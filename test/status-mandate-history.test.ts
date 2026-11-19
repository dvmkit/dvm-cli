import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES_DIR, type Message } from "@dvmkit/sdk/internal";
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
const messageReads = () => wire.getMessages.mock.calls.map(([id, after]) => [id, after]);

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
  wire.getMessages.mockImplementation(async (_id: string, after: number) =>
    history.filter((message) => message.seq > after));
});

it("checks a long job's tail against cached asks and leaves unread messages available", async () => {
  const image = Buffer.alloc(192 * 1024, 7).toString("base64");
  const artifacts = Array.from({ length: 28 }, (_, index) => artifact(index + 1, image));
  const prompt: Message = { seq: 30, from: "provider", timestamp, type: "prompt",
    content: { id: "continue", text: "Continue observing?" } };
  const cache = [...artifacts, ask(29), prompt];
  history = [...cache, payment(31, 29), payment(33, 32)];
  seed(jobId, 30, cache);
  seed("full-read", 0);
  wire.status.mockImplementation(async (id: string) => ({ jobId: id, status: "awaiting-input", content_available: true }));

  await status(jobId, {});
  expect(messageReads()).toEqual([[jobId, 30]]);
  const incremental = output();
  expect(incremental).toMatchObject({
    next_action: { type: "respond", prompt_id: "continue" },
    spend: { total_msats: 8000, payments: 2 },
    overcharged: true,
    violated_limits: ["request_seq"],
    mandate_payments: [
      { seq: 31, request_seq: 29, amount_msats: 8000, total_micro: 80_000, overcharged: false },
      { seq: 33, request_seq: 32, amount_msats: 0, total_micro: 160_000, overcharged: true, violated_limits: ["request_seq"] },
    ],
  });
  expect(incremental).not.toHaveProperty("messages");
  expect(loadJob(jobId)).toMatchObject({ messageCursor: 30, paidPaymentRequestSeqs: [29] });

  await status("full-read", {});
  expect(messageReads().at(-1)).toEqual(["full-read", 0]);
  expect(output().mandate_payments).toEqual(incremental.mandate_payments);

  await status(jobId, {});
  expect(messageReads().slice(2)).toEqual([[jobId, 31]]);
  expect(output().mandate_payments).toEqual(incremental.mandate_payments);
  expect(loadJob(jobId)).toMatchObject({ messageCursor: 30, totalPaidMsats: 8000, paymentsHonoured: 2 });

  await status(jobId, { messages: true });
  expect(messageReads().slice(3)).toEqual([[jobId, 30]]);
  expect(output()).toMatchObject({ cursor: 33, messages: [{ seq: 31 }, { seq: 33 }] });
  expect(loadJob(jobId)?.messageCursor).toBe(33);
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
  expect(messageReads()).toEqual([[jobId, 2], [jobId, 2], [jobId, 4]]);
  expect(loadJob(jobId)?.messageCursor).toBe(2);
});

it("recovers the missing prefix when the cached log is truncated", async () => {
  history = [ask(1), payment(2, 1), artifact(3)];
  seed(jobId, 0);
  await status(jobId, {});
  await status(jobId, {});
  expect(messageReads()).toEqual([[jobId, 0], [jobId, 3]]);

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
