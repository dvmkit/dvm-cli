import { type PaymentRailKey, paymentRailLabel } from "../lib/rail-labels";
import { formatPaymentAmount } from "../lib/currency";
import { buildCompletionHintFields, completionFromMessages, nextStepHint } from "../lib/completion-hints";
import {
  asProviderText,
  DvmError,
  loadAgentWallet,
  type PaymentRequestContent,
  type RailFlag,
} from "@dvmkit/sdk/internal";
import {
  connectedTempoAccount,
} from "../lib/payment-rails/tempo-wallet";
import {
  info,
  json,
} from "../lib/output";
import {
  loadX402Wallet,
} from "../lib/x402/wallet";
import {
  updateJob,
} from "../lib/job-store";

import { takeCreditNoticeFields } from "../lib/credit-notice";
import { formatIdentifier } from "../lib/dvm-identifier";
import { takeFeedbackNoticeFields } from "../lib/feedback-notice";
import { noteFeedbackAfterTerminal } from "../lib/feedback-nudges";
import { parseForcedRail } from "../lib/forced-rail";
import {
  type JobAccessOptions,
  type ResolvedStoredJobAccess,
  resolveStoredJobAccess,
  withJobTokenRedaction,
} from "../lib/job-access";
import { loadMessages } from "../lib/messages";
import { applyMintPin } from "../lib/mint-pin";
import { paidConfirmationDisplay } from "../lib/payment-copy";
import { handlePaymentRequest, type PaidPaymentResult } from "../lib/payment-responder";
import { finalizeProgressLine } from "../lib/progress-bar";
import { createArtifactSaveSession } from "../lib/save-artifact";
import { streamLoop } from "../lib/stream-loop";
import { persistStreamOutcome, streamTerminalStatus } from "../lib/stream-outcome";
import { createDvmTransport } from "../lib/transport";
import { dvmIdentity } from "./dvm-identity";
import { formatMessageHuman, serializeMessageForOutput } from "./messages";

export interface PayOptions extends JobAccessOptions {
  human?: boolean;
  /** Timeout in seconds for streaming (default: 30) */
  timeout?: string;
  /**
   * Pin the Cashu spend mint for this payment. Overrides any mint
   * pinned at request time. Persisted onto the job so subsequent legs honour it.
   */
  mint?: string;
  /** Force this payment request onto one rail, with no fallback. */
  rail?: string;
  /** Refuse Cashu proof selection above this exact principal ceiling. */
  maxCashuPrincipalSats?: string;
}

export async function pay(jobId: string, opts: PayOptions): Promise<void> {
  const access = resolveStoredJobAccess(jobId, opts);
  return withJobTokenRedaction(access.jobToken, () => payWithAccess(jobId, opts, access));
}

