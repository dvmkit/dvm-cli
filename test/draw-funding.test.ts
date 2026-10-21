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
import { info } from "../src/lib/output";
import { handlePaymentRequest } from "../src/lib/payment-responder";
import { HttpsTransport } from "../src/lib/transport/https";
import { loadLedger } from "../src/lib/budget-ledger";
import { commitAgentSpend, prepareAgentSpend } from "../src/lib/wallet-agent/spend";

const market = vi.hoisted(() => ({ rate: 100_000 }));
vi.mock("../src/lib/btc-rate", () => ({ resolveBtcUsdRate: async () => ({ rate: market.rate, stale: false }) }));
vi.mock("@dvmkit/sdk/internal", async (original) => ({
  ...await original<typeof import("@dvmkit/sdk/internal")>(), loadAgentWallet: () => ({ proofs: [] }),
}));
vi.mock("../src/lib/wallet-agent/spend", () => ({
  prepareAgentSpend: vi.fn(async () => ({ cashuToken: "mint-fixture", requestId: "fund-1",
    mint: "https://mint.invalid", totalSats: 50, intendedLockPubkey: "02" + "01".repeat(32) })),
  commitAgentSpend: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/wallet-agent/recovery-submissions", () => ({ sweepPendingSubmissions: async () => undefined }));

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

function wire(receipt: unknown = funding(), code = 201, error?: string) {
  const observed = response();
  const fetch = vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith("/v1/info")) return Response.json({ builder: dvm.anchor });
    if (String(url).endsWith("/messages")) return Response.json({ seq: 8, draw_funding_receipt: receipt,
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
    expect(commitAgentSpend).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [503, "job_snapshot_unavailable"], [500, "payment_unapplied"], [409, "replay_rejected"],
  ])("retains committed funding on HTTP %s without treating the failed payment as success", async (status, code) => {
    seed();
    const fetch = wire(funding(), status, code);
    await expect(pay()).rejects.toMatchObject({ code });
    expect(loadJob(jobId)?.drawFundingReceipts).toHaveLength(1);
    expect(loadJob(jobId)?.paymentsHonoured).toBeUndefined();
    expect(commitAgentSpend).not.toHaveBeenCalled();
    fetch.mockClear();
    await settle(response());
    expect(warnings()).toEqual([]);
    expect(loadCredit(endpoint, signing.pubkey, identity)?.remainingMicro).toBe(400_000);
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

  it.each(["shape", "fund", "payment-sequence"])("does not admit %s-mismatched acknowledgements", async (kind) => {
    seed();
    const receipt = kind === "shape" ? { kind: "credit_draw_funding" }
      : funding(kind === "fund" ? { fund_id: "other-payment" } : { payment_seq: 9 });
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
    expect(commitAgentSpend).not.toHaveBeenCalled();
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
