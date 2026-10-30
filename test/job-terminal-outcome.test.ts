import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { type Message } from "@dvmkit/sdk/internal";

const wire = vi.hoisted(() => ({
  describe: vi.fn(), quote: vi.fn(), submit: vi.fn(), stream: vi.fn(), status: vi.fn(),
  getMessages: vi.fn(), cancel: vi.fn(), sendMessage: vi.fn(), close: vi.fn(), json: vi.fn(), info: vi.fn(),
}));
vi.mock("../src/lib/transport", () => ({ createDvmTransport: () => wire }));
vi.mock("../src/lib/output", async (original) => ({
  ...await original<typeof import("../src/lib/output")>(), json: wire.json, info: wire.info,
}));

import { request } from "../src/commands/request";
import { status } from "../src/commands/status";
import { cancel } from "../src/commands/cancel";
import { message } from "../src/commands/message";
import { messages } from "../src/commands/messages";
import { loadJob, saveJob } from "../src/lib/job-store";

const endpoint = "https://provider.example";
const jobId = "terminal-job";
const reason = "Insufficient coverage for this request";
const root = process.env.DVM_CONFIG_DIR!;
const log: Message[] = [{ seq: 1, from: "provider", timestamp: 1, type: "cancel", content: { reason } }];
const output = () => wire.json.mock.calls.at(-1)![0];

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "config.json"), JSON.stringify({ credit: { posture: "off" }, feedback: { posture: "off" } }));
  vi.stubEnv("DVM_IDENTITY_KEY", "01".repeat(32));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network access")));
  wire.describe.mockResolvedValue({ name: "Test provider", capabilities: { work: { description: "Work" } } });
  wire.quote.mockResolvedValue([{ priceMsats: 0 }]);
  wire.submit.mockResolvedValue({ jobId, status: "processing" });
  wire.stream.mockResolvedValue({ messages: log, lastSeq: 1 });
  wire.getMessages.mockResolvedValue(log);
  wire.status.mockResolvedValue({ jobId, status: "failed", message: reason });
  wire.cancel.mockResolvedValue(undefined);
  wire.sendMessage.mockResolvedValue({ seq: 1 });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function seed() {
  saveJob({ id: jobId, endpoint, status: "processing", submittedAt: 1 });
}

it.each([false, true])("reports a streamed refusal and replays it offline (receipts=%s)", async (receipts) => {
  wire.describe.mockResolvedValue({ name: "Test provider", receipts, capabilities: { work: { description: "Work" } } });
  await request({ endpoint, input: "work" });
  expect(output()).toMatchObject({ status: "failed", message: reason, next_action: null });
  expect(output()._provider_fields).toContain("message");
  expect(loadJob(jobId)).toMatchObject({ status: "failed", completion: { message: reason } });
  wire.status.mockRejectedValue(new Error("Provider offline"));
  await status(jobId, {});
  expect(output()).toMatchObject({ status: "failed", message: reason, source: "local", next_action: null });
});

it("prefers the provider's cancellation status over a cancel message", async () => {
  wire.describe.mockResolvedValue({ name: "Test provider", receipts: true, capabilities: { work: { description: "Work" } } });
  wire.status.mockResolvedValue({ jobId, status: "cancelled", message: "Provider confirmed cancellation" });
  await request({ endpoint, input: "work" });
  expect(output()).toMatchObject({ status: "cancelled", message: "Provider confirmed cancellation" });
  expect(wire.status).toHaveBeenCalledTimes(1);
  expect(loadJob(jobId)).toMatchObject({ status: "cancelled", completion: { message: "Provider confirmed cancellation" } });
});

it("corrects a cached legacy outcome when the receipt read reports failure", async () => {
  saveJob({ id: jobId, endpoint, status: "cancelled", submittedAt: 1, completion: {}, receiptsSupported: true });
  await status(jobId, {});
  expect(output()).toMatchObject({ status: "failed", message: reason });
  expect(loadJob(jobId)).toMatchObject({ status: "failed", completion: { message: reason } });
});

it("retains a caller cancellation and reason across stream replay and offline status", async () => {
  seed();
  await cancel(jobId, { reason: "Plans changed" });
  wire.status.mockRejectedValue(new Error("Provider offline"));
  await messages(jobId, { stream: false });
  await status(jobId, {});
  expect(output()).toMatchObject({ status: "cancelled", message: "Plans changed", source: "local" });
});

it.each([
  { command: "request", redacted: false },
  { command: "cancel", redacted: false },
  { command: "request", redacted: true },
  { command: "cancel", redacted: true },
])("retains the $command reason through a fresh status read and offline replay (redacted=$redacted)", async ({ command, redacted }) => {
  const terminal = command === "request" ? "failed" : "cancelled";
  if (command === "request") await request({ endpoint, input: "work" });
  else {
    seed();
    await cancel(jobId, { reason });
  }
  wire.status.mockResolvedValue({ jobId, status: terminal,
    ...(redacted ? { content_available: false, message: "", hasArtifacts: false } : {}) });
  wire.getMessages.mockResolvedValue([]);

  await status(jobId, { messages: true });
  expect(output()).toMatchObject({ status: terminal, message: reason, source: "provider" });
  expect(loadJob(jobId)?.completion?.message).toBe(reason);

  wire.status.mockRejectedValue(new Error("Provider offline"));
  await status(jobId, {});
  expect(output()).toMatchObject({ status: terminal, message: reason, source: "local" });
});

