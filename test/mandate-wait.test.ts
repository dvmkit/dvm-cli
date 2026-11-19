import { DvmError, signDvmRequestData, type Message, type Transport } from "@dvmkit/sdk/internal";
import { expect, it, vi } from "vitest";
import { loadJob, saveJob, type CreditPaymentIntent } from "../src/lib/job-store";
import { mandateWindowAction } from "../src/lib/mandate-wait";
import { waitForJob } from "../src/lib/wait-for-job";

const start = 1_000_000;
const job = { id: "waiting", endpoint: "https://provider.example", status: "processing" as const, submittedAt: start,
  mandate: { max_total_micro: 300_000, max_ask_micro: 200_000, expires_at_ms: 2_000_000,
    credit_id: "credit", draw_id: "draw", currency: "usd", signed_data: {} }, mandateAskObservedAtMs: { 1: start } };
const ask = { amount_msats: 200_000, reason: "Next piece", credit: { amount_micro: 200_000, currency: "usd" } };
const policy = { maxTotalMsats: 300_000, autoPayBelowMsats: 200_000, maxIncrementMsats: 200_000, maxPayments: 3 };

function savedCreditPayment(jobId: string, requestSeq: number): CreditPaymentIntent {
  const credit = { credit_id: "credit", draw_id: "draw", request_seq: requestSeq, payment_id: "pending", ...ask.credit };
  return { request: ask, authorization: { ...credit, ...signDvmRequestData("01".repeat(32), credit,
    { audience: { dvm_id: "provider", builder_pubkey: "cd".repeat(32) }, method: "POST", path: `/v1/job/${jobId}/messages`, capability: null }) } };
}

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

it.each(["recovers", "reports stale status before recovering", "starts with two stale reads", "keeps timing out", "recovers with a saved credit authorization"])(
  "keeps watching an accepted decline when its confirmation %s", async (confirmation) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(start);
      const jobId = `decline-${confirmation.replaceAll(" ", "-")}`;
      const stopRequestedDisplay = "Stop recorded for the next payment ask.";
      const jobToken = "ab".repeat(32);
      const pendingCreditPayment = confirmation === "recovers with a saved credit authorization" ? savedCreditPayment(jobId, 4) : undefined;
      saveJob({ ...job, id: jobId, policy, jobToken, stopRequested: true, stopRequestedDisplay, pendingCreditPayment });
      const request: Message = { seq: 4, from: "provider", timestamp: start / 1000, type: "payment-request", content: ask };
      const cancel: Message = { seq: 5, from: "provider", timestamp: start / 1000 + 3, type: "cancel", content: { reason: "Declined" } };
      const provider = { endpoint: job.endpoint };
      let accepted = false;
      let terminal = false;
      let cancelInStream = false;
      let staleStatus = confirmation === "reports stale status before recovering";
      let consecutiveStaleReads = 0;
      const statusTimeouts: number[] = [];
      const status = vi.fn<Transport["status"]>(async (_id, _provider, options) => {
        if (!accepted) return { jobId, status: "awaiting-input" };
        const timeoutMs = options?.timeoutMs ?? 0;
        if (confirmation === "starts with two stale reads") {
          if (consecutiveStaleReads++ < 2) return { jobId, status: "awaiting-input" };
        } else if (statusTimeouts.length === 0 || confirmation === "keeps timing out") {
          statusTimeouts.push(timeoutMs);
          await new Promise((resolve) => setTimeout(resolve, timeoutMs));
          throw new DvmError("timeout", "Decline confirmation timed out");
        }
        if (staleStatus) {
          staleStatus = false;
          cancelInStream = true;
          return { jobId, status: "awaiting-input" };
        }
        terminal = true;
        return { jobId, status: "cancelled" };
      });
      const getMessages = vi.fn<Transport["getMessages"]>(async (_id, after) =>
        (terminal ? [request, cancel] : [request]).filter((message) => message.seq > after));
      const stream = vi.fn<NonNullable<Transport["stream"]>>(async () => ({ messages: cancelInStream ? [request, cancel] : [request], reason: "yield" }));
      const sendMessage = vi.fn<Transport["sendMessage"]>(async () => { accepted = true; });
      const transport = { status, getMessages, stream, sendMessage } as unknown as Transport;
      const until = confirmation === "keeps timing out" ? 3_000 : 8_000;
      const waiting = waitForJob({ jobId, transport, provider, policy, afterSeq: 2,
        afterSeqExplicit: true, timeoutMs: 1_500 }, until).catch((error: unknown) => ({ error }));
      await vi.runAllTimersAsync();
      const result = await waiting;

      expect(sendMessage.mock.calls.map(([, message]) => message.type)).toEqual(["decline"]);
      for (const [, , options] of status.mock.calls.slice(1)) expect(options?.jobToken).toBe(jobToken);
      expect(loadJob(jobId)).toMatchObject({ stopRequested: true, stopRequestedDisplay });
      if (confirmation === "keeps timing out") {
        expect(stream).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ nextAction: { type: "poll", hint: expect.stringContaining("wait limit (3s)") }, autoPayments: [] });
        expect(statusTimeouts).toEqual([1_500, 500]);
        expect(Date.now() - start).toBe(until);
        expect(loadJob(jobId)).toMatchObject({ status: "processing" });
        expect(loadJob(jobId)?.callerDeclined).toBeUndefined();
      } else {
        expect(result).toMatchObject({ providerStatus: { status: "cancelled" }, nextAction: null, messages: [request, cancel], autoPayments: [] });
        expect(statusTimeouts).toEqual(confirmation === "starts with two stale reads" ? [] : [1_500]);
        expect(loadJob(jobId)).toMatchObject({ status: "cancelled", callerCancelled: true, callerDeclined: true });
        if (pendingCreditPayment) expect(loadJob(jobId)?.pendingCreditPayment).toBeUndefined();
      }
    } finally {
      vi.useRealTimers();
    }
  },
);

