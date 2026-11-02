import { expect, it } from "vitest";
import { jobSpend } from "../job-spend";
import { addPayment, loadJob, markJobTerminal, recordUpfrontCreditPayment, saveJob } from "../job-store";
import { appendMessages } from "../messages";
import { attestedDvm } from "./fixtures/receipt-fixture";

it.each([0, 19000])("uses a verified %i-msat settlement in the headline while preserving local counters", (amount) => {
  const dvm = attestedDvm();
  const receipt = dvm.sign({ job_id: `receipt-headline-${amount}`, paid: {
    msats: amount, rail: "cashu", native_amount: null, native_asset: null, tx_hash: null, mint: null } });
  const spend = jobSpend({ id: receipt.job_id, endpoint: "https://provider.example", submittedAt: 1,
    status: "completed", totalPaidMsats: amount === 0 ? 5000 : 0, receipt, builderAnchor: dvm.anchor });
  expect(spend.total_msats).toBe(amount === 0 ? 5000 : 0);
  if (amount === 0) {
    expect(spend.display).toContain("free job");
    expect(spend.display).not.toContain("Settled 5 sats");
  } else {
    expect(spend.display).toContain("Settled 19 sats");
    expect(spend.display).not.toContain("free");
  }
});

it.each(["failed", "cancelled"] as const)("does not bill a released %s draw as paid", (status) => {
  const dvm = attestedDvm();
  const receipt = dvm.sign({ job_id: `released-${status}`, outcome: status,
    credit: { credit_id: "credit", draw_id: "draw", amount: 19000, balance_after: 50000, ledger_seq: 2 } });
  const spend = jobSpend({ id: receipt.job_id, endpoint: "https://provider.example", submittedAt: 1,
    status, totalPaidMsats: 19000, paymentsHonoured: 1, paymentMethod: "credit", receipt, builderAnchor: dvm.anchor });
  expect(spend.display).not.toMatch(/\bpaid\b/i);
  expect(spend).toMatchObject({ total_msats: 19000,
    settlement: { status: "released", settled_msats: 0, released_msats: 19000 } });
});

it.each([true, false])("distinguishes a confirmed refund from an unclaimed token (claimed=%s)", (claimed) => {
  const id = `refunded-${claimed}`;
  appendMessages(id, [{ seq: 1, from: "provider", timestamp: 1, type: "payment",
    content: { amount_msats: 6000, cashu_token: "untrusted", reason: "refund" } }]);
  const spend = jobSpend({ id, endpoint: "https://provider.example", submittedAt: 1, status: "failed",
    totalPaidMsats: 6000, paymentsHonoured: 1, paymentMethod: "cashu",
    ...(claimed ? { claimedPaymentSeqs: [1], claimedPaymentAmountsMsats: { 1: 6000 } } : {}) });
  expect(spend.display).not.toMatch(/\bpaid\b/i);
  expect(spend).toMatchObject({ total_msats: 6000,
    settlement: { status: claimed ? "refunded" : "pending", refunded_msats: claimed ? 6000 : 0, rail: "cashu" } });
});

it.each(["invalid", "wrong-job", "wrong-outcome", "legacy"])("keeps settlement unknown with %s receipt evidence", (kind) => {
  const dvm = attestedDvm();
  const signed = dvm.sign({ job_id: kind === "wrong-job" ? "another-job" : `unknown-${kind}`,
    outcome: kind === "wrong-outcome" ? "completed" : "failed",
    credit: { credit_id: "credit", draw_id: "draw", amount: 19000, balance_after: 50000, ledger_seq: 2 } });
  const receipt = kind === "invalid" ? { ...signed, credit: { ...signed.credit!, balance_after: 99999 } } : signed;
  const spend = jobSpend({ id: `unknown-${kind}`, endpoint: "https://provider.example", submittedAt: 1,
    status: "failed", totalPaidMsats: 19000, paymentsHonoured: 1,
    ...(kind === "legacy" ? {} : { receipt, builderAnchor: dvm.anchor }) });
  expect(spend).toMatchObject({ settlement: { status: "unknown", settled_msats: null } });
  expect(spend.display).not.toMatch(/\bpaid\b/i);
});

