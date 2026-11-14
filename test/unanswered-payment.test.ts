import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Message } from "@dvmkit/sdk/internal";
import { status } from "../src/commands/status";
import { messages } from "../src/commands/messages";
import { loadJob, saveJob, updateJob } from "../src/lib/job-store";
import { appendMessages, loadMessages } from "../src/lib/messages";

const wire = vi.hoisted(() => ({ status: vi.fn(), getMessages: vi.fn(), stream: vi.fn(),
  sendMessage: vi.fn(), close: vi.fn(), json: vi.fn(), jsonEvent: vi.fn(), info: vi.fn() }));
vi.mock("../src/lib/transport", () => ({ createDvmTransport: () => wire }));
vi.mock("../src/lib/output", async (original) => ({
  ...await original<typeof import("../src/lib/output")>(), json: wire.json, jsonEvent: wire.jsonEvent, info: wire.info,
}));

const root = process.env.DVM_CONFIG_DIR!;
const jobId = "watch";
const endpoint = "https://provider.example";
const deadline = Date.parse("2030-01-01T01:30:00Z");
const ask: Message = { seq: 1, from: "provider", timestamp: deadline / 1000 - 1800, type: "payment-request",
  content: { amount_msats: 5000, reason: "Second hour", fiat_amount: { amount: 0.05, currency: "usd" }, expires_at_ms: deadline } };
const ended: Message = { seq: 2, from: "provider", timestamp: deadline / 1000 + 1, type: "cancel",
  content: { reason: "Job timed out (idle)" } };
let log: Message[];
const output = () => wire.json.mock.calls.at(-1)![0];
const reads = [
  { name: "status", run: (human = false) => status(jobId, { human }) },
  { name: "status --messages", run: (human = false) => status(jobId, { messages: true, human }) },
  { name: "messages --no-stream", run: (human = false) => messages(jobId, { stream: false, human }) },
  { name: "messages", run: (human = false) => messages(jobId, { human }) },
  { name: "messages --wait", run: (human = false) => messages(jobId, { wait: true, human }) },
];

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "config.json"), JSON.stringify({ credit: { posture: "off" }, feedback: { posture: "off" } }));
  saveJob({ id: jobId, endpoint, status: "processing", submittedAt: 1, messageCursor: 0,
    policy: { maxTotalMsats: 10000, autoPayBelowMsats: 5000, maxIncrementMsats: 5000, maxPayments: 2 } });
  log = [ask, ended];
  wire.getMessages.mockImplementation(async (_id: string, after: number) => log.filter((msg) => msg.seq > after));
  wire.stream.mockImplementation(async () => ({ messages: log, lastSeq: log.at(-1)?.seq }));
  wire.status.mockResolvedValue({ jobId, status: "cancelled", message: "Job timed out (idle)", hasArtifacts: false });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network access")));
});
afterEach(() => { vi.unstubAllGlobals(); });

it.each(reads)("$name explains an expired unanswered charge and retains provider evidence", async ({ run }) => {
  await run();
  expect(output().unanswered_payment_request).toMatchObject({ seq: 1, amount_msats: 5000,
    reason: { _source: "provider", text: "Second hour" }, fiat_amount: { amount: 0.05, currency: "usd" }, expires_at_ms: deadline });
  expect(output().unanswered_payment_request.display).toContain("stopped because payment ask #1 went unanswered");
  expect(output().unanswered_payment_request.display).toContain("Only charges paid before this ask were taken");
  expect(output().next_action).toBeNull();
  expect(wire.sendMessage).not.toHaveBeenCalled();
  if (output().message) expect(output().message).toBe("Job timed out (idle)");
  else if (output().messages) expect(output().messages.at(-1).content.reason.text).toBe("Job timed out (idle)");
  else expect(wire.jsonEvent.mock.calls.at(-1)![0].content.reason.text).toBe("Job timed out (idle)");
  expect(output().unanswered_payment_request._provider_fields).toContain("expires_at_ms");
  await run(true);
  expect(wire.info.mock.calls.flat().join("\n")).toContain("stopped because payment ask #1 went unanswered");
});

it("retains cancellation evidence for offline status without consuming messages", async () => {
  await status(jobId, {});
  expect(loadJob(jobId)?.messageCursor).toBe(0);
  expect(loadMessages(jobId)).toEqual([]);
  wire.status.mockRejectedValue(new Error("Offline"));
  wire.getMessages.mockRejectedValue(new Error("Offline"));
  await status(jobId, {});
  expect(output()).toMatchObject({ source: "local", message: "Job timed out (idle)",
    unanswered_payment_request: { seq: 1, expires_at_ms: deadline } });
});

it.each(reads)("$name qualifies expiry when cancellation shares the deadline's second", async ({ run }) => {
  log = [{ ...ask, content: { ...ask.content, expires_at_ms: deadline + 500 } },
    { ...ended, timestamp: deadline / 1000 }];
  await run();
  expect(output().unanswered_payment_request).toMatchObject({ seq: 1, expires_at_ms: deadline + 500 });
  expect(output().unanswered_payment_request.display).toContain("appears to have stopped because");
  expect(output().unanswered_payment_request.display).not.toMatch(/cancelled at|stopped at/);
  expect(output().unanswered_payment_request.display).toContain("one-second precision");
});

