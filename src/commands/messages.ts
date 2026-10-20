import { formatAmountBestEffort, formatPaymentAmount } from "../lib/currency";
import { computeNextAction } from "../lib/next-action";
import {
  asProviderText,
  DvmError,
  type Message,
} from "@dvmkit/sdk/internal";
import {
  info,
  json,
} from "../lib/output";

import {
  type JobAccessOptions,
  type ResolvedJobAccess,
  resolveJobAccess,
  withJobTokenRedaction,
} from "../lib/job-access";
import { jobContentFields, observeJobContent } from "../lib/job-content";
import { appendMessages, loadMessages, maxSeq } from "../lib/messages";
import { finalizeProgressLine, renderProgressLine } from "../lib/progress-bar";
import { progressNotice } from "../lib/progress-notice";
import {
  claimInboundPayments,
  printRefundSummaryHuman,
  refundJsonField,
  refundNextAction,
} from "../lib/refund-claim";
import {
  type ArtifactSaveSession,
  createArtifactSaveSession,
  saveArtifact,
} from "../lib/save-artifact";
import { streamLoop } from "../lib/stream-loop";
import { persistStreamOutcome } from "../lib/stream-outcome";
import { createDvmTransport } from "../lib/transport";

export interface MessagesOptions extends JobAccessOptions {
  after?: string;
  /** Whether to stream (default: true). Set to false by --no-stream. */
  stream?: boolean;
  human?: boolean;
  /** How long to wait (in seconds) for messages (default: 5) */
  timeout?: string;
}

export async function messages(jobId: string, opts: MessagesOptions): Promise<void> {
  const access = resolveJobAccess(jobId, opts);
  return withJobTokenRedaction(access.jobToken, () => messagesWithAccess(jobId, opts, access));
}

async function messagesWithAccess(
  jobId: string,
  opts: MessagesOptions,
  access: ResolvedJobAccess
): Promise<void> {
  const artifactSession = opts.human ? createArtifactSaveSession() : undefined;
  const { stored, ref, jobToken } = access;
  const transport = createDvmTransport();

  const isTerminal = stored?.status === "completed" || stored?.status === "failed";
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
    const nextAction = refundNextAction(jobId, refunds) ?? computeNextAction(jobId, msgs);
    const content = jobContentFields(
      jobId,
      await observeJobContent(jobId, transport, ref, { timeoutMs: timeout, jobToken })
    );
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
        printRefundSummaryHuman(refunds);
      }
    } else {
      json({
        jobId,
        ...content,
        messages: msgs.map(serialize),
        cursor: newCursor,
        next_action: nextAction,
        ...(await refundJsonField(refunds)),
      });
    }
    return;
  }

  progressNotice("Streaming messages...", opts.human);
  // Render `progress` heartbeats live in --human mode so multi-minute jobs
  // give the operator continuous feedback. Other types are batch-rendered
  // after the stream returns; progress is skipped there to avoid duplication.
  const result = await streamLoop({
    jobId,
    transport,
    provider: ref,
    policy: stored?.policy ?? undefined,
    afterSeq: after,
    jobToken,
    persistLocalState: !access.endpointOverridden,
    ...(opts.human && {
      onMessage: (msg: Message) => {
        if (msg.type === "progress") formatMessageHuman(msg);
      },
    }),
  });

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
    await observeJobContent(jobId, transport, ref, {
      timeoutMs: opts.timeout ? Number(opts.timeout) * 1000 : 5000,
      jobToken,
    })
  );
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
      printRefundSummaryHuman(result.refunds);
    }
  } else {
    json({
      jobId,
      ...content,
      messages: result.messages.map(serialize),
      cursor: result.cursor,
      next_action: result.nextAction,
      ...(result.autoPayments.length > 0 ? { auto_payments: result.autoPayments } : {}),
      ...(await refundJsonField(result.refunds)),
    });
  }
}

function paymentAmount(msg: Extract<Message, { type: "payment" }>): string {
  if (msg.from === "requester" && msg.content.credit) {
    const credit = msg.content.credit;
    const digits = String(credit.amount_micro).padStart(7, "0");
    const fraction = digits.slice(-6).replace(/0+$/, "");
    const amount = digits.slice(0, -6) + (fraction ? `.${fraction}` : "");
    return `${amount} ${credit.currency.toUpperCase()} from prepaid balance`;
  }
  return formatAmountBestEffort(msg.content.amount_msats);
}

export function formatMessageHuman(
  msg: Message,
  jobId?: string,
  artifactSession?: ArtifactSaveSession
): void {
  const prefix = msg.from === "provider" ? "Provider" : "You";

  // Progress redraws a single line in TTY mode; every other type prints a
  // standalone line, so flush the bar's trailing position first.
  if (msg.type !== "progress") finalizeProgressLine();

  switch (msg.type) {
    case "text":
      info(`[${msg.seq}] ${prefix}: ${msg.content.text}`);
      break;
    case "prompt":
      info(`[${msg.seq}] ${prefix} asks: ${msg.content.text}`);
      if (msg.content.options) {
        for (const opt of msg.content.options) {
          info(`  - ${opt}`);
        }
      }
      break;
    case "artifact": {
      const label = msg.content.name ?? msg.content.mime_type ?? "unknown type";
      if (jobId) {
        const saved = saveArtifact(msg.content, artifactSession ?? createArtifactSaveSession());
        if (saved) {
          info(
            `[${msg.seq}] ${prefix} sent artifact: ${label} (${saved.bytes.toLocaleString()} bytes → ${saved.path})`
          );
          break;
        }
      }
      info(`[${msg.seq}] ${prefix} sent artifact: ${label}`);
      break;
    }
    case "payment-request":
      info(
        `[${msg.seq}] ${prefix} requests ${formatPaymentAmount(msg.content.amount_msats, msg.content.fiat_amount, { anchor: false })}${msg.content.reason ? `: ${msg.content.reason}` : ""}`
      );
      break;
    case "payment": {
      const amount = paymentAmount(msg);
      if (msg.from === "provider") {
        const noun = msg.content.reason === "change" ? "change" : "refund";
        info(`[${msg.seq}] ${prefix} sent ${noun}: ${amount}`);
      } else {
        info(`[${msg.seq}] ${prefix} paid: ${amount}`);
      }
      break;
    }
    case "complete":
      info(`[${msg.seq}] Job complete${msg.content.summary ? `: ${msg.content.summary}` : ""}`);
      break;
    case "working":
      info(
        `[${msg.seq}] Provider is working${msg.content.estimate_seconds ? ` (est. ${String(msg.content.estimate_seconds)}s)` : ""}${msg.content.hint ? `: ${msg.content.hint}` : ""}`
      );
      break;
    case "progress":
      renderProgressLine(msg.content, msg.seq);
      break;
    case "cancel":
      info(`[${msg.seq}] Cancelled${msg.content.reason ? `: ${msg.content.reason}` : ""}`);
      break;
    default:
      info(`[${msg.seq}] ${prefix} [${msg.type}]: ${JSON.stringify(msg.content)}`);
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
  const base = { seq: msg.seq, from: msg.from, timestamp: msg.timestamp, type: msg.type };
  const fromProvider = msg.from === "provider";

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
      if (msg.content.options) content.options = msg.content.options;
      if (msg.content.schema) content.schema = msg.content.schema;
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
      const display = fromProvider
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
