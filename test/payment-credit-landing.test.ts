import { runCreditDrain } from "../src/lib/credit/drain";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CREDITS_FILE, JOBS_FILE, WALLET_FILE, WALLET_VERSION, loadAgentWallet, saveAgentWallet,
  BUDGET_FILE, recordFundResponse, loadCredit, markCredit, receiptPubkeyFromSecret, type Message, type PaymentRequestContent } from "@dvmkit/sdk/internal";
import { prepareAgentSpend } from "../src/lib/wallet-agent/spend";
import { loadLedger } from "../src/lib/budget-ledger";
import { handlePaymentRequest } from "../src/lib/payment-responder";
import { loadJob, saveJob, updateJob, markPaymentRequestAnswered, markPaymentRequestPaid, markPaymentRequestInFlight } from "../src/lib/job-store";
import { HttpsTransport } from "../src/lib/transport/https";
import { streamLoop } from "../src/lib/stream-loop";
import { pay as payCommand } from "../src/commands/pay";
import { creditList } from "../src/commands/credit";
import { json } from "../src/lib/output";
import { readNextAction } from "../src/lib/read-next-action";
import { loadAnsweredYieldSeqs } from "../src/lib/yield-state";
import { takeCreditNoticeFields } from "../src/lib/credit-notice";

vi.mock("../src/lib/wallet-agent/spend", async (original) => ({
  ...await original<typeof import("../src/lib/wallet-agent/spend")>(), prepareAgentSpend: vi.fn(),
}));
vi.mock("../src/lib/wallet-agent/recovery-submissions", () => ({ sweepPendingSubmissions: async () => undefined }));
const budget = vi.hoisted(() => ({ recordSpend: vi.fn() }));
vi.mock("../src/lib/budget-ledger", async (original) => ({
  ...await original<typeof import("../src/lib/budget-ledger")>(), enforceGlobalBudget: async () => 100_000, recordSpend: budget.recordSpend,
}));
vi.mock("../src/lib/btc-rate", () => ({ tryResolveBtcUsdRate: async () => ({ rate: 100_000, stale: false }) }));
vi.mock("../src/lib/output", async (original) => ({
  ...await original<typeof import("../src/lib/output")>(), json: vi.fn(), info: vi.fn(), progress: vi.fn(),
}));
const key = "01".repeat(32);
const caller = receiptPubkeyFromSecret(key);
const policy = { maxTotalMsats: 100_000, maxIncrementMsats: 100_000, autoPayBelowMsats: 100_000, maxPayments: 3 };
const audience = { dvm_id: "landing-provider", builder_pubkey: "ab".repeat(32) };
let server: Server;
let endpoint: string;
let cause: "mandate" | "expired" | "mismatch" | "unconfirmed";
let implicit: boolean;
let creditPayments: number;
let creditPayment: Message | undefined;
let signed: boolean;
let landed: boolean;
let posts: number;
let balanceReads: number;
let balanceUnavailable: boolean;
let jobUnavailable: boolean;
let statusReads: number;
let failStatusAt: number;
let held: boolean;
let invalidCredit: boolean;
let fresh: boolean;
let refuseCredit: boolean;
let unapplied500: boolean;
let omitCredit: boolean;
let refuseCreditBeforeLanding: boolean;
let sends: number;
let drainRequests: Record<string, unknown>[];
let ask: PaymentRequestContent;
const creditId = () => signed && !implicit ? (fresh ? "fresh-credit" : "held-credit") : "imp:cashu:landing-token";
const wireCredit = () => ({ credit_id: creditId(), currency: "usd", balance_micro: 11_500, remaining_micro: held ? 0 : 11_500,
  expiry_ms: Date.now() + 86_400_000, expired: false, drainable: !held, ledger_seq: 2 });
