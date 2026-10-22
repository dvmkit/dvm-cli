import { expect, it } from "vitest";
import { jobSpend } from "../job-spend";
import { addPayment, loadJob, markJobTerminal, saveJob } from "../job-store";
import { appendMessages } from "../messages";

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