it.each(["change", "partial", "legacy-claim"])("does not claim a full refund from %s evidence", (kind) => {
  const id = `refund-evidence-${kind}`;
  appendMessages(id, [{ seq: 1, from: "provider", timestamp: 1, type: "payment",
    content: { amount_msats: 6000, cashu_token: "untrusted", reason: kind === "change" ? "change" : "refund" } }]);
  const spend = jobSpend({ id, endpoint: "https://provider.example", submittedAt: 1, status: "failed",
    totalPaidMsats: 6000, paymentsHonoured: 1, claimedPaymentSeqs: [1],
    ...(kind === "legacy-claim" ? {} : { claimedPaymentAmountsMsats: { 1: kind === "partial" ? 3000 : 6000 } }) });
  expect(spend.settlement).toMatchObject({ status: kind === "legacy-claim" ? "pending" : "unknown",
    settled_msats: null, refunded_msats: kind === "partial" ? 3000 : 0 });
});

it.each(["converted", "larger-receipt"])("does not net a Cashu refund against %s accounting", (kind) => {
  const id = `net-refund-${kind}`;
  const dvm = attestedDvm();
  appendMessages(id, [{ seq: 1, from: "provider", timestamp: 1, type: "payment",
    content: { amount_msats: 6000, cashu_token: "untrusted", reason: "refund" } }]);
  const spend = jobSpend({ id, endpoint: "https://provider.example", submittedAt: 1, status: "failed",
    totalPaidMsats: 6000, paymentsHonoured: 1, claimedPaymentSeqs: [1], claimedPaymentAmountsMsats: { 1: 6000 },
    ...(kind === "converted" ? { paymentMethod: "x402" as const }
      : { receipt: dvm.sign({ job_id: id, outcome: "failed" }), builderAnchor: dvm.anchor }) });
  expect(spend.settlement).toMatchObject({ status: "unknown", settled_msats: null, refunded_msats: 6000, rail: "cashu" });
  expect(spend.settlement.display).toContain("Final net charge is unknown");
});

it("includes the upfront Cashu payment while active and after completion", () => {
  saveJob({ id: "cashu-bill", endpoint: "https://provider.example", status: "submitted", submittedAt: 1 });
  addPayment("cashu-bill", 6000);
  addPayment("cashu-bill", 1000);
  appendMessages("cashu-bill", [
    { seq: 1, from: "provider", timestamp: 1767225600000, type: "payment-request",
      content: { amount_msats: 1000, reason: "More work" } },
    { seq: 2, from: "requester", timestamp: 1767225600000, type: "payment",
      content: { amount_msats: 1000, cashu_token: "redacted" } },
  ]);
  expect(jobSpend(loadJob("cashu-bill")!)).toMatchObject({
    total_msats: 7000, upfront_display: "6 sats", payments: 2, log_mismatch: false,
  });
  markJobTerminal("cashu-bill", "completed", {}, { costMsats: 6000, paymentMethod: "cashu" });
  expect(jobSpend(loadJob("cashu-bill")!)).toMatchObject({
    total_msats: 7000, upfront_display: "6 sats", payments: 2, log_mismatch: false,
  });
});

it.each(["processing", "completed"] as const)("only flags incomplete logs after completion: %s", (status) => {
  const spend = jobSpend({ id: "lagging-bill", endpoint: "https://provider.example", submittedAt: 1,
    status, totalPaidMsats: 7000, paymentsHonoured: 2 });
  expect(spend.log_mismatch).toBe(status === "completed");
});