function history(): Message[] {
  return [...(creditPayment ? [creditPayment] : []), { seq: 4, from: "provider", timestamp: 1, type: "payment-request", content: ask },
    ...(landed && cause === "mandate" ? [{ seq: 5, from: "requester", timestamp: 2, type: "payment", content: { credit: {
      mandate: true, credit_id: "held-credit", draw_id: "draw", request_seq: 4, payment_id: "mandate-winner", amount_micro: 1500, currency: "usd",
    } } } as Message] : []),
    ...(landed && cause === "expired" ? [{ seq: 5, from: "provider", timestamp: 2, type: "cancel", content: { reason: "Payment request expired" } } as Message] : [])];
}
beforeEach(async () => {
  statusReads = 0; failStatusAt = 0;
  omitCredit = false; refuseCreditBeforeLanding = false; invalidCredit = false; fresh = false; refuseCredit = false; unapplied500 = false; sends = 0; drainRequests = []; implicit = false; creditPayments = 0; creditPayment = undefined; jobUnavailable = false; held = false;
  cause = "mandate"; signed = true; landed = false; posts = 0; balanceReads = 0; balanceUnavailable = false;
  for (const file of [BUDGET_FILE, CREDITS_FILE, JOBS_FILE, WALLET_FILE]) rmSync(file, { force: true });
  rmSync(join(process.env.DVM_CONFIG_DIR!, "messages"), { recursive: true, force: true });
  takeCreditNoticeFields();
  process.env.DVM_IDENTITY_KEY = key;
  ask = { amount_msats: 1500, reason: "Next piece", credit: { amount_micro: 1500, currency: "usd" },
    lock_pubkey: "02" + "11".repeat(32), mints: ["https://mint.example"], expires_at_ms: Date.now() + 600_000 };
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/info") return void response.end(JSON.stringify({ protocol_version: 1, auth: ["secp256k1-schnorr-v2"], auth_audience: audience, credit: { balance_payment: true, currency: "usd", funding: ["cashu"], min_micro: 1000, max_micro: 5_000_000, ttl_ms: 86_400_000 } }));
    if (request.url === "/v1/credit") {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.op === "drain") {
        drainRequests.push(body);
        return void response.end(JSON.stringify({ op: "drain", credit: { ...wireCredit(), remaining_micro: 0 }, drain: {
          drain_id: body.drain_id, credit_id: body.credit_id, method: "cashu", status: "pending", amount_micro: 11_500,
          currency: "usd", ledger_seq: 3, created_at: Date.now(), receipts: [],
        } }));
      }
      balanceReads++;
      expect(body).toMatchObject({ op: "balance", credit_id: creditId(), pubkey: caller });
      if (balanceUnavailable) { response.statusCode = 503; return void response.end('{"error":"unavailable"}'); }
      return void response.end(JSON.stringify({ op: "balance", credit: wireCredit() }));
    }
    if (jobUnavailable && request.method === "GET") { response.statusCode = 503; return void response.end('{"error":"unavailable"}'); }
    if (request.url === "/v1/job/job-landing" && ++statusReads === failStatusAt) {
      response.statusCode = 503; return void response.end('{"error":"unavailable"}');
    }
    if (request.url === "/v1/job/job-landing") return void response.end(JSON.stringify({ status: landed && cause === "expired" ? "cancelled" : (creditPayment || (landed && cause === "mandate")) ? "processing" : "awaiting-input" }));
    if (request.method === "GET") return void response.end(JSON.stringify({ messages: history() }));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.content?.credit) {
      creditPayments++;
      if (refuseCredit || (refuseCreditBeforeLanding && !landed)) { response.statusCode = 402; return void response.end(JSON.stringify({ error: "insufficient_credit", remaining_micro: 0, shortfall_micro: 1500 })); }
      expect(body.content.credit).toMatchObject({ credit_id: "held-credit", request_seq: 4, amount_micro: 1500, pubkey: caller });
      creditPayment = { seq: 7, from: "requester", timestamp: 3, type: "payment", content: body.content };
      response.statusCode = 201; return void response.end(JSON.stringify({ seq: 7 }));
    }
    expect(body).toMatchObject({ type: "payment", content: { cashu_token: "landing-token", cashu_request_id: sends === 1 ? "landing-send" : `landing-send-${sends}` } });
    posts++; landed = true;
    if (unapplied500) {
      response.statusCode = posts === 1 ? 500 : 409;
      return void response.end(JSON.stringify(posts === 1 ? { error: "payment_unapplied", ...(omitCredit ? {} : { credit_id: creditId(), credited_micro: 1500, credit_currency: "usd" }),
        display: "The payment was received but whether it paid the charge is unconfirmed.", hint: "Read the job status before paying again." }
        : { error: "replay_rejected" }));
    }
    response.statusCode = 201;
    response.end(JSON.stringify({ seq: 6, credit: { credit_id: creditId(), credited_micro: 1500, credit_currency: invalidCredit ? "untrusted prose" : "usd",
      display: "Provider wording is not CLI guidance", hint: cause === "expired" ? "ask_expired" : cause === "mismatch" ? "rail_mismatch" : cause === "unconfirmed" ? "unconfirmed" : "no_open_ask" } }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  vi.mocked(prepareAgentSpend).mockImplementation(async () => {
    const requestId = ++sends === 1 ? "landing-send" : `landing-send-${sends}`;
    if (cause === "expired") ask.expires_at_ms = Date.now() - 31_000;
    saveAgentWallet({ version: WALLET_VERSION, lock_privkey: key, lock_pubkey: "02" + caller,
      mnemonic_fingerprint: null, mints: ["https://mint.example"], proofs: [], nut13_counters: {}, pending_mints: [], pending_melts: [],
      pending_submissions: [{ request_id: requestId, endpoint, mint: "https://mint.example", amount_sats: 2,
        intended_lock_pubkey: ask.lock_pubkey!, cashu_token: "landing-token", output_proofs: [], created_at: new Date().toISOString() }],
      recent_spends: [], created_at: new Date().toISOString() });
    return { endpoint, cashuToken: "landing-token", requestId, mint: "https://mint.example", totalSats: 2,
      swapFeeSats: 0, intendedLockPubkey: ask.lock_pubkey! };
  });
});
afterEach(async () => {
  delete process.env.DVM_IDENTITY_KEY;
  server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
});
function seed() {
  if (signed) recordFundResponse({ endpoint, callerPubkey: caller, credit: { ...wireCredit(), balance_micro: 10_000, remaining_micro: 10_000, ledger_seq: 1 }, targetMicro: 10_000 });
  saveJob({ id: "job-landing", endpoint, status: "processing", submittedAt: Date.now(), policy,
    ...(signed ? { creditBinding: { creditId: "held-credit", drawId: "draw", callerPubkey: caller } } : {}),
    ...(cause === "mandate" ? { mandate: { credit_id: "held-credit", draw_id: "draw", currency: "usd", max_total_micro: 100_000,
      max_ask_micro: 50_000, expires_at_ms: Date.now() + 600_000, signed_data: {} }, mandateAskObservedAtMs: { 4: Date.now() - 90_000 } } : {}) });
  // The pocket exists before mint preparation is requested.
  saveAgentWallet({ version: WALLET_VERSION, lock_privkey: key, lock_pubkey: "02" + caller, mnemonic_fingerprint: null,
    mints: [], proofs: [], nut13_counters: {}, pending_mints: [], pending_melts: [], pending_submissions: [], recent_spends: [], created_at: new Date().toISOString() });
}

