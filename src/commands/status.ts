import { providerJobJson } from "../lib/provider-output";
import { jobSpend, renderSpendHuman } from "../lib/job-spend";
import { formatMessageHuman } from "../lib/message-human";
import { printNextActionHuman } from "../lib/next-action-human";
import { finalizeProgressLine } from "../lib/progress-bar";
import { createArtifactSaveSession } from "../lib/save-artifact";
import { type PaymentPolicyContext, computeNextAction, isTerminalJobStatus, type NextAction, pollNextAction } from "../lib/next-action";
import { buildCompletionHintFields, completionSnapshot, type JobCompletion, nextStepHint } from "../lib/completion-hints";
import {
  getLastKnownBtcRate,
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
} from "../lib/receipt-capture";
import {
  getOutputTraceId,
  info,
} from "../lib/output";
import {
  type JobRecord,
  loadJob,
  markJobTerminal,
  updateJob,
} from "../lib/job-store";
import {
  receiptDisplay,
  receiptHint,
} from "../lib/receipt-verify";

import { type ContentStatus, jobContentFields } from "../lib/job-content";
import { takeCreditNoticeFields } from "../lib/credit-notice";
import { settleCreditAfterRead } from "../lib/credit-topup";
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
import { appendMessages, maxSeq } from "../lib/messages";
import { progressNotice } from "../lib/progress-notice";
import { createDvmTransport } from "../lib/transport";
import { dvmIdentity } from "./dvm-identity";
import { serializeMessageForOutput } from "./messages";

export interface StatusOptions extends JobAccessOptions {
  human?: boolean;
  /** How long to wait (in seconds) for a result before returning (default: 5) */
  timeout?: string;
  messages?: boolean;
}

export async function status(jobId: string, opts: StatusOptions): Promise<void> {
  const access = resolveJobAccess(jobId, opts);
  return withJobTokenRedaction(access.jobToken, () => statusWithAccess(jobId, opts, access));
}

async function statusWithAccess(
  jobId: string,
  opts: StatusOptions,
  access: ResolvedJobAccess
): Promise<void> {
  const { stored, ref, jobToken } = access;

  // a finished job answers from its stored snapshot — same field set
  // as the wire read that produced it, and readable with the provider down.
  // `--messages` still goes to the wire: the message log isn't in the snapshot,
  // and a record written before this landed carries no snapshot to replay.
  if (
    stored &&
    !access.overridden &&
    isTerminalJobStatus(stored.status) &&
    stored.completion &&
    !opts.messages
  ) {
    // re-verify the snapshotted receipt rather than replaying a
    // cached verdict — a tampered `jobs.json` must answer `invalid`.
    let receipt = replayStoredReceipt(stored);
    const transport = createDvmTransport();

    // a terminal snapshot can predate the receipt that the DVM now
    // serves. Spend one best-effort read only when the DVM advertised receipts
    // and the local record has none; the saved completion remains authoritative
    // even when that read fails or returns no proof.
    if (stored.receiptsSupported && receipt.status === "absent") {
      const fetched = await fetchMissingJobReceipt(jobId, transport, ref);
      if (fetched.receipt || fetched.receiptParseError) {
        if (fetched.receipt && !stored.builderAnchor) {
          await backfillTrustAnchor(jobId, transport, ref);
        }
        receipt = captureTransportReceipt(jobId, fetched);
      }
    }
    await settleCreditAfterRead({ job: stored, capture: receipt, transport, human: opts.human });
    transport.close();

    renderStatus(jobId, stored, stored.status, stored.completion, "local", null, opts, {
      receipt,
    });
    return;
  }

  const timeout = opts.timeout ? Number(opts.timeout) * 1000 : 5000;

  const transport = createDvmTransport();

  progressNotice("Checking job status...", opts.human);

  // thread the per-job opaque token (issued for anonymous callers
  // at create-time) into status / messages reads as `X-Job-Token`.
  const result: ContentStatus = await transport.status(jobId, ref, { timeoutMs: timeout, jobToken });
  if (stored && !access.endpointOverridden) captureDrawFundingReceipts(jobId, result.drawFundingReceipts, { endpoint: ref.endpoint });

  let msgs: Message[] = [];
  let newCursor: number | undefined;
  if (opts.messages) {
    const after = access.endpointOverridden ? 0 : (stored?.messageCursor ?? 0);
    msgs = await transport.getMessages(jobId, after, ref, { timeoutMs: timeout, jobToken });
    if (!access.endpointOverridden) appendMessages(jobId, msgs);
    newCursor = maxSeq(msgs, after);
  }

  const nextAction = await resolveNextAction(jobId, result.status, msgs, transport, ref, {
    timeoutMs: timeout,
    jobToken,
    context: access.endpointOverridden ? undefined : stored ?? undefined,
  });

  // Update job store if we learned something new. A terminal read snapshots the
  // outcome so every later `dvm status` replays this exact payload.
  const completion = completionSnapshot(result);
  let receipt: ReceiptCapture | undefined;
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
    receipt =
      stored && !access.endpointOverridden
        ? captureTransportReceipt(jobId, result)
        : transientReceiptCapture(jobId, result);
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
    if (Object.keys(updates).length > 0) updateJob(jobId, updates);
  }

  transport.close();

  renderStatus(jobId, stored, result.status, completion, "provider", nextAction, opts, {
    msgs,
    cursor: newCursor,
    receipt,
    content: result,
  });
}

