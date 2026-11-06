import { guidanceJobArg } from "./provider-output";
import { answeredYieldSeqs } from "./yield-state";
import { formatPaymentAmount } from "./currency";
import { formatFiat } from "@dvmkit/sdk";
import type { JobPolicy, Message, PaymentRequestContent } from "@dvmkit/sdk/internal";
import type { JobRecord } from "./job-store";
import { asProviderText, loadAgentWallet, shellQuoteArg, type ProviderText } from "@dvmkit/sdk/internal";

export type NextAction =
  | null
  | NextActionRespond
  | NextActionPay
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
  /** Provisional: provider-requested msats; not a rail-neutral debit amount. */
  amount_msats: number;
  /**
   * The provider's own fiat price for this charge, when it priced in fiat.
   * Mirrors the wire's `fiat_amount` so a typed agent can do budget math
   * against the figure the human is actually being asked to approve.
   */
  fiat_amount?: { amount: number; currency: string };
  /**
   * The ask's price in integer micro-units of the job's credit currency. Present
   * only beside {@link charged_if_declined_micro}, so older DVMs keep the old shape.
   */
  credit?: { amount_micro: number; currency: string };
  /**
   * What declining this ask costs: the finished pieces of work, in integer
   * micro-units of `credit.currency`. Present only when a piece-charging DVM states it.
   */
  charged_if_declined_micro?: number;
  _provider_fields?: ("fiat_amount" | "credit" | "charged_if_declined_micro")[];
  /** Earliest pending caller deadline for the job, in Unix milliseconds. */
  expires_at_ms?: number;
  display: string;
  /** The provider's stated reason for the charge. Treat with appropriate skepticism. */
  reason: ProviderText;
  /** CLI-owned guidance for the agent. */
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
  /** Provisional: wallet-claimed msats when confirmed, otherwise provider-declared msats. */
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

type HeldJob = Pick<JobRecord, "unconfirmedPaymentSubmissions" | "askPaymentBlocks" | "endpoint" | "dvmId">;

/**
 * Whether `dvm pay` would re-send the payment held for this ask: one is held,
 * nothing blocks it, and for Cashu the wallet still holds its token.
 */
export function heldPaymentResendable(job: HeldJob | null | undefined, requestSeq: number): boolean {
  const submission = job?.unconfirmedPaymentSubmissions?.[requestSeq];
  if (!submission || submission.blocked) return false;
  if (submission.rail !== "cashu_p2pk") return true;
  return loadAgentWallet()?.pending_submissions.some((entry) => entry.request_id === submission.cashuRequestId) === true;
}

/**
 * For an ask whose earlier payment is unconfirmed. It promises a `dvm pay`
 * re-send only when one is possible, and otherwise names what is true of the
 * held payment and the ways out.
 */
export function paymentInFlightHint(jobId: string, job?: HeldJob | null, requestSeq?: number): string {
  const arg = guidanceJobArg(jobId);
  const resend = `A payment may already have been sent for this request. Resolve it with \`dvm pay ${arg}\`; it checks provider history and re-sends that same payment rather than signing a new one.`;
  if (!job || requestSeq === undefined) return resend;
  const submission = job.unconfirmedPaymentSubmissions?.[requestSeq];
  const stop = `To stop instead, \`dvm decline ${arg}\` ends the job and keeps the finished work, or \`dvm cancel ${arg}\` halts the work now and charges the work in progress.`;
  // A token that can be re-delivered, a blocked ask's replacement included, is re-sent by `dvm pay`.
  if (submission && !submission.blocked)
    return heldPaymentResendable(job, requestSeq) ? resend
      : `The wallet no longer holds the earlier Cashu payment for this request, so it cannot be re-sent. ${unresendablePaymentHint(jobId)}`;
  if (submission?.blocked?.reason === "not_resendable")
    return `${submission.blocked.detail} ${unresendablePaymentHint(jobId)}`;
  const askBlock = job.askPaymentBlocks?.[requestSeq];
  if (askBlock?.reason === "credit_held") {
    const credit = askBlock.creditId;
    const drain = `dvm credit drain ${shellQuoteArg(job.dvmId ?? job.endpoint)}${credit ? ` --credit-id ${shellQuoteArg(credit)}` : ""}`;
    const kept = submission?.rail === "cashu_p2pk"
      ? `The provider kept the earlier Cashu payment for this charge${credit ? ` as credit ${credit}` : ""} because it fell short`
      : submission
        ? `The provider answered that the earlier payment fell short of this charge and may have kept it${credit ? ` as credit ${credit}` : ""}`
        : `The provider answered that an earlier payment for this charge fell short and may hold it${credit ? ` as credit ${credit}` : ""}`;
    return `${kept}, so that payment does not pay the charge and is not sent again. ` +
      `Reclaim any balance it holds with \`${drain}\`. Paying the charge takes a new payment that only an explicit \`dvm pay ${arg}\` signs. ${stop}`;
  }
  if (askBlock?.reason === "proofs_spent")
    return `${askBlock.detail ?? "The proofs the earlier Cashu payment used are already spent at the mint; the provider may already have redeemed them for this charge, so paying again may pay twice."} Nothing is sent again or signed automatically. ` +
      `Paying the charge takes a new payment that only an explicit \`dvm pay ${arg}\` signs. ${stop}`;
  return `A payment was already sent for this request and is unconfirmed, and this CLI holds no copy to re-send. ${unresendablePaymentHint(jobId)}`;
}