it.each(["mandate", "expired"] as const)("records the real 201 Cashu balance landing after %s without booking another job payment", async (reason) => {
  cause = reason; seed();
  const transport = new HttpsTransport();
  const pay = () => handlePaymentRequest("job-landing", ask, policy, transport, { endpoint }, { rail: "cashu", requestSeq: 4 });
  const result = await pay();
  expect(result).toMatchObject({ status: "credited", credit: { credit_id: "held-credit", credited_micro: 1500, drainable: reason === "expired",
    ...(reason === "expired" ? { reclaim_command: expect.stringContaining("dvm credit drain") } : {}), display: expect.stringContaining("$0.0015") } });
  expect(loadJob("job-landing")?.paymentsHonoured ?? 0).toBe(0);
  expect(loadJob("job-landing")?.paidPaymentRequestSeqs).toBeUndefined();
  expect(loadCredit(endpoint, caller)).toMatchObject({ creditId: "held-credit", remainingMicro: 11_500 });
  expect(loadAgentWallet()).toMatchObject({ pending_submissions: [], recent_spends: [{ request_id: "landing-send", amount_sats: 2 }] });
  await pay();
  for (let read = 0; read < 2; read++) await streamLoop({ jobId: "job-landing", transport, provider: { endpoint }, policy, afterSeq: 0 });
  expect(loadJob("job-landing")?.paymentsHonoured ?? 0).toBe(reason === "mandate" ? 1 : 0);
  expect(loadJob("job-landing")?.totalPaidMsats ?? 0).toBe(reason === "mandate" ? 1500 : 0);
  expect(posts).toBe(1); expect(balanceReads).toBe(1);
  expect(loadLedger().entries).toMatchObject([{ kind: "credit_fund", jobId: "fund:landing-send", msats: 2000 }]);
  expect(loadLedger().entries).toHaveLength(1);
  expect(budget.recordSpend).not.toHaveBeenCalled();
  creditList({});
  expect(vi.mocked(json).mock.calls.at(-1)![0]).toMatchObject({ credits: [{ credit_id: "held-credit", remaining_micro: 11_500 }],
    payment_credit_landings: [{ credited_micro: 1500 }] });
  transport.close();
});

it("records an unsigned landing without promising a caller-key drain", async () => {
  signed = false; cause = "expired"; seed();
  const transport = new HttpsTransport();
  const result = await handlePaymentRequest("job-landing", ask, policy, transport, { endpoint }, { rail: "cashu", requestSeq: 4 });
  expect(result).toMatchObject({ status: "credited", credit: { credit_id: "imp:cashu:landing-token", drainable: false,
    display: expect.stringContaining("no caller key can drain") } });
  expect(typeof result === "object" && result.status === "credited" && result.credit.reclaim_command).toBeUndefined();
  creditList({});
  expect(vi.mocked(json).mock.calls.at(-1)![0]).toMatchObject({ payment_credit_landings: [{ amount_msats: 1500, amount_sats: 2, credited_micro: 1500, drainable: false }] });
  expect(balanceReads).toBe(0); expect(budget.recordSpend).not.toHaveBeenCalled();
  transport.close();
});

