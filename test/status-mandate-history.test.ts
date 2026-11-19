import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DvmError, MESSAGES_DIR, type Message } from "@dvmkit/sdk/internal";
import { beforeEach, expect, it, vi } from "vitest";
import { status } from "../src/commands/status";
import { loadJob, saveJob } from "../src/lib/job-store";
import { appendMessages } from "../src/lib/messages/index";

const wire = vi.hoisted(() => ({
  status: vi.fn(), getMessages: vi.fn(), close: vi.fn(), json: vi.fn(),
}));
vi.mock("../src/lib/transport", () => ({ createDvmTransport: () => wire }));
vi.mock("../src/lib/output", async (original) => ({
  ...await original<typeof import("../src/lib/output")>(), json: wire.json,
}));

const jobId = "watch";
const root = process.env.DVM_CONFIG_DIR!;
const endpoint = "https://provider.example";
const timestamp = 1_700_000_000;
const deadline = Date.parse("2030-01-01T00:00:00Z");
const mandate = {
  credit_id: "credit", draw_id: "draw", currency: "usd", max_ask_micro: 150_000,
  max_total_micro: 500_000, expires_at_ms: deadline, signed_data: {},
};
const ask = (seq: number): Message => ({ seq, from: "provider", timestamp, type: "payment-request",
  content: { reason: "Next observation", amount_msats: 8000, expires_at_ms: deadline,
    credit: { amount_micro: 80_000, currency: "usd" } } });
const payment = (seq: number, requestSeq: number): Message => ({ seq, from: "requester", timestamp, type: "payment",
  content: { credit: { mandate: true, credit_id: "credit", draw_id: "draw", currency: "usd",
    request_seq: requestSeq, amount_micro: 80_000, payment_id: `mandate:${requestSeq}` } } });
const artifact = (seq: number, data = "dGVzdA=="): Message => ({ seq, from: "provider", timestamp, type: "artifact",
  content: { name: `frame-${seq}.jpg`, data } });

let history: Message[];
const output = () => wire.json.mock.lastCall?.[0];
const messageReads = () => wire.getMessages.mock.calls
  .filter(([, , , options]) => options.beforeSeq === undefined).map(([id, after]) => [id, after]);
const gapReads = () => wire.getMessages.mock.calls
  .filter(([, , , options]) => options.beforeSeq !== undefined).map(([id, after, , options]) => [id, after, options.beforeSeq]);

function seed(id: string, messageCursor: number, cache: Message[] = []) {
  saveJob({ id, endpoint, submittedAt: 1, status: "processing", messageCursor, mandate });
  appendMessages(id, cache);
}

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "config.json"), JSON.stringify({ credit: { posture: "off" }, feedback: { posture: "off" } }));
  history = [];
  wire.status.mockImplementation(async (id: string) => ({ jobId: id, status: "processing", content_available: true }));
  wire.getMessages.mockImplementation(async (_id: string, after: number, _provider, { beforeSeq = Infinity } = {}) =>
    history.filter((message) => message.seq > after && message.seq < beforeSeq));
});

it("bounds reads at a permanent gap after an open prompt in a long job", async () => {
  const image = Buffer.alloc(192 * 1024, 7).toString("base64");
  const setup: Message = { seq: 1, from: "provider", timestamp, type: "prompt",
    content: { id: "setup", text: "Start observing?" } };
  // The provider used seq 2 for a rejected payment and omits it from every read.
  const artifacts = Array.from({ length: 29 }, (_, index) => artifact(index + 3, image));
  const prompt: Message = { seq: 33, from: "provider", timestamp, type: "prompt",
    content: { id: "continue", text: "Continue observing?" } };
  const cache = [setup, ...artifacts, ask(32), prompt];
  seed(jobId, 33, cache);
  seed("full-read", 0);
  history = cache;
  wire.status.mockImplementation(async (id: string) => ({ jobId: id, status: "awaiting-input", content_available: true }));
  await status(jobId, {});
  expect(messageReads()).toEqual([[jobId, 1]]);
  wire.getMessages.mockClear();

  history = [...cache, payment(34, 32), payment(36, 35)];
  await status(jobId, {});
  expect(messageReads()).toEqual([[jobId, 33]]);
  expect(gapReads()).toEqual([[jobId, 1, 3]]);
  const incremental = output();
  expect(incremental).toMatchObject({
    next_action: { type: "respond", prompt_id: "continue" },
    spend: { total_msats: 8000, payments: 2 },
    overcharged: true,
    violated_limits: ["request_seq"],
    mandate_payments: [
      { seq: 34, request_seq: 32, amount_msats: 8000, total_micro: 80_000, overcharged: false },
      { seq: 36, request_seq: 35, amount_msats: 0, total_micro: 160_000, overcharged: true, violated_limits: ["request_seq"] },
    ],
  });
  expect(incremental).not.toHaveProperty("messages");
  expect(loadJob(jobId)).toMatchObject({ messageCursor: 33, paidPaymentRequestSeqs: [32] });

  await status("full-read", {});
  expect(messageReads().at(-1)).toEqual(["full-read", 0]);
  expect(output().mandate_payments).toEqual(incremental.mandate_payments);

  await status(jobId, {});
  expect(messageReads().slice(2)).toEqual([[jobId, 36]]);
  expect(gapReads().slice(1)).toEqual([[jobId, 1, 3], [jobId, 34, 36]]);
  expect(output().mandate_payments).toEqual(incremental.mandate_payments);
  expect(loadJob(jobId)).toMatchObject({ messageCursor: 33, totalPaidMsats: 8000, paymentsHonoured: 2 });

  await status(jobId, { messages: true });
  expect(messageReads().slice(3)).toEqual([[jobId, 33]]);
  expect(output()).toMatchObject({ cursor: 36, messages: [{ seq: 34 }, { seq: 36 }] });
  expect(loadJob(jobId)?.messageCursor).toBe(36);
});