async function payWithAccess(
  jobId: string,
  opts: PayOptions,
  access: ResolvedStoredJobAccess
): Promise<void> {
  const rail = parseForcedRail(opts.rail);
  const maxCashuPrincipalSats = parsePositiveCashuSats(opts.maxCashuPrincipalSats);
  if (maxCashuPrincipalSats !== undefined && rail !== "cashu") {
    throw new DvmError(
      "cashu_principal_ceiling_requires_cashu",
      "--max-cashu-principal-sats requires --rail cashu.",
      "Force the Cashu rail or omit the Cashu-specific ceiling."
    );
  }
  const artifactSession = opts.human ? createArtifactSaveSession() : undefined;
  const { stored, ref, jobToken } = access;

  const msgs = loadMessages(jobId);
  const pending = stored.pendingCreditPayment;
  const paymentMessage = findPendingPaymentRequest(msgs);
  const paymentReq = pending?.request ?? paymentMessage?.content;
  const requestSeq = pending?.authorization.request_seq ?? paymentMessage?.seq;
  if (!paymentReq) {
    throw new DvmError(
      "no_payment_pending",
      "No pending payment request found for this job.",
      "Use 'dvm messages' to check the job's state."
    );
  }

  // Persist any `--mint` override before paying so the spend path and
  // streamLoop both read the same pin off the job record. Validate
  // against this payment-request's advertised mints *before* writing the field
  // — otherwise a bad pin poisons the job: it would be persisted, throw, and
  // every subsequent `dvm pay <job>` (even without --mint) would re-read the
  // bad pin and re-fail, stranding the job.
  if (opts.mint) {
    applyMintPin(paymentReq.mints ?? [], opts.mint);
    updateJob(jobId, { pinnedMint: opts.mint });
  }

  const transport = createDvmTransport();

  if (!stored.policy) {
    throw new DvmError(
      "no_budget",
      "Cannot pay — this job has no spending policy.",
      'Resubmit with --budget and --max-payments. Set a default budget with: dvm wallet setup --default-budget "$1"'
    );
  }

  // Explicit pay approves this ask; the locally priced native debit must still
  // fit the hard increment/total caps rather than the provider's msat proxy.
  const payPolicy = { ...stored.policy, autoPayBelowMsats: stored.policy.maxTotalMsats };

  // No cost anchor: the caller reached `dvm pay` by deciding this charge was
  // worth it, so "fraction of a cent" here is noise rather than orientation.
  info(
    `Paying ${formatPaymentAmount(paymentReq.amount_msats, paymentReq.fiat_amount, { anchor: false })}...`
  );
  // anonymous-flow per-job token threaded through the `payment`
  // POST and the follow-up streamLoop's reads.
  const result = await handlePaymentRequest(jobId, paymentReq, payPolicy, transport, ref, {
    jobToken,
    rail,
    maxCashuPrincipalSats,
    requestSeq,
    approval: "explicit",
  });

  if (result === "over-budget") {
    transport.close();
    throw new DvmError("over_budget", "Payment would exceed the job's budget.");
  }

  if (result === "payment-cap-exceeded") {
    transport.close();
    const cap = stored.policy.maxPayments;
    throw new DvmError(
      "payment_cap_exceeded",
      "Job has reached its maximum payment count.",
      `The provider has sent more payment-requests than --max-payments allows. Inspect with 'dvm messages ${jobId}' and 'dvm cancel ${jobId}' if unintended. Raise with '--max-payments ${cap + 1}' or investigate why this provider is asking for many small payments.`,
      {
        anchor: "max_payments_exceeded",
        display: `Payment cap reached (${cap} payment${cap === 1 ? "" : "s"})`,
        jobId,
        paymentsHonoured: stored.paymentsHonoured ?? 0,
        maxPayments: cap,
      }
    );
  }

  if (result === "needs-approval") {
    transport.close();
    throw await buildNeedsApprovalError(paymentReq, rail, !stored.creditBinding && !!paymentReq.credit);
  }

  const paid = paymentConfirmation(result, paymentReq.reason, paymentReq.fiat_amount);

  const timeoutMs = opts.timeout ? Number(opts.timeout) * 1000 : undefined;
  const afterSeq = access.endpointOverridden ? 0 : (stored.messageCursor ?? 0);
  const streamResult = await streamLoop({
    jobId,
    transport,
    provider: ref,
    policy: stored.policy,
    afterSeq,
    timeoutMs,
    jobToken,
    persistLocalState: !access.endpointOverridden,
  });

  // a payment that resumes the handler through to `complete` is this
  // path's only signal the job is over — record the terminal status and its
  // snapshot so `dvm status` answers from the local record, as `dvm request` does.
  // The spend itself is already booked by `handlePaymentRequest` (addPayment).
  const streamedTerminal =
    streamResult.nextAction === null ? streamTerminalStatus(streamResult.messages) : undefined;
  const completion = access.endpointOverridden
    ? streamedTerminal
      ? completionFromMessages(streamResult.messages)
      : undefined
    : persistStreamOutcome({
        jobId,
        messages: streamResult.messages,
        cursor: streamResult.cursor,
        afterSeq,
      });
  // a payment that runs the handler through to `complete` ends the
  // job right here, so this is a job-terminal emission like the request arcs.
  if (streamedTerminal && !access.endpointOverridden) {
    noteFeedbackAfterTerminal({
      jobId,
      dvmId: stored.dvmId,
      endpoint: stored.endpoint,
      status: streamedTerminal,
      human: opts.human,
    });
  }
  transport.close();

  const identifier = stored.dvmId ? formatIdentifier(stored.dvmId, stored.capability) : undefined;

  if (opts.human) {
    info(`${paid.display}${identifier ? ` [${identifier}]` : ""}`);
    for (const msg of streamResult.messages) {
      // `jobId` is what lets an artifact in the resumed stream reach disk —
      // without it `formatMessageHuman` prints the label and drops the bytes.
      formatMessageHuman(msg, jobId, artifactSession);
    }
    if (completion) {
      const hint = nextStepHint(jobId, completion.payloadIn, completion.artifactCount);
      if (hint) info(`📎 ${hint}`);
    }
    finalizeProgressLine();
  } else {
    json({
      jobId,
      ...dvmIdentity(stored.dvmId, stored.capability),
      paid,
      messages: streamResult.messages.map(serializeMessageForOutput),
      // A payment that resumes the handler through to `complete` ends the job
      // here, and this path has no transport receipt to read the outcome off —
      // so without these an agent that pays sees `next_action: null` and can't
      // tell whether the payload is the summary or artifacts it must go fetch
      // Mirrors what `dvm request` renders on the upfront-paid arc.
      ...(completion?.summary !== undefined ? { summary: completion.summary } : {}),
      ...(completion ? buildCompletionHintFields(jobId, completion) : {}),
      ...takeCreditNoticeFields(),
      ...takeFeedbackNoticeFields(),
      next_action: streamResult.nextAction,
      ...(streamResult.autoPayments.length > 0 ? { auto_payments: streamResult.autoPayments } : {}),
    });
  }
}