it("keeps an accepted landing recoverable when its follow-up balance read fails", async () => {
  balanceUnavailable = true; cause = "expired"; seed();
  const transport = new HttpsTransport();
  const pay = () => handlePaymentRequest("job-landing", ask, policy, transport, { endpoint }, { rail: "cashu", requestSeq: 4 });
  await expect(pay()).resolves.toMatchObject({ status: "credited" });
  await expect(pay()).resolves.toMatchObject({ status: "credited", credit: { credited_micro: 1500 } });
  expect(posts).toBe(1); expect(loadCredit(endpoint, caller)?.provisional).toBe(true);
  expect(loadJob("job-landing")?.totalPaidMsats ?? 0).toBe(0);
  transport.close();
});


it("reports automatic balance landings separately from automatic job payments", async () => {
  refuseCredit = true; cause = "expired"; seed();
  const transport = new HttpsTransport();
  const result = await streamLoop({ jobId: "job-landing", transport, provider: { endpoint }, policy, afterSeq: 0 });
  expect(result.autoPayments).toEqual([]);
  expect(takeCreditNoticeFields().payment_credit_landings).toMatchObject([{ credited_micro: 1500,
    display: expect.stringContaining("became credit") }]);
  expect(loadJob("job-landing")?.paymentsHonoured ?? 0).toBe(0);
  expect(posts).toBe(1); expect(budget.recordSpend).not.toHaveBeenCalled();
  transport.close();
});

it("dvm pay reports a credit landing rather than claiming the job was paid", async () => {
  cause = "expired"; seed();
  await payCommand("job-landing", { rail: "cashu" });
  const output = vi.mocked(json).mock.calls.at(-1)![0] as Record<string, unknown>;
  expect(output).toMatchObject({ credit_landing: { credit_id: "held-credit", credited_micro: 1500 },
    display: expect.stringContaining("became credit") });
  expect(output.paid).toBeUndefined();
  expect(posts).toBe(1); expect(budget.recordSpend).not.toHaveBeenCalled();
});


it("the existing drain command reclaims the recorded provider credit as its original caller", async () => {
  cause = "expired"; seed();
  const transport = new HttpsTransport();
  await handlePaymentRequest("job-landing", ask, policy, transport, { endpoint }, { rail: "cashu", requestSeq: 4 });
  await runCreditDrain(endpoint, {});
  expect(drainRequests).toMatchObject([{ op: "drain", credit_id: "held-credit", pubkey: caller }]);
  expect(vi.mocked(json).mock.calls.at(-1)![0]).toMatchObject({ op: "drain", drain: { credit_id: "held-credit", status: "pending" } });
  expect(posts).toBe(1);
  transport.close();
});

it("does not turn unreadable 201 credit details into an assumed job payment", async () => {
  invalidCredit = true; cause = "expired"; seed();
  const transport = new HttpsTransport();
  await expect(handlePaymentRequest("job-landing", ask, policy, transport, { endpoint }, { rail: "cashu", requestSeq: 4 }))
    .rejects.toMatchObject({ code: "payment_unconfirmed" });
  expect(loadJob("job-landing")?.unconfirmedPaymentSubmissions?.[4]).toBeDefined();
  expect(loadJob("job-landing")?.paymentsHonoured ?? 0).toBe(0);
  expect(budget.recordSpend).not.toHaveBeenCalled();
  transport.close();
});


it.each(["mismatch", "unconfirmed"] as const)("leaves the ask payable after a %s credit landing", async (reason) => {
  cause = reason; unapplied500 = reason === "unconfirmed"; seed();
  const transport = new HttpsTransport();
  const first = await handlePaymentRequest("job-landing", ask, policy, transport, { endpoint }, { rail: "cashu", requestSeq: 4 });
  expect(first).toMatchObject({ status: "credited", credit: { ask_answered: false,
    provider_display: { _source: "provider", text: reason === "mismatch" ? "Provider wording is not CLI guidance" : "The payment was received but whether it paid the charge is unconfirmed." },
    provider_hint: { _source: "provider", text: reason === "mismatch" ? "rail_mismatch" : "Read the job status before paying again." },
    display: expect.stringContaining("charge is still open") } });
  expect(loadAnsweredYieldSeqs("job-landing").has(4)).toBe(false);
  const read = await streamLoop({ jobId: "job-landing", transport, provider: { endpoint }, afterSeq: 0 });
  expect(read.nextAction).toMatchObject({ type: "pay" });
  expect(read.nextAction?.hint).not.toContain("already sent");
  expect(posts).toBe(1); expect(loadJob("job-landing")?.paymentsHonoured ?? 0).toBe(0);
  transport.close();
});

