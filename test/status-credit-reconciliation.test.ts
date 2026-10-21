import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendReceipt, CREDITS_FILE, loadCredit, receiptPubkeyFromSecret, type Transport, type UnsignedJobReceipt } from "@dvmkit/sdk/internal";
import { attestedDvm, CALLER_B } from "../src/lib/__tests__/fixtures/receipt-fixture";
import { loadJob, saveJob, type JobRecord } from "../src/lib/job-store";
import { status } from "../src/commands/status";
import { creditList } from "../src/commands/credit";
import { receiptsShow, receiptsVerify } from "../src/commands/receipts";
import { settleCreditAfterJob } from "../src/lib/credit-topup";
import { requestResult } from "../src/commands/request-result";
import { saveRequestIntent } from "../src/lib/request-intent-store";
import { planProbeDraw } from "../src/lib/credit-policy";

const wire = vi.hoisted(() => ({
  status: vi.fn(), describe: vi.fn(), getMessages: vi.fn(), credit: vi.fn(),
  close: vi.fn(), json: vi.fn(),
  requestResult: vi.fn(),
}));
vi.mock("../src/lib/transport", () => ({ createDvmTransport: () => wire }));
vi.mock("../src/lib/output", async (original) => ({
  ...await original<typeof import("../src/lib/output")>(),
  info: vi.fn(), progress: vi.fn(), json: wire.json,
}));

const root = process.env.DVM_CONFIG_DIR!;
const dvm = attestedDvm();
const endpoint = "https://provider.example";
const jobId = "job-receipt";
const secret = "01".repeat(32);
const CALLER_A = receiptPubkeyFromSecret(secret);
const bound = { creditId: "held-credit", drawId: "held-draw", callerPubkey: CALLER_A };

function receipt(overrides: Partial<UnsignedJobReceipt> = {}) {
  return dvm.sign({ job_id: jobId, requester_pubkey: CALLER_A,
    credit: { credit_id: bound.creditId, draw_id: bound.drawId, amount: 150_000, balance_after: 350_000, ledger_seq: 2 },
    ...overrides });
}

function seed(overrides: Partial<JobRecord> = {}, currency = "usd") {
  writeFileSync(CREDITS_FILE, JSON.stringify({ credits: [{ endpoint, callerPubkey: CALLER_A,
    creditId: bound.creditId, currency, remainingMicro: 500_000, balanceMicro: 500_000,
    targetMicro: 5_000_000, ledgerSeq: 1, status: "active", expiryMs: Date.now() + 86_400_000,
    menu: { funding: ["cashu"], currency, min_micro: 1000, max_micro: 5_000_000, ttl_ms: 86_400_000 } }],
    implicitCredits: [], pendingFundings: [] }));
  saveJob({ id: jobId, endpoint, status: "completed", submittedAt: 1, completion: { summary: "Done" },
    creditBinding: bound, builderAnchor: dvm.anchor, receiptsSupported: true,
    totalPaidMsats: 1500, paymentsHonoured: 1, ...overrides });
  if (overrides.receipt) appendReceipt({ receipt: overrides.receipt, endpoint,
    builder: dvm.anchor, verification: "verified", verified_at: Date.now() });
}

beforeEach(() => {
  for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true, force: true });
  vi.clearAllMocks();
  wire.describe.mockResolvedValue({ builder: dvm.anchor, receipts: true });
  wire.getMessages.mockResolvedValue([]);
  wire.status.mockResolvedValue({ jobId, status: "completed", summary: "Done", receipt: receipt() });
  writeFileSync(join(root, "config.json"), JSON.stringify({ credit: { posture: "auto" }, feedback: { posture: "off" } }));
});
afterEach(() => vi.unstubAllEnvs());

