import { DvmError, JOBS_FILE, type JobPolicy, type Message, type Transport } from "@dvmkit/sdk/internal";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The provider and the Cashu wallet journal are external; the CLI commands,
// stream loop, payment responder and job store run unmocked.
const seams = vi.hoisted(() => ({
  transport: undefined as unknown as Transport,
  json: vi.fn(),
  wallet: { pending_submissions: [] as Record<string, unknown>[], recent_spends: [] as Record<string, unknown>[] },
  walletMissing: false,
  nextFromReserve: false,
  noFunds: false,
  enforceGlobalBudget: vi.fn(async () => 100_000),
  signed: [] as string[],
  recordSpend: vi.fn(),
}));

vi.mock("../src/lib/transport", () => ({ createDvmTransport: () => seams.transport }));
vi.mock("../src/lib/output", async (original) => ({
  ...(await original<typeof import("../src/lib/output")>()),
  info: vi.fn(),
  json: seams.json,
}));
vi.mock("../src/lib/budget-ledger", async (original) => ({
  ...(await original<typeof import("../src/lib/budget-ledger")>()),
  enforceGlobalBudget: () => seams.enforceGlobalBudget(),
  recordSpend: seams.recordSpend,
}));
vi.mock("@dvmkit/sdk/internal", async (original) => ({
  ...(await original<typeof import("@dvmkit/sdk/internal")>()),
  loadAgentWallet: () => seams.walletMissing ? null : ({ proofs: [], ...seams.wallet }),
}));
vi.mock("../src/lib/wallet-agent/recovery-submissions", () => ({ sweepPendingSubmissions: async () => undefined }));
// Each prepare swaps fresh proofs at the mint: one call is one signed token.
vi.mock("../src/lib/wallet-agent/spend", () => ({
  prepareAgentSpend: async (args: { amountSats: number; endpoint: string; cashuP2pk: { mints: string[]; lock_pubkey: string } }) => {
    const n = seams.signed.length + 1;
    if (seams.noFunds) return { error: { code: "insufficient_balance", message: "Not enough sats.", hint: "Fund the wallet." } };
    const fromReserve = seams.nextFromReserve;
    const prepared = { cashuToken: `token-${n}`, requestId: `submission-${n}`, mint: args.cashuP2pk.mints[0],
      totalSats: args.amountSats, endpoint: args.endpoint, intendedLockPubkey: args.cashuP2pk.lock_pubkey,
      ...(fromReserve ? { fromReserve: true } : {}) };
    seams.signed.push(prepared.cashuToken);
    seams.wallet.pending_submissions.push({ request_id: prepared.requestId, endpoint: args.endpoint, mint: prepared.mint,
      amount_sats: args.amountSats, intended_lock_pubkey: prepared.intendedLockPubkey,
      output_proofs: fromReserve ? [{ secret: `reserve-${n}`, reserved_for: "builder:dvm.example" }] : [],
      cashu_token: prepared.cashuToken, created_at: new Date().toISOString(), t_expire: Date.parse("2026-11-20T00:00:00Z") });
    return prepared;
  },
  commitAgentSpend: async (args: { requestId: string; recentSpend: Record<string, unknown> }) => {
    seams.wallet.pending_submissions = seams.wallet.pending_submissions.filter((entry) => entry.request_id !== args.requestId);
    seams.wallet.recent_spends.push(args.recentSpend);
  },
  commitHeldSubmission: async (requestId: string) => {
    const entry = seams.wallet.pending_submissions.find((held) => held.request_id === requestId);
    if (!entry) return;
    seams.wallet.pending_submissions = seams.wallet.pending_submissions.filter((held) => held !== entry);
    seams.wallet.recent_spends.push({ request_id: requestId, dvm_endpoint: entry.endpoint, mint: entry.mint, amount_sats: entry.amount_sats });
  },
  abandonPendingSubmission: async () => undefined,
}));

import { messages } from "../src/commands/messages";
import { pay } from "../src/commands/pay";
import { cancel } from "../src/commands/cancel";
import { status } from "../src/commands/status";
import { streamLoop } from "../src/lib/stream-loop";
import { loadJob, saveJob, updateJob } from "../src/lib/job-store";
import { appendMessages } from "../src/lib/messages";
import { getDecodedToken } from "@cashu/cashu-ts";
import { recordSubmissionVerdicts } from "../src/lib/wallet-agent/submission-verdicts";

const endpoint = "https://dvm.example";
const mint = "https://mint.example";
const lockPubkey = "02" + "11".repeat(32);
const policy: JobPolicy = { maxTotalMsats: 2_000_000, autoPayBelowMsats: 1_000_000, maxIncrementMsats: 0, maxPayments: 3 };
const ask = { amount_msats: 800_000, reason: "Finish the job", lock_pubkey: lockPubkey, mints: [mint] };

/**
 * A provider whose machine can be suspended. While down, a payment POST fails
 * with no answer. Up, it records a Cashu payment once per `cashu_request_id`
 * and answers a repeat as a replay, as the SDK accumulator does. `answer`
 * scripts the provider's reply to payment POSTs while it is set: an error it
 * returns is thrown, and "record-then-lose" records the payment but drops the
 * reply.
 */
