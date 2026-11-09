import { hasPendingAcceptedJobAccess } from "./submission-evidence";
import { withJobPaymentLock } from "./payment-lock";
import { loadAnsweredYieldSeqs, reconcileInFlightPaymentRequest, settleRecordedPayments } from "./yield-state";
import { finishBookedSubmission, midJobSpendLabel } from "./taken-payment";
import { sameEndpoint } from "./job-access";
import { bookedCreditPayment, sendCreditPayment, tryCreditPayment } from "./credit-payment";
import { buildTempoCredential } from "./payment-rails/tempo-credential";
import {
  DvmError,
  isPublicRequestId,
  shellQuoteArg,
  type JobPolicy,
  loadAgentWallet,
  type MppxCredential,
  msatsToUsdc,
  type PaymentRequestContent,
  type ProviderInfo,
  type ProviderRef,
  type RailFlag,
  type OutboundMessage,
  type SendMessageOptions,
  tempoCredentialAmountMicro,
  toCashuProofs,
  decodePayment,
  exactEvmAuthorization,
  type Transport,
  usdcToMsats,
} from "@dvmkit/sdk/internal";
import { getEncodedToken } from "@cashu/cashu-ts";
import {
  addPayment,
  clearPaymentRequestInFlight,
  loadJob,
  hasUnknownUpfrontCredit,
  hasUnknownUpfrontRail,
  type HeldPaymentBlock,
  type JobRecord,
  markPaymentRequestPaid,
  markPaymentRequestInFlight,
  blockHeldPayment,
  type PaymentApproval,
  type UnconfirmedPaymentSubmission,
} from "./job-store";
import {
  info,
} from "./output";
import {
  loadConfig,
} from "./identity";
import {
  abandonPendingSubmission,
  commitAgentSpend,
  prepareAgentSpend,
  type PreparedAgentSpend,
} from "./wallet-agent/spend";
import { sweepPendingSubmissions } from "./wallet-agent/recovery-submissions";
import { enforceGlobalBudget, recordSpend } from "./budget-ledger";
import { tryResolveBtcUsdRate } from "./btc-rate";

import { withAgentWalletPaymentRetry } from "./agent-wallet-retry";
import { dvmFetch } from "./http";
import { applyMintPin } from "./mint-pin";
import { assertTempoChallengeNetwork, resolveTempoNetworkSelection } from "./tempo-network";
import { captureDrawFundingReceipts } from "./draw-funding";
import { loadRequestIntent } from "./request-intent-store";
import { heldPaymentResendable, paymentInFlightHint, pollNextAction, unresendablePaymentHint } from "./next-action";
import { guidanceJobArg, providerFields } from "./provider-output";

export interface PaidPaymentResult {
  status: "paid";
  rail: "cashu_p2pk" | "x402" | "tempo" | "credit";
  amountMsats: number;
  /** Exact signed x402 value in USDC microunits. */
  amountUsdcMicro?: string;
}

export type PaymentResult =
  | PaidPaymentResult
  | "needs-approval"
  | "over-budget"
  | "payment-cap-exceeded";

