import { createServer, type Server } from "node:http";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSignedRequestVerifier, type PaymentContent } from "@dvmkit/sdk";
import { CREDITS_FILE, DvmError, JOBS_FILE, receiptPubkeyFromSecret, signDvmRequestData, type PaymentRequestContent, type Transport } from "@dvmkit/sdk/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handlePaymentRequest } from "../src/lib/payment-responder";
import { bookCreditPayment, loadJob, saveJob, updateJob } from "../src/lib/job-store";
import { HttpsTransport } from "../src/lib/transport/https";
import { waitForJob } from "../src/lib/wait-for-job";
import { streamLoop } from "../src/lib/stream-loop";
import { appendMessage } from "../src/lib/messages";
import { pay } from "../src/commands/pay";

const budget = vi.hoisted(() => ({ enforce: vi.fn(), record: vi.fn(), rate: 100000 as number | null }));
vi.mock("../src/lib/btc-rate", () => ({ tryResolveBtcUsdRate: async () => budget.rate === null ? null : { rate: budget.rate, stale: false } }));
vi.mock("../src/lib/budget-ledger", async (original) => ({
  ...await original<typeof import("../src/lib/budget-ledger")>(), enforceGlobalBudget: budget.enforce, recordSpend: budget.record,
}));
vi.mock("../src/lib/output", async (original) => ({
  ...await original<typeof import("../src/lib/output")>(), info: vi.fn(), json: vi.fn(), progress: vi.fn(),
}));
const secret = "01".repeat(32);
const pubkey = receiptPubkeyFromSecret(secret);
const audience = { dvm_id: "example-provider", builder_pubkey: "ab".repeat(32) };
const policy = { maxTotalMsats: 4_000, maxIncrementMsats: 2_000, autoPayBelowMsats: 2_000, maxPayments: 2 };
const ask: PaymentRequestContent = { amount_msats: 1_500, reason: "Additional work", credit: { amount_micro: 1_500, currency: "usd" } };
const token = "ab".repeat(32);
const messagesPath = "/v1/job/job-a/messages";
const received: Array<NonNullable<PaymentContent["credit"]>> = [];
let server: Server;
let endpoint: string;
let advertisement = true;
let expectedMicro = 1500;
let expectedSeq = 4;
let expectedCurrency = "usd";
let reply: "ok" | "drop" | "insufficient" | "conflict" | "malformed" | "unavailable" | "fake-insufficient" | "invalid-insufficient" = "ok";
let accepted = false;
let repeatPaidAsk = false;
const charged = new Set<string>();