function fakeProvider(jobId: string, followUp: "complete" | "second-ask") {
  let up = true;
  let asks = 1;
  let answer: (() => Error | "record-then-lose") | undefined;
  const history: Message[] = [
    { seq: 1, from: "provider", timestamp: 1, type: "working", content: {} } as Message,
    { seq: 2, from: "provider", timestamp: 2, type: "payment-request", content: ask } as Message,
  ];
  const recorded: string[] = [];
  const append = (message: Omit<Message, "seq" | "timestamp">) =>
    history.push({ ...message, seq: history.length + 1, timestamp: history.length + 1 } as Message);
  const openAsk = () => history.at(-1)?.type === "payment-request";
  const sendMessage = vi.fn(async (_job: string, message: { type: string; content: Record<string, unknown> }) => {
    if (!up) throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    const scripted = answer?.();
    if (scripted instanceof Error) throw scripted;
    const requestId = String(message.content.cashu_request_id);
    if (recorded.includes(requestId)) throw new DvmError("replay_rejected", "Already accepted", undefined, { http_status: 409 });
    recorded.push(requestId);
    append({ from: "requester", type: "payment", content: message.content } as Omit<Message, "seq" | "timestamp">);
    if (followUp === "second-ask" && asks === 1) {
      asks++;
      append({ from: "provider", type: "payment-request", content: ask } as Omit<Message, "seq" | "timestamp">);
    } else append({ from: "provider", type: "complete", content: { summary: "Done" } } as Omit<Message, "seq" | "timestamp">);
    if (scripted === "record-then-lose")
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    return { seq: history.length };
  });
  const after = (seq: number) => {
    if (!up) throw new TypeError("fetch failed");
    return history.filter((message) => message.seq > seq);
  };
  seams.transport = {
    sendMessage,
    stream: vi.fn(async (_job: string, seq: number) => ({ messages: after(seq), reason: "yield" })),
    getMessages: vi.fn(async (_job: string, seq: number) => after(seq)),
    status: vi.fn(async () => {
      if (!up) throw new TypeError("fetch failed");
      return { status: openAsk() ? "awaiting-input" : "completed" };
    }),
    describe: vi.fn(async () => ({ cashu: { lock_pubkeys: [lockPubkey], mints: [mint] } })),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(),
  } as unknown as Transport;
  saveJob({ id: jobId, endpoint, status: "processing", submittedAt: Date.now(), policy, messageCursor: 0 });
  return {
    sendMessage,
    recorded,
    suspend: () => { up = false; },
    resume: () => { up = true; },
    answerWith: (next: (() => Error | "record-then-lose") | undefined) => { answer = next; },
    record: (message: Omit<Message, "seq" | "timestamp">) => append(message),
    history,
    sentTokens: () => sendMessage.mock.calls.map(([, message]) => [message.content.cashu_token, message.content.cashu_request_id]),
  };
}

/** The request stream auto-pays the ask, and the machine is suspended before the provider answers. */
async function payIntoSuspendedProvider(jobId: string, provider: ReturnType<typeof fakeProvider>): Promise<void> {
  const transport = seams.transport;
  const sendMessage = provider.sendMessage.getMockImplementation()!;
  provider.sendMessage.mockImplementationOnce(async (...args) => {
    provider.suspend();
    return sendMessage(...args);
  });
  await expect(streamLoop({ jobId, transport, provider: { endpoint }, policy, afterSeq: 0 }))
    .rejects.toThrow("fetch failed");
  expect(seams.signed).toEqual(["token-1"]);
  expect(provider.recorded).toEqual([]);
  // The machine comes back about six minutes later, well past the settle window.
  vi.setSystemTime(Date.now() + 6 * 60_000);
  provider.resume();
}

beforeEach(() => {
  // Every test's first token is "submission-1"; keep one test's jobs and verdicts from another's.
  rmSync(JOBS_FILE, { force: true });
  rmSync(join(dirname(JOBS_FILE), "submission-verdicts.json"), { force: true });
  vi.useFakeTimers({ toFake: ["Date"] });
  seams.walletMissing = false;
  seams.nextFromReserve = false;
  seams.noFunds = false;
  seams.enforceGlobalBudget.mockImplementation(async () => 100_000);
  seams.wallet.pending_submissions = [];
  seams.wallet.recent_spends = [];
  seams.signed = [];
});
afterEach(() => vi.useRealTimers());