it("backs up to the verified prefix of a legacy cache after a delivery cursor jump", async () => {
  history = [artifact(1), ask(2), payment(3, 2), artifact(4)];
  seed(jobId, 3, [history[0], history[2]]);
  await status(jobId, { messages: true });

  expect(messageReads()).toEqual([[jobId, 1]]);
  expect(output()).toMatchObject({
    cursor: 4,
    messages: [{ seq: 4 }],
    mandate_payments: [{ seq: 3, amount_msats: 8000, overcharged: false }],
  });
  expect(loadJob(jobId)).toMatchObject({ messageCursor: 4, paidPaymentRequestSeqs: [2], totalPaidMsats: 8000 });
});

it("switches to the remaining prompt when a reply becomes visible below the newest sequence", async () => {
  const prompts = [
    { seq: 1, from: "provider", timestamp, type: "prompt", content: { id: "first", text: "First choice?" } },
    { seq: 2, from: "provider", timestamp, type: "prompt", content: { id: "second", text: "Second choice?" } },
  ] satisfies Message[];
  const reply: Message = { seq: 3, from: "requester", timestamp, type: "response",
    content: { prompt_id: "second", text: "Yes" } };
  const later = artifact(4);
  seed(jobId, 2, prompts);
  wire.status.mockResolvedValue({ jobId, status: "awaiting-input", content_available: true });

  history = [...prompts, later];
  await status(jobId, {});
  expect(output()).toMatchObject({ next_action: { type: "respond", prompt_id: "second" } });

  history = [...prompts, reply, later];
  await status(jobId, {});
  expect(output()).toMatchObject({ next_action: { type: "respond", prompt_id: "first" } });
  await status(jobId, {});
  expect(output()).toMatchObject({ next_action: { type: "respond", prompt_id: "first" } });
  expect(messageReads()).toEqual([[jobId, 2], [jobId, 4], [jobId, 4]]);
  expect(gapReads()).toEqual([[jobId, 2, 4]]);
  expect(loadJob(jobId)?.messageCursor).toBe(2);
});

it("bounds gap probes and revisits older gaps as the provider history grows", async () => {
  const prompts = [
    { seq: 1, from: "provider", timestamp, type: "prompt", content: { id: "first", text: "First choice?" } },
    { seq: 2, from: "provider", timestamp, type: "prompt", content: { id: "second", text: "Second choice?" } },
  ] satisfies Message[];
  history = [...prompts, ...[5, 7, 9, 11, 13].map((seq) => artifact(seq))];
  seed(jobId, 2, history);
  await status(jobId, {});
  wire.status.mockResolvedValue({ jobId, status: "awaiting-input", content_available: true });
  history.push({ seq: 12, from: "requester", timestamp, type: "response", content: { prompt_id: "second", text: "Yes" } });

  const polls = [
    { newest: 15, gaps: [[2, 5], [5, 7]], action: { type: "respond", prompt_id: "second" } },
    { newest: 17, gaps: [[7, 9], [9, 11]], action: { type: "respond", prompt_id: "second" } },
    { newest: 19, gaps: [[11, 13]], action: { type: "respond", prompt_id: "first" } },
    { newest: 21, gaps: [[2, 5], [5, 7]], action: { type: "poll" } },
  ];
  for (const { newest, gaps, action } of polls) {
    wire.getMessages.mockClear();
    history.push(artifact(newest));
    if (newest === 21) {
      history.push({ seq: 3, from: "requester", timestamp, type: "response", content: { prompt_id: "first", text: "Yes" } });
    }
    await status(jobId, {});
    expect(gapReads()).toEqual(gaps.map(([after, before]) => [jobId, after, before]));
    expect(wire.getMessages.mock.calls[0]?.slice(0, 2)).toEqual([jobId, newest - 2]);
    expect(output()).toMatchObject({ next_action: action });
  }
});

