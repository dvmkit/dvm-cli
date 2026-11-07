import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { computeResultHash, type JsonValue, type JobReceipt, type Message } from "@dvmkit/sdk/internal";
import { attestedDvm, unsignedReceipt } from "../../src/lib/__tests__/fixtures/receipt-fixture";

const binary = process.env.DVM_CLI_TEST_BINARY ?? resolve(import.meta.dirname, "../../dist/dvm.js");
const token = "ab".repeat(32);
const dvm = attestedDvm();
// The upfront payment bought the first piece ($0.16); the first ask's payment
// bought the second ($0.20). The second ask ($0.30) is open.
const UPFRONT = 160_000;
const askOne = { seq: 1, from: "provider", timestamp: 1, type: "payment-request", content: {
  amount_msats: 200_000, reason: "Second block", fiat_amount: { amount: 0.2, currency: "usd" },
  credit: { amount_micro: 200_000, currency: "usd" }, charged_if_declined_micro: 160_000 } };
const payOne = { seq: 2, from: "requester", timestamp: 2, type: "payment", content: { credit: {
  credit_id: "credit", draw_id: "draw", payment_id: "pay-1", request_seq: 1, amount_micro: 200_000, currency: "usd" } } };
const askTwo = (expiresAtMs: number) => ({ seq: 3, from: "provider", timestamp: 3, type: "payment-request", content: {
  amount_msats: 300_000, reason: "Third block", fiat_amount: { amount: 0.3, currency: "usd" },
  credit: { amount_micro: 300_000, currency: "usd" }, charged_if_declined_micro: 360_000, expires_at_ms: expiresAtMs } });

type Mode = "piece" | "legacy";
let root: string;
let server: Server;
let endpoint: string;
let mode: Mode;
let state: string;
let history: Message[];
let receipt: JobReceipt | undefined;
let endingReceipt: (kind: "decline" | "cancel") => JobReceipt | undefined;
let declineReply: "ends" | "no_open_ask" | "ignored" | "unavailable";
let cancelConflicts: number;
let requests: { method: string; path: string; body?: { type?: string; content?: unknown } }[];

function settled(outcome: "cancelled" | "failed", charged: number, pieces: { amount: number; charged: number; paid_seq: number; state: string }[]) {
  const held = UPFRONT + 200_000;
  return dvm.sign({ job_id: "job", outcome, ended_by: "caller", reason: "Job ended",
    paid: { ...unsignedReceipt().paid, msats: held, rail: null, mint: null },
    ...(mode === "piece" ? { settlement: { held: Math.max(held, charged), charged, released: Math.max(held, charged) - charged,
      pieces: pieces as never } } : {}) });
}

