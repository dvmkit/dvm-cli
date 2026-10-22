vi.mock("../src/lib/payment-rails/tempo-credential", () => ({ buildTempoCredential: sdk.buildTempoCredential }));
vi.mock("../src/lib/x402/client", async () => ({ ...(await vi.importActual<typeof import("../src/lib/x402/client")>("../src/lib/x402/client")), tryX402Payment: sdk.tryX402Payment }));
vi.mock("../src/lib/x402/wallet", async () => ({ ...(await vi.importActual<typeof import("../src/lib/x402/wallet")>("../src/lib/x402/wallet")), loadX402Wallet: sdk.loadX402Wallet }));
vi.mock("../src/lib/identity", async () => ({ ...(await vi.importActual<typeof import("../src/lib/identity")>("../src/lib/identity")), loadConfig: sdk.loadConfig }));
vi.mock("../src/lib/job-store", async () => ({ ...(await vi.importActual<typeof import("../src/lib/job-store")>("../src/lib/job-store")), addPayment: sdk.addPayment,
loadJob: sdk.loadJob }));
import type {
  JobPolicy,
  PaymentRequestContent,
  ProviderRef,
  Transport,
} from "@dvmkit/sdk/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  addPayment: vi.fn(),
  commitAgentSpend: vi.fn(async () => undefined),
  buildTempoCredential: vi.fn(),
  enforceGlobalBudget: vi.fn(),
  loadAgentWallet: vi.fn(),
  loadConfig: vi.fn(),
  loadJob: vi.fn(),
  loadX402Wallet: vi.fn(),
  recordSpend: vi.fn(),
  prepareAgentSpend: vi.fn(),
  tempoCredentialAmountMicro: vi.fn(),
  tryX402Payment: vi.fn(),
  usdcToMsats: vi.fn(),
}));

vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
  addPayment: sdk.addPayment,
  buildTempoCredential: sdk.buildTempoCredential,
  loadAgentWallet: sdk.loadAgentWallet,
  loadConfig: sdk.loadConfig,
  loadJob: sdk.loadJob,
  loadX402Wallet: sdk.loadX402Wallet,
  tempoCredentialAmountMicro: sdk.tempoCredentialAmountMicro,
  tryX402Payment: sdk.tryX402Payment,
  usdcToMsats: sdk.usdcToMsats,
}));

vi.mock("../src/lib/budget-ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/budget-ledger")>()),
  enforceGlobalBudget: sdk.enforceGlobalBudget,
  recordSpend: sdk.recordSpend,
}));