describe("an ask whose payment the provider never confirmed", () => {
  it.each([
    ["messages", (jobId: string) => messages(jobId, {})],
    ["messages --wait", (jobId: string) => messages(jobId, { wait: true, until: "2m" })],
    ["pay", (jobId: string) => pay(jobId, {})],
    ["the request stream", (jobId: string) => streamLoop({ jobId, transport: seams.transport, provider: { endpoint }, policy, afterSeq: 0 }).then(() => undefined)],
  ])("is re-delivered with its original token by %s, never re-signed", async (_entry, run) => {
    const jobId = `unconfirmed-${_entry.replace(/\W+/g, "-")}`;
    const provider = fakeProvider(jobId, "complete");
    await payIntoSuspendedProvider(jobId, provider);

    await run(jobId);

    expect(seams.signed).toEqual(["token-1"]);
    expect(provider.sentTokens()).toEqual([["token-1", "submission-1"], ["token-1", "submission-1"]]);
    expect(provider.recorded).toEqual(["submission-1"]);
    expect(seams.wallet.pending_submissions).toEqual([]);
    expect(seams.wallet.recent_spends).toEqual([expect.objectContaining({ request_id: "submission-1", amount_sats: 800 })]);
    expect(seams.recordSpend).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ jobId, msats: 800_000 }));
    const job = loadJob(jobId);
    expect(job).toMatchObject({ totalPaidMsats: 800_000, paymentsHonoured: 1, paidPaymentRequestSeqs: [2] });
    expect(job?.inFlightPaymentRequestSeqs).toBeUndefined();
    expect(job?.unconfirmedPaymentSubmissions).toBeUndefined();
  });

  it("is only read by status, which neither signs nor sends", async () => {
    const jobId = "unconfirmed-status";
    const provider = fakeProvider(jobId, "complete");
    await payIntoSuspendedProvider(jobId, provider);

    await status(jobId, {});

    // The ask is open, but status must say a payment was already sent and how it is resolved.
    expect(seams.json.mock.calls.at(-1)?.[0]).toMatchObject({ status: "awaiting-input", next_action: { type: "pay",
      hint: expect.stringContaining("re-sends that same payment rather than signing a new one") } });
    expect(seams.signed).toEqual(["token-1"]);
    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
    expect(loadJob(jobId)?.unconfirmedPaymentSubmissions?.[2]).toMatchObject({ cashuRequestId: "submission-1" });
  });

  it("does not stop a new ask for the same amount from being paid with a new token", async () => {
    const jobId = "unconfirmed-second-ask";
    const provider = fakeProvider(jobId, "second-ask");
    await payIntoSuspendedProvider(jobId, provider);

    await messages(jobId, {});
    await messages(jobId, {});

    expect(seams.signed).toEqual(["token-1", "token-2"]);
    expect(provider.sentTokens()).toEqual([
      ["token-1", "submission-1"], ["token-1", "submission-1"], ["token-2", "submission-2"],
    ]);
    expect(provider.recorded).toEqual(["submission-1", "submission-2"]);
    expect(loadJob(jobId)).toMatchObject({ totalPaidMsats: 1_600_000, paymentsHonoured: 2, paidPaymentRequestSeqs: [2, 4] });
  });
});

const providerError = (code: string, status?: number) =>
  new DvmError(code, `Provider answered ${code}`, undefined, status === undefined ? undefined : { http_status: status });

/** Run a command while fake timers carry it through retry backoff. */
async function drive<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  const watched = work.finally(() => { settled = true; });
  watched.catch(() => undefined);
  for (let i = 0; i < 60 && !settled; i++) await vi.advanceTimersByTimeAsync(500);
  return watched;
}

function expectPaidOnceWithFirstToken(jobId: string, provider: ReturnType<typeof fakeProvider>): void {
  expect(seams.signed).toEqual(["token-1"]);
  expect(provider.sentTokens().every(([token, id]) => token === "token-1" && id === "submission-1")).toBe(true);
  expect(seams.recordSpend).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ jobId, msats: 800_000 }));
  expect(seams.wallet.recent_spends).toEqual([expect.objectContaining({ request_id: "submission-1" })]);
  expect(loadJob(jobId)).toMatchObject({ totalPaidMsats: 800_000, paymentsHonoured: 1, paidPaymentRequestSeqs: [2] });
  expect(loadJob(jobId)?.unconfirmedPaymentSubmissions).toBeUndefined();
  expect(loadJob(jobId)?.inFlightPaymentRequestSeqs).toBeUndefined();
}

