import { providerJobJson } from "../lib/provider-output";
import {
  DvmError,
  type OutboundMessage,
} from "@dvmkit/sdk/internal";
import {
  info,
} from "../lib/output";

import { takeCreditNoticeFields } from "../lib/credit-notice";
import { takeFeedbackNoticeFields } from "../lib/feedback-notice";
import { noteFeedbackAfterTerminal } from "../lib/feedback-nudges";
import {
  type JobAccessOptions,
  type ResolvedJobAccess,
  resolveJobAccess,
  withJobTokenRedaction,
} from "../lib/job-access";
import { jobContentFields, observeJobContent } from "../lib/job-content";
import { finalizeProgressLine } from "../lib/progress-bar";
import { progressNotice } from "../lib/progress-notice";
import { createArtifactSaveSession } from "../lib/save-artifact";
import { streamLoop } from "../lib/stream-loop";
import { persistStreamOutcome, streamTerminalStatus } from "../lib/stream-outcome";
import { createDvmTransport } from "../lib/transport";
import { formatMessageHuman, serializeMessageForOutput } from "./messages";

export interface MessageOptions extends JobAccessOptions {
  /** Message type (default: "text") */
  type?: "text" | "response" | "approval" | "cancel" | "payment";
  /** Prompt ID (required for --type response) */
  promptId?: string;
  json?: string;
  /** Reference sequence number (for --type approval) */
  ref?: string;
  /** Cashu token to send (for --type payment) */
  token?: string;
  human?: boolean;
  /** Timeout in seconds for streaming (default: 30) */
  timeout?: string;
}

export async function message(jobId: string, text: string, opts: MessageOptions): Promise<void> {
  const access = resolveJobAccess(jobId, opts);
  return withJobTokenRedaction(access.jobToken, () =>
    messageWithAccess(jobId, text, opts, access)
  );
}

async function messageWithAccess(
  jobId: string,
  text: string,
  opts: MessageOptions,
  access: ResolvedJobAccess
): Promise<void> {
  const artifactSession = opts.human ? createArtifactSaveSession() : undefined;
  const { stored, ref, jobToken } = access;
  const json = (data: Record<string, unknown>) => providerJobJson(data, !!stored);

  const msgType = opts.type ?? (opts.json ? "response" : "text");

  if (msgType === "response" && !opts.promptId && !opts.json) {
    throw new DvmError("invalid_input", "--prompt-id is required when --type is 'response'.");
  }

  if (msgType === "payment" && !opts.token) {
    throw new DvmError("invalid_input", "--token is required when --type is 'payment'.");
  }

  const outbound = buildOutboundMessage(msgType, text, opts);

  const transport = createDvmTransport();

  progressNotice("Sending message...", opts.human);
  // anonymous-flow per-job token threaded through the POST and the
  // follow-up streamLoop's reads.
  await transport.sendMessage(jobId, outbound, ref, { jobToken });

  const timeoutMs = opts.timeout ? Number(opts.timeout) * 1000 : undefined;
  const afterSeq = access.endpointOverridden ? 0 : (stored?.messageCursor ?? 0);
  const result = await streamLoop({
    jobId,
    transport,
    provider: ref,
    policy: stored?.policy ?? undefined,
    afterSeq,
    timeoutMs,
    jobToken,
    persistLocalState: !access.endpointOverridden,
  });

  // an answer that runs the handler through to `complete` is this
  // path's only signal the job is over — record the terminal status and its
  // snapshot so `dvm status` answers from the local record.
  if (!access.endpointOverridden) {
    persistStreamOutcome({ jobId, messages: result.messages, cursor: result.cursor, afterSeq });
  }
  // an answer that runs the handler through to `complete` ends the
  // job right here, so this is a job-terminal emission like the request arcs.
  const streamedTerminal =
    result.nextAction === null ? streamTerminalStatus(result.messages) : undefined;
  if (streamedTerminal && stored && !access.endpointOverridden) {
    noteFeedbackAfterTerminal({
      jobId,
      dvmId: stored.dvmId,
      endpoint: stored.endpoint,
      status: streamedTerminal,
      human: opts.human,
    });
  }
  const content = jobContentFields(
    jobId,
    await observeJobContent(jobId, transport, ref, { timeoutMs: timeoutMs ?? 5000, jobToken }),
    opts.human
  );
  transport.close();

  if (opts.human) {
    info(String(content.content_hint));
    info(`Message sent (type: ${msgType}).`);
    for (const msg of result.messages) {
      formatMessageHuman(msg, jobId, artifactSession);
    }
    finalizeProgressLine();
  } else {
    json({
      jobId,
      ...content,
      sent: { type: outbound.type, content: outbound.content },
      messages: result.messages.map(serializeMessageForOutput),
      ...takeCreditNoticeFields(),
      ...takeFeedbackNoticeFields(),
      next_action: result.nextAction,
      ...(result.autoPayments.length > 0 ? { auto_payments: result.autoPayments } : {}),
    });
  }
}

function buildOutboundMessage(type: string, text: string, opts: MessageOptions): OutboundMessage {
  switch (type) {
    case "response": {
      if (opts.json) {
        const parsed = JSON.parse(opts.json) as Record<string, unknown>;
        const promptId =
          typeof parsed.prompt_id === "string" ? parsed.prompt_id : (opts.promptId ?? "");
        const data =
          parsed.data && typeof parsed.data === "object"
            ? (parsed.data as Record<string, unknown>)
            : parsed;
        return {
          type: "response",
          content: { prompt_id: promptId, text, data },
        };
      }
      return {
        type: "response",
        content: { prompt_id: opts.promptId ?? "", text },
      };
    }
    case "approval":
      return {
        type: "approval",
        content: {
          ...(opts.ref ? { ref_seq: Number(opts.ref) } : {}),
          comment: text,
        },
      };
    case "cancel":
      return {
        type: "cancel",
        content: { reason: text },
      };
    case "payment": {
      const content: Record<string, unknown> = {};
      if (opts.token) content.cashu_token = opts.token;
      return { type: "payment", content };
    }
    default:
      return {
        type: "text",
        content: { text },
      };
  }
}
