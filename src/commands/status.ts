import { createHash } from "node:crypto";
import { rememberStandingStop, standingStopOutput } from "../lib/mandate-wait";
import { storedMandateSummary } from "../lib/mandate-payments";
import { readTerminalCompletion, terminalCompletionOutput } from "../lib/terminal-completion";
import { readUnansweredPaymentRequest } from "../lib/unanswered-payment";
import { providerJobJson } from "../lib/provider-output";
import { jobSpend, renderSpendHuman } from "../lib/job-spend";
import { terminalSettlementReport } from "../lib/job-settlement";
import { formatMessageHuman } from "../lib/message-human";
import { printNextActionHuman } from "../lib/next-action-human";
import { finalizeProgressLine } from "../lib/progress-bar";
import { createArtifactSaveSession } from "../lib/save-artifact";
import { type PaymentPolicyContext, isTerminalJobStatus, type NextAction, pollNextAction } from "../lib/next-action";
import { readNextAction } from "../lib/read-next-action";
import { answeredYieldSeqs, settleRecordedPayments } from "../lib/yield-state";
import { completionSnapshot, type JobCompletion } from "../lib/completion-hints";
import {
  type JobStatus,
  type Message,
  type ProviderRef,
  type Transport,
  verifyJobReceipt,
} from "@dvmkit/sdk/internal";
import {
  backfillTrustAnchor,
  captureTransportReceipt,
  fetchMissingJobReceipt,
  type ReceiptCapture,
  receiptJsonFields,
  renderReceiptHuman,
  replayStoredReceipt,
  toCapture,
} from "../lib/receipt-capture";
import {
  getOutputTraceId,
  info,
  withOutputWarnings,
} from "../lib/output";
import {
  type JobRecord,
  type StatusMessageHistory,
  loadJob,
  markJobTerminal,
  recordStatusMessageHistory,
  updateObservedJob,
} from "../lib/job-store";
import {
  receiptHint,
} from "../lib/receipt-verify";

import { type ContentStatus, jobContentFields } from "../lib/job-content";
import { takeCreditNoticeFields } from "../lib/credit-notice";
import { settleCreditAfterRead } from "../lib/credit-topup";
import { providerCurrency } from "../lib/provider-currency";
import { captureDrawFundingReceipts } from "../lib/draw-funding";
import { formatIdentifier } from "../lib/dvm-identifier";
import { takeFeedbackNoticeFields } from "../lib/feedback-notice";
import { noteFeedbackAfterTerminal } from "../lib/feedback-nudges";
import {
  type JobAccessOptions,
  type ResolvedJobAccess,
  resolveJobAccess,
  withJobTokenRedaction,
} from "../lib/job-access";
import { appendMessages, loadMessages, maxSeq } from "../lib/messages/index";
import { progressNotice } from "../lib/progress-notice";
import { createDvmTransport } from "../lib/transport/index";
import { dvmIdentity } from "./dvm-identity";
import { serializeJobMessageForOutput } from "./messages";

export interface StatusOptions extends JobAccessOptions {
  human?: boolean;
  /** How long to wait (in seconds) for a result before returning (default: 5) */
  timeout?: string;
  messages?: boolean;
}

export async function status(jobId: string, opts: StatusOptions): Promise<void> {
  const access = resolveJobAccess(jobId, opts);
  return withJobTokenRedaction(access.jobToken, () => withOutputWarnings(() => statusWithAccess(jobId, opts, access), opts.human));
}

