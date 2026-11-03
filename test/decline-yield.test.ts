import { expect, it } from "vitest";
import { type Message } from "@dvmkit/sdk/internal";
import { loadJob, saveJob, updateJob } from "../src/lib/job-store";
import { appendMessages } from "../src/lib/messages";
import { persistStreamOutcome, streamTerminalStatus } from "../src/lib/stream-outcome";
import { answeredYieldSeqs, loadAnsweredYieldSeqs, pendingPaymentRequest } from "../src/lib/yield-state";

const ask: Message = { seq: 4, from: "provider", type: "payment-request", timestamp: 1,
  content: { amount_msats: 5000, reason: "Next block", charged_if_declined_micro: 360_000 } };
const prompt: Message = { seq: 2, from: "provider", type: "prompt", timestamp: 1, content: { id: "q", text: "Continue?" } };
const decline: Message = { seq: 5, from: "requester", type: "decline", timestamp: 1, content: { reason: "Too slow" } };

// An older DVM accepts a decline as an ordinary message and keeps the job open.
it("leaves the ask open while only the log shows a decline", () => {
  expect(answeredYieldSeqs([prompt, ask, decline])).toEqual(new Set());
  expect(pendingPaymentRequest([prompt, ask, decline])?.seq).toBe(4);
  expect(streamTerminalStatus([ask, decline])).toBeUndefined();
  saveJob({ id: "ignored", endpoint: "https://provider.example", status: "awaiting-input", submittedAt: 1 });
  appendMessages("ignored", [prompt, ask, decline]);
  expect(loadAnsweredYieldSeqs("ignored")).toEqual(new Set());
  persistStreamOutcome({ jobId: "ignored", messages: [prompt, ask, decline], cursor: 5, afterSeq: 0,
    providerStatus: { status: "awaiting-input" } });
  expect(loadJob("ignored")?.status).toBe("awaiting-input");
});

it("answers the ask and prompts once the provider confirmed the decline", () => {
  saveJob({ id: "declined", endpoint: "https://provider.example", status: "awaiting-input", submittedAt: 1 });
  appendMessages("declined", [prompt, ask, decline, { ...ask, seq: 6 }]);
  updateJob("declined", { callerDeclined: true, callerCancelled: true });
  expect(loadAnsweredYieldSeqs("declined")).toEqual(new Set([2, 4]));
  expect(streamTerminalStatus([ask, decline], { callerDeclined: true })).toBe("cancelled");
  persistStreamOutcome({ jobId: "declined", messages: [prompt, ask, decline], cursor: 5, afterSeq: 0 });
  expect(loadJob("declined")).toMatchObject({ status: "cancelled", completion: { message: "Too slow" } });
});
