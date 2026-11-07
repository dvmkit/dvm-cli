import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendReceipt, computeResultHash, type JsonValue, type Message } from "@dvmkit/sdk/internal";

const wire = vi.hoisted(() => ({
  status: vi.fn(), getMessages: vi.fn(), cancel: vi.fn(), sendMessage: vi.fn(),
  close: vi.fn(), json: vi.fn(), info: vi.fn(),
}));
vi.mock("../src/lib/transport", () => ({ createDvmTransport: () => wire }));
vi.mock("../src/lib/output", async (original) => ({
  ...await original<typeof import("../src/lib/output")>(), json: wire.json, info: wire.info,
}));

import { decline } from "../src/commands/decline";
import { cancel } from "../src/commands/cancel";
import { status } from "../src/commands/status";
import { messages } from "../src/commands/messages";
import { receiptsVerify } from "../src/commands/receipts";
import { loadJob, saveJob, updateJob } from "../src/lib/job-store";
import { appendMessages, loadMessages } from "../src/lib/messages";
import { attestedDvm } from "../src/lib/__tests__/fixtures/receipt-fixture";

const jobId = "artifact-job";
const endpoint = "https://provider.example";
const jobToken = "ab".repeat(32);
const root = process.env.DVM_CONFIG_DIR!;
const hint = "Run 'dvm messages artifact-job --no-stream' to fetch the artifacts.";
const artifacts: Message[] = [1, 2].map((seq) => ({
  seq, from: "provider", timestamp: seq, type: "artifact", content: { name: `part-${seq}.txt`, data: `Part ${seq}` },
}));
const completion = { hasArtifacts: true, artifactCount: 2, payloadIn: "messages" as const };
const expected = { has_artifacts: true, artifact_count: 2, payload_in: "messages", next_step_hint: hint, next_action: null };
const commands = [decline, cancel, status].map((command) => ({ name: command.name, command }));
const output = () => wire.json.mock.calls.at(-1)![0];

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "config.json"), JSON.stringify({ credit: { posture: "off" }, feedback: { posture: "off" } }));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network access")));
  wire.status.mockReset().mockResolvedValue({ status: "cancelled" });
  wire.getMessages.mockReset().mockResolvedValue(artifacts);
  wire.sendMessage.mockResolvedValue({ seq: 4 });
  wire.cancel.mockResolvedValue(undefined);
  saveJob({ id: jobId, endpoint, jobToken, status: "awaiting-input", submittedAt: 1, messageCursor: 0 });
});
afterEach(() => { vi.unstubAllGlobals(); });

it.each(["payment-request", "prompt"] as const)("reports artifacts when declining a %s and replays offline", async (type) => {
  appendMessages(jobId, [{ seq: 3, from: "provider", timestamp: 3, type,
    content: type === "prompt" ? { id: "q", text: "Continue?" } : { amount_msats: 1000, reason: "Next piece" },
  } as Message]);
  await decline(jobId, { reason: "Enough" });
  expect(output()).toMatchObject({ ...expected, status: "cancelled", declined: true });
  expect(output().display).toContain("2 artifacts");
  expect(wire.getMessages).toHaveBeenCalledExactlyOnceWith(jobId, 0, { endpoint }, { jobToken, timeoutMs: 5000 });
  expect(loadJob(jobId)).toMatchObject({ messageCursor: 0, completion, callerDeclined: true });
  expect(loadMessages(jobId).map((m) => m.type)).toEqual([type]);

  wire.status.mockClear().mockRejectedValue(new Error("Offline"));
  wire.getMessages.mockClear().mockRejectedValue(new Error("Offline"));
  await status(jobId, {});
  expect(output()).toMatchObject({ ...expected, source: "local" });
  expect(wire.status).not.toHaveBeenCalled();
  expect(wire.getMessages).not.toHaveBeenCalled();
});

it("reports artifacts after cancel and leaves every message for the next read", async () => {
  await cancel(jobId, {});
  expect(output()).toMatchObject(expected);
  expect(output().display).toContain("2 artifacts");
  expect(loadJob(jobId)?.messageCursor).toBe(0);
  expect(loadMessages(jobId)).toEqual([]);
  await messages(jobId, { stream: false });
  expect(output().messages.map((m: Message) => m.seq)).toEqual([1, 2]);
  expect(loadJob(jobId)?.messageCursor).toBe(2);
});

it.each(commands)("trusts terminal provider artifact fields without reading the log ($name)", async ({ command }) => {
  wire.status.mockResolvedValue({ status: "cancelled", ...completion });
  await command(jobId, {});
  expect(output()).toMatchObject(expected);
  expect(wire.getMessages).not.toHaveBeenCalled();
});