async function statusWithAccess(
  jobId: string,
  opts: StatusOptions,
  access: ResolvedJobAccess
): Promise<void> {
  const { stored, ref, jobToken } = access;
  const timeout = opts.timeout ? Number(opts.timeout) * 1000 : 5000;
  const readOptions = { timeoutMs: timeout, jobToken };

  // Replay terminal evidence locally. Legacy failed/cancelled snapshots may
  // backfill artifact counts; --messages still explicitly fetches unread output.
  if (
    stored &&
    !access.overridden &&
    isTerminalJobStatus(stored.status) &&
    (stored.completion || stored.status !== "completed") &&
    !opts.messages
  ) {
    // re-verify the snapshotted receipt rather than replaying a
    // cached verdict — a tampered `jobs.json` must answer `invalid`.
    let receipt = replayStoredReceipt(stored);
    let terminalStatus = stored.status;
    let completion = stored.completion ?? {};
    let content: Partial<ContentStatus> | undefined;
    const transport = createDvmTransport();

    // a terminal snapshot can predate the receipt that the DVM now
    // serves. Spend one best-effort read only when the DVM advertised receipts
    // and the local record has none. Reconcile any terminal provider status;
    // retain the saved completion fields when the read has no content.
    if (stored.receiptsSupported && receipt.status === "absent") {
      const fetched = await fetchMissingJobReceipt(jobId, transport, ref);
      if (fetched.status && isTerminalJobStatus(fetched.status)) {
        content = fetched;
        const saved = stored.status === fetched.status ? completion : undefined;
        terminalStatus = fetched.status;
        completion = fetched.content_available === false && saved
          ? saved
          : { ...saved, ...completionSnapshot(fetched) };
        markJobTerminal(jobId, terminalStatus, completion);
      }
      if (fetched.receipt || fetched.receiptParseError) {
        if (fetched.receipt && !stored.builderAnchor) {
          await backfillTrustAnchor(jobId, transport, ref);
        }
        receipt = captureTransportReceipt(jobId, fetched);
      }
    }
    if (terminalStatus !== "completed" && completion.hasArtifacts === undefined && content?.content_available !== false) {
      completion = await readTerminalCompletion({
        jobId, status: { ...completion, ...content, status: terminalStatus },
        transport, ref, ...readOptions,
        ...(stored.mandate && { readMessages: async () => {
          const { batch, history } = await readStatusMessages(jobId, access, transport, {
            ...readOptions, status: terminalStatus,
          });
          return history ?? batch;
        } }),
      });
      markJobTerminal(jobId, terminalStatus, completion);
    }
    await settleCreditAfterRead({ job: stored, capture: receipt, transport, human: opts.human });
    const unanswered = await readUnansweredPaymentRequest(jobId, terminalStatus, access, transport, { localOnly: true });
    transport.close();

    await renderStatus(jobId, stored, terminalStatus, completion, "local", null, opts, {
      receipt, content, unanswered,
    });
    return;
  }

  const transport = createDvmTransport();

  progressNotice("Checking job status...", opts.human);

  // thread the per-job opaque token (issued for anonymous callers
  // at create-time) into status / messages reads as `X-Job-Token`.
  const result: ContentStatus = await transport.status(jobId, ref, readOptions);
  if (stored && !access.endpointOverridden) captureDrawFundingReceipts(jobId, result.drawFundingReceipts, { endpoint: ref.endpoint });

  if (!access.endpointOverridden && result.stop_requested) rememberStandingStop(jobId, result.display);
  const { batch: msgs, history, cursor: newCursor } = opts.messages || (stored?.mandate && !access.endpointOverridden)
    ? await readStatusMessages(jobId, access, transport, {
      ...readOptions, status: result.status, deliver: opts.messages, contentAvailable: result.content_available,
    })
    : { batch: [] };

  const nextAction = await resolveNextAction(jobId, result.status, msgs, history, transport, ref, {
    ...readOptions,
    context: access.endpointOverridden ? undefined : stored ?? undefined,
    ignoreLocalState: access.endpointOverridden,
  });

  // Update job store if we learned something new. A terminal read snapshots the
  // outcome so every later `dvm status` replays this exact payload.
  let completion = completionSnapshot(result);
  const reasonUnavailable = completion.message === undefined ||
    (result.content_available === false && completion.message === "");
  if (reasonUnavailable && (result.status === "failed" || result.status === "cancelled")) {
    const savedReason = !access.endpointOverridden && stored?.status === result.status
      ? stored.completion?.message : undefined;
    const terminal = (history ?? msgs).findLast((message) =>
      message.type === "complete" || message.type === "cancel" || message.type === "decline");
    const reason = savedReason ?? (terminal?.type === "cancel" || terminal?.type === "decline" ? terminal.content.reason : undefined);
    if (reason !== undefined) completion.message = reason;
  }
  if (isTerminalJobStatus(result.status)) {
    completion = await readTerminalCompletion({
      jobId, status: { ...result, ...completion }, transport, ref, jobToken, timeoutMs: timeout,
      saved: !access.endpointOverridden && stored?.status === result.status ? stored.completion : undefined,
      ...(history && { readMessages: async () => history }),
    });
  }
  let receipt: ReceiptCapture | undefined;
  let currency: string | undefined;
  if (isTerminalJobStatus(result.status)) {
    if (stored && !access.endpointOverridden) {
      // Provider redaction must not erase an output snapshot already saved here.
      // Render the fresh response below; retain the local snapshot only in storage.
      const savedCompletion =
        result.content_available === false && stored.status === result.status && stored.completion
          ? stored.completion
          : completion;
      markJobTerminal(jobId, result.status, savedCompletion, {
        ...(newCursor !== undefined ? { messageCursor: newCursor } : {}),
      });
    }
    // this is the recovery capture point. A receipt the submit path
    // never saw — an async job, a dropped SSE, a job that predates receipts
    // landing — is collected here on the next read. Backfill the trust anchor
    // first when the record has none, so a receipt that *can* chain to a
    // builder identity isn't recorded as merely unattested.
    if (stored && result.receipt && !stored.builderAnchor && !access.endpointOverridden) {
      await backfillTrustAnchor(jobId, transport, ref);
    }
    // Receipt capture persists the endpoint association. With no record, or
    // when this read deliberately targets another endpoint, keep the override
    // request-scoped instead of filing proof under stale local metadata.
    currency = stored && !access.endpointOverridden ? undefined
      : await providerCurrency({ receipt: result.receipt, status: result, messages: msgs, transport, ref });
    receipt =
      stored && !access.endpointOverridden
        ? captureTransportReceipt(jobId, result)
        : transientReceiptCapture(jobId, result, ref.endpoint, currency);
    if (stored && !access.endpointOverridden) {
      await settleCreditAfterRead({ job: stored, capture: receipt, transport, human: opts.human });
    }
    // this wire read is where a `--no-stream` job's terminal is
    // learned, so it is the arc's one nudge moment — gated on the stored
    // record not being terminal yet, because a re-read of a finished job (the
    // local-snapshot replay above, or `--messages` going to the wire) is not
    // the CLI learning anything new.
    if (stored && !access.endpointOverridden && !isTerminalJobStatus(stored.status)) {
      noteFeedbackAfterTerminal({
        jobId,
        dvmId: stored.dvmId,
        endpoint: stored.endpoint,
        status: result.status,
        human: opts.human,
      });
    }
  } else if (stored && !access.endpointOverridden) {
    const updates: Record<string, unknown> = {};
    if (result.status === "processing") updates.status = "processing";
    if (newCursor !== undefined) updates.messageCursor = newCursor;
    if (Object.keys(updates).length > 0) updateObservedJob(jobId, updates);
  }

  const unanswered = await readUnansweredPaymentRequest(jobId, result.status, access, transport, {
    messages: history ?? msgs, fullHistory: history !== undefined,
    timeoutMs: timeout, localOnly: result.content_available === false,
  });
  transport.close();

  await renderStatus(jobId, stored, result.status, completion, "provider", nextAction, opts, {
    msgs,
    cursor: newCursor,
    receipt,
    content: result,
    currency,
    unanswered,
  });
}

