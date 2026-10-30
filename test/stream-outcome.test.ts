import { expect, it } from "vitest";
import { type Message } from "@dvmkit/sdk/internal";
import { loadJob, saveJob } from "../src/lib/job-store";
import { appendMessages } from "../src/lib/messages";
import { persistStreamOutcome, streamTerminalStatus } from "../src/lib/stream-outcome";

const cancel: Message = { seq: 3, from: "provider", type: "cancel", timestamp: 1, content: { reason: "No coverage" } };
const complete: Message = { seq: 3, from: "provider", type: "complete", timestamp: 1, content: { summary: "Done" } };

it("does not infer caller intent from a wire sender label", () => {
  expect(streamTerminalStatus([{ ...cancel, from: "requester" }])).toBe("failed");
});

it("lets an authoritative failure override stream completion and local cancel intent", () => {
  const context = { providerStatus: { status: "failed" as const }, callerCancelled: true };
  expect(streamTerminalStatus([complete], context)).toBe("failed");
});

it("does not let a stale nonterminal status erase a stream failure reason", () => {
  saveJob({ id: "stale", endpoint: "https://provider.example", status: "processing", submittedAt: 1 });
  persistStreamOutcome({ jobId: "stale", messages: [cancel], cursor: 3, afterSeq: 0,
    providerStatus: { status: "processing", message: "Still working" } });
  expect(loadJob("stale")).toMatchObject({ status: "failed", completion: { message: "No coverage" } });
});

it("leaves an incomplete stream snapshot for a later provider read", () => {
  saveJob({ id: "gap", endpoint: "https://provider.example", status: "processing", submittedAt: 1 });
  appendMessages("gap", [cancel]);
  expect(persistStreamOutcome({ jobId: "gap", messages: [cancel], cursor: 3, afterSeq: 2 })).toBeUndefined();
  expect(loadJob("gap")).toMatchObject({ status: "processing", messageCursor: 3 });
  expect(loadJob("gap")?.completion).toBeUndefined();
});

it("saves provider status without inventing artifact metadata for an incomplete log", () => {
  saveJob({ id: "partial", endpoint: "https://provider.example", status: "processing", submittedAt: 1 });
  const completion = persistStreamOutcome({ jobId: "partial", messages: [cancel], cursor: 3, afterSeq: 2,
    providerStatus: { status: "failed", message: "No coverage" } });
  expect(completion).toEqual({ message: "No coverage" });
  expect(loadJob("partial")?.status).toBe("failed");
});

it("counts artifacts from a whole local log when only the terminal tail is returned", () => {
  saveJob({ id: "whole", endpoint: "https://provider.example", status: "processing", submittedAt: 1 });
  appendMessages("whole", [
    { seq: 1, from: "provider", type: "artifact", timestamp: 1, content: { name: "report.txt", mime_type: "text/plain", data: "report" } },
    { seq: 2, from: "provider", type: "text", timestamp: 1, content: { text: "Coverage report" } }, cancel,
  ]);
  expect(persistStreamOutcome({ jobId: "whole", messages: [cancel], cursor: 3, afterSeq: 2 }))
    .toEqual({ message: "No coverage", artifactCount: 1, hasArtifacts: true, payloadIn: "messages" });
});

it("preserves saved artifact evidence when a terminal status has no message content", () => {
  saveJob({ id: "redacted", endpoint: "https://provider.example", status: "failed", submittedAt: 1,
    completion: { message: "No coverage", artifactCount: 2, hasArtifacts: true, payloadIn: "messages" } });
  expect(persistStreamOutcome({ jobId: "redacted", messages: [], cursor: 0, afterSeq: 0,
    providerStatus: { status: "failed" } }))
    .toEqual({ message: "No coverage", artifactCount: 2, hasArtifacts: true, payloadIn: "messages" });
});
