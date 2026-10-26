import { isCallerMessage } from "../lib/message-ownership";
import { providerFields, providerJobJson } from "../lib/provider-output";
export { formatMessageHuman } from "../lib/message-human";
import { formatMessageHuman, paymentAmount } from "../lib/message-human";
import { printNextActionHuman } from "../lib/next-action-human";
import { formatPaymentAmount } from "../lib/currency";
import { computeNextAction, isTerminalJobStatus, paymentInFlightHint, pollNextAction, type NextAction } from "../lib/next-action";
import {
  asProviderText,
  DvmError,
  type Message,
} from "@dvmkit/sdk/internal";
import {
  info,
} from "../lib/output";

import {
  type JobAccessOptions,
  type ResolvedJobAccess,
  resolveJobAccess,
  withJobTokenRedaction,
} from "../lib/job-access";
import { jobContentFields, observeJobContent } from "../lib/job-content";
import { appendMessages, loadMessages, maxSeq } from "../lib/messages";
import { finalizeProgressLine } from "../lib/progress-bar";
import { progressNotice } from "../lib/progress-notice";
import {
  claimInboundPayments,
  refundJsonField,
  withRefundNextAction,
} from "../lib/refund-claim";
import {
  createArtifactSaveSession,
} from "../lib/save-artifact";
import { parseDurationMs } from "../lib/duration";
import { loadAnsweredYieldSeqs } from "../lib/yield-state";
import { waitForJob } from "../lib/wait-for-job";
import { streamLoop } from "../lib/stream-loop";
import { persistStreamOutcome, streamTerminalStatus } from "../lib/stream-outcome";
import { createDvmTransport } from "../lib/transport";

export interface MessagesOptions extends JobAccessOptions {
  after?: string;
  wait?: boolean;
  until?: string;
  /** Whether to stream (default: true). Set to false by --no-stream. */
  stream?: boolean;
  human?: boolean;
  /** How long to wait (in seconds) for messages (default: 5) */
  timeout?: string;
}

export async function messages(jobId: string, opts: MessagesOptions): Promise<void> {
  if ((opts.until !== undefined && !opts.wait) || (opts.wait && opts.stream === false)) {
    throw new DvmError("invalid_arguments", "Use --until with --wait, and --wait with streaming enabled.");
  }
  const access = resolveJobAccess(jobId, opts);
  return withJobTokenRedaction(access.jobToken, () => messagesWithAccess(jobId, opts, access));
}