it("keeps the fresh payment summary when a gap read uses up the poll budget", async () => {
  const prompt: Message = { seq: 1, from: "provider", timestamp, type: "prompt",
    content: { id: "choice", text: "Continue observing?" } };
  history = [prompt, artifact(3), artifact(5), ask(7)];
  seed(jobId, 1, history);
  await status(jobId, {});
  wire.getMessages.mockClear();
  history.push(payment(8, 7));
  wire.status.mockResolvedValue({ jobId, status: "awaiting-input", content_available: true });
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  wire.getMessages.mockImplementation(async (_id: string, after: number, _provider, { beforeSeq } = {}) => {
    if (beforeSeq !== undefined) {
      now = 100;
      throw new DvmError("timeout", "Message poll timed out.");
    }
    now = 85;
    return history.filter((message) => message.seq > after);
  });

  await status(jobId, { timeout: "0.1" });

  expect(wire.getMessages.mock.calls[0]?.slice(0, 2)).toEqual([jobId, 7]);
  expect(gapReads()).toEqual([[jobId, 1, 3]]);
  expect(wire.getMessages.mock.lastCall?.[3].timeoutMs).toBe(15);
  expect(output()).toMatchObject({ mandate_payments: [{ seq: 8, amount_msats: 8000 }], spend: { total_msats: 8000 } });

  wire.getMessages.mockClear().mockImplementation(async (_id: string, after: number, _provider, { beforeSeq = Infinity } = {}) =>
    history.filter((message) => message.seq > after && message.seq < beforeSeq));
  history.push({ seq: 4, from: "requester", timestamp, type: "response", content: { prompt_id: "choice", text: "Yes" } });
  await status(jobId, {});
  expect(gapReads()).toEqual([[jobId, 3, 5], [jobId, 5, 7]]);
  expect(output()).toMatchObject({ next_action: { type: "poll" } });
});

it("recovers the missing prefix when the cached log is truncated", async () => {
  history = [ask(1), payment(2, 1), artifact(4)];
  seed(jobId, 0);
  await status(jobId, {});
  await status(jobId, {});
  expect(messageReads()).toEqual([[jobId, 0], [jobId, 4]]);

  writeFileSync(join(MESSAGES_DIR, `${jobId}.jsonl`), JSON.stringify(history[2]) + "\n");
  await status(jobId, {});

  expect(messageReads().at(-1)).toEqual([jobId, 0]);
  expect(output()).toMatchObject({ mandate_payments: [{ seq: 2, amount_msats: 8000, overcharged: false }] });
  expect(loadJob(jobId)).toMatchObject({ totalPaidMsats: 8000, paymentsHonoured: 1 });
});

it("uses the same incremental history for terminal artifacts and an unanswered charge", async () => {
  const cache = [artifact(1), ask(2)];
  history = [...cache, { seq: 3, from: "provider", timestamp: deadline / 1000, type: "cancel",
    content: { reason: "Ask expired" } }];
  seed(jobId, 2, cache);
  wire.status.mockResolvedValue({ jobId, status: "cancelled", content_available: true });

  await status(jobId, {});

  expect(messageReads()).toEqual([[jobId, 2]]);
  expect(output()).toMatchObject({ artifact_count: 1, message: "Ask expired", next_action: null,
    unanswered_payment_request: { seq: 2, amount_msats: 8000, expires_at_ms: deadline } });
  expect(loadJob(jobId)?.messageCursor).toBe(2);
});

it("checks sparse history for a caller decline before attributing cancellation to an unpaid ask", async () => {
  const cache = [artifact(1), ask(2)];
  const later = artifact(4);
  history = [...cache, later];
  seed(jobId, 2, cache);
  await status(jobId, {});
  await status(jobId, {});
  expect(messageReads()).toEqual([[jobId, 2], [jobId, 4]]);

  history = [...cache, { seq: 3, from: "requester", timestamp: deadline / 1000 - 1, type: "decline",
    content: { reason: "Stop" } }, later, { seq: 5, from: "provider", timestamp: deadline / 1000,
    type: "cancel", content: { reason: "Ended" } }];
  wire.status.mockResolvedValue({ jobId, status: "cancelled", content_available: true });
  await status(jobId, {});

  expect(output()).toMatchObject({ artifact_count: 2, status: "cancelled", next_action: null });
  expect(output()).not.toHaveProperty("unanswered_payment_request");
  expect(messageReads().at(-1)).toEqual([jobId, 2]);
});

it("uses the sparse cache when the provider reports completion with artifact metadata", async () => {
  history = [artifact(1), artifact(3), ask(4)];
  seed(jobId, 4, history);
  await status(jobId, {});
  expect(messageReads()).toEqual([[jobId, 1]]);

  history = [...history, payment(5, 4)];
  wire.status.mockResolvedValue({ jobId, status: "completed", content_available: true,
    hasArtifacts: true, artifactCount: 2, summary: "Finished", payloadIn: "messages" });
  await status(jobId, {});
  expect(messageReads()).toEqual([[jobId, 1], [jobId, 4]]);
  expect(gapReads()).toEqual([]);
  expect(output()).toMatchObject({ status: "completed", source: "provider", summary: "Finished", artifact_count: 2,
    mandate_payments: [{ seq: 5, amount_msats: 8000 }], next_action: null });
  expect(loadJob(jobId)?.status).toBe("completed");
  await status(jobId, {});
  expect(output()).toMatchObject({ status: "completed", source: "local", artifact_count: 2 });
  expect(messageReads()).toHaveLength(2);
});
