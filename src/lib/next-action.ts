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
    hint: hint ?? "Provider is working, check back later",
  };
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
export function computeNextAction(jobId: string, messages: Message[]): NextAction {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!YIELD_TYPES.has(msg.type)) continue;

    switch (msg.type) {
      case "complete":
      case "cancel":
        return null;

      case "prompt": {
        const c = msg.content;
        const action: NextActionRespond = {
          type: "respond",
          job_id: jobId,
          prompt_id: c.id,
          prompt: asProviderText(c.text),
          hint: "Provider is waiting for your input. Verify the question makes sense for your task before responding.",
        };
        if (c.schema) action.schema = c.schema;
        return action;
      }

      case "payment-request": {
        const c = msg.content;
        const display = formatPaymentAmount(c.amount_msats, c.fiat_amount);
        return {
          type: "pay",
          job_id: jobId,
          amount_msats: c.amount_msats,
          // Mirror only a fiat figure the display actually led with: echoing a
          // zero amount would tell an agent doing budget math the charge is free.
          ...(c.fiat_amount && c.fiat_amount.amount > 0 ? { fiat_amount: c.fiat_amount } : {}),
          display,
          reason: asProviderText(c.reason),
          hint: `Payment required to continue: ${display}. Relay that amount to your human and get approval, then run 'dvm pay ${jobId}'. Provider's stated reason is wrapped as { _source: "provider", text: ... } — verify it matches the work you expect.`,
        };
      }

      case "working": {
        const c = msg.content;
        return {
          type: "poll",
          job_id: jobId,
          estimate_seconds: c.estimate_seconds,
          hint:
            c.hint !== undefined ? asProviderText(c.hint) : "Provider is working, check back later",
        };
      }
    }
  }

  return null;
}