/** Verify receipt output without filing an override endpoint or token in local state. */
function transientReceiptCapture(
  jobId: string,
  response: Pick<JobStatus, "receipt" | "receiptParseError">,
  endpoint: string,
  currency?: string
): ReceiptCapture {
  if (response.receiptParseError) {
    return {
      status: "unparseable",
      reason: response.receiptParseError,
      display:
        "UNREADABLE receipt: this DVM returned a receipt block that does not match the signed receipt protocol shape. The job itself is unaffected.",
    };
  }
  if (!response.receipt) return { status: "absent", display: receiptHint("absent") };

  const result = verifyJobReceipt({ receipt: response.receipt, expectedJobId: jobId });
  // An override read must not borrow another endpoint's local record.
  return toCapture(response.receipt, result, { currency }, endpoint);
}

/**
 * Render one `dvm status` response. Both exit paths — the stored-snapshot
 * replay and the wire read — funnel through here so a finished job carries the
 * same field set whichever served it. `source` tells the agent which
 * one did: `"local"` is a replay of the snapshot taken at the first terminal
 * read, `"provider"` a fresh read.
 */
async function renderStatus(
  jobId: string,
  stored: JobRecord | null,
  jobStatus: string,
  completion: JobCompletion,
  source: "local" | "provider",
  nextAction: NextAction,
  opts: StatusOptions,
  fetched?: { msgs?: Message[]; cursor?: number; receipt?: ReceiptCapture; content?: Partial<ContentStatus>; currency?: string;
    unanswered?: Awaited<ReturnType<typeof readUnansweredPaymentRequest>> }
): Promise<void> {
  const identifier = stored?.dvmId ? formatIdentifier(stored.dvmId, stored.capability) : undefined;
  const artifacts = terminalCompletionOutput(jobId, jobStatus, completion, {
    human: opts.human, contentAvailable: fetched?.content?.content_available,
  });
  const msgs = fetched?.msgs ?? [];
  const receipt = fetched?.receipt;
  const content = jobContentFields(jobId, fetched?.content, opts.human);
  const spend = stored ? jobSpend({ ...(loadJob(jobId) ?? stored),
    status: jobStatus as JobRecord["status"] }, receipt?.receipt) : undefined;
  const settlement = await terminalSettlementReport(jobId, { status: jobStatus, receipt: receipt?.receipt,
    persistLocalState: !!stored, currency: fetched?.currency });

  const pendingStop = stored && !isTerminalJobStatus(jobStatus) ? standingStopOutput(loadJob(jobId)) : {};

  if (opts.human) {
    if (jobStatus === "completed" && completion.summary) {
      info(`Summary:`);
      console.log(completion.summary);
    } else {
      info(`Status: ${jobStatus}${identifier ? ` [${identifier}]` : ""}`);
      if (completion.message) info(`  ${completion.message}`);
    }
    if (pendingStop.display) info(pendingStop.display);
    if (stored) {
      const mandate = storedMandateSummary(jobId);
      if (mandate.overcharged) info(mandate.display!);
    }
    if (fetched?.unanswered) info(fetched.unanswered.display);
    if (artifacts.hint) info(`📎 ${artifacts.hint}`);
    info(String(content.content_hint));
    if (msgs.length > 0) {
      info(`\n${msgs.length} new message(s):`);
      const artifactSession = createArtifactSaveSession();
      for (const msg of msgs) formatMessageHuman(msg, jobId, artifactSession);
      finalizeProgressLine();
    }
    const traceId = getOutputTraceId();
    if (traceId) info(`Trace: ${traceId}`);
    if (spend) renderSpendHuman(spend, info);
    else if (settlement.settlement) info(settlement.settlement.display);
    if (settlement.wallet_remaining) info(settlement.wallet_remaining.display);
    if (receipt) await renderReceiptHuman(receipt);
    // The receipt line already explained the same unlabelled amounts.
    if (settlement.settlement_hint && !receipt?.currencyHint) info(`  ${settlement.settlement_hint}`);
    printNextActionHuman(nextAction);
    return;
  }

  const output: Record<string, unknown> = {
    jobId,
    ...(stored?.transactionHash ? { transaction_hash: stored.transactionHash } : {}),
    ...dvmIdentity(stored?.dvmId, stored?.capability),
    status: jobStatus,
    source,
    _provider_fields: [
      ...(completion.summary ? ["summary"] : []),
      ...(completion.message ? ["message"] : []),
    ],
    ...content,
    ...(completion.summary ? { summary: completion.summary } : {}),
    ...artifacts.fields,
    ...(artifacts.display ? { display: artifacts.display } : {}),
    ...(completion.message ? { message: completion.message } : {}),
    ...(fetched?.unanswered ? { unanswered_payment_request: fetched.unanswered } : {}),
    // terminal responses only. On a still-running job "absent" would
    // read as "this DVM doesn't issue receipts" rather than "not yet".
    ...(receipt ? await receiptJsonFields(receipt) : {}),
    ...settlement,
    ...pendingStop,
    ...(pendingStop.display ? { stop_display: pendingStop.display } : {}),
    ...(stored ? storedMandateSummary(jobId) : {}),
    ...(receipt?.currencyHint ? { settlement_hint: undefined } : {}),
    // `dvm status` is a job-terminal emission for `--no-stream`
    // jobs, so it drains the deferred-notice sinks like the request terminals
    // do. Both spread blind and are absent when nothing was stashed.
    ...takeCreditNoticeFields(),
    ...takeFeedbackNoticeFields(),
    ...(spend ? { spend } : {}),
    next_action: nextAction,
  };
  if (opts.messages) {
    output.messages = msgs.map((msg) => serializeJobMessageForOutput(msg, stored ? jobId : undefined));
    output.cursor = fetched?.cursor ?? 0;
  }
  providerJobJson(output, !!stored);
}

