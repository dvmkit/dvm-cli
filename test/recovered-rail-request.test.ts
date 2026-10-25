import { rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JOBS_FILE, REQUEST_INTENTS_DIR, receiptPubkeyFromSecret, type Transport } from "@dvmkit/sdk/internal";
import { requestResult } from "../src/commands/request-result";
import { addPayment, loadJob } from "../src/lib/job-store";
import { handlePaymentRequest } from "../src/lib/payment-responder";
import { loadRequestIntent, recordRequestRailPayment, saveRequestIntent } from "../src/lib/request-intent-store";

vi.mock("../src/lib/cli-identity-resolve", async (original) => ({
  ...(await original<typeof import("../src/lib/cli-identity-resolve")>()),
  findSigningIdentityByPubkey: () => ({ privkey: "01".repeat(32), pubkey: receiptPubkeyFromSecret("01".repeat(32)) }),
}));
vi.mock("../src/lib/output", async (original) => ({
  ...(await original<typeof import("../src/lib/output")>()), json: vi.fn(),
}));

const endpoint = "https://provider.example";
const policy = { maxTotalMsats: 10000, autoPayBelowMsats: 10000, maxIncrementMsats: 10000, maxPayments: 2 };
let upfront: unknown;
let fetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  rmSync(JOBS_FILE, { force: true });
  rmSync(REQUEST_INTENTS_DIR, { recursive: true, force: true });
  saveRequestIntent({ v: 2, requestId: "request", endpoint, capability: "echo", body: { input: "Work", data: { request_id: "request" } },
    callerPubkey: receiptPubkeyFromSecret("01".repeat(32)), policy,
    authAudience: { dvm_id: "test-provider", builder_pubkey: "03".repeat(32) }, createdAt: 1 });
  upfront = undefined;
  fetch = vi.fn(async () => new Response(JSON.stringify({ request_id: "request", job_id: "job",
    status: "processing", upfront_payment: upfront }), { status: 202 }));
  vi.stubGlobal("fetch", fetch);
});
afterEach(() => vi.unstubAllGlobals());

it.each(["cashu", "x402", "tempo"] as const)("restores a %s intent's exact price once without another rail payment", async (method) => {
  recordRequestRailPayment("request", { method, amountMsats: 6500 });
  expect(loadRequestIntent("request")?.body).toEqual({ input: "Work", data: { request_id: "request" } });
  // A provider's FX valuation does not replace the caller's pinned rail price.
  upfront = { amount_msats: 5000, rail: method };
  await requestResult("request");
  expect(loadJob("job")).toMatchObject({ totalPaidMsats: 6500, paymentsHonoured: 1, paymentMethod: method });
  addPayment("job", 3000);
  await requestResult("request");
  await requestResult("request");
  expect(loadJob("job")).toMatchObject({ totalPaidMsats: 9500, paymentsHonoured: 2 });
  await expect(handlePaymentRequest("job", { amount_msats: 1000, reason: "More" }, policy,
    {} as Transport, { endpoint })).resolves.toBe("over-budget");
  await expect(handlePaymentRequest("job", { amount_msats: 100, reason: "More" }, policy,
    {} as Transport, { endpoint })).resolves.toBe("payment-cap-exceeded");
  expect(fetch).toHaveBeenCalledTimes(3);
  for (const [url, init] of fetch.mock.calls as unknown as [string, RequestInit][]) {
    expect(url).toBe(`${endpoint}/v1/request-result/request`);
    expect(new Headers(init.headers).has("X-Cashu")).toBe(false);
  }
});

it("recovers a legacy price from accepted upfront evidence, without using the original budget", async () => {
  upfront = { amount_msats: 6000, rail: "cashu" };
  await requestResult("request");
  expect(loadJob("job")).toMatchObject({ totalPaidMsats: 6000, paymentsHonoured: 1 });
});

it("blocks additional payment when a legacy recovered request has no known price", async () => {
  await requestResult("request");
  await expect(handlePaymentRequest("job", { amount_msats: 100, reason: "More" }, policy,
    {} as Transport, { endpoint })).rejects.toMatchObject({ code: "upfront_rail_unknown" });
});

it("does not overwrite a different recorded price before submission", () => {
  recordRequestRailPayment("request", { method: "cashu", amountMsats: 6000 });
  expect(() => recordRequestRailPayment("request", { method: "cashu", amountMsats: 7000 }))
    .toThrow(expect.objectContaining({ code: "upfront_payment_conflict" }));
  expect(loadRequestIntent("request")?.railPayment).toEqual({ method: "cashu", amountMsats: 6000 });
});