describe("credit settlement on receipt reads", () => {
  it.each(["cached", "live", "messages", "stored"])("reconciles a %s terminal receipt without a signing key or funding", async (path) => {
    seed(path === "live" ? { status: "processing", completion: undefined }
      : path === "stored" ? { receipt: receipt() } : {});
    await status(jobId, { messages: path === "messages" });
    expect(wire.json).toHaveBeenLastCalledWith(expect.objectContaining({ receipt_verified: "verified" }));
    creditList({});
    expect(wire.json).toHaveBeenLastCalledWith(expect.objectContaining({
      credits: [expect.objectContaining({ remaining_micro: 350_000, currency: "usd", ledger_seq: 2 })],
    }));
    await status(jobId, {});
    receiptsShow(jobId, {});
    await receiptsVerify(jobId, {});
    expect(loadCredit(endpoint, CALLER_A)).toMatchObject({ remainingMicro: 350_000, ledgerSeq: 2 });
    expect(loadJob(jobId)).toMatchObject({ totalPaidMsats: 1500, paymentsHonoured: 1 });
    expect(wire.credit).not.toHaveBeenCalled();
    expect(wire.status).toHaveBeenCalledTimes(path === "stored" ? 0 : 1);
  });

  it("leaves an absent receipt and projection intact until the provider has proof", async () => {
    seed();
    wire.status.mockResolvedValueOnce({ jobId, status: "completed" });
    await status(jobId, {});
    expect(wire.json).toHaveBeenLastCalledWith(expect.objectContaining({ receipt_verified: "absent" }));
    expect(loadCredit(endpoint, CALLER_A)?.remainingMicro).toBe(500_000);
    await status(jobId, {});
    expect(loadCredit(endpoint, CALLER_A)?.remainingMicro).toBe(350_000);
  });

  it("retains exact non-USD micro-units without a rate conversion", async () => {
    seed({}, "eur");
    const signed = receipt({ credit: { credit_id: bound.creditId, draw_id: bound.drawId,
      amount: 150_001, balance_after: 349_999, ledger_seq: 2 } });
    wire.status.mockResolvedValue({ jobId, status: "completed", receipt: signed });
    await status(jobId, {});
    expect(loadCredit(endpoint, CALLER_A)).toMatchObject({ currency: "eur", remainingMicro: 349_999, lastPriceMicro: 150_001 });
    expect(wire.describe).not.toHaveBeenCalled();
  });

  it.each([
    ["signature", () => ({ ...receipt(), signature: "00".repeat(64) })],
    ["job", () => receipt({ job_id: "another-job" })],
    ["caller", () => receipt({ requester_pubkey: CALLER_B })],
    ["anonymous caller", () => receipt({ requester_pubkey: null })],
    ["credit", () => receipt({ credit: { ...receipt().credit!, credit_id: "another-credit" } })],
    ["draw", () => receipt({ credit: { ...receipt().credit!, draw_id: "another-draw" } })],
  ] as const)("rejects a mismatched %s on live and stored reads", async (_name, evidence) => {
    seed({ status: "processing", completion: undefined });
    const before = loadCredit(endpoint, CALLER_A);
    wire.status.mockResolvedValue({ jobId, status: "completed", receipt: evidence() });
    await status(jobId, {});
    await status(jobId, {});
    expect(loadCredit(endpoint, CALLER_A)).toEqual(before);
    expect(wire.credit).not.toHaveBeenCalled();
  });

  it("preserves newer credit metadata and the draw ceiling when an older job is read again", async () => {
    seed({ receipt: receipt() });
    await status(jobId, {});
    const newerJobId = "newer-job";
    const newer = receipt({ job_id: newerJobId, credit: { ...receipt().credit!, draw_id: "newer-draw",
      amount: 200_000, balance_after: 150_000, ledger_seq: 3 } });
    saveJob({ ...loadJob(jobId)!, id: newerJobId, receipt: newer,
      creditBinding: { ...bound, drawId: "newer-draw" } });
    await status(newerJobId, {});
    const before = loadCredit(endpoint, CALLER_A);
    expect(before).toMatchObject({ remainingMicro: 150_000, ledgerSeq: 3,
      lastPriceMicro: 200_000, lastReceiptJobId: newerJobId });
    await status(jobId, {});
    const replayed = loadCredit(endpoint, CALLER_A);
    expect(replayed).toEqual(before);
    expect(planProbeDraw({ stored: replayed, drawCeilingMsats: 175_000,
      drawCeilingSource: "budget", btcRate: 100_000, config: { posture: "auto" } })).toMatchObject({
      mode: "none", drawSkipped: { reason: "price_above_ceiling", lastPriceMicro: 200_000, ceilingMicro: 175_000 },
    });
  });

  it.each([
    { label: "portable endpoint", options: { endpoint, jobToken: "ab".repeat(32) }, job: {} },
    { label: "unbound job", options: {}, job: { creditBinding: { unbound: true as const, callerPubkey: CALLER_A } } },
    { label: "legacy job", options: {}, job: { creditBinding: undefined } },
    { label: "strict per-call job", options: {}, job: { strictPerCall: true as const } },
  ])("keeps $label detached from credit accounting", async ({ options, job }) => {
    seed(job);
    const before = loadCredit(endpoint, CALLER_A);
    await status(jobId, options);
    expect(loadCredit(endpoint, CALLER_A)).toEqual(before);
  });

  it("uses the backfilled builder anchor to reconcile an attested credit", async () => {
    seed({ builderAnchor: undefined });
    await status(jobId, {});
    expect(wire.describe).toHaveBeenCalledOnce();
    expect(loadCredit(endpoint, CALLER_A)?.remainingMicro).toBe(350_000);
  });

  it("also rejects invalid evidence on the shared request settlement path", async () => {
    seed();
    const signed = receipt();
    const { captureJobReceipt } = await import("../src/lib/receipt-capture");
    const capture = captureJobReceipt(jobId, { ...signed, credit: { ...signed.credit!, balance_after: 1 } });
    expect(capture.status).toBe("invalid");
    await settleCreditAfterJob({ capture, transport: wire as unknown as Transport, ref: { endpoint },
      signing: { pubkey: CALLER_A, privkey: "01".repeat(32) }, allowTopup: false });
    expect(loadCredit(endpoint, CALLER_A)?.remainingMicro).toBe(500_000);
  });

  it("reconciles a terminal request-result read and keeps its replay free of funding", async () => {
    seed({ status: "processing", completion: undefined });
    vi.stubEnv("DVM_IDENTITY_KEY", secret);
    saveRequestIntent({ v: 2, requestId: "recover-receipt", endpoint, capability: "count",
      body: { capability: "count", data: { credit_id: bound.creditId, draw_id: bound.drawId } },
      callerPubkey: CALLER_A, createdAt: 1,
      policy: { maxTotalMsats: 2000, maxIncrementMsats: 2000, autoPayBelowMsats: 2000, maxPayments: 2 },
      authAudience: { dvm_id: dvm.attestation.dvm_id, builder_pubkey: dvm.identity.pubkey },
      builderAnchor: dvm.anchor, receiptsSupported: true });
    wire.requestResult.mockResolvedValue({ jobId, status: "completed", receipt: receipt(), summary: "Done" });
    await requestResult("recover-receipt");
    await requestResult("recover-receipt");
    expect(loadCredit(endpoint, CALLER_A)).toMatchObject({ remainingMicro: 350_000, ledgerSeq: 2 });
    expect(loadJob(jobId)).toMatchObject({ totalPaidMsats: 1500, paymentsHonoured: 1 });
    expect(wire.credit).not.toHaveBeenCalled();
  });
});