async function readStatusMessages(
  jobId: string,
  access: ResolvedJobAccess,
  transport: Transport,
  { status, deliver, contentAvailable, ...readOptions }: {
    status: string; timeoutMs: number; jobToken?: string; deliver?: boolean; contentAvailable?: boolean;
  }
): Promise<{ batch: Message[]; history?: Message[]; cursor?: number }> {
  const stored = access.endpointOverridden ? null : access.stored;
  const deliveryAfter = stored?.messageCursor ?? 0;
  const useCache = !!stored?.mandate && contentAvailable !== false;
  const cached = useCache ? loadMessages(jobId) : [];
  const checkpoint = stored?.statusMessageHistory;
  const covered = statusHistoryCursor(cached, status, checkpoint);
  // A delivery cursor can skip messages the payment reconciler still needs.
  const after = deliver ? (useCache ? Math.min(deliveryAfter, covered) : deliveryAfter) : covered;
  const tail = await transport.getMessages(jobId, after, access.ref, readOptions);
  const history = contentAvailable !== false && (useCache || after === 0)
    ? [...new Map([...cached.filter((message) => message.seq <= after), ...tail]
      .map((message) => [message.seq, message])).values()].sort((a, b) => a.seq - b.seq)
    : undefined;

  if (!access.endpointOverridden) {
    appendMessages(jobId, tail);
    const fullHistoryThrough = history === undefined ? undefined : Math.max(after, history.at(-1)?.seq ?? 0);
    await settleRecordedPayments(jobId, fullHistoryThrough);
    if (useCache && !isTerminalJobStatus(status) && history && fullHistoryThrough && Number.isSafeInteger(fullHistoryThrough)) {
      recordStatusMessageHistory(jobId, {
        through: fullHistoryThrough, sequenceDigest: historySequenceDigest(history, fullHistoryThrough),
      }, checkpoint);
    }
  }
  const batch = deliver && after < deliveryAfter ? tail.filter((message) => message.seq > deliveryAfter) : tail;
  const cursor = deliver ? Math.max(deliveryAfter, maxSeq(batch, deliveryAfter)) : undefined;
  return { batch, history, cursor };
}