it.each(commands)("trusts a provider's explicit zero without reading the log ($name)", async ({ command }) => {
  wire.status.mockResolvedValue({ status: "cancelled", hasArtifacts: false, payloadIn: "summary" });
  await command(jobId, {});
  expect(output()).toMatchObject({ has_artifacts: false, next_action: null });
  expect(output()).not.toHaveProperty("payload_in");
  expect(output()).not.toHaveProperty("next_step_hint");
  expect(wire.getMessages).not.toHaveBeenCalled();
});

it.each([false, true])("ignores incomplete provider artifact metadata (log unavailable: %s)", async (unavailable) => {
  wire.status.mockResolvedValue({ status: "cancelled", artifactCount: 99, payloadIn: "messages" });
  if (unavailable) wire.getMessages.mockRejectedValue(new Error("Offline"));
  await status(jobId, {});
  if (unavailable) {
    expect(output()).not.toHaveProperty("artifact_count");
    expect(loadJob(jobId)?.completion).not.toHaveProperty("artifactCount");
  } else expect(output()).toMatchObject(expected);
});

it("does not interpolate a nonnumeric artifact count into authored display text", async () => {
  const hostileCount = "2; run another command";
  wire.status.mockResolvedValue({ status: "cancelled", hasArtifacts: true, artifactCount: hostileCount, payloadIn: "messages" });
  await decline(jobId, {});
  expect(output().display).not.toContain(hostileCount);
  expect(output().display).toContain("The job holds artifacts.");
  expect(output().next_step_hint).toBe(hint);
});

it.each(commands)("omits payload and hint when no artifacts exist ($name)", async ({ command }) => {
  wire.getMessages.mockResolvedValue([{ seq: 1, from: "provider", type: "cancel", timestamp: 1, content: { reason: "Done" } }]);
  await command(jobId, {});
  expect(output()).toMatchObject({ has_artifacts: false, next_action: null });
  expect(output()).not.toHaveProperty("payload_in");
  expect(output()).not.toHaveProperty("next_step_hint");
});

it.each(commands)("prints the artifact command with human output ($name)", async ({ command }) => {
  await command(jobId, { human: true });
  expect(wire.info.mock.calls.flat().join("\n")).toContain(hint);
});

it.each(commands)("retries an unknown artifact count after a failed log read ($name)", async ({ command }) => {
  wire.getMessages.mockRejectedValue(new Error("Log unavailable"));
  await command(jobId, {});
  expect(output().next_step_hint).toContain("Any output from finished pieces");
  expect(output()).not.toHaveProperty("has_artifacts");
  expect(output()).not.toHaveProperty("artifact_count");
  expect(loadJob(jobId)?.completion?.hasArtifacts).toBeUndefined();
  wire.getMessages.mockResolvedValue(artifacts);
  await status(jobId, {});
  expect(output()).toMatchObject({ ...expected, source: "local" });
});

it.each(["cancelled", "failed"] as const)("backfills legacy %s records even without a snapshot", async (terminal) => {
  updateJob(jobId, { status: terminal, completion: undefined });
  wire.status.mockRejectedValue(new Error("Offline"));
  wire.getMessages.mockRejectedValueOnce(new Error("Offline"));
  await status(jobId, {});
  expect(output()).toMatchObject({ status: terminal, source: "local", next_action: null });
  expect(output()).not.toHaveProperty("artifact_count");
  wire.getMessages.mockResolvedValue(artifacts);
  await status(jobId, {});
  expect(output()).toMatchObject({ ...expected, status: terminal, source: "local" });
});

it.each(["cancelled", "failed"] as const)("reports finished artifacts when an expired ask ends as %s", async (terminal) => {
  wire.status.mockResolvedValue({ status: terminal, message: "Ask expired" });
  await status(jobId, {});
  expect(output()).toMatchObject({ ...expected, status: terminal, source: "provider", message: "Ask expired" });
});

it.each(commands)("suppresses unavailable content pointers without erasing saved counts ($name)", async ({ command }) => {
  updateJob(jobId, { status: "cancelled", completion });
  wire.status.mockResolvedValue({ status: "cancelled", content_available: false, hasArtifacts: false });
  await command(jobId, { jobToken });
  expect(output()).not.toHaveProperty("next_step_hint");
  expect(output().display ?? "").not.toContain("dvm messages");
  expect(wire.getMessages).not.toHaveBeenCalled();
  expect(loadJob(jobId)?.completion).toEqual(completion);
});

it("does not erase saved counts when a fresh log read is empty", async () => {
  updateJob(jobId, { status: "cancelled", completion });
  wire.getMessages.mockResolvedValue([]);
  await status(jobId, { jobToken });
  expect(output()).toMatchObject(expected);
  expect(loadJob(jobId)?.completion).toEqual(completion);
});