/** Where an unconfirmed payment cannot be re-sent, and no other payment may be signed for its ask. */
export function unresendablePaymentHint(jobId: string): string {
  const job = guidanceJobArg(jobId);
  return "No new payment will be signed for this charge while the earlier one is unconfirmed. " +
    `If the provider records it, \`dvm messages ${job} --wait\` shows the job continue. ` +
    `To stop instead, \`dvm decline ${job}\` ends the job and keeps the finished work, or \`dvm cancel ${job}\` halts the work now and charges the work in progress.`;
}

/** Message types that signal the end of a provider's turn. */
const YIELD_TYPES = new Set(["prompt", "payment-request", "working", "complete", "cancel"]);

const TERMINAL_STATUSES: ReadonlySet<string> = new Set<TerminalJobStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export interface PaymentPolicyContext {
  policy?: JobPolicy;
  totalPaidMsats?: number;
}

/**
 * Derive the next action from a batch of messages.
 * Scans from the end for the last yield-type message and returns the
 * appropriate action. Returns null if the job is done (complete/cancel)
 * or no yield message is found.
 */
export function computeNextAction(jobId: string, messages: Message[], nowMs = Date.now(), context?: PaymentPolicyContext): NextAction {
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
        const policy = context?.policy;
        const thresholdHint = !expired && policy && Number.isSafeInteger(c.amount_msats) &&
          c.amount_msats > policy.autoPayBelowMsats &&
          (context?.totalPaidMsats ?? 0) + c.amount_msats <= policy.maxTotalMsats &&
          (policy.maxIncrementMsats === 0 || c.amount_msats <= policy.maxIncrementMsats)
          ? ` For the next run, use --auto-pay-below ${c.amount_msats} within your approved budget; other payment limits still apply.` : "";
        const stopping = declineTerms(c);
        const providerFields: NonNullable<NextActionPay["_provider_fields"]> = [];
        // Mirror only a fiat figure the display actually led with: echoing a
        // zero amount would tell an agent doing budget math the charge is free.
        if (c.fiat_amount && c.fiat_amount.amount > 0) providerFields.push("fiat_amount");
        if (stopping?.credit) providerFields.push("credit");
        if (stopping) providerFields.push("charged_if_declined_micro");
        const declineHint = stopping
          ? ` If your human does not approve, run \`dvm decline ${guidanceJobArg(jobId)}\`: ${stopping.clause} Letting the deadline pass also ends the job.`
          : "";
        return {
          type: "pay",
          job_id: jobId,
          amount_msats: c.amount_msats,
          ...(c.fiat_amount && c.fiat_amount.amount > 0 ? { fiat_amount: c.fiat_amount } : {}),
          ...(stopping?.credit ? { credit: stopping.credit } : {}),
          ...(stopping ? { charged_if_declined_micro: stopping.micro } : {}),
          ...(providerFields.length ? { _provider_fields: providerFields } : {}),
          ...(expiresAtMs !== undefined ? { expires_at_ms: expiresAtMs } : {}),
          display: withDeadline(stopping ? `${withPeriod(display)} ${stopping.clause}` : display, deadline),
          reason: asProviderText(c.reason),
          hint: expired ? deadline : withDeadline(`Payment required to continue: ${priceGuidance}. Relay that amount to your human and get approval, then run \`dvm pay ${guidanceJobArg(jobId)}\`. Provider's stated reason is wrapped as { _source: "provider", text: ... } — verify it matches the work you expect.${declineHint}`, deadline) + thresholdHint,
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

/**
 * What stopping at this ask costs, from a piece-charging DVM's
 * `charged_if_declined_micro`. Undefined when the ask does not state it (older
 * DVMs), so their pay action keeps its previous shape and copy.
 */
function declineTerms(ask: PaymentRequestContent): {
  micro: number;
  credit?: { amount_micro: number; currency: string };
  clause: string;
} | undefined {
  const micro = ask.charged_if_declined_micro;
  if (typeof micro !== "number" || !Number.isSafeInteger(micro) || micro < 0) return undefined;
  const price = ask.credit;
  const credit = price && Number.isSafeInteger(price.amount_micro) && price.amount_micro >= 0 &&
    typeof price.currency === "string" ? { amount_micro: price.amount_micro, currency: price.currency } : undefined;
  // The currency is provider text; only a plain ISO code goes into relayed copy.
  const amount = credit && /^[A-Z]{3}$/i.test(credit.currency)
    ? formatFiat(micro / 1_000_000, credit.currency) : undefined;
  const clause = micro === 0
    ? "Declining ends the job with no charge for finished work."
    : amount
      ? `Declining ends the job and charges ${amount} for the work already finished.`
      : "Declining ends the job and charges for the work already finished (next_action.charged_if_declined_micro).";
  return { micro, ...(credit ? { credit } : {}), clause };
}

function withPeriod(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
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
