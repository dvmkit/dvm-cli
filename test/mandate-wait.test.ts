import { DvmError, type Message, type Transport } from "@dvmkit/sdk/internal";
import { expect, it, vi } from "vitest";
import { loadJob, saveJob } from "../src/lib/job-store";
import { mandateWindowAction } from "../src/lib/mandate-wait";
import { waitForJob } from "../src/lib/wait-for-job";

const start = 1_000_000;
const job = { id: "waiting", endpoint: "https://provider.example", status: "processing" as const, submittedAt: start,
  mandate: { max_total_micro: 300_000, max_ask_micro: 200_000, expires_at_ms: 2_000_000,
    credit_id: "credit", draw_id: "draw", currency: "usd", signed_data: {} }, mandateAskObservedAtMs: { 1: start } };
const ask = { amount_msats: 200_000, reason: "Next piece", credit: { amount_micro: 200_000, currency: "usd" } };

it("covers the SDK's 10-second recovery grace and 60-second sweep, with ten seconds of settlement margin", () => {
  saveJob(job);
  expect(mandateWindowAction(job.id, ask, 1, [], start + 75_000)).toMatchObject({ type: "poll", retry_at_ms: start + 80_000 });
  expect(mandateWindowAction(job.id, ask, 1, [], start + 80_000)).toBeUndefined();
});

it.each([
  { name: "ask cap", price: { amount_micro: 200_001, currency: "usd" }, now: start },
  { name: "currency", price: { amount_micro: 200_000, currency: "eur" }, now: start },
  { name: "expiry", price: ask.credit, now: 2_000_000 },
])("does not wait for a mandate that must skip due to $name", ({ price, now }) => {
  saveJob(job);
  expect(mandateWindowAction(job.id, { ...ask, credit: price }, 1, [], now)).toBeUndefined();
});

it("does not wait when this draw cannot fit the ask under the standing total", () => {
  saveJob(job);
  const payment = { seq: 2, from: "requester", timestamp: 1000, type: "payment", content: { credit: {
    credit_id: "credit", draw_id: "draw", request_seq: 1, payment_id: "paid", amount_micro: 200_000, currency: "usd",
  } } } as Message;
  expect(mandateWindowAction(job.id, ask, 3, [payment], start)).toBeUndefined();
});

it.each(["recovers", "keeps timing out"])("reconciles the ask within the wait limit when mandate history %s", async (historyOutcome) => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(start);
    const jobId = historyOutcome === "recovers" ? "mandate-history-recovers" : "mandate-history-limit";
    const policy = { maxTotalMsats: 300_000, autoPayBelowMsats: 200_000, maxIncrementMsats: 200_000, maxPayments: 3 };
    saveJob({ ...job, id: jobId, policy });
    const request: Message = { seq: 4, from: "provider", timestamp: start / 1000, type: "payment-request", content: ask };
    const payment: Message = { seq: 5, from: "requester", timestamp: start / 1000 + 2, type: "payment", content: { credit: {
      mandate: true, credit_id: "credit", draw_id: "draw", request_seq: 4, payment_id: "mandate:paid", amount_micro: 200_000, currency: "usd",
    } } };
    const complete: Message = { seq: 6, from: "provider", timestamp: start / 1000 + 2, type: "complete", content: { summary: "Done" } };
    let settled = false;
    const stream = vi.fn<NonNullable<Transport["stream"]>>(async (_id, after) => ({
      messages: (settled ? [request, payment, complete] : [request]).filter((msg) => msg.seq > after), reason: settled ? "complete" : "yield",
    }));
    const timeoutHistory: Transport["getMessages"] = async (_id, _after, _provider, options) => {
      await new Promise((resolve) => setTimeout(resolve, options?.timeoutMs));
      throw new DvmError("timeout", "Message poll timed out");
    };
    const getMessages = vi.fn(timeoutHistory);
    if (historyOutcome === "recovers") {
      getMessages.mockImplementationOnce(timeoutHistory).mockImplementation(async () => {
        settled = true;
        return [request, payment, complete];
      });
    }
    const sendMessage = vi.fn<Transport["sendMessage"]>();
    const transport = { stream, status: vi.fn().mockResolvedValue({ status: "awaiting-input" }), getMessages, sendMessage } as unknown as Transport;
    const until = historyOutcome === "recovers" ? 5_000 : 3_000;
    const waiting = waitForJob({ jobId, transport, provider: { endpoint: job.endpoint }, policy, afterSeq: 2,
      afterSeqExplicit: true, timeoutMs: 1_500 }, until).catch((error: unknown) => ({ error }));
    await vi.runAllTimersAsync();
    const result = await waiting;

    expect(sendMessage).not.toHaveBeenCalled();
    expect(stream.mock.calls.slice(0, 2).map(([, after]) => after)).toEqual([2, 3]);
    expect(getMessages.mock.calls.map(([, after]) => after)).toEqual([0, 0]);
    if (historyOutcome === "recovers") {
      expect(result).toMatchObject({ cursor: 6, nextAction: null, messages: [request, payment, complete] });
      expect(loadJob(jobId)).toMatchObject({ paidPaymentRequestSeqs: [4], mandatePaymentSeqs: [5], paymentsHonoured: 1, totalPaidMsats: 200_000 });
    } else {
      expect(result).toMatchObject({ cursor: 3, nextAction: { type: "poll", hint: expect.stringContaining("wait limit (3s)") } });
      expect(getMessages.mock.calls.map(([, , , options]) => options?.timeoutMs)).toEqual([1_500, 500]);
      expect(Date.now() - start).toBe(until);
    }
  } finally {
    vi.useRealTimers();
  }
});