it("pays the still-open ask once from the newly recorded credit, including reconnects", async () => {
  cause = "mismatch"; seed();
  const transport = new HttpsTransport();
  await handlePaymentRequest("job-landing", ask, policy, transport, { endpoint }, { rail: "cashu", requestSeq: 4, approval: "explicit" });
  expect(loadAnsweredYieldSeqs("job-landing").has(4)).toBe(false);
  for (let read = 0; read < 2; read++) await streamLoop({ jobId: "job-landing", transport, provider: { endpoint }, policy, afterSeq: 0 });
  expect(creditPayments).toBe(1); expect(posts).toBe(1);
  expect(loadJob("job-landing")).toMatchObject({ paymentsHonoured: 1, totalPaidMsats: 1500 });
  expect(loadAnsweredYieldSeqs("job-landing").has(4)).toBe(true);
  expect(loadLedger().entries).toMatchObject([{ kind: "credit_fund", jobId: "fund:landing-send", msats: 2000 }]);
  expect(loadLedger().entries).toHaveLength(1); expect(budget.recordSpend).not.toHaveBeenCalled();
  transport.close();
});

it("never offers a drain for an implicit credit even when the job has a signed caller", async () => {
  implicit = true; cause = "expired"; seed();
  const transport = new HttpsTransport();
  const result = await handlePaymentRequest("job-landing", ask, policy, transport, { endpoint }, { rail: "cashu", requestSeq: 4 });
  expect(result).toMatchObject({ status: "credited", credit: { credit_id: "imp:cashu:landing-token", drainable: false,
    display: expect.stringContaining("no caller key can drain") } });
  expect(typeof result === "object" && result.status === "credited" && result.credit.reclaim_command).toBeUndefined();
  expect(balanceReads).toBe(0);
  transport.close();
});

it("hides a landing notice after its credit is drained to zero", async () => {
  cause = "expired"; seed();
  const transport = new HttpsTransport();
  await handlePaymentRequest("job-landing", ask, policy, transport, { endpoint }, { rail: "cashu", requestSeq: 4 });
  markCredit(endpoint, caller, "drained");
  creditList({});
  expect((vi.mocked(json).mock.calls.at(-1)![0] as Record<string, unknown>).payment_credit_landings).toBeUndefined();
  transport.close();
});


it("does not offer an immediate drain while the provider holds the landed balance", async () => {
  cause = "unconfirmed"; unapplied500 = true; held = true; seed();
  const transport = new HttpsTransport();
  const result = await handlePaymentRequest("job-landing", ask, policy, transport, { endpoint }, { rail: "cashu", requestSeq: 4 });
  expect(result).toMatchObject({ status: "credited", credit: { ask_answered: false, drainable: false,
    display: expect.stringContaining("hold the credit until the job ends") } });
  expect(typeof result === "object" && result.status === "credited" && result.credit.reclaim_command).toBeUndefined();
  transport.close();
});

it("does not send a replacement until fresh status and history confirm the charge is open", async () => {
  cause = "mismatch"; jobUnavailable = true; seed();
  const transport = new HttpsTransport();
  const pay = () => handlePaymentRequest("job-landing", ask, policy, transport, { endpoint }, { rail: "cashu", requestSeq: 4 });
  await expect(pay()).resolves.toMatchObject({ status: "credited", credit: { ask_answered: false,
    display: expect.stringContaining("has not been confirmed") } });
  await expect(pay()).rejects.toMatchObject({ code: "payment_settling" });
  expect(posts).toBe(1); expect(loadAnsweredYieldSeqs("job-landing").has(4)).toBe(false);
  jobUnavailable = false;
  await streamLoop({ jobId: "job-landing", transport, provider: { endpoint }, policy, afterSeq: 0 });
  expect(creditPayments).toBe(1); expect(posts).toBe(1);
  transport.close();
});


it("refreshing an old landing preserves a newer unresolved payment for the same ask", async () => {
  cause = "mismatch"; seed();
  const transport = new HttpsTransport();
  await handlePaymentRequest("job-landing", ask, policy, transport, { endpoint }, { rail: "cashu", requestSeq: 4 });
  const pending = { rail: "x402" as const, content: { x402_payment: "new-signed-payment", amount_msats: 1500 },
    requestAmountMsats: 1500, amountMsats: 1500, btcRate: 100_000 };
  markPaymentRequestInFlight("job-landing", 4, pending);
  await expect(handlePaymentRequest("job-landing", ask, policy, transport, { endpoint }, { rail: "cashu", requestSeq: 4 }))
    .rejects.toMatchObject({ code: "payment_settling" });
  expect(loadJob("job-landing")?.unconfirmedPaymentSubmissions?.[4]).toEqual(pending);
  expect(posts).toBe(1);
  transport.close();
});