it("recovers a terminal reason from the fresh log when no reason was saved", async () => {
  seed();
  wire.status.mockResolvedValue({ jobId, status: "failed" });
  await status(jobId, { messages: true });
  expect(output()).toMatchObject({ status: "failed", message: reason });
  expect(loadJob(jobId)?.completion?.message).toBe(reason);
});

it("prefers a fresh provider reason to the saved reason", async () => {
  seed();
  await cancel(jobId, { reason });
  wire.status.mockResolvedValue({ jobId, status: "cancelled", message: "Cancellation confirmed" });
  await status(jobId, { messages: true });
  expect(output()).toMatchObject({ status: "cancelled", message: "Cancellation confirmed" });
  expect(loadJob(jobId)?.completion?.message).toBe("Cancellation confirmed");
});

it("does not reuse a saved reason for another terminal status or endpoint", async () => {
  seed();
  await cancel(jobId, { reason });
  wire.status.mockResolvedValue({ jobId, status: "failed" });
  wire.getMessages.mockResolvedValue([]);
  await status(jobId, { messages: true, endpoint: "https://other-provider.example", jobToken: "ab".repeat(32) });
  expect(output()).not.toHaveProperty("message");
  expect(loadJob(jobId)).toMatchObject({ status: "cancelled", completion: { message: reason } });
  await status(jobId, { messages: true });
  expect(output()).not.toHaveProperty("message");
});

it.each(["batch", "stream", "receipt"])("preserves saved artifacts after a redacted %s read", async (path) => {
  const completion = { summary: "Saved result", message: reason, hasArtifacts: true, artifactCount: 2, payloadIn: "messages" as const };
  saveJob({ id: jobId, endpoint, status: "completed", submittedAt: 1, completion, receiptsSupported: path === "receipt" });
  wire.getMessages.mockResolvedValue([]);
  wire.stream.mockResolvedValue({ messages: [], lastSeq: 0 });
  wire.status.mockResolvedValue({ jobId, status: "completed", content_available: false,
    summary: "", message: "", hasArtifacts: false });

  if (path === "receipt") await status(jobId, {});
  else await messages(jobId, { stream: path === "stream" });
  expect(loadJob(jobId)?.completion).toEqual(completion);

  wire.status.mockRejectedValue(new Error("Provider offline"));
  await status(jobId, {});
  expect(output()).toMatchObject({ source: "local", summary: "Saved result", has_artifacts: true,
    artifact_count: 2, payload_in: "messages" });
});

it("records cancellation sent through the message command", async () => {
  seed();
  wire.status.mockRejectedValue(new Error("Legacy provider"));
  await message(jobId, "Plans changed", { type: "cancel" });
  await status(jobId, {});
  expect(output()).toMatchObject({ status: "cancelled", message: "Plans changed" });
});

it("does not record caller intent when cancellation is refused", async () => {
  seed();
  wire.cancel.mockRejectedValue(new Error("Cancellation refused"));
  await expect(cancel(jobId, { reason: "Plans changed" })).rejects.toThrow("Cancellation refused");
  expect(loadJob(jobId)?.callerCancelled).toBeUndefined();
  await messages(jobId, { stream: false });
  expect(loadJob(jobId)?.status).toBe("failed");
});

it("shows failure status and reason in human request output", async () => {
  await request({ endpoint, input: "work", human: true });
  const human = wire.info.mock.calls.flat().join("\n");
  expect(human).toContain(`Status: failed: ${reason}`);
  expect(human).not.toContain("Cancelled");
});

it.each([
  { terminal: "failed", code: "job_failed" },
  { terminal: "cancelled", code: "cancelled" },
])("retains a synchronous $terminal reason in the error and status snapshot", async ({ terminal, code }) => {
  wire.submit.mockResolvedValue({ jobId, status: terminal });
  await expect(request({ endpoint, input: "work" })).rejects.toMatchObject({
    code, message: reason, data: { status: terminal },
  });
  await status(jobId, {});
  expect(output()).toMatchObject({ status: terminal, message: reason });
});

it.each(["batch", "stream", "wait", "message"])("uses provider status from the %s read before snapshotting", async (path) => {
  seed();
  wire.status.mockResolvedValue({ jobId, status: "cancelled", message: "Provider confirmed cancellation" });
  if (path === "message") await message(jobId, "continue", {});
  else await messages(jobId, path === "batch" ? { stream: false } : path === "wait" ? { wait: true } : {});
  expect(loadJob(jobId)).toMatchObject({ status: "cancelled", completion: { message: "Provider confirmed cancellation" } });
});

it.each([false, true])("persists terminal status even when the message tail is empty (wait=%s)", async (wait) => {
  seed();
  wire.stream.mockResolvedValue({ messages: [], lastSeq: 0 });
  wire.getMessages.mockResolvedValue([]);
  await messages(jobId, { wait });
  expect(output().next_action).toBeNull();
  expect(loadJob(jobId)).toMatchObject({ status: "failed", completion: { message: reason } });
  expect(loadJob(jobId)?.completion?.hasArtifacts).toBeUndefined();
});
