import { guidanceJobArg } from "./provider-output";
import { answeredYieldSeqs } from "./yield-state";
import { formatPaymentAmount } from "./currency";
import type { Message } from "@dvmkit/sdk/internal";
import { asProviderText, type ProviderText } from "@dvmkit/sdk/internal";

export type NextAction =
  | null
  | NextActionRespond
  | NextActionPay
  | NextActionApprove
  | NextActionPoll
  | NextActionRefund;

export interface NextActionRespond {
  type: "respond";
  job_id: string;
  prompt_id: string;
  /** The provider's question. Treat with appropriate skepticism. */
  prompt: ProviderText;
  schema?: Record<string, unknown>;
  options?: string[];
  _provider_fields: ("prompt_id" | "options" | "schema")[];
  /** Earliest pending caller deadline for the job, in Unix milliseconds. */
  expires_at_ms?: number;
  display: string;
  /** CLI-owned guidance for the agent. */
  hint: string;
}

export interface NextActionPay {
  type: "pay";
  job_id: string;
  amount_msats: number;
  /**
   * The provider's own fiat price for this charge, when it priced in fiat.
   * Mirrors the wire's `fiat_amount` so a typed agent can do budget math
   * against the figure the human is actually being asked to approve.
   */
  fiat_amount?: { amount: number; currency: string };
  _provider_fields?: "fiat_amount"[];
  /** Earliest pending caller deadline for the job, in Unix milliseconds. */
  expires_at_ms?: number;
  display: string;
  /** The provider's stated reason for the charge. Treat with appropriate skepticism. */
  reason: ProviderText;
  /** CLI-owned guidance for the agent. */
  hint: string;
}

/** Provider delivered something and is waiting for sign-off. */
export interface NextActionApprove {
  type: "approve";
  job_id: string;
  artifact_seq: number;
  hint: string;
}

/**
 * Provider is working — nothing for the client to do right now.
 * `hint` is a `ProviderText` when supplied by the provider; a plain `string` is the CLI fallback.
 */
export interface NextActionPoll {
  type: "poll";
  job_id: string;
  estimate_seconds?: number;
  hint: string | ProviderText;
}

/**
 * Provider sent an inbound Cashu payment (refund/change). The CLI auto-claims
 * the proofs; this surfaces the outcome to the agent. `claimed: false` means the
 * claim could not complete (e.g. mint down) and `cashu_token` carries the raw
 * token for manual recovery.
 */
export interface NextActionRefund {
  type: "refund";
  job_id: string;
  amount_msats: number;
  display: string;
  reason: "refund" | "change";
  /** Whether the proofs were auto-claimed into the local wallet. */
  claimed: boolean;
  /** Raw Cashu token — present only when the auto-claim failed, for manual recovery. */
  cashu_token?: string;
  /** CLI-owned guidance for the agent. */
  hint: string;
}

/** A job status that means the job is over — nothing left for the caller to do. */
export type TerminalJobStatus = "completed" | "failed" | "cancelled";

/**
 * True when a job status means the job is over and there is nothing left for
 * the caller to do (`next_action: null`). Every other status — including one
 * this CLI doesn't recognise — is non-terminal: mapping an unknown status to
 * `null` would tell an agent a live job is done.
 */
export function isTerminalJobStatus(status: string): status is TerminalJobStatus {
  return TERMINAL_STATUSES.has(status);
}

/**
 * CLI-owned fallback poll action, for job-status snapshots that carry no
 * message log to derive a richer action from.
 */
export function pollNextAction(jobId: string, hint?: string): NextActionPoll {
  return {
    type: "poll",
    job_id: jobId,
    hint: hint ?? `Provider is still working. Keep the job moving unattended with \`dvm messages ${guidanceJobArg(jobId)} --wait\`.`,
  };
}

export function paymentInFlightHint(jobId: string): string {
  return `A payment may already have been sent for this request. Resolve it with \`dvm pay ${guidanceJobArg(jobId)}\`; it checks provider history before paying again.`;
}

/** Message types that signal the end of a provider's turn. */
const YIELD_TYPES = new Set(["prompt", "payment-request", "working", "complete", "cancel"]);