function statusHistoryCursor(cached: Message[], status: string, checkpoint?: StatusMessageHistory): number {
  const sequences = new Set(cached.map((message) => message.seq));
  const contiguous = contiguousSequenceThrough(sequences, 0);
  // The terminal snapshot also needs cancellation evidence that may have landed in a gap.
  if (isTerminalJobStatus(status) || !checkpoint || !Number.isSafeInteger(checkpoint.through) ||
    checkpoint.through <= contiguous || !sequences.has(checkpoint.through) ||
    checkpoint.sequenceDigest !== historySequenceDigest(cached, checkpoint.through)) return contiguous;

  const covered = contiguousSequenceThrough(sequences, checkpoint.through);
  if (status !== "awaiting-input") return covered;

  // Pending payments hold newer SDK history back. A later sequence can be visible while
  // a reply awaits verification, so recheck gaps that could answer an open prompt.
  const answered = answeredYieldSeqs(cached);
  let firstOpenPrompt = covered;
  for (const message of cached) {
    if (message.from === "provider" && message.type === "prompt" && !answered.has(message.seq)) {
      firstOpenPrompt = Math.min(firstOpenPrompt, message.seq);
    }
  }
  return contiguousSequenceThrough(sequences, Math.max(contiguous, firstOpenPrompt), covered);
}

function contiguousSequenceThrough(sequences: Set<number>, after: number, limit = Number.MAX_SAFE_INTEGER): number {
  while (after < limit && sequences.has(after + 1)) after++;
  return after;
}

function historySequenceDigest(messages: Message[], through: number): string {
  const sequences = [...new Set(messages.map((message) => message.seq).filter((seq) => seq <= through))].sort((a, b) => a - b);
  return createHash("sha256").update(JSON.stringify(sequences)).digest("hex");
}

async function resolveNextAction(
  jobId: string,
  status: string,
  fetched: Message[],
  history: Message[] | undefined,
  transport: Transport,
  ref: ProviderRef,
  opts: { timeoutMs: number; jobToken?: string; context?: PaymentPolicyContext; ignoreLocalState: boolean }
): Promise<NextAction> {
  if (isTerminalJobStatus(status)) return null;
  if (status === "awaiting-input") {
    // An unanswered prompt or charge can predate the delivery cursor.
    if (history) return readNextAction(jobId, history, opts) ?? pollNextAction(jobId);
    const fromBatch = readNextAction(jobId, fetched, opts);
    if (fromBatch) return fromBatch;
    const fullLog = await transport.getMessages(jobId, 0, ref, opts);
    return readNextAction(jobId, fullLog, opts) ?? pollNextAction(jobId);
  }
  return pollNextAction(jobId);
}