it("stops automatic rail payments after a fresh mismatch landing and repeated bound-credit refusals", async () => {
  cause = "mismatch"; refuseCredit = true; seed(); fresh = true;
  const transport = new HttpsTransport();
  let last;
  for (let read = 0; read < 3; read++) {
    last = await streamLoop({ jobId: "job-landing", transport, provider: { endpoint }, policy, afterSeq: 0 });
    expect(last.nextAction).toMatchObject({ type: "pay", requires_approval: true });
    expect(creditPayments).toBeGreaterThanOrEqual(2);
  }
  expect(posts).toBe(1);
  expect(last?.nextAction).toMatchObject({ type: "pay", requires_approval: true, display: expect.stringContaining("charge is still open") });
  expect(last?.nextAction?.hint).toContain("different rail");
  expect(last?.nextAction?.hint).toContain(`dvm credit drain ${endpoint} --credit-id fresh-credit`);
  expect(last?.nextAction?.hint).toContain("dvm decline job-landing");
  expect(JSON.stringify(last?.nextAction)).not.toMatch(/unsigned/i);
  expect(last?.nextAction?.display).toContain("$0.0015");
  expect(last?.nextAction?.display).toContain("fresh-credit");
  expect(readNextAction("job-landing", history())).toMatchObject({ type: "pay", requires_approval: true });
  expect(loadLedger().entries).toHaveLength(1);
  expect(loadJob("job-landing")?.paymentsHonoured ?? 0).toBe(0);
  transport.close();
});

it("refuses repeated explicit Cashu payments after one mismatch landing", async () => {
  cause = "mismatch"; refuseCredit = true; seed(); fresh = true;
  await expect(payCommand("job-landing", { rail: "cashu" })).rejects.toMatchObject({ code: "payment_credit_choice_required" });
  for (let attempt = 0; attempt < 2; attempt++) await expect(payCommand("job-landing", { rail: "cashu" }))
    .rejects.toMatchObject({ code: "payment_credit_rail_repeated", message: expect.stringContaining("land as credit again") });
  expect(posts).toBe(1); expect(loadLedger().entries).toHaveLength(1);
});

it.each([false, true])("stops implicit mismatch landings without offering a drain (signed caller: %s)", async (signedCaller) => {
  cause = "mismatch"; signed = signedCaller; implicit = true; refuseCredit = true; seed();
  const transport = new HttpsTransport();
  let last;
  for (let read = 0; read < 3; read++) last = await streamLoop({ jobId: "job-landing", transport, provider: { endpoint }, policy, afterSeq: 0 });
  expect(posts).toBe(1);
  expect(last?.nextAction).toMatchObject({ requires_approval: true });
  expect(JSON.stringify(last?.nextAction)).not.toContain("dvm credit drain");
  expect(JSON.stringify(last?.nextAction)).toContain("no caller key can drain");
  transport.close();
});

it("never re-sends a payment after the real 500 payment_unapplied credit landing", async () => {
  cause = "unconfirmed"; signed = false; unapplied500 = true; seed();
  const transport = new HttpsTransport();
  let last;
  const originalNow = Date.now();
  for (let read = 0; read < 3; read++) {
    // Cross the old uncertain-send retry window so a held send cannot hide a replay.
    vi.spyOn(Date, "now").mockReturnValue(originalNow + read * 46_000);
    try { last = await streamLoop({ jobId: "job-landing", transport, provider: { endpoint }, policy, afterSeq: 0 }); } catch { /* Probe retries after the provider fault. */ }
  }
  expect(posts).toBe(1);
  expect(last?.nextAction).toMatchObject({ requires_approval: true });
  expect(Object.values(loadJob("job-landing")?.paymentCreditLandings ?? {})).toMatchObject([{ credit_id: "imp:cashu:landing-token", credited_micro: 1500 }]);
  expect(loadJob("job-landing")?.paymentsHonoured ?? 0).toBe(0);
  transport.close();
});

it("describes an open landing as potential charge funding without a reclaim command", async () => {
  cause = "mismatch"; seed();
  const transport = new HttpsTransport();
  await handlePaymentRequest("job-landing", ask, policy, transport, { endpoint }, { rail: "cashu", requestSeq: 4 });
  creditList({});
  expect(vi.mocked(json).mock.calls.at(-1)![0]).toMatchObject({ payment_credit_landings: [{ ask_open: true,
    display: expect.stringContaining("may still pay the charge") }] });
  expect(JSON.stringify((vi.mocked(json).mock.calls.at(-1)![0] as Record<string, unknown>).payment_credit_landings)).not.toContain("dvm credit drain");
  await streamLoop({ jobId: "job-landing", transport, provider: { endpoint }, policy, afterSeq: 0 });
  creditList({});
  expect(vi.mocked(json).mock.calls.at(-1)![0]).toMatchObject({ payment_credit_landings: [{ ask_answered: true, ask_open: false,
    display: expect.stringContaining("settled"), drainable: false }] });
  expect(JSON.stringify((vi.mocked(json).mock.calls.at(-1)![0] as Record<string, unknown>).payment_credit_landings)).not.toContain("dvm credit drain");
  transport.close();
});

it("does not offer a second drain while the landing credit has a pending drain", async () => {
  cause = "expired"; seed();
  const transport = new HttpsTransport();
  await handlePaymentRequest("job-landing", ask, policy, transport, { endpoint }, { rail: "cashu", requestSeq: 4 });
  await runCreditDrain(endpoint, {});
  creditList({});
  const entries = (vi.mocked(json).mock.calls.at(-1)![0] as Record<string, unknown>).payment_credit_landings;
  expect(JSON.stringify(entries)).not.toContain("dvm credit drain");
  expect(JSON.stringify(entries)).toContain("drain is pending");
  transport.close();
});


