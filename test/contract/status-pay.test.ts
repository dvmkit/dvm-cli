import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const binary = process.env.DVM_CLI_TEST_BINARY ?? resolve(import.meta.dirname, "../../dist/dvm.js");
let root: string;
let server: Server;
let endpoint: string;
let state: string;
let history: unknown[];
let posts: number;
let creditReply: "accepted" | "refused" | undefined;
let paymentBodies: Array<{ type: string; content: unknown }>;
const token = "ab".repeat(32);
const ask = { seq: 5, from: "provider", timestamp: 1700000000, type: "payment-request",
  content: { amount_msats: 1500, reason: "Additional work", mints: ["https://mint.example"] } };

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "status-pay-"));
  state = "awaiting-input";
  history = [ask];
  posts = 0;
  creditReply = undefined;
  paymentBodies = [];
  server = createServer((request, response) => {
    expect(request.headers["x-job-token"]).toBe(token);
    response.setHeader("content-type", "application/json");
    if (request.method === "POST") posts++;
    if (request.method === "POST" && creditReply) {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        paymentBodies.push(JSON.parse(body));
        if (creditReply === "refused") {
          response.statusCode = 402;
          response.end(JSON.stringify({ error: "insufficient_credit", remaining_micro: 1000, shortfall_micro: 500 }));
        } else {
          state = "completed";
          history = [{ seq: 7, from: "provider", timestamp: 1700000002, type: "complete", content: { status: "success", summary: "Done" } }];
          response.statusCode = 201;
          response.end(JSON.stringify({ seq: 6 }));
        }
      });
      return;
    }
    response.end(JSON.stringify(request.url?.includes("/messages") ? { messages: history } : { status: state }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  writeFileSync(join(root, "jobs.json"), JSON.stringify([{ id: "job", endpoint, jobToken: token,
    status: "processing", messageCursor: 4, submittedAt: 1,
    policy: { maxTotalMsats: 10000, maxIncrementMsats: 10000, autoPayBelowMsats: 0, maxPayments: 2 } }]));
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(root, { recursive: true, force: true });
});
function run(command: string, flags: string[] = []) {
  return new Promise<{ code: number; output: { error?: { code: string }; [key: string]: unknown } }>((done) => {
    execFile(process.execPath, [binary, command, "job", ...flags], {
      env: Object.fromEntries(Object.entries({ ...process.env, DVM_CONFIG_DIR: root }).filter(([key]) => !["DVM_JOB_ENDPOINT", "DVM_JOB_TOKEN", "DVM_IDENTITY_KEY"].includes(key))), timeout: 15000,
    }, (error, stdout) => done({ code: error ? 1 : 0, output: JSON.parse(stdout) }));
  });
}
it("ordinary status then pay reaches the wallet guard and leaves unread messages available", async () => {
  for (let i = 0; i < 2; i++) expect((await run("status")).output).toMatchObject({ next_action: { type: "pay", amount_msats: 1500 } });
  expect(JSON.parse(readFileSync(join(root, "jobs.json"), "utf8"))[0].messageCursor).toBe(4);
  expect((await run("pay")).output).toMatchObject({ error: { code: "payment_failed" } });
  const messages = await run("messages", ["--no-stream"]);
  expect(messages.output).toMatchObject({ messages: [{ seq: 5, type: "payment-request", content: { amount_msats: 1500, mints: ["https://mint.example"] } }], cursor: 5 });
  expect(posts).toBe(0);
});
it.each(["paid", "expired", "completed", "cancelled", "working", "unavailable"])("does not debit a %s request discovered by status", async (change) => {
  expect((await run("status")).output).toMatchObject({ next_action: { type: "pay" } });
  if (change === "paid") history.push({ seq: 6, from: "requester", timestamp: 1700000001, type: "payment", content: { amount_msats: 1500 } });
  if (change === "expired") history = [{ ...ask, content: { ...ask.content, expires_at_ms: 1 } }];
  if (change === "completed" || change === "cancelled") state = change;
  if (change === "working") history.push({ seq: 6, from: "provider", timestamp: 1700000001, type: "working", content: {} });
  if (change === "unavailable") { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
  const result = await run("pay");
  expect(result.code).toBe(1);
  expect(result.output.error?.code).toBe(change === "unavailable" ? "internal" : "no_payment_pending");
  expect(posts).toBe(0);
});
it("refuses a foreign endpoint before sending the stored bearer credential", async () => {
  const before = readFileSync(join(root, "jobs.json"), "utf8");
  expect((await run("pay", ["--endpoint", "http://127.0.0.1:1"])).output).toMatchObject({ error: { code: "job_token_required" } });
  expect(readFileSync(join(root, "jobs.json"), "utf8")).toBe(before);
  expect(posts).toBe(0);
});

it.each([
  { inactive: "expired", confirmed: true }, { inactive: "terminal", confirmed: true },
  { inactive: "expired", confirmed: false }, { inactive: "terminal", confirmed: false },
])("reconciles $inactive uncertain payments (confirmed=$confirmed) without a replacement debit", async ({ inactive, confirmed }) => {
  const request = inactive === "expired" ? { ...ask, content: { ...ask.content, expires_at_ms: 1 } } : ask;
  const jobs = JSON.parse(readFileSync(join(root, "jobs.json"), "utf8"));
  jobs[0].inFlightPaymentRequestSeqs = [5];
  jobs[0].inFlightPaymentRequestStartedAtMs = { 5: Date.now() - 46000 };
  if (inactive === "terminal") jobs[0].status = "completed";
  writeFileSync(join(root, "jobs.json"), JSON.stringify(jobs));
  mkdirSync(join(root, "messages"));
  const localHistory = [request, ...(inactive === "terminal" ? [{ seq: 6, from: "provider", timestamp: 1700000001,
    type: "working", content: {} }] : [])];
  writeFileSync(join(root, "messages/job.jsonl"), localHistory.map((message) => JSON.stringify(message)).join("\n") + "\n");
  history = [request, ...(confirmed ? [{ seq: 6, from: "requester", timestamp: 1700000001,
    type: "payment", content: { amount_msats: 1500 } }] : [])];
  expect((await run("pay")).output).toMatchObject({ error: { code: "no_payment_pending" } });
  const saved = JSON.parse(readFileSync(join(root, "jobs.json"), "utf8"))[0];
  expect(saved.paidPaymentRequestSeqs).toEqual(confirmed ? [5] : undefined);
  expect(saved.inFlightPaymentRequestSeqs).toEqual(confirmed ? undefined : [5]);
  expect(posts).toBe(0);
});

it.each([
  { inactive: "expired", accepted: true }, { inactive: "terminal", accepted: true }, { inactive: "satisfied", accepted: true }, { inactive: "remote-terminal", accepted: true },
  { inactive: "expired", accepted: false }, { inactive: "terminal", accepted: false }, { inactive: "satisfied", accepted: false }, { inactive: "remote-terminal", accepted: false },
])("recovers saved $inactive credit intent without replacement funding (accepted=$accepted)", async ({ inactive, accepted }) => {
  const request = { ...ask.content, credit: { amount_micro: 1500, currency: "usd" },
    ...(inactive === "expired" ? { expires_at_ms: 1 } : {}) };
  const authorization = { credit_id: "held-credit", draw_id: "accepted-draw", payment_id: "original-payment",
    request_seq: 5, amount_micro: 1500, currency: "usd", timestamp: Math.floor(Date.now() / 1000),
    pubkey: "cd".repeat(32), signature: "ab".repeat(64),
    auth_statement: { audience: { dvm_id: "example-provider", builder_pubkey: "cd".repeat(32) },
      method: "POST", path: "/v1/job/job/messages", capability: null } };
  const jobs = JSON.parse(readFileSync(join(root, "jobs.json"), "utf8"));
  jobs[0].pendingCreditPayment = { request, authorization, amountMsats: 1500, approval: "explicit" };
  if (inactive === "terminal") jobs[0].status = "completed";
  writeFileSync(join(root, "jobs.json"), JSON.stringify(jobs));
  history = [{ ...ask, content: request }, ...(inactive === "satisfied" ? [{ seq: 6, from: "requester", timestamp: 1700000001,
    type: "payment", content: { credit: authorization } }] : [])];
  if (inactive === "remote-terminal") state = "completed";
  creditReply = accepted ? "accepted" : "refused";
  const result = await run("pay");
  expect(result.code).toBe(accepted ? 0 : 1);
  if (accepted) expect(result.output).toMatchObject({ paid: { rail: "credit", msats: 1500 }, next_action: null });
  else expect(result.output).toMatchObject({ error: { code: "credit_payment_retry_required" } });
  expect(paymentBodies).toEqual([{ type: "payment", content: { credit: authorization } }]);
  expect(posts).toBe(1);
  const saved = JSON.parse(readFileSync(join(root, "jobs.json"), "utf8"))[0];
  expect(saved.pendingCreditPayment).toBeUndefined();
  expect(saved.paymentsHonoured).toBe(accepted ? 1 : undefined);
  if (!accepted) {
    expect((await run("pay")).output).toMatchObject({ error: { code: "no_payment_pending" } });
    expect(posts).toBe(1);
  }
});