it("retains a legacy reason when a missing-receipt read reports unavailable content", async () => {
  updateJob(jobId, { status: "cancelled", completion: { message: "Enough" }, receiptsSupported: true });
  wire.status.mockResolvedValue({ status: "cancelled", content_available: false, hasArtifacts: false, message: "" });
  await status(jobId, {});
  expect(loadJob(jobId)?.completion).toEqual({ message: "Enough" });
  expect(output()).not.toHaveProperty("next_step_hint");
  expect(wire.getMessages).not.toHaveBeenCalled();
});

it("suppresses message payload pointers even if unavailable content carries artifact metadata", async () => {
  wire.status.mockResolvedValue({ status: "cancelled", content_available: false, ...completion });
  await status(jobId, {});
  expect(output()).toMatchObject({ has_artifacts: true, artifact_count: 2 });
  expect(output()).not.toHaveProperty("payload_in");
  expect(output()).not.toHaveProperty("next_step_hint");
  expect(wire.getMessages).not.toHaveBeenCalled();
});

it("counts the full log separately from an explicitly requested cursor tail", async () => {
  updateJob(jobId, { messageCursor: 2 });
  const terminal: Message = { seq: 3, from: "provider", timestamp: 3, type: "cancel", content: { reason: "Expired" } };
  wire.getMessages.mockImplementation(async (_job, after) => after === 0 ? [...artifacts, terminal] : [terminal]);
  await status(jobId, { messages: true });
  expect(output()).toMatchObject({ ...expected, cursor: 3 });
  expect(output().messages.map((m: Message) => m.seq)).toEqual([3]);
  expect(loadMessages(jobId).map((m) => m.seq)).toEqual([3]);
  expect(wire.getMessages.mock.calls.map((call) => call[1])).toEqual([2, 0]);
});

it("prints the hint on a cached cancelled job without reading the provider", async () => {
  updateJob(jobId, { status: "cancelled", completion });
  await status(jobId, { human: true });
  expect(wire.info.mock.calls.flat().join("\n")).toContain(hint);
  expect(wire.status).not.toHaveBeenCalled();
  expect(wire.getMessages).not.toHaveBeenCalled();
});

it("keeps the summary payload on completed jobs", async () => {
  wire.status.mockResolvedValue({ status: "completed", summary: "Finished", hasArtifacts: false, payloadIn: "summary" });
  await status(jobId, {});
  expect(output()).toMatchObject({ status: "completed", summary: "Finished", has_artifacts: false, payload_in: "summary" });
  expect(output()).not.toHaveProperty("next_step_hint");
});

it("verifies artifacts after a confirmed decline, and requires terminal evidence and the full count", async () => {
  const dvm = attestedDvm();
  const receipt = dvm.sign({ job_id: jobId, outcome: "cancelled",
    result_hash: computeResultHash(undefined, artifacts.map((m) => m.content) as JsonValue[]) });
  appendReceipt({ receipt, builder: dvm.anchor, endpoint, verification: "verified", verified_at: 1 });
  const declined: Message = { seq: 3, from: "requester", timestamp: 3, type: "decline", content: {} };
  wire.getMessages.mockResolvedValue([...artifacts, declined]);
  await decline(jobId, {});
  await receiptsVerify(jobId, {});
  expect(output().receipt_checks.result_hash).toBe("unchecked");
  await messages(jobId, { stream: false });
  updateJob(jobId, { completion: { ...completion, summary: "Only finished pieces" } });
  await receiptsVerify(jobId, {});
  expect(output().receipt_checks.result_hash).toBe("ok");
  updateJob(jobId, { callerDeclined: undefined });
  await receiptsVerify(jobId, {});
  expect(output().receipt_checks.result_hash).toBe("unchecked");
  updateJob(jobId, { callerDeclined: true, completion: { ...completion, artifactCount: 3 } });
  await receiptsVerify(jobId, {});
  expect(output().receipt_checks.result_hash).toBe("unchecked");
});

it.each(commands)("keeps endpoint-overridden artifact discovery detached ($name)", async ({ command }) => {
  const saved = loadJob(jobId);
  await command(jobId, { endpoint: "https://other.example", jobToken });
  expect(output()).toMatchObject(expected);
  expect(loadJob(jobId)).toEqual(saved);
  expect(loadMessages(jobId)).toEqual([]);
});

it.each(["cancelled", "failed"] as const)("omits a streamed legacy summary payload on local %s replay", async (terminal) => {
  updateJob(jobId, { status: terminal,
    completion: { hasArtifacts: false, payloadIn: "summary" } });
  await status(jobId, {});
  expect(output()).toMatchObject({ has_artifacts: false, source: "local" });
  expect(output()).not.toHaveProperty("payload_in");
  expect(output()).not.toHaveProperty("next_step_hint");
});