describe("a re-delivery answer that does not settle the ask", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }));

  // Each answer leaves the token possibly accepted or still acceptable, so the
  // next command must send that token again, never sign another.
  it.each([
    ["proof_pending (transient)", () => providerError("proof_pending", 402)],
    ["mint_unreachable (transient)", () => providerError("mint_unreachable", 402)],
    ["429 rate_limited", () => providerError("rate_limited", 429)],
    ["408", () => providerError("request_timeout", 408)],
    ["425", () => providerError("too_early", 425)],
    ["an unlisted structured 4xx", () => providerError("job_busy", 409)],
    ["a prose JSON 404", () => providerError("Job not found", 404)],
    ["an unstructured 4xx", () => providerError("provider_error")],
    ["an inferred payment_insufficient", () => Object.assign(providerError("payment_insufficient", 402),
      { data: { http_status: 402, code_source: "inferred" } })],
  ])("holds the payment after %s and re-sends the same token next time", async (_label, refusal) => {
    const jobId = `held-${_label.replace(/\W+/g, "-")}`;
    const provider = fakeProvider(jobId, "complete");
    await payIntoSuspendedProvider(jobId, provider);
    provider.answerWith(refusal);
    await expect(drive(messages(jobId, {}))).rejects.toBeInstanceOf(Error);
    expect(seams.signed).toEqual(["token-1"]);
    expect(loadJob(jobId)?.unconfirmedPaymentSubmissions?.[2]).toMatchObject({ cashuRequestId: "submission-1" });

    provider.answerWith(undefined);
    vi.setSystemTime(Date.now() + 60_000);
    await drive(messages(jobId, {}));
    await drive(messages(jobId, {}));

    expectPaidOnceWithFirstToken(jobId, provider);
    expect(provider.recorded).toEqual(["submission-1"]);
  });

  // These answers repeat on every re-send, while the provider may still redeem the token.
  it.each([
    ["request_id_reused", () => Object.assign(providerError("request_id_reused", 409), { hint: "Send these proofs again under a new request id." }),
      "already carries a different payment"],
    ["wrong_lock_pubkey", () => providerError("wrong_lock_pubkey", 402), "take the token back after 2026-11-20T00:00:00.000Z"],
  ])("holds without re-sending after %s and says how to end the job", async (_code, answer, why) => {
    const jobId = `blocked-${_code}`;
    const provider = fakeProvider(jobId, "complete");
    await payIntoSuspendedProvider(jobId, provider);
    provider.answerWith(answer);
    const failure = await drive(pay(jobId, {})).catch((error: unknown) => error);
    expect(failure).toMatchObject({ hint: expect.stringContaining(why),
      data: { next_action: { type: "poll", hint: expect.stringContaining("dvm decline") } } });
    expect((failure as DvmError).hint).not.toContain("new request id");
    const sends = provider.sendMessage.mock.calls.length;
    provider.answerWith(undefined);
    await messages(jobId, {});
    expect(provider.sendMessage).toHaveBeenCalledTimes(sends);
    expect(seams.json.mock.calls.at(-1)?.[0]).toMatchObject({ next_action: { hint: expect.stringContaining("dvm cancel") } });
    expect(seams.signed).toEqual(["token-1"]);
  });
});