beforeEach(async () => {
  process.env.DVM_IDENTITY_KEY = secret;
  received.length = 0;
  charged.clear();
  accepted = false;
  repeatPaidAsk = false;
  reply = "ok";
  advertisement = true;
  expectedMicro = 1500;
  expectedSeq = 4;
  expectedCurrency = "usd";
  budget.rate = 100000;
  budget.enforce.mockRejectedValue(new DvmError("global_budget_exceeded", "Wallet outflow budget exhausted."));
  const verifier = createSignedRequestVerifier({ _zod: {}, parse: (value: unknown) => value,
    safeParse: (data: unknown) => ({ success: true as const, data }) }, { replayStore: null });
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/v1/info") {
        response.end(JSON.stringify({ protocol_version: 1, auth: ["secp256k1-schnorr-v2"], auth_audience: audience,
          credit: { balance_payment: advertisement, currency: "usd", funding: ["cashu"], min_micro: 1000, max_micro: 5000000, ttl_ms: 86400000 } }));
        return;
      }
      if (request.method === "GET") {
        response.end(JSON.stringify({ messages: [accepted && !repeatPaidAsk
          ? { seq: 6, from: "provider", timestamp: 1700000000, type: "complete", content: { status: "success", summary: "Done" } }
          : { seq: 4, from: "provider", timestamp: 1700000000, type: "payment-request", content: ask }] }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const authorization = body.content.credit;
      received.push(authorization);
      expect(request.headers["x-job-token"]).toBe(token);
      expect(body).toEqual({ type: "payment", content: { credit: authorization } });
      verifier.checkAuth(authorization, { audience, method: "POST", path: messagesPath, capability: null });
      expect(authorization).toMatchObject({ credit_id: "held-credit", draw_id: expect.any(String),
        request_seq: expectedSeq, amount_micro: expectedMicro, currency: expectedCurrency, pubkey });
      if (reply === "insufficient" || reply === "fake-insufficient" || reply === "invalid-insufficient") {
        response.statusCode = reply === "fake-insufficient" ? 503 : 402;
        response.end(JSON.stringify({ error: "insufficient_credit", remaining_micro: reply === "invalid-insufficient" ? -1 : 1000, shortfall_micro: 500 }));
      } else if (reply === "conflict" || reply === "unavailable") {
        response.statusCode = reply === "conflict" ? 409 : 503;
        response.end(JSON.stringify({ error: reply === "conflict" ? "credit_payment_conflict" : "provider_unavailable" }));
      } else {
        charged.add(authorization.payment_id);
        accepted = true;
        if (reply === "drop") response.destroy();
        else { response.statusCode = 201; response.end(reply === "malformed" ? "{}" : '{"seq":5}'); }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  rmSync(JOBS_FILE, { force: true });
  rmSync(join(process.env.DVM_CONFIG_DIR!, "messages"), { recursive: true, force: true });
  rmSync(join(process.env.DVM_CONFIG_DIR!, "config.json"), { force: true });
  writeFileSync(CREDITS_FILE, JSON.stringify({ credits: [{ endpoint, callerPubkey: pubkey, creditId: "held-credit",
    currency: "usd", balanceMicro: 10000, remainingMicro: 10000, targetMicro: 10000,
    expiryMs: Date.now() + 86400000, status: "active", ledgerSeq: 1 }], implicitCredits: [], pendingFundings: [] }));
  saveJob({ id: "job-a", endpoint, status: "processing", submittedAt: Date.now(), policy, jobToken: token,
    creditBinding: { creditId: "held-credit", drawId: "accepted-draw", callerPubkey: pubkey } });
});
afterEach(async () => {
  delete process.env.DVM_IDENTITY_KEY;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const respond = (overrides = policy, request = ask) => handlePaymentRequest("job-a", request, overrides,
  new HttpsTransport(), { endpoint }, { requestSeq: 4 });

describe("balance-backed mid-job payments", () => {
  it("uses the accepted draw with signed ask/path/token and books consumption once without another wallet debit", async () => {
    await expect(respond()).resolves.toMatchObject({ rail: "credit", amountMsats: 1500 });
    expect(received[0].draw_id).toBe("accepted-draw");
    await expect(respond()).resolves.toMatchObject({ rail: "credit" });
    expect(received).toHaveLength(1);
    expect(loadJob("job-a")).toMatchObject({ totalPaidMsats: 1500, paymentsHonoured: 1,
      paymentApprovals: [{ requestSeq: 4, approval: "auto" }] });
    expect(budget.enforce).not.toHaveBeenCalled();
    expect(budget.record).not.toHaveBeenCalled();
  });

  it.each([
    { policy: { ...policy, autoPayBelowMsats: 1000 }, result: "needs-approval" },
    { policy: { ...policy, maxIncrementMsats: 1000 }, result: "over-budget" },
    { policy: { ...policy, maxTotalMsats: 1000 }, result: "over-budget" },
    { policy: { ...policy, maxPayments: 0 }, result: "payment-cap-exceeded" },
  ])("enforces consent and per-job caps before authorization ($result)", async (row) => {
    await expect(respond(row.policy)).resolves.toBe(row.result);
    expect(received).toHaveLength(0);
    expect(loadJob("job-a")?.pendingCreditPayment).toBeUndefined();
  });

  it.each(["drop", "malformed", "conflict", "unavailable", "fake-insufficient", "invalid-insufficient"] as const)("keeps the same intent after %s and recovers it without double booking", async (mode) => {
    reply = mode;
    await expect(respond()).rejects.toBeInstanceOf(Error);
    const saved = JSON.parse(JSON.stringify(loadJob("job-a")?.pendingCreditPayment));
    expect(saved.authorization.payment_id).toBeTruthy();
    expect(loadJob("job-a")?.paymentsHonoured).toBeUndefined();
    expect(budget.enforce).not.toHaveBeenCalled();
    reply = "ok";
    await expect(respond()).resolves.toMatchObject({ rail: "credit" });
    expect(received[1]).toEqual(saved.authorization);
    expect(charged.size).toBe(1);
    expect(loadJob("job-a")).toMatchObject({ totalPaidMsats: 1500, paymentsHonoured: 1 });
    expect(loadJob("job-a")?.pendingCreditPayment).toBeUndefined();
  });

  it("renews an old envelope while retaining its monetary identity, owner and domain", async () => {
    reply = "drop";
    await expect(respond()).rejects.toBeInstanceOf(Error);
    const pending = loadJob("job-a")!.pendingCreditPayment!;
    const a = pending.authorization;
    pending.authorization = signDvmRequestData(secret, { credit_id: a.credit_id, draw_id: a.draw_id,
      payment_id: a.payment_id, request_seq: a.request_seq, amount_micro: a.amount_micro, currency: a.currency },
      { audience, method: "POST", path: messagesPath, capability: null },
      { timestamp: Math.floor(Date.now() / 1000) - 600 }) as typeof a;
    updateJob("job-a", { pendingCreditPayment: pending });
    reply = "ok";
    await respond();
    expect(received[1]).toMatchObject({ payment_id: a.payment_id, credit_id: a.credit_id, draw_id: a.draw_id,
      amount_micro: a.amount_micro, currency: a.currency, request_seq: a.request_seq, pubkey, auth_statement: a.auth_statement });
    expect(received[1].timestamp).toBeGreaterThan(pending.authorization.timestamp);
    expect(charged.size).toBe(1);
  });

  it("recovers a crash after the accepted response but before local consumption booking", async () => {
    const jobs = await import("../src/lib/job-store");
    const booking = vi.spyOn(jobs, "bookCreditPayment").mockImplementationOnce(() => { throw new Error("Interrupted before local booking"); });
    await expect(respond()).rejects.toThrow("Interrupted before local booking");
    booking.mockRestore();
    expect(loadJob("job-a")?.paymentsHonoured).toBeUndefined();
    const saved = loadJob("job-a")!.pendingCreditPayment!;
    await respond();
    expect(received[1]).toEqual(saved.authorization);
    expect(charged.size).toBe(1);
    expect(loadJob("job-a")).toMatchObject({ totalPaidMsats: 1500, paymentsHonoured: 1 });
  });

  it("books an echoed pending payment before paying the next charge during wait", async () => {
    const jobs = await import("../src/lib/job-store");
    const booking = vi.spyOn(jobs, "bookCreditPayment").mockImplementationOnce(() => { throw new Error("Interrupted before local booking"); });
    await expect(respond()).rejects.toThrow("Interrupted before local booking");
    booking.mockRestore();
    const saved = loadJob("job-a")!.pendingCreditPayment!;
    appendMessage("job-a", { seq: 4, from: "provider", timestamp: 0, type: "payment-request", content: ask });
    appendMessage("job-a", { seq: 5, from: "requester", timestamp: 0, type: "payment", content: { credit: saved.authorization } });
    const http = new HttpsTransport();
    const stream = vi.fn().mockImplementationOnce(async () => {
      // Recovery must finish before the new ask is processed.
      expect(loadJob("job-a")).toMatchObject({ paymentsHonoured: 1, totalPaidMsats: 1500 });
      expectedSeq = 7;
      return { messages: [{ seq: 7, from: "provider", timestamp: 0, type: "payment-request", content: ask }] };
    }).mockResolvedValueOnce({ messages: [{ seq: 9, from: "provider", timestamp: 0, type: "prompt", content: { id: "continue", text: "Continue?" } }] });
    const transport = { stream, status: async () => ({ status: "processing" }),
      sendMessage: http.sendMessage.bind(http), describe: http.describe.bind(http) } as unknown as Transport;
    const result = await waitForJob({ jobId: "job-a", provider: { endpoint }, transport, policy, afterSeq: 5 }, 3000);
    expect(result.nextAction).toMatchObject({ type: "respond", prompt_id: "continue" });
    expect(received).toHaveLength(3);
    expect(received[1]).toEqual(saved.authorization);
    expect(charged.size).toBe(2);
    expect(loadJob("job-a")).toMatchObject({ totalPaidMsats: 3000, paymentsHonoured: 2 });
    expect(loadJob("job-a")?.pendingCreditPayment).toBeUndefined();
    expect(budget.enforce).not.toHaveBeenCalled();
  });

  it("books a recovered server acceptance idempotently even after local booking already completed", async () => {
    await respond();
    const booked = loadJob("job-a")!.bookedCreditPayments![0];
    updateJob("job-a", { pendingCreditPayment: booked });
    bookCreditPayment("job-a", booked);
    expect(loadJob("job-a")?.paymentApprovals).toEqual([{ requestSeq: 4, approval: "auto" }]);
    expect(loadJob("job-a")).toMatchObject({ totalPaidMsats: 1500, paymentsHonoured: 1 });
    expect(loadJob("job-a")?.pendingCreditPayment).toBeUndefined();
  });

  it("allows ordinary rail fallback only after the negotiated 402 insufficiency with exact amounts", async () => {
    reply = "insufficient";
    await expect(respond()).rejects.toMatchObject({ code: "global_budget_exceeded" });
    expect(received).toHaveLength(1);
    expect(loadJob("job-a")?.pendingCreditPayment).toBeUndefined();
    expect(loadJob("job-a")?.totalPaidMsats).toBeUndefined();
    expect(budget.enforce).toHaveBeenCalledOnce();
  });

  it.each(["legacy", "unsupported", "currency", "posture"])("keeps safe existing rail behavior for %s", async (mode) => {
    if (mode === "legacy") updateJob("job-a", { creditBinding: undefined });
    if (mode === "unsupported") advertisement = false;
    if (mode === "posture") writeFileSync(join(process.env.DVM_CONFIG_DIR!, "config.json"), JSON.stringify({ credit: { posture: "off" } }));
    const request = mode === "currency" ? { ...ask, credit: { amount_micro: 1500, currency: "eur" } } : ask;
    await expect(respond(policy, request)).rejects.toMatchObject({ code: "global_budget_exceeded" });
    expect(received).toHaveLength(0);
  });

  it("selects and persists the first draw only for a known unbound zero-upfront job", async () => {
    updateJob("job-a", { creditBinding: { unbound: true, callerPubkey: pubkey } });
    reply = "drop";
    await expect(respond()).rejects.toBeInstanceOf(Error);
    expect(loadJob("job-a")?.creditBinding).toEqual({ callerPubkey: pubkey, creditId: "held-credit", drawId: received[0].draw_id });
    reply = "ok";
    await respond();
    expect(received[1].draw_id).toBe(received[0].draw_id);
  });

  it("recovers the old pending ask before refusing to advance to a different ask", async () => {
    reply = "drop";
    await expect(respond()).rejects.toBeInstanceOf(Error);
    const saved = loadJob("job-a")!.pendingCreditPayment!;
    reply = "ok";
    await expect(handlePaymentRequest("job-a", { ...ask, amount_msats: 2000 }, policy,
      new HttpsTransport(), { endpoint }, { requestSeq: 8 })).rejects.toMatchObject({ code: "credit_payment_recovered" });
    expect(received[1]).toEqual(saved.authorization);
    expect(received).toHaveLength(2);
    expect(loadJob("job-a")).toMatchObject({ totalPaidMsats: 1500, paymentsHonoured: 1 });
  });

  it("does not treat a refused first draw as an accepted binding", async () => {
    updateJob("job-a", { creditBinding: { unbound: true, callerPubkey: pubkey } });
    reply = "insufficient";
    await expect(respond()).rejects.toMatchObject({ code: "global_budget_exceeded" });
    expect(loadJob("job-a")?.creditBinding).toEqual({ unbound: true, callerPubkey: pubkey });
  });

  it("refuses a large exact balance charge hidden behind a tiny provider msat proxy", async () => {
    expectedMicro = 5000000;
    await expect(respond(policy, { ...ask, amount_msats: 1, credit: { amount_micro: 5000000, currency: "usd" } }))
      .rejects.toMatchObject({ code: "credit_payment_amount_exceeds_limit" });
    expect(received).toHaveLength(0);
    expect(loadJob("job-a")?.pendingCreditPayment).toBeUndefined();
    expect(budget.enforce).not.toHaveBeenCalled();
  });

  it("pins locally priced consumption before send and retains it when rates change on replay", async () => {
    expectedMicro = 1600;
    const request = { ...ask, credit: { amount_micro: 1600, currency: "usd" } };
    reply = "drop";
    await expect(respond(policy, request)).rejects.toBeInstanceOf(Error);
    expect(loadJob("job-a")?.pendingCreditPayment?.amountMsats).toBe(1600);
    budget.rate = 200000;
    reply = "ok";
    await expect(respond(policy, request)).resolves.toMatchObject({ rail: "credit", amountMsats: 1600 });
    expect(loadJob("job-a")).toMatchObject({ totalPaidMsats: 1600, paymentsHonoured: 1 });
  });

  it("checks the actual locally priced debit against the per-job cap within the allowed quote margin", async () => {
    await expect(respond({ ...policy, maxIncrementMsats: 1550 },
      { ...ask, credit: { amount_micro: 1600, currency: "usd" } }))
      .rejects.toMatchObject({ code: "over_budget" });
    expect(received).toHaveLength(0);
  });

  it("retains the existing safe rail path when no caller rate can price the exact debit", async () => {
    budget.rate = null;
    await expect(respond()).rejects.toMatchObject({ code: "global_budget_exceeded" });
    expect(received).toHaveLength(0);
    expect(loadJob("job-a")?.pendingCreditPayment).toBeUndefined();
  });

  it("automatic streaming threads the provider ask sequence through the shared responder", async () => {
    const result = await streamLoop({ jobId: "job-a", provider: { endpoint }, policy, afterSeq: 0, transport: new HttpsTransport() });
    expect(result.autoPayments).toMatchObject([{ rail: "credit", amount_msats: 1500 }]);
    expect(result.nextAction).toBeNull();
    expect(received[0].request_seq).toBe(4);
  });

  it("reports a paid balance recovery when a restarted stream first receives the terminal result", async () => {
    expectedMicro = 1600;
    const request = { ...ask, credit: { amount_micro: 1600, currency: "usd" } };
    reply = "drop";
    await expect(respond(policy, request)).rejects.toBeInstanceOf(Error);
    const result = await (async () => {
      reply = "ok";
      return streamLoop({ jobId: "job-a", provider: { endpoint }, policy, afterSeq: 4, transport: new HttpsTransport() });
    })();
    expect(result.autoPayments).toMatchObject([{ rail: "credit", amount_msats: 1600,
      reason: { text: "Additional work", _source: "provider" }, display: expect.stringContaining("prepaid balance") }]);
    expect(result.nextAction).toBeNull();
    expect(loadJob("job-a")).toMatchObject({ totalPaidMsats: 1600, paymentsHonoured: 1 });
    expect(charged.size).toBe(1);
  });

  it("reports a recovered payment once when the provider still repeats the already-paid ask", async () => {
    reply = "drop";
    await expect(respond()).rejects.toBeInstanceOf(Error);
    reply = "ok";
    repeatPaidAsk = true;
    const result = await streamLoop({ jobId: "job-a", provider: { endpoint }, policy, afterSeq: 4,
      transport: new HttpsTransport(), timeoutMs: 100 });
    expect(result.autoPayments).toMatchObject([{ rail: "credit", amount_msats: 1500 }]);
    expect(result.autoPayments).toHaveLength(1);
    expect(result.nextAction).toMatchObject({ type: "poll" });
    expect(received).toHaveLength(2);
    expect(loadJob("job-a")).toMatchObject({ totalPaidMsats: 1500, paymentsHonoured: 1 });
  });

  it("does not report a refused pending recovery as an automatic payment", async () => {
    reply = "unavailable";
    await expect(respond()).rejects.toBeInstanceOf(Error);
    reply = "insufficient";
    budget.enforce.mockResolvedValue(0);
    const result = await streamLoop({ jobId: "job-a", provider: { endpoint }, policy, afterSeq: 4, transport: new HttpsTransport() });
    expect(result.autoPayments).toEqual([]);
    expect(result.nextAction).toMatchObject({ type: "pay" });
    expect(loadJob("job-a")?.paymentsHonoured).toBeUndefined();
    expect(charged.size).toBe(0);
  });

  it("explicit pay recovers the saved intent when the original message journal is gone", async () => {
    reply = "drop";
    await expect(respond()).rejects.toBeInstanceOf(Error);
    const saved = loadJob("job-a")!.pendingCreditPayment!;
    reply = "ok";
    await pay("job-a", {});
    expect(received[1]).toEqual(saved.authorization);
    expect(loadJob("job-a")).toMatchObject({ totalPaidMsats: 1500, paymentsHonoured: 1 });
  });

  it("explains the missing legacy binding when no existing rail can pay", async () => {
    budget.enforce.mockResolvedValue(0);
    updateJob("job-a", { creditBinding: undefined });
    appendMessage("job-a", { seq: 4, from: "provider", timestamp: Math.floor(Date.now() / 1000), type: "payment-request", content: ask });
    await expect(pay("job-a", {})).rejects.toMatchObject({ code: "payment_failed",
      hint: expect.stringContaining("no known credit/draw binding") });
    expect(received).toHaveLength(0);
  });

  it("explicit pay approves the locally priced debit while retaining the hard job caps", async () => {
    expectedMicro = 1600;
    updateJob("job-a", { policy: { ...policy, autoPayBelowMsats: 1000 } });
    appendMessage("job-a", { seq: 4, from: "provider", timestamp: Math.floor(Date.now() / 1000),
      type: "payment-request", content: { ...ask, credit: { amount_micro: 1600, currency: "usd" } } });
    await pay("job-a", {});
    expect(loadJob("job-a")).toMatchObject({ totalPaidMsats: 1600, paymentsHonoured: 1 });
    expect(budget.enforce).not.toHaveBeenCalled();
  });

  it("preserves exact credit errors and refuses malformed success instead of booking it", async () => {
    reply = "insufficient";
    const transport = new HttpsTransport();
    await expect(respond()).rejects.toMatchObject({ code: "global_budget_exceeded" });
    await expect(transport.sendMessage("job-a", { type: "payment", content: { credit: received[0] } }, { endpoint }, { jobToken: token }))
      .rejects.toMatchObject({ code: "insufficient_credit", data: { remaining_micro: 1000, shortfall_micro: 500, http_status: 402 } });
    reply = "conflict";
    await expect(transport.sendMessage("job-a", { type: "payment", content: { credit: received[0] } }, { endpoint }, { jobToken: token }))
      .rejects.toMatchObject({ code: "credit_payment_conflict" });
  });
});


const nativeFetch = globalThis.fetch;
function foreignCredit(currency: string, amountMicro = 1350): PaymentRequestContent {
  expectedCurrency = currency;
  expectedMicro = amountMicro;
  writeFileSync(CREDITS_FILE, JSON.stringify({ credits: [{ endpoint, callerPubkey: pubkey, creditId: "held-credit",
    currency, balanceMicro: 10000, remainingMicro: 10000, targetMicro: 10000,
    expiryMs: Date.now() + 86400000, status: "active", ledgerSeq: 1 }], implicitCredits: [], pendingFundings: [] }));
  return { ...ask, credit: { amount_micro: amountMicro, currency } };
}
function mockCurrencySource(response: (signal: AbortSignal) => Promise<Response>) {
  const upstream = vi.fn(response);
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === endpoint) return nativeFetch(input, init);
    expect(url.origin + url.pathname).toBe("https://api.coingecko.com/api/v3/simple/price");
    expect(url.searchParams.get("ids")).toBe("bitcoin");
    expect(url.searchParams.get("vs_currencies")).toBe(`usd,${expectedCurrency}`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return upstream(init!.signal!);
  });
  return upstream;
}

describe("caller-owned non-USD balance valuation", () => {
  it("uses EUR rather than USD and preserves a fractional-sat debit", async () => {
    const request = foreignCredit("eur");
    vi.stubEnv("DVMKIT_FX_SOURCE", "https://example.com/untrusted");
    const source = mockCurrencySource(async () => Response.json({ bitcoin: { usd: 100000, eur: 90000 } }));
    await expect(respond(policy, request)).resolves.toMatchObject({ rail: "credit", amountMsats: 1500 });
    expect(loadJob("job-a")).toMatchObject({ totalPaidMsats: 1500, paymentsHonoured: 1 });
    expect(received[0]).toMatchObject({ currency: "eur", amount_micro: 1350 });
    expect(source).toHaveBeenCalledOnce();
    expect(budget.enforce).not.toHaveBeenCalled();
    expect(budget.record).not.toHaveBeenCalled();
  });

  it.each([
    { limit: "increment", overrides: { maxIncrementMsats: 1550 }, code: "over_budget" },
    { limit: "total", overrides: { maxTotalMsats: 1550 }, code: "over_budget" },
    { limit: "automatic consent", overrides: { autoPayBelowMsats: 1550 }, code: "global_budget_exceeded" },
  ])("checks a within-tolerance foreign debit against actual $limit", async ({ overrides, code }) => {
    const request = foreignCredit("gbp", 1440);
    mockCurrencySource(async () => Response.json({ bitcoin: { usd: 100000, gbp: 90000 } }));
    await expect(respond({ ...policy, ...overrides }, request)).rejects.toMatchObject({ code });
    expect(received).toHaveLength(0);
    expect(loadJob("job-a")?.pendingCreditPayment).toBeUndefined();
  });

  it.each([
    { currency: "cad", value: undefined },
    { currency: "aud", value: -90000 },
    { currency: "nzd", value: "90000" },
  ])("keeps the safe existing path when $currency is absent or invalid", async ({ currency, value }) => {
    const request = foreignCredit(currency);
    mockCurrencySource(async () => Response.json({ bitcoin: { usd: 100000, [currency]: value } }));
    await expect(respond(policy, request)).rejects.toMatchObject({ code: "global_budget_exceeded" });
    expect(received).toHaveLength(0);
    expect(loadJob("job-a")?.pendingCreditPayment).toBeUndefined();
  });

  it("bounds each FX attempt and keeps the safe existing path after timeouts", async () => {
    const source = mockCurrencySource(async () => Response.json({ bitcoin: { usd: 100000, sek: 90000 } }));
    await expect(respond({ ...policy, maxIncrementMsats: 1550 }, foreignCredit("sek", 1440)))
      .rejects.toMatchObject({ code: "over_budget" });
    const request = foreignCredit("sek");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 300001);
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const deadlines = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => timeout(ms === 5000 ? 1 : ms));
    source.mockClear();
    source.mockImplementation((signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    await expect(respond(policy, request)).rejects.toMatchObject({ code: "global_budget_exceeded" });
    expect(source).toHaveBeenCalledTimes(3);
    expect(deadlines.mock.calls.filter(([ms]) => ms === 5000)).toHaveLength(3);
    expect(received).toHaveLength(0);
    expect(loadJob("job-a")?.pendingCreditPayment).toBeUndefined();
  });

  it("refuses a requested rate carried forward after a partial refresh", async () => {
    const source = mockCurrencySource(async () => Response.json({ bitcoin: { usd: 100000 } }));
    source.mockImplementationOnce(async () => Response.json({ bitcoin: { usd: 100000, nok: 90000 } }));
    await expect(respond({ ...policy, maxIncrementMsats: 1550 }, foreignCredit("nok", 1440)))
      .rejects.toMatchObject({ code: "over_budget" });
    const request = foreignCredit("nok");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 300001);
    await expect(respond(policy, request)).rejects.toMatchObject({ code: "global_budget_exceeded" });
    expect(received).toHaveLength(0);
    expect(loadJob("job-a")?.pendingCreditPayment).toBeUndefined();
  });

  it("replays a lost accepted foreign payment without fetching or repricing after FX becomes unavailable", async () => {
    const request = foreignCredit("chf");
    const source = mockCurrencySource(async () => Response.json({ bitcoin: { usd: 100000, chf: 90000 } }));
    reply = "drop";
    await expect(respond(policy, request)).rejects.toBeInstanceOf(Error);
    const saved = loadJob("job-a")!.pendingCreditPayment!;
    expect(saved.amountMsats).toBe(1500);
    source.mockImplementation(async () => Response.json({ bitcoin: { usd: 200000, chf: 180000 } }));
    budget.rate = 1;
    reply = "ok";
    await expect(respond(policy, request)).resolves.toMatchObject({ rail: "credit", amountMsats: 1500 });
    expect(source).toHaveBeenCalledOnce();
    expect(received[1]).toEqual(saved.authorization);
    expect(charged.size).toBe(1);
    expect(loadJob("job-a")).toMatchObject({ totalPaidMsats: 1500, paymentsHonoured: 1 });
    source.mockImplementation(async () => { throw new Error("FX unavailable after acceptance"); });
    await respond(policy, request);
    expect(source).toHaveBeenCalledOnce();
    expect(received).toHaveLength(2);
  });
});