it("does not offer a stale drain for an exhausted sibling credit", async () => {
  cause = "expired"; seed(); fresh = true;
  const transport = new HttpsTransport();
  await handlePaymentRequest("job-landing", ask, policy, transport, { endpoint }, { rail: "cashu", requestSeq: 4 });
  recordFundResponse({ endpoint, callerPubkey: caller, credit: { ...wireCredit(), balance_micro: 0, remaining_micro: 0, ledger_seq: 3 }, targetMicro: 0 });
  recordFundResponse({ endpoint, callerPubkey: caller, credit: { ...wireCredit(), credit_id: "held-credit", balance_micro: 10_000, remaining_micro: 10_000, ledger_seq: 4 }, targetMicro: 0 });
  creditList({});
  const entries = (vi.mocked(json).mock.calls.at(-1)![0] as Record<string, unknown>).payment_credit_landings;
  expect(JSON.stringify(entries)).toContain("settled");
  expect(JSON.stringify(entries)).not.toContain("dvm credit drain");
  transport.close();
});

it("tries bound credit after an automatic landing before asking a human", async () => {
  cause = "mismatch"; refuseCreditBeforeLanding = true; seed();
  const transport = new HttpsTransport();
  const first = await streamLoop({ jobId: "job-landing", transport, provider: { endpoint }, policy, afterSeq: 0 });
  expect(first.nextAction).not.toMatchObject({ requires_approval: true });
  const next = await streamLoop({ jobId: "job-landing", transport, provider: { endpoint }, policy, afterSeq: 0 });
  expect(next.nextAction).not.toMatchObject({ requires_approval: true });
  expect(creditPayments).toBe(2);
  expect(posts).toBe(1);
  expect(loadJob("job-landing")).toMatchObject({ paymentsHonoured: 1, totalPaidMsats: 1500 });
  transport.close();
});

it("does not present a human choice on an ordinary read before trying landed credit", async () => {
  cause = "mismatch"; seed();
  const transport = new HttpsTransport();
  await handlePaymentRequest("job-landing", ask, policy, transport, { endpoint }, { rail: "cashu", requestSeq: 4, approval: "explicit" });
  expect(creditPayments).toBe(0);
  expect(readNextAction("job-landing", history())).not.toMatchObject({ requires_approval: true });
  const next = await streamLoop({ jobId: "job-landing", transport, provider: { endpoint }, policy, afterSeq: 0 });
  expect(next.autoPayments).toMatchObject([{ rail: "credit" }]);
  expect(next.nextAction).not.toMatchObject({ requires_approval: true });
  expect(posts).toBe(1);
  transport.close();
});

it("returns a settling action for payment_unapplied without readable credit fields", async () => {
  cause = "unconfirmed"; refuseCredit = true; unapplied500 = true; omitCredit = true; seed();
  const transport = new HttpsTransport();
  const result = await streamLoop({ jobId: "job-landing", transport, provider: { endpoint }, policy, afterSeq: 0 });
  expect(result).toMatchObject({ nextAction: { type: "poll", hint: expect.stringContaining("re-sends that same payment") }, paymentInFlight: true });
  expect(loadJob("job-landing")?.unconfirmedPaymentSubmissions?.[4]).toBeDefined();
  expect(loadJob("job-landing")?.paymentCreditLandings).toBeUndefined();
  expect(loadJob("job-landing")?.paymentsHonoured ?? 0).toBe(0);
  const retry = await streamLoop({ jobId: "job-landing", transport, provider: { endpoint }, policy, afterSeq: 0 });
  expect(retry.nextAction).toMatchObject({ type: "poll" });
  expect(posts).toBe(1); expect(sends).toBe(1);
  transport.close();
});

it.each([false, true])("uses explicit approval to try landed credit above the auto-pay limit (refused: %s)", async (refused) => {
  cause = "mismatch"; refuseCredit = refused; seed();
  updateJob("job-landing", { policy: { ...policy, autoPayBelowMsats: 1000 } });
  if (refused) {
    await expect(payCommand("job-landing", { rail: "cashu" })).rejects.toMatchObject({
      code: "payment_credit_choice_required", data: { next_action: { requires_approval: true, hint: expect.stringContaining("dvm decline job-landing") } },
    });
    expect(loadJob("job-landing")?.paymentsHonoured ?? 0).toBe(0);
  } else {
    await payCommand("job-landing", { rail: "cashu" });
    expect(vi.mocked(json).mock.calls.at(-1)![0]).toMatchObject({ paid: { rail: "credit" }, next_action: { type: "poll" } });
    expect(loadJob("job-landing")).toMatchObject({ paymentsHonoured: 1, paymentApprovals: [{ requestSeq: 4, approval: "explicit" }] });
  }
  expect(creditPayments).toBe(1);
  expect(posts).toBe(1); expect(sends).toBe(1);
  await expect(payCommand("job-landing", { rail: "cashu" })).rejects.toMatchObject({ code: refused ? "payment_credit_rail_repeated" : "no_payment_pending" });
  expect(posts).toBe(1); expect(sends).toBe(1);
});

