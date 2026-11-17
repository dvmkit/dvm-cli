import { createServer, type Server } from "node:http";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CREDITS_FILE, DvmError, JOBS_FILE, receiptPubkeyFromSecret, type PaymentRequestContent } from "@dvmkit/sdk/internal";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handlePaymentRequest } from "../src/lib/payment-responder";
import { loadJob, saveJob } from "../src/lib/job-store";
import { HttpsTransport } from "../src/lib/transport/https";
import { streamLoop } from "../src/lib/stream-loop";

const budget = vi.hoisted(() => ({ enforce: vi.fn(), record: vi.fn() }));
vi.mock("../src/lib/btc-rate", () => ({ tryResolveBtcUsdRate: async () => ({ rate: 100000, stale: false }) }));
vi.mock("../src/lib/budget-ledger", async (original) => ({
  ...await original<typeof import("../src/lib/budget-ledger")>(), enforceGlobalBudget: budget.enforce, recordSpend: budget.record,
}));
vi.mock("../src/lib/output", async (original) => ({
  ...await original<typeof import("../src/lib/output")>(), info: vi.fn(), json: vi.fn(), progress: vi.fn(),
}));
const secret = "01".repeat(32);
const pubkey = receiptPubkeyFromSecret(secret);
const audience = { dvm_id: "example-provider", builder_pubkey: "ab".repeat(32) };
const policy = { maxTotalMsats: 4_000, maxIncrementMsats: 2_000, autoPayBelowMsats: 2_000, maxPayments: 3 };
const ask: PaymentRequestContent = { amount_msats: 1_500, reason: "Additional work", credit: { amount_micro: 1_500, currency: "usd" } };
const token = "ab".repeat(32);
let server: Server; let endpoint: string;
let phase: "drop" | "echo" = "drop";
let posts = 0;
let declines = 0;
let stopped = false;
let moveDuringStatus = false;
let terminal = false;
let reportedStatus: string | undefined;
let lastAuth: unknown;
let mode: "signed" | "mandate" | "mandate-lost" = "signed";
beforeEach(async () => {
  reportedStatus = undefined; phase = "drop"; posts = 0; declines = 0; stopped = false; moveDuringStatus = false; terminal = false; lastAuth = undefined; mode = "signed";
  process.env.DVM_IDENTITY_KEY = secret;
  budget.enforce.mockRejectedValue(new DvmError("global_budget_exceeded", "no"));
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (c: Buffer) => chunks.push(c));
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/v1/info") {
        response.end(JSON.stringify({ protocol_version: 1, auth: ["secp256k1-schnorr-v2"], auth_audience: audience,
          credit: { balance_payment: true, standing_mandate: true, currency: "usd", funding: ["cashu"], min_micro: 1000, max_micro: 5000000, ttl_ms: 86400000 } }));
        return;
      }
      if (request.method === "GET" && request.url === "/v1/job/job-a") {
        response.end(JSON.stringify({ status: reportedStatus ?? (terminal ? "completed" : stopped ? "cancelled" : moveDuringStatus ? "processing" : phase === "drop" ? "awaiting-input" : "processing") })); return;
      }
      if (request.method === "GET") {
        const msgs: unknown[] = [{ seq: 4, from: "provider", timestamp: Math.floor(Date.now() / 1000), type: "payment-request", content: ask }];
        if (phase === "echo") msgs.push({ seq: 5, from: "requester", timestamp: Math.floor(Date.now() / 1000), type: "payment", content: { credit: mode !== "signed"
          ? { mandate: true, credit_id: "held-credit", draw_id: "accepted-draw", payment_id: "mandate:x", request_seq: 4, amount_micro: 1500, currency: "usd" } : lastAuth } });
        if (terminal) msgs.push({ seq: 6, from: "provider", timestamp: Math.floor(Date.now() / 1000), type: "complete", content: { status: "success", summary: "Done" } });
        if (stopped) msgs.push({ seq: 6, from: "provider", timestamp: Math.floor(Date.now() / 1000), type: "cancel", content: { reason: "Declined" } });
        response.end(JSON.stringify({ messages: msgs })); return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.type === "decline") {
        declines++; stopped = true;
        response.statusCode = 201; response.end('{"seq":6}'); return;
      }
      posts++;
      lastAuth = body.content.credit;
      if (phase === "drop" && mode === "mandate") { response.statusCode = 409; response.end('{"error":"credit_payment_ask_mismatch"}'); phase = "echo"; return; }
      if (phase === "drop") { response.destroy(); return; }
      response.statusCode = 201; response.end('{"seq":5}');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  rmSync(JOBS_FILE, { force: true });
  rmSync(join(process.env.DVM_CONFIG_DIR!, "messages"), { recursive: true, force: true });
  writeFileSync(CREDITS_FILE, JSON.stringify({ credits: [{ endpoint, callerPubkey: pubkey, creditId: "held-credit",
    currency: "usd", balanceMicro: 10000, remainingMicro: 10000, targetMicro: 10000,
    expiryMs: Date.now() + 86400000, status: "active", ledgerSeq: 1 }], implicitCredits: [], pendingFundings: [] }));
  saveJob({ id: "job-a", endpoint, status: "processing", submittedAt: Date.now(), policy, jobToken: token,
    creditBinding: { creditId: "held-credit", drawId: "accepted-draw", callerPubkey: pubkey },
    mandate: { max_total_micro: 4000, max_ask_micro: 2000, expires_at_ms: Date.now() + 600_000,
      credit_id: "held-credit", draw_id: "accepted-draw", currency: "usd", signed_data: {} },
    mandateAskObservedAtMs: { 4: Date.now() - 90_000 } });
});
afterEach(async () => {
  delete process.env.DVM_IDENTITY_KEY;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

it.each(["signed", "mandate", "mandate-lost"] as const)("recovers a saved signed fallback when %s payment won, without stalling or double booking", async (winner) => {
  mode = winner;
  await expect(handlePaymentRequest("job-a", ask, policy, new HttpsTransport(), { endpoint }, { requestSeq: 4 })).rejects.toBeInstanceOf(Error);
  if (winner === "mandate") expect(loadJob("job-a")?.pendingCreditPayment).toBeUndefined();
  else expect(loadJob("job-a")?.pendingCreditPayment).toBeDefined();
  expect(posts).toBe(1);
  phase = "echo";
  for (let round = 0; round < 2; round++) {
    const transport = new HttpsTransport();
    try {
      const result = await streamLoop({ jobId: "job-a", transport, provider: { endpoint }, policy, afterSeq: 0, jobToken: token, timeoutMs: 2000 });
      expect(result.nextAction?.type).toBe("poll");
    } finally { transport.close(); }
    expect(loadJob("job-a")?.pendingCreditPayment).toBeUndefined();
    expect(loadJob("job-a")).toMatchObject({ paymentsHonoured: 1, totalPaidMsats: 1500 });
  }
  expect(posts).toBe(winner === "signed" ? 2 : 1);
});

it("describes provider mandate settlement without claiming the CLI sent a payment", async () => {
  const { updateJob } = await import("../src/lib/job-store");
  updateJob("job-a", { mandateAskObservedAtMs: {} });
  const transport = new HttpsTransport();
  const result = await streamLoop({ jobId: "job-a", transport, provider: { endpoint }, policy, afterSeq: 0, jobToken: token, timeoutMs: 2000 });
  transport.close();
  expect(result.nextAction).toMatchObject({ type: "poll", display: expect.stringContaining("standing limit"),
    hint: expect.stringContaining("Nothing has been sent") });
  expect(result.nextAction?.hint).not.toContain("unconfirmed");
  expect(posts).toBe(0);
});

it("status expects the standing limit to cover an open ask while the settlement window is open", async () => {
  const { updateJob } = await import("../src/lib/job-store");
  const { status } = await import("../src/commands/status");
  const { json } = await import("../src/lib/output");
  updateJob("job-a", { mandateAskObservedAtMs: {} });
  await status("job-a", {});
  expect(vi.mocked(json).mock.calls.at(-1)?.[0]).toMatchObject({ next_action: {
    type: "poll", display: expect.stringContaining("standing limit"), hint: expect.stringContaining("Nothing has been sent"),
  } });
  expect(posts).toBe(0);
});


it("keeps polling when the provider moves past the ask between history and status reads", async () => {
  moveDuringStatus = true;
  const transport = new HttpsTransport();
  const result = await streamLoop({ jobId: "job-a", transport, provider: { endpoint }, policy, afterSeq: 0, jobToken: token });
  transport.close();
  expect(result.nextAction).toMatchObject({ type: "poll", display: expect.stringContaining("no payment was sent") });
  expect(result.cursor).toBe(3);
  expect(posts).toBe(0);
});

it.each([true, false])("declines a later ask after a recorded stop even with an attached policy: %s", async (attachedPolicy) => {
  const { updateJob } = await import("../src/lib/job-store");
  updateJob("job-a", { stopRequested: true, stopRequestedDisplay: "Stop recorded. Decline the next open payment ask to stop the job." });
  const transport = new HttpsTransport();
  const options = { jobId: "job-a", transport, provider: { endpoint }, afterSeq: 0, jobToken: token,
    ...(attachedPolicy ? { policy } : {}) };
  await streamLoop(options);
  const result = await streamLoop(options);
  transport.close();
  expect(result.nextAction).toBeNull();
  expect(loadJob("job-a")).toMatchObject({ status: "cancelled", callerDeclined: true, stopRequested: true });
  expect(posts).toBe(0);
  expect(declines).toBe(1);
});


it("books the original signed payment if the job ends before the lost-response wait reconnects", async () => {
  await expect(handlePaymentRequest("job-a", ask, policy, new HttpsTransport(), { endpoint }, { requestSeq: 4 })).rejects.toBeInstanceOf(Error);
  phase = "echo"; terminal = true;
  const { waitForJob } = await import("../src/lib/wait-for-job");
  const transport = new HttpsTransport();
  const result = await waitForJob({ jobId: "job-a", transport, provider: { endpoint }, policy, afterSeq: 0, jobToken: token }, 2000);
  transport.close();
  expect(result.nextAction).toBeNull();
  expect(loadJob("job-a")).toMatchObject({ paymentsHonoured: 1, totalPaidMsats: 1500 });
  expect(loadJob("job-a")?.pendingCreditPayment).toBeUndefined();
  expect(posts).toBe(1);
});


it.each(["processing", "completed", "failed", "cancelled"].flatMap((state) =>
  [false, true].map((overcharged) => ({ state, overcharged }))))("status keeps stop and overcharge messages faithful ($state, overcharge: $overcharged)", async ({ state, overcharged }) => {
  const { updateJob } = await import("../src/lib/job-store");
  const { status } = await import("../src/commands/status");
  const { json, info } = await import("../src/lib/output");
  const stopDisplay = "The job will stop at its next payment ask. Only finished pieces will be charged.";
  reportedStatus = state; phase = "echo"; mode = "mandate";
  updateJob("job-a", { stopRequested: true, stopRequestedDisplay: stopDisplay,
    mandate: { ...loadJob("job-a")!.mandate!, max_ask_micro: overcharged ? 1000 : 2000 } });
  const ended = state !== "processing";
  // Terminal snapshots must relay the same result as the initial provider read.
  for (let read = 0; read < 2; read++) {
    await status("job-a", {});
    const output = vi.mocked(json).mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(output).toMatchObject({ status: state, source: ended && read === 1 ? "local" : "provider" });
    expect(output.overcharged).toBe(overcharged ? true : undefined);
    if (ended) {
      expect(output.stop_requested).toBeUndefined();
      expect(output.stop_display).toBeUndefined();
      expect(output.display ?? "").not.toContain(stopDisplay);
    } else {
      expect(output).toMatchObject({ stop_requested: true, stop_display: stopDisplay });
      if (!overcharged) expect(output.display).toBe(stopDisplay);
    }
    if (overcharged) expect(output.display).toContain("Provider overcharge");
  }
  vi.mocked(info).mockClear();
  await status("job-a", { human: true });
  const human = vi.mocked(info).mock.calls.map(([line]) => line).join("\n");
  if (ended) expect(human).not.toContain(stopDisplay);
  else expect(human).toContain(stopDisplay);
  if (overcharged) expect(human).toContain("Provider overcharge");
  expect(posts).toBe(0);
});