it.each([
  { reply: "standing stop", source: "streamed ask" },
  { reply: "standing stop", source: "saved credit authorization" },
  { reply: "plain decline", source: "streamed ask" },
  { reply: "plain decline", source: "saved credit authorization" },
])("watches for a later prompt after a $reply acknowledgment for a $source", async ({ reply, source }) => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(start);
    const jobId = `${reply}-${source}`.replaceAll(" ", "-");
    const standingStop = reply === "standing stop";
    const pendingCreditPayment = source === "saved credit authorization" ? savedCreditPayment(jobId, 4) : undefined;
    saveJob({ ...job, id: jobId, policy, stopRequested: true, pendingCreditPayment });
    const request: Message = { seq: 4, from: "provider", timestamp: start / 1000, type: "payment-request", content: ask };
    const decline: Message = { seq: 5, from: "requester", timestamp: start / 1000 + 1, type: "decline", content: {} };
    const prompt: Message = { seq: 6, from: "provider", timestamp: start / 1000 + 2, type: "prompt", content: { id: "next", text: "Continue?" } };
    const display = "The job will stop at its next payment ask.";
    let stopAcknowledged = false;
    let readsAfterAck = 0;
    const sendMessage = vi.fn<Transport["sendMessage"]>(async () => {
      stopAcknowledged = true;
      return standingStop ? { seq: 4, stop_requested: true, display } : { seq: decline.seq };
    });
    const status = vi.fn<Transport["status"]>(async (_id, _provider, options) => {
      if (stopAcknowledged && ++readsAfterAck === 1 && standingStop) {
        await new Promise((resolve) => setTimeout(resolve, options?.timeoutMs));
        throw new DvmError("timeout", "Status read timed out");
      }
      return { jobId, status: "awaiting-input" };
    });
    const messages = standingStop ? [request, prompt] : [request, decline, prompt];
    const stream = vi.fn<NonNullable<Transport["stream"]>>(async (_id, after) => ({
      messages: (readsAfterAck > (standingStop ? 2 : 1) ? messages : [request]).filter((message) => message.seq > after), reason: "yield",
    }));
    const getMessages = vi.fn<Transport["getMessages"]>().mockResolvedValue([request]);
    const transport = { status, getMessages, stream, sendMessage } as unknown as Transport;
    const waiting = waitForJob({ jobId, transport, provider: { endpoint: job.endpoint }, policy, afterSeq: 2,
      afterSeqExplicit: true, timeoutMs: 1_500 }, 12_000).catch((error: unknown) => ({ error }));
    await vi.runAllTimersAsync();

    expect(await waiting).toMatchObject({ messages, nextAction: { type: "respond", prompt_id: "next" }, autoPayments: [] });
    expect(sendMessage.mock.calls.map(([, message]) => message.type)).toEqual(["decline"]);
    expect(loadJob(jobId)).toMatchObject({ stopRequested: true });
    if (standingStop) expect(loadJob(jobId)?.stopRequestedDisplay).toBe(display);
    expect(loadJob(jobId)?.pendingCreditPayment).toEqual(pendingCreditPayment);
    expect(loadJob(jobId)?.callerDeclined).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it.each(["timeout", "provider_error"])("returns streamed completion when another status read would fail with %s", async (code) => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(start);
    const jobId = `decline-completion-${code}`;
    saveJob({ ...job, id: jobId, policy, stopRequested: true });
    const request: Message = { seq: 4, from: "provider", timestamp: start / 1000, type: "payment-request", content: ask };
    const complete: Message = { seq: 6, from: "provider", timestamp: start / 1000 + 1, type: "complete", content: { summary: "Finished" } };
    const status = vi.fn<Transport["status"]>(async (_id, _provider, options) => {
      if (code === "timeout") await new Promise((resolve) => setTimeout(resolve, options?.timeoutMs));
      throw new DvmError(code, "Status unavailable");
    }).mockResolvedValueOnce({ jobId, status: "awaiting-input" }).mockResolvedValueOnce({ jobId, status: "processing" });
    const stream = vi.fn<NonNullable<Transport["stream"]>>()
      .mockResolvedValueOnce({ messages: [request], reason: "yield" })
      .mockResolvedValueOnce({ messages: [complete], reason: "complete" });
    const sendMessage = vi.fn<Transport["sendMessage"]>().mockResolvedValue({ seq: 5 });
    const getMessages = vi.fn<Transport["getMessages"]>().mockResolvedValue([request]);
    const transport = { status, getMessages, stream, sendMessage } as unknown as Transport;
    const waiting = waitForJob({ jobId, transport, provider: { endpoint: job.endpoint }, policy, afterSeq: 2,
      afterSeqExplicit: true, timeoutMs: 1_500 }, 8_000).catch((error: unknown) => ({ error }));
    await vi.runAllTimersAsync();

    expect(await waiting).toMatchObject({ messages: [request, complete], cursor: 6, nextAction: null, autoPayments: [] });
    expect(status).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls.map(([, message]) => message.type)).toEqual(["decline"]);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["after the decline in the stream", "after the decline in terminal history", "after an echoed decline", "before the decline"])(
  "attributes cancellation using the position of working messages %s", async (workPosition) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(start);
      const jobId = `decline-working-${workPosition.replaceAll(" ", "-")}`;
      const pendingCreditPayment = savedCreditPayment(jobId, 4);
      saveJob({ ...job, id: jobId, policy, stopRequested: true, pendingCreditPayment });
      const request: Message = { seq: 4, from: "provider", timestamp: start / 1000, type: "payment-request", content: ask };
      const decline: Message = { seq: 6, from: "requester", timestamp: start / 1000 + 1, type: "decline", content: {} };
      const workBeforeDecline = workPosition === "before the decline";
      const working: Message = { seq: workBeforeDecline ? 5 : 7, from: "provider", timestamp: start / 1000 + 1, type: "working", content: {} };
      const cancel: Message = { seq: 8, from: "provider", timestamp: start / 1000 + 2, type: "cancel", content: { reason: "Cancelled" } };
      const liveMessages = workBeforeDecline ? [request, working, decline] : [request, decline, working];
      const sendMessage = vi.fn<Transport["sendMessage"]>().mockResolvedValue(workPosition === "after an echoed decline" ? undefined : { seq: decline.seq });
      const status = vi.fn<Transport["status"]>().mockResolvedValue({ jobId, status: "cancelled" })
        .mockResolvedValueOnce({ jobId, status: "awaiting-input" });
      if (workPosition !== "after the decline in terminal history") status.mockResolvedValueOnce({ jobId, status: "processing" });
      const stream = vi.fn<NonNullable<Transport["stream"]>>(async (_id, after) => ({
        messages: liveMessages.filter((message) => message.seq > after), reason: "yield",
      }));
      const getMessages = vi.fn<Transport["getMessages"]>(async (_id, after) =>
        [...liveMessages, cancel].filter((message) => message.seq > after)).mockResolvedValueOnce([request]);
      const transport = { status, getMessages, stream, sendMessage } as unknown as Transport;
      const waiting = waitForJob({ jobId, transport, provider: { endpoint: job.endpoint }, policy, afterSeq: 2,
        afterSeqExplicit: true, timeoutMs: 1_500 }, 8_000).catch((error: unknown) => ({ error }));
      await vi.runAllTimersAsync();

      expect(await waiting).toMatchObject({ messages: [...liveMessages, cancel], providerStatus: { status: "cancelled" }, nextAction: null, autoPayments: [] });
      expect(sendMessage.mock.calls.map(([, message]) => message.type)).toEqual(["decline"]);
      const saved = loadJob(jobId);
      expect(saved?.callerDeclined).toBe(workBeforeDecline ? true : undefined);
      expect(saved?.callerCancelled).toBe(workBeforeDecline ? true : undefined);
      expect(saved?.pendingCreditPayment).toEqual(workBeforeDecline ? undefined : pendingCreditPayment);
      expect(saved?.stopRequested).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  },
);

it("surfaces a timeout in the decline send without retrying it or reading confirmation", async () => {
  const jobId = "decline-send-timeout";
  saveJob({ ...job, id: jobId, stopRequested: true });
  const request: Message = { seq: 4, from: "provider", timestamp: start / 1000, type: "payment-request", content: ask };
  const status = vi.fn<Transport["status"]>().mockResolvedValue({ jobId, status: "awaiting-input" });
  const sendFailure = new DvmError("timeout", "Decline send timed out");
  const sendMessage = vi.fn<Transport["sendMessage"]>().mockRejectedValue(sendFailure);
  const transport = { status, sendMessage,
    getMessages: vi.fn<Transport["getMessages"]>().mockResolvedValue([request]) } as unknown as Transport;

  await expect(waitForJob({ jobId, transport, provider: { endpoint: job.endpoint }, afterSeq: 2,
    afterSeqExplicit: true }, 3_000)).rejects.toBe(sendFailure);
  expect(sendMessage.mock.calls.map(([, message]) => message.type)).toEqual(["decline"]);
  expect(status).toHaveBeenCalledTimes(1);
});