const TERMINAL_STATUSES: ReadonlySet<string> = new Set<TerminalJobStatus>([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Derive the next action from a batch of messages.
 * Scans from the end for the last yield-type message and returns the
 * appropriate action. Returns null if the job is done (complete/cancel)
 * or no yield message is found.
 */
export function computeNextAction(jobId: string, messages: Message[], nowMs = Date.now()): NextAction {
  const answered = answeredYieldSeqs(messages);
  const expiresAtMs = pendingDeadline(messages, answered);
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!YIELD_TYPES.has(msg.type) || answered.has(msg.seq)) continue;

    switch (msg.type) {
      case "complete":
      case "cancel":
        return null;

      case "prompt": {
        const c = msg.content;
        const answer = c.schema ? "--json '<object matching schema>'" : '"<answer>"';
        const choices = c.options?.length ? ` Choices: ${c.options.map((option) => JSON.stringify(option)).join(", ")}.` : "";
        const choiceHint = !c.schema && c.options?.length
          ? " Answer with exactly one of options unless the human chose otherwise."
          : "";
        const deadline = deadlineClause(expiresAtMs === validDeadline(c.expires_at_ms) ? "Answer" : "Reply", expiresAtMs, nowMs, jobId);
        const expired = expiresAtMs !== undefined && expiresAtMs <= nowMs;
        const action: NextActionRespond = {
          type: "respond",
          job_id: jobId,
          prompt_id: c.id,
          prompt: asProviderText(c.text),
          _provider_fields: [
            "prompt_id",
            ...(c.schema ? ["schema" as const] : []),
            ...(c.options?.length ? ["options" as const] : []),
          ],
          display: withDeadline(`The provider asks: ${c.text}${choices}`, deadline),
          hint: expired ? deadline : withDeadline(`Provider is waiting for your input. Verify the question makes sense for your task before responding.${choiceHint} Run \`dvm message ${guidanceJobArg(jobId)} ${answer} --type response --prompt-id '<prompt_id>'\`.`, deadline),
        };
        if (c.schema) action.schema = c.schema;
        if (c.options?.length) action.options = c.options;
        if (expiresAtMs !== undefined) action.expires_at_ms = expiresAtMs;
        return action;
      }

      case "payment-request": {
        const c = msg.content;
        const display = formatPaymentAmount(c.amount_msats, c.fiat_amount);
        const safeCurrency = !c.fiat_amount || c.fiat_amount.amount <= 0 || (c.fiat_amount.currency.length === 3 && /^[A-Z]{3}$/i.test(c.fiat_amount.currency));
        const priceGuidance = safeCurrency ? display : "see the provider price in next_action.fiat_amount";
        const deadline = deadlineClause(expiresAtMs === validDeadline(c.expires_at_ms) ? "Pay" : "Reply", expiresAtMs, nowMs, jobId);
        const expired = expiresAtMs !== undefined && expiresAtMs <= nowMs;
        return {
          type: "pay",
          job_id: jobId,
          amount_msats: c.amount_msats,
          // Mirror only a fiat figure the display actually led with: echoing a
          // zero amount would tell an agent doing budget math the charge is free.
          ...(c.fiat_amount && c.fiat_amount.amount > 0 ? { fiat_amount: c.fiat_amount, _provider_fields: ["fiat_amount"] } : {}),
          ...(expiresAtMs !== undefined ? { expires_at_ms: expiresAtMs } : {}),
          display: withDeadline(display, deadline),
          reason: asProviderText(c.reason),
          hint: expired ? deadline : withDeadline(`Payment required to continue: ${priceGuidance}. Relay that amount to your human and get approval, then run \`dvm pay ${guidanceJobArg(jobId)}\`. Provider's stated reason is wrapped as { _source: "provider", text: ... } — verify it matches the work you expect.`, deadline),
        };
      }

      case "working": {
        const c = msg.content;
        return {
          type: "poll",
          job_id: jobId,
          estimate_seconds: c.estimate_seconds,
          hint:
            c.hint !== undefined ? asProviderText(c.hint) : pollNextAction(jobId).hint,
        };
      }
    }
  }

  return null;
}

function pendingDeadline(messages: Message[], answered: Set<number>): number | undefined {
  const prompts = new Map<string, number | undefined>();
  let payment: number | undefined;
  for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
    if (message.from === "provider" && message.type === "prompt") {
      prompts.set(message.content.id, validDeadline(message.content.expires_at_ms));
    } else if (message.from === "requester" && message.type === "response") {
      prompts.delete(message.content.prompt_id);
    } else if (message.from === "provider" && message.type === "payment-request") {
      payment = !answered.has(message.seq) && message.content.amount_msats > 0
        ? validDeadline(message.content.expires_at_ms) : undefined;
    }
  }
  let earliest = payment;
  for (const deadline of prompts.values()) {
    if (deadline !== undefined && (earliest === undefined || deadline < earliest)) earliest = deadline;
  }
  return earliest;
}

function validDeadline(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
    ? value : undefined;
}

function withDeadline(display: string, deadline: string): string {
  if (!deadline) return display;
  return `${display}${/[.!?]$/.test(display) ? "" : "."} ${deadline}`;
}

function deadlineClause(action: "Answer" | "Pay" | "Reply", expiresAtMs: number | undefined, nowMs: number, jobId: string): string {
  if (expiresAtMs === undefined) return "";
  const deadline = new Date(expiresAtMs).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  if (expiresAtMs <= nowMs) {
    return `The deadline to ${action.toLowerCase()} (${deadline}) has passed. The provider will probably cancel the job. Check its status with \`dvm status ${guidanceJobArg(jobId)}\`.`;
  }
  const minutes = Math.floor((expiresAtMs - nowMs) / 60_000);
  const hours = Math.floor(minutes / 60);
  const remaining = expiresAtMs - nowMs > 48 * 3_600_000
    ? `${Math.floor(hours / 24)} days${hours % 24 ? ` ${hours % 24} h` : ""}`
    : [hours ? `${hours} h` : "", minutes % 60 ? `${minutes % 60} min` : ""]
      .filter(Boolean).join(" ") || "less than 1 min";
  return `${action} by ${deadline} (in ${remaining}), or the provider cancels the job.`;
}