function paymentConfirmation(
  result: PaidPaymentResult,
  reason: string,
  fiat?: { amount: number; currency: string }
): {
  msats: number;
  rail: PaidPaymentResult["rail"];
  reason: ReturnType<typeof asProviderText>;
  amount_usdc_microunits?: string;
  display: string;
} {
  return {
    msats: result.amountMsats,
    rail: result.rail,
    reason: asProviderText(reason),
    ...(result.amountUsdcMicro !== undefined && {
      amount_usdc_microunits: result.amountUsdcMicro,
    }),
    display: paidConfirmationDisplay(result, fiat),
  };
}

/**
 * Build a structured `payment_failed` error explaining why no rail could
 * satisfy this `payment-request`. The old hint blanket-asserted
 * "no wallet configured?" — misleading when the agent wallet is configured
 * but, e.g., the cashu_p2pk swap path returned `insufficient_balance` and
 * the DVM offers no other rail.
 */
async function buildNeedsApprovalError(
  req: PaymentRequestContent,
  forcedRail?: RailFlag,
  unknownCreditBinding = false
): Promise<DvmError> {
  // Raw keys in the machine fields, glossed wording in the prose: an agent
  // branches on `configured_rails` / `advertised_rails`, a human reads the
  // display and has no way to look up what "cashu_p2pk" is.
  const configured: PaymentRailKey[] = [];
  if (loadAgentWallet()) configured.push("cashu");
  if (await connectedTempoAccount()) configured.push("tempo");
  if (loadX402Wallet()) configured.push("x402");

  const advertised: PaymentRailKey[] = [];
  if (req.lock_pubkey || (req.mints?.length ?? 0) > 0) advertised.push("cashu");
  if (req.x402) advertised.push("x402");
  if (req.tempo?.challenges.length) advertised.push("tempo");

  const configuredProse = configured
    .map((r) => (r === "cashu" ? `${paymentRailLabel(r)} (agent wallet)` : paymentRailLabel(r)))
    .join(", ");
  const advertisedProse =
    advertised.length > 0 ? advertised.map(paymentRailLabel).join(", ") : "(none advertised)";

  const display =
    forcedRail
      ? `The selected ${paymentRailLabel(forcedRail)} rail could not satisfy this payment request.`
      : configured.length === 0
      ? `No payment wallets configured locally; this service accepts: ${advertisedProse}.`
      : `No locally-configured rail could satisfy this payment-request. Configured: ${configuredProse}. This service accepts: ${advertisedProse}.`;

  const bindingHint = unknownCreditBinding ? " This saved job has no known credit/draw binding, so its prepaid balance cannot safely pay this ask." : "";
  const hint =
    forcedRail
      ? `Check that the service advertises ${paymentRailLabel(forcedRail)} and that its local wallet has enough funds, or retry without --rail to allow fallback.`
      : configured.length === 0
      ? "Run `dvm wallet init` + `dvm wallet fund` for ecash, or `dvm wallet fund --rail tempo` for Tempo stablecoin."
      : configured.includes("x402") && advertised.includes("x402")
        ? "Run `dvm wallet balance` to check the x402 USDC balance, then fund the displayed wallet address with the exact USDC on the advertised network."
        : "The agent wallet may be short on the requested amount or locked to a different mint. Inspect with `dvm wallet show`, then top up or run with a higher `--auto-pay-below`.";

  return new DvmError("payment_failed", display, hint + bindingHint, {
    anchor: "no_rail_matched",
    display,
    configured_rails: configured,
    advertised_rails: advertised,
    ...(forcedRail ? { selected_rail: forcedRail } : {}),
  });
}

function parsePositiveCashuSats(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw.trim());
  if (raw.trim() === "" || !Number.isSafeInteger(value) || value <= 0) {
    throw new DvmError(
      "invalid_max_cashu_principal",
      `Invalid --max-cashu-principal-sats value: ${raw}`,
      "Pass an exact positive integer number of sats."
    );
  }
  return value;
}

function findPendingPaymentRequest(
  msgs: { type: string; content: unknown; seq: number }[]
): { content: PaymentRequestContent; seq: number } | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (msg.type === "payment") return undefined; // Already paid
    if (msg.type === "payment-request") {
      return { content: msg.content as PaymentRequestContent, seq: msg.seq };
    }
  }
  return undefined;
}
