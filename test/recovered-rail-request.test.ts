import { rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JOBS_FILE, REQUEST_INTENTS_DIR, WALLET_FILE, WALLET_VERSION, receiptPubkeyFromSecret, saveAgentWallet, type Transport } from "@dvmkit/sdk/internal";
import { requestResult } from "../src/commands/request-result";
import { addPayment, loadJob, saveJob } from "../src/lib/job-store";
import { handlePaymentRequest } from "../src/lib/payment-responder";
import { loadRequestIntent, recordRequestRailPayment, saveRequestIntent } from "../src/lib/request-intent-store";
import { sweepPendingSubmissions } from "../src/lib/wallet-agent/recovery-submissions";
import type { PricedSubmissionContext } from "../src/lib/upfront-payment";

vi.mock("../src/lib/cli-identity-resolve", async (original) => ({
  ...(await original<typeof import("../src/lib/cli-identity-resolve")>()),
  findSigningIdentityByPubkey: () => ({ privkey: "01".repeat(32), pubkey: receiptPubkeyFromSecret("01".repeat(32)) }),
}));
vi.mock("../src/lib/output", async (original) => ({
  ...(await original<typeof import("../src/lib/output")>()), json: vi.fn(),
}));
vi.mock("../src/lib/btc-rate", async (original) => ({
  ...(await original<typeof import("../src/lib/btc-rate")>()), resolveBtcUsdRate: async () => ({ rate: 100000, stale: false }),
}));
vi.mock("../src/lib/x402/wallet", async (original) => ({
  ...(await original<typeof import("../src/lib/x402/wallet")>()), loadX402Wallet: () => ({ privateKey: `0x${"01".repeat(32)}` }),
}));
vi.mock("../src/lib/x402/client", async (original) => ({
  ...(await original<typeof import("../src/lib/x402/client")>()),
  tryX402Payment: async () => ({ paymentHeader: "payment-proof", amountMsats: 1000, amountUsdcMicro: 1000n, btcRate: 100000, x402Version: 2 }),
}));

const endpoint = "https://provider.example";
const policy = { maxTotalMsats: 10000, autoPayBelowMsats: 10000, maxIncrementMsats: 10000, maxPayments: 2 };
let upfront: unknown;
let fetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  rmSync(JOBS_FILE, { force: true });
  rmSync(WALLET_FILE, { force: true });
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

async function payMeteredAsk(): Promise<void> {
  const sendMessage = vi.fn(async () => ({ seq: 5 }));
  await expect(handlePaymentRequest("job", { amount_msats: 1000, reason: "Metered work", x402: {
    pay_to: `0x${"02".repeat(20)}`, network: "eip155:8453", asset: `0x${"03".repeat(20)}`,
  } }, policy, { sendMessage } as unknown as Transport, { endpoint }, { rail: "x402", requestSeq: 4 }))
    .resolves.toMatchObject({ status: "paid", rail: "x402", amountMsats: 1000 });
  expect(sendMessage).toHaveBeenCalledTimes(1);
}

it.each(["new", "existing"])("pays the first metered ask after recovering the %s free-start job without a rail", async (local) => {
  if (local === "existing") saveJob({ id: "job", endpoint, status: "processing", submittedAt: 1,
    upfrontRailPayment: "free", policy });
  upfront = { amount_msats: 0 };
  await requestResult("request");
  await payMeteredAsk();
  // Later read-backs can omit the original free-start evidence.
  upfront = undefined;
  await requestResult("request");
  expect(loadJob("job")).toMatchObject({ totalPaidMsats: 1000, paymentsHonoured: 1, upfrontRailPayment: "free" });
});

it("retains the journal price after sweep recovery when the intent price was never persisted", async () => {
  const context: PricedSubmissionContext = { submit_body: { input: "Work", data: { request_id: "request" } },
    upfront_rail_payment: { method: "cashu", amountMsats: 6500 }, policy };
  saveAgentWallet({ version: WALLET_VERSION, lock_privkey: "01".repeat(32), lock_pubkey: `02${"01".repeat(32)}`,
    mnemonic_fingerprint: null, mints: ["https://mint.example"], proofs: [], nut13_counters: {}, pending_mints: [], pending_melts: [],
    pending_submissions: [{ endpoint, request_id: "11111111-1111-4111-8111-111111111111", intended_lock_pubkey: `02${"01".repeat(32)}`,
      mint: "https://mint.example", amount_sats: 7, output_proofs: [{ mint: "https://mint.example", secret: "proof-secret",
        C: `02${"02".repeat(32)}`, amount: 7, id: "00ad268c4d1f5826", locked_to_pubkey: `02${"01".repeat(32)}`, status: "valid" }],
      cashu_token: "cashuBtest", created_at: new Date().toISOString(), context }], recent_spends: [], created_at: new Date().toISOString() });
  expect(loadRequestIntent("request")?.railPayment).toBeUndefined();
  await sweepPendingSubmissions({ httpPost: async () => ({ status: 202, body: { job_id: "job", status: "processing",
    upfront_payment: { amount_msats: 5000, rail: "cashu" } } }) });
  expect(loadJob("job")).toMatchObject({ totalPaidMsats: 6500, paymentsHonoured: 1 });
  upfront = { amount_msats: 5000, rail: "cashu" };
  await requestResult("request");
  await requestResult("request");
  await payMeteredAsk();
  await requestResult("request");
  expect(loadJob("job")).toMatchObject({ totalPaidMsats: 7500, paymentsHonoured: 2,
    upfrontRailPayment: { method: "cashu", amountMsats: 6500 } });
  expect(loadJob("job")).not.toHaveProperty("upfrontRailConflict");
});

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
