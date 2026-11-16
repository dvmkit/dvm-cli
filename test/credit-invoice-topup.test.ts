import { rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  attestedDvmIdentity,
  CREDITS_FILE,
  DvmError,
  JOBS_FILE,
  loadCredit,
  loadPendingFunding,
  RECEIPTS_FILE,
  receiptPubkeyFromSecret,
  recordFundResponse,
  recordPendingFunding,
  type Transport,
} from "@dvmkit/sdk/internal";
import { attestedDvm } from "../src/lib/__tests__/fixtures/receipt-fixture";
import type { InvoicePendingFunding } from "../src/lib/credit-invoice";
import { resetCreditNotices, takeCreditNoticeFields } from "../src/lib/credit-notice";
import { settleCreditAfterJob } from "../src/lib/credit-topup";
import { fundViaFloat, loadFloat } from "../src/lib/float";
import { saveJob } from "../src/lib/job-store";
import { captureTransportReceipt } from "../src/lib/receipt-capture";

vi.mock("../src/lib/float", async (original) => ({
  ...await original<typeof import("../src/lib/float")>(),
  loadFloat: vi.fn(),
  fundViaFloat: vi.fn(),
}));
vi.mock("../src/lib/output", async (original) => ({
  ...await original<typeof import("../src/lib/output")>(), info: vi.fn(),
}));

const endpoint = "https://provider.invalid";
const creditId = "credit-held";
const fundId = "fund-manual";
const jobId = "job-completed";
const signing = { privkey: "01".repeat(32), pubkey: receiptPubkeyFromSecret("01".repeat(32)) };
const dvm = attestedDvm();
const identity = attestedDvmIdentity(dvm.anchor)!;

beforeEach(() => {
  for (const path of [CREDITS_FILE, JOBS_FILE, RECEIPTS_FILE]) rmSync(path, { force: true });
  resetCreditNotices();
  vi.mocked(loadFloat).mockReturnValue({ conn: {}, connectedAt: "" } as never);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetCreditNotices();
});

it.each([false, true])("reconciles a manual invoice once after a job without waiting or paying (settled: %s)", async (paid) => {
  const menu = { min_micro: 100_000, max_micro: 5_000_000, ttl_ms: 86400000, currency: "usd", funding: ["lightning"] };
  recordFundResponse({ endpoint, identity, callerPubkey: signing.pubkey, rail: "lightning", targetMicro: 500_000, menu,
    credit: { credit_id: creditId, currency: "usd", balance_micro: 100_000, remaining_micro: 100_000,
      ledger_seq: 1, expiry_ms: Date.now() + 86400000, expired: false, drainable: true } });
  const pending: InvoicePendingFunding = {
    endpoint, callerPubkey: signing.pubkey, creditId, fundId, rail: "lightning", lightningPaymentMode: "invoice",
    amountMicro: 450_000, targetMicro: 500_000, menu, requestedAt: Date.now(),
    bolt11: "lnbcrt1000n1manual", amountMsats: 450_000, paymentHash: "ab".repeat(32), expiresAtMs: Date.now() + 600_000,
  };
  recordPendingFunding(pending);
  saveJob({ id: jobId, endpoint, status: "completed", submittedAt: Date.now(), builderAnchor: dvm.anchor,
    receiptsSupported: true, creditBinding: { creditId, drawId: "draw-completed", callerPubkey: signing.pubkey } });
  const receipt = dvm.sign({ job_id: jobId, requester_pubkey: signing.pubkey,
    credit: { credit_id: creditId, draw_id: "draw-completed", amount: 50_000, balance_after: 50_000, ledger_seq: 2 } });
  const capture = captureTransportReceipt(jobId, { receipt });
  expect(capture.status).toBe("verified");
  const credit = vi.fn(async () => {
    if (paid) {
      return { op: "fund" as const, funded_micro: 450_000,
        credit: { credit_id: creditId, currency: "usd", balance_micro: 500_000, remaining_micro: 500_000,
          ledger_seq: 3, expiry_ms: Date.now() + 86400000, expired: false, drainable: true } };
    }
    throw new DvmError("lightning_settlement_pending", "Invoice not settled.", undefined, {
      lightning: { invoice: pending.bolt11, payment_hash: pending.paymentHash,
        amount_msats: pending.amountMsats, expires_at_ms: pending.expiresAtMs },
    });
  });
  const refillPocket = vi.fn(async () => undefined);
  const start = Date.now();
  let completed = false;
  const run = settleCreditAfterJob({ capture, transport: { credit } as unknown as Transport, ref: { endpoint },
    signing, providerInfo: { builder: dvm.anchor }, config: { posture: "auto" },
    signBody: (_key, body) => body, refillPocket }).then(() => { completed = true; });

  // Drain asynchronous work without advancing the human-payment polling timer.
  await vi.advanceTimersByTimeAsync(0);
  expect(completed).toBe(true);
  await run;
  expect(Date.now()).toBe(start);
  expect(vi.getTimerCount()).toBe(0);
  expect(credit).toHaveBeenCalledTimes(1);
  expect(credit).toHaveBeenCalledWith({ endpoint }, expect.objectContaining({ credit_id: creditId,
    fund: { method: "lightning", fund_id: fundId, amount_micro: 450_000 } }), undefined, expect.anything());
  expect(refillPocket).toHaveBeenCalledTimes(1);
  expect(fundViaFloat).not.toHaveBeenCalled();
  const notices = takeCreditNoticeFields();
  if (paid) {
    expect(loadPendingFunding(endpoint, signing.pubkey, creditId)).toBeUndefined();
    expect(loadCredit(endpoint, signing.pubkey, identity)?.remainingMicro).toBe(500_000);
    expect(notices.credit_funding).toMatchObject([{ route: "lightning", amount_micro: 450_000 }]);
    expect(notices.credit_funding_incomplete).toBeUndefined();
  } else {
    expect(loadPendingFunding(endpoint, signing.pubkey, creditId)).toMatchObject(pending);
    expect(loadCredit(endpoint, signing.pubkey, identity)?.remainingMicro).toBe(50_000);
    expect(notices.credit_funding).toBeUndefined();
    expect(notices.credit_funding_incomplete).toMatchObject([{ code: "credit_funding_deferred", credit_id: creditId,
      fund_id: fundId, rail: "lightning", amount_micro: 450_000, hint: expect.stringContaining("original") }]);
    expect(notices.credit_funding_incomplete?.[0]).not.toHaveProperty("spent_sats");
  }
});