describe("a re-delivery the provider already took", () => {
  it("books spent proofs as the payment, once, without signing again", async () => {
    const jobId = "taken-proof-not-unspent";
    const provider = fakeProvider(jobId, "complete");
    await payIntoSuspendedProvider(jobId, provider);
    // The provider redeemed the first token without recording it; its receive
    // path checks proof state before replay detection.
    provider.answerWith(() => providerError("proof_not_unspent", 402));
    await messages(jobId, {});
    await messages(jobId, {});
    expectPaidOnceWithFirstToken(jobId, provider);
    expect(provider.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("books spent proofs swapped for this payment even on a first delivery", async () => {
    const jobId = "taken-first-delivery";
    const provider = fakeProvider(jobId, "complete");
    provider.answerWith(() => providerError("proof_not_unspent", 402));
    await streamLoop({ jobId, transport: seams.transport, provider: { endpoint }, policy, afterSeq: 0 });
    expectPaidOnceWithFirstToken(jobId, provider);
  });

  // Reserve proofs existed before this payment and could have paid another call.
  it("blocks spent reserve proofs for an explicit choice, booking nothing", async () => {
    const jobId = "spent-reserve";
    const provider = fakeProvider(jobId, "complete");
    seams.nextFromReserve = true;
    provider.answerWith(() => providerError("proof_not_unspent", 402));
    await expect(streamLoop({ jobId, transport: seams.transport, provider: { endpoint }, policy, afterSeq: 0 }))
      .rejects.toMatchObject({ code: "proof_not_unspent", hint: expect.stringContaining("only an explicit `dvm pay") });
    expect(seams.recordSpend).not.toHaveBeenCalled();
    provider.answerWith(undefined);
    await messages(jobId, {});
    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
    expect(seams.json.mock.calls.at(-1)?.[0]).toMatchObject({ next_action: { type: "pay",
      hint: expect.stringContaining("may already have redeemed this token for this charge, so paying again may pay twice") } });
    seams.nextFromReserve = false;
    await pay(jobId, {});
    expect(seams.signed).toEqual(["token-1", "token-2"]);
    expect(provider.recorded).toEqual(["submission-2"]);
    expect(loadJob(jobId)).toMatchObject({ totalPaidMsats: 800_000, paymentsHonoured: 1 });
  });

  it.each([
    ["messages", (jobId: string) => messages(jobId, {})],
    ["messages --wait", (jobId: string) => messages(jobId, { wait: true, until: "2m" })],
    ["status --messages", (jobId: string) => status(jobId, { messages: true })],
  ])("books a payment whose answer was lost once %s shows the provider recorded it", async (_entry, run) => {
    const jobId = `recorded-${_entry.replace(/\W+/g, "-")}`;
    const provider = fakeProvider(jobId, "complete");
    provider.answerWith(() => "record-then-lose");
    await expect(streamLoop({ jobId, transport: seams.transport, provider: { endpoint }, policy, afterSeq: 0 }))
      .rejects.toThrow("fetch failed");
    provider.answerWith(undefined);
    expect(loadJob(jobId)?.inFlightPaymentRequestSeqs).toEqual([2]);

    await run(jobId);
    await run(jobId);

    expectPaidOnceWithFirstToken(jobId, provider);
    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("a definite refusal of the re-delivered token", () => {
  it.each(["payment_invalid", "lock_not_exclusive"])("releases the ask after %s, so a new token may pay it", async (code) => {
    const jobId = `refused-${code}`;
    const provider = fakeProvider(jobId, "complete");
    await payIntoSuspendedProvider(jobId, provider);
    provider.answerWith(() => providerError(code, 402));
    await expect(messages(jobId, {})).rejects.toMatchObject({ code });
    expect(loadJob(jobId)?.unconfirmedPaymentSubmissions).toBeUndefined();

    provider.answerWith(undefined);
    await messages(jobId, {});

    expect(seams.signed).toEqual(["token-1", "token-2"]);
    expect(provider.recorded).toEqual(["submission-2"]);
    expect(loadJob(jobId)).toMatchObject({ totalPaidMsats: 800_000, paymentsHonoured: 1 });
  });
});

describe("a short Cashu payment the provider kept as credit", () => {
  it("stops auto-pay, names the credit and its drain, and pays only on an explicit dvm pay", async () => {
    const jobId = "credit-held";
    const provider = fakeProvider(jobId, "complete");
    await payIntoSuspendedProvider(jobId, provider);
    provider.answerWith(() => Object.assign(providerError("payment_insufficient", 402),
      { data: { http_status: 402, credit_id: "credit-7" } }));
    await expect(messages(jobId, {})).rejects.toMatchObject({ code: "payment_insufficient",
      hint: expect.stringContaining("dvm credit drain https://dvm.example --credit-id credit-7") });
    provider.answerWith(undefined);

    // A replay of the kept token would read as paid; nothing is sent again.
    await messages(jobId, {});
    expect(provider.sendMessage).toHaveBeenCalledTimes(2);
    expect(seams.json.mock.calls.at(-1)?.[0]).toMatchObject({ next_action: { type: "pay",
      hint: expect.stringContaining("only an explicit `dvm pay") } });
    expect(seams.signed).toEqual(["token-1"]);

    await pay(jobId, {});
    expect(seams.signed).toEqual(["token-1", "token-2"]);
    expect(provider.recorded).toEqual(["submission-2"]);
    expect(seams.recordSpend).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ msats: 800_000 }));
    expect(seams.wallet.pending_submissions).toEqual([expect.objectContaining({ request_id: "submission-1" })]);
  });
});

describe("an explicit pay that cannot replace a blocked payment", () => {
  async function creditHeldAsk(jobId: string) {
    const provider = fakeProvider(jobId, "complete");
    await payIntoSuspendedProvider(jobId, provider);
    provider.answerWith(() => Object.assign(providerError("payment_insufficient", 402),
      { data: { http_status: 402, credit_id: "credit-7" } }));
    await expect(messages(jobId, {})).rejects.toMatchObject({ code: "payment_insufficient" });
    provider.answerWith(undefined);
    return provider;
  }

  // The block is what stops automatic payment; a failed replacement must not drop it.
  it.each([
    ["the budget refuses it", () => seams.enforceGlobalBudget.mockRejectedValueOnce(new DvmError("budget_exceeded", "Over the daily cap"))],
    ["the wallet has no funds", () => { seams.noFunds = true; }],
  ])("keeps the block when %s, so the next automatic messages signs nothing", async (_label, fail) => {
    const jobId = `blocked-replacement-${_label.replace(/\W+/g, "-")}`;
    const provider = await creditHeldAsk(jobId);
    fail();
    await expect(pay(jobId, {})).rejects.toBeInstanceOf(Error);
    expect(loadJob(jobId)?.unconfirmedPaymentSubmissions?.[2]).toMatchObject({ cashuRequestId: "submission-1",
      blocked: { reason: "credit_held", creditId: "credit-7" } });
    seams.noFunds = false;

    await messages(jobId, {});
    expect(seams.signed).toEqual(["token-1"]);
    expect(provider.sendMessage).toHaveBeenCalledTimes(2);
    expect(seams.json.mock.calls.at(-1)?.[0]).toMatchObject({ next_action: { type: "pay",
      hint: expect.stringContaining("credit-7") } });
  });
});

describe("a refused replacement for a blocked payment", () => {
  async function blockedAsk(kind: "credit_held" | "proofs_spent", jobId: string) {
    const provider = fakeProvider(jobId, "complete");
    if (kind === "credit_held") {
      await payIntoSuspendedProvider(jobId, provider);
      provider.answerWith(() => Object.assign(providerError("payment_insufficient", 402),
        { data: { http_status: 402, credit_id: "credit-7" } }));
      await expect(messages(jobId, {})).rejects.toMatchObject({ code: "payment_insufficient" });
    } else {
      seams.nextFromReserve = true;
      provider.answerWith(() => providerError("proof_not_unspent", 402));
      await expect(streamLoop({ jobId, transport: seams.transport, provider: { endpoint }, policy, afterSeq: 0 }))
        .rejects.toMatchObject({ code: "proof_not_unspent" });
      seams.nextFromReserve = false;
    }
    expect(loadJob(jobId)?.unconfirmedPaymentSubmissions?.[2]).toMatchObject({ blocked: { reason: kind } });
    return provider;
  }

  // The spent reserve token may already have paid this charge, so an automatic second token could pay twice.
  it.each(["credit_held", "proofs_spent"] as const)("keeps a %s ask from automatic payment after the provider refuses the replacement", async (kind) => {
    const jobId = `refused-replacement-${kind}`;
    const provider = await blockedAsk(kind, jobId);
    provider.answerWith(() => providerError("payment_invalid", 402));
    await expect(pay(jobId, {})).rejects.toMatchObject({ code: "payment_invalid" });
    expect(seams.signed).toEqual(["token-1", "token-2"]);
    expect(loadJob(jobId)?.askPaymentBlocks?.[2]).toMatchObject({ reason: kind });
    provider.answerWith(undefined);
    const sends = provider.sendMessage.mock.calls.length;

    await messages(jobId, {});
    expect(seams.signed).toEqual(["token-1", "token-2"]);
    expect(provider.sendMessage).toHaveBeenCalledTimes(sends);
    expect(seams.json.mock.calls.at(-1)?.[0]).toMatchObject({ next_action: { type: "pay",
      hint: expect.stringContaining("only an explicit `dvm pay") } });

    await pay(jobId, {});
    expect(seams.signed).toEqual(["token-1", "token-2", "token-3"]);
    expect(provider.recorded).toEqual(["submission-3"]);
  });

  // The refusal reaches an automatic re-send of the replacement, which carries no explicit approval.
  it.each([
    ["credit_held", "a lost send", "ECONNRESET"],
    ["proofs_spent", "a lost send", "ECONNRESET"],
    ["credit_held", "a send that never connected", "ECONNREFUSED"],
  ] as const)("keeps a %s ask blocked when an automatic re-send of the replacement after %s is refused", async (kind, _label, code) => {
    const jobId = `refused-resend-${kind}-${code}`;
    const provider = await blockedAsk(kind, jobId);
    provider.answerWith(() => new TypeError("fetch failed", { cause: Object.assign(new Error("connection"), { code }) }));
    await expect(pay(jobId, {})).rejects.toThrow("fetch failed");
    expect(seams.signed).toEqual(["token-1", "token-2"]);
    vi.setSystemTime(Date.now() + 60_000);

    provider.answerWith(() => providerError("payment_invalid", 402));
    await expect(messages(jobId, {})).rejects.toMatchObject({ code: "payment_invalid" });
    expect(provider.sentTokens().at(-1)).toEqual(["token-2", "submission-2"]);
    provider.answerWith(undefined);
    const sends = provider.sendMessage.mock.calls.length;

    await messages(jobId, {});
    expect(seams.signed).toEqual(["token-1", "token-2"]);
    expect(provider.sendMessage).toHaveBeenCalledTimes(sends);
    expect(loadJob(jobId)?.askPaymentBlocks?.[2]).toMatchObject({ reason: kind });
    expect(seams.json.mock.calls.at(-1)?.[0]).toMatchObject({ next_action: { type: "pay",
      hint: expect.stringContaining("only an explicit `dvm pay") } });
  });

  it("lifts the block once an explicit replacement is taken", async () => {
    const jobId = "replacement-taken";
    const provider = await blockedAsk("credit_held", jobId);
    provider.answerWith(undefined);
    await pay(jobId, {});
    expect(provider.recorded).toEqual(["submission-2"]);
    expect(loadJob(jobId)?.askPaymentBlocks).toBeUndefined();
  });

  // The provider accepted the cancel but kept the job, and its ask, open.
  it("keeps the block when a cancel is accepted but the ask stays open", async () => {
    const jobId = "cancel-ask-open";
    const provider = await blockedAsk("credit_held", jobId);
    provider.answerWith(undefined);
    await cancel(jobId, {});
    expect(loadJob(jobId)?.askPaymentBlocks?.[2]).toMatchObject({ reason: "credit_held" });
    const sends = provider.sendMessage.mock.calls.length;
    await messages(jobId, {});
    expect(seams.signed).toEqual(["token-1"]);
    expect(provider.sendMessage).toHaveBeenCalledTimes(sends);
  });

  it("keeps the refusal's own hint when an explicit replacement is refused by the budget", async () => {
    const jobId = "replacement-budget-hint";
    await blockedAsk("credit_held", jobId);
    seams.enforceGlobalBudget.mockRejectedValueOnce(new DvmError("budget_exceeded", "Over the daily cap",
      "Raise the daily cap with `dvm budget set`, or wait for the window to reset."));
    await expect(pay(jobId, {})).rejects.toMatchObject({ code: "budget_exceeded",
      hint: "Raise the daily cap with `dvm budget set`, or wait for the window to reset." });
    expect(loadJob(jobId)?.unconfirmedPaymentSubmissions?.[2]).toMatchObject({ blocked: { reason: "credit_held" } });
  });
});

describe("guards around a held payment", () => {
  it("refuses to pay the held ask at another endpoint", async () => {
    const jobId = "held-other-endpoint";
    const provider = fakeProvider(jobId, "complete");
    await payIntoSuspendedProvider(jobId, provider);
    const failure = await pay(jobId, { endpoint: "https://other.example", jobToken: "cd".repeat(32) }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "payment_unconfirmed", hint: expect.stringContaining("without --endpoint") });
    expect(seams.signed).toEqual(["token-1"]);
    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("refuses a forced rail other than the one already sent", async () => {
    const jobId = "held-other-rail";
    const provider = fakeProvider(jobId, "complete");
    await payIntoSuspendedProvider(jobId, provider);
    await expect(pay(jobId, { rail: "x402" })).rejects.toMatchObject({ code: "payment_unconfirmed",
      message: expect.stringContaining("unconfirmed cashu payment"), hint: expect.stringContaining("without --rail") });
    expect(seams.signed).toEqual(["token-1"]);
    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("refuses when the held payment answered a different amount", async () => {
    const jobId = "held-other-amount";
    const provider = fakeProvider(jobId, "complete");
    await payIntoSuspendedProvider(jobId, provider);
    const held = loadJob(jobId)!.unconfirmedPaymentSubmissions![2];
    updateJob(jobId, { unconfirmedPaymentSubmissions: { 2: { ...held, requestAmountMsats: 1 } } });
    await expect(pay(jobId, {})).rejects.toMatchObject({ code: "payment_unconfirmed", message: expect.stringContaining("different amount") });
    expect(seams.signed).toEqual(["token-1"]);
    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("refuses while the wallet holding the token is unavailable", async () => {
    const jobId = "held-wallet-missing";
    const provider = fakeProvider(jobId, "complete");
    await payIntoSuspendedProvider(jobId, provider);
    seams.walletMissing = true;
    await expect(pay(jobId, {})).rejects.toMatchObject({ code: "payment_unconfirmed", hint: expect.stringContaining("Restore the agent wallet") });
    expect(seams.signed).toEqual(["token-1"]);
    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
    expect(loadJob(jobId)?.unconfirmedPaymentSubmissions?.[2]).toBeDefined();
  });

  // A forgotten or aged-out wallet entry proves no reclaim: the provider may still redeem it.
  it.each([
    ["messages", (jobId: string) => messages(jobId, {})],
    ["pay", (jobId: string) => pay(jobId, {}).catch((error: unknown) => { throw error; })],
  ])("keeps the ask held by %s after the wallet entry is gone without a reclaim", async (entry, run) => {
    const jobId = `held-entry-gone-${entry}`;
    const provider = fakeProvider(jobId, "complete");
    await payIntoSuspendedProvider(jobId, provider);
    seams.wallet.pending_submissions = [];
    const outcome = await run(jobId).then(() => undefined, (error: unknown) => error);
    if (entry === "pay") expect(outcome).toMatchObject({ code: "payment_unconfirmed",
      hint: expect.stringContaining("dvm cancel"), data: { next_action: { type: "poll" } } });
    else expect(seams.json.mock.calls.at(-1)?.[0]).toMatchObject({ next_action: { type: "poll" } });
    expect(seams.signed).toEqual(["token-1"]);
    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
    expect(loadJob(jobId)?.unconfirmedPaymentSubmissions?.[2]).toBeDefined();
  });

  // A recent spend can be a partial redeem, so only a sweep verdict books.
  it("books a dropped token only on the sweep's spent verdict, never on a bare recent spend", async () => {
    const jobId = "held-already-committed";
    const provider = fakeProvider(jobId, "complete");
    await payIntoSuspendedProvider(jobId, provider);
    seams.wallet.pending_submissions = [];
    seams.wallet.recent_spends = [{ request_id: "submission-1", amount_sats: 300 }];
    await expect(pay(jobId, {})).rejects.toMatchObject({ code: "payment_unconfirmed" });
    expect(seams.recordSpend).not.toHaveBeenCalled();

    recordSubmissionVerdicts([{ requestId: "submission-1", verdict: "spent" }]);
    await expect(pay(jobId, {})).rejects.toMatchObject({ code: "payment_already_sent" });
    await messages(jobId, {});
    expect(seams.signed).toEqual(["token-1"]);
    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
    expect(seams.recordSpend).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ jobId, msats: 800_000 }));
    expect(loadJob(jobId)).toMatchObject({ totalPaidMsats: 800_000, paymentsHonoured: 1, paidPaymentRequestSeqs: [2] });
  });

  it("rebuilds the held token from its proofs when the journal kept no encoded copy", async () => {
    const jobId = "held-rebuilt-token";
    const provider = fakeProvider(jobId, "complete");
    await payIntoSuspendedProvider(jobId, provider);
    const proofs = [
      { id: "009a1f293253e41e", amount: 512, secret: "held-secret-a", C: "02" + "aa".repeat(32) },
      { id: "009a1f293253e41e", amount: 288, secret: "held-secret-b", C: "02" + "bb".repeat(32) },
    ];
    seams.wallet.pending_submissions = seams.wallet.pending_submissions.map((entry) =>
      ({ ...entry, cashu_token: undefined, output_proofs: proofs }));
    await pay(jobId, {});
    const [, redelivered] = provider.sentTokens();
    expect(redelivered[1]).toBe("submission-1");
    const decoded = getDecodedToken(String(redelivered[0]), ["009a1f293253e41e"]);
    expect(decoded.mint).toBe(mint);
    expect(decoded.proofs.map(({ amount, secret, C }) => ({ amount: Number(amount), secret, C })))
      .toEqual(proofs.map(({ amount, secret, C }) => ({ amount, secret, C })));
    expect(seams.signed).toEqual(["token-1"]);
  });
});

describe("history that answers a held ask without this payment", () => {
  // Scenario A: another payment, such as one sent by hand, answered the ask.
  it("marks the ask answered but books nothing and keeps the wallet entry when the payment is not this one", async () => {
    const jobId = "answered-by-other";
    const provider = fakeProvider(jobId, "complete");
    await payIntoSuspendedProvider(jobId, provider);
    provider.record({ from: "requester", type: "payment", content: { cashu_token: "other", cashu_request_id: "hand-sent", amount_msats: 800_000 } } as Omit<Message, "seq" | "timestamp">);
    provider.record({ from: "provider", type: "complete", content: { summary: "Done" } } as Omit<Message, "seq" | "timestamp">);
    await messages(jobId, {});
    await messages(jobId, {});
    expect(seams.recordSpend).not.toHaveBeenCalled();
    expect(seams.wallet.pending_submissions).toEqual([expect.objectContaining({ request_id: "submission-1" })]);
    expect(loadJob(jobId)?.paidPaymentRequestSeqs).toEqual([2]);
    expect(loadJob(jobId)?.totalPaidMsats).toBeUndefined();
    expect(loadJob(jobId)?.unconfirmedPaymentSubmissions?.[2]).toMatchObject({ cashuRequestId: "submission-1" });
    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
  });

  // Scenario B: a confirmed decline answered the ask, and a later stream stops at the ask.
  it("does not book a held payment for an ask the caller declined", async () => {
    const jobId = "declined-ask";
    const provider = fakeProvider(jobId, "complete");
    await payIntoSuspendedProvider(jobId, provider);
    updateJob(jobId, { callerDeclined: true });
    appendMessages(jobId, [{ seq: 3, from: "requester", timestamp: 3, type: "decline", content: {} } as Message]);
    await messages(jobId, { after: "1" });
    expect(seams.recordSpend).not.toHaveBeenCalled();
    expect(seams.wallet.pending_submissions).toEqual([expect.objectContaining({ request_id: "submission-1" })]);
    expect(loadJob(jobId)?.totalPaidMsats).toBeUndefined();
    expect(loadJob(jobId)?.paidPaymentRequestSeqs ?? []).not.toContain(2);
    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("budget after an earlier payment is booked", () => {
  it("checks the cap against the total that booking produced", async () => {
    const jobId = "cap-after-booking";
    const provider = fakeProvider(jobId, "second-ask");
    updateJob(jobId, { policy: { ...policy, maxTotalMsats: 1_000_000 } });
    provider.answerWith(() => "record-then-lose");
    await expect(streamLoop({ jobId, transport: seams.transport, provider: { endpoint }, policy, afterSeq: 0 }))
      .rejects.toThrow("fetch failed");
    provider.answerWith(undefined);
    // A read that saved the history but stopped before booking it.
    appendMessages(jobId, provider.history.filter((message) => message.seq > 2));
    await expect(pay(jobId, {})).rejects.toMatchObject({ code: "over_budget" });
    expect(seams.signed).toEqual(["token-1"]);
    expect(loadJob(jobId)).toMatchObject({ totalPaidMsats: 800_000, paymentsHonoured: 1 });
  });
});

describe("hints for a held payment that cannot be re-sent", () => {
  it.each([
    ["status", (jobId: string) => status(jobId, {})],
    ["messages", (jobId: string) => messages(jobId, {})],
  ])("%s does not promise a dvm pay re-send once the wallet entry is gone", async (_entry, run) => {
    const jobId = `hint-entry-gone-${_entry}`;
    const provider = fakeProvider(jobId, "complete");
    await payIntoSuspendedProvider(jobId, provider);
    seams.wallet.pending_submissions = [];
    await run(jobId);
    const hint = String(seams.json.mock.calls.at(-1)?.[0]?.next_action?.hint);
    expect(hint).toContain("no longer holds");
    expect(hint).toContain("dvm decline");
    expect(hint).not.toContain("Resolve it with `dvm pay");
  });
});
