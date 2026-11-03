import { expect, it } from "vitest";
import { type Message } from "@dvmkit/sdk/internal";
import { saveJob, loadJob } from "../src/lib/job-store";
import { persistStreamOutcome, streamTerminalStatus } from "../src/lib/stream-outcome";
import { answeredYieldSeqs, pendingPaymentRequest } from "../src/lib/yield-state";

const ask: Message = { seq: 4, from: "provider", type: "payment-request", timestamp: 1,
  content: { amount_msats: 5000, reason: "Next block", charged_if_declined_micro: 360_000 } };
const prompt: Message = { seq: 2, from: "provider", type: "prompt", timestamp: 1, content: { id: "q", text: "Continue?" } };
const decline: Message = { seq: 5, from: "requester", type: "decline", timestamp: 1, content: {} };

it("treats a caller's decline as the answer to the open ask and prompts", () => {
  expect(pendingPaymentRequest([prompt, ask])?.seq).toBe(4);
  expect(answeredYieldSeqs([prompt, ask])).toEqual(new Set());
  expect(pendingPaymentRequest([prompt, ask, decline])).toBeUndefined();
  expect(answeredYieldSeqs([prompt, ask, decline])).toEqual(new Set([2, 4]));
});

it("does not let a decline answer an ask sent after it", () => {
  const later = { ...ask, seq: 6 };
  expect(answeredYieldSeqs([decline, later])).toEqual(new Set());
  expect(pendingPaymentRequest([decline, later])?.seq).toBe(6);
});

it("ends a declined job as cancelled, as a piece-charging DVM records it", () => {
  expect(streamTerminalStatus([ask])).toBeUndefined();
  expect(streamTerminalStatus([ask, decline])).toBe("cancelled");
  saveJob({ id: "declined", endpoint: "https://provider.example", status: "awaiting-input", submittedAt: 1 });
  persistStreamOutcome({ jobId: "declined", messages: [ask, { ...decline, content: { reason: "Too slow" } }], cursor: 5, afterSeq: 0 });
  expect(loadJob("declined")).toMatchObject({ status: "cancelled", completion: { message: "Too slow" } });
});