function strip<T extends { content: Record<string, unknown> }>(message: T): T {
  if (mode === "piece") return message;
  const { charged_if_declined_micro: _ignored, ...content } = message.content;
  return { ...message, content };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "piece-charging-"));
  mode = "piece";
  state = "awaiting-input";
  history = [];
  receipt = undefined;
  declineReply = "ends";
  cancelConflicts = 0;
  requests = [];
  endingReceipt = (kind) => kind === "decline"
    ? settled("cancelled", 360_000, [
      { amount: UPFRONT, charged: UPFRONT, paid_seq: 0, state: "finished" },
      { amount: 200_000, charged: 200_000, paid_seq: 2, state: "finished" }])
    : settled("cancelled", 360_000, [
      { amount: UPFRONT, charged: UPFRONT, paid_seq: 0, state: "finished" },
      { amount: 200_000, charged: 200_000, paid_seq: 2, state: "stopped" }]);
  server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      if (request.url === "/v1/info") {
        requests.push({ method: request.method!, path: "/v1/info" });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ protocol_version: 1, name: "Piece provider", capabilities: {},
          credit: { currency: "usd", funding: ["lightning"], min_micro: 100_000, max_micro: 5_000_000, ttl_ms: 86_400_000 } }));
        return;
      }
      expect(request.headers["x-job-token"]).toBe(token);
      const path = new URL(request.url!, "http://provider.invalid").pathname;
      const body = text ? JSON.parse(text) : undefined;
      requests.push({ method: request.method!, path, body });
      response.setHeader("content-type", "application/json");
      const finished = ["completed", "failed", "cancelled"].includes(state);
      if (request.method === "GET" && path === "/v1/job/job/messages") {
        response.end(JSON.stringify({ messages: history }));
      } else if (request.method === "GET" && path === "/v1/job/job") {
        response.end(JSON.stringify({ jobId: "job", status: state, ...(finished && receipt ? { receipt } : {}) }));
      } else if (request.method === "POST" && path === "/v1/job/job/messages" && body.type === "decline") {
        if (declineReply === "unavailable") {
          response.statusCode = 409;
          response.end(JSON.stringify({ error: "decline_unavailable", message: "This job store cannot end a job at a decline." }));
          return;
        }
        if (declineReply === "no_open_ask") {
          response.statusCode = 409;
          response.end(JSON.stringify({ error: "no_open_ask", message: "The job has no open payment request or prompt to decline.",
            hint: "Decline answers an open ask." }));
          return;
        }
        history.push({ seq: history.length + 1, from: "requester", timestamp: 9, type: "decline", content: body.content } as Message);
        if (declineReply === "ends") {
          state = "cancelled";
          receipt = endingReceipt("decline");
        }
        response.statusCode = 201;
        response.end(JSON.stringify({ seq: history.length }));
      } else if (request.method === "DELETE" && path === "/v1/job/job") {
        if (cancelConflicts > 0) {
          cancelConflicts--;
          response.statusCode = 409;
          response.setHeader("retry-after", "1");
          response.end(JSON.stringify({ error: "payment_in_progress", retryable: true,
            message: "A payment for this job is being verified, and the job cannot end until its outcome is recorded." }));
          return;
        }
        state = "cancelled";
        receipt = endingReceipt("cancel");
        response.end(JSON.stringify({ status: "cancelled" }));
      } else {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: `unexpected ${request.method} ${path}` }));
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(root, { recursive: true, force: true });
});