it.each(["usd", "eur", "missing", "upfront"])("uses summed fiat only when all payments have one currency: %s", (kind) => {
  const id = `fiat-bill-${kind}`;
  appendMessages(id, [
    { seq: 1, from: "provider", timestamp: 1767225600000, type: "payment-request",
      content: { amount_msats: 1000, fiat_amount: { amount: 0.02, currency: "usd" }, reason: "First" } },
    { seq: 2, from: "requester", timestamp: 1767225600000, type: "payment", content: { amount_msats: 1000 } },
    { seq: 3, from: "provider", timestamp: 1767225600000, type: "payment-request",
      content: { amount_msats: 1000, reason: "Second",
        ...(kind === "missing" ? {} : { fiat_amount: { amount: 0.04, currency: kind === "eur" ? "eur" : "usd" } }) } },
    { seq: 4, from: "requester", timestamp: 1767225600000, type: "payment", content: { amount_msats: 1000 } },
  ]);
  const spend = jobSpend({ id, endpoint: "https://provider.example", submittedAt: 1,
    status: "completed", totalPaidMsats: kind === "upfront" ? 3000 : 2000,
    paymentsHonoured: kind === "upfront" ? 3 : 2,
    policy: { maxTotalMsats: 10000, maxPayments: 5, maxIncrementMsats: 1000, autoPayBelowMsats: 1000 } });
  expect(spend.total_display).toBe(kind === "usd" ? "$0.06 USD (2 sats)" : kind === "upfront" ? "3 sats" : "2 sats");
  expect(spend.budget_display).toBe(kind === "usd" ? "$0.30 USD (10 sats)" : "10 sats");
});

it("falls back to completion cost only when the running total is absent", () => {
  const job = { id: "legacy-bill", endpoint: "https://provider.example", submittedAt: 1,
    status: "completed" as const, costMsats: 4000 };
  expect(jobSpend(job)).toMatchObject({ total_msats: 4000, upfront_display: "4 sats", payments: 1 });
  expect(jobSpend({ ...job, totalPaidMsats: 0 })).toMatchObject({ total_msats: 0, payments: 0 });
});

it("flags a paid job whose booked mid-job payment is missing from the completed log", () => {
  saveJob({ id: "missing-payment-bill", endpoint: "https://provider.example", status: "submitted", submittedAt: 1,
    paymentMethod: "cashu" });
  addPayment("missing-payment-bill", 2000);
  addPayment("missing-payment-bill", 1500);
  markJobTerminal("missing-payment-bill", "completed", {}, { costMsats: 2000 });
  expect(jobSpend(loadJob("missing-payment-bill")!).log_mismatch).toBe(true);
});

it("flags an upward-tampered total without conversation charges", () => {
  const spend = jobSpend({ id: "tampered-upfront-bill", endpoint: "https://provider.example", submittedAt: 1,
    status: "completed", costMsats: 2000, totalPaidMsats: 3000, paymentsHonoured: 1, paymentMethod: "cashu" });
  expect(spend.log_mismatch).toBe(true);
});

it.each(["processing", "completed"] as const)("shows the original credit debit in the %s bill", (status) => {
  const id = `credit-bill-${status}`;
  saveJob({ id, endpoint: "https://provider.example", status, submittedAt: 1, paymentMethod: "credit",
    creditBinding: { creditId: "credit", drawId: "draw", callerPubkey: "caller" } });
  recordUpfrontCreditPayment(id, { amount_msats: 6000, amount_micro: 6000, currency: "usd",
    credit_id: "credit", draw_id: "draw" });
  addPayment(id, 1000);
  appendMessages(id, [
    { seq: 1, from: "provider", timestamp: 1767225600000, type: "payment-request",
      content: { amount_msats: 1000, reason: "More work" } },
    { seq: 2, from: "requester", timestamp: 1767225600000, type: "payment", content: { amount_msats: 1000 } },
  ]);
  const spend = jobSpend(loadJob(id)!);
  expect(spend).toMatchObject({ total_msats: 7000, upfront_display: "$0.0060 USD (6 sats)", payments: 2, log_mismatch: false });
  expect(spend.display).toContain(status === "completed" ? "Settled 7 sats over 2 charges" : "Sent or held 7 sats over 2 charges");
  expect(spend.display).not.toContain("not recorded");
});

it("keeps legacy credit consumption unknown even with a zero recorded total", () => {
  const spend = jobSpend({ id: "legacy-credit-bill", endpoint: "https://provider.example", status: "completed",
    submittedAt: 1, paymentMethod: "credit", totalPaidMsats: 0 });
  expect(spend.display).toContain("upfront amount is not recorded locally");
  expect(spend.display).not.toContain("free");
  expect(spend).not.toHaveProperty("upfront_display");
});