it.each([
  [1, false], [1, true], [2, false], [2, true],
])("re-examines a landed ask from the returned cursor after status read %i fails (refused: %s)", async (failAt, refused) => {
  cause = "mismatch"; refuseCreditBeforeLanding = true; failStatusAt = failAt; seed();
  const transport = new HttpsTransport();
  const first = await streamLoop({ jobId: "job-landing", transport, provider: { endpoint }, policy, afterSeq: 0 });
  expect(statusReads).toBe(failAt);
  expect(first).toMatchObject({ cursor: 3, nextAction: { type: "poll", hint: expect.stringContaining("credit") } });
  expect(first.nextAction?.hint).not.toMatch(/unconfirmed|no copy|re-send/i);
  refuseCredit = refused;
  const next = await streamLoop({ jobId: "job-landing", transport, provider: { endpoint }, policy, afterSeq: first.cursor });
  if (refused) expect(next.nextAction).toMatchObject({ type: "pay", requires_approval: true });
  else {
    expect(next.autoPayments).toMatchObject([{ rail: "credit" }]);
    expect(next.nextAction).toMatchObject({ type: "poll" });
    expect(loadJob("job-landing")?.paymentsHonoured).toBe(1);
  }
  expect(creditPayments).toBe(2);
  expect(posts).toBe(1); expect(sends).toBe(1);
  transport.close();
});

it.each(["pinned rail", "no binding"])("does not save a credit refusal when no credit attempt was made: %s", async (mode) => {
  cause = "mismatch"; signed = mode !== "no binding"; seed();
  const transport = new HttpsTransport();
  await handlePaymentRequest("job-landing", ask, policy, transport, { endpoint }, { rail: "cashu", requestSeq: 4 });
  await expect(handlePaymentRequest("job-landing", ask, policy, transport, { endpoint }, { rail: "cashu", requestSeq: 4 }))
    .rejects.toMatchObject({ code: "payment_credit_choice_required" });
  expect(creditPayments).toBe(0);
  if (mode === "no binding") expect(readNextAction("job-landing", history())).toMatchObject({ requires_approval: true });
  else expect(readNextAction("job-landing", history())).not.toMatchObject({ requires_approval: true });
  expect(Object.values(loadJob("job-landing")?.paymentCreditLandings ?? {})[0].credit_payment_unavailable).toBeUndefined();
  expect(posts).toBe(1);
  transport.close();
});

it("clears a real credit refusal after a top-up pays the landed ask", async () => {
  cause = "mismatch"; refuseCredit = true; seed();
  const transport = new HttpsTransport();
  const first = await streamLoop({ jobId: "job-landing", transport, provider: { endpoint }, policy, afterSeq: 0 });
  expect(first.nextAction).toMatchObject({ requires_approval: true });
  expect(creditPayments).toBe(2);
  expect(Object.values(loadJob("job-landing")?.paymentCreditLandings ?? {})[0].credit_payment_unavailable).toBe(true);
  recordFundResponse({ endpoint, callerPubkey: caller, credit: { ...wireCredit(), ledger_seq: 3 }, targetMicro: 10_000 });
  refuseCredit = false;
  const next = await streamLoop({ jobId: "job-landing", transport, provider: { endpoint }, policy, afterSeq: first.cursor });
  expect(next.autoPayments).toMatchObject([{ rail: "credit" }]);
  expect(loadJob("job-landing")?.paymentsHonoured).toBe(1);
  expect(Object.values(loadJob("job-landing")?.paymentCreditLandings ?? {})[0].credit_payment_unavailable).toBeUndefined();
  expect(posts).toBe(1); expect(sends).toBe(1);
  transport.close();
});

it.each(["external answer", "rail payment", "terminal job"])("clears a credit refusal when the charge is resolved by %s", async (answer) => {
  cause = "mismatch"; refuseCredit = true; seed();
  const transport = new HttpsTransport();
  await streamLoop({ jobId: "job-landing", transport, provider: { endpoint }, policy, afterSeq: 0 });
  expect(Object.values(loadJob("job-landing")?.paymentCreditLandings ?? {})[0].credit_payment_unavailable).toBe(true);
  if (answer === "external answer") markPaymentRequestAnswered("job-landing", 4);
  else if (answer === "rail payment") markPaymentRequestPaid("job-landing", 4);
  else updateJob("job-landing", { status: "cancelled" });
  expect(Object.values(loadJob("job-landing")?.paymentCreditLandings ?? {})[0].credit_payment_unavailable).toBeUndefined();
  expect(posts).toBe(1);
  transport.close();
});