async function messagesWithAccess(
  jobId: string,
  opts: MessagesOptions,
  access: ResolvedJobAccess
): Promise<void> {
  const waitDuration = opts.wait ? parseDurationMs(opts.until ?? "12h") : undefined;
  const artifactSession = opts.human ? createArtifactSaveSession() : undefined;
  const { stored, ref, jobToken } = access;
  const json = (data: Record<string, unknown>) => providerJobJson(data, !!stored);

  function actionFromMessages(batch: Message[]): NextAction {
    const answered = access.endpointOverridden ? new Set<number>() : loadAnsweredYieldSeqs(jobId);
    const action = computeNextAction(jobId, batch.filter((message) => !answered.has(message.seq)));
    const request = batch.findLast((message) => message.type === "payment-request");
    if (action?.type === "pay" && request && !access.endpointOverridden &&
        stored?.inFlightPaymentRequestSeqs?.includes(request.seq))
      return { ...action, hint: paymentInFlightHint(jobId) };
    return action;
  }

  async function resolveNextAction(action: NextAction, messages: Message[]): Promise<NextAction> {
    if (action?.type === "refund") return action;
    if (streamTerminalStatus(messages) || (!access.endpointOverridden && stored && isTerminalJobStatus(stored.status))) return null;
    if (!opts.human) return action;
    // Terminal status takes precedence over actions from an older message.
    // Empty incremental batches can still have a pending question in history.
    try {
      const readOptions = { jobToken, timeoutMs: opts.timeout ? Number(opts.timeout) * 1000 : 5000 };
      const snapshot = await transport.status(jobId, ref, readOptions);
      if (isTerminalJobStatus(snapshot.status)) return null;
      if (action && (action.type !== "poll" ||
        messages.some((message) => ["prompt", "payment-request", "working"].includes(message.type)))) return action;
      if (snapshot.status === "awaiting-input") {
        const history = await transport.getMessages(jobId, 0, ref, readOptions);
        return actionFromMessages(history) ?? pollNextAction(jobId);
      }
      return action ?? pollNextAction(jobId);
    } catch {
      return action ?? pollNextAction(jobId);
    }
  }
  const transport = createDvmTransport();

  const isTerminal = !access.endpointOverridden && !!stored && isTerminalJobStatus(stored.status);
  const after =
    opts.after !== undefined
      ? Number(opts.after)
      : opts.stream === false && isTerminal
        ? 0
        : access.endpointOverridden
          ? 0
          : (stored?.messageCursor ?? 0);

  // Thread the resolved per-job token through every read. It can come from
  // portable access or from the local record, and remains undefined for other
  // authenticated callers.
  if (opts.stream === false) {
    const timeout = opts.timeout ? Number(opts.timeout) * 1000 : 5000;
    progressNotice("Fetching messages...", opts.human);
    let msgs: Message[];
    try {
      msgs = await transport.getMessages(jobId, after, ref, { timeoutMs: timeout, jobToken });
    } catch (err) {
      if (
        err instanceof DvmError &&
        err.code === "provider_unreachable" &&
        isTerminal &&
        !access.endpointOverridden &&
        loadMessages(jobId).some((message) => message.type === "complete" || message.type === "cancel")
      ) {
        throw new DvmError(
          "retained_messages_offline",
          `Could not fetch messages for ${stored?.status} job ${jobId}; its provider is unreachable.`,
          `A terminal message is in the local message log. Inspect that log and run 'dvm receipts verify ${jobId}' to check any stored receipt and result hash offline, or restart the provider to fetch messages again.`
        );
      }
      throw err;
    }
    if (!access.endpointOverridden) appendMessages(jobId, msgs);
    const newCursor = maxSeq(msgs, after);
    // a batch that ends on `complete` / `cancel` tells us the job is
    // over — record the terminal status and its snapshot, not just the cursor.
    if (!access.endpointOverridden) {
      persistStreamOutcome({ jobId, messages: msgs, cursor: newCursor, afterSeq: after });
    }

    // Auto-claim inbound Cashu payments (refund/change) into the local wallet.
    const refunds = access.endpointOverridden ? [] : await claimInboundPayments(jobId, msgs);
    const nextAction = withRefundNextAction(jobId, actionFromMessages(msgs) ??
      (streamTerminalStatus(msgs) || isTerminal ? null : pollNextAction(jobId)), refunds);
    const content = jobContentFields(
      jobId,
      await observeJobContent(jobId, transport, ref, { timeoutMs: timeout, jobToken }),
      opts.human
    );
    const resolvedAction = await resolveNextAction(nextAction, msgs);
    transport.close();

    if (opts.human) {
      info(String(content.content_hint));
      if (msgs.length === 0) {
        info("No new messages.");
      } else {
        for (const msg of msgs) {
          formatMessageHuman(msg, jobId, artifactSession);
        }
        finalizeProgressLine();
      }
      printNextActionHuman(resolvedAction, { refunds });
    } else {
      json({
        jobId,
        ...content,
        messages: msgs.map(serialize),
        cursor: newCursor,
        next_action: resolvedAction,
        ...(await refundJsonField(refunds)),
      });
    }
    return;
  }

  progressNotice("Streaming messages...", opts.human);
  // Render `progress` heartbeats live in --human mode so multi-minute jobs
  // give the operator continuous feedback. Other types are batch-rendered
  // after the stream returns; progress is skipped there to avoid duplication.
  const streamOptions = {
    jobId,
    transport,
    provider: ref,
    policy: stored?.policy ?? undefined,
    afterSeq: after,
    afterSeqExplicit: opts.after !== undefined,
    jobToken,
    persistLocalState: !access.endpointOverridden,
    timeoutMs: opts.timeout ? Number(opts.timeout) * 1000 : (opts.wait ? 60_000 : 5000),
    ...(opts.human && {
      onMessage: (msg: Message) => {
        if (msg.type === "progress") formatMessageHuman(msg);
      },
    }),
  };
  const waitDeadline = waitDuration === undefined ? undefined : Date.now() + waitDuration;
  let result;
  try {
    result = opts.wait
      ? await waitForJob(streamOptions, waitDuration!)
      : await streamLoop(streamOptions);
  } catch (err) {
    transport.close();
    throw err;
  }

  if (!access.endpointOverridden) {
    persistStreamOutcome({
      jobId,
      messages: result.messages,
      cursor: result.cursor,
      afterSeq: after,
    });
  }
  const content = jobContentFields(
    jobId,
    waitDeadline !== undefined && Date.now() >= waitDeadline ? undefined
      : await observeJobContent(jobId, transport, ref, {
        timeoutMs: waitDeadline === undefined ? (opts.timeout ? Number(opts.timeout) * 1000 : 5000)
          : Math.max(1, Math.min(streamOptions.timeoutMs, waitDeadline - Date.now())),
        jobToken,
      }),
    opts.human
  );
  const resolvedAction = opts.wait ? result.nextAction : await resolveNextAction(result.nextAction, result.messages);
  transport.close();

  if (opts.human) {
    info(String(content.content_hint));
    if (result.messages.length === 0) {
      info("No new messages.");
    } else {
      for (const msg of result.messages) {
        if (msg.type === "progress") continue; // already rendered live
        formatMessageHuman(msg, jobId, artifactSession);
      }
      finalizeProgressLine();
    }
    printNextActionHuman(resolvedAction, { refunds: result.refunds });
  } else {
    json({
      jobId,
      ...content,
      messages: result.messages.map(serialize),
      cursor: result.cursor,
      next_action: resolvedAction,
      ...(result.autoPayments.length > 0 ? { auto_payments: result.autoPayments } : {}),
      ...(await refundJsonField(result.refunds)),
    });
  }
}

