import { rmSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { JOBS_FILE, type Transport } from "@dvmkit/sdk/internal";
import { addPayment, loadJob, recordUpfrontRailPayment, saveJob } from "../job-store";
import { handlePaymentRequest } from "../payment-responder";
import { tryCreditPayment } from "../credit-payment";

const endpoint = "https://provider.example";
const policy = { maxTotalMsats: 10000, autoPayBelowMsats: 10000, maxIncrementMsats: 10000, maxPayments: 2 };
beforeEach(() => {
  rmSync(JOBS_FILE, { force: true });
  saveJob({ id: "job", endpoint, status: "processing", submittedAt: 1, policy });
});

it.each(["cashu", "x402", "tempo"] as const)("preserves a fresh %s upfront charge and later payment across recovery", async (method) => {
  const payment = { method, amountMsats: 6000 };
  recordUpfrontRailPayment("job", payment, true);
  addPayment("job", 3000);
  recordUpfrontRailPayment("job", payment);
  recordUpfrontRailPayment("job", payment);
  expect(loadJob("job")).toMatchObject({ totalPaidMsats: 9000, paymentsHonoured: 2, upfrontRailPayment: payment });
  const sendMessage = vi.fn();
  const transport = { sendMessage } as unknown as Transport;
  await expect(handlePaymentRequest("job", { amount_msats: 2000, reason: "More" }, policy,
    transport, { endpoint })).resolves.toBe("over-budget");
  await expect(handlePaymentRequest("job", { amount_msats: 1000, reason: "More" }, policy,
    transport, { endpoint })).resolves.toBe("payment-cap-exceeded");
  expect(sendMessage).not.toHaveBeenCalled();
});

it.each([undefined, { method: "cashu", amountMsats: -1 }, { method: "cashu", amountMsats: 1.5 },
  { method: "cashu", amountMsats: Number.MAX_SAFE_INTEGER + 1 }])("blocks every payment path with unknown original pricing: %j", async (value) => {
  recordUpfrontRailPayment("job", value);
  await expect(handlePaymentRequest("job", { amount_msats: 1000, reason: "More" }, policy,
    {} as Transport, { endpoint })).rejects.toMatchObject({ code: "upfront_rail_unknown" });
  await expect(tryCreditPayment({ jobId: "job", request: { amount_msats: 1000, reason: "More" }, policy,
    transport: {} as Transport, provider: { endpoint } })).rejects.toMatchObject({ code: "upfront_rail_unknown" });
});

it("preserves ambiguous legacy counters instead of duplicating an already booked charge", () => {
  addPayment("job", 6000);
  addPayment("job", 3000);
  recordUpfrontRailPayment("job", { method: "cashu", amountMsats: 6000 });
  expect(loadJob("job")).toMatchObject({ totalPaidMsats: 9000, paymentsHonoured: 2, upfrontRailPayment: "unknown" });
});

it("keeps the original counters and blocks payment after conflicting recovery evidence", async () => {
  recordUpfrontRailPayment("job", { method: "cashu", amountMsats: 6000 });
  addPayment("job", 3000);
  recordUpfrontRailPayment("job", { method: "cashu", amountMsats: 1000 });
  expect(loadJob("job")).toMatchObject({ totalPaidMsats: 9000, paymentsHonoured: 2, upfrontRailConflict: true });
  await expect(handlePaymentRequest("job", { amount_msats: 100, reason: "More" }, policy,
    {} as Transport, { endpoint })).rejects.toMatchObject({ code: "upfront_rail_unknown" });
});

it("distinguishes an unknown debit from a recovered zero price", () => {
  recordUpfrontRailPayment("job", undefined);
  recordUpfrontRailPayment("job", { method: "cashu", amountMsats: 0 });
  expect(loadJob("job")).toMatchObject({ totalPaidMsats: 0, paymentsHonoured: 0,
    upfrontRailPayment: { method: "cashu", amountMsats: 0 } });
});