it.each(["no ask", "paid locally", "paid in history", "caller cancelled", "caller cancelled without ask", "declined", "not expired at cancellation", "missing deadline", "invalid deadline", "missing cancellation time", "unconfirmed payment", "blocked payment", "newer paid ask", "work resumed", "caller ending in history", "no cancellation event"])("does not infer an expired unanswered charge: %s", async (scenario) => {
  if (scenario === "no ask") log = [ended];
  if (scenario === "paid locally") updateJob(jobId, { paidPaymentRequestSeqs: [1] });
  if (scenario === "caller cancelled") updateJob(jobId, { callerCancelled: true });
  if (scenario === "caller cancelled without ask") {
    log = [ended];
    updateJob(jobId, { callerCancelled: true });
  }
  if (scenario === "declined") updateJob(jobId, { callerCancelled: true, callerDeclined: true });
  if (scenario === "not expired at cancellation") log = [ask, { ...ended, timestamp: deadline / 1000 - 1 }];
  if (scenario === "missing deadline" || scenario === "invalid deadline") log = [{ ...ask,
    content: { ...ask.content, expires_at_ms: scenario === "missing deadline" ? undefined : 1e300 } }, ended];
  if (scenario === "missing cancellation time") log = [ask, { ...ended, timestamp: Number.NaN }];
  if (scenario === "paid in history") log = [ask, { seq: 2, from: "requester", timestamp: 1, type: "payment", content: { amount_msats: 5000 } }, { ...ended, seq: 3 }];
  if (scenario === "unconfirmed payment") updateJob(jobId, { unconfirmedPaymentSubmissions: {
    1: { rail: "x402", content: {}, requestAmountMsats: 5000, amountMsats: 5000, btcRate: 100000 } } });
  if (scenario === "blocked payment") updateJob(jobId, { askPaymentBlocks: { 1: { reason: "credit_held" } } });
  if (scenario === "newer paid ask") {
    log = [ask, { ...ask, seq: 2 }, { ...ended, seq: 3 }];
    updateJob(jobId, { paidPaymentRequestSeqs: [2] });
  }
  if (scenario === "work resumed") log = [ask, { seq: 2, from: "provider", timestamp: 1,
    type: "working", content: {} }, { ...ended, seq: 3 }];
  if (scenario === "caller ending in history") log = [ask, { seq: 2, from: "requester", timestamp: 1,
    type: "decline", content: { reason: "Stop" } }, { ...ended, seq: 3 }];
  if (scenario === "no cancellation event") log = [ask];
  appendMessages(jobId, log);
  await status(jobId, {});
  expect(output()).not.toHaveProperty("unanswered_payment_request");
});

it("finds an expired ask before the current messages cursor", async () => {
  updateJob(jobId, { messageCursor: 1 });
  await messages(jobId, { stream: false });
  expect(output().messages.map((message: Message) => message.seq)).toEqual([2]);
  expect(output().unanswered_payment_request).toMatchObject({ seq: 1 });
  expect(loadJob(jobId)?.messageCursor).toBe(2);
  expect(loadMessages(jobId).map((message) => message.seq)).toEqual([2]);
});

it.each([false, true])("does not fetch unavailable content (retained expiry evidence: %s)", async (retained) => {
  if (retained) appendMessages(jobId, [ask, ended]);
  wire.status.mockResolvedValue({ jobId, status: "cancelled", content_available: false, hasArtifacts: false });
  await status(jobId, {});
  if (retained) expect(output().unanswered_payment_request).toMatchObject({ seq: 1 });
  else expect(output()).not.toHaveProperty("unanswered_payment_request");
  expect(wire.getMessages).not.toHaveBeenCalled();
});

it("withdraws cached expiry attribution when fresh history shows the ask was paid", async () => {
  log = [ask, { ...ended, seq: 3 }];
  await status(jobId, {});
  expect(output().unanswered_payment_request).toMatchObject({ seq: 1 });
  log = [ask, { seq: 2, from: "requester", timestamp: 1, type: "payment", content: { amount_msats: 5000 } },
    { ...ended, seq: 3 }];
  await status(jobId, { jobToken: "ab".repeat(32) });
  expect(output()).not.toHaveProperty("unanswered_payment_request");
  wire.status.mockRejectedValue(new Error("Offline"));
  wire.getMessages.mockRejectedValue(new Error("Offline"));
  await status(jobId, {});
  expect(output()).not.toHaveProperty("unanswered_payment_request");
});

it("reconciles a stored ask even without a saved spending policy", async () => {
  updateJob(jobId, { policy: undefined });
  appendMessages(jobId, [ask]);
  await status(jobId, {});
  expect(output().unanswered_payment_request).toMatchObject({ seq: 1 });
  expect(loadMessages(jobId).map((message) => message.seq)).toEqual([1]);
});

it("reads the ending when the stream yields at an ask before reporting cancellation", async () => {
  wire.stream.mockResolvedValue({ messages: [ask], lastSeq: 1 });
  await messages(jobId, {});
  expect(output().unanswered_payment_request).toMatchObject({ seq: 1 });
});

it("does not mix stored asks into an endpoint override", async () => {
  appendMessages(jobId, [ask, ended]);
  log = [ended];
  await status(jobId, { endpoint });
  expect(output()).not.toHaveProperty("unanswered_payment_request");
});