/**
 * Serialize a message for JSON output: wraps provider-supplied free-text fields as
 * `{ _source: "provider", text: ... }` and adds a plain-text `display` string.
 * The `display` string remains plain text — `--human` callers and agents that just want
 * a label can read it directly.
 */
export function serializeMessageForOutput(msg: Message): Record<string, unknown> {
  return serialize(msg);
}

function serialize(msg: Message): Record<string, unknown> {
  const fromProvider = !isCallerMessage(msg);
  const base = providerFields({ seq: msg.seq, from: msg.from, timestamp: msg.timestamp, type: msg.type, content: msg.content },
    ["seq", "from", "timestamp", ...(fromProvider ? ["type", "content"] : [])]);

  switch (msg.type) {
    case "text": {
      const display = msg.content.text;
      return {
        ...base,
        content: fromProvider
          ? { text: asProviderText(msg.content.text) }
          : { text: msg.content.text },
        display,
      };
    }
    case "prompt": {
      const display = `Provider asks: ${msg.content.text}`;
      const content: Record<string, unknown> = {
        id: msg.content.id,
        text: asProviderText(msg.content.text),
      };
      content._provider_fields = [
        "id",
        ...(msg.content.options ? ["options"] : []),
        ...(msg.content.schema ? ["schema"] : []),
      ];
      if (msg.content.options) content.options = msg.content.options;
      if (msg.content.schema) content.schema = msg.content.schema;
      if (msg.content.expires_at_ms !== undefined) content.expires_at_ms = msg.content.expires_at_ms;
      return { ...base, content, display };
    }
    case "artifact": {
      const label = msg.content.name ?? msg.content.mime_type ?? "unknown type";
      const display = `Artifact: ${label}`;
      const content: Record<string, unknown> = { ...msg.content };
      if (msg.content.name !== undefined) content.name = asProviderText(msg.content.name);
      return { ...base, content, display };
    }
    case "payment-request": {
      const display = `Provider requests ${formatPaymentAmount(msg.content.amount_msats, msg.content.fiat_amount, { anchor: false })}${msg.content.reason ? `: ${msg.content.reason}` : ""}`;
      return {
        ...base,
        content: {
          ...msg.content,
          reason: asProviderText(msg.content.reason),
        },
        display,
      };
    }
    case "payment": {
      // Requester payments must not borrow provider refund/change wording.
      const amount = paymentAmount(msg);
      const display = msg.from === "provider"
        ? `${msg.content.reason === "change" ? "Change" : "Refund"} sent: ${amount}`
        : `Paid: ${amount}`;
      return { ...base, content: { ...msg.content }, display };
    }
    case "complete": {
      const display = `Job complete${msg.content.summary ? `: ${msg.content.summary}` : ""}`;
      const content: Record<string, unknown> = { ...msg.content };
      if (msg.content.summary !== undefined) content.summary = asProviderText(msg.content.summary);
      return { ...base, content, display };
    }
    case "working": {
      const display = `Provider is working${msg.content.estimate_seconds ? ` (est. ${String(msg.content.estimate_seconds)}s)` : ""}${msg.content.hint ? `: ${msg.content.hint}` : ""}`;
      const content: Record<string, unknown> = { ...msg.content };
      if (msg.content.hint !== undefined) content.hint = asProviderText(msg.content.hint);
      return { ...base, content, display };
    }
    case "progress": {
      const phase = msg.content.current_phase ? ` (${msg.content.current_phase})` : "";
      const hint = msg.content.hint ? ` — ${msg.content.hint}` : "";
      const display = `Progress: ${String(msg.content.percent_complete)}%${phase}${hint}`;
      const content: Record<string, unknown> = { ...msg.content };
      if (msg.content.current_phase !== undefined)
        content.current_phase = asProviderText(msg.content.current_phase);
      if (msg.content.hint !== undefined) content.hint = asProviderText(msg.content.hint);
      return { ...base, content, display };
    }
    case "cancel": {
      const display = `Cancelled${msg.content.reason ? `: ${msg.content.reason}` : ""}`;
      const content: Record<string, unknown> = { ...msg.content };
      if (fromProvider && msg.content.reason !== undefined) {
        content.reason = asProviderText(msg.content.reason);
      }
      return { ...base, content, display };
    }
    default:
      return {
        ...base,
        content: msg.content,
        display: `[${msg.type}] ${JSON.stringify(msg.content)}`,
      };
  }
}