/** Verify receipt output without filing an override endpoint or token in local state. */
function transientReceiptCapture(
  jobId: string,
  response: Pick<JobStatus, "receipt" | "receiptParseError">
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
  return {
    status: result.status,
    receipt: response.receipt,
    checks: result.checks,
    ...(result.reason ? { reason: result.reason } : {}),
    display: receiptDisplay(
      response.receipt,
      result.status,
      getLastKnownBtcRate()?.rate ?? 0
    ),
  };
}

/**
 * Render one `dvm status` response. Both exit paths — the stored-snapshot
 * replay and the wire read — funnel through here so a finished job carries the
 * same field set whichever served it. `source` tells the agent which
 * one did: `"local"` is a replay of the snapshot taken at the first terminal
 * read, `"provider"` a fresh read.
 */
function renderStatus(
  jobId: string,
  stored: JobRecord | null,
  jobStatus: string,
  completion: JobCompletion,
  source: "local" | "provider",
  nextAction: NextAction,
  opts: StatusOptions,
  fetched?: { msgs?: Message[]; cursor?: number; receipt?: ReceiptCapture; content?: ContentStatus }
): void {
  const identifier = stored?.dvmId ? formatIdentifier(stored.dvmId, stored.capability) : undefined;
  const hint = nextStepHint(jobId, completion.payloadIn, completion.artifactCount, opts.human);
  const msgs = fetched?.msgs ?? [];
  const receipt = fetched?.receipt;
  const content = jobContentFields(jobId, fetched?.content, opts.human);
  const spend = stored ? jobSpend(loadJob(jobId) ?? stored, receipt?.receipt) : undefined;

  if (opts.human) {
    if (jobStatus === "completed" && completion.summary) {
      info(`Summary:`);
      console.log(completion.summary);
    } else {
      info(`Status: ${jobStatus}${identifier ? ` [${identifier}]` : ""}`);
      if (completion.message) info(`  ${completion.message}`);
    }
    if (jobStatus === "completed" && hint) info(`📎 ${hint}`);
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
    if (receipt) renderReceiptHuman(receipt);
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
    ...(jobStatus === "completed" ? buildCompletionHintFields(jobId, completion) : {}),
    ...(completion.message ? { message: completion.message } : {}),
    // terminal responses only. On a still-running job "absent" would
    // read as "this DVM doesn't issue receipts" rather than "not yet".
    ...(receipt ? receiptJsonFields(receipt) : {}),
    // `dvm status` is a job-terminal emission for `--no-stream`
    // jobs, so it drains the deferred-notice sinks like the request terminals
    // do. Both spread blind and are absent when nothing was stashed.
    ...takeCreditNoticeFields(),
    ...takeFeedbackNoticeFields(),
    ...(spend ? { spend } : {}),
    next_action: nextAction,
  };
  if (opts.messages) {
    output.messages = msgs.map(serializeMessageForOutput);
    output.cursor = fetched?.cursor ?? 0;
  }
  providerJobJson(output, !!stored);
}

/**
 * Derive `next_action` from a status snapshot — always a value,
 * `null` only on a terminal job.
 *
 * The snapshot says *that* the job is waiting on the caller but not *what for*,
 * so `awaiting-input` falls back to the message log to build the faithful
 * `respond` / `pay` action — the `--messages` batch when it already carries the
 * pending yield, else a fresh read from seq 0 (the yield may predate the
 * caller's cursor). That read deliberately neither appends nor advances the
 * stored cursor — it would swallow messages a later `dvm messages` must return.
 */
async function resolveNextAction(
  jobId: string,
  status: string,
  fetched: Message[],
  transport: Transport,
  ref: ProviderRef,
  opts: { timeoutMs: number; jobToken?: string; context?: PaymentPolicyContext }
): Promise<NextAction> {
  if (isTerminalJobStatus(status)) return null;
  if (status === "awaiting-input") {
    const fromBatch = computeNextAction(jobId, fetched, undefined, opts.context);
    if (fromBatch) return fromBatch;
    const history = await transport.getMessages(jobId, 0, ref, opts);
    return computeNextAction(jobId, history, undefined, opts.context) ?? pollNextAction(jobId);
  }
  return pollNextAction(jobId);
}
