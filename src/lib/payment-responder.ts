import { buildTempoCredential } from "./payment-rails/tempo-credential";
import {
  DvmError,
  type JobPolicy,
  loadAgentWallet,
  type MppxCredential,
  msatsToUsdc,
  type PaymentRequestContent,
  type ProviderInfo,
  type ProviderRef,
  type RailFlag,
  tempoCredentialAmountMicro,
  type Transport,
  usdcToMsats,
} from "@dvmkit/sdk/internal";
import {
  addPayment,
  loadJob,
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

export interface PaidPaymentResult {
  status: "paid";
  rail: "cashu_p2pk" | "x402" | "tempo";
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
  opts?: { jobToken?: string; rail?: RailFlag; maxCashuPrincipalSats?: number }
): Promise<PaymentResult> {
  const job = loadJob(jobId);
  const spent = job?.totalPaidMsats ?? 0;
  const paymentsHonoured = job?.paymentsHonoured ?? 0;
  // Caller-pinned spend mint, persisted at request time or by
  // `dvm pay --mint`. Honoured on every spend leg below — no fallback.
  const pinnedMint = job?.pinnedMint;
  const strictPerCall = job?.strictPerCall === true;
  const maxCashuFeeSats = job?.maxCashuFeeSats;
  // thread the per-job token onto every `sendMessage` for this job
  // so anonymous callers' mid-job payments don't 404 at the SDK gate.
  const jobToken = opts?.jobToken ?? job?.jobToken;

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

  // Check the global budget ledger — captures cross-job spending. Throws DvmError on overflow.
  // Returns the BTC/USD rate to thread into the post-payment recordSpend so pre-check and debit
  // use a single rate.
  const btcRate = await enforceGlobalBudget({ plannedMsats: request.amount_msats });

  if (request.amount_msats > policy.autoPayBelowMsats) {
    return "needs-approval";
  }

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
      jobToken,
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
        await transport.sendMessage(
          jobId,
          {
            type: "payment",
            content: {
              x402_payment: proof.paymentHeader,
              amount_msats: proof.amountMsats,
            },
          },
          provider,
          { jobToken }
        );
        addPayment(jobId, proof.amountMsats);
        recordSpend({
          msats: proof.amountMsats,
          btcRate: proof.btcRate,
          jobId,
          providerEndpoint: provider.endpoint,
          ...midJobSpendLabel(request.reason),
        });
        return {
          status: "paid",
          rail: "x402",
          amountMsats: proof.amountMsats,
          amountUsdcMicro: proof.amountUsdcMicro,
        };
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
      await transport.sendMessage(
        jobId,
        {
          type: "payment",
          content: {
            tempo_credential: cred,
            amount_msats: paidMsats,
          },
        },
        provider,
        { jobToken }
      );
      addPayment(jobId, paidMsats);
      recordSpend({
        msats: paidMsats,
        btcRate: tempoRate,
        jobId,
        providerEndpoint: provider.endpoint,
        ...midJobSpendLabel(request.reason),
      });
      return { status: "paid", rail: "tempo", amountMsats: paidMsats };
    }
  }

  return "needs-approval";
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
/**
 * Spend-label fields recorded in the budget ledger for a mid-job payment,
 * rendered by `dvm wallet history`. The provider's `payment-request.reason`
 * is provider-supplied free text, so it's tagged `labelSource: "provider"` and
 * the history command provenance-wraps it on relay. Omitted when blank.
 */
function midJobSpendLabel(reason: string): { label?: string; labelSource?: "provider" } {
  const text = reason.trim();
  return text ? { label: text, labelSource: "provider" } : {};
}

async function tryAgentWalletMidJobPayment(args: {
  jobId: string;
  request: PaymentRequestContent;
  transport: Transport;
  provider: ProviderRef;
  btcRate: number;
  /** Caller-pinned spend mint. Narrows the allowlist to this mint. */
  pinnedMint?: string;
  /** Job-wide Cashu fee ceiling persisted by the original request. */
  maxCashuFeeSats?: number;
  /** Strict jobs never sweep pending state or select reserve proofs. */
  strictPerCall?: boolean;
  /** anonymous-flow per-job token; sent as `X-Job-Token` on the `payment` POST. */
  jobToken?: string;
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

  try {
    await sendMidJobPaymentWithRetry({
      jobId,
      amountMsats: request.amount_msats,
      prepared,
      transport,
      provider,
      jobToken,
    });
  } catch (err) {
    // Per the crash-safety contract: only abandon on `payment_invalid`
    // (DVM rejected the spend permanently). Everything else — including
    // `payment_lock_pubkey_stale`, exhausted `proof_pending` /
    // `mint_unreachable` retries, 5xx, and network errors — leaves the
    // `pending_submission` on disk so the locked capital remains recoverable.
    if (err instanceof DvmError && err.code === "payment_invalid") {
      await abandonPendingSubmission({ requestId: prepared.requestId });
    }
    throw err;
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

  addPayment(jobId, request.amount_msats);
  recordSpend({
    msats: request.amount_msats,
    btcRate,
    jobId,
    providerEndpoint: provider.endpoint,
    ...midJobSpendLabel(request.reason),
  });
  return true;
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
}): Promise<void> {
  const { jobId, amountMsats, prepared, transport, provider, jobToken } = args;
  await withAgentWalletPaymentRetry({
    attempt: () =>
      transport.sendMessage(
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
        { jobToken }
      ),
    intendedLockPubkey: prepared.intendedLockPubkey,
    refetchInfo: () => transport.describe(provider),
    sleep: args.sleep,
  });
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
