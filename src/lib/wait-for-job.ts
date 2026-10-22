import { withJobPaymentLock } from "./payment-lock";
import { DvmError, isAbortError, type Message } from "@dvmkit/sdk/internal";
import { loadJob } from "./job-store";
import { createMessageAppendSession, maxSeq } from "./messages";
import { loadAnsweredYieldSeqs, answeredYieldSeqs, reconcilePaymentRequestHistory, JOB_READ_TIMEOUT_MS } from "./yield-state";
import { claimInboundPayments, withRefundNextAction } from "./refund-claim";
import { isTerminalJobStatus, pollNextAction } from "./next-action";
import { streamLoop, type StreamLoopOptions, type StreamLoopResult } from "./stream-loop";

export async function waitForJob(opts: StreamLoopOptions, durationMs: number, now: () => number = Date.now): Promise<StreamLoopResult> {
  const deadline = now() + durationMs;
  const result: StreamLoopResult = {
    messages: [], autoPayments: [], refunds: [], cursor: opts.afterSeq,
    nextAction: pollNextAction(opts.jobId),
  };
  const returnedSeqs = new Set<number>();
  const emittedSeqs = new Set<number>();
  const collectMessages = (messages: Message[]) => {
    for (const message of messages) if (!returnedSeqs.has(message.seq)) {
      returnedSeqs.add(message.seq);
      result.messages.push(message);
    }
  };
  const onMessage = (message: Message) => {
    if (emittedSeqs.has(message.seq)) return;
    emittedSeqs.add(message.seq);
    opts.onMessage?.(message);
  };
  const messageAppendSession = opts.persistLocalState === false ? undefined
    : (opts.messageAppendSession ?? createMessageAppendSession(opts.jobId));
  let backoffMs = 1000;
  let firstRead = true;
  const idleTimeoutMs = opts.timeoutMs ?? JOB_READ_TIMEOUT_MS;
  async function readWithRetry<T>(read: () => Promise<T>): Promise<T | undefined> {
    while (now() < deadline) {
      try { return await read(); }
      catch (error) {
        if (!isAbortError(error) && !(error instanceof DvmError && error.code === "timeout")) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(backoffMs, Math.max(0, deadline - now()))));
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
    return undefined;
  }
  while (now() < deadline) {
    const readOptions = () => ({ jobToken: opts.jobToken, timeoutMs: Math.max(1, Math.min(idleTimeoutMs, deadline - now())) });
    const snapshot = await readWithRetry(() => opts.transport.status(opts.jobId, opts.provider, readOptions()));
    if (!snapshot) break;
    if (isTerminalJobStatus(snapshot.status)) {
      result.nextAction = null;
      const history = await readWithRetry(() => opts.transport.getMessages(opts.jobId, result.cursor, opts.provider, readOptions()));
      if (!history) break;
      const tail = history.filter((message) => message.seq > result.cursor);
      collectMessages(tail);
      result.cursor = maxSeq(tail, result.cursor);
      for (const message of tail) onMessage(message);
      if (opts.persistLocalState !== false) {
        messageAppendSession?.append(tail);
        result.refunds.push(...await claimInboundPayments(opts.jobId, tail));
      }
      result.nextAction = withRefundNextAction(opts.jobId, null, result.refunds);
      break;
    }
    // A previous command may have advanced the cursor past an unanswered yield.
    const inFlight = opts.persistLocalState === false ? [] : loadJob(opts.jobId)?.inFlightPaymentRequestSeqs ?? [];
    let cursorLimit = Infinity;
    let streamAfter = result.cursor;
    if (inFlight.length || (firstRead && !opts.afterSeqExplicit && snapshot.status === "awaiting-input")) {
      let unresolved = false;
      let retryDelayMs = backoffMs;
      let history: Message[] | undefined;
      try {
        history = await readWithRetry(() => withJobPaymentLock(opts.jobId, async (assertOwned) => {
          const messages = await opts.transport.getMessages(opts.jobId, 0, opts.provider, readOptions());
          assertOwned();
          for (const seq of loadJob(opts.jobId)?.inFlightPaymentRequestSeqs ?? []) {
            try { reconcilePaymentRequestHistory(opts.jobId, seq, messages, snapshot.status, now); }
            catch (error) {
              if (!(error instanceof DvmError) || !["payment_settling", "payment_request_not_pending"].includes(error.code)) throw error;
              if (!loadJob(opts.jobId)?.inFlightPaymentRequestSeqs?.includes(seq)) continue;
              unresolved = true;
              cursorLimit = Math.min(cursorLimit, seq - 1);
              if (typeof error.data?.retry_at_ms === "number")
                retryDelayMs = Math.min(retryDelayMs, Math.max(1, error.data.retry_at_ms - now()));
            }
          }
          return messages;
        }));
      } catch (error) {
        if (!(error instanceof DvmError) || error.code !== "payment_settling") throw error;
        unresolved = true;
        cursorLimit = Math.min(...inFlight.map((seq) => seq - 1));
        // Read-only progress is safe while another process owns the payment.
        history = await readWithRetry(() => opts.transport.getMessages(opts.jobId, 0, opts.provider, readOptions()));
      }
      if (!history) break;
      messageAppendSession?.append(history);
      const answered = opts.persistLocalState === false ? new Set<number>() : loadAnsweredYieldSeqs(opts.jobId);
      for (const seq of answeredYieldSeqs(history)) answered.add(seq);
      const pending = history.findLast((msg: Message) => msg.from === "provider" &&
        ["prompt", "payment-request", "working", "complete", "cancel"].includes(msg.type) && !answered.has(msg.seq));
      const newerYield = snapshot.status === "awaiting-input" && pending && !answered.has(pending.seq) &&
        (pending.type === "prompt" || pending.type === "payment-request") && !inFlight.includes(pending.seq);
      if (unresolved) {
        const limit = newerYield ? pending.seq - 1 : Infinity;
        const tail = history.filter((message) => message.seq > Math.max(opts.afterSeq, result.cursor) && message.seq <= limit);
        collectMessages(tail);
        result.cursor = Math.min(maxSeq(tail, result.cursor), cursorLimit);
        for (const message of tail) onMessage(message);
        if (opts.persistLocalState !== false)
          result.refunds.push(...await claimInboundPayments(opts.jobId, tail));
      }
      if (unresolved && !newerYield) {
        result.nextAction = pollNextAction(opts.jobId);
        await new Promise((resolve) => setTimeout(resolve, Math.min(retryDelayMs, Math.max(0, deadline - now()))));
        backoffMs = Math.min(backoffMs * 2, 30_000);
        continue;
      }
      streamAfter = result.cursor;
      // Read the newer question without letting the returned cursor strand the older charge.
      if (unresolved && newerYield) streamAfter = pending.seq - 1;
      if (pending && !answered.has(pending.seq) && (!opts.afterSeqExplicit || inFlight.includes(pending.seq)) &&
          (pending.type === "prompt" || pending.type === "payment-request"))
        streamAfter = Math.min(streamAfter, pending.seq - 1);
    }
    firstRead = false;
    if (now() >= deadline) break;
    // streamLoop handles read timeouts at the read boundary. Payment failures
    // must propagate because the provider may already have accepted the send.
    const next = await streamLoop({
      ...opts, onMessage, messageAppendSession, afterSeq: streamAfter,
      timeoutMs: readOptions().timeoutMs,
    });
    collectMessages(next.messages);
    result.autoPayments.push(...next.autoPayments);
    result.refunds.push(...next.refunds);
    const progressed = next.cursor > result.cursor;
    result.cursor = Math.min(next.cursor, cursorLimit);
    result.nextAction = next.nextAction;
    if (next.nextAction?.type !== "poll") break;
    if (progressed) backoffMs = 1000;
    const delay = Math.min(backoffMs, Math.max(0, deadline - now()));
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    backoffMs = Math.min(backoffMs * 2, 30_000);
  }
  if (opts.persistLocalState !== false) {
    const remaining = loadJob(opts.jobId)?.inFlightPaymentRequestSeqs ?? [];
    result.cursor = Math.min(result.cursor, ...remaining.map((seq) => seq - 1));
  }
  result.messages.sort((a, b) => a.seq - b.seq);
  return result;
}