export async function handlePaymentRequest(
  jobId: string,
  request: PaymentRequestContent,
  policy: JobPolicy,
  transport: Transport,
  provider: ProviderRef,
  // `jobToken` is the anonymous-flow per-job token threaded into
  // every `payment` `sendMessage`.
  opts?: { jobToken?: string; rail?: RailFlag; maxCashuPrincipalSats?: number; requestSeq?: number; approval?: PaymentApproval; creditRecoveryOnly?: boolean }
): Promise<PaymentResult> {
  const seq = opts?.requestSeq;
  // An explicit `dvm pay` on an ask blocked from automatic payment is a
  // replacement attempt: its errors are about the new payment.
  let replacing = false;
  return withJobPaymentLock(jobId, (assertOwned) => {
    replacing = opts?.approval === "explicit" && seq !== undefined && loadJob(jobId)?.askPaymentBlocks?.[seq] !== undefined;
    // Guard every rail, balance recovery, and retry at the dispatch boundary.
    const guardedTransport = new Proxy(transport, {
      get(target, key) {
        if (key === "sendMessage") return async (...args: Parameters<Transport["sendMessage"]>) => {
          assertOwned();
          return target.sendMessage(...args);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return handleLockedPaymentRequest(jobId, request, policy, guardedTransport, provider, opts);
  }).catch((error: unknown) => {
    if (!(error instanceof DvmError)) throw error;
    const job = loadJob(jobId);
    if (!job || !provider.endpoint || !sameEndpoint(job.endpoint, provider.endpoint)) throw error;
    let requestId: string | undefined;
    if (job.requestId && isPublicRequestId(job.requestId)) {
      try {
        const intent = loadRequestIntent(job.requestId);
        if (intent && sameEndpoint(intent.endpoint, job.endpoint)) requestId = job.requestId;
      } catch {
        // Unreadable recovery metadata must not replace the payment refusal.
      }
    }
    // A payment held for this ask that a re-send cannot settle: the provider's
    // hint and the replacement text below would both be untrue here. An
    // explicit replacement's own refusal, such as the budget, keeps its hint.
    const heldUnsendable = !replacing && seq !== undefined && holdsPayment(job, seq) && !heldPaymentResendable(job, seq);
    if (error.code !== "payment_unconfirmed" && heldUnsendable) {
      error.hint = paymentInFlightHint(jobId, job, seq);
      if (error.proseSources?.hint) error.proseSources = { ...error.proseSources, hint: undefined };
    }
    // Its own hint already names the ways forward; no replacement is involved.
    if (error.code === "payment_unconfirmed" || heldUnsendable) {
      error.data = providerFields({
        ...error.data,
        job_id: jobId,
        next_action: providerFields({ ...pollNextAction(jobId, error.hint) }, ["job_id"]),
      }, ["job_id"]);
      throw error;
    }
    const command = requestId
      ? `dvm request-result ${shellQuoteArg(requestId)}`
      : `dvm status ${guidanceJobArg(jobId)}`;
    const recovery = `The job was already accepted. Inspect it with \`${command}\` before submitting a replacement. This read cannot submit a job or send payment.`;
    error.data = providerFields({
      ...error.data,
      job_id: jobId,
      ...(requestId ? { request_id: requestId } : {}),
      next_action: providerFields({ ...pollNextAction(jobId, recovery) }, ["job_id"]),
      next_step: [typeof error.data?.next_step === "string" ? error.data.next_step : undefined, recovery].filter(Boolean).join(" "),
    }, ["job_id"]);
    throw error;
  });
}

async function handleLockedPaymentRequest(
  jobId: string,
  request: PaymentRequestContent,
  policy: JobPolicy,
  transport: Transport,
  provider: ProviderRef,
  opts?: { jobToken?: string; rail?: RailFlag; maxCashuPrincipalSats?: number; requestSeq?: number; approval?: PaymentApproval; creditRecoveryOnly?: boolean }
): Promise<PaymentResult> {
  if (hasPendingAcceptedJobAccess(jobId, provider.endpoint)) throw new DvmError("local_job_state_unsaved",
    "Private recovery state must be folded before another payment can be sent.",
    "Run dvm status <job_id> --messages before paying; unresolved recovery records remain preserved.");
  const approval: { requestSeq: number; approval: PaymentApproval } | undefined = opts?.requestSeq === undefined ? undefined : {
    requestSeq: opts.requestSeq, approval: opts.approval ?? "auto",
  };
  const job = loadJob(jobId);
  if (job && hasUnknownUpfrontRail(job))
    throw new DvmError("upfront_rail_unknown", "The original upfront rail charge is unknown or conflicting.",
      "Recover the original job price before authorizing more payments.");
  if (job && hasUnknownUpfrontCredit(job))
    throw new DvmError("upfront_credit_unknown", "The original upfront credit debit is unknown or conflicting.",
      "Recover the accepted upfront amount with 'dvm request-result' before authorizing more payments.");

  // Caller-pinned spend mint, persisted at request time or by
  // `dvm pay --mint`. Honoured on every spend leg below — no fallback.
  const pinnedMint = job?.pinnedMint;
  const strictPerCall = job?.strictPerCall === true;
  const maxCashuFeeSats = job?.maxCashuFeeSats;
  // thread the per-job token onto every `sendMessage` for this job
  // so anonymous callers' mid-job payments don't 404 at the SDK gate.
  const jobToken = opts?.jobToken ?? job?.jobToken;

  const matchingEndpoint = !!job && !!provider.endpoint && sameEndpoint(job.endpoint, provider.endpoint);
  if (!matchingEndpoint && job?.pendingCreditPayment)
    throw new DvmError("credit_payment_endpoint_mismatch", "Recover this balance payment at its original endpoint.");
  if (job?.creditOnly && (!matchingEndpoint || !job.creditBinding || "unbound" in job.creditBinding ||
      job.creditBinding.creditId !== job.creditOnly || opts?.rail !== undefined))
    throw new DvmError("credit_only_unavailable", "This job may spend only its original prepaid credit.");
  let balanceRefused = false;
  const booked = matchingEndpoint ? bookedCreditPayment(jobId, opts?.requestSeq) : undefined;
  if (booked && (booked.request.amount_msats !== request.amount_msats ||
      booked.request.credit?.amount_micro !== request.credit?.amount_micro ||
      booked.request.credit?.currency !== request.credit?.currency))
    throw new DvmError("credit_payment_conflict", "The saved payment ask differs from this request.");
  if (booked) return { status: "paid", rail: "credit", amountMsats: booked.amountMsats ?? booked.request.amount_msats };
  if (job?.pendingCreditPayment) {
    const pending = job.pendingCreditPayment;
    const paid = await sendCreditPayment(jobId, pending, transport, provider, jobToken);
    if (paid) {
      if (pending.authorization.request_seq !== opts?.requestSeq)
        throw new DvmError("credit_payment_recovered", "The prior balance payment was recovered; reload this job before paying another ask.");
      return { status: "paid", rail: "credit", amountMsats: pending.amountMsats ?? pending.request.amount_msats };
    }
    balanceRefused = true;
    // An old unresolved ask cannot authorize a rail spend for a different ask.
    if (pending.authorization.request_seq !== opts?.requestSeq)
      throw new DvmError("credit_payment_retry_required", "The prior balance payment was refused; reload this job's pending ask.");
  }
  // A competing payer may clear the saved intent before this lock is acquired.
  if (opts?.creditRecoveryOnly)
    throw new DvmError("credit_payment_retry_required", "The saved balance payment was not recovered; no replacement payment was sent.",
      `Run \`dvm status ${shellQuoteArg(jobId)}\` to refresh the job, then run \`dvm pay ${shellQuoteArg(jobId)}\` only if payment is still requested.`);

  // A payment held for this ask was signed for the stored endpoint; another
  // endpoint must not be paid around it.
  if (!matchingEndpoint && job && opts?.requestSeq !== undefined && holdsPayment(job, opts.requestSeq))
    throw unconfirmedPaymentError(jobId, "An earlier payment for this request was sent to this job's stored endpoint and is unconfirmed.",
      `Re-send it with \`dvm pay ${guidanceJobArg(jobId)}\` without --endpoint; it re-delivers that same payment.`);

  let unconfirmed: UnconfirmedPaymentSubmission | undefined;
  if (matchingEndpoint && opts?.requestSeq !== undefined) {
    if (job.inFlightPaymentRequestSeqs?.includes(opts.requestSeq))
      await reconcileInFlightPaymentRequest(jobId, opts.requestSeq, transport, provider, { jobToken });
    await settleRecordedPayments(jobId);
    if (loadAnsweredYieldSeqs(jobId).has(opts.requestSeq))
      throw new DvmError("payment_already_sent", "Payment already sent for this request.",
        `Keep watching with \`dvm messages ${shellQuoteArg(jobId)} --wait\` before paying again.`);
    // Reconciliation may have resolved or released the earlier send.
    const current = loadJob(jobId);
    unconfirmed = current?.unconfirmedPaymentSubmissions?.[opts.requestSeq];
    // An in-flight send recorded by an older CLI kept no copy to re-deliver,
    // and the provider may still accept it.
    if (!unconfirmed && current?.inFlightPaymentRequestSeqs?.includes(opts.requestSeq))
      throw unconfirmedPaymentError(jobId, "An earlier payment for this request is unconfirmed and this CLI holds no copy to re-send.");
  }

  // Settling above can book an earlier payment, so the caps read the job now.
  const latest = loadJob(jobId);
  const spent = latest?.totalPaidMsats ?? 0;
  const paymentsHonoured = latest?.paymentsHonoured ?? 0;

  if (policy.maxIncrementMsats > 0 && request.amount_msats > policy.maxIncrementMsats) {
    return "over-budget";
  }

  if (spent + request.amount_msats > policy.maxTotalMsats) {
    return "over-budget";
  }

  // Check payment count cap (drip-attack defence)
  if (paymentsHonoured >= policy.maxPayments) {
    return "payment-cap-exceeded";
  }

  // Strict direct-Cashu is intentionally one upfront payment. A later ask has
  // no exact `/v1/job` recovery body and may not fall through to another rail.
  if (strictPerCall)
    throw new DvmError(
      "strict_per_call_mid_job_payment",
      "Strict per-call mode refuses additional mid-job payments.",
      "Verify the original one-payment quote; do not authorize a fallback or replacement payment."
    );

  if (request.amount_msats > policy.autoPayBelowMsats) return "needs-approval";

  // Before any balance or rail can sign a second payment for the same ask.
  if (unconfirmed && opts?.requestSeq !== undefined) {
    // A token that can still be re-delivered is sent again, never replaced.
    if (!unconfirmed.blocked)
      return redeliverUnconfirmedPayment({
        jobId, request, requestSeq: opts.requestSeq, submission: unconfirmed,
        transport, provider, jobToken, rail: opts.rail,
      });
    if (unconfirmed.blocked.reason === "not_resendable")
      throw unconfirmedPaymentError(jobId, "Sending the earlier payment for this request again cannot settle it.",
        paymentInFlightHint(jobId, loadJob(jobId), opts.requestSeq));
  }
  // A short payment kept as credit, or spent reserve proofs, settle nothing,
  // and the ask stays blocked whatever becomes of a replacement's own record:
  // only an explicit `dvm pay` may sign a fresh payment for it. The earlier
  // token stays in the wallet journal for the sweep's verdict.
  if (opts?.requestSeq !== undefined && loadJob(jobId)?.askPaymentBlocks?.[opts.requestSeq] && opts.approval !== "explicit")
    return "needs-approval";

  if (matchingEndpoint && !balanceRefused && opts?.rail === undefined) {
    const creditPaid = await tryCreditPayment({ jobId, request, policy,
      requestSeq: opts?.requestSeq, approval: opts?.approval ?? "auto", transport, provider, jobToken });
    if (creditPaid !== false) return { status: "paid", rail: "credit", amountMsats: creditPaid };
  }

  if (job?.creditOnly)
    throw new DvmError("credit_only_unavailable", "The selected prepaid credit cannot pay this ask; no fresh payment was attempted.");

  // Deposits already entered the wallet-outflow ledger; only a new rail spend
  // needs another global budget check and ledger entry.
  const btcRate = await enforceGlobalBudget({ plannedMsats: request.amount_msats });

  const cashuPrincipalSats = Math.ceil(request.amount_msats / 1000);
  if (
    opts?.maxCashuPrincipalSats !== undefined &&
    (opts.rail !== "cashu" ||
      !Number.isSafeInteger(opts.maxCashuPrincipalSats) ||
      opts.maxCashuPrincipalSats <= 0)
  ) {
    throw new DvmError(
      "invalid_cashu_principal_ceiling",
      "The Cashu principal ceiling is invalid for this payment.",
      "Use a positive integer ceiling together with an exact Cashu rail selection."
    );
  }
  if (
    opts?.maxCashuPrincipalSats !== undefined &&
    cashuPrincipalSats > opts.maxCashuPrincipalSats
  ) {
    throw new DvmError(
      "cashu_principal_ceiling_exceeded",
      `Cashu payment requires ${cashuPrincipalSats} sats, above the ${opts.maxCashuPrincipalSats}-sat ceiling.`,
      "Do not pay this request unless a new native-sat ceiling is approved."
    );
  }

  // Agent-wallet cashu_p2pk path: mirrors the upfront
  // `tryAgentWalletPayment` flow in `src/commands/request.ts`. This is the only
  // Cashu path. Soft-falls-
  // through on `no_eligible_mint` / `insufficient_balance`; hard errors propagate.
  if ((opts?.rail === undefined || opts.rail === "cashu") && loadAgentWallet()) {
    const paid = await tryAgentWalletMidJobPayment({
      jobId,
      request,
      transport,
      provider,
      btcRate,
      pinnedMint,
      maxCashuFeeSats,
      strictPerCall,
      approval,
      jobToken,
      requestSeq: matchingEndpoint ? opts?.requestSeq : undefined,
    });
    if (paid) {
      return { status: "paid", rail: "cashu_p2pk", amountMsats: request.amount_msats };
    }
  }

  if ((opts?.rail === undefined || opts.rail === "x402") && request.x402) {
    const { loadX402Wallet } = await import("./x402/wallet");
    const { tryX402Payment } = await import("./x402/client");
    const wallet = loadX402Wallet();
    if (wallet) {
      let proof;
      try {
        proof = await tryX402Payment(
          {
            amountMsats: request.amount_msats,
            requiredUsdcMicro: request.x402.required_usdc_micro,
            payTo: request.x402.pay_to,
            network: request.x402.network,
            asset: request.x402.asset,
            paymentRequired: request.x402.payment_required,
            // Price the USDC against the rate the cap check used, so the signed
            // amount and the ledger entry can't disagree.
            btcRate,
            // when the server stamped a per-job nonce on the
            // payment-request, sign against that exact `bytes32` so the
            // SDK's verify-side binding accepts the credential.
            ...(request.x402.nonce && { nonce: request.x402.nonce }),
          },
          wallet
        );
      } catch (err) {
        // Treat x402_build_failed as soft fall-through to preserve the
        // chained-fallback semantics for callers that hold multiple wallets.
        if (!(err instanceof DvmError) || err.code !== "x402_build_failed") throw err;
        proof = null;
      }
      if (proof) {
        // Bind the cross-job ledger ceiling to the amount actually signed,
        // which may be slightly higher than the msat quote at the caller's
        // contemporaneous BTC/USD rate.
        await enforceGlobalBudget({ plannedMsats: proof.amountMsats, btcRate: proof.btcRate });
        return deliverSignedRailPayment({
          jobId, request, transport, provider, jobToken, approval,
          requestSeq: matchingEndpoint ? opts?.requestSeq : undefined,
          submission: {
            rail: "x402",
            content: { x402_payment: proof.paymentHeader, amount_msats: proof.amountMsats },
            requestAmountMsats: request.amount_msats,
            amountMsats: proof.amountMsats,
            btcRate: proof.btcRate,
            amountUsdcMicro: proof.amountUsdcMicro,
            approval: approval?.approval,
            reason: request.reason,
          },
        });
      }
    }
  }

  if ((opts?.rail === undefined || opts.rail === "tempo") && request.tempo?.challenges.length) {
    // `enforceGlobalBudget` hands back 0 for an uncapped caller, so resolve a
    // rate of this rail's own when it did — Tempo prices in dollars and needs
    // one to hold the DVM's advertised figure to the ask. Same shape as
    // `tryX402Payment`'s `priceableRate`.
    const tempoRate = btcRate > 0 ? btcRate : ((await tryResolveBtcUsdRate())?.rate ?? 0);
    const cred = await tryMppCredential(request.tempo.challenges, request.amount_msats, tempoRate);
    if (cred) {
      // The challenge amount is what the credential authorizes, and the ask is
      // only the basis it was held within a tolerance of — so bind the ledger
      // ceiling and every entry to the signed figure, exactly as the x402
      // branch above does.
      const paidMsats = usdcToMsats(Number(tempoCredentialAmountMicro(cred)) / 1e6, tempoRate);
      await enforceGlobalBudget({ plannedMsats: paidMsats, btcRate: tempoRate });
      return deliverSignedRailPayment({
        jobId, request, transport, provider, jobToken, approval,
        requestSeq: matchingEndpoint ? opts?.requestSeq : undefined,
        submission: {
          rail: "tempo",
          content: { tempo_credential: cred, amount_msats: paidMsats },
          requestAmountMsats: request.amount_msats,
          amountMsats: paidMsats,
          btcRate: tempoRate,
          approval: approval?.approval,
          reason: request.reason,
        },
      });
    }
  }

  return "needs-approval";
}

function unconfirmedPaymentError(jobId: string, message: string, hint = unresendablePaymentHint(jobId)): DvmError {
  return new DvmError("payment_unconfirmed", `${message} No new payment was signed.`, hint);
}

function holdsPayment(job: JobRecord, requestSeq: number): boolean {
  return job.inFlightPaymentRequestSeqs?.includes(requestSeq) === true ||
    job.unconfirmedPaymentSubmissions?.[requestSeq] !== undefined;
}

/**
 * Send the payment already signed for this ask again, never a new one. The
 * provider settles a Cashu token once per `cashu_request_id`; a copy it already
 * took answers as a replay or as spent proofs, and either is booked as paid.
 */
async function redeliverUnconfirmedPayment(args: {
  jobId: string;
  request: PaymentRequestContent;
  requestSeq: number;
  submission: UnconfirmedPaymentSubmission;
  transport: Transport;
  provider: ProviderRef;
  jobToken?: string;
  rail?: RailFlag;
}): Promise<PaidPaymentResult> {
  const { jobId, request, submission, provider } = args;
  const sentRail: RailFlag = submission.rail === "cashu_p2pk" ? "cashu" : submission.rail;
  if (submission.requestAmountMsats !== request.amount_msats)
    throw unconfirmedPaymentError(jobId, "The unconfirmed payment held for this request answered a different amount.");
  if (args.rail !== undefined && args.rail !== sentRail)
    throw unconfirmedPaymentError(jobId, `An unconfirmed ${sentRail} payment was already sent for this request.`,
      `Re-send it with \`dvm pay ${guidanceJobArg(jobId)}\` without --rail; it re-delivers that same payment.`);
  if (submission.rail !== "cashu_p2pk")
    return deliverSignedRailPayment({ ...args, submission, redelivery: true });

  const wallet = loadAgentWallet();
  if (!wallet)
    throw unconfirmedPaymentError(jobId, "The agent wallet holding the unconfirmed Cashu payment for this request is unavailable.",
      `Restore the agent wallet, then run \`dvm pay ${guidanceJobArg(jobId)}\` to re-send that same payment. ${unresendablePaymentHint(jobId)}`);
  const held = wallet.pending_submissions.find((entry) => entry.request_id === submission.cashuRequestId);
  // Only a sweep verdict (applied before this point) settles a token the
  // wallet dropped; a forgotten or aged-out entry may still be redeemable,
  // and a recent spend can be a partial redeem rather than this payment.
  if (!held)
    throw unconfirmedPaymentError(jobId, "The wallet no longer holds the unconfirmed Cashu payment for this request and recorded no verdict on it.");
  const cashuToken = held.cashu_token ?? (held.output_proofs.length
    ? getEncodedToken({ mint: held.mint, proofs: toCashuProofs(held.output_proofs) }) : undefined);
  if (!cashuToken || !sameEndpoint(held.endpoint, provider.endpoint))
    throw unconfirmedPaymentError(jobId, "The unconfirmed Cashu payment for this request cannot be re-delivered.");
  await deliverAgentWalletPayment({
    ...args,
    submission: held.output_proofs.some((proof) => proof.reserved_for !== undefined) ? { ...submission, reserve: true } : submission,
    redelivery: true,
    prepared: {
      cashuToken,
      requestId: held.request_id,
      mint: held.mint,
      totalSats: held.amount_sats,
      endpoint: held.endpoint,
      intendedLockPubkey: held.intended_lock_pubkey,
    },
  });
  return { status: "paid", rail: "cashu_p2pk", amountMsats: request.amount_msats };
}

/** Send a signed x402 or Tempo payment and book it once the provider takes it. */
async function deliverSignedRailPayment(args: {
  jobId: string;
  request: PaymentRequestContent;
  submission: Extract<UnconfirmedPaymentSubmission, { rail: "x402" | "tempo" }>;
  transport: Transport;
  provider: ProviderRef;
  jobToken?: string;
  requestSeq?: number;
  approval?: { requestSeq: number; approval: PaymentApproval };
  redelivery?: boolean;
}): Promise<PaidPaymentResult> {
  const { jobId, submission, provider } = args;
  const sent = await sendRailPayment(args.transport, jobId,
    { type: "payment", content: submission.content } as OutboundMessage,
    provider, { jobToken: args.jobToken }, args.requestSeq, submission, args.redelivery);
  if (!sent.tracked) {
    addPayment(jobId, submission.amountMsats, args.approval);
    recordSpend({ msats: submission.amountMsats, btcRate: submission.btcRate, jobId,
      providerEndpoint: provider.endpoint, ...midJobSpendLabel(args.request.reason) });
  } else if (sent.booked) await finishBookedSubmission(jobId, sent.booked, provider.endpoint);
  return {
    status: "paid",
    rail: submission.rail,
    amountMsats: submission.amountMsats,
    ...(submission.amountUsdcMicro !== undefined ? { amountUsdcMicro: submission.amountUsdcMicro } : {}),
  };
}

/**
 * Pay a mid-job `payment-request` via the agent wallet's per-call
 * swap-and-ship plumbing. Returns `true` when the spend was
 * accepted; `false` when the rail doesn't apply (no lock pubkey, no mints,
 * or `prepareAgentSpend` returned `no_eligible_mint` / `insufficient_balance`).
 *
 * Crash-safety / capital preservation: on `sendMessage` failure we mirror
 * the upfront `payWithAgentWallet` lifecycle in `request.ts` —
 * `abandonPendingSubmission` only fires on `payment_invalid` (permanent
 * reject). Transient failures (5xx, network, exhausted transient-payment
 * retries) and `payment_lock_pubkey_stale` leave the `pending_submission`
 * on disk so `dvm wallet show` can surface the locked proofs for manual
 * recovery — the upfront-only `sweepPendingSubmissions` can't auto-replay
 * a mid-job send, but the capital stays reachable.
 */
async function tryAgentWalletMidJobPayment(args: {
  jobId: string;
  request: PaymentRequestContent;
  transport: Transport;
  provider: ProviderRef;
  btcRate: number;
  approval?: { requestSeq: number; approval: PaymentApproval };
  /** Caller-pinned spend mint. Narrows the allowlist to this mint. */
  pinnedMint?: string;
  /** Job-wide Cashu fee ceiling persisted by the original request. */
  maxCashuFeeSats?: number;
  /** Strict jobs never sweep pending state or select reserve proofs. */
  strictPerCall?: boolean;
  /** anonymous-flow per-job token; sent as `X-Job-Token` on the `payment` POST. */
  jobToken?: string;
  requestSeq?: number;
}): Promise<boolean> {
  const {
    jobId,
    request,
    transport,
    provider,
    btcRate,
    pinnedMint,
    maxCashuFeeSats,
    strictPerCall,
    approval,
    jobToken,
  } = args;

  // Drain any pending_submissions left by previous crashes. Best-effort —
  // failures stay on disk for the next sweep.
  if (!strictPerCall) await sweepPendingSubmissions({ fetchImpl: dvmFetch }).catch(() => undefined);

  // Resolve lock pubkey + mints. Prefer the values the DVM put on the
  // `payment-request` itself; fall back to `/v1/info` for either when
  // missing (older DVMs / `requestPayment` callers that don't surface them).
  //
  // `/v1/info` is now read unconditionally: a mid-job spend is the
  // one that can never be resumed by the submission sweep, so it is the most
  // important one to give a refund clause — and `cashu.canonical_id`, which
  // names the refund subkey, appears only on `/v1/info`. Best-effort as before;
  // an unreachable `/v1/info` just means no clause, not a failed payment.
  let info: ProviderInfo | undefined;
  try {
    info = await transport.describe(provider);
  } catch {
    info = undefined;
  }
  const lockPubkey = request.lock_pubkey ?? info?.cashu?.lock_pubkeys[0];
  let mints = request.mints?.length ? request.mints : info?.cashu?.mints;
  if (!lockPubkey || !mints || mints.length === 0) return false;

  // restrict the spend to the caller-pinned mint. Throws
  // `mint_not_allowed` (naming the accepted mints) when the pin isn't advertised.
  if (pinnedMint) mints = applyMintPin(mints, pinnedMint);

  // The `payment-request` may state its own locktime floor
  // (`min_locktime_seconds`); take whichever of the two surfaces asks for more,
  // and `undefined` when neither states one.
  const minLocktime =
    Math.max(info?.cashu?.min_locktime ?? 0, request.min_locktime_seconds ?? 0) || undefined;

  const amountSats = Math.ceil(request.amount_msats / 1000);
  let builderHandle: string | undefined;
  if (!strictPerCall)
    try {
      builderHandle = new URL(provider.endpoint).hostname.toLowerCase();
    } catch {
      builderHandle = undefined;
    }

  const prepared = await prepareAgentSpend({
    amountSats,
    endpoint: provider.endpoint,
    ...(maxCashuFeeSats !== undefined ? { maxCashuFeeSats } : {}),
    cashuP2pk: {
      mints,
      lock_pubkey: lockPubkey,
      canonical_id: info?.cashu?.canonical_id,
      min_locktime: minLocktime,
    },
    ...(builderHandle ? { builderHandle } : {}),
  });

  if ("error" in prepared) {
    if (
      !pinnedMint &&
      (prepared.error.code === "no_eligible_mint" || prepared.error.code === "insufficient_balance")
    ) {
      // Soft fall-through: legacy `~/.dvm/cashu.json` may still cover it.
      // Suppressed when a mint is pinned — restrict semantics mean
      // a shortfall at the pinned mint is a hard error, no fallback.
      return false;
    }
    throw new DvmError(
      prepared.error.code,
      prepared.error.message,
      prepared.error.hint,
      // the mints tried and why, so a mid-job payment failure names
      // the outage rather than a bare cashu-ts string.
      prepared.error.attempts ? { mint_attempts: prepared.error.attempts } : undefined
    );
  }

  await deliverAgentWalletPayment({ jobId, request, prepared, transport, provider, approval, jobToken,
    requestSeq: args.requestSeq,
    submission: {
      rail: "cashu_p2pk",
      cashuRequestId: prepared.requestId,
      ...(prepared.fromReserve ? { reserve: true as const } : {}),
      requestAmountMsats: request.amount_msats,
      amountMsats: request.amount_msats,
      btcRate,
      approval: approval?.approval,
      reason: request.reason,
    },
  });
  return true;
}

/** Ship a prepared or held Cashu token and book it once the provider takes it. */
async function deliverAgentWalletPayment(args: {
  jobId: string;
  request: PaymentRequestContent;
  prepared: PreparedAgentSpend;
  submission: Extract<UnconfirmedPaymentSubmission, { rail: "cashu_p2pk" }>;
  transport: Transport;
  provider: ProviderRef;
  approval?: { requestSeq: number; approval: PaymentApproval };
  jobToken?: string;
  requestSeq?: number;
  redelivery?: boolean;
}): Promise<void> {
  const { jobId, request, prepared, submission, transport, provider, approval, jobToken } = args;
  let sent: SentPayment;
  try {
    sent = await sendMidJobPaymentWithRetry({
      jobId,
      amountMsats: request.amount_msats,
      prepared,
      transport,
      provider,
      jobToken,
      requestSeq: args.requestSeq,
      submission,
      redelivery: args.redelivery,
    });
  } catch (err) {
    // Only a definite `payment_invalid` refusal abandons the wallet entry.
    // Every other failure, including exhausted `proof_pending` /
    // `mint_unreachable` retries, `payment_lock_pubkey_stale`, 5xx and network
    // errors, leaves the `pending_submission` on disk so the locked capital
    // stays recoverable and the same token can be re-delivered.
    if (err instanceof DvmError && err.code === "payment_invalid" && sendOutcome(err, submission, args.redelivery).kind === "refused") {
      await abandonPendingSubmission({ requestId: prepared.requestId, preserveRecovery: true });
    }
    // The provider no longer takes this token's lock key, but holding that key
    // it could still redeem it; a re-send gets the same answer.
    if (args.requestSeq !== undefined && err instanceof DvmError &&
        (err.code === "payment_lock_pubkey_stale" || err.code === "wrong_lock_pubkey")) {
      const reclaimAt = loadAgentWallet()?.pending_submissions.find((entry) => entry.request_id === prepared.requestId)?.t_expire;
      blockHeldPayment(jobId, args.requestSeq, { reason: "not_resendable", detail:
        "The provider no longer accepts the lock key this Cashu token was made for, though it may still redeem it." +
        (reclaimAt ? ` The wallet can take the token back after ${new Date(reclaimAt).toISOString()} if it does not.` : "") });
    }
    throw err;
  }

  if (sent.tracked) {
    if (sent.booked) await finishBookedSubmission(jobId, sent.booked, provider.endpoint);
    return;
  }
  await commitAgentSpend({
    requestId: prepared.requestId,
    recentSpend: {
      request_id: prepared.requestId,
      dvm_endpoint: provider.endpoint,
      mint: prepared.mint,
      amount_sats: prepared.totalSats,
      signed_at_ms: Date.now(),
    },
  });
  addPayment(jobId, request.amount_msats, approval);
  recordSpend({
    msats: request.amount_msats,
    btcRate: submission.btcRate,
    jobId,
    providerEndpoint: provider.endpoint,
    ...midJobSpendLabel(request.reason),
  });
}

/**
 * Ship a mid-job `payment` message under the retry policy:
 * transient payment rejections (`proof_pending` / `mint_unreachable`) retry with
 * exponential backoff, `wrong_lock_pubkey` retries once after refetching
 * `/v1/info`. Mirrors `submitAgentWalletWithRetry` for the upfront path.
 */
async function sendMidJobPaymentWithRetry(args: {
  jobId: string;
  amountMsats: number;
  prepared: PreparedAgentSpend;
  transport: Transport;
  provider: ProviderRef;
  sleep?: (ms: number) => Promise<void>;
  jobToken?: string;
  requestSeq?: number;
  submission: UnconfirmedPaymentSubmission;
  redelivery?: boolean;
}): Promise<SentPayment> {
  const { jobId, amountMsats, prepared, transport, provider, jobToken } = args;
  return withAgentWalletPaymentRetry({
    attempt: () =>
      sendRailPayment(transport,
        jobId,
        {
          type: "payment",
          content: {
            cashu_token: prepared.cashuToken,
            cashu_request_id: prepared.requestId,
            mint: prepared.mint,
            amount_msats: amountMsats,
          },
        },
        provider,
        { jobToken },
        args.requestSeq,
        args.submission,
        args.redelivery
      ),
    intendedLockPubkey: prepared.intendedLockPubkey,
    refetchInfo: () => transport.describe(provider),
    sleep: args.sleep,
  });
}

/**
 * `tracked` sends were journalled under their ask's seq; `booked` is the
 * submission this send booked, absent when a concurrent reader booked it first.
 * An untracked send (another endpoint) leaves booking to its caller.
 */
type SentPayment = { tracked: true; booked?: UnconfirmedPaymentSubmission } | { tracked: false };

async function sendRailPayment(
  transport: Transport,
  jobId: string,
  message: OutboundMessage,
  provider: ProviderRef,
  options?: SendMessageOptions,
  requestSeq?: number,
  submission?: UnconfirmedPaymentSubmission,
  redelivery?: boolean
): Promise<SentPayment> {
  // The acknowledgement's seq is a post-dispatch cursor, not the inbound
  // payment sequence signed by the provider.
  const capture = (evidence: { drawFundingReceipt?: unknown; drawFundingReceiptParseError?: unknown }) => {
    if (evidence.drawFundingReceiptParseError) info("Warning: mid-job funding evidence has an invalid shape.");
    if (evidence.drawFundingReceipt) captureDrawFundingReceipts(jobId, [evidence.drawFundingReceipt], {
      endpoint: provider.endpoint,
      ...(typeof message.content.cashu_request_id === "string" ? { fundId: message.content.cashu_request_id } : {}),
    });
  };
  // Persist before dispatch: a lost reply cannot distinguish a rejected send
  // from a payment the provider already accepted.
  if (requestSeq !== undefined) markPaymentRequestInFlight(jobId, requestSeq, submission);
  let result: Awaited<ReturnType<Transport["sendMessage"]>>;
  try {
    result = await transport.sendMessage(jobId, message, provider, options);
  } catch (error) {
    // A failure after deposit acceptance can still carry signed funding evidence.
    if (error instanceof DvmError && error.data) capture(error.data);
    const outcome = sendOutcome(error, submission, redelivery);
    if (requestSeq === undefined) {
      if (outcome.kind === "taken" && error instanceof DvmError && error.code === "replay_rejected") return { tracked: false };
      throw error;
    }
    if (outcome.kind === "taken") return { tracked: true, booked: markPaymentRequestPaid(jobId, requestSeq) };
    if (outcome.kind === "blocked") blockHeldPayment(jobId, requestSeq, outcome.blocked);
    else if (outcome.kind === "refused") clearPaymentRequestInFlight(jobId, requestSeq);
    else if (outcome.kind === "not_sent") clearPaymentRequestInFlight(jobId, requestSeq, { keepSubmission: true });
    else markPaymentRequestInFlight(jobId, requestSeq);
    throw error;
  }
  // Book the accepted ask before receipt parsing can fail, so a later stream
  // never constructs a fresh payment for the same seq.
  const sent: SentPayment = requestSeq === undefined ? { tracked: false }
    : { tracked: true, booked: markPaymentRequestPaid(jobId, requestSeq) };
  if (result) capture(result);
  return sent;
}

/**
 * Provider refusals that examine these exact proofs or this credential and
 * keep nothing, checked against the codes the SDK's receive path answers with.
 * Only these release an ask for a new payment, and only when the provider's
 * own `error` field named the code. Transient mint answers (`proof_pending`,
 * `mint_unreachable`), throttling (408, 425, 429), a prose `Job not found` and
 * every unlisted or unstructured answer hold the payment instead.
 */
const DEFINITE_REFUSALS: ReadonlySet<string> = new Set([
  "payment_invalid",
  "lock_not_exclusive",
  "not_p2pk_locked",
  "cashu_not_p2pk_locked",
  "invalid_token",
  "invalid_message",
  "invalid_input",
  "invalid_request",
]);

type SendOutcome =
  | { kind: "taken" | "refused" | "not_sent" | "unknown" }
  | { kind: "blocked"; blocked: HeldPaymentBlock };

function sendOutcome(error: unknown, submission: UnconfirmedPaymentSubmission | undefined, redelivery: boolean | undefined): SendOutcome {
  if (!(error instanceof DvmError)) return { kind: requestNeverSent(error) ? "not_sent" : "unknown" };
  if (error.code === "replay_rejected") return { kind: "taken" };
  const status = error.data?.http_status;
  if (typeof status !== "number" || status < 400 || status >= 500) return { kind: "unknown" };
  // A code the transport filled in for a body that named none proves nothing.
  if (error.data?.code_source === "inferred") return { kind: "unknown" };
  const cashu = submission?.rail === "cashu_p2pk" ? submission : undefined;
  if (cashu && error.code === "proof_not_unspent") {
    // The receive path checks proof state before replay detection, so a token
    // it already redeemed answers as spent proofs. Outputs swapped for this
    // payment went only to this provider, so spent means it redeemed them;
    // reserve proofs could have paid another call.
    if (!cashu.reserve) return { kind: "taken" };
    return { kind: "blocked", blocked: { reason: "proofs_spent",
      detail: "The reserve proofs the earlier Cashu payment used are already spent at the mint and the provider recorded no payment for this charge, but it may already have redeemed this token for this charge, so paying again may pay twice." } };
  }
  // A short Cashu payment is accepted into the provider's accumulator before
  // the shortfall is found: the token is kept, held on credit where the
  // provider has a ledger, so it is neither refused nor a payment of the ask.
  // The SDK sends this code on no other rail mid-job, so another provider's
  // short x402 or Tempo answer is held the same way rather than trusted.
  if (error.code === "payment_insufficient")
    return { kind: "blocked", blocked: { reason: "credit_held",
      ...(typeof error.data?.credit_id === "string" ? { creditId: error.data.credit_id } : {}) } };
  // The same request id already carries another payment there; a re-send gets the same answer.
  if (error.code === "request_id_reused")
    return { kind: "blocked", blocked: { reason: "not_resendable",
      detail: "The provider did not take this payment, because its request id already carries a different payment there." } };
  if (!DEFINITE_REFUSALS.has(error.code)) return { kind: "unknown" };
  // After a lost first send, `payment_invalid` may mean the provider already
  // took this credential: it answers that way for a Tempo credential it used,
  // and for an x402 authorization it settled before writing its replay marker.
  // An authorization that never settled stays unpaid, so holding loses nothing.
  if (redelivery && submission && submission.rail !== "cashu_p2pk" && error.code === "payment_invalid")
    return { kind: "blocked", blocked: { reason: "not_resendable", detail: submission.rail === "tempo"
      ? "The provider refused the earlier Tempo credential, which it also does for one it already used."
      : `${x402RefusalNote(submission.content.x402_payment)} It also answers that way for an authorization it already settled.` } };
  return { kind: "refused" };
}

/** Name an x402 authorization's expiry, beside the refusal of its re-delivery. */
function x402RefusalNote(header: unknown): string {
  try {
    const validBefore = Number(exactEvmAuthorization(decodePayment(String(header))).validBefore) * 1000;
    if (Number.isFinite(validBefore))
      return validBefore <= Date.now()
        ? `The provider refused the earlier x402 authorization, which expired at ${new Date(validBefore).toISOString()}.`
        : "The provider refused the earlier x402 authorization before it expired.";
  } catch {
    // An undecodable header still leaves the provider's refusal as the outcome.
  }
  return "The provider refused the earlier x402 authorization.";
}

/** These failures occur before an HTTP request can reach the provider. */
function requestNeverSent(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof DvmError) return false;
  // A generic fetch failure or ECONNRESET can also mean a lost acknowledgement.
  if ("code" in error && ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"].includes(String(error.code))) return true;
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(requestNeverSent);
  return requestNeverSent(error.cause);
}

/**
 * Try to build an MPP credential for one of the offered challenges using the
 * locally-persisted MPP wallet. Returns the structured credential when a
 * matching challenge can be satisfied, otherwise null.
 *
 * Tempo is the only per-call MPP method dvmkit DVMs accept today. Stripe is
 * not a per-call DVM rail — it covers the platform-side subscription flow
 * (builder→platform) only; see `docs/payments.md`. Stripe-typed MPP
 * challenges from a third-party DVM are unreachable here on purpose and
 * fall through to needs-approval.
 */
async function tryMppCredential(
  challenges: NonNullable<PaymentRequestContent["tempo"]>["challenges"],
  amountMsats: number,
  btcRate: number
): Promise<MppxCredential | null> {
  const wallet = loadConfig()?.tempo;
  if (wallet?.method !== "tempo" || !wallet.apiKey) return null;
  const network = resolveTempoNetworkSelection(wallet.network, undefined);
  assertTempoChallengeNetwork(challenges, network, ["charge"]);
  // Without a rate the caller has no dollar figure of its own, so it cannot
  // tell an honest conversion of the ask from an over-charge. Fall through to
  // `needs-approval` rather than sign blind — a human then sees the amount.
  if (btcRate <= 0) {
    // Say why. The other two refusal paths on this rail log (the upfront leg's
    // skip, `buildTempoCredential`'s `onError: "null"`), and a bare
    // `needs-approval` gives the agent nothing to relay.
    info(
      "Skipping the Tempo rail: it prices in USDC and the BTC/USD rate is unavailable (no cached rate on this machine)."
    );
    return null;
  }
  return buildTempoCredential({
    challenges,
    privateKey: wallet.apiKey,
    basisMicro: msatsToUsdc(amountMsats, btcRate),
    onError: "null",
  });
}
