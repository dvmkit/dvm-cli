import { DvmError, isAbortError, type Message } from "@dvmkit/sdk/internal";
import { clearPaymentRequestInFlight, loadJob, markPaymentRequestPaid } from "./job-store";
import { createMessageAppendSession, maxSeq } from "./messages";
import { loadAnsweredYieldSeqs, answeredYieldSeqs } from "./yield-state";
import { claimInboundPayments, withRefundNextAction } from "./refund-claim";
import { isTerminalJobStatus, pollNextAction } from "./next-action";
import { streamLoop, type StreamLoopOptions, type StreamLoopResult } from "./stream-loop";

export async function waitForJob(opts: StreamLoopOptions, durationMs: number): Promise<StreamLoopResult> {
  const deadline = Date.now() + durationMs;
  const result: StreamLoopResult = {
    messages: [], autoPayments: [], refunds: [], cursor: opts.afterSeq,
    nextAction: pollNextAction(opts.jobId),
  };
  const messageAppendSession = opts.persistLocalState === false ? undefined
    : (opts.messageAppendSession ?? createMessageAppendSession(opts.jobId));
  let backoffMs = 1000;
  let firstRead = true;
  const idleTimeoutMs = opts.timeoutMs ?? 60_000;
  async function readWithRetry<T>(read: () => Promise<T>): Promise<T | undefined> {
    while (Date.now() < deadline) {
      try { return await read(); }
      catch (error) {
        if (!isAbortError(error) && !(error instanceof DvmError && error.code === "timeout")) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(backoffMs, Math.max(0, deadline - Date.now()))));
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
    return undefined;
  }
  while (Date.now() < deadline) {
    const readOptions = () => ({ jobToken: opts.jobToken, timeoutMs: Math.max(1, Math.min(idleTimeoutMs, deadline - Date.now())) });
    const snapshot = await readWithRetry(() => opts.transport.status(opts.jobId, opts.provider, readOptions()));
    if (!snapshot) break;
    if (isTerminalJobStatus(snapshot.status)) {
      result.nextAction = null;
      const history = await readWithRetry(() => opts.transport.getMessages(opts.jobId, result.cursor, opts.provider, readOptions()));
      if (!history) break;
      const tail = history.filter((message) => message.seq > result.cursor);
      result.messages.push(...tail);
      result.cursor = maxSeq(tail, result.cursor);
      for (const message of tail) opts.onMessage?.(message);
      if (opts.persistLocalState !== false) {
        messageAppendSession?.append(tail);
        result.refunds.push(...await claimInboundPayments(opts.jobId, tail));
      }
      result.nextAction = withRefundNextAction(opts.jobId, null, result.refunds);
      break;
    }
    // A previous command may have advanced the cursor past an unanswered yield.
    const inFlight = opts.persistLocalState === false ? [] : loadJob(opts.jobId)?.inFlightPaymentRequestSeqs ?? [];
    if (firstRead && (inFlight.length || (!opts.afterSeqExplicit && snapshot.status === "awaiting-input"))) {
      const history = await readWithRetry(() => opts.transport.getMessages(opts.jobId, 0, opts.provider, readOptions()));
      if (!history) break;
      messageAppendSession?.append(history);
      const answered = opts.persistLocalState === false ? new Set<number>() : loadAnsweredYieldSeqs(opts.jobId);
      for (const seq of answeredYieldSeqs(history)) answered.add(seq);
      for (const seq of inFlight) {
        if (answered.has(seq)) markPaymentRequestPaid(opts.jobId, seq);
        else clearPaymentRequestInFlight(opts.jobId, seq);
      }
      const pending = history.findLast((msg: Message) =>
        ["prompt", "payment-request", "working", "complete", "cancel"].includes(msg.type) && !answered.has(msg.seq));
      if (!opts.afterSeqExplicit && (pending?.type === "prompt" || pending?.type === "payment-request"))
        result.cursor = Math.min(result.cursor, pending.seq - 1);
    }
    firstRead = false;
    if (Date.now() >= deadline) break;
    // streamLoop handles read timeouts at the read boundary. Payment failures
    // must propagate because the provider may already have accepted the send.
    const next = await streamLoop({
      ...opts, messageAppendSession, afterSeq: result.cursor,
      timeoutMs: readOptions().timeoutMs,
    });
    result.messages.push(...next.messages);
    result.autoPayments.push(...next.autoPayments);
    result.refunds.push(...next.refunds);
    const progressed = next.cursor > result.cursor;
    result.cursor = next.cursor;
    result.nextAction = next.nextAction;
    if (next.nextAction?.type !== "poll") break;
    if (progressed) backoffMs = 1000;
    const delay = Math.min(backoffMs, Math.max(0, deadline - Date.now()));
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    backoffMs = Math.min(backoffMs * 2, 30_000);
  }
  return result;
}
