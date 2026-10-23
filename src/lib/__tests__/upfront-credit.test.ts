import { rmSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { JOBS_FILE, type Transport } from "@dvmkit/sdk/internal";
import {
  addPayment, loadAllJobs, loadJob, recordUpfrontCreditPayment, saveJob, saveSubmittedJob,
} from "../job-store";
import { handlePaymentRequest } from "../payment-responder";
import { HttpsTransport } from "../transport/https";

const endpoint = "https://provider.example";
const upfront = { amount_msats: 6000, amount_micro: 6000, currency: "usd", credit_id: "credit", draw_id: "draw" };
const policy = { maxTotalMsats: 10000, autoPayBelowMsats: 10000, maxIncrementMsats: 10000, maxPayments: 3 };
beforeEach(() => {
  rmSync(JOBS_FILE, { force: true });
  saveJob({ id: "job", endpoint, status: "processing", submittedAt: 1, paymentMethod: "credit", policy,
    creditBinding: { creditId: "credit", drawId: "draw", callerPubkey: "01".repeat(32) } });
});

it("includes the accepted draw in the real cumulative budget guard", async () => {
  recordUpfrontCreditPayment("job", upfront);
  addPayment("job", 3000);
  const sendMessage = vi.fn();
  await expect(handlePaymentRequest("job", { amount_msats: 2000, reason: "More work" }, policy,
    { sendMessage } as unknown as Transport, { endpoint })).resolves.toBe("over-budget");
  expect(sendMessage).not.toHaveBeenCalled();
  expect(loadJob("job")).toMatchObject({ totalPaidMsats: 9000, paymentsHonoured: 2 });
});

it("includes the accepted draw in the real payment-count guard", async () => {
  recordUpfrontCreditPayment("job", upfront);
  await expect(handlePaymentRequest("job", { amount_msats: 1000, reason: "More work" }, { ...policy, maxPayments: 1 },
    {} as Transport, { endpoint })).resolves.toBe("payment-cap-exceeded");
});

it("preserves later payments and original evidence across submit and recovery replay", () => {
  recordUpfrontCreditPayment("job", upfront);
  addPayment("job", 3000);
  saveSubmittedJob({ id: "job", endpoint, status: "submitted", submittedAt: 2 });
  recordUpfrontCreditPayment("job", { ...upfront });
  recordUpfrontCreditPayment("job", { ...upfront });
  expect(loadAllJobs()).toHaveLength(1);
  expect(loadJob("job")).toMatchObject({ status: "processing", totalPaidMsats: 9000,
    paymentsHonoured: 2, upfrontCreditBooked: true, upfrontPayment: upfront });
});

it.each([undefined, null, { amount_msats: -1 }, { ...upfront, amount_msats: 1.5 },
  { ...upfront, amount_msats: Number.MAX_SAFE_INTEGER + 1 }, { ...upfront, draw_id: undefined },
  { ...upfront, currency: "USD" }, { ...upfront, credit_id: "other" },
  { amount_msats: 0 }])("does not authorize more payments using unknown credit evidence: %j", async (value) => {
  recordUpfrontCreditPayment("job", value);
  await expect(handlePaymentRequest("job", { amount_msats: 1000, reason: "More work" }, policy,
    {} as Transport, { endpoint })).rejects.toMatchObject({ code: "upfront_credit_unknown" });
});

it("distinguishes known zero from a missing amount", async () => {
  recordUpfrontCreditPayment("job", { ...upfront, amount_msats: 0, amount_micro: 0 });
  expect(loadJob("job")).toMatchObject({ totalPaidMsats: 0, paymentsHonoured: 0, upfrontCreditBooked: true });
  await expect(handlePaymentRequest("job", { amount_msats: 11000, reason: "Too much" }, policy,
    {} as Transport, { endpoint })).resolves.toBe("over-budget");
});

it("keeps original consumption and blocks automatic payment after conflicting recovery evidence", async () => {
  recordUpfrontCreditPayment("job", upfront);
  addPayment("job", 3000);
  recordUpfrontCreditPayment("job", { ...upfront, amount_msats: 9000, amount_micro: 9000 });
  expect(loadJob("job")).toMatchObject({ upfrontPayment: upfront, totalPaidMsats: 9000,
    paymentsHonoured: 2, upfrontCreditConflict: true });
  await expect(handlePaymentRequest("job", { amount_msats: 1000, reason: "More work" }, policy,
    {} as Transport, { endpoint })).rejects.toMatchObject({ code: "upfront_credit_unknown" });
});

it.each(["cashu", "x402", "tempo"] as const)("does not book a %s fund-and-draw twice", (paymentMethod) => {
  saveJob({ id: "rail", endpoint, status: "processing", submittedAt: 1, paymentMethod });
  addPayment("rail", 6000);
  recordUpfrontCreditPayment("rail", upfront, true);
  recordUpfrontCreditPayment("rail", upfront);
  expect(loadJob("rail")).toMatchObject({ totalPaidMsats: 6000, paymentsHonoured: 1 });
});

it.each([200, 202])("parses the accepted debit on HTTP %i submit and recovery responses", async (status) => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ job_id: "job", request_id: "request",
    status: status === 202 ? "processing" : "completed", upfront_payment: upfront }), { status }));
  vi.stubGlobal("fetch", fetch);
  try {
    const transport = new HttpsTransport();
    const submitted = await transport.submit({ endpoint }, { input: "Work" });
    const recovered = await transport.requestResult({ endpoint }, "request", { input: "Work" });
    // Exercise the parsed response through the production accounting boundary.
    recordUpfrontCreditPayment("job", submitted.upfrontPayment);
    addPayment("job", 1000);
    recordUpfrontCreditPayment("job", recovered.upfrontPayment);
    expect(loadJob("job")).toMatchObject({ totalPaidMsats: 7000, paymentsHonoured: 2, upfrontPayment: upfront });
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally { vi.unstubAllGlobals(); }
});