function seed(status: string, messages: unknown[], record: Record<string, unknown> = {}) {
  writeFileSync(join(root, "jobs.json"), JSON.stringify([{ id: "job", endpoint, jobToken: token, status, submittedAt: 1,
    messageCursor: 0, builderAnchor: dvm.anchor, receiptsSupported: true, paymentMethod: "credit", upfrontCreditBooked: true,
    upfrontPayment: { amount_msats: UPFRONT, amount_micro: UPFRONT, currency: "usd", credit_id: "credit", draw_id: "draw" },
    totalPaidMsats: UPFRONT + 200_000, paymentsHonoured: 2,
    policy: { maxTotalMsats: 10_000_000, maxIncrementMsats: 10_000_000, autoPayBelowMsats: 1000, maxPayments: 10 }, ...record }]));
  mkdirSync(join(root, "messages"), { recursive: true });
  writeFileSync(join(root, "messages/job.jsonl"), messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
}

function run(command: string | string[], flags: string[] = []) {
  return new Promise<{ code: number; stderr: string; output: Record<string, any> }>((done) => {
    execFile(process.execPath, [binary, ...(typeof command === "string" ? [command] : command), "job", ...flags], {
      env: Object.fromEntries(Object.entries({ ...process.env, DVM_CONFIG_DIR: root })
        .filter(([key]) => !["DVM_JOB_ENDPOINT", "DVM_JOB_TOKEN", "DVM_IDENTITY_KEY"].includes(key))),
      timeout: 20_000,
    }, (error, stdout, stderr) => done({ code: error ? 1 : 0, stderr, output: stdout.trim() ? JSON.parse(stdout) : {} }));
  });
}

const sentPayments = () => requests.filter((entry) => entry.method === "POST" && entry.body?.type === "payment");

it.each(["piece", "legacy"] as const)("returns an ask above the auto-pay limit to the agent unpaid (%s DVM)", async (dvmMode) => {
  mode = dvmMode;
  const expires = Date.now() + 2 * 3_600_000;
  history = [strip(askOne), payOne, strip(askTwo(expires))] as Message[];
  seed("awaiting-input", [strip(askOne), payOne]);
  const result = await run("messages");
  expect(result.code).toBe(0);
  expect(sentPayments()).toEqual([]);
  const action = result.output.next_action;
  expect(action).toMatchObject({ type: "pay", job_id: "job", amount_msats: 300_000,
    fiat_amount: { amount: 0.3, currency: "usd" }, expires_at_ms: expires });
  expect(action.display).toMatch(/^\$0\.30 USD \(300 sats\) — comparable to a ChatGPT query\./);
  expect(action.display).toMatch(/Pay by \d{4}-\d\d-\d\d \d\d:\d\d UTC \(in (1 h \d+ min|2 h)\), or the provider cancels the job\.$/);
  if (dvmMode === "piece") {
    expect(action).toMatchObject({ credit: { amount_micro: 300_000, currency: "usd" }, charged_if_declined_micro: 360_000,
      _provider_fields: expect.arrayContaining(["fiat_amount", "credit", "charged_if_declined_micro"]) });
    expect(action.display).toContain("Declining ends the job and charges $0.36 USD for the work already finished.");
    expect(action.hint).toContain("If your human does not approve, run `dvm decline job`");
  } else {
    expect(Object.keys(action).sort()).toEqual(["_provider_fields", "amount_msats", "display", "expires_at_ms",
      "fiat_amount", "hint", "job_id", "reason", "type"]);
    expect(action._provider_fields).toEqual(["fiat_amount", "job_id"]);
    expect(`${action.display} ${action.hint}`).not.toMatch(/[Dd]ecline/);
  }
  const human = await run("messages", ["--no-stream", "--human"]);
  expect(human.stderr).toContain(dvmMode === "piece" ? "To stop instead, run `dvm decline job`." : "Run `dvm pay job`.");
  if (dvmMode === "legacy") expect(human.stderr).not.toContain("decline");
});

it("declines the open ask, ends the job and reports the finished pieces charged", async () => {
  history = [askOne, payOne, askTwo(Date.now() + 3_600_000)] as Message[];
  seed("awaiting-input", history);
  const result = await run("decline", ["--reason", "Over budget"]);
  expect(result.code).toBe(0);
  expect(requests.filter((entry) => entry.method === "POST")).toEqual([
    { method: "POST", path: "/v1/job/job/messages", body: { type: "decline", content: { reason: "Over budget" } } }]);
  expect(result.output).toMatchObject({ jobId: "job", status: "cancelled", declined: true, reason: "Over budget", next_action: null,
    settlement: { status: "settled", evidence: "receipt", held_micro: 360_000, charged_micro: 360_000, released_micro: 0,
      currency: "usd", ceiling_micro: 360_000, overcharged: false } });
  expect(result.output.display).toBe("Declined; the job has ended. Charged $0.36 USD of $0.36 USD held, $0.00 USD released.");
  expect(JSON.parse(readFileSync(join(root, "jobs.json"), "utf8"))[0]).toMatchObject({
    status: "cancelled", callerCancelled: true, callerDeclined: true, completion: { message: "Over budget" } });

  const status = await run("status");
  expect(status.output.receipt_verified).toBe("verified");
  expect(status.output.spend.display).toContain("Charged $0.36 USD of $0.36 USD held, $0.00 USD released.");
  const messages = await run("messages", ["--no-stream"]);
  expect(messages.output.next_action).toBeNull();
  expect(sentPayments()).toEqual([]);
});

// Seven CLI startups share this deadline; run() also bounds each process separately.
it.each(["payment-request", "prompt"])("retrieves and verifies finished artifacts after declining a %s", async (type) => {
  const contents = [{ name: "first.txt", data: "First piece" }, { name: "second.txt", data: "Second piece" }];
  history = [askOne, payOne,
    ...contents.map((content, index) => ({ seq: index + 3, from: "provider", timestamp: index + 3, type: "artifact", content })),
    type === "prompt"
      ? { seq: 5, from: "provider", timestamp: 5, type: "prompt", content: { id: "continue", text: "Continue?" } }
      : { ...askTwo(Date.now() + 3_600_000), seq: 5 },
  ] as Message[];
  seed("awaiting-input", [askOne, payOne], { messageCursor: 2 });
  const makeReceipt = endingReceipt;
  endingReceipt = (kind) => {
    const { signature: _signature, ...unsigned } = makeReceipt(kind)!;
    return dvm.sign({ ...unsigned, result_hash: computeResultHash(undefined, contents as JsonValue[]) });
  };

  const declined = await run("decline");
  expect(declined.code).toBe(0);
  expect(declined.output).toMatchObject({ status: "cancelled", declined: true,
    has_artifacts: true, artifact_count: 2, payload_in: "messages", next_action: null,
    next_step_hint: "Run 'dvm messages job --no-stream' to fetch the artifacts." });
  expect(declined.output.display).toContain("2 artifacts");
  expect(JSON.parse(readFileSync(join(root, "jobs.json"), "utf8"))[0].messageCursor).toBe(2);
  const reads = requests.length;
  const replay = await run("status");
  expect(replay.output).toMatchObject({ source: "local", artifact_count: 2, payload_in: "messages" });
  expect(requests).toHaveLength(reads);
  const unchecked = await run(["receipts", "verify"]);
  expect(unchecked.output.receipt_checks.result_hash).toBe("unchecked");

  const fetched = await run("messages", ["--no-stream"]);
  expect(fetched.code).toBe(0);
  expect(fetched.output.messages.filter((message: Message) => message.type === "artifact")).toHaveLength(2);
  const verified = await run(["receipts", "verify"]);
  expect(verified.code).toBe(0);
  expect(verified.output.receipt_checks.result_hash).toBe("ok");

  const logPath = join(root, "messages/job.jsonl");
  const log = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const first = log.find((message: Message) => message.type === "artifact");
  if (!first) throw new Error("Fetched artifact missing from local log");
  first.content.data = "Altered piece";
  writeFileSync(logPath, log.map((message) => JSON.stringify(message)).join("\n") + "\n");
  const mismatch = await run(["receipts", "verify"]);
  expect(mismatch.output.receipt_checks.result_hash).toBe("mismatch");

  writeFileSync(logPath, log.filter((message: Message) => message.seq !== first.seq)
    .map((message) => JSON.stringify(message)).join("\n") + "\n");
  const incomplete = await run(["receipts", "verify"]);
  expect(incomplete.output.receipt_checks.result_hash).toBe("unchecked");
}, 30_000);

it("explains a decline with nothing open, and one an older DVM ignores", async () => {
  history = [askOne, payOne] as Message[];
  seed("processing", history);
  declineReply = "no_open_ask";
  const refused = await run("decline");
  expect(refused.code).toBe(1);
  expect(refused.output.error).toMatchObject({ code: "no_open_ask" });
  expect(refused.output.error.hint).toContain("`dvm cancel job`");
  expect(refused.output.error.hint).toContain("`dvm messages job --wait`");

});

it("keeps the ask payable after an older DVM ignores a decline", async () => {
  mode = "legacy";
  history = [strip(askOne), payOne, strip(askTwo(Date.now() + 3_600_000))] as Message[];
  seed("awaiting-input", history);
  declineReply = "ignored";
  const ignored = await run("decline");
  expect(ignored.code).toBe(1);
  expect(ignored.output.error).toMatchObject({ code: "decline_unsupported" });
  expect(ignored.output.error.hint).toContain("`dvm pay job`");
  expect(history.at(-1)).toMatchObject({ from: "requester", type: "decline" });

  const messages = await run("messages", ["--no-stream"]);
  expect(messages.code).toBe(0);
  expect(messages.output.next_action).toMatchObject({ type: "pay", amount_msats: 300_000 });
  expect(JSON.parse(readFileSync(join(root, "jobs.json"), "utf8"))[0]).toMatchObject({ status: "awaiting-input" });
  expect(JSON.parse(readFileSync(join(root, "jobs.json"), "utf8"))[0]).not.toHaveProperty("callerDeclined");

  const paid = await run("pay");
  // Past the pending-ask check: the payment reaches the wallet, which this test has none of.
  expect(paid.stderr).toContain("Paying $0.30 USD (300 sats)...");
  expect(paid.output.error).toMatchObject({ code: "payment_failed", anchor: "no_rail_matched" });
});

it("cancels at once, waits out a payment being verified, and names the work in progress charged", async () => {
  history = [askOne, payOne] as Message[];
  seed("processing", history);
  cancelConflicts = 1;
  const result = await run("cancel");
  expect(result.code).toBe(0);
  expect(requests.filter((entry) => entry.method === "DELETE")).toHaveLength(2);
  expect(result.output).toMatchObject({ status: "cancelled", next_action: null,
    settlement: { charged_micro: 360_000, stopped_micro: 200_000, overcharged: false } });
  expect(result.output.display).toBe("Stopped. The $0.20 USD paid for the work in progress is not refunded. " +
    "Charged $0.36 USD of $0.36 USD held, $0.00 USD released.");
  const human = await run("status", ["--human"]);
  expect(human.stderr).toContain("Charged $0.36 USD of $0.36 USD held, $0.00 USD released.");
});

it("explains a cancel's amounts when no local record names their currency", async () => {
  // No ask, payment, upfront record or local credit names the credit's currency.
  seed("processing", [], { upfrontPayment: undefined });
  endingReceipt = () => settled("cancelled", UPFRONT, [{ amount: UPFRONT, charged: UPFRONT, paid_seq: 0, state: "stopped" }]);
  const result = await run("cancel");
  expect(result.code).toBe(0);
  expect(result.output.display).toBe("Stopped. The 0.16 (currency not recorded) paid for the work in progress is not refunded. " +
    "Charged 0.16 (currency not recorded) of 0.36 (currency not recorded) held, 0.20 (currency not recorded) released.");
  expect(result.output.hint).toContain("does not name the currency");
  expect(result.output.hint).toContain(`dvm describe ${endpoint}`);
  const human = await run("status", ["--human"]);
  expect(human.stderr).toContain("Charged 0.16 (currency not recorded)");
  expect(human.stderr.split("does not name the currency")).toHaveLength(2);
  const listed = await run("messages");
  expect(listed.output.settlement_hint).toContain("does not name the currency");
  const humanMessages = await run("messages", ["--no-stream", "--human"]);
  expect(humanMessages.stderr).toContain("Charged 0.16 (currency not recorded)");
  expect(humanMessages.stderr).toContain("does not name the currency");
});

it("stops resending a cancel after its bounded attempts", async () => {
  history = [askOne, payOne] as Message[];
  seed("processing", history);
  cancelConflicts = 99;
  const started = Date.now();
  const result = await run("cancel");
  expect(result.code).toBe(1);
  expect(result.output.error).toMatchObject({ code: "payment_in_progress" });
  expect(requests.filter((entry) => entry.method === "DELETE")).toHaveLength(5);
  expect(Date.now() - started).toBeGreaterThanOrEqual(4000);
  expect(JSON.parse(readFileSync(join(root, "jobs.json"), "utf8"))[0].status).toBe("processing");
}, 30_000);

it("reports no artifacts on an older DVM's cancel and preserves its human output", async () => {
  mode = "legacy";
  history = [strip(askOne), payOne] as Message[];
  seed("processing", history);
  const result = await run("cancel");
  expect(result.code).toBe(0);
  expect(result.output).toEqual({ jobId: "job", status: "cancelled", has_artifacts: false,
    next_action: null, _provider_fields: ["jobId"] });
  const human = await run("cancel", ["--human"]);
  expect(human.stderr.trim().split("\n").at(-1)).toBe("Job job cancelled.");
});

it("flags a receipt charging more than the finished pieces this CLI paid for", async () => {
  // The open ask said declining would charge $0.16; the receipt's pieces match this CLI's log.
  const stated = askTwo(Date.now() + 3_600_000);
  history = [askOne, payOne, { ...stated, content: { ...stated.content, charged_if_declined_micro: 160_000 } }] as Message[];
  seed("awaiting-input", history);
  const result = await run("decline", ["--human"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("Warning: the signed receipt for job job charges $0.36 USD, more than the $0.16 USD of finished pieces this CLI paid for.");
  expect(result.stderr).toContain("This charge exceeds the finished pieces this CLI paid for (at most $0.16 USD).");
  const status = await run("status");
  expect(status.output.spend.settlement).toMatchObject({ charged_micro: 360_000, ceiling_micro: 160_000,
    ceiling_basis: "payments", overcharged: true });
  expect(status.output.spend.display).toContain("This charge exceeds the finished pieces this CLI paid for (at most $0.16 USD).");
});

it("flags a receipt charging for a piece this CLI never paid for", async () => {
  history = [askOne, payOne, askTwo(Date.now() + 3_600_000)] as Message[];
  seed("awaiting-input", history);
  endingReceipt = () => settled("cancelled", 660_000, [
    { amount: UPFRONT, charged: UPFRONT, paid_seq: 0, state: "finished" },
    { amount: 200_000, charged: 200_000, paid_seq: 2, state: "finished" },
    { amount: 300_000, charged: 300_000, paid_seq: 4, state: "finished" }]);
  const result = await run("decline", ["--human"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("Warning: the signed receipt for job job charges $0.66 USD, more than the $0.36 USD the job's last ask said stopping would cost.");
  const status = await run("status");
  expect(status.output.spend.settlement).toMatchObject({ charged_micro: 660_000, ceiling_micro: 360_000, overcharged: true });
  expect(status.output.spend.display).toContain("This charge exceeds");
});

it("does not flag an honest receipt whose payment never reached the local log", async () => {
  history = [askOne, payOne, askTwo(Date.now() + 3_600_000)] as Message[];
  // The send recorded the paid ask; only its echo in the message log was lost.
  seed("awaiting-input", [askOne], { paidPaymentRequestSeqs: [1] });
  const result = await run("decline", ["--human"]);
  expect(result.code).toBe(0);
  expect(result.stderr).not.toContain("Warning: the signed receipt");
  expect(result.stderr).not.toContain("This charge exceeds");
});

it("names a store that cannot decline without calling the live job ended", async () => {
  history = [askOne, payOne, askTwo(Date.now() + 3_600_000)] as Message[];
  seed("awaiting-input", history);
  declineReply = "unavailable";
  const result = await run("decline");
  expect(result.code).toBe(1);
  expect(result.output.error).toMatchObject({ code: "decline_unavailable" });
  expect(result.output.error.hint).toContain("`dvm pay job`");
  expect(result.output.error.hint).toContain("`dvm cancel job`");
  expect(JSON.parse(readFileSync(join(root, "jobs.json"), "utf8"))[0].status).toBe("awaiting-input");
});

it("says where the charge will show when a cancel's receipt is not signed yet", async () => {
  history = [askOne, payOne] as Message[];
  seed("processing", history);
  endingReceipt = () => undefined;
  const result = await run("cancel");
  expect(result.code).toBe(0);
  expect(result.output).toMatchObject({ status: "cancelled", next_action: null,
    display: "Stopped. Its receipt is not available yet; `dvm status job` shows what was charged once it is." });
  expect(result.output).not.toHaveProperty("settlement");
  const human = await run("cancel", ["--human"]);
  expect(human.stderr).toContain("Its receipt is not available yet");
});

it("states a portable job's charge in the provider's currency", async () => {
  history = [askOne, payOne] as Message[];
  const portable = ["--endpoint", endpoint, "--job-token", token];
  const cancelled = await run("cancel", portable);
  expect(cancelled.code).toBe(0);
  expect(cancelled.output.display).toBe("Stopped. The $0.20 USD paid for the work in progress is not refunded. " +
    "Charged $0.36 USD of $0.36 USD held, $0.00 USD released.");
  expect(cancelled.output.settlement).toMatchObject({ currency: "usd", charged_micro: 360_000 });
  expect(requests.some((entry) => entry.path === "/v1/info")).toBe(true);
  const status = await run("status", portable);
  expect(status.output.settlement).toMatchObject({ currency: "usd",
    display: "Charged $0.36 USD of $0.36 USD held, $0.00 USD released." });
  expect(status.output.receipt_display).toContain("Charged $0.36 USD for");
  expect(JSON.stringify(status.output)).not.toContain("micro-units");
});