vi.mock("../src/lib/wallet-agent/spend", () => ({
  prepareAgentSpend: sdk.prepareAgentSpend,
  commitAgentSpend: sdk.commitAgentSpend,
  abandonPendingSubmission: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/wallet-agent/recovery-submissions", () => ({ sweepPendingSubmissions: async () => undefined }));

import lockfile from "proper-lockfile";
import { streamLoop } from "../src/lib/stream-loop";
import { waitForJob } from "../src/lib/wait-for-job";
import { DvmError, type Message } from "@dvmkit/sdk/internal";
import { handlePaymentRequest } from "../src/lib/payment-responder";

const policy: JobPolicy = {
  maxTotalMsats: 100_000,
  autoPayBelowMsats: 100_000,
  maxIncrementMsats: 100_000,
  maxPayments: 1,
};
const provider = { endpoint: "https://dvm.example" } as ProviderRef;
const x402Offer = {
  required_usdc_micro: "10000",
  pay_to: "0x0000000000000000000000000000000000000001",
  network: "eip155:8453",
  asset: "0x0000000000000000000000000000000000000002",
  payment_required: "challenge",
} as unknown as NonNullable<PaymentRequestContent["x402"]>;

afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("mid-job payment rail selection", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("Network disabled for this unit test");
    }));
    sdk.loadJob.mockReturnValue({
      endpoint: provider.endpoint,
      totalPaidMsats: 0,
      paymentsHonoured: 0,
      jobToken: "job-token",
    });
    sdk.enforceGlobalBudget.mockResolvedValue(100_000);
    sdk.loadAgentWallet.mockReturnValue({ proofs: [{}] });
    sdk.loadConfig.mockReturnValue({ tempo: { method: "tempo", apiKey: "0xkey" } });
    sdk.loadX402Wallet.mockReturnValue({ privateKey: "0xkey" });
    sdk.tempoCredentialAmountMicro.mockReturnValue(10_000n);
    sdk.usdcToMsats.mockReturnValue(12_000);
  });


  const railAsk = () => request({ lock_pubkey: "02" + "01".repeat(32), mints: ["https://mint.example"], x402: x402Offer,
    tempo: { challenges: [{ method: "tempo" }] } as PaymentRequestContent["tempo"] });
  const walletPrep = (ask: PaymentRequestContent) => {
    sdk.prepareAgentSpend.mockResolvedValue({ cashuToken: "cashu-proof", requestId: "spend-1",
      mint: "https://mint.example", totalSats: 10, intendedLockPubkey: ask.lock_pubkey });
    sdk.buildTempoCredential.mockReturnValue({ credential: "tempo-proof" });
  };

  it.each(["cashu", "tempo"] as const)("%s send failing 60 seconds after dispatch still gets a full settle window", async (rail) => {
    vi.useFakeTimers();
    try {
      const { jobId, transport } = await setup(`late-send-${rail}`);
      const ask = railAsk(); walletPrep(ask);
      transport.sendMessage.mockImplementationOnce(() => new Promise((_, reject) =>
        setTimeout(() => reject(new DvmError("timeout", "Reply lost")), 60_000)));
      const pay = () => handlePaymentRequest(jobId, ask, policy, transport, provider, { rail, requestSeq: 5 });
      const first = expect(pay()).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(60_000);
      await first;
      // Immediate rerun, provider history does not show the payment yet.
      const outcome = await pay().then((r) => ({ resolved: r }), (e) => ({ code: e.code }));
      expect(outcome).toEqual({ code: "payment_settling" });
      expect(transport.sendMessage).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("serializes concurrent Cashu payers even after the settle window", async () => {
    vi.useFakeTimers();
    try {
      const { jobId, transport } = await setup("concurrent-send");
      const ask = railAsk(); walletPrep(ask);
      let finishSend!: () => void;
      transport.sendMessage.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSend = resolve; }));
      const pay = () => handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "cashu", requestSeq: 5 });
      const first = pay();
      await vi.advanceTimersByTimeAsync(46_000);
      const outcome = await pay().then((r) => ({ resolved: r }), (e) => ({ code: e.code }));
      finishSend();
      await first;
      expect(outcome).toEqual({ code: "payment_settling" });
      expect(transport.sendMessage).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("wait pays an uncertain charge followed by an answered concurrent prompt", async () => {
    vi.useFakeTimers();
    try {
      const { store, jobId, transport, history } = await setup("answered-prompt-wait");
      store.updateJob(jobId, { inFlightPaymentRequestSeqs: [5], inFlightPaymentRequestStartedAtMs: { 5: Date.now() - 60_000 } });
      // SDK keeps status awaiting-input while pendingPayment is set after a prompt is answered.
      const messages: Message[] = [...history(false),
        { seq: 7, from: "provider", timestamp: 0, type: "prompt", content: { id: "p", text: "Continue?" } },
        { seq: 8, from: "requester", timestamp: 0, type: "response", content: { prompt_id: "p", text: "yes" } } as Message];
      transport.getMessages.mockResolvedValue(messages);
      transport.status.mockResolvedValue({ status: "awaiting-input" });
      const stream = vi.fn().mockResolvedValue({ messages });
      const pending = waitForJob({ jobId, policy, provider, transport: { ...transport, stream }, afterSeq: 8 }, 600_000);
      await vi.advanceTimersByTimeAsync(600_000);
      const result = await pending;
      expect(result.autoPayments).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it.each([false, true])("wait pays after the settle window with an incremental stream (explicit after=%s)", async (explicit) => {
    vi.useFakeTimers();
    try {
      const { store, jobId, transport, history } = await setup(`window-expiry-${explicit}`);
      store.markPaymentRequestInFlight(jobId, 5);
      const messages = history(false);
      transport.getMessages.mockImplementation(async (_job, after) => messages.filter((message) => message.seq > after));
      const stream = vi.fn(async (_job, after) => ({ messages: messages.filter((message) => message.seq > after), reason: "yield" as const }));
      const pending = waitForJob({ jobId, policy, provider, transport: { ...transport, stream },
        afterSeq: 4, afterSeqExplicit: explicit }, 180_000);
      await vi.advanceTimersByTimeAsync(180_000);
      const result = await pending;
      expect(transport.sendMessage).toHaveBeenCalledTimes(1);
      expect(result.autoPayments).toHaveLength(1);
      expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it.each([
    { explicit: false, seqs: [5] },
    { explicit: true, seqs: [5] },
    { explicit: true, seqs: [3, 5] },
  ])("wait pins its returned cursor behind the earliest unresolved payment and delivers intervening messages once (%j)", async ({ explicit, seqs }) => {
    vi.useFakeTimers();
    try {
      const { store, jobId, transport, history } = await setup(`pinned-cursor-${explicit}-${seqs.join("-")}`);
      for (const seq of seqs) store.markPaymentRequestInFlight(jobId, seq);
      const after = seqs[0] - 1;
      const asks = seqs.map((seq) => ({ ...history(false)[0], seq }));
      const progress: Message = { seq: 6, from: "provider", timestamp: 0, type: "text", content: { text: "Still working" } };
      transport.getMessages.mockResolvedValue([...asks, progress]);
      const stream = vi.fn();
      const onMessage = vi.fn();
      const pending = waitForJob({ jobId, policy, provider, transport: { ...transport, stream },
        afterSeq: after, afterSeqExplicit: explicit, onMessage }, 3000);
      await vi.advanceTimersByTimeAsync(3000);
      const result = await pending;
      expect(result.cursor).toBe(4);
      expect(result.messages.map((message) => message.seq)).toEqual([...seqs, 6]);
      expect(onMessage.mock.calls.map(([message]) => message.seq)).toEqual([...seqs, 6]);
      expect(transport.sendMessage).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("wait releases the payment lock during history-read backoff and reacquires before reconciling", async () => {
    vi.useFakeTimers();
    try {
      const { store, jobId, transport, history } = await setup("history-lock-backoff");
      store.markPaymentRequestInFlight(jobId, 5);
      const { withJobPaymentLock } = await import("../src/lib/payment-lock");
      let readCount = 0;
      transport.getMessages.mockImplementation(async () => {
        readCount++;
        if (readCount === 1) throw new DvmError("timeout", "History unavailable");
        await expect(withJobPaymentLock(jobId, async () => undefined)).rejects.toMatchObject({ code: "payment_settling" });
        return history(true);
      });
      const stream = vi.fn().mockResolvedValue({ messages: [] });
      const pending = waitForJob({ jobId, policy, provider, transport: { ...transport, stream }, afterSeq: 5 }, 2000);
      await vi.advanceTimersByTimeAsync(0);
      const lockDuringBackoff = await withJobPaymentLock(jobId, async () => "available").catch((error) => error.code);
      await vi.advanceTimersByTimeAsync(2000);
      await pending;
      expect(lockDuringBackoff).toBe("available");
      expect(readCount).toBeGreaterThan(1);
      expect(store.loadJob(jobId)?.paidPaymentRequestSeqs).toEqual([5]);
      expect(transport.sendMessage).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each(["cashu", "tempo", "x402"] as const)("prevents a %s send after losing the lock during preparation", async (rail) => {
    const { store, jobId, transport } = await setup(`lost-lock-${rail}`);
    const ask = railAsk(); walletPrep(ask);
    const loseLock = paymentLockLoss();
    sdk.enforceGlobalBudget.mockImplementationOnce(async () => {
      loseLock();
      return 100_000;
    });
    await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail, requestSeq: 5 }))
      .rejects.toMatchObject({ code: "payment_settling" });
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toEqual([5]);
  });

  it("does not retry a Cashu send after the lock is compromised", async () => {
    const { store, jobId, transport } = await setup("lost-lock-retry");
    const ask = railAsk(); walletPrep(ask);
    const loseLock = paymentLockLoss();
    transport.sendMessage.mockImplementationOnce(async () => {
      loseLock();
      throw new DvmError("mint_unreachable", "Mint unavailable");
    });
    await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "cashu", requestSeq: 5 }))
      .rejects.toMatchObject({ code: "payment_settling" });
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
    expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toEqual([5]);
  });

  it.each(["cashu", "tempo", "x402"] as const)("books an accepted %s payment after lock loss during the send", async (rail) => {
    const { store, jobId, transport } = await setup(`accepted-lost-lock-${rail}`);
    const ask = railAsk(); walletPrep(ask);
    const loseLock = paymentLockLoss();
    transport.sendMessage.mockImplementationOnce(async () => { loseLock(); return { seq: 6 }; });
    const outcome = await handlePaymentRequest(jobId, ask, policy, transport, provider, { rail, requestSeq: 5 })
      .catch((error: unknown) => error);
    expect(sdk.addPayment).toHaveBeenCalledExactlyOnceWith(jobId, rail === "cashu" ? 10_000 : 12_000,
      { requestSeq: 5, approval: "auto" });
    expect(sdk.recordSpend).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      jobId, msats: rail === "cashu" ? 10_000 : 12_000,
    }));
    expect(sdk.commitAgentSpend).toHaveBeenCalledTimes(rail === "cashu" ? 1 : 0);
    expect(outcome).toMatchObject({ status: "paid" });
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
    expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toBeUndefined();
    expect(store.loadJob(jobId)?.paidPaymentRequestSeqs).toEqual([5]);
  });

  it.each(["refused", "unknown"])("records a %s outcome after lock loss during the send", async (outcome) => {
    const { store, jobId, ask, transport } = await setup(`lost-lock-${outcome}`);
    const loseLock = paymentLockLoss();
    const startedAt = Date.now();
    transport.sendMessage.mockImplementationOnce(async () => {
      loseLock();
      if (outcome === "refused") throw new DvmError("payment_invalid", "Refused", undefined, { http_status: 402 });
      throw new DvmError("timeout", "Reply lost");
    });
    await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 }))
      .rejects.toMatchObject({ code: outcome === "refused" ? "payment_invalid" : "timeout" });
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
    expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toEqual(outcome === "refused" ? undefined : [5]);
    if (outcome === "unknown")
      expect(store.loadJob(jobId)?.inFlightPaymentRequestStartedAtMs?.[5]).toBeGreaterThanOrEqual(startedAt);
    expect(store.loadJob(jobId)?.paidPaymentRequestSeqs).toBeUndefined();
    expect(sdk.addPayment).not.toHaveBeenCalled();
    expect(sdk.recordSpend).not.toHaveBeenCalled();
  });

  it("does not auto-pay an older unanswered request superseded by a paid newer request", async () => {
    const { jobId, ask, transport } = await setup("superseded-stream");
    const messages: Message[] = [
      { seq: 5, from: "provider", timestamp: 0, type: "payment-request", content: ask },
      { seq: 7, from: "provider", timestamp: 0, type: "payment-request", content: ask },
      { seq: 8, from: "requester", timestamp: 0, type: "payment", content: { amount_msats: 12_000 } },
      { seq: 9, from: "provider", timestamp: 0, type: "text", content: { text: "Thanks" } },
    ];
    const stream = vi.fn().mockResolvedValueOnce({ messages }).mockResolvedValue({ messages: [] });
    const result = await streamLoop({ jobId, policy: { ...policy, maxPayments: 5 }, provider,
      transport: { ...transport, stream }, afterSeq: 0, afterSeqExplicit: true });
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(result.autoPayments).toEqual([]);
    expect(result.nextAction).toMatchObject({ type: "poll" });
  });

  it("wait abandons a superseded in-flight request without repeatedly reading history or delivering its messages", async () => {
    vi.useFakeTimers();
    try {
      const { store, jobId, ask, transport, history } = await setup("abandoned-wait");
      store.markPaymentRequestInFlight(jobId, 5);
      const messages: Message[] = [...history(false),
        { seq: 7, from: "provider", timestamp: 0, type: "payment-request", content: ask },
        { seq: 8, from: "requester", timestamp: 0, type: "payment", content: { amount_msats: 12_000 } },
        { seq: 9, from: "provider", timestamp: 0, type: "text", content: { text: "Thanks" } },
      ];
      transport.getMessages.mockResolvedValue(messages);
      const stream = vi.fn(async (_job, after) => ({ messages: messages.filter((message) => message.seq > after), reason: "yield" as const }));
      const onMessage = vi.fn();
      const opts = { jobId, policy, provider, transport: { ...transport, stream }, afterSeq: 4, afterSeqExplicit: true, onMessage };
      const waiting = waitForJob(opts, 3000);
      await vi.advanceTimersByTimeAsync(3000);
      const result = await waiting;
      expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toBeUndefined();
      expect(store.loadJob(jobId)?.inFlightPaymentRequestStartedAtMs).toBeUndefined();
      expect(store.loadJob(jobId)?.paidPaymentRequestSeqs).not.toContain(5);
      expect(transport.getMessages).toHaveBeenCalledTimes(1);
      expect(result.cursor).toBe(9);
      expect(result.messages.map((message) => message.seq)).toEqual([5, 7, 8, 9]);
      onMessage.mockClear();
      const reconnected = waitForJob({ ...opts, afterSeq: result.cursor }, 3000);
      await vi.advanceTimersByTimeAsync(3000);
      expect((await reconnected).messages).toEqual([]);
      expect(onMessage).not.toHaveBeenCalled();
      expect(transport.getMessages).toHaveBeenCalledTimes(1);
      expect(transport.sendMessage).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("restamps every Cashu retry even when the request is already in flight", async () => {
    vi.useFakeTimers();
    try {
      const { store, jobId, transport } = await setup("retry-start");
      const ask = railAsk(); walletPrep(ask);
      const startedAt = Date.now();
      transport.sendMessage.mockRejectedValueOnce(new DvmError("mint_unreachable", "Mint unavailable"))
        .mockImplementationOnce(async () => {
          expect(store.loadJob(jobId)?.inFlightPaymentRequestStartedAtMs).toEqual({ 5: startedAt + 250 });
          throw new DvmError("timeout", "Reply lost");
        });
      const first = handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "cashu", requestSeq: 5 }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(250);
      expect(await first).toMatchObject({ code: "timeout" });
      expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toEqual([5]);
      expect(transport.sendMessage).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("wait keeps polling without paying while another command holds the payment lock", async () => {
    vi.useFakeTimers();
    try {
      const { store, jobId, transport, history } = await setup("wait-lock");
      store.updateJob(jobId, { inFlightPaymentRequestSeqs: [5], inFlightPaymentRequestStartedAtMs: { 5: Date.now() - 60_000 } });
      const { withJobPaymentLock } = await import("../src/lib/payment-lock");
      let release!: () => void;
      const held = withJobPaymentLock(jobId, () => new Promise<void>((resolve) => { release = resolve; }));
      const progress: Message = { seq: 6, from: "provider", timestamp: 0, type: "text", content: { text: "Still processing" } };
      transport.getMessages.mockResolvedValue([...history(false), progress]);
      const stream = vi.fn().mockResolvedValue({ messages: history(false) });
      const onMessage = vi.fn();
      const pending = waitForJob({ jobId, policy, provider, transport: { ...transport, stream }, afterSeq: 5, onMessage }, 2000);
      await vi.advanceTimersByTimeAsync(2000);
      const result = await pending;
      release();
      await held;
      expect(result.nextAction).toMatchObject({ type: "poll" });
      expect(result.messages).toEqual([progress]);
      expect(onMessage).toHaveBeenCalledExactlyOnceWith(progress);
      expect(transport.sendMessage).not.toHaveBeenCalled();
      expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toEqual([5]);
    } finally { vi.useRealTimers(); }
  });

  it("concurrent stream auto-payers send one payment", async () => {
    const { jobId, transport, ask, history } = await setup("stream-lock");
    let finishSend!: () => void;
    let started!: () => void;
    const sending = new Promise<void>((resolve) => { started = resolve; });
    transport.sendMessage.mockImplementationOnce(() => {
      started();
      return new Promise<void>((resolve) => { finishSend = resolve; });
    });
    const stream = vi.fn().mockResolvedValue({ messages: history(false) });
    const { streamLoop } = await import("../src/lib/stream-loop");
    const first = handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 });
    await sending;
    const second = await streamLoop({ jobId, policy, provider, transport: { ...transport, stream }, afterSeq: 4 });
    finishSend();
    await first;
    expect(second.nextAction).toMatchObject({ type: "poll" });
    expect(second.autoPayments).toEqual([]);
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
  });

  // A refused or never-dispatched payment must not prevent paying the same ask later.
  it.each([
    ["payment_invalid", () => new DvmError("payment_invalid", "Invalid payment", undefined, { http_status: 402 })],
    ["payment_insufficient", () => new DvmError("payment_insufficient", "Insufficient payment", undefined, { http_status: 402 })],
    ["structured refusal", () => new DvmError("invalid_request", "Invalid request", undefined, { http_status: 400 })],
    ["connection refused", () => new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) })],
    ["DNS failure", () => new TypeError("fetch failed", { cause: Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" }) })],
  ])("releases the in-flight request after %s", async (label, makeError) => {
    const { store, jobId, ask, transport } = await setup(label);
    transport.sendMessage.mockRejectedValueOnce(makeError());
    await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 })).rejects.toBeTruthy();
    expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toBeUndefined();
    await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 }))
      .resolves.toMatchObject({ status: "paid" });
    expect(transport.sendMessage).toHaveBeenCalledTimes(2);
    expect(store.loadJob(jobId)?.paidPaymentRequestSeqs).toEqual([5]);
  });

  it("records replay_rejected as paid without sending another payment", async () => {
    const { store, jobId, ask, transport } = await setup("replay");
    transport.sendMessage.mockRejectedValueOnce(new DvmError("replay_rejected", "Already accepted", undefined, { http_status: 409 }));
    await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 }))
      .resolves.toMatchObject({ status: "paid" });
    expect(store.loadJob(jobId)?.paidPaymentRequestSeqs).toEqual([5]);
    expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toBeUndefined();
    await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 }))
      .rejects.toMatchObject({ code: "payment_already_sent" });
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["timeout", () => new DvmError("timeout", "Reply lost")],
    ["connection reset", () => new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) })],
    ["unstructured server failure", () => new DvmError("provider_error", "Server failed", undefined, { http_status: 500 })],
    ["unparseable reply", () => new SyntaxError("Invalid JSON")],
  ])("retains %s until history can resolve it", async (label, makeError) => {
    const { store, jobId, ask, transport } = await setup(label);
    transport.sendMessage.mockRejectedValueOnce(makeError());
    await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 })).rejects.toBeTruthy();
    expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toEqual([5]);
    transport.getMessages.mockRejectedValueOnce(new DvmError("provider_unreachable", "History unavailable"));
    await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 }))
      .rejects.toMatchObject({ code: "provider_unreachable" });
    expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toEqual([5]);
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("explicit pay resolves an unknown send from history (paid=%s)", async (paid) => {
    const { store, jobId, ask, transport, history } = await setup(`manual-${paid}`);
    transport.sendMessage.mockRejectedValueOnce(new DvmError("timeout", "Reply lost"));
    await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 })).rejects.toMatchObject({ code: "timeout" });
    transport.getMessages.mockResolvedValue(history(paid));
    store.updateJob(jobId, { inFlightPaymentRequestStartedAtMs: { 5: Date.now() - 45_000 } });
    transport.sendMessage.mockImplementation(async () => {
      expect(transport.getMessages).toHaveBeenCalledWith(jobId, 0, provider, { jobToken: "job-token", timeoutMs: 60_000 });
    });
    const retry = handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 });
    if (paid) await expect(retry).rejects.toMatchObject({ code: "payment_already_sent" });
    else await expect(retry).resolves.toMatchObject({ status: "paid" });
    expect(transport.sendMessage).toHaveBeenCalledTimes(paid ? 1 : 2);
    expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toBeUndefined();
    expect(store.loadJob(jobId)?.paidPaymentRequestSeqs).toEqual([5]);
  });

  it.each(["cashu", "tempo", "x402"] as const)("defers a replacement %s payment until the provider can record the lost send", async (rail) => {
    vi.useFakeTimers();
    try {
      const { store, jobId, transport, history } = await setup(`settling's ${rail}`);
      const ask = request({
        lock_pubkey: "02" + "01".repeat(32), mints: ["https://mint.example"],
        x402: x402Offer, tempo: { challenges: [{ method: "tempo" }] } as PaymentRequestContent["tempo"],
      });
      sdk.prepareAgentSpend.mockResolvedValue({ cashuToken: "cashu-proof", requestId: "spend-1",
        mint: "https://mint.example", totalSats: 10, intendedLockPubkey: ask.lock_pubkey });
      sdk.buildTempoCredential.mockReturnValue({ credential: "tempo-proof" });
      transport.sendMessage.mockRejectedValueOnce(new DvmError("timeout", "Reply lost"));
      const pay = () => handlePaymentRequest(jobId, ask, policy, transport, provider, { rail, requestSeq: 5 });
      const startedAt = Date.now();
      await expect(pay()).rejects.toMatchObject({ code: "timeout" });
      expect(store.loadJob(jobId)?.inFlightPaymentRequestStartedAtMs).toEqual({ 5: startedAt });
      transport.getMessages.mockResolvedValue(history(false));
      await expect(pay()).rejects.toMatchObject({ code: "payment_settling",
        hint: expect.stringContaining("in about 45 seconds") });
      expect(transport.sendMessage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(44_999);
      await expect(pay()).rejects.toMatchObject({ code: "payment_settling",
        message: "The previous payment may still be processing.",
        hint: expect.stringContaining(String.raw`dvm pay 'payment-settling'\''s ${rail}'`),
        data: { retry_at_ms: startedAt + 45_000 } });
      expect(transport.sendMessage).toHaveBeenCalledTimes(1);
      expect(sdk.prepareAgentSpend).toHaveBeenCalledTimes(rail === "cashu" ? 1 : 0);
      expect(sdk.buildTempoCredential).toHaveBeenCalledTimes(rail === "tempo" ? 1 : 0);
      expect(sdk.tryX402Payment).toHaveBeenCalledTimes(rail === "x402" ? 1 : 0);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pay()).resolves.toMatchObject({ status: "paid" });
      expect(transport.sendMessage).toHaveBeenCalledTimes(2);
      expect(store.loadJob(jobId)?.inFlightPaymentRequestStartedAtMs).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it.each(["processing", "completed", "different charge", "complete", "cancel", "working", "missing charge"])("does not replace a lost payment after the window when the provider shows %s", async (state) => {
    const { store, jobId, ask, transport, history } = await setup(`changed-${state}`);
    store.updateJob(jobId, { inFlightPaymentRequestSeqs: [5],
      inFlightPaymentRequestStartedAtMs: { 5: Date.now() - 45_001 } });
    transport.status.mockResolvedValue({ status: ["processing", "completed"].includes(state) ? state : "awaiting-input" });
    const changed = history(false);
    if (state === "different charge") changed.push({ ...changed[0], seq: 7 });
    if (state === "complete") changed.push({ seq: 7, from: "provider", timestamp: 0, type: "complete", content: {} });
    if (state === "working") changed.push({ seq: 7, from: "provider", timestamp: 0, type: "working", content: {} });
    if (state === "cancel") changed.push({ seq: 7, from: "provider", timestamp: 0, type: "cancel", content: { reason: "Stopped" } });
    transport.getMessages.mockResolvedValue(state === "missing charge" ? [] : changed);
    await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 }))
      .rejects.toMatchObject({ code: "payment_request_not_pending" });
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toEqual(state === "different charge" ? undefined : [5]);
  });

  it.each([false, true])("keeps the latest charge payable alongside a later prompt (answered=%s)", async (answered) => {
    const { store, jobId, ask, transport, history } = await setup(`prompt-${answered}`);
    store.updateJob(jobId, { inFlightPaymentRequestSeqs: [5], inFlightPaymentRequestStartedAtMs: { 5: Date.now() - 60_000 } });
    const messages: Message[] = [...history(false), { seq: 7, from: "provider", timestamp: 0, type: "prompt", content: { id: "p", text: "Continue?" } }];
    if (answered) messages.push({ seq: 8, from: "requester", timestamp: 0, type: "response", content: { prompt_id: "p", text: "yes" } });
    transport.getMessages.mockResolvedValue(messages);
    await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 })).resolves.toMatchObject({ status: "paid" });
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each(["history", "status"])("normalizes a transport %s timeout into payment recovery guidance", async (boundary) => {
    const { store, jobId, ask, transport } = await setup("reader's job");
    store.updateJob(jobId, { inFlightPaymentRequestSeqs: [5] });
    const timeout = new DvmError("timeout", "Message poll timed out.", "Unquoted transport hint");
    if (boundary === "history") transport.getMessages.mockRejectedValue(timeout);
    else transport.status.mockRejectedValue(timeout);
    await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 })).rejects.toMatchObject({
      code: "timeout", message: "Payment recovery read timed out. No new payment was sent.",
      hint: expect.stringContaining(String.raw`dvm pay 'payment-reader'\''s job'`),
    });
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it("reads the clock once at the settlement boundary", async () => {
    const { store, jobId, transport } = await setup("clock-boundary");
    const startedAt = Date.now();
    store.updateJob(jobId, { inFlightPaymentRequestSeqs: [5], inFlightPaymentRequestStartedAtMs: { 5: startedAt } });
    const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt + 45_000);
    const { reconcileInFlightPaymentRequest } = await import("../src/lib/yield-state");
    await expect(reconcileInFlightPaymentRequest(jobId, 5, transport, provider, {})).resolves.toBe(false);
    expect(clock).toHaveBeenCalledTimes(1);
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it("caps a future stored timestamp at one settle window", async () => {
    const { store, jobId, transport } = await setup("future-clock");
    const now = Date.now();
    store.updateJob(jobId, { inFlightPaymentRequestSeqs: [5], inFlightPaymentRequestStartedAtMs: { 5: now + 3_600_000 } });
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { reconcileInFlightPaymentRequest } = await import("../src/lib/yield-state");
    await expect(reconcileInFlightPaymentRequest(jobId, 5, transport, provider, {})).rejects.toMatchObject({
      code: "payment_settling", data: { retry_at_ms: now + 45_000 }, hint: expect.stringContaining("in about 45 seconds"),
    });
  });

  it("retries an older in-flight record without a timestamp only while the same charge is pending", async () => {
    const { store, jobId, ask, transport } = await setup("legacy");
    store.updateJob(jobId, { inFlightPaymentRequestSeqs: [5] });
    await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 }))
      .resolves.toMatchObject({ status: "paid" });
    expect(transport.status).toHaveBeenCalledWith(jobId, provider, { jobToken: "job-token", timeoutMs: 60_000 });
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each(["history", "status"])("bounds a hanging pre-send %s read and never pays", async (boundary) => {
    vi.useFakeTimers();
    try {
      const { store, jobId, ask, transport } = await setup("hung-history");
      store.markPaymentRequestInFlight(jobId, 5);
      if (boundary === "status") {
        store.updateJob(jobId, { inFlightPaymentRequestStartedAtMs: { 5: Date.now() - 45_000 } });
        transport.status.mockImplementation(() => new Promise(() => undefined));
      } else transport.getMessages.mockImplementation(() => new Promise(() => undefined));
      const pending = handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 });
      const rejected = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(transport.sendMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await rejected).toMatchObject({ code: "timeout", message: "Payment recovery read timed out. No new payment was sent.", hint: expect.stringContaining("dvm pay") });
      expect(transport.sendMessage).not.toHaveBeenCalled();
      expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toEqual([5]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("wait rechecks the provider and pays once when the injected clock reaches the settle deadline", async () => {
    vi.useFakeTimers();
    try {
      const { store, jobId, transport, history } = await setup("wait-settle");
      store.markPaymentRequestInFlight(jobId, 5);
      const startedAt = Date.now();
      let elapsed = 0;
      const clock = () => startedAt + elapsed;
      const progress: Message = { seq: 6, from: "provider", timestamp: 0, type: "text", content: { text: "Still processing" } };
      transport.getMessages.mockResolvedValue([...history(false), progress]);
      const onMessage = vi.fn();
      const stream = vi.fn().mockResolvedValueOnce({ messages: [...history(false), progress] })
        .mockResolvedValue({ messages: [{ seq: 7, from: "provider", timestamp: 0, type: "prompt", content: { id: "continue", text: "Continue?" } }] });
      const pending = waitForJob({ jobId, policy, provider, transport: { ...transport, stream }, afterSeq: 5, onMessage }, 120_000, clock);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(transport.getMessages.mock.calls.length).toBeGreaterThan(1);
      expect(transport.sendMessage).not.toHaveBeenCalled();
      expect(stream).not.toHaveBeenCalled();
      elapsed = 45_000;
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await pending;
      expect(result.autoPayments).toHaveLength(1);
      expect(result.messages.filter((message) => message.seq === 6)).toEqual([progress]);
      expect(result.messages.map((message) => message.seq)).toEqual([5, 6, 7]);
      expect(onMessage.mock.calls.filter(([message]) => message.seq === 6)).toEqual([[progress]]);
      expect(transport.sendMessage).toHaveBeenCalledTimes(1);
      expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it("wait returns a newer prompt while preserving the uncertain older payment", async () => {
    const { store, jobId, transport, history } = await setup("superseded");
    store.markPaymentRequestInFlight(jobId, 5);
    const progress: Message = { seq: 6, from: "provider", timestamp: 0, type: "text", content: { text: "Still working" } };
    const messages: Message[] = [...history(false), progress, { seq: 7, from: "provider", timestamp: 0,
      type: "prompt", content: { id: "continue", text: "Continue?" } }];
    transport.getMessages.mockResolvedValue(messages);
    const stream = vi.fn().mockResolvedValue({ messages });
    const onMessage = vi.fn();
    const result = await waitForJob({ jobId, policy, provider, transport: { ...transport, stream }, afterSeq: 4, onMessage }, 60_000);
    expect(result.cursor).toBe(4);
    expect(result.messages).toContainEqual(progress);
    expect(onMessage).toHaveBeenCalledWith(progress);
    const { loadMessages } = await import("../src/lib/messages");
    expect(loadMessages(jobId)).toContainEqual(progress);
    expect(result.nextAction).toMatchObject({ type: "respond", prompt_id: "continue" });
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toEqual([5]);
  });

  it.each([false, true])("wait resolves an unknown send from history (paid=%s)", async (paid) => {
    vi.useFakeTimers();
    try {
      const { store, jobId, ask, transport, history } = await setup(`wait-${paid}`);
      transport.sendMessage.mockRejectedValueOnce(new DvmError("timeout", "Reply lost"));
      await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 })).rejects.toMatchObject({ code: "timeout" });
      transport.getMessages.mockResolvedValue(history(paid));
      const stream = vi.fn().mockResolvedValueOnce({ messages: history(false) })
        .mockResolvedValue({ messages: [{ seq: 7, from: "provider", timestamp: 0, type: "prompt", content: { id: "continue", text: "Continue?" } }] });
      const pending = waitForJob({ jobId, policy, provider, transport: { ...transport, stream }, afterSeq: 4, jobToken: "job-token" }, 60_000);
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.nextAction).toMatchObject({ type: "respond", prompt_id: "continue" });
      expect(result.autoPayments).toHaveLength(paid ? 0 : 1);
      expect(transport.sendMessage).toHaveBeenCalledTimes(paid ? 1 : 2);
      expect(transport.getMessages).toHaveBeenCalledWith(jobId, 0, provider, { jobToken: "job-token", timeoutMs: expect.any(Number) });
      expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toBeUndefined();
      expect(store.loadJob(jobId)?.paidPaymentRequestSeqs).toEqual([5]);
    } finally { vi.useRealTimers(); }
  });
  it("retries an uncertain-payment history timeout before automatic spending", async () => {
    vi.useFakeTimers();
    try {
      const { store, jobId, transport, history } = await setup("history-timeout");
      store.markPaymentRequestInFlight(jobId, 5);
      transport.getMessages.mockRejectedValueOnce(new DvmError("timeout", "History timed out"))
        .mockResolvedValue(history(true));
      const stream = vi.fn().mockResolvedValue({ messages: [{ seq: 7, from: "provider", timestamp: 0, type: "prompt", content: { id: "continue", text: "Continue?" } }] });
      const start = Date.now();
      const pending = waitForJob({ jobId, policy, provider, transport: { ...transport, stream }, afterSeq: 5, jobToken: "job-token" }, 60_000);
      await vi.runAllTimersAsync();
      expect((await pending).nextAction).toMatchObject({ type: "respond" });
      expect(Date.now() - start).toBe(1000);
      expect(transport.getMessages).toHaveBeenCalledTimes(2);
      expect(transport.sendMessage).not.toHaveBeenCalled();
      expect(store.loadJob(jobId)?.paidPaymentRequestSeqs).toEqual([5]);
      expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

});

function request(
  overrides: Partial<PaymentRequestContent> = {}
): PaymentRequestContent {
  return {
    amount_msats: 10_000,
    reason: "Continue the job",
    ...overrides,
  } as PaymentRequestContent;
}

function fakeTransport(): Transport & { sendMessage: ReturnType<typeof vi.fn> } {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  } as unknown as Transport & { sendMessage: ReturnType<typeof vi.fn> };
}

async function setup(label: string) {
  const store = await vi.importActual<typeof import("../src/lib/job-store")>("../src/lib/job-store");
  const jobId = `payment-${label}`;
  store.saveJob({ id: jobId, endpoint: provider.endpoint, status: "processing", submittedAt: 0, jobToken: "job-token" });
  sdk.loadJob.mockImplementation(store.loadJob);
  sdk.tryX402Payment.mockResolvedValue({ paymentHeader: "x402-proof", amountMsats: 12_000, amountUsdcMicro: "10000", btcRate: 100_000 });
  const ask = request({ x402: x402Offer });
  const transport = { ...fakeTransport(), getMessages: vi.fn().mockResolvedValue([]), status: vi.fn().mockResolvedValue({ status: "awaiting-input" }), describe: vi.fn().mockResolvedValue({}) };
  const history = (paid: boolean): Message[] => [
    { seq: 5, from: "provider", timestamp: 0, type: "payment-request", content: ask },
    ...(paid ? [{ seq: 6, from: "requester", timestamp: 0, type: "payment", content: { amount_msats: 12_000 } } as Message] : []),
  ];
  transport.getMessages.mockResolvedValue(history(false));
  return { store, jobId, ask, transport, history };
}

function paymentLockLoss(): () => void {
  const acquire = lockfile.lockSync.bind(lockfile);
  let loseLock: () => void = () => { throw new Error("Payment lock not acquired"); };
  vi.spyOn(lockfile, "lockSync").mockImplementation((file, options) => {
    const release = acquire(file, options);
    if (!String(file).includes(".payment-")) return release;
    let lost = false;
    loseLock = () => {
      lost = true;
      release();
      options?.onCompromised?.(new Error("Lock ownership lost"));
    };
    return () => { if (!lost) release(); };
  });
  return () => loseLock();
}
