import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUDGET_FILE, CREDITS_FILE, JOBS_FILE, RECEIPTS_FILE,
  applyReceiptCredit, attestedDvmIdentity, loadCredit, loadReceipt, receiptPubkeyFromSecret,
  recordFundResponse, signDrawFundingReceipt,
  type DrawFundingReceipt, type JobStatus, type Transport,
} from "@dvmkit/sdk/internal";
import { attestedDvm } from "../src/lib/__tests__/fixtures/receipt-fixture";
import { settleCreditAfterJob, settleCreditAfterRead } from "../src/lib/credit-topup";
import { loadJob, saveJob, updateJob } from "../src/lib/job-store";
import { captureTransportReceipt, fetchMissingJobReceipt } from "../src/lib/receipt-capture";
import { captureDrawFundingReceipts } from "../src/lib/draw-funding";
import { info, json, withOutputWarnings } from "../src/lib/output";
import { handlePaymentRequest } from "../src/lib/payment-responder";
import { status } from "../src/commands/status";
import { HttpsTransport } from "../src/lib/transport/https";
import { loadLedger } from "../src/lib/budget-ledger";
import { commitHeldSubmission, prepareAgentSpend } from "../src/lib/wallet-agent/spend";

const market = vi.hoisted(() => ({ rate: 100_000 }));
vi.mock("../src/lib/btc-rate", () => ({ resolveBtcUsdRate: async () => ({ rate: market.rate, stale: false }) }));
vi.mock("@dvmkit/sdk/internal", async (original) => ({
  ...await original<typeof import("@dvmkit/sdk/internal")>(), loadAgentWallet: () => ({ proofs: [], pending_submissions: [], recent_spends: [] }),
}));
vi.mock("../src/lib/wallet-agent/spend", () => ({
  prepareAgentSpend: vi.fn(async () => ({ cashuToken: "mint-fixture", requestId: "fund-1",
    mint: "https://mint.invalid", totalSats: 50, intendedLockPubkey: "02" + "01".repeat(32) })),
  commitAgentSpend: vi.fn(async () => undefined),
  commitHeldSubmission: vi.fn(async () => undefined),
  abandonPendingSubmission: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/wallet-agent/recovery-submissions", () => ({ sweepPendingSubmissions: async () => undefined }));

const stdout = vi.hoisted((): string[] => []);
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const writeSync = ((fd: number, buffer: Buffer, offset?: number, length?: number) => {
    if (fd !== 1) return fs.writeSync(fd, buffer, offset, length);
    const start = offset ?? 0;
    const end = start + (length ?? buffer.length - start);
    stdout.push(buffer.subarray(start, end).toString("utf8"));
    return end - start;
  }) as typeof fs.writeSync;
  return { ...fs, default: { ...fs, writeSync }, writeSync };
});

vi.mock("../src/lib/output", async (original) => ({
  ...await original<typeof import("../src/lib/output")>(), info: vi.fn(),
}));

const dvm = attestedDvm();
const identity = attestedDvmIdentity(dvm.anchor)!;
const signing = { privkey: "01".repeat(32), pubkey: receiptPubkeyFromSecret("01".repeat(32)) };
const endpoint = "https://provider.invalid";
const jobId = "job-funded";
const creditId = "credit-held";
const drawId = "draw-funded";
const transport = { credit: vi.fn(), describe: vi.fn(), sendMessage: vi.fn() } as unknown as Transport;

beforeEach(() => {
  for (const path of [BUDGET_FILE, CREDITS_FILE, JOBS_FILE, RECEIPTS_FILE]) rmSync(path, { force: true });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
});

const ask = { amount_msats: 50_000, reason: "Additional work", lock_pubkey: "02" + "01".repeat(32), mints: ["https://mint.invalid"] };
const policy = { maxTotalMsats: 1_000_000, maxIncrementMsats: 1_000_000, autoPayBelowMsats: 1_000_000, maxPayments: 3 };

function wire(receipt: unknown = funding(), code = 201, error?: string, seq = 8) {
  const observed = response();
  const fetch = vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith("/v1/info")) return Response.json({ builder: dvm.anchor });
    if (String(url).endsWith("/messages")) return Response.json({ seq, draw_funding_receipt: receipt,
      ...(error ? { error } : {}) }, { status: code });
    if (String(url) === `${endpoint}/v1/job/${jobId}`) return Response.json({ status: "completed",
      receipt: observed.receipt, draw_funding_receipts: [funding()] });
    throw new Error("Unexpected endpoint");
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const pay = () => handlePaymentRequest(jobId, ask, policy, new HttpsTransport(), { endpoint }, { rail: "cashu", requestSeq: 4 });

describe("payment acknowledgement funding evidence", () => {
  it("retains an accepted Cashu request before wallet commit failure and refuses a second spend", async () => {
    seed();
    wire();
    const failure = new Error("Wallet commit unavailable");
    vi.mocked(commitHeldSubmission).mockRejectedValueOnce(failure);
    await expect(pay()).rejects.toBe(failure);
    expect(loadJob(jobId)?.paidPaymentRequestSeqs).toEqual([4]);
    await expect(pay()).rejects.toMatchObject({ code: "payment_already_sent" });
    expect(prepareAgentSpend).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/messages"))).toHaveLength(1);
  });

  it("retains funding when the acknowledgement cursor advances beyond the inbound payment", async () => {
    seed();
    const receipt = funding({ payment_seq: 8 });
    const fetch = wire(receipt, 201, undefined, 9);
    await expect(pay()).resolves.toMatchObject({ status: "paid", rail: "cashu_p2pk" });
    expect(loadJob(jobId)?.drawFundingReceipts).toEqual([receipt]);
    fetch.mockClear();
    // No recovery evidence: reconciliation must use the durable acknowledgement.
    await settle(response());
    expect(loadCredit(endpoint, signing.pubkey, identity)).toMatchObject({ remainingMicro: 400_000, ledgerSeq: 6 });
    expect(warnings()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([100_000, 200_000])("uses signed native funding when the caller's BTC rate is %s", async (rate) => {
    seed();
    market.rate = rate;
    const fetch = wire();
    await expect(pay()).resolves.toMatchObject({ status: "paid", rail: "cashu_p2pk" });
    expect(loadJob(jobId)?.drawFundingReceipts?.[0].funded_micro).toBe(50_000);
    const ledger = loadLedger();
    expect(ledger.entries).toHaveLength(1);
    fetch.mockClear();
    await settle(response());
    expect(loadCredit(endpoint, signing.pubkey, identity)?.remainingMicro).toBe(400_000);
    expect(warnings()).toEqual([]);
    expect(loadLedger()).toEqual(ledger);
    expect(prepareAgentSpend).toHaveBeenCalledTimes(1);
    expect(commitHeldSubmission).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [503, "job_snapshot_unavailable"], [500, "payment_unapplied"],
  ])("retains committed funding on HTTP %s without treating the failed payment as success", async (status, code) => {
    seed();
    const fetch = wire(funding(), status, code);
    await expect(pay()).rejects.toMatchObject({ code });
    expect(loadJob(jobId)?.drawFundingReceipts).toHaveLength(1);
    expect(loadJob(jobId)?.paymentsHonoured).toBeUndefined();
    expect(commitHeldSubmission).not.toHaveBeenCalled();
    fetch.mockClear();
    await settle(response());
    expect(warnings()).toEqual([]);
    expect(loadCredit(endpoint, signing.pubkey, identity)?.remainingMicro).toBe(400_000);
  });

  it("books a replay refusal as paid and retains its signed funding", async () => {
    seed();
    const fetch = wire(funding(), 409, "replay_rejected");
    await expect(pay()).resolves.toMatchObject({ status: "paid", rail: "cashu_p2pk" });
    expect(loadJob(jobId)?.drawFundingReceipts).toHaveLength(1);
    expect(loadJob(jobId)?.paidPaymentRequestSeqs).toEqual([4]);
    expect(loadJob(jobId)?.inFlightPaymentRequestSeqs).toBeUndefined();
    expect(loadJob(jobId)?.paymentsHonoured).toBe(1);
    expect(commitHeldSubmission).toHaveBeenCalledTimes(1);
    fetch.mockClear();
    await settle(response());
    expect(warnings()).toEqual([]);
    expect(loadCredit(endpoint, signing.pubkey, identity)?.remainingMicro).toBe(400_000);
  });

  it("clears a structured Cashu payment_invalid refusal for retry", async () => {
    seed();
    wire(undefined, 402, "payment_invalid");
    await expect(pay()).rejects.toMatchObject({ code: "payment_invalid" });
    expect(loadJob(jobId)?.inFlightPaymentRequestSeqs).toBeUndefined();
    expect(loadJob(jobId)?.unconfirmedPaymentSubmissions).toBeUndefined();
    wire();
    await expect(pay()).resolves.toMatchObject({ status: "paid" });
    expect(loadJob(jobId)?.paidPaymentRequestSeqs).toEqual([4]);
  });

  // The provider accumulates a short Cashu token before it finds the shortfall,
  // so it keeps it; only an explicit approval may sign another payment.
  it("holds a short Cashu payment the provider kept until an explicit pay", async () => {
    seed();
    const fetch = wire(undefined, 402, "payment_insufficient");
    await expect(pay()).rejects.toMatchObject({ code: "payment_insufficient" });
    expect(loadJob(jobId)?.unconfirmedPaymentSubmissions?.[4]).toMatchObject({ blocked: { reason: "credit_held" } });
    fetch.mockClear();
    await expect(pay()).resolves.toBe("needs-approval");
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/messages"))).toBe(false);
    wire();
    await expect(handlePaymentRequest(jobId, ask, policy, new HttpsTransport(), { endpoint },
      { rail: "cashu", requestSeq: 4, approval: "explicit" })).resolves.toMatchObject({ status: "paid" });
    expect(prepareAgentSpend).toHaveBeenCalledTimes(2);
    expect(loadJob(jobId)?.paidPaymentRequestSeqs).toEqual([4]);
  });

  it("keeps an unparseable payment refusal uncertain", async () => {
    seed();
    const fetch = wire();
    fetch.mockImplementationOnce(async () => Response.json({ builder: dvm.anchor }));
    fetch.mockImplementationOnce(async () => new Response("Invalid reply", { status: 402 }));
    await expect(pay()).rejects.toMatchObject({ code: "payment_insufficient" });
    expect(loadJob(jobId)?.inFlightPaymentRequestSeqs).toEqual([4]);
    expect(commitHeldSubmission).not.toHaveBeenCalled();
  });

  it("recovers a lost acknowledgement from the provider's job read", async () => {
    seed();
    const fetch = wire();
    fetch.mockImplementationOnce(async () => Response.json({ builder: dvm.anchor }));
    fetch.mockImplementationOnce(async () => { throw new TypeError("Lost acknowledgement"); });
    await expect(pay()).rejects.toThrow("Lost acknowledgement");
    expect(loadJob(jobId)?.drawFundingReceipts).toBeUndefined();
    const fetched = await fetchMissingJobReceipt(jobId, new HttpsTransport(), { endpoint });
    expect(loadJob(jobId)?.drawFundingReceipts).toHaveLength(1);
    fetch.mockClear();
    await settle({ ...response(), ...fetched });
    expect(warnings()).toEqual([]);
  });

  it("retains valid recovery evidence beside a malformed array member", async () => {
    seed();
    const fetch = wire();
    fetch.mockResolvedValueOnce(Response.json({ status: "completed", receipt: response().receipt,
      draw_funding_receipts: [funding(), {}] }));
    const fetched = await fetchMissingJobReceipt(jobId, new HttpsTransport(), { endpoint });
    expect(fetched.drawFundingReceiptParseError).toBe("shape_invalid");
    await settle({ ...response(), ...fetched });
    expect(warnings()).toEqual([]);
    expect(loadCredit(endpoint, signing.pubkey, identity)?.remainingMicro).toBe(400_000);
  });

  it.each(["shape", "fund"])("does not admit %s-mismatched acknowledgements", async (kind) => {
    seed();
    const receipt = kind === "shape" ? { kind: "credit_draw_funding" }
      : funding({ fund_id: "other-payment" });
    const fetch = wire(receipt);
    await pay();
    expect(loadJob(jobId)?.drawFundingReceipts).toBeUndefined();
    fetch.mockClear();
    await settle(response());
    expect(warnings()).toHaveLength(1);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function seed(remaining = 500_000, seq = 5): void {
  recordFundResponse({ endpoint, identity, callerPubkey: signing.pubkey, targetMicro: 500_000,
    credit: { credit_id: creditId, currency: "usd", balance_micro: remaining + 100_000,
      remaining_micro: remaining + 100_000, ledger_seq: seq - 1, expiry_ms: Date.now() + 86400000,
      expired: false, drainable: true } });
  saveJob({ id: "previous-job", endpoint, status: "completed", submittedAt: Date.now(), builderAnchor: dvm.anchor });
  const previous = dvm.sign({ job_id: "previous-job", requester_pubkey: signing.pubkey,
    credit: { credit_id: creditId, draw_id: "previous-draw", amount: 100_000,
      balance_after: remaining, ledger_seq: seq } });
  expect(captureTransportReceipt("previous-job", { receipt: previous }).status).toBe("verified");
  applyReceiptCredit({ endpoint, identity, callerPubkey: signing.pubkey, jobId: "previous-job",
    outcome: "completed", credit: previous.credit! });
  saveJob({ id: jobId, endpoint, status: "processing", submittedAt: Date.now(),
    builderAnchor: dvm.anchor, receiptsSupported: true,
    creditBinding: { creditId, drawId, callerPubkey: signing.pubkey } });
}

function funding(overrides: Partial<DrawFundingReceipt> = {}): DrawFundingReceipt {
  return signDrawFundingReceipt({ v: 1, kind: "credit_draw_funding", credit_id: creditId,
    job_id: jobId, draw_id: drawId, fund_id: "fund-1", payment_seq: 8, currency: "usd",
    funded_micro: 50_000, balance_after_micro: 400_000, ledger_seq: 6,
    issued_at: 1789300000, caller_pubkey: signing.pubkey,
    dvm_id: identity.dvmId, dvm: "wordcount", receipt_pubkey: dvm.receiptKey.pubkey,
    ...overrides }, dvm.receiptKey.secret);
}

function response(balance = 400_000, seq = 6): JobStatus {
  return { jobId, status: "completed", receipt: dvm.sign({ job_id: jobId,
    requester_pubkey: signing.pubkey, credit: { credit_id: creditId, draw_id: drawId,
      amount: 150_000, balance_after: balance, ledger_seq: seq } }) };
}

async function settle(observed: JobStatus): Promise<void> {
  const networkCalls = vi.mocked(fetch).mock.calls.length;
  const capture = captureTransportReceipt(jobId, observed);
  expect(capture.status).toBe("verified");
  await settleCreditAfterJob({ capture, transport, ref: { endpoint }, signing,
    providerInfo: { builder: dvm.anchor }, allowTopup: false });
  expect(fetch).toHaveBeenCalledTimes(networkCalls);
  expect(transport.credit).not.toHaveBeenCalled();
  expect(transport.describe).not.toHaveBeenCalled();
  expect(transport.sendMessage).not.toHaveBeenCalled();
}

function warnings(): string[] {
  return vi.mocked(info).mock.calls.map(([line]) => line).filter((line) => line.includes("balance mismatch"));
}

describe("signed draw funding reconciliation", () => {
  it("reconciles recovered funding on a job read without a signing key or additional spending", async () => {
    seed();
    const capture = captureTransportReceipt(jobId, { ...response(), drawFundingReceipts: [funding()] });
    const ledger = loadLedger();
    await settleCreditAfterRead({ job: loadJob(jobId)!, capture, transport });
    expect(loadCredit(endpoint, signing.pubkey, identity)).toMatchObject({ remainingMicro: 400_000, ledgerSeq: 6 });
    expect(warnings()).toEqual([]);
    expect(loadLedger()).toEqual(ledger);
    expect(transport.credit).not.toHaveBeenCalled();
    expect(transport.describe).not.toHaveBeenCalled();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(prepareAgentSpend).not.toHaveBeenCalled();
    expect(commitHeldSubmission).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { before: 500_000, after: 400_000, seq: 6 },
    { before: 400_000, after: 300_000, seq: 7 },
  ])("adopts $after at sequence $seq without a false warning", async ({ before, after, seq }) => {
    seed(before, seq - 1);
    const receipt = funding({ ledger_seq: seq, balance_after_micro: after });
    await settle({ ...response(after, seq), drawFundingReceipts: [receipt] });
    expect(loadCredit(endpoint, signing.pubkey, identity)).toMatchObject({ remainingMicro: after, ledgerSeq: seq });
    expect(loadCredit(endpoint, signing.pubkey, identity)?.discrepancy).toBeUndefined();
    expect(warnings()).toEqual([]);
    expect(loadJob(jobId)).toHaveProperty("drawFundingReceipts", [receipt]);
  });

  it("keeps a genuine contradiction and its signed evidence after external funding", async () => {
    seed();
    const observed = { ...response(390_000), drawFundingReceipts: [funding()] };
    await settle(observed);
    expect(warnings()).toHaveLength(1);
    expect(loadCredit(endpoint, signing.pubkey, identity)).toMatchObject({ remainingMicro: 390_000,
      discrepancy: { expectedMicro: 400_000, reportedMicro: 390_000, fundedMicro: 50_000,
        jobId, drawId, ledgerSeq: 6, priorJobId: "previous-job" } });
    expect(loadReceipt("previous-job")?.verification).toBe("verified");
    expect(loadReceipt(jobId)?.receipt).toEqual(observed.receipt);
    expect(loadJob(jobId)).toHaveProperty("drawFundingReceipts", observed.drawFundingReceipts);
  });

  it.each(["absent", "signature", "caller", "credit", "job", "draw", "currency", "provider", "sequence"])(
    "keeps sequential mismatch detection with %s evidence", async (kind) => {
      seed();
      const changes: Partial<DrawFundingReceipt> = kind === "caller" ? { caller_pubkey: "ab".repeat(32) }
        : kind === "job" ? { job_id: "other-job" }
        : kind === "credit" ? { credit_id: "other-credit" }
        : kind === "draw" ? { draw_id: "other-draw" }
        : kind === "currency" ? { currency: "eur" }
        : kind === "provider" ? { dvm_id: "other-provider" }
        : kind === "sequence" ? { ledger_seq: 7 } : {};
      const receipt = funding(changes);
      if (kind === "signature") receipt.funded_micro++;
      await settle({ ...response(), ...(kind === "absent" ? {} : { drawFundingReceipts: [receipt] }) });
      expect(warnings()).toHaveLength(1);
      expect(loadCredit(endpoint, signing.pubkey, identity)?.discrepancy).toMatchObject({
        expectedMicro: 350_000, reportedMicro: 400_000,
      });
    }
  );

  it("rejects an unrelated attestation with the same DVM name", async () => {
    seed();
    const other = attestedDvm();
    const receipt = signDrawFundingReceipt({ ...funding(), receipt_pubkey: other.receiptKey.pubkey }, other.receiptKey.secret);
    await settle({ ...response(), drawFundingReceipts: [receipt] });
    expect(warnings()).toHaveLength(1);
    expect(loadJob(jobId)?.drawFundingReceipts).toBeUndefined();
  });

  it("deduplicates funding and does not apply it twice on terminal replay", async () => {
    seed();
    const receipt = funding();
    await settle({ ...response(), drawFundingReceipts: [receipt, receipt] });
    await settle({ ...response(), drawFundingReceipts: [receipt] });
    expect(loadCredit(endpoint, signing.pubkey, identity)).toMatchObject({ remainingMicro: 400_000, ledgerSeq: 6 });
    expect(loadJob(jobId)?.drawFundingReceipts).toHaveLength(1);
    expect(warnings()).toEqual([]);
  });

  it("adds distinct provider-signed payments without counting a replay twice", async () => {
    seed();
    const first = funding({ funded_micro: 25_000 });
    const second = funding({ fund_id: "fund-2", funded_micro: 25_000 });
    await settle({ ...response(), drawFundingReceipts: [first, second, first] });
    expect(loadCredit(endpoint, signing.pubkey, identity)?.remainingMicro).toBe(400_000);
    expect(loadJob(jobId)?.drawFundingReceipts).toHaveLength(2);
    expect(warnings()).toEqual([]);
  });

  it("does not let a stale receipt or funding replay touch newer credit metadata", async () => {
    seed();
    const observed = { ...response(), drawFundingReceipts: [funding()] };
    await settle(observed);
    recordFundResponse({ endpoint, identity, callerPubkey: signing.pubkey, targetMicro: 900_000,
      credit: { credit_id: creditId, currency: "usd", balance_micro: 800_000,
        remaining_micro: 800_000, ledger_seq: 9, expiry_ms: Date.now() + 86400000,
        expired: false, drainable: true } });
    const before = loadCredit(endpoint, signing.pubkey, identity);
    await settle(observed);
    expect(loadCredit(endpoint, signing.pubkey, identity)).toEqual(before);
  });

  it.each(["failed", "cancelled"] as const)("adopts released value on a %s draw without consuming funds", async (outcome) => {
    seed();
    const receipt = dvm.sign({ job_id: jobId, requester_pubkey: signing.pubkey, outcome,
      credit: { credit_id: creditId, draw_id: drawId, amount: 150_000,
        balance_after: 550_000, ledger_seq: 6 } });
    await settle({ jobId, status: outcome, receipt, drawFundingReceipts: [funding()] });
    expect(loadCredit(endpoint, signing.pubkey, identity)).toMatchObject({ remainingMicro: 550_000, ledgerSeq: 6 });
    expect(loadCredit(endpoint, signing.pubkey, identity)?.drawFundings).toBeUndefined();
    expect(warnings()).toEqual([]);
  });

  it("subtracts the complete draw for balance-paid asks with no external funding", async () => {
    seed();
    await settle(response(350_000));
    expect(loadCredit(endpoint, signing.pubkey, identity)).toMatchObject({ remainingMicro: 350_000, ledgerSeq: 6 });
    expect(warnings()).toEqual([]);
  });

  it("recovers funding beside a delayed receipt without paying or refreshing balances", async () => {
    seed();
    const observed = { ...response(), drawFundingReceipts: [funding()] };
    const status = vi.fn().mockResolvedValue(observed);
    const fetched = await fetchMissingJobReceipt(jobId, { status } as unknown as Transport, { endpoint });
    expect(loadJob(jobId)?.drawFundingReceipts).toHaveLength(1);
    await settle({ ...response(), ...fetched });
    expect(loadCredit(endpoint, signing.pubkey, identity)?.remainingMicro).toBe(400_000);
    expect(warnings()).toEqual([]);
    expect(status).toHaveBeenCalledTimes(1);
  });

  it("re-verifies durable evidence instead of trusting an edited job record", async () => {
    seed();
    captureDrawFundingReceipts(jobId, [funding()]);
    updateJob(jobId, { drawFundingReceipts: [{ ...funding(), funded_micro: 60_000 }] });
    await settle(response());
    expect(warnings()).toHaveLength(1);
    expect(loadCredit(endpoint, signing.pubkey, identity)?.discrepancy?.expectedMicro).toBe(350_000);
  });

  it("does not file evidence from a different endpoint or an unbound job", () => {
    seed();
    captureDrawFundingReceipts(jobId, [funding()], { endpoint: "https://other.invalid" });
    expect(loadJob(jobId)?.drawFundingReceipts).toBeUndefined();
    updateJob(jobId, { creditBinding: { unbound: true, callerPubkey: signing.pubkey } });
    captureDrawFundingReceipts(jobId, [funding()]);
    expect(loadJob(jobId)?.drawFundingReceipts).toBeUndefined();
  });

  it.each(["signature", "caller"])("does not adopt a terminal receipt with an invalid %s", async (kind) => {
    seed();
    const before = loadCredit(endpoint, signing.pubkey, identity);
    const receipt = dvm.sign({ ...response().receipt!,
      ...(kind === "caller" ? { requester_pubkey: "ab".repeat(32) } : {}) });
    if (kind === "signature") receipt.credit!.balance_after--;
    const capture = captureTransportReceipt(jobId, { receipt, drawFundingReceipts: [funding()] });
    await settleCreditAfterJob({ capture, transport, ref: { endpoint }, signing,
      providerInfo: { builder: dvm.anchor }, allowTopup: false });
    expect(loadCredit(endpoint, signing.pubkey, identity)).toEqual(before);
  });
});

function implicitFunding(overrides: Partial<DrawFundingReceipt> = {}): DrawFundingReceipt {
  return funding({ credit_id: "imp:cashu:first-payment", draw_id: "first-payment", ...overrides });
}

function fundingWarnings(): string[] {
  return vi.mocked(info).mock.calls.map(([line]) => line).filter((line) => line.includes("mid-job funding evidence"));
}

describe("mid-job funding evidence warnings", () => {
  it.each([
    ["no credit binding", () => updateJob(jobId, { creditBinding: undefined })],
    ["an unbound job", () => updateJob(jobId, { creditBinding: { unbound: true, callerPubkey: signing.pubkey } })],
  ])("stays silent for implicit-credit funding on %s", (_label, unbind) => {
    seed();
    unbind();
    vi.mocked(info).mockClear();
    captureDrawFundingReceipts(jobId, [implicitFunding()], { endpoint, fundId: "fund-1" });
    expect(fundingWarnings()).toEqual([]);
    expect(loadJob(jobId)?.drawFundingReceipts).toBeUndefined();
  });

  it.each([
    ["no credit binding", () => updateJob(jobId, { creditBinding: undefined })],
    ["an unbound job", () => updateJob(jobId, { creditBinding: { unbound: true, callerPubkey: signing.pubkey } })],
  ])("warns no_bound_draw for prepaid-credit funding on %s", (_label, unbind) => {
    seed();
    unbind();
    vi.mocked(info).mockClear();
    captureDrawFundingReceipts(jobId, [funding()], { endpoint, fundId: "fund-1" });
    expect(fundingWarnings()).toEqual([expect.stringContaining("did not verify (no_bound_draw)")]);
    expect(fundingWarnings()[0]).toContain(`funding for credit "${creditId}", but this job records no draw on it`);
    expect(fundingWarnings()[0]).toContain(`\`dvm credit balance ${endpoint}\` once the job ends`);
    expect(fundingWarnings()[0]).not.toContain("--credit-id");
    expect(loadJob(jobId)?.drawFundingReceipts).toBeUndefined();
  });

  it("keeps an unverified credit id out of the relayed command", () => {
    seed();
    updateJob(jobId, { creditBinding: { unbound: true, callerPubkey: signing.pubkey } });
    vi.mocked(info).mockClear();
    const hostile = "x'; rm -rf ~ #$(id)";
    captureDrawFundingReceipts(jobId, [{ ...funding(), credit_id: hostile }], { endpoint, fundId: "fund-1" });
    expect(fundingWarnings()).toEqual([expect.stringContaining("did not verify (no_bound_draw)")]);
    expect(fundingWarnings()[0]).toContain(
      `funding for credit ${JSON.stringify(hostile)}, but this job records no draw on it`);
    expect(fundingWarnings()[0]).toContain(`\`dvm credit balance ${endpoint}\` once the job ends`);
    expect(fundingWarnings()[0]).not.toContain("--credit-id");
    expect(fundingWarnings()[0].match(/`[^`]*`/g)).toEqual([`\`dvm credit balance ${endpoint}\``]);
  });

  it.each([
    ["job_id_mismatch", () => implicitFunding({ job_id: "other-job" }), 'job_id "other-job"; this job expects "job-funded"'],
    ["fund_id_mismatch", () => implicitFunding({ fund_id: "other-payment" }), 'fund_id "other-payment"; this job expects "fund-1"'],
    ["signature_invalid", () => ({ ...implicitFunding(), funded_micro: 60_000 }), "funding evidence failed verification"],
  ])("still checks an implicit-credit receipt for %s", (reason, build, hint) => {
    seed();
    updateJob(jobId, { creditBinding: { unbound: true, callerPubkey: signing.pubkey } });
    vi.mocked(info).mockClear();
    captureDrawFundingReceipts(jobId, [build()], { endpoint, fundId: "fund-1" });
    expect(fundingWarnings()).toEqual([expect.stringContaining(`did not verify (${reason})`)]);
    expect(fundingWarnings()[0]).toContain(hint);
    expect(fundingWarnings()[0]).not.toContain("--credit-id");
  });

  it("collapses identical evidence and keeps distinct evidence within one command", async () => {
    seed();
    updateJob(jobId, { creditBinding: { unbound: true, callerPubkey: signing.pubkey } });
    vi.mocked(info).mockClear();
    stdout.length = 0;
    await withOutputWarnings(async () => {
      captureDrawFundingReceipts(jobId, [funding()], { endpoint });
      captureDrawFundingReceipts(jobId, [funding()], { endpoint });
      captureDrawFundingReceipts(jobId, [funding({ credit_id: "other-credit" })], { endpoint });
      captureDrawFundingReceipts(jobId, [implicitFunding({ job_id: "other-job" })], { endpoint });
      json({ ok: true });
    });
    const out = JSON.parse(stdout.join("")) as { warnings: { reason: string; hint: string }[] };
    expect(out.warnings.map((warning) => warning.reason)).toEqual(["no_bound_draw", "no_bound_draw", "job_id_mismatch"]);
    expect(out.warnings[0].hint).toContain(`credit "${creditId}"`);
    expect(out.warnings[1].hint).toContain('credit "other-credit"');
    expect(fundingWarnings()).toHaveLength(3);
  });

  it("stays silent for evidence that is not a draw-funding receipt", () => {
    seed();
    vi.mocked(info).mockClear();
    const { job_id: _job, draw_id: _draw, ...plain } = funding();
    captureDrawFundingReceipts(jobId, [{ ...plain, kind: "credit_funding" }], { endpoint, fundId: "fund-1" });
    expect(fundingWarnings()).toEqual([]);
    expect(loadJob(jobId)?.drawFundingReceipts).toBeUndefined();
  });

  it("stores verified Cashu funding without a warning", () => {
    seed();
    vi.mocked(info).mockClear();
    captureDrawFundingReceipts(jobId, [funding()], { endpoint, fundId: "fund-1" });
    expect(fundingWarnings()).toEqual([]);
    expect(loadJob(jobId)?.drawFundingReceipts).toHaveLength(1);
  });

  it.each([
    ["credit_id_mismatch", { credit_id: "other-credit" }, 'credit_id "other-credit"; this job expects "credit-held"'],
    ["job_id_mismatch", { job_id: "other-job" }, 'job_id "other-job"; this job expects "job-funded"'],
    ["draw_id_mismatch", { draw_id: "other-draw" }, 'draw_id "other-draw"; this job expects "draw-funded"'],
    ["fund_id_mismatch", { fund_id: "other-payment" }, 'fund_id "other-payment"; this job expects "fund-1"'],
    ["caller_pubkey_mismatch", { caller_pubkey: "ab".repeat(32) }, `caller_pubkey "${"ab".repeat(32)}"; this job expects "${signing.pubkey}"`],
  ] as const)("names the signed and expected value for %s", (reason, changes, hint) => {
    seed();
    vi.mocked(info).mockClear();
    captureDrawFundingReceipts(jobId, [funding(changes)], { endpoint, fundId: "fund-1" });
    expect(fundingWarnings()).toEqual([expect.stringContaining(`did not verify (${reason})`)]);
    expect(fundingWarnings()[0]).toContain(`Hint: The provider signed ${hint}.`);
    expect(loadJob(jobId)?.drawFundingReceipts).toBeUndefined();
  });

  it.each([
    ["signature_invalid", () => ({ ...funding(), funded_micro: 60_000 })],
    ["receipt_key_mismatch", () => {
      const other = attestedDvm();
      const { signature: _signature, ...unsigned } = funding();
      return signDrawFundingReceipt({ ...unsigned, receipt_pubkey: other.receiptKey.pubkey }, other.receiptKey.secret);
    }],
  ])("reports the verifier reason %s", (reason, build) => {
    seed();
    vi.mocked(info).mockClear();
    captureDrawFundingReceipts(jobId, [build()], { endpoint, fundId: "fund-1" });
    expect(fundingWarnings()).toEqual([expect.stringContaining(`did not verify (${reason})`)]);
    expect(fundingWarnings()[0]).toContain("Hint: The provider's funding evidence failed verification. Nothing is owed or lost");
    expect(fundingWarnings()[0]).toContain(`report job "${jobId}" and the reason to the provider`);
  });
});

describe("Cashu top-ups on a job without a bound draw", () => {
  const payAt = (requestSeq: number) =>
    handlePaymentRequest(jobId, ask, policy, new HttpsTransport(), { endpoint }, { rail: "cashu", requestSeq });

  it("stays silent while the provider signs implicit-credit funding for each payment", async () => {
    seed();
    updateJob(jobId, { creditBinding: { unbound: true, callerPubkey: signing.pubkey } });
    wire(implicitFunding());
    vi.mocked(info).mockClear();
    for (const requestSeq of [4, 5, 6]) {
      await expect(payAt(requestSeq)).resolves.toMatchObject({ status: "paid", rail: "cashu_p2pk" });
    }
    expect(fundingWarnings()).toEqual([]);
    expect(loadJob(jobId)?.paidPaymentRequestSeqs).toEqual([4, 5, 6]);
  });

  it("warns no_bound_draw in the JSON output for prepaid-credit funding", async () => {
    seed();
    updateJob(jobId, { creditBinding: { unbound: true, callerPubkey: signing.pubkey } });
    wire(funding());
    vi.mocked(info).mockClear();
    stdout.length = 0;
    await withOutputWarnings(async () => {
      await expect(payAt(4)).resolves.toMatchObject({ status: "paid", rail: "cashu_p2pk" });
      json({ ok: true });
    });
    expect(fundingWarnings()).toEqual([expect.stringContaining("did not verify (no_bound_draw)")]);
    expect(JSON.parse(stdout.join("")).warnings).toEqual([{
      code: "draw_funding_unverified", job_id: jobId, reason: "no_bound_draw",
      hint: expect.stringContaining(`dvm credit balance ${endpoint}`), display: expect.stringContaining("no_bound_draw"),
    }]);
  });

  it("surfaces the warning in status JSON", async () => {
    seed();
    updateJob(jobId, { creditBinding: { unbound: true, callerPubkey: signing.pubkey } });
    wire(funding());
    vi.mocked(info).mockClear();
    stdout.length = 0;
    await status(jobId, {});
    expect(fundingWarnings()).toEqual([expect.stringContaining("did not verify (no_bound_draw)")]);
    const out = stdout.join("").trim().split("\n").map((line) => JSON.parse(line) as { warnings?: unknown });
    expect(out.at(-1)?.warnings).toEqual([expect.objectContaining({
      code: "draw_funding_unverified", job_id: jobId, reason: "no_bound_draw",
      hint: expect.stringContaining(`dvm credit balance ${endpoint}`),
    })]);
  });
});
