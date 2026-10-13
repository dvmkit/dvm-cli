import { buildTempoCredential } from "./payment-rails/tempo-credential";
/**
 * Funds prepaid credit over Cashu, Lightning, x402 or Tempo. Before payment, an unavailable rail
 * may fall back; a funding refusal stops the cascade. Once money or signed authority has been
 * presented, resume the original durable fund id instead of paying again.
 *
 * x402 exact authorizations and reusable-channel deposits have separate journals. Tempo charge
 * credentials expire quickly while their funding intents survive for reconciliation; session
 * vouchers record capture authority separately from deposited collateral.
 */

import { randomUUID } from "crypto";
import { sha256hex } from "@dvmkit/sdk/internal";
import { Challenge, Credential } from "mppx";
import { privateKeyToAccount } from "viem/accounts";

import { tryResolveBtcUsdRate } from "./btc-rate";
import { enforceGlobalBudget, recordSpend, recordSpendOnce } from "./budget-ledger";
import { signDvmRequestData } from "@dvmkit/sdk/internal";
import {
  clearPendingFunding,
  listPendingFundings,
  loadCreditX402Binding,
  loadPendingFunding,
  normalizeCreditEndpoint,
  type PendingFunding,
  recordCreditX402Instrument,
  recordFundResponse,
  recordPendingFunding,
  type StoredCreditX402Binding,
} from "@dvmkit/sdk/internal";
import { formatUsd, usdToMsats } from "@dvmkit/sdk/internal";
import { microToSats } from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";
import {
  assertFloatBudget,
  emitFloatBudgetWarning,
  type Float,
  type FloatPayment,
  floatPaymentDisplay,
  fundViaFloat,
  loadFloat,
} from "./float";
import {
  loadConfig,
} from "./identity";
import {
  clearPendingTempoChargeFunding,
  listResumableTempoChargeFundings,
  loadResumableTempoChargeFunding,
  loadTempoChannelAssociation,
  type PendingTempoChargeFunding,
  recordPendingTempoChargeFunding,
  TEMPO_CHARGE_PENDING_STALE_MS,
  tempoChargeCredentialSettleable,
  withTempoChannelLock,
} from "@dvmkit/sdk/internal";
import {
  tempoCredentialAmountMicro,
  tempoCredentialValidBefore,
} from "@dvmkit/sdk/internal";
import {
  assertTempoSessionChallengeWithinAsk,
  assertTempoSessionDepositWithinCap,
  assertTempoSessionVoucherWithinAsk,
  createTempoCreditSession,
  createTempoSessionPaymentFetch,
  offersTempoCreditCharge,
  offersTempoCreditFunding,
  offersTempoCreditSession,
  persistTempoOpenCredential,
  tempoSessionAssociationByKey,
  tempoSessionChallenge,
  tempoSessionChallengeChannelScope,
  type TempoSessionClientResolver,
  tempoSessionCredentialChannelScope,
  tempoSessionCredentialCumulativeMicro,
  tempoSessionCumulativeCapMicro,
  tempoSessionPriorCumulativeMicro,
  withholdsTempoCreditSession,
} from "@dvmkit/sdk/internal";
import {
  type TempoAccount,
} from "@dvmkit/sdk/internal";
import {
  connectedTempoAccount,
} from "./payment-rails/tempo-wallet";
import { TEMPO_SESSION_UPDATED_REASON } from "@dvmkit/sdk/internal";
import {
  captureFundingReceipt,
} from "./receipt-capture";
import { type AttestedDvmIdentity, attestedDvmIdentity } from "@dvmkit/sdk/internal";
import { signedRequestDomain } from "@dvmkit/sdk/internal";
import type {
  CreditMenu,
  CreditOpResult,
  LightningFundingOffer,
  Payment,
  ProviderInfo,
  ProviderRef,
  Transport,
} from "@dvmkit/sdk/internal";
import { redactUrlsInText } from "@dvmkit/sdk/internal";
import { loadAgentWallet } from "@dvmkit/sdk/internal";
import {
  abandonPendingSubmission,
  commitAgentSpend,
  prepareAgentSpend,
} from "./wallet-agent/spend";
import {
  acknowledgeReplayedX402Payment,
  assertX402RequirementDescribesChannel,
  canReplaceExpiredX402Deposit,
  createX402BatchPayment,
  processX402BatchCorrection,
  processX402BatchResponse,
  processX402BatchResponseForWallet,
  x402RequiredFromError,
} from "@dvmkit/sdk/internal";
import {
  x402VoucherPendingRefusal,
} from "./x402/batch-client";
import {
  acknowledgeX402ChannelOwner,
  clearPendingX402ExactFunding,
  clearPendingX402Funding,
  findX402Channel,
  listPendingX402Fundings,
  listResumableX402ExactFundings,
  listResumableX402Fundings,
  loadResumableX402ExactFunding,
  loadResumableX402Funding,
  type PendingX402ExactFunding,
  type PendingX402Funding,
  recordPendingX402ExactFunding,
  recordPendingX402Funding,
  retirePendingX402Funding,
  type StoredX402ChannelMetadata,
  withX402ChannelLock,
  x402PendingBlockExpiresAt,
  x402PendingDepositExpiresAt,
  x402PendingRetired,
  x402PendingUnsettled,
} from "@dvmkit/sdk/internal";
import {
  isSignableExactRequirement,
} from "@dvmkit/sdk/internal";
import {
  tryX402Payment,
} from "./x402/client";
import { assertX402ChannelPayer } from "@dvmkit/sdk/internal";
import {
  offersX402CreditChannel,
  offersX402CreditFlavour,
  offersX402CreditFunding,
  x402CreditChannelNetworks,
  x402CreditExactNetworks,
  type X402CreditFlavour,
  x402CreditFlavour,
  x402CreditFundingNetworks,
  type X402CreditInstrument,
  x402FlavourForInstrument,
  x402InstrumentForFlavour,
} from "@dvmkit/sdk/internal";
import {
  x402NetworkLabel,
} from "./x402/networks";
import {
  decodePayment,
  type PaymentRequired as X402PaymentRequired,
  type PaymentRequirementsV1,
  type PaymentRequirementsV2,
  X402_BATCH_SETTLEMENT_SCHEME,
  X402_EXACT_SCHEME,
  x402NetworkToCaip2,
} from "@dvmkit/sdk/internal";
import type { X402Wallet } from "@dvmkit/sdk/internal";
import {
  loadX402Wallet,
} from "./x402/wallet";

import {
  type CreditFundRail,
  type CreditFundingMode,
  STABLECOIN_FUND_RAILS,
  fundingModeForTempoIntent,
  fundingModeForX402Flavour,
  isCreditFundRail,
  isStablecoinFundRail,
} from "@dvmkit/sdk/internal";
export {
  CREDIT_DRAIN_RAILS,
  CREDIT_FUNDING_MODES,
  CREDIT_FUND_RAILS,
  type CreditDrainRail,
  type CreditFundRail,
  type CreditFundingMode,
  STABLECOIN_FUND_RAILS,
  fundingModeForTempoIntent,
  fundingModeForX402Flavour,
  isCreditFundRail,
  isCreditFundingMode,
  isStablecoinFundRail,
} from "@dvmkit/sdk/internal";

/**
 * Where a forced rail came from. Kept apart because they are not
 * the same claim: the first three are the caller's preference, the fourth is
 * the DVM's ledger refusing to blend two rails' native value.
 */
export type CreditRailSource =
  /** `--rail` on this invocation. */
  | "flag"
  /** `config.credit.perDvm.<endpoint>.fundingRail`. */
  | "per_dvm"
  /** `config.credit.fundingRail`. */
  | "global"
  /** The credit is already funded on this rail, so `/v1/credit` admits no other. */
  | "credit_bound";

/**
 * Why the picker put the rail it did at the head of the order — the structured
 * half of "every funding names its route and the reason".
 */
export type CreditRailReason =
  /** A `--rail` flag, a `fundingRail` pin, or the credit's existing binding decided it. */
  | "forced"
  /** The amount clears the DVM's advertised Lightning floor, and a float is connected. */
  | "above_lightning_minimum"
  /** The amount is under that floor, so only ecash can carry it. */
  | "below_lightning_minimum"
  /** The DVM advertises no Lightning floor, so the client never invents one. */
  | "no_lightning_minimum"
  /** The DVM takes Lightning, but no float is connected here. */
  | "no_float"
  /** This DVM's menu doesn't offer Lightning funding at all. */
  | "lightning_not_offered"
  /** An x402 channel is the only locally usable funding route. */
  | "x402_channel"
  /** A per-call `exact` x402 authorization is the only locally usable route. */
  | "x402_exact"
  /** A connected Tempo wallet can open or reuse the advertised session. */
  | "tempo_session_available"
  /** A one-shot Tempo charge is the available stablecoin funding route. */
  | "tempo_charge";

export interface CreditRailPick {
  /** Rails to attempt, in order. Empty when nothing is usable. */
  order: CreditFundRail[];
  reason: CreditRailReason;
  /** Set only on `reason: "forced"`. */
  source?: CreditRailSource;
}

/** Why a rail couldn't be used — distinguishes "not this rail" from "no". */
export type CreditFundStatus =
  /** The credit was funded (or a replay confirmed it already had been). */
  | "funded"
  /**
   * The money left the Lightning wallet and is recorded, but the DVM hadn't
   * observed settlement by the time we stopped asking. Crediting is
   * pull-based: the next request to this DVM settles it.
   */
  | "settlement_pending"
  /** No rail could be used at all — nothing was attempted, nothing moved. */
  | "unavailable"
  /** The DVM refused the funding itself. Trying another rail would not help. */
  | "refused";

export interface CreditFundOutcome {
  status: CreditFundStatus;
  /** The rail actually used, when one was. */
  rail?: CreditFundRail;
  creditId: string;
  fundId: string;
  /** Validated public settlement transaction for a stablecoin funding. */
  transactionHash?: string;
  /** Micro-units the server says it credited. */
  fundedMicro?: number;
  /** The server's post-funding view of the credit. */
  credit?: CreditOpResult["credit"];
  /** Sats that left a Cashu or Lightning wallet. Absent for stablecoin funding. */
  spentSats?: number;
  /** Lightning invoice principal. Present only after a Lightning payment moved. */
  principalSats?: number;
  /** Wallet-reported Lightning routing fee. Null means the wallet omitted it. */
  routingFeeSats?: number | null;
  /** Total Lightning wallet fee. Null means the total is unprovable. */
  totalWalletFeeSats?: number | null;
  /** Wallet fee not itemized as routing. Null means the split is unprovable. */
  unitemizedWalletFeeSats?: number | null;
  /** Exact Lightning wallet debit. Null means wallet evidence could not prove it. */
  walletDebitSats?: number | null;
  /** Stablecoin micro-units committed through a Tempo charge or session. */
  spentMicro?: number;
  /** How the Lightning payment resolved — `reconciled` means it was not re-sent. */
  paymentOutcome?: "paid" | "reconciled" | "republished";
  /**
   * The provider's operator repaired a blocked invoice, so the balance is on a
   * credit this caller never named. `creditId` is that credit, not
   * the one the funding was requested against. Distinct from
   * `paymentOutcome: "reconciled"`, which is about the wallet's own retry.
   */
  reconciled?: boolean;
  /** Relayable prose for the agent's human, always populated. CLI-authored. */
  display: string;
  hint?: string;
  /**
   * The DVM's own copy about this funding, where it sent any — kept apart from
   * `display`/`hint` because those are the fields an agent is told to act on
   * and a provider does not get to write them. Surfaced by the
   * caller wrapped as `{ _source: "provider", text }`.
   */
  providerDisplay?: string;
  providerHint?: string;
  /** The refusal, when `status` is `refused` or a rail failed outright. */
  error?: DvmError;
  /**
   * The rail this credit is bound to, when the DVM refused a top-up for
   * arriving on a different one. Lets a stale local record heal itself in one
   * hop instead of retrying a rail that can never work.
   */
  requiredRail?: CreditFundRail;
  /**
   * Why {@link pickCreditFundRail} ordered the rails the way it did.
   * Present on every outcome, including a fallback's — it describes the routing
   * decision, not which rail happened to answer.
   */
  railReason?: CreditRailReason;
  /** Where a forced rail came from. Set only when {@link railReason} is `forced`. */
  railSource?: CreditRailSource;
  /** The x402 mechanism that actually ran, independent of the routing reason. */
  x402Flavour?: X402CreditFlavour;
  /** The Tempo mechanism that actually ran, independent of the routing reason. */
  tempoIntent?: "charge" | "session";
  /**
   * Whether the instrument that ran was a one-shot payment or reusable channel
   * collateral — the customer-level reading of {@link x402Flavour} /
   * {@link tempoIntent}, and the field a caller who passed `--funding-mode`
   * checks to see that they got what they asked for. Present on every
   * stablecoin outcome, forced or not; absent on Cashu and Lightning, which
   * have no such choice.
   */
  fundingMode?: CreditFundingMode;
}

export interface FundCreditArgs {
  transport: Transport;
  ref: ProviderRef;
  signing: { privkey: string; pubkey: string };
  /** The credit to fund. Caller-minted uuid opens a new one. */
  creditId: string;
  /** Idempotency key for this funding — reused verbatim on every retry. */
  fundId?: string;
  /** How much to fund, in micro-units of the menu currency. */
  amountMicro: number;
  /**
   * Absent menus preserve legacy Cashu/Lightning eligibility. Stablecoin rails require an
   * explicit advertised credit capability.
   */
  menu?: CreditMenu;
  /** `/v1/info`, for the Cashu offer a proof attach needs. */
  providerInfo?: ProviderInfo;
  /** Exact Cashu mint to use for this funding. Omit to use the DVM's advertised allowlist. */
  cashuMint?: string;
  /** Maximum Cashu token principal, in sats, for this funding. */
  maxCashuPrincipalSats?: number;
  /** Maximum Cashu swap fee, in sats, for this funding. */
  maxCashuFeeSats?: number;
  /** Refill target to persist alongside the funded balance. */
  targetMicro?: number;
  /** Maximum stablecoin deposit authorization allowed for this channel funding. */
  maxDepositMicro?: number;
  /** Force one rail instead of letting the rule pick. */
  rail?: CreditFundRail;
  /** What forced it — a flag, a persisted pin, or the credit's binding. Defaults to `flag`. */
  railSource?: CreditRailSource;
  /**
   * Force a one-shot or reusable stablecoin instrument instead of letting the
   * rail's own preference pick. Narrows the eligible rails to
   * {@link STABLECOIN_FUND_RAILS}, since neither Bitcoin rail has the choice.
   *
   * Outranks the menu's default preference and is subordinate to the credit's
   * existing binding: a mode that disagrees with what this credit was opened
   * over is refused locally before anything is signed, never silently
   * reinterpreted. Left unset by the automatic refill, whose preference order
   * this must not disturb.
   */
  fundingMode?: CreditFundingMode;
  /** Test seam for the request-signing dependency (avoids a hard cycle). */
  signBody?: (privkey: string, body: Record<string, unknown>) => Record<string, unknown>;
  /** Test seam — defaults to the configured float. */
  float?: Float | null;
  /** Select prose rather than structured progress for pre-payment warnings. */
  human?: boolean;
  /** Test seam — defaults to the configured Tempo account. */
  tempoAccount?: TempoAccount | null;
  /** Test seam for the challenge's Tempo chain client. */
  tempoGetClient?: TempoSessionClientResolver;
  /** Test seam around mppx's challenge-aware fetch lifecycle. */
  tempoFetch?: (args: {
    fetch: typeof globalThis.fetch;
    input: RequestInfo | URL;
    init?: RequestInit;
  }) => Promise<Response>;
}

/** Hard ceiling on any single `/v1/credit` POST. */
const CREDIT_POST_TIMEOUT_MS = 15_000;

/**
 * Codes on which a funding can never land — the DVM has refused this funding,
 * not this rail, so a prepared spend is dropped and no other rail is tried.
 */
const CREDIT_PERMANENT_REFUSALS = new Set([
  "credit_over_max",
  "credit_below_min",
  "credit_not_supported",
  "one_shot_credit_not_supported",
  "credit_id_unavailable",
  "caller_mismatch",
  "funding_commitment_mismatch",
]);

/**
 * Codes the caller raises against itself on the Tempo charge leg, before the
 * DVM ever sees a credential: the advertised amount was unreadable, or above
 * what this funding agreed to pay. Nothing was signed, but they still stop the
 * cascade — see the branch in `mppChargeRefusal`.
 */
const TEMPO_AMOUNT_REFUSALS = new Set(["tempo_amount_exceeds_limit", "tempo_amount_invalid"]);

/**
 * How many times to re-ask the DVM whether the invoice settled. Real wallets
 * take a moment to see an incoming payment; past this the funding is reported
 * as pending rather than failed, because the money has already moved and
 * crediting is pull-based.
 */
const SETTLEMENT_POLLS = 3;
/** Backoff between settlement polls. */
const SETTLEMENT_POLL_DELAY_MS = 1_500;

/**
 * Attempts eligible rails in order and returns structured funding outcomes. Store or wallet-
 * loading errors may still escape.
 */
export async function fundCredit(args: FundCreditArgs): Promise<CreditFundOutcome> {
  // One place to stamp the customer-level reading of the instrument that ran,
  // so every exit below — a resumed journal as much as a fresh funding — says
  // whether the money went out as a one-shot payment or as reusable collateral.
  return withFundingMode(await runCreditFunding(args));
}

async function runCreditFunding(args: FundCreditArgs): Promise<CreditFundOutcome> {
  // Resume the requested credit's durable authority before honoring a new rail preference. A new
  // payment while that authority remains usable can charge the same funding twice.
  const x402Pending = pendingX402ForCredit(args);
  if (x402Pending) {
    if (!args.rail || args.rail === "x402") {
      return fundOverX402(argsFromPendingX402(args, x402Pending), x402Pending.fundId, x402Pending);
    }
    return voucherPendingOutcome(
      { creditId: args.creditId, fundId: x402Pending.fundId, rail: args.rail },
      x402Pending,
      `This credit already has a signed x402 voucher awaiting acknowledgement, so it cannot be funded over ${args.rail}.`
    );
  }

  // Replay an exact authorization with its original header and fund id, even if the invocation
  // now requests another instrument.
  const x402ExactPending = pendingX402ExactForCredit(args);
  if (x402ExactPending) {
    const wallet = loadX402Wallet();
    if (wallet && (!args.rail || args.rail === "x402")) {
      return fundOverX402Exact(
        argsFromPendingX402Exact(args, x402ExactPending),
        x402ExactPending.fundId,
        wallet
      );
    }
    return exactAuthorizationPendingOutcome(args, x402ExactPending, Boolean(wallet));
  }

  // Resume the existing charge intent under its original fund id before choosing a new rail.
  const tempoChargePending = pendingTempoChargeForCredit(args);
  if (tempoChargePending) {
    const account =
      args.tempoAccount === undefined ? await connectedTempoAccount() : args.tempoAccount;
    if (account && (!args.rail || args.rail === "tempo")) {
      return fundOverMppCharge(
        argsFromPendingTempoCharge(args, tempoChargePending),
        tempoChargePending.fundId
      );
    }
    return tempoChargePendingOutcome(args, tempoChargePending, Boolean(account));
  }

  const pending = loadPendingFunding(args.ref.endpoint, args.signing.pubkey, args.creditId);
  if (pending) {
    if (!pendingFundingExpired(pending)) {
      const resumed = argsFromPending(args, pending);
      return pending.rail === "tempo"
        ? fundOverMpp(resumed, pending.fundId, pending)
        : fundOverLightning(resumed, pending.fundId, pending);
    }
    clearPending(pending);
  }

  const fundId = args.fundId ?? randomUUID();
  const base = { creditId: args.creditId, fundId };
  // A funding mode names a stablecoin instrument, so it narrows the eligible
  // set rather than reordering it: answering `--funding-mode
  // reusable` by quietly paying over ecash would drop the only thing the flag
  // asked for. Every refusal below this line is reached before a rail leg runs.
  const eligible = args.fundingMode
    ? availableRails(args).filter(isStablecoinFundRail)
    : availableRails(args);

  const x402Network = loadX402Wallet()?.network;
  const x402Binding = boundX402Binding(args);
  // Outstanding signed authority takes precedence over mode changes, before any new credential
  // is created.
  const mode = args.fundingMode;
  if (mode) {
    const refused = fundingModeRefusal({
      args,
      mode,
      fundId,
      rails: eligible,
      binding: x402Binding,
      ...(x402Network ? { x402Network } : {}),
    });
    if (refused) return refused;
  }
  // Past the gate, a rail that only advertises the other instrument is no
  // longer a candidate: leaving it in the order would spend a discovery
  // round-trip on a leg whose only possible answer is "not offered" before the
  // cascade reached the rail that can drive the mode. The gate ran against the
  // unnarrowed set so its forced-rail refusals keep naming that rail.
  const rails = mode
    ? eligible.filter((rail) => railOffersMode(args, rail, mode, x402Network))
    : eligible;
  const pick = pickCreditFundRail({
    rails,
    amountMicro: args.amountMicro,
    ...(x402Network ? { x402Network } : {}),
    ...(x402Binding.instrument ? { x402Instrument: x402Binding.instrument } : {}),
    ...(args.menu ? { menu: args.menu } : {}),
    tempoCredit: {
      endpoint: args.ref.endpoint,
      callerPubkey: args.signing.pubkey,
      creditId: args.creditId,
    },
    ...(args.rail ? { forced: args.rail } : {}),
    ...(args.railSource ? { forcedSource: args.railSource } : {}),
    ...(mode ? { fundingMode: mode } : {}),
  });
  const railFields = {
    railReason: pick.reason,
    ...(pick.source ? { railSource: pick.source } : {}),
  };

  if (args.rail && pick.order.length === 0) {
    return {
      ...base,
      ...railFields,
      status: "unavailable",
      display: unavailableDisplay(args, args.rail),
      hint: forcedRailHint(args, args.rail),
    };
  }

  const order = pick.order;
  const tried = new Set<CreditFundRail>();
  let last: CreditFundOutcome | undefined;
  for (let i = 0; i < order.length; i++) {
    const rail = order[i];
    if (tried.has(rail)) continue;
    tried.add(rail);
    const attempted =
      rail === "cashu"
        ? await fundOverCashu(args, fundId)
        : rail === "lightning"
          ? await fundOverLightning(args, fundId)
          : rail === "x402"
            ? await fundOverX402Rail(args, fundId, x402Binding)
            : await fundOverMppRail(args, fundId);
    // The pick is what the *funding* was routed by, so it rides every outcome —
    // including a fallback's, where "why Lightning was tried first" is exactly
    // what makes the ecash that followed legible.
    const outcome = { ...railFields, ...attempted };
    // A DVM-level refusal is the DVM's answer to the funding, not to the rail.
    if (outcome.status !== "unavailable") return outcome;
    last = outcome;
    // The DVM named the rail this credit is bound to — go straight there
    // rather than working through an order that can only be refused again.
    // Not when the caller forced a rail: silently paying over a different one
    // than they asked for is worse than telling them it can't be done.
    if (!args.rail && outcome.requiredRail && rails.includes(outcome.requiredRail)) {
      order.splice(i + 1, 0, outcome.requiredRail);
    }
  }
  return (
    last ?? {
      ...base,
      ...railFields,
      status: "unavailable",
      display: unavailableDisplay(args),
      hint: "Fund the agent's Cashu wallet ('dvm wallet fund'), connect a Lightning wallet ('dvm wallet connect', with the connection string piped in), or connect Tempo ('dvm wallet tempo-connect') when the DVM offers that rail.",
    }
  );
}

/**
 * Reconciles existing durable fundings independently, tolerating an entry's network failure. It
 * may complete session management or re-sign an expired Tempo charge under the existing fund id;
 * it does not create a new funding intent.
 */
export async function pollPendingCreditFundings(args: {
  transport: Transport;
  ref: ProviderRef;
  signing: { privkey: string; pubkey: string };
  /** Test seam for the request-signing dependency (avoids a hard cycle). */
  signBody?: (privkey: string, body: Record<string, unknown>) => Record<string, unknown>;
}): Promise<void> {
  const pending = listPendingFundings({
    endpoint: args.ref.endpoint,
    callerPubkey: args.signing.pubkey,
  });
  for (const funding of pending) {
    if (pendingFundingExpired(funding)) {
      clearPending(funding);
      continue;
    }

    const fundArgs = argsFromPending(args, funding);
    if (funding.rail === "tempo") {
      await fundOverMpp(fundArgs, funding.fundId, funding).catch(() => undefined);
      continue;
    }
    const base = {
      creditId: funding.creditId,
      fundId: funding.fundId,
      rail: "lightning" as const,
    };
    try {
      const result = await postCredit(fundArgs, lightningCreditBody(funding));
      settleAndClear(fundArgs, base, result, lightningSpendFromPending(funding), funding);
    } catch (err) {
      const offer = lightningOffer(err);
      if (offer) {
        const enriched = withLightningOffer(funding, offer);
        recordPendingFunding(enriched);
        if (pendingFundingExpired(enriched)) clearPending(enriched);
      } else if (shouldClearPending(err)) {
        clearPending(funding);
      }
    }
  }
  for (const funding of listResumableX402Fundings({
    endpoint: args.ref.endpoint,
    callerPubkey: args.signing.pubkey,
  })) {
    // Contained like the tempo arm above: one entry whose lock or store write
    // throws must not cost the remaining entries their sweep.
    await fundOverX402(
      {
        ...args,
        ref: { endpoint: funding.endpoint },
        creditId: funding.creditId,
        fundId: funding.fundId,
        amountMicro: funding.amountMicro,
        targetMicro: funding.targetMicro,
        rail: "x402",
      },
      funding.fundId,
      funding
    ).catch(() => undefined);
  }
  // The Tempo charge arm. Contained per entry like the two above,
  // and skipped wholesale without a connected Tempo account — the credential is
  // journalled, but a resume past its deadline has to sign, and the signer needs
  // the wallet.
  const tempoCharges = listResumableTempoChargeFundings({
    endpoint: args.ref.endpoint,
    callerPubkey: args.signing.pubkey,
  });
  // Read after the list, not before: this sweep runs after every job, and an
  // empty journal must not cost it a wallet lookup.
  const tempoAccount = tempoCharges.length > 0 ? await connectedTempoAccount() : null;
  if (tempoAccount) {
    for (const funding of tempoCharges) {
      await fundOverMppCharge(
        {
          ...args,
          ref: { endpoint: funding.endpoint },
          creditId: funding.creditId,
          fundId: funding.fundId,
          amountMicro: funding.amountMicro,
          targetMicro: funding.targetMicro,
          tempoAccount,
          rail: "tempo",
        },
        funding.fundId,
        funding
      ).catch(() => undefined);
    }
  }
  // The exact arm. Narrower than the channel one by construction:
  // `listResumableX402ExactFundings` already drops anything past its own
  // `validBefore`, so a sweep never re-presents a header that can no longer
  // settle. Nothing to do without a wallet — the header is journalled, but the
  // resume still resolves the flavour off the connected chain.
  const exactWallet = loadX402Wallet();
  if (!exactWallet) return;
  for (const funding of listResumableX402ExactFundings({
    endpoint: args.ref.endpoint,
    callerPubkey: args.signing.pubkey,
  })) {
    await fundOverX402Exact(
      {
        ...args,
        ref: { endpoint: funding.endpoint },
        creditId: funding.creditId,
        fundId: funding.fundId,
        amountMicro: funding.amountMicro,
        targetMicro: funding.targetMicro,
        rail: "x402",
      },
      funding.fundId,
      exactWallet,
      funding
    ).catch(() => undefined);
  }
}

/**
 * The rails that could be used against this DVM right now: advertised in the
 * menu (when one is known) and usable locally. Order is the preference rule —
 * Cashu first, Lightning as the rail that works when ecash can't.
 */
export function availableRails(args: {
  menu?: CreditMenu;
  providerInfo?: ProviderInfo;
  float?: Float | null;
  tempoAccount?: TempoAccount | null;
}): CreditFundRail[] {
  const advertised = args.menu?.funding;
  const offers = (rail: CreditFundRail): boolean => !advertised || advertised.includes(rail);
  const rails: CreditFundRail[] = [];
  const cashu = args.providerInfo?.cashu;
  if (offers("cashu") && cashu && cashu.lock_pubkeys.length > 0 && cashu.mints.length > 0) {
    rails.push("cashu");
  }
  const float = args.float === undefined ? loadFloat() : args.float;
  if (offers("lightning") && float) rails.push("lightning");
  // A connected wallet plus `funding: ["x402"]` is not enough: the menu's
  // scheme list has to name a flavour this caller can build on this wallet's
  // own chain. Both flavours qualify — a batch-settlement channel or
  // a per-call `exact` authorization — but a scheme list naming
  // neither, or naming them only on other chains, answers the POST with no
  // requirement this wallet can sign and the funding dead-ends. Dropping the
  // rail here is what lets the loop reach the next eligible one instead.
  const x402Wallet = offers("x402") ? loadX402Wallet() : null;
  if (x402Wallet && offersX402CreditFunding(args.menu, x402Wallet.network)) rails.push("x402");
  if (offers("tempo") && offersTempoCreditFunding(args.menu) && hasConnectedTempoWallet(args)) {
    rails.push("tempo");
  }
  return rails;
}

/**
 * Prefer direct Lightning at or above the advertised receive floor. An unknown floor never
 * invents a threshold; below-floor funds use available pocket value first.
 */
export function preferLightningFirst(menu: CreditMenu | undefined, amountMicro: number): boolean {
  return menu?.lightning_min_micro !== undefined && amountMicro >= menu.lightning_min_micro;
}

/**
 * Returns eligible rails in routing order. Forced rails must remain eligible; reasons describe
 * that ordering even when a later rail ultimately pays.
 */
export function pickCreditFundRail(args: {
  /** Eligibility set — {@link availableRails}. */
  rails: readonly CreditFundRail[];
  amountMicro: number;
  menu?: CreditMenu;
  /**
   * CAIP-2 chain the connected x402 wallet is pinned to, when there is one.
   * Only the reported reason depends on it — it is what tells an x402-first
   * order which flavour is about to be driven, at a DVM that advertises a
   * channel on one chain and `exact` on this wallet's.
   */
  x402Network?: string;
  /**
   * The x402 instrument the credit being funded is bound to, when one is
   * recorded. Like {@link x402Network}, only the reported reason
   * depends on it — but it decides that reason outright, because a bound credit
   * funds over its own instrument whatever the menu prefers.
   */
  x402Instrument?: X402CreditInstrument;
  /**
   * Identity of the credit being funded, when the caller has one. It lets the
   * reason name a reusable Tempo session that is withheld for new credits but
   * still available to this credit's existing channel.
   */
  tempoCredit?: TempoCreditIdentity;
  /** A rail the caller, a pin, or the credit's binding requires. */
  forced?: CreditFundRail;
  /** Which of those it was. Defaults to `flag`. */
  forcedSource?: CreditRailSource;
  /**
   * A forced stablecoin instrument. Like {@link x402Network}, only
   * the reported reason depends on it — but it decides that reason outright for
   * a stablecoin head, because the leg drives what was asked for rather than
   * what the menu prefers.
   */
  fundingMode?: CreditFundingMode;
}): CreditRailPick {
  if (args.forced) {
    return {
      order: args.rails.includes(args.forced) ? [args.forced] : [],
      reason: "forced",
      source: args.forcedSource ?? "flag",
    };
  }
  const rails = [...args.rails];
  if (preferLightningFirst(args.menu, args.amountMicro) && rails.includes("lightning")) {
    return {
      order: ["lightning", ...rails.filter((rail) => rail !== "lightning")],
      reason: "above_lightning_minimum",
    };
  }
  return {
    order: rails,
    reason: cashuFirstReason(
      args.menu,
      rails,
      args.x402Network,
      args.x402Instrument,
      args.tempoCredit,
      args.fundingMode
    ),
  };
}

/**
 * Use a verified attested identity pair for pooling; otherwise retain the origin fallback. An
 * unsigned builder advertisement does not authenticate the DVM.
 */
function fundedDvmIdentity(
  providerInfo: ProviderInfo | undefined
): AttestedDvmIdentity | undefined {
  return attestedDvmIdentity(providerInfo?.builder);
}

function identityArg(identity: AttestedDvmIdentity | undefined): {
  identity?: AttestedDvmIdentity;
} {
  return identity ? { identity } : {};
}

interface X402FundBase {
  creditId: string;
  fundId: string;
  rail: "x402";
  x402Flavour: X402CreditFlavour;
}

interface MppFundBase {
  creditId: string;
  fundId: string;
  rail: "tempo";
  tempoIntent: "charge" | "session";
}

interface TempoCreditIdentity {
  endpoint: string;
  callerPubkey: string;
  creditId: string;
}

function hasConnectedTempoWallet(args: { tempoAccount?: TempoAccount | null }): boolean {
  if (args.tempoAccount !== undefined) return args.tempoAccount !== null;
  const tempo = loadConfig()?.tempo;
  return (
    tempo?.method === "tempo" &&
    typeof tempo.apiKey === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(tempo.apiKey)
  );
}

/**
 * Requires both the advertised payment method and its credit details; a stale per-call detail
 * block cannot invent funding support.
 */
function oneShotRailFilteredFromCreditMenu(
  args: FundCreditArgs,
  rail: (typeof STABLECOIN_FUND_RAILS)[number],
  x402Network?: string
): boolean {
  if (!args.menu || args.menu.funding.includes(rail)) return false;
  if (args.providerInfo?.paymentMethods?.includes(rail) !== true) return false;
  if (rail === "x402") {
    return x402Network !== undefined && args.providerInfo.x402?.network === x402Network;
  }
  return (
    hasConnectedTempoWallet(args) &&
    args.providerInfo.tempo?.methods.some(
      (candidate) => candidate.method === "tempo" && candidate.intent === "charge"
    ) === true
  );
}

/**
 * Reports the instrument that actually ran, which can differ from a new mode request answered by
 * a durable journal.
 */
function withFundingMode(outcome: CreditFundOutcome): CreditFundOutcome {
  const mode = outcome.tempoIntent
    ? fundingModeForTempoIntent(outcome.tempoIntent)
    : outcome.x402Flavour
      ? fundingModeForX402Flavour(outcome.x402Flavour)
      : undefined;
  return mode ? { ...outcome, fundingMode: mode } : outcome;
}

function tempoOffersMode(args: FundCreditArgs, mode: CreditFundingMode): boolean {
  if (mode === "one-shot") return offersTempoCreditCharge(args.menu);
  return mayFundOverTempoSession(args);
}

function x402OffersMode(
  args: FundCreditArgs,
  mode: CreditFundingMode,
  x402Network: string | undefined
): boolean {
  if (!x402Network) return false;
  return offersX402CreditFlavour(
    args.menu,
    x402Network,
    mode === "reusable" ? X402_BATCH_SETTLEMENT_SCHEME : X402_EXACT_SCHEME
  );
}

function railOffersMode(
  args: FundCreditArgs,
  rail: CreditFundRail,
  mode: CreditFundingMode,
  x402Network: string | undefined
): boolean {
  if (rail === "tempo") return tempoOffersMode(args, mode);
  return rail === "x402" ? x402OffersMode(args, mode, x402Network) : false;
}

function offeredModesSentence(offered: CreditFundingMode | undefined): string {
  return offered
    ? `The only mode this DVM offers here right now is ${offered} funding.`
    : "This DVM offers neither mode for prepaid credit right now.";
}

/**
 * Reject an unavailable requested stablecoin mode before creating any authority or replacing a
 * journal. Existing credit bindings and durable authority take precedence over the requested
 * mode.
 */
function fundingModeRefusal(input: {
  args: FundCreditArgs;
  mode: CreditFundingMode;
  fundId: string;
  /** Eligible rails, already narrowed to the stablecoin pair. */
  rails: readonly CreditFundRail[];
  binding: StoredCreditX402Binding;
  x402Network?: string;
}): CreditFundOutcome | undefined {
  const { args, mode, fundId, rails, binding, x402Network } = input;
  const other: CreditFundingMode = mode === "reusable" ? "one-shot" : "reusable";
  const refuse = (
    code: string,
    display: string,
    hint: string,
    data: Record<string, unknown> = {}
  ): CreditFundOutcome => ({
    creditId: args.creditId,
    fundId,
    status: "refused",
    fundingMode: mode,
    error: new DvmError(code, display, hint, {
      credit_id: args.creditId,
      requested_funding_mode: mode,
      ...data,
    }),
    display,
    hint,
  });

  // 1. The credit is already bound to the other instrument. Local evidence
  // only: x402 records the instrument outright, while Tempo has no such
  // field and is read off the channel association — so a charge-opened
  // credit asked for `reusable` is not knowable here and stays with the
  // server's own refusal on the session leg.
  const boundFlavour = x402FlavourForInstrument(binding.instrument);
  if (boundFlavour && fundingModeForX402Flavour(boundFlavour) !== mode) {
    return refuse(
      "funding_mode_conflict",
      `This prepaid balance was opened as ${other} x402 funding, so it can't be topped up as ${mode} funding. Nothing was signed and no money moved.`,
      `Top this credit up without --funding-mode, or open a separate credit for ${mode} funding by funding without --credit-id. The balance already here is still spendable and still reclaimable with 'dvm credit drain ${args.ref.endpoint}'.`,
      { credit_instrument: binding.instrument }
    );
  }
  if (
    mode === "one-shot" &&
    loadTempoChannelAssociation(args.ref.endpoint, args.signing.pubkey, args.creditId)?.opened ===
      true
  ) {
    return refuse(
      "funding_mode_conflict",
      "This prepaid balance belongs to its existing reusable Tempo channel, so a one-shot payment can't top it up. Nothing was signed and no money moved.",
      `Top this credit up without --funding-mode, or open a separate credit for one-shot funding by funding without --credit-id. The balance already here is still spendable and still reclaimable with 'dvm credit drain ${args.ref.endpoint}'.`,
      { credit_instrument: "tempo_session" }
    );
  }

  // 2. A rail was forced — by the flag, a pin, or this credit's own binding —
  // and it holds value in bitcoin, where there is no reusable form to pick.
  if (args.rail && !isStablecoinFundRail(args.rail)) {
    return refuse(
      "funding_mode_unavailable",
      `Funding over ${args.rail} is always a single payment, so it has no ${mode}-versus-${other} choice to make. Nothing was signed and no money moved.`,
      args.railSource === "credit_bound"
        ? `This prepaid credit was opened over ${args.rail} and is bound to it. Fund without --funding-mode, or open a separate credit on a stablecoin rail by funding without --credit-id.`
        : "Drop --funding-mode, or ask for a stablecoin rail with --rail x402 or --rail tempo.",
      { rail: args.rail }
    );
  }

  // Only the forced rail is a candidate once one is named: a mode is checked
  // against the leg that will actually run, never against a sibling rail the
  // pick has already excluded — which would let an unadvertised instrument
  // through to a signature the DVM can only refuse.
  const candidates = args.rail ? rails.filter((rail) => rail === args.rail) : rails;

  // 3. Nothing stablecoin is usable here at all — no wallet connected, or the
  // DVM advertises no stablecoin funding this caller could build. With a
  // rail forced, this is left to the forced-rail refusal further down, whose
  // copy names that rail and how to connect it; without one, the mode is
  // what excluded ecash and Lightning, so it owes the caller that sentence.
  if (candidates.length === 0) {
    const requestedRail = args.rail;
    const oneShotRails: readonly (typeof STABLECOIN_FUND_RAILS)[number][] =
      requestedRail === "x402" || requestedRail === "tempo"
        ? [requestedRail]
        : STABLECOIN_FUND_RAILS;
    const filteredOneShotRails = oneShotRails.filter((rail) =>
      oneShotRailFilteredFromCreditMenu(args, rail, x402Network)
    );
    if (mode === "one-shot" && filteredOneShotRails.length > 0) {
      const where =
        filteredOneShotRails.length === 1
          ? ` on ${railLabel(filteredOneShotRails[0])}`
          : " on either stablecoin rail";
      return refuse(
        "funding_mode_unavailable",
        `${args.ref.endpoint} does not offer one-shot funding for prepaid credit${where}. This DVM restricts stablecoin credit to reusable channels. Nothing was signed and no money moved.`,
        "Use a reusable channel for prepaid credit when one is offered, or use the one-payment stablecoin method for a single call instead. This DVM has not accepted the manual refund obligation that one-shot prepaid balances create.",
        { available_funding_modes: [], rails: filteredOneShotRails }
      );
    }
    if (args.rail) return undefined;
    return refuse(
      "funding_mode_unavailable",
      `A ${mode}-versus-${other} choice only exists on the stablecoin rails, and neither x402 nor Tempo can fund this credit right now. Nothing was signed and no money moved.`,
      "Connect a stablecoin wallet ('dvm wallet x402-connect' or 'dvm wallet tempo-connect') where the DVM offers that rail, or drop --funding-mode to fund over whichever rail is available."
    );
  }

  // 4. A stablecoin rail is usable, but not in the mode that was asked for.
  // This never refuses on silence: `availableRails` admits a stablecoin rail
  // only off an advertised method or scheme, so a non-empty candidate set is
  // itself the evidence that a menu was read. A DVM whose menu never arrived
  // was already answered by the rung above.
  if (candidates.some((rail) => railOffersMode(args, rail, mode, x402Network))) return undefined;
  // The requested mode is not on offer here, so the only mode that can be is
  // the other one — which is why the copy below never has two to name.
  const offered = candidates.some((rail) => railOffersMode(args, rail, other, x402Network))
    ? other
    : undefined;
  return refuse(
    "funding_mode_unavailable",
    `${args.ref.endpoint} does not offer ${mode} funding for prepaid credit on ${candidates.length === 1 ? railLabel(candidates[0]) : "either stablecoin rail"} right now. ${offeredModesSentence(offered)} Nothing was signed and no money moved.`,
    offered
      ? mode === "one-shot" && offered === "reusable"
        ? "Fund through the reusable channel instead. One-payment stablecoin methods remain available for per-call payment, but this DVM has not accepted the manual refund obligation they create for prepaid balances."
        : `Fund as ${offered} funding instead, or drop --funding-mode to take whichever the DVM prefers.`
      : "Drop --funding-mode and retry, or check the DVM's funding menu with 'dvm credit balance'.",
    { available_funding_modes: offered ? [offered] : [], rails: [...candidates] }
  );
}

function railLabel(rail: CreditFundRail): string {
  return rail === "tempo" ? "Tempo" : rail;
}

/**
 * Why the default (Cashu-first) order stands. The two structural causes are
 * reported ahead of the amount rule: a caller with no float, or a DVM that
 * takes no Lightning, is not "below the minimum" — telling them to fund more
 * would send them chasing a rail that was never going to be used.
 */
function cashuFirstReason(
  menu: CreditMenu | undefined,
  rails: readonly CreditFundRail[],
  x402Network?: string,
  x402Instrument?: X402CreditInstrument,
  tempoCredit?: TempoCreditIdentity,
  fundingMode?: CreditFundingMode
): CreditRailReason {
  // A forced mode is the instrument, so it answers the head outright — the
  // reads below describe a preference the leg is about to override.
  if (fundingMode && rails[0] === "x402") {
    return fundingMode === "reusable" ? "x402_channel" : "x402_exact";
  }
  if (fundingMode && rails[0] === "tempo") {
    return fundingMode === "reusable" ? "tempo_session_available" : "tempo_charge";
  }
  // Report the same precedence as dispatch: credit binding, explicit mode, then the advertised
  // instrument preference.
  if (rails[0] === "x402") {
    const bound = x402FlavourForInstrument(x402Instrument);
    if (bound) return bound === X402_BATCH_SETTLEMENT_SCHEME ? "x402_channel" : "x402_exact";
    const flavour = x402Network ? x402CreditFlavour(menu, x402Network) : undefined;
    const channel = x402Network
      ? flavour === X402_BATCH_SETTLEMENT_SCHEME
      : offersX402CreditChannel(menu);
    return channel ? "x402_channel" : "x402_exact";
  }
  if (rails[0] === "tempo") {
    return tempoSessionAvailable(menu, tempoCredit) ? "tempo_session_available" : "tempo_charge";
  }
  const advertised = menu?.funding;
  if (advertised && !advertised.includes("lightning")) return "lightning_not_offered";
  if (!rails.includes("lightning")) return "no_float";
  if (menu?.lightning_min_micro === undefined) return "no_lightning_minimum";
  return "below_lightning_minimum";
}

/**
 * Known credit bindings control dispatch before preferences. Unbound credits use an explicitly
 * requested supported mode or the menu preference; missing capability must not trigger signing.
 */
async function fundOverX402Rail(
  args: FundCreditArgs,
  fundId: string,
  /** The credit's recorded binding, read once by the caller for the reason too. */
  binding: StoredCreditX402Binding
): Promise<CreditFundOutcome> {
  const wallet = loadX402Wallet();
  if (!wallet) return fundOverX402(args, fundId);
  if (binding.instrument === "x402_channel" && !binding.channelNetwork) {
    const candidate = boundX402Channel(args);
    if (candidate) {
      try {
        assertX402ChannelPayer(
          candidate.recorded,
          privateKeyToAccount(wallet.privateKey as `0x${string}`).address
        );
      } catch (err) {
        return x402Refusal(
          args,
          {
            creditId: args.creditId,
            fundId,
            rail: "x402",
            x402Flavour: X402_BATCH_SETTLEMENT_SCHEME,
          },
          err
        );
      }
      // The fallback can name a newer, unrelated channel at this DVM. Its
      // network becomes evidence only after the unsigned discovery challenge
      // derives this exact channel id inside `fundOverX402`.
      return fundOverX402(args, fundId, undefined, false, false, candidate);
    }
  }
  const bound = x402FlavourForInstrument(binding.instrument);
  // A recorded channel chain is stronger evidence than the live menu. The DVM
  // may open channels on both the channel's chain and the wallet's current pin,
  // but `computeChannelId` folds the chain into the id: signing on the pin would
  // target a different channel and can only be refused by the credit ledger.
  if (binding.channelNetwork && binding.channelNetwork !== wallet.network) {
    return x402InstrumentUnavailable(
      args,
      fundId,
      X402_BATCH_SETTLEMENT_SCHEME,
      wallet.network,
      binding.channelNetwork
    );
  }
  if (bound) {
    // A menu that no longer names the bound flavour on this chain is the
    // shape one level down: nothing can top this credit up over x402
    // any more, and the honest answer is to say so rather than sign.
    //
    // Guarded on the menu being present at all. `availableRails` only admits
    // this rail off an advertised scheme, so one is always in hand on the path
    // that reaches here — and the guard is what keeps that from being load
    // bearing, since an absent menu is no evidence of what a DVM offers and
    // refusing on silence would strand a credit it still funds.
    if (args.menu && !offersX402CreditFlavour(args.menu, wallet.network, bound)) {
      return x402InstrumentUnavailable(args, fundId, bound, wallet.network, binding.channelNetwork);
    }
    return bound === X402_EXACT_SCHEME
      ? fundOverX402Exact(args, fundId, wallet)
      : fundOverX402(args, fundId);
  }
  // No binding to honour, so the caller's own choice decides where the menu's
  // channel-first preference otherwise would. Below the binding for
  // the reason the rail flag is: a credit's instrument is the DVM's refusal to
  // blend two, which no caller preference talks it out of — and a mode that
  // disagreed with one never reaches this leg at all.
  if (args.fundingMode) {
    return args.fundingMode === "one-shot"
      ? fundOverX402Exact(args, fundId, wallet)
      : fundOverX402(args, fundId);
  }
  if (x402CreditFlavour(args.menu, wallet.network) === X402_EXACT_SCHEME) {
    return fundOverX402Exact(args, fundId, wallet);
  }
  return fundOverX402(args, fundId);
}

/**
 * The x402 binding this funding's credit carries, as the caller last heard it:
 * the instrument it must be topped up over, and — where that instrument is a
 * settlement channel — the chain that channel lives on. Empty for a credit
 * adopted from a balance read, one opened before these fields existed, or a
 * `--credit-id` naming something the local record doesn't track. A recorded
 * channel instrument whose chain is empty is enriched from channel metadata in
 * the channel leg, after the connected payer and DVM challenge can be checked.
 */
function boundX402Binding(args: FundCreditArgs): StoredCreditX402Binding {
  return loadCreditX402Binding(
    args.ref.endpoint,
    args.signing.pubkey,
    args.creditId,
    fundedDvmIdentity(args.providerInfo)
  );
}

/**
 * The channel metadata that backs this credit, including the stale-credit-id
 * fallback the drain uses. Current writes change the owner only after a DVM
 * acknowledgement, but rows written by an older CLI can still name a refused
 * credit. The fallback is only a candidate here; the unsigned DVM challenge
 * must derive its exact channel id before its network is used.
 */
function boundX402Channel(args: FundCreditArgs): BoundX402ChannelCandidate | undefined {
  const recorded = findX402Channel({
    endpoint: args.ref.endpoint,
    callerPubkey: args.signing.pubkey,
    creditId: args.creditId,
  });
  if (recorded) return { recorded, creditScoped: true };
  const fallback = findX402Channel({
    endpoint: args.ref.endpoint,
    callerPubkey: args.signing.pubkey,
  });
  return fallback ? { recorded: fallback, creditScoped: false } : undefined;
}

interface BoundX402ChannelCandidate {
  recorded: StoredX402ChannelMetadata;
  creditScoped: boolean;
}

/**
 * A known x402 binding cannot be replaced by a live-menu preference. Refuse locally before
 * signing when its instrument is unavailable. A recorded channel chain distinguishes wallet re-
 * pinning from a DVM that stopped serving that chain; unknown chains require conditional advice.
 */
function x402InstrumentUnavailable(
  args: FundCreditArgs,
  fundId: string,
  bound: X402CreditFlavour,
  network: string,
  /** The chain the credit's own settlement channel lives on, where recorded. */
  channelNetwork: string | undefined
): CreditFundOutcome {
  const channelBound = bound === X402_BATCH_SETTLEMENT_SCHEME;
  const drain = `The balance is still spendable and still reclaimable with 'dvm credit drain ${args.ref.endpoint}'.`;
  const separate = `${drain} ${separateCreditSentence(args, network, channelBound)}`;
  const { display, hint } = channelBound
    ? channelInstrumentCopy(args, network, channelNetwork, drain, separate)
    : exactInstrumentCopy(args, network, drain, separate);
  return {
    creditId: args.creditId,
    fundId,
    rail: "x402" as const,
    status: "refused",
    error: new DvmError("x402_instrument_unavailable", display, hint, {
      credit_id: args.creditId,
      credit_instrument: x402InstrumentForFlavour(bound),
      ...(channelBound && channelNetwork ? { channel_network: channelNetwork } : {}),
    }),
    display,
    hint,
  };
}

/**
 * A known channel chain selects the remedy: restore the wallet pin when the DVM still serves it,
 * otherwise reclaim or open a separate credit. An unknown chain cannot be inferred from the
 * wallet's current pin.
 */
function channelInstrumentCopy(
  args: FundCreditArgs,
  network: string,
  channelNetwork: string | undefined,
  drain: string,
  separate: string
): { display: string; hint: string } {
  const networkCopy = x402NetworkLabel(network);
  const channelNetworkCopy = channelNetwork ? x402NetworkLabel(channelNetwork) : undefined;
  const belongs = channelNetworkCopy
    ? `This prepaid balance belongs to an x402 settlement channel on ${channelNetworkCopy}`
    : "This prepaid balance belongs to an x402 settlement channel";
  const elsewhere = x402CreditChannelNetworks(args.menu);
  const elsewhereCopy = elsewhere.map(x402NetworkLabel);
  if (elsewhere.length === 0) {
    return {
      display: `${belongs}, and ${args.ref.endpoint} now takes x402 top-ups only as one-off payments — which can't be added to it. Nothing was signed.`,
      hint: separate,
    };
  }
  if (channelNetwork) {
    return elsewhere.includes(channelNetwork)
      ? {
          display: `${belongs}, and ${args.ref.endpoint} still opens channels there — but the connected wallet is pinned to ${networkCopy}, and a settlement channel is tied to the chain it was opened on. Nothing was signed.`,
          hint: `Re-pin the wallet back to the channel's chain without handling its key: 'dvm wallet x402-network ${channelNetwork}'. ${drain}`,
        }
      : {
          display: `${belongs}, and ${args.ref.endpoint} no longer opens channels there — only on ${elsewhereCopy.join(", ")}. A settlement channel is tied to the chain it was opened on, so re-pinning the wallet would reach a different channel, not this balance. Nothing was signed.`,
          hint: separate,
        };
  }
  return {
    display: `${belongs}, and ${args.ref.endpoint} now opens channels only on ${elsewhereCopy.join(", ")} — a settlement channel is tied to the chain it was opened on, and the connected wallet is pinned to ${networkCopy}. Nothing was signed.`,
    hint: `If the channel was opened on ${elsewhereCopy.join(" or ")}, re-pin the wallet back to it: 'dvm wallet x402-network ${elsewhere[0]}'. If it was opened on a chain this DVM no longer serves, a top-up needs a separate credit — fund without --credit-id. ${drain}`,
  };
}

/**
 * Exact credits authorize each funding independently and have no channel-chain binding. A wallet
 * re-pin may reach another advertised exact chain; channel-only support cannot refill an exact-
 * bound credit.
 */
function exactInstrumentCopy(
  args: FundCreditArgs,
  network: string,
  drain: string,
  separate: string
): { display: string; hint: string } {
  const belongs = "This prepaid balance was opened by a one-off x402 payment";
  const elsewhere = x402CreditExactNetworks(args.menu);
  const elsewhereCopy = elsewhere.map(x402NetworkLabel);
  if (elsewhere.length === 0) {
    return {
      display: `${belongs}, and ${args.ref.endpoint} now takes x402 top-ups only through its reusable settlement channel — which can't be added to it. Nothing was signed.`,
      hint: separate,
    };
  }
  return {
    display: `${belongs}, and ${args.ref.endpoint} takes those on ${elsewhereCopy.join(", ")} — the connected wallet is pinned to ${x402NetworkLabel(network)}. Nothing was signed.`,
    hint: `Re-pin the wallet without handling its key: 'dvm wallet x402-network ${elsewhere[0]}'. ${drain}`,
  };
}

/**
 * Name the advertised alternate x402 route on the wallet's chain when available; otherwise
 * keep separate-credit advice generic.
 */
function separateCreditSentence(
  args: FundCreditArgs,
  network: string,
  channelBound: boolean
): string {
  const open = "Fund without --credit-id to open a separate credit";
  const other = channelBound ? X402_EXACT_SCHEME : X402_BATCH_SETTLEMENT_SCHEME;
  if (!offersX402CreditFlavour(args.menu, network, other)) {
    return `${open} over the route this DVM does offer.`;
  }
  const route = channelBound
    ? `takes one-off x402 payments on ${x402NetworkLabel(network)}`
    : `opens settlement channels on ${x402NetworkLabel(network)}`;
  return `${open}: this DVM ${route}, which the wallet is already pinned to.`;
}

/**
 * Adopt only the selected credit's binding from a terminal refusal. A channel-owner refusal
 * about another credit cannot relabel this credit.
 */
function healX402Binding(args: FundCreditArgs, err: unknown): void {
  if (boundCreditId(err)) return;
  const instrument = boundInstrument(err);
  if (instrument !== "x402_exact" && instrument !== "x402_channel") return;
  const channelNetwork =
    instrument === "x402_channel" ? refusedX402ChannelNetwork(args, err) : undefined;
  if (channelNetwork) {
    recordCreditX402Instrument(
      args.ref.endpoint,
      args.signing.pubkey,
      args.creditId,
      instrument,
      fundedDvmIdentity(args.providerInfo),
      channelNetwork
    );
  } else {
    recordCreditX402Instrument(
      args.ref.endpoint,
      args.signing.pubkey,
      args.creditId,
      instrument,
      fundedDvmIdentity(args.providerInfo)
    );
  }
}

/**
 * Resolve the refusal's channel id, then check its endpoint, caller and connected payer.
 * The channel id survives credit reassociation, so metadata creditId need not match the
 * selected credit.
 */
function refusedX402ChannelNetwork(args: FundCreditArgs, err: unknown): string | undefined {
  const channelId = boundChannelId(err);
  const wallet = loadX402Wallet();
  if (!channelId || !wallet) return undefined;
  try {
    const recorded = findX402Channel({ channelId });
    if (recorded?.channelId.toLowerCase() !== channelId.toLowerCase()) return undefined;
    if (
      recorded.endpoint !== normalizeCreditEndpoint(args.ref.endpoint) ||
      recorded.callerPubkey !== args.signing.pubkey
    ) {
      return undefined;
    }
    assertX402ChannelPayer(
      recorded,
      privateKeyToAccount(wallet.privateKey as `0x${string}`).address
    );
    return recorded.network;
  } catch {
    return undefined;
  }
}

/**
 * One exact authorization is signed against the DVM's unpaid challenge, then its verbatim header
 * and fund id are journalled before POST. Replay that authority rather than issuing a second
 * payment; its own validBefore bounds settlement. Unknown settlement books the authorized spend
 * idempotently.
 */
async function fundOverX402Exact(
  args: FundCreditArgs,
  fundId: string,
  wallet: X402Wallet,
  resumed?: PendingX402ExactFunding,
  locked = false
): Promise<CreditFundOutcome> {
  if (!locked) {
    return withX402ChannelLock(async () => {
      // Re-read under the lock: signing is a check-then-write, and two CLI
      // processes funding one credit concurrently must not both reach the
      // signer. The channel leg's preamble, minus the voucher arithmetic.
      const durable = pendingX402ExactForCredit(args);
      if (durable) {
        return fundOverX402Exact(
          argsFromPendingX402Exact(args, durable),
          durable.fundId,
          wallet,
          durable,
          true
        );
      }
      if (resumed) {
        return {
          creditId: args.creditId,
          fundId,
          rail: "x402" as const,
          x402Flavour: X402_EXACT_SCHEME,
          status: "unavailable",
          display: "This x402 funding was already resolved by another run, so nothing was sent.",
          hint: "Check the balance with 'dvm credit balance'.",
        };
      }
      return fundOverX402Exact(args, fundId, wallet, undefined, true);
    });
  }

  const base: X402FundBase = {
    creditId: args.creditId,
    fundId,
    rail: "x402" as const,
    x402Flavour: X402_EXACT_SCHEME,
  };
  let btcRate = 100_000;
  let pending = resumed;
  if (!pending) {
    // The funding is the spend, so the cap applies before anything is signed.
    // Fresh attempts only, as on every journalling rail: re-running it against
    // an authorization already out there moves no new money and could only
    // strand it, since a caller who hit their daily limit after signing would
    // never be able to re-present the header.
    try {
      const resolved = await tryResolveBtcUsdRate();
      btcRate = resolved?.rate ?? btcRate;
      await enforceGlobalBudget({
        plannedMsats: usdToMsats(args.amountMicro / 1_000_000, btcRate),
        btcRate,
      });
    } catch (err) {
      return budgetRefusal(base, err);
    }

    // Discovery, as on the channel leg: the unpaid POST is itself a real fund
    // POST, so a 200 is this `(credit_id, fund_id)` replaying rather than a 402
    // to answer, and a failure that carries no challenge stays `refused` — never
    // falling through to ecash, which would re-use the fund id under a different
    // commitment.
    const probeBody = x402CreditBody(args, fundId, args.amountMicro, sha256hex(""));
    let required;
    try {
      const replay = await postCredit(args, probeBody);
      return settled(args, base, replay, 0);
    } catch (err) {
      if (!(err instanceof DvmError)) return x402Refusal(args, base, err);
      required = x402RequiredFromError(err);
      if (!required) return x402Refusal(args, base, err);
    }

    let proof;
    try {
      const selected = selectExactRequirement(required, wallet.network);
      proof = await tryX402Payment(
        {
          // The DVM's advertised figure is what gets signed. `amountMsats` is
          // only the local basis `tryX402Payment` refuses a >10% overcharge
          // against, so it is this funding's own intent restated in msats.
          amountMsats: usdToMsats(args.amountMicro / 1_000_000, btcRate),
          btcRate,
          payTo: selected.payTo,
          network: selected.network,
          asset: selected.asset,
          paymentRequired: selected.challenge,
        },
        wallet
      );
    } catch (err) {
      return x402Refusal(args, base, err);
    }
    if (!proof) {
      // Only reachable for a chain with no USDC contract in the network table,
      // which the wallet-chain match above has already excluded. Treated as a
      // routing fact rather than a refusal all the same: nothing was signed.
      return {
        ...base,
        status: "unavailable",
        display: `No x402 payment could be built for ${wallet.network}, so nothing was signed.`,
        hint: "Re-pin the connected x402 wallet to a chain this build supports ('dvm wallet x402-network <caip2>'), or fund over another rail.",
      };
    }

    // Before the POST, never after: the response is the thing that goes missing,
    // so an entry written on the way back would be written exactly when it
    // cannot be. `amountMsats`/`btcRate` are the signed figure, journalled here
    // so a resume can book the ledger row without a fresh rate lookup.
    pending = {
      endpoint: args.ref.endpoint,
      callerPubkey: args.signing.pubkey,
      creditId: args.creditId,
      fundId,
      amountMicro: args.amountMicro,
      targetMicro: args.targetMicro ?? args.amountMicro,
      paymentHeader: proof.paymentHeader,
      x402Version: proof.x402Version,
      amountMsats: proof.amountMsats,
      btcRate: proof.btcRate,
      requestedAt: Date.now(),
      ...(exactAuthorizationValidBefore(proof.paymentHeader) !== undefined
        ? { authorizationValidBefore: exactAuthorizationValidBefore(proof.paymentHeader) }
        : {}),
    };
    recordPendingX402ExactFunding(pending);
  }

  const body = x402CreditBody(
    args,
    pending.fundId,
    pending.amountMicro,
    sha256hex(pending.paymentHeader)
  );
  try {
    const result = await postCredit(args, body, {
      x402Payment: pending.paymentHeader,
      x402Version: pending.x402Version,
    });
    // Adopt first, retire last — the channel leg's ordering. A crash between
    // the two leaves the entry replayable, and the DVM answers the replay with
    // its recorded funding rather than a second settlement.
    const outcome = settled(args, base, result, undefined);
    // `recordSpendOnce` on `fund:<fundId>`, as on every other rail: the verb
    // and the post-job refill can both reach this funding, and the ledger must
    // book the authorization once however many times it is described. What it
    // books is the *signed* figure, not the caller's ask: the DVM's advertised
    // amount is what gets authorized, and `tryX402Payment` accepts one up to
    // 10% above the local conversion — so booking `amountMicro` would under-book
    // the spend by whatever that gap is.
    recordSpendOnce({
      msats: pending.amountMsats,
      btcRate: pending.btcRate,
      kind: "credit_fund",
      jobId: `fund:${pending.fundId}`,
      providerEndpoint: args.ref.endpoint,
      label: "x402 prepaid credit funding",
    });
    clearPendingX402ExactFunding(pending);
    return outcome;
  } catch (err) {
    const mapped = err instanceof DvmError ? err : undefined;
    // The binding refusal occurs before facilitator settlement, but the presented header may
    // still be captured until its signed deadline. Clear this journal without claiming the
    // authorization disappeared.
    if (mapped && isBindingRefusal(mapped)) {
      healX402Binding(args, mapped);
      clearPendingX402ExactFunding(pending);
      const copy = x402BindingRefusalCopy(mapped, args.creditId);
      return {
        ...base,
        status: "refused",
        error: mapped,
        display: copy.display,
        hint: `${x402ExactPresentedWindow(pending.paymentHeader)} ${copy.hint}`,
      };
    }
    if (mapped && CREDIT_PERMANENT_REFUSALS.has(mapped.code)) {
      clearPendingX402ExactFunding(pending);
      return {
        ...base,
        status: "refused",
        error: mapped,
        display: `The DVM refused this funding outright (${mapped.code}), so nothing was credited.`,
        hint: "The signed authorization was never settled. Fund again with an amount this DVM accepts.",
      };
    }
    // Book potentially settled authority immediately, keyed by fund id, so unknown confirmation
    // cannot under-report outflow or make replay book twice.
    recordSpendOnce({
      msats: pending.amountMsats,
      btcRate: pending.btcRate,
      kind: "credit_fund",
      jobId: `fund:${pending.fundId}`,
      providerEndpoint: args.ref.endpoint,
      label: "x402 prepaid credit funding (unconfirmed)",
    });
    // Deliberately `refused` rather than `unavailable`: routing the same funding
    // onto ecash from here is how a caller pays twice. The entry stays on disk,
    // so the retry the hint asks for re-presents this authorization instead of
    // signing a second one.
    return {
      ...base,
      status: "refused",
      ...(mapped ? { error: mapped } : {}),
      display:
        mapped?.display ??
        mapped?.message ??
        "The x402 authorization was presented but the DVM did not confirm the funding.",
      hint: `Re-run this same funding ('dvm credit fund') — it re-presents the authorization already signed rather than signing another, so it cannot pay twice, and answers with the recorded result if it did settle. Check 'dvm credit balance' before funding a different amount instead: the authorization already sent stays submittable ${x402ExactAuthorizationDeadline(pending.paymentHeader)}, so a fresh one signed inside that window can settle alongside it.`,
    };
  }
}

/**
 * An already-presented exact header may still settle until its signed deadline even after this
 * funding is refused. Lead with that window before advice that would create another payment; an
 * unreadable deadline must not invent a date.
 */
function x402ExactPresentedWindow(paymentHeader: string): string {
  return `Nothing was settled — this DVM refused before its facilitator was asked — but the authorization already sent stays submittable ${x402ExactAuthorizationDeadline(paymentHeader)}, so check 'dvm credit balance' before signing another: one signed inside that window can settle alongside it.`;
}

/**
 * How long a sent exact authorization stays submittable, as a clause a hint
 * drops into. Read off the header rather than recomputed, and an unreadable one
 * named as a deadline without a time: putting an invented timestamp on a real
 * signature is the mistake in a different place.
 */
function x402ExactAuthorizationDeadline(paymentHeader: string): string {
  const seconds = Number(exactAuthorizationValidBefore(paymentHeader));
  return Number.isFinite(seconds)
    ? `until ${new Date(seconds * 1000).toISOString()}`
    : "until its own deadline lapses";
}

function exactAuthorizationValidBefore(paymentHeader: string): string | undefined {
  try {
    return decodePayment(paymentHeader).payload.authorization.validBefore;
  } catch {
    return undefined;
  }
}

/**
 * Normalize v1 exact terms to the signer's v2 shape, then retain every signable requirement on
 * the desired chain. Selecting the first chain match alone can discard a supported sibling
 * behind an unsupported entry.
 */
function selectExactRequirement(
  challenge: NonNullable<ReturnType<typeof x402RequiredFromError>>,
  network: string
): { challenge: X402PaymentRequired; payTo: string; network: string; asset: string } {
  // Both generations name the scheme, network, payTo and asset identically —
  // only the amount field differs, and that one is read by the signer rather
  // than here — so one predicate serves both. v1 carries the legacy network
  // slug, hence the normalization before comparison.
  const accepts: (PaymentRequirementsV1 | PaymentRequirementsV2)[] = challenge.accepts;
  const matched = accepts.filter(
    (entry) => isSignableExactRequirement(entry) && x402NetworkToCaip2(entry.network) === network
  );
  if (matched.length === 0) {
    const networkCopy = x402NetworkLabel(network);
    throw new DvmError(
      "x402_exact_not_offered",
      `The DVM offered no signable exact x402 requirement on the wallet's ${networkCopy} network.`,
      `This DVM does not take x402 credit funding on ${networkCopy}. Fund over another rail, or re-pin the connected x402 wallet to a chain this DVM settles ('dvm wallet x402-network <caip2>').`
    );
  }
  // The signer's own selection over the narrowed list is a `find`, so the head
  // is the entry it will sign — which is what these fallback fields must name.
  const accepted = matched[0];
  return {
    // `x402RequiredFromError` decodes into `@x402/core`'s declaration of the
    // same wire shape; the signer takes ours. The two are structurally
    // identical for both generations, so this is a re-declaration and not a
    // conversion.
    challenge: { ...challenge, accepts: matched } as X402PaymentRequired,
    payTo: accepted.payTo,
    network: accepted.network,
    asset: accepted.asset,
  };
}

/**
 * The reusable stablecoin rail. A discovery POST obtains the server-authored
 * channel terms; the signed payment header is then journalled verbatim before
 * submission and retired only after its PAYMENT-RESPONSE advances storage.
 */
async function fundOverX402(
  args: FundCreditArgs,
  fundId: string,
  resumed?: PendingX402Funding,
  corrected = false,
  locked = false,
  /** Payer-checked metadata whose channel id the discovery challenge must confirm. */
  channelCandidate?: BoundX402ChannelCandidate
): Promise<CreditFundOutcome> {
  if (!locked) {
    return withX402ChannelLock(async () => {
      const durable = pendingX402ForCredit(args);
      if (durable) {
        return fundOverX402(
          argsFromPendingX402(args, durable),
          durable.fundId,
          durable,
          corrected,
          true,
          channelCandidate
        );
      }
      // The caller handed us a journal entry that is no longer on disk: a
      // sibling process settled or retired it while this one waited on the
      // lock. Falling through would sign a *new* payment, which is the one
      // thing a sweep must never do.
      if (resumed) {
        return {
          creditId: args.creditId,
          fundId,
          rail: "x402" as const,
          status: "unavailable",
          display: "This x402 funding was already resolved by another run, so nothing was sent.",
          hint: "Check the balance with 'dvm credit balance'.",
        };
      }
      return fundOverX402(args, fundId, undefined, corrected, true, channelCandidate);
    });
  }
  const base: X402FundBase = {
    creditId: args.creditId,
    fundId,
    rail: "x402" as const,
    x402Flavour: X402_BATCH_SETTLEMENT_SCHEME,
  };
  const wallet = loadX402Wallet();
  if (!wallet) {
    return {
      ...base,
      status: "unavailable",
      display:
        "No x402 wallet is connected, so prepaid credit can't be funded through x402's reusable channel.",
      hint: "Run 'dvm wallet x402-connect --network eip155:84532' to create one, or add --key-file <path> to import a key you already hold.",
    };
  }

  let btcRate = 100_000;
  let pending = resumed;
  let scheme: Awaited<ReturnType<typeof createX402BatchPayment>>["scheme"] | undefined;
  if (!pending) {
    // Cheap local pre-check for the case that dominates: another credit at this
    // same DVM still owes a signed voucher. `createX402BatchPayment` gates the
    // authoritative version on the channel id — which catches two DVMs behind
    // one payout address — but only after a discovery round trip, and the
    // post-job auto-refill would pay for that on every single job.
    const rival = otherCreditPendingX402(args);
    if (rival) {
      return voucherPendingOutcome(
        base,
        rival,
        `A signed x402 voucher for credit ${rival.creditId} is still waiting for its acknowledgement, so this channel cannot sign another.`
      );
    }
    // The cap is checked on a fresh attempt only, as on the Lightning and Tempo
    // legs. Re-running it against an already-signed authorization moves no new
    // money and can only latch the journal shut: a caller who hit their daily
    // limit after signing could never acknowledge the voucher, and the entry
    // that leaves behind blocks the whole channel.
    try {
      const resolved = await tryResolveBtcUsdRate();
      btcRate = resolved?.rate ?? btcRate;
      await enforceGlobalBudget({
        plannedMsats: usdToMsats(args.amountMicro / 1_000_000, btcRate),
        btcRate,
      });
    } catch (err) {
      return budgetRefusal(base, err);
    }
    const probeBody = x402CreditBody(args, fundId, args.amountMicro, sha256hex(""));
    let required;
    try {
      const replay = await postCredit(args, probeBody);
      return settled(args, base, replay, 0);
    } catch (err) {
      if (!(err instanceof DvmError)) return x402Refusal(args, base, err);
      required = x402RequiredFromError(err);
      if (!required) return x402Refusal(args, base, err);
    }
    if (channelCandidate) {
      try {
        assertX402RequirementDescribesChannel({
          wallet,
          paymentRequired: required,
          recorded: channelCandidate.recorded,
          depositMicro: args.maxDepositMicro ?? args.amountMicro,
        });
        if (channelCandidate.recorded.network !== wallet.network) {
          return x402InstrumentUnavailable(
            args,
            fundId,
            X402_BATCH_SETTLEMENT_SCHEME,
            wallet.network,
            channelCandidate.recorded.network
          );
        }
      } catch (err) {
        // A credit-scoped row is this credit's channel even when the DVM has
        // retired its chain or changed its terms, so the drain-style refusal is
        // authoritative. Only the stale-credit fallback is ambiguous enough to
        // discard when the current challenge derives a different channel.
        if (channelCandidate.creditScoped) {
          if (err instanceof DvmError && err.code === "x402_batch_not_offered") {
            return x402InstrumentUnavailable(
              args,
              fundId,
              X402_BATCH_SETTLEMENT_SCHEME,
              wallet.network,
              channelCandidate.recorded.network
            );
          }
          return x402Refusal(args, base, err);
        }
      }
    }
    try {
      const payment = await createX402BatchPayment({
        wallet,
        paymentRequired: required,
        endpoint: args.ref.endpoint,
        callerPubkey: args.signing.pubkey,
        creditId: args.creditId,
        depositMicro: args.maxDepositMicro ?? args.amountMicro,
      });
      scheme = payment.scheme;
      pending = {
        endpoint: args.ref.endpoint,
        callerPubkey: args.signing.pubkey,
        creditId: args.creditId,
        fundId,
        amountMicro: args.amountMicro,
        targetMicro: args.targetMicro ?? args.amountMicro,
        paymentHeader: payment.paymentHeader,
        channelId: payment.channelId,
        requestedAt: Date.now(),
        // What the signature covers, not what the funding asked for. The exit's
        // exposure report uses this, and the two figures differ.
        maxClaimableMicro: payment.maxClaimableMicro,
        ...(payment.depositMicro !== undefined ? { depositMicro: payment.depositMicro } : {}),
        ...(payment.authorizationValidBefore !== undefined
          ? { authorizationValidBefore: payment.authorizationValidBefore }
          : {}),
      };
      recordPendingX402Funding(pending);
    } catch (err) {
      return x402Refusal(args, base, err);
    }
  } else {
    // A resume needs the rate only to price its ledger row; a rate outage must
    // never stand between a signed voucher and its acknowledgement.
    btcRate = (await tryResolveBtcUsdRate().catch(() => undefined))?.rate ?? btcRate;
  }

  const body = x402CreditBody(
    args,
    pending.fundId,
    pending.amountMicro,
    sha256hex(pending.paymentHeader)
  );
  try {
    const result = await postCredit(args, body, {
      x402Payment: pending.paymentHeader,
      x402Version: 2,
    });
    if (!result.x402PaymentResponse && result.replayed) {
      await acknowledgeReplayedX402Payment(pending.paymentHeader);
    } else if (scheme) await processX402BatchResponse(scheme, result.x402PaymentResponse);
    else {
      await processX402BatchResponseForWallet({
        wallet,
        depositMicro: pending.targetMicro,
        paymentResponse: result.x402PaymentResponse,
      });
    }
    // The metadata write at signing time is crash-recovery state, not evidence
    // that this credit owns the channel. Only the DVM's successful response —
    // including a replay acknowledgement — can advance that owner. This also
    // heals rows an older CLI relabelled after a refused cross-credit attempt.
    acknowledgeX402ChannelOwner({
      channelId: pending.channelId,
      endpoint: normalizeCreditEndpoint(pending.endpoint),
      callerPubkey: pending.callerPubkey,
      creditId: pending.creditId,
    });
    // Persist the acknowledged credit before clearing recovery state so a crash cannot lose
    // both.
    const outcome = settled(
      { ...args, amountMicro: pending.amountMicro, targetMicro: pending.targetMicro },
      base,
      result,
      undefined,
      // Record the accepted channel's chain, rather than a wallet pin that may have changed
      // during a replay.
      findX402Channel({ channelId: pending.channelId })?.network
    );
    recordSpendOnce({
      msats: usdToMsats(pending.amountMicro / 1_000_000, btcRate),
      btcRate,
      kind: "credit_fund",
      jobId: `fund:${pending.fundId}`,
      providerEndpoint: args.ref.endpoint,
      label: "x402 prepaid credit funding",
    });
    clearPendingX402Funding(pending);
    return outcome;
  } catch (err) {
    if (
      !corrected &&
      err instanceof DvmError &&
      (err.code === "invalid_batch_settlement_evm_payload_authorization_valid_before" ||
        err.message.includes("invalid_batch_settlement_evm_payload_authorization_valid_before"))
    ) {
      try {
        if (await canReplaceExpiredX402Deposit({ wallet, paymentHeader: pending.paymentHeader })) {
          clearPendingX402Funding(pending);
          return await fundOverX402(args, pending.fundId, undefined, true, true);
        }
      } catch {
        // Fail closed: retain the exact authorization unless onchain non-use is proven.
      }
    }
    const correction = err instanceof DvmError ? x402RequiredFromError(err) : undefined;
    if (correction && !corrected) {
      try {
        const recovered = await processX402BatchCorrection({
          wallet,
          paymentRequired: correction,
          depositMicro: pending.targetMicro,
        });
        if (recovered) {
          clearPendingX402Funding(pending);
          return await fundOverX402(args, pending.fundId, undefined, true, true);
        }
      } catch {
        // Keep the original signed header durable when recovery cannot be proven.
      }
    }
    // A terminal binding refusal retires the submitted voucher without changing channel
    // ownership. Its signed deposit may remain usable until expiry, so advice must lead with
    // that window.
    if (err instanceof DvmError && isBindingRefusal(err)) {
      retirePendingX402Funding(pending);
      healX402Binding(args, err);
      const copy = x402BindingRefusalCopy(err, pending.creditId);
      return {
        ...base,
        status: "refused",
        error: err,
        display: copy.display,
        // The block window leads, because the fix it gates is a channel funding
        // in three of the four shapes: an agent that acts on "top credit-X up
        // instead" first walks straight into `otherCreditPendingX402` and gets
        // a second refusal it can do nothing with. Scoped to the channel rather
        // than to x402 at large — the journal gates this leg only, so an exact
        // funding here is untouched — and to this DVM's endpoint, which is what
        // the gate keys on.
        hint: `${x402RetiredDepositWindow(pending)}, so no funding over this DVM's reusable x402 channel — this credit's or any other credit's — can be signed until then. Funding over another rail is unaffected. ${copy.hint} ${x402RetiredVoucherResidual(pending)}`,
      };
    }
    // A refusal the DVM will repeat forever retires the journal, as it does on
    // every other rail. Deliberately the code list rather than
    // `isPermanentRefusal`: that also fires on `retryable: false`, which covers
    // `credit_funding_unrecorded` — "paid, and the ledger will never carry it".
    // On a rail where the journalled header *is* the bearer authority, that is
    // the one entry that must survive. Same narrowing the Cashu leg uses.
    if (err instanceof DvmError && CREDIT_PERMANENT_REFUSALS.has(err.code)) {
      // Marked, not deleted. The entry stops being replayable — which is what
      // unwedges the credit — but it is still the only local record of two
      // signatures the caller cannot take back, and they die on different
      // clocks: the deposit authorization at its own timestamp, the claim
      // voucher never.
      retirePendingX402Funding(pending);
      return {
        ...base,
        status: "refused",
        error: err,
        display: `The DVM refused this funding outright (${err.code}), so its signed voucher was retired from funding rather than left blocking the channel.`,
        hint: `Nothing was credited. ${x402RetiredDepositWindow(pending)}, so fund again with an amount this DVM accepts after that. ${x402RetiredVoucherResidual(pending)}`,
      };
    }
    return {
      ...base,
      status: "refused",
      error: err instanceof DvmError ? err : undefined,
      display:
        "Prepaid-credit funding through the reusable x402 channel did not acknowledge its signed voucher. The exact header remains journalled and will be retried without increasing the authorized amount.",
      hint: "Re-run this funding after the DVM is reachable; do not create a replacement credit.",
    };
  }
}

/**
 * Retired deposit authority still blocks this channel until its signed expiry; voucher-only
 * payloads use the conservative journal backstop.
 */
function x402RetiredDepositWindow(pending: PendingX402Funding): string {
  const until = new Date(x402PendingBlockExpiresAt(pending)).toISOString();
  return x402PendingDepositExpiresAt(pending) !== undefined
    ? `The deposit it signed can still be submitted until ${until}`
    : `It signed no deposit authorization with a deadline of its own, so this channel is held from funding until ${until} — a conservative cutoff this CLI picks, not one the DVM agreed to`;
}

/**
 * The half of a retired entry that no clock releases. `claim()` takes the
 * cumulative voucher with no expiry and no dependency on the deposit having
 * landed, so retiring it is a decision the caller makes rather than a deadline
 * they wait out.
 */
function x402RetiredVoucherResidual(pending: PendingX402Funding): string {
  return `Its claim voucher never expires, so it keeps lowering the guaranteed floor reported by 'dvm wallet x402-withdraw-initiate' and stays in the at-risk figure reported by a cooperative drain until you retire it with 'dvm wallet x402-clear-pending --credit-id ${pending.creditId} --force'.`;
}

/**
 * The answer when a signed voucher stands between the caller and what they
 * asked for. Always `unavailable`: nothing was signed and nothing moved on this
 * attempt, so the rail loop is free to try another one — and a forced rail gets
 * the honest refusal rather than a silent substitution.
 */
function voucherPendingOutcome(
  base: { creditId: string; fundId: string; rail: CreditFundRail },
  blocking: PendingX402Funding,
  display: string
): CreditFundOutcome {
  // The refused flavour writes its own sentences: "retry that funding" is
  // advice an auto-refill would loop on forever, since the DVM already gave its
  // final answer and only the authorization's clock releases the block.
  if (x402PendingRetired(blocking)) {
    const error = x402VoucherPendingRefusal(blocking);
    return {
      ...base,
      status: "unavailable",
      error,
      display: error.message,
      ...(error.hint ? { hint: error.hint } : {}),
    };
  }
  const hint = `Retry that funding ('dvm credit fund ${blocking.endpoint} --credit-id ${blocking.creditId}'), or retire it with 'dvm wallet x402-clear-pending --credit-id ${blocking.creditId}' if the DVM is gone.`;
  return {
    ...base,
    status: "unavailable",
    error: new DvmError("x402_voucher_pending", display, hint, {
      credit_id: blocking.creditId,
      fund_id: blocking.fundId,
      channel_id: blocking.channelId,
    }),
    display,
    hint,
  };
}

function x402CreditBody(
  args: FundCreditArgs,
  fundId: string,
  amountMicro: number,
  commitment: string
): Record<string, unknown> {
  return {
    op: "fund",
    credit_id: args.creditId,
    fund: { amount_micro: amountMicro, fund_id: fundId, commitment },
  };
}

/**
 * These pre-payment failures describe rail availability, so the cascade may continue. They
 * cannot classify authority already presented as safe to pay elsewhere.
 */
const X402_RAIL_UNAVAILABLE = new Set([
  "x402_batch_not_offered",
  "x402_exact_not_offered",
  "x402_unsupported_network",
  "x402_voucher_pending",
  "x402_voucher_unreadable",
]);

/**
 * Compose binding-refusal advice locally: server pre-payment copy can recommend a doomed retry
 * or omit already-presented authority. Distinguish the selected credit from the channel's owner.
 */
function x402BindingRefusalCopy(
  err: DvmError,
  creditId: string
): { display: string; hint: string } {
  const rail = boundRail(err);
  const instrument = boundInstrument(err);
  const channelId = boundChannelId(err);
  const owner = boundCreditId(err);
  const separate =
    "Re-run this funding without --credit-id to open a separate credit for x402; re-running it as it stands is refused the same way.";
  if (rail && rail !== "x402") {
    return {
      display: `This prepaid balance was opened over ${rail}, so an x402 top-up can't be added to it. Nothing was credited.`,
      hint: `Top ${creditId} up over ${rail} instead. ${separate}`,
    };
  }
  if (owner) {
    return {
      display: `The x402 settlement channel this funding signed against already funds credit ${owner}, so it can't also fund ${creditId}. Nothing was credited.`,
      hint: `Top ${owner} up instead — it is the credit this channel backs. ${separate}`,
    };
  }
  if (instrument === "x402_channel") {
    return {
      display: channelId
        ? `This prepaid balance belongs to x402 settlement channel ${channelId}, so only a deposit from that channel can top it up. Nothing was credited.`
        : "This prepaid balance belongs to an existing x402 settlement channel, so only a deposit from that channel can top it up. Nothing was credited.",
      // Same as the one-off branch below: the binding is recorded now. Where
      // its channel metadata is local too, the chain is learned in the same
      // mutation, so a re-run either takes the right channel or names the one
      // re-pin required before another signature.
      hint: `${creditId}'s channel binding is now recorded, so re-running this funding uses ${channelId ? `channel ${channelId}` : "the channel that opened it"} when the wallet is on its chain, or names the chain to re-pin to before anything else is signed. ${separate}`,
    };
  }
  return {
    display:
      "This prepaid balance was opened by a one-off x402 payment, so x402's reusable channel can't top it up. Nothing was credited.",
    // The flavour is not the caller's to pick, but it is no longer the live
    // menu's either: records the binding this refusal just named, so
    // the next top-up of this credit signs a one-off payment rather than
    // another channel deposit. That makes the retry the fix wherever this DVM
    // still takes one — and where it doesn't, the answer is refused locally
    // before anything is signed, which is what the second sentence offers.
    hint: `${creditId}'s one-off binding is now recorded, so re-running this funding takes that route wherever this DVM still offers it. ${separate}`,
  };
}

function x402Refusal(args: FundCreditArgs, base: X402FundBase, err: unknown): CreditFundOutcome {
  const mapped = err instanceof DvmError ? err : undefined;
  const required = boundRail(err);
  // A refusal naming x402 itself must not splice that same rail back into the cascade. The
  // instrument binding, not another signature, changes the next route.
  const terminalBinding =
    required === base.rail || (required === undefined && boundInstrument(mapped) !== undefined);
  if (mapped && terminalBinding) {
    // The most valuable heal point of the three: this branch also fires on the
    // discovery probe's refusal, so the binding is learned before either leg
    // has signed anything at all.
    healX402Binding(args, mapped);
    return {
      ...base,
      status: "refused",
      error: mapped,
      ...x402BindingRefusalCopy(mapped, base.creditId),
    };
  }
  const railwise = mapped !== undefined && X402_RAIL_UNAVAILABLE.has(mapped.code);
  return {
    ...base,
    status: required || railwise ? "unavailable" : "refused",
    ...(required ? { requiredRail: required } : {}),
    ...(mapped ? { error: mapped } : {}),
    display:
      mapped?.display ??
      mapped?.message ??
      (base.x402Flavour === X402_EXACT_SCHEME
        ? "Prepaid-credit funding through one x402 stablecoin authorization could not be signed."
        : "Prepaid-credit funding through x402's reusable channel could not be signed."),
    hint: mapped?.hint,
  };
}

/**
 * The attach rail: swap proofs locked to the DVM, ship them on the request
 * that funds. Resumable against `(credit_id, fund_id)` — a lost response
 * re-ships from the pending-submission sweep and never funds twice.
 */
async function fundOverCashu(args: FundCreditArgs, fundId: string): Promise<CreditFundOutcome> {
  const base = { creditId: args.creditId, fundId, rail: "cashu" as const };
  const cashu = args.providerInfo?.cashu;
  const lockPubkey = cashu?.lock_pubkeys[0];
  if (!cashu || !lockPubkey || cashu.mints.length === 0 || !loadAgentWallet()) {
    return { ...base, status: "unavailable", display: "No Cashu wallet can cover this funding." };
  }
  if (args.cashuMint !== undefined && !cashu.mints.includes(args.cashuMint)) {
    return {
      ...base,
      status: "refused",
      error: new DvmError(
        "cashu_mint_not_accepted",
        "The requested Cashu mint is not accepted by this DVM.",
        "Choose a mint from the DVM's current Cashu offer before funding.",
        { mint: args.cashuMint }
      ),
      display:
        "Nothing was funded because the approved Cashu mint is no longer accepted by this DVM.",
    };
  }

  const rate = (await tryResolveBtcUsdRate())?.rate ?? 0;
  if (rate <= 0) {
    return {
      ...base,
      status: "unavailable",
      display: "The bitcoin exchange rate couldn't be read, so the funding amount can't be sized.",
    };
  }
  const fundSats = microToSats(args.amountMicro, rate);

  if (args.maxCashuPrincipalSats !== undefined && fundSats > args.maxCashuPrincipalSats) {
    return cashuFundingCapRefusal(base, {
      code: "cashu_principal_cap_exceeded",
      message: `Funding ${args.amountMicro} micro-units requires ${fundSats} sats, over the ${args.maxCashuPrincipalSats}-sat approved principal limit.`,
      hint: "Retry only after a new approval raises the native-sat principal ceiling.",
    });
  }

  // The funding is the spend — the cap applies here, before any proof moves.
  let btcRate: number;
  try {
    btcRate = await enforceGlobalBudget({ plannedMsats: fundSats * 1000, btcRate: rate });
  } catch (err) {
    return budgetRefusal(base, err);
  }

  const creditBody: Record<string, unknown> = {
    op: "fund",
    credit_id: args.creditId,
    fund: { amount_micro: args.amountMicro, fund_id: fundId, commitment: "" },
  };

  const prepared = await prepareAgentSpend({
    amountSats: fundSats,
    endpoint: args.ref.endpoint,
    cashuP2pk: {
      mints: args.cashuMint ? [args.cashuMint] : [...cashu.mints],
      lock_pubkey: lockPubkey,
      // refund clause on the funding outputs too — a top-up the DVM
      // never confirms is the same stranded capital a per-call spend would be.
      canonical_id: cashu.canonical_id,
      min_locktime: cashu.min_locktime,
    },
    ...(args.maxCashuPrincipalSats !== undefined
      ? { maxCashuPrincipalSats: args.maxCashuPrincipalSats }
      : {}),
    ...(args.maxCashuFeeSats !== undefined ? { maxCashuFeeSats: args.maxCashuFeeSats } : {}),
    submitContext: {
      submit_body: {},
      route: "credit",
      credit_body: { ...creditBody, fund: { ...(creditBody.fund as object) } },
      signing_pubkey: args.signing.pubkey,
      ...(!args.signBody && args.providerInfo
        ? {
            auth_domain: signedRequestDomain({
              provider: args.providerInfo,
              endpoint: args.ref.endpoint,
              method: "POST",
              path: "v1/credit",
              capability: null,
            }),
          }
        : {}),
    },
  });
  if ("error" in prepared) {
    if (
      prepared.error.code === "cashu_principal_cap_exceeded" ||
      prepared.error.code === "cashu_fee_cap_exceeded"
    ) {
      return cashuFundingCapRefusal(base, prepared.error);
    }
    // A balance-shaped refusal is "not this rail" — the caller may still have a
    // float. Anything else is a wallet fault worth reporting as such.
    return { ...base, status: "unavailable", display: prepared.error.message };
  }

  (creditBody.fund as Record<string, unknown>).commitment = sha256hex(prepared.cashuToken);

  try {
    const result = await postCredit(args, creditBody, {
      cashuToken: prepared.cashuToken,
      cashuRequestId: prepared.requestId,
    });
    await commitAgentSpend({
      requestId: prepared.requestId,
      recentSpend: {
        request_id: prepared.requestId,
        dvm_endpoint: args.ref.endpoint,
        mint: prepared.mint,
        amount_sats: prepared.totalSats,
        signed_at_ms: Date.now(),
      },
    });
    recordSpend({
      msats: prepared.totalSats * 1000,
      btcRate,
      kind: "credit_fund",
      jobId: `fund:${fundId}`,
      providerEndpoint: args.ref.endpoint,
      label: "credit top-up",
    });
    return settled(args, base, result, prepared.totalSats);
  } catch (err) {
    // Bound to another rail. Not transient, so the prepared spend must be
    // dropped rather than left replaying forever against a credit that will
    // refuse it every time — and the named rail is worth trying instead.
    const required = boundRail(err);
    if (required) {
      await abandonPendingSubmission({ requestId: prepared.requestId }).catch(() => undefined);
      return {
        ...base,
        status: "unavailable",
        requiredRail: required,
        display: `This credit was opened over ${required}, so an ecash top-up can't be added to it.`,
      };
    }
    if (err instanceof DvmError && CREDIT_PERMANENT_REFUSALS.has(err.code)) {
      await abandonPendingSubmission({ requestId: prepared.requestId }).catch(() => undefined);
      return {
        ...base,
        status: "refused",
        error: err,
        display: `The DVM refused the funding (${err.code}) — the ${String(prepared.totalSats)} sats spend was dropped. ${err.message}`,
        hint: err.hint,
      };
    }
    // Transient: the pending entry stays on disk and the next invocation's
    // sweep replays it against (credit_id, fund_id).
    return {
      ...base,
      status: "refused",
      error: err instanceof DvmError ? err : undefined,
      display: `The funding didn't confirm (${err instanceof DvmError ? err.code : "error"}) — it will be retried automatically on the next call.`,
    };
  }
}

function cashuFundingCapRefusal(
  base: { creditId: string; fundId: string; rail: "cashu" },
  error: { code: string; message: string; hint?: string }
): CreditFundOutcome {
  const refusal = new DvmError(error.code, error.message, error.hint, { display: error.message });
  return {
    ...base,
    status: "refused",
    error: refusal,
    display: `Nothing was funded: the Cashu spend is above its approved native-sat ceiling (${error.code}).`,
    hint: error.hint,
  };
}

/**
 * Withdrawn session support prevents new channels, but an existing accepted channel can still
 * permit a top-up.
 */
function mayFundOverTempoSession(args: FundCreditArgs): boolean {
  return tempoSessionAvailable(args.menu, {
    endpoint: args.ref.endpoint,
    callerPubkey: args.signing.pubkey,
    creditId: args.creditId,
  });
}

/** Whether this menu and credit can use a reusable Tempo session right now. */
function tempoSessionAvailable(
  menu: CreditMenu | undefined,
  credit?: TempoCreditIdentity
): boolean {
  if (offersTempoCreditSession(menu)) return true;
  if (!withholdsTempoCreditSession(menu) || !credit) return false;
  return (
    loadTempoChannelAssociation(credit.endpoint, credit.callerPubkey, credit.creditId)?.opened ===
    true
  );
}

/**
 * Known session bindings and an explicit mode precede preference. A live session cannot silently
 * switch to a one-shot charge.
 */
async function fundOverMppRail(args: FundCreditArgs, fundId: string): Promise<CreditFundOutcome> {
  if (args.fundingMode === "reusable") return fundOverMpp(args, fundId);
  if (args.fundingMode === "one-shot") return fundOverMppCharge(args, fundId);
  if (mayFundOverTempoSession(args)) return fundOverMpp(args, fundId);
  const association = loadTempoChannelAssociation(
    args.ref.endpoint,
    args.signing.pubkey,
    args.creditId
  );
  if (association?.opened) {
    return {
      creditId: args.creditId,
      fundId,
      rail: "tempo",
      tempoIntent: "session",
      status: "refused",
      display:
        "This prepaid balance belongs to its existing reusable Tempo channel, but the provider is not offering session funding right now. No charge was made.",
      hint: "The provider may be withholding sessions because its channel-close observer is stale. Retry after session funding returns; do not replace this top-up with a one-shot charge.",
    };
  }
  return fundOverMppCharge(args, fundId);
}

/**
 * A Tempo charge has a short-lived credential but a durable funding intent. Probe the original
 * fund id first, replay a live credential, or sign a fresh one only after no-record proof and
 * expiry. Journal before POST and book acknowledged spend before clearing the intent.
 */
async function fundOverMppCharge(
  args: FundCreditArgs,
  fundId: string,
  resumed?: PendingTempoChargeFunding,
  locked = false
): Promise<CreditFundOutcome> {
  if (!locked) {
    return withTempoChannelLock(async () => {
      // Re-read under the lock: signing is a check-then-write, and two CLI
      // processes funding one credit concurrently must not both reach the
      // signer. The session leg holds this same lock for the same reason.
      const durable = pendingTempoChargeForCredit(args);
      if (durable) {
        return fundOverMppCharge(
          argsFromPendingTempoCharge(args, durable),
          durable.fundId,
          durable,
          true
        );
      }
      if (resumed) {
        return {
          creditId: args.creditId,
          fundId,
          rail: "tempo" as const,
          tempoIntent: "charge" as const,
          status: "unavailable",
          display: "This Tempo funding was already resolved by another run, so nothing was sent.",
          hint: "Check the balance with 'dvm credit balance'.",
        };
      }
      return fundOverMppCharge(args, fundId, undefined, true);
    });
  }

  const base: MppFundBase = {
    creditId: args.creditId,
    fundId,
    rail: "tempo",
    tempoIntent: "charge",
  };
  const account =
    args.tempoAccount === undefined ? await connectedTempoAccount() : args.tempoAccount;
  if (!account) {
    return {
      ...base,
      status: "unavailable",
      display: "No Tempo wallet is connected, so this credit cannot be funded.",
      hint: "Connect one with 'dvm wallet tempo-connect', fund its address, then retry.",
    };
  }
  // A menu read chooses the rail; a resume is finishing one already chosen. The
  // journalled entry is the proof this DVM offered the charge, and a sweep
  // reaches this leg with no menu at all — gating a resume on a fresh
  // advertisement would strand the very charge the entry exists to answer for.
  if (!resumed && !offersTempoCreditCharge(args.menu)) {
    return {
      ...base,
      status: "unavailable",
      display: "This DVM does not advertise one-shot Tempo funding for prepaid credit.",
    };
  }

  // The rate is the budget ledger's unit, not the payment's — a Tempo charge is
  // USD-micro end to end. A resume needs neither: the gate has already run and
  // the signed figure was journalled in msats at the rate it was priced at, so
  // an fx outage cannot stand between a presented charge and its record.
  let rate = resumed?.btcRate ?? 0;
  if (!resumed) {
    rate = (await tryResolveBtcUsdRate())?.rate ?? 0;
    if (rate <= 0) {
      return {
        ...base,
        status: "unavailable",
        display:
          "The bitcoin exchange rate couldn't be read, so the funding can't be checked against the global budget.",
      };
    }
    // Fresh attempts only, as on every journalling rail: re-running the gate
    // against a charge already presented moves no new money and could only
    // strand it, since a caller who hit their daily limit after signing would
    // never be able to finish the funding they already paid for.
    const plannedMsats = microToSats(args.amountMicro, rate) * 1000;
    try {
      await enforceGlobalBudget({ plannedMsats, btcRate: rate });
    } catch (err) {
      return budgetRefusal(base, err);
    }
  }

  // The unpaid POST is itself a real fund POST, so a 200 is this
  // `(credit_id, fund_id)` replaying rather than a 402 to answer — which is
  // exactly how a retry after a lost response gets its answer without paying.
  const probeBody = mppChargeCreditBody(args, fundId, sha256hex(""));
  let challenges: Challenge.Challenge[];
  try {
    const replay = await postCredit(args, probeBody);
    if (resumed) {
      // Keep the recovery entry until acknowledged spend is booked; clearing first loses the
      // only evidence after a process interruption.
      const outcome = { ...settled(args, base, replay), spentMicro: resumed.signedMicro };
      recordSpendOnce({
        msats: resumed.amountMsats,
        btcRate: resumed.btcRate,
        kind: "credit_fund",
        jobId: `fund:${resumed.fundId}`,
        providerEndpoint: args.ref.endpoint,
        label: "Tempo charge credit top-up",
      });
      clearPendingTempoChargeFunding(resumed);
      return outcome;
    }
    return settled(args, base, replay);
  } catch (err) {
    const required = tempoChargeChallenges(err);
    if (!required) return mppChargeRefusal(args, base, err, false, resumed);
    challenges = required;
  }

  let pending = resumed;
  if (!pending || !tempoChargeCredentialSettleable(pending)) {
    let credential: Credential.Credential;
    try {
      const built = await buildTempoCredential({
        challenges,
        privateKey: account.privateKey,
        // This funding's own intent is the basis the ceiling is measured against:
        // the DVM authors the figure that gets signed, and a challenge more than
        // the shared tolerance above the ask is refused unsigned.
        basisMicro: args.amountMicro,
        onError: "throw",
      });
      if (!built) {
        return {
          ...base,
          status: "unavailable",
          display: "The DVM offered no Tempo charge challenge, so nothing was signed.",
        };
      }
      credential = built;
    } catch (err) {
      return mppChargeRefusal(args, base, err, false, resumed);
    }

    // Before the POST, never after: the response is the thing that goes
    // missing, so an entry written on the way back would be written exactly
    // when it cannot be. The signed figure and its rate ride along so a resume
    // books the ledger row without a fresh fx hop.
    const signedAt = Date.now();
    const signedMicro = Number(tempoCredentialAmountMicro(credential));
    const validBefore = tempoCredentialValidBefore(credential, signedAt);
    pending = {
      endpoint: args.ref.endpoint,
      callerPubkey: args.signing.pubkey,
      creditId: args.creditId,
      fundId,
      amountMicro: args.amountMicro,
      targetMicro: args.targetMicro ?? args.amountMicro,
      credential: Credential.serialize(credential),
      // What the credential authorizes, which the tolerance above allows to sit
      // a little over the ask. Read back off the credential's own bound
      // challenge so the ledger and the outcome report the money that moves.
      signedMicro,
      amountMsats: usdToMsats(signedMicro / 1_000_000, rate),
      btcRate: rate,
      requestedAt: signedAt,
      ...(validBefore !== undefined ? { credentialValidBefore: validBefore } : {}),
    };
    recordPendingTempoChargeFunding(pending);
  }

  try {
    const result = await postCredit(
      args,
      mppChargeCreditBody(args, pending.fundId, sha256hex(pending.credential)),
      {
        mppCredentialRaw: pending.credential,
      }
    );
    // Adopt, book by fund id, then retire the journal. Each step remains safe to repeat after a
    // crash.
    const outcome = { ...settled(args, base, result), spentMicro: pending.signedMicro };
    recordSpendOnce({
      msats: pending.amountMsats,
      btcRate: pending.btcRate,
      kind: "credit_fund",
      jobId: `fund:${pending.fundId}`,
      providerEndpoint: args.ref.endpoint,
      label: "Tempo charge credit top-up",
    });
    clearPendingTempoChargeFunding(pending);
    return outcome;
  } catch (err) {
    return mppChargeRefusal(args, base, err, true, pending);
  }
}

function mppChargeCreditBody(
  args: FundCreditArgs,
  fundId: string,
  commitment: string
): Record<string, unknown> {
  return {
    op: "fund",
    credit_id: args.creditId,
    fund: {
      amount_micro: args.amountMicro,
      fund_id: fundId,
      commitment,
      method: "tempo",
      intent: "charge",
    },
  };
}

function tempoChargeChallenges(err: unknown): Challenge.Challenge[] | undefined {
  if (!(err instanceof DvmError) || !Array.isArray(err.data?.tempo_challenges)) return undefined;
  const challenges = (err.data.tempo_challenges as Challenge.Challenge[]).filter(
    (candidate) => candidate.method === "tempo" && candidate.intent === "charge"
  );
  return challenges.length > 0 ? challenges : undefined;
}

/**
 * The refusal side of {@link fundOverMppCharge}, and the only place its journal
 * is retired on anything but success.
 *
 * The rule is the one landed for x402 exact: **a definite answer from
 * the DVM clears the entry, an unknown outcome keeps it.** A DVM that refused
 * the funding, named another rail, or would refuse this credential every time
 * is not something a retry can resolve, and an entry nothing replays would only
 * hold the credit shut. A timeout is the opposite: the charge may have settled,
 * and the entry is what makes the retry ask under the same fund id instead of
 * signing a second one.
 */
function mppChargeRefusal(
  args: FundCreditArgs,
  base: MppFundBase,
  err: unknown,
  presented: boolean,
  pending?: PendingTempoChargeFunding
): CreditFundOutcome {
  const mapped = err instanceof DvmError ? err : undefined;
  const instrument = boundInstrument(err);
  const required = boundRail(err);
  const retire = (): void => {
    if (pending) clearPendingTempoChargeFunding(pending);
  };
  if (mapped && TEMPO_AMOUNT_REFUSALS.has(mapped.code)) {
    // `refused`, not `unavailable`: nothing was signed, but a DVM asking for
    // more than it quoted is a fact about this DVM rather than about Tempo, and
    // letting the cascade pay the same inflated ask over ecash would bury it.
    // The x402 twin lands the same way — `x402_amount_exceeds_limit` is absent
    // from `X402_RAIL_UNAVAILABLE` on purpose.
    retire();
    return {
      ...base,
      status: "refused",
      error: mapped,
      display: (mapped.data?.display as string | undefined) ?? mapped.message,
      hint: mapped.hint,
    };
  }
  if (presented && mapped && CREDIT_PERMANENT_REFUSALS.has(mapped.code)) {
    // The DVM refused the funding itself, which it does before taking the
    // credential — so this one carries no "may still have settled" ambiguity,
    // the same branch `fundOverX402Exact` draws.
    retire();
    return {
      ...base,
      status: "refused",
      error: mapped,
      display: `The DVM refused this funding outright (${mapped.code}), so nothing was credited.`,
      hint: "The signed charge was never settled. Fund again with an amount this DVM accepts.",
    };
  }
  if (presented && mapped && (instrument || required)) {
    retire();
    return {
      ...base,
      status: "refused",
      error: mapped,
      display: mapped.display ?? mapped.message,
      hint: `${tempoChargePresentedWindow(pending)}${
        mapped.hint ??
        "Do not pay again. Check the credit balance, then contact the service operator to reconcile the completed charge."
      }`,
    };
  }
  if (instrument === "tempo_session") {
    retire();
    return {
      ...base,
      status: "refused",
      error: mapped,
      display:
        "This prepaid balance belongs to its existing reusable Tempo channel, so a one-shot charge cannot top it up. No charge was made.",
      hint:
        mapped?.hint ??
        "Retry when the provider offers Tempo session funding again; do not replace the session top-up with a one-shot charge.",
    };
  }
  if (required) {
    // The DVM named the rail this credit is bound to, so no retry of this one
    // can ever land — retiring is what lets the cascade reach the named rail
    // instead of the journal blocking it until the staleness line.
    retire();
    return {
      ...base,
      status: "unavailable",
      requiredRail: required,
      ...(mapped ? { error: mapped } : {}),
      display: `This credit was opened over ${required}, so a Tempo top-up can't be added to it.`,
    };
  }
  if (!presented && !pending) {
    return {
      ...base,
      status: "unavailable",
      ...(mapped ? { error: mapped } : {}),
      display:
        mapped?.display ?? mapped?.message ?? "A Tempo charge could not be built for this funding.",
      hint: mapped?.hint,
    };
  }
  // A presented charge may already have settled. Book its authorized outflow idempotently while
  // retaining the intent for confirmation.
  if (pending) {
    recordSpendOnce({
      msats: pending.amountMsats,
      btcRate: pending.btcRate,
      kind: "credit_fund",
      jobId: `fund:${pending.fundId}`,
      providerEndpoint: args.ref.endpoint,
      label: "Tempo charge credit top-up (unconfirmed)",
    });
  }
  // Deliberately `refused` rather than `unavailable`: routing the same funding
  // onto ecash from here is how a caller pays twice. The entry stays on disk, so
  // the retry the hint asks for asks under the same fund id instead of signing a
  // second charge.
  return {
    ...base,
    status: "refused",
    ...(mapped ? { error: mapped } : {}),
    display:
      mapped?.display ??
      mapped?.message ??
      "The Tempo charge was presented but the DVM did not confirm the funding.",
    hint: `Re-run this same funding ('dvm credit fund') — it asks under the fund id already used, so a charge that settled answers with the recorded result and one that did not is paid once. Check 'dvm credit balance' before funding a different amount instead: funding ${base.fundId} was never confirmed here.`,
  };
}

/**
 * Credential expiry and durable funding resolution have different clocks. An expired signature
 * alone does not establish that an earlier payment was never recorded.
 */
function tempoChargePresentedWindow(pending: PendingTempoChargeFunding | undefined): string {
  if (!pending || !tempoChargeCredentialSettleable(pending)) return "";
  return `Nothing was settled — this DVM refused before its rail was asked — but the charge already sent stays submittable until ${new Date(
    (pending.credentialValidBefore ?? 0) * 1000
  ).toISOString()}, so check 'dvm credit balance' before signing another. `;
}

/**
 * The Tempo session rail: persist an intent, discover a challenge, create an
 * on-chain open/top-up/voucher credential, persist that exact Authorization
 * value, then send it. Every later 402 repeats the same sequence, which is how
 * a management top-up followed by its cumulative voucher stays crash-safe.
 */
async function fundOverMpp(
  args: FundCreditArgs,
  fundId: string,
  resumed?: PendingFunding,
  locked = false
): Promise<CreditFundOutcome> {
  if (!locked) {
    return withTempoChannelLock(() => fundOverMpp(args, fundId, resumed, true));
  }
  const base: MppFundBase = {
    creditId: args.creditId,
    fundId,
    rail: "tempo",
    tempoIntent: "session",
  };
  const account =
    args.tempoAccount === undefined ? await connectedTempoAccount() : args.tempoAccount;
  if (!account) {
    return {
      ...base,
      status: "unavailable",
      display: "No Tempo wallet is connected, so prepaid credit can't be funded over Tempo.",
      hint: "Connect one with 'dvm wallet tempo-connect', fund its address, then retry.",
    };
  }
  if (!mayFundOverTempoSession(args)) {
    return {
      ...base,
      status: "unavailable",
      display:
        "This DVM does not offer prepaid-credit funding over Tempo; its funding menu has no reusable Tempo session.",
    };
  }

  let pending = resumed;
  if (!pending) {
    const rate = (await tryResolveBtcUsdRate())?.rate ?? 0;
    if (rate <= 0) {
      return {
        ...base,
        status: "unavailable",
        display:
          "The bitcoin exchange rate couldn't be read, so the funding can't be checked against the global budget.",
      };
    }
    const plannedMsats = microToSats(args.amountMicro, rate) * 1000;
    let budgetBtcRate: number;
    try {
      budgetBtcRate = await enforceGlobalBudget({ plannedMsats, btcRate: rate });
    } catch (err) {
      return budgetRefusal(base, err);
    }
    pending = {
      endpoint: args.ref.endpoint,
      callerPubkey: args.signing.pubkey,
      creditId: args.creditId,
      fundId,
      amountMicro: args.amountMicro,
      rail: "tempo",
      targetMicro: args.targetMicro ?? args.amountMicro,
      maxDepositMicro: args.maxDepositMicro ?? args.amountMicro,
      ...(args.menu ? { menu: args.menu } : {}),
      requestedAt: Date.now(),
      budgetBtcRate,
    };
    // The intent exists before challenge discovery or an on-chain open. A
    // death from here onward resumes this fund id and this credit id.
    recordPendingFunding(pending);
  }

  let current = pending;
  // A new credit has no association of its own yet, while mppx may still reuse
  // an existing channel under its (payee, token, escrow, chain) scope. Discover
  // that exact scope before fixing the cap, then hand the same response to mppx
  // on its first fetch instead of probing the DVM twice. A resume skips this:
  // its exact saved credential carries the challenge scope it was signed for.
  let initialBridge:
    | { result: CreditOpResult; error?: never }
    | { result?: never; error: unknown }
    | undefined;
  if (!current.mppCredential) {
    try {
      initialBridge = { result: await postCredit(args, mppCreditBody(current)) };
    } catch (error) {
      initialBridge = { error };
    }
  }
  const channelScope = current.mppCredential
    ? tempoSessionCredentialChannelScope(current.mppCredential)
    : tempoSessionChallengeChannelScope(tempoSessionChallenge(initialBridge?.error));
  const association = tempoSessionAssociationByKey({
    endpoint: current.endpoint,
    callerPubkey: current.callerPubkey,
    creditId: current.creditId,
    channelScope,
  });
  // The one figure the caller authorizes this channel to hold: mppx sizes its
  // automatic open and top-up against it, and the bridge below re-checks what
  // each credential actually commits against the same number.
  const capMicro = tempoSessionCumulativeCapMicro({
    endpoint: current.endpoint,
    callerPubkey: current.callerPubkey,
    creditId: current.creditId,
    allowanceMicro: current.maxDepositMicro ?? current.amountMicro,
    amountMicro: current.amountMicro,
    ...(association ? { association } : {}),
  });
  // What the channel was already authorized to pay out when this funding began.
  // Read once here rather than per credential: mppx writes the new cumulative
  // into the channel store as it signs, so by the time the bridge sees a voucher
  // the store already contains that voucher's own figure. Stable across the
  // management-top-up → voucher two-step, and across a resume.
  const priorCumulativeMicro = tempoSessionPriorCumulativeMicro({
    endpoint: current.endpoint,
    callerPubkey: current.callerPubkey,
    creditId: current.creditId,
    ...(association ? { association } : {}),
  });
  const session = createTempoCreditSession({
    account,
    endpoint: current.endpoint,
    callerPubkey: current.callerPubkey,
    creditId: current.creditId,
    maxDepositMicro: capMicro,
    topUpAmountMicro: current.amountMicro,
    ...(channelScope ? { operator: channelScope.operator } : {}),
    ...(args.tempoGetClient ? { getClient: args.tempoGetClient } : {}),
  });

  let lastBridgeError: unknown;
  let callerRefusal: DvmError | undefined;
  let bridgeResult: CreditOpResult | undefined;
  let managementTransactionHash: string | undefined;
  const bridgeFetch: typeof globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    const credential = headers.get("Authorization") ?? undefined;
    const credentialAction = credential ? tempoSessionCredentialAction(credential) : undefined;
    const isManagementRequest = !headers.has("Accept-Payment");
    /** What a freshly minted voucher lets the DVM capture, once one is seen. */
    let authorizedMicro: number | undefined;
    // Check additional collateral against the caller's cap before journalling or transmission. A
    // session voucher's cumulative capture authority is not its deposit amount.
    if (credential && credential !== current.mppCredential) {
      try {
        assertTempoSessionDepositWithinCap({
          credential,
          endpoint: current.endpoint,
          callerPubkey: current.callerPubkey,
          creditId: current.creditId,
          capMicro,
          ...(channelScope ? { channelScope } : {}),
        });
        // The collateral ceiling above and this one are different questions: a
        // deposit is recoverable collateral, a voucher is capture authority the
        // DVM can spend. A management top-up names no cumulative and returns
        // `undefined` here.
        const cumulativeMicro = tempoSessionCredentialCumulativeMicro(credential);
        if (cumulativeMicro !== undefined) {
          authorizedMicro = cumulativeMicro - priorCumulativeMicro;
          assertTempoSessionVoucherWithinAsk({
            authorizedMicro,
            basisMicro: current.amountMicro,
          });
        }
      } catch (err) {
        if (err instanceof DvmError) callerRefusal = err;
        throw err;
      }
    }
    if (credential && credential !== current.mppCredential) {
      current = {
        ...current,
        mppCredential: credential,
        ...(authorizedMicro !== undefined && authorizedMicro > 0 ? { authorizedMicro } : {}),
      };
      // mppx uses this bridge for management top-ups as well as vouchers. The
      // exact credential for every money-moving send reaches disk first, so a
      // crash can replay whichever step was in flight.
      recordPendingFunding(current);
    }
    if (credentialAction === "open" && credential) {
      // mppx normally writes an opening channel only after the response. Keep
      // a provisional entry first so a process death after the DVM commits can
      // replay the journaled credential and promote the same channel.
      if (
        !(await persistTempoOpenCredential({
          credential,
          endpoint: current.endpoint,
          callerPubkey: current.callerPubkey,
          creditId: current.creditId,
          opened: false,
        }))
      ) {
        throw new DvmError(
          "payment_invalid",
          "The Tempo opening credential could not be persisted before broadcast."
        );
      }
    }
    try {
      if (!credential && initialBridge) {
        const cached = initialBridge;
        initialBridge = undefined;
        if ("error" in cached) throw cached.error;
        bridgeResult = cached.result;
      } else {
        bridgeResult = await postCredit(
          args,
          mppCreditBody(current),
          credential ? { mppCredentialRaw: credential } : undefined
        );
      }
      if (
        (credentialAction === "open" || credentialAction === "topUp") &&
        bridgeResult.transactionHash
      ) {
        managementTransactionHash = sameTempoTransaction(
          managementTransactionHash,
          bridgeResult.transactionHash
        );
      }
      if (credentialAction === "open" && credential) {
        if (
          !(await persistTempoOpenCredential({
            credential,
            endpoint: current.endpoint,
            callerPubkey: current.callerPubkey,
            creditId: current.creditId,
            opened: true,
          }))
        ) {
          throw new DvmError(
            "payment_invalid",
            "The confirmed Tempo channel could not be promoted in local storage."
          );
        }
      }
      return Response.json(bridgeResult);
    } catch (err) {
      lastBridgeError = err;
      const errorTransaction =
        err instanceof DvmError && typeof err.data?.transaction_hash === "string"
          ? err.data.transaction_hash
          : undefined;
      if ((credentialAction === "open" || credentialAction === "topUp") && errorTransaction) {
        managementTransactionHash = sameTempoTransaction(
          managementTransactionHash,
          errorTransaction
        );
      }
      const challenges =
        err instanceof DvmError && Array.isArray(err.data?.tempo_challenges)
          ? (err.data.tempo_challenges as Challenge.Challenge[])
          : [];
      // dvmkit's one pre-signature lever on this leg. Every session challenge
      // mppx acts on is one this bridge handed it, so refusing here is refusing
      // before anything is signed — the placement the charge leg gets for free
      // inside `buildTempoCredential`. The belt above still
      // matters: mppx retries a 402 five times, and this sees each challenge
      // alone rather than their sum.
      if (challenges.length > 0) {
        try {
          assertTempoSessionChallengeWithinAsk({
            challenges,
            basisMicro: current.amountMicro,
          });
        } catch (refusal) {
          if (refusal instanceof DvmError) callerRefusal = refusal;
          throw refusal;
        }
      }
      // Translate only the accepted session-management sentinel into the empty success mppx
      // requires. Other 402 responses must remain challenges, before a business voucher is
      // signed.
      if (
        isManagementRequest &&
        credentialAction === "topUp" &&
        err instanceof DvmError &&
        err.code === "payment_invalid" &&
        err.message.includes(TEMPO_SESSION_UPDATED_REASON) &&
        challenges.length > 0
      ) {
        return new Response(null, { status: 204 });
      }
      if (challenges.length > 0) {
        return Response.json(
          { error: err instanceof DvmError ? err.code : "payment_required" },
          {
            status: 402,
            headers: {
              "WWW-Authenticate": challenges
                .map((challenge) => Challenge.serialize(challenge))
                .join(", "),
            },
          }
        );
      }
      return Response.json(
        {
          error: err instanceof DvmError ? err.code : "provider_error",
          message: err instanceof Error ? err.message : String(err),
        },
        { status: 400 }
      );
    }
  };

  const input = `${current.endpoint}/v1/credit`;
  const init: RequestInit = {
    method: "POST",
    ...(current.mppCredential ? { headers: { Authorization: current.mppCredential } } : {}),
  };
  let response: Response;
  try {
    response = args.tempoFetch
      ? await args.tempoFetch({ fetch: bridgeFetch, input, init })
      : await createTempoSessionPaymentFetch(session, bridgeFetch)(input, init);
  } catch (err) {
    // `!bridgeResult` because a refusal is only the whole story while nothing
    // settled. mppx rethrows a bridge throw rather than retrying past it, so a
    // refusal alongside a booked credit is unreachable today — but reporting a
    // settled funding as `refused` would skip its spend and clear its journal.
    if (callerRefusal && !bridgeResult) return mppCallerRefusal(base, current, callerRefusal);
    return mppFundingFailure(args, base, current, err);
  }
  if (callerRefusal && !bridgeResult) return mppCallerRefusal(base, current, callerRefusal);
  if (!response.ok || !bridgeResult) {
    return mppFundingFailure(
      args,
      base,
      current,
      lastBridgeError ?? new DvmError("payment_invalid", "Tempo session funding was refused.")
    );
  }
  // What the voucher authorizes the DVM to capture, not what the funding asked
  // for — the tolerance above lets the two differ, and booking the ask
  // under-reports the spend by exactly that gap (the argument, on the
  // leg where the money actually moves per job). The channel *deposit* is
  // deliberately not booked here: it is recoverable collateral that a
  // cooperative close or 'dvm wallet tempo-exit' returns, `dvm wallet balance`
  // already reports it separately, and booking it as spend would double-count
  // against the same money the credit's draws later consume.
  const bookedMicro = current.authorizedMicro ?? current.amountMicro;
  if (current.budgetBtcRate) {
    recordSpendOnce({
      msats: microToSats(bookedMicro, current.budgetBtcRate) * 1000,
      btcRate: current.budgetBtcRate,
      kind: "credit_fund",
      jobId: `fund:${current.creditId}:${fundId}`,
      providerEndpoint: args.ref.endpoint,
      label: "Tempo prepaid credit funding",
    });
  }
  const settledOutcome = settled(args, base, {
    ...bridgeResult,
    ...(managementTransactionHash ? { transactionHash: managementTransactionHash } : {}),
  });
  const outcome = {
    ...settledOutcome,
    spentMicro: bookedMicro,
    display: `${settledOutcome.display} Its reusable Tempo channel is the custody and settlement mechanism: the channel deposit is on-chain collateral, while the DVM ledger balance above is the prepaid credit jobs can spend.`,
    hint: "See liquid wallet money, reusable-channel collateral, and prepaid credit separately with 'dvm wallet balance'. Drain the credit to cooperatively close the channel and reclaim its remainder.",
  };
  clearPending(current);
  return outcome;
}

function tempoSessionCredentialAction(credential: string): string | undefined {
  try {
    const payload = Credential.deserialize(credential).payload as { action?: unknown };
    return typeof payload.action === "string" ? payload.action : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Recognize only the exact locally thrown ceiling-refusal object; a DVM-controlled error code
 * cannot spoof it. Distinguish refusal before authority from refusal after channel collateral
 * already moved.
 */
function mppCallerRefusal(
  base: MppFundBase,
  pending: PendingFunding,
  refusal: DvmError
): CreditFundOutcome {
  clearPending(pending);
  return {
    ...base,
    status: "refused",
    error: refusal,
    display: (refusal.data?.display as string | undefined) ?? refusal.message,
    ...(refusal.hint ? { hint: refusal.hint } : {}),
  };
}

function mppFundingFailure(
  args: FundCreditArgs,
  base: MppFundBase,
  pending: PendingFunding,
  err: unknown
): CreditFundOutcome {
  const required = boundRail(err);
  const mapped = err instanceof DvmError ? err : undefined;
  const instrument = boundInstrument(err);
  if (pending.mppCredential && mapped && (instrument || required)) {
    clearPending(pending);
    return {
      ...base,
      status: "refused",
      error: mapped,
      display: mapped.display ?? mapped.message,
      hint:
        mapped.hint ??
        "Do not pay again. Check the credit balance, then contact the service operator to reconcile the completed session payment.",
    };
  }
  if (instrument === "tempo_charge") {
    clearPending(pending);
    return {
      ...base,
      status: "refused",
      error: mapped,
      display:
        "This prepaid balance was opened by a one-shot Tempo payment, so a reusable session cannot top it up. No channel was opened.",
      hint: "Open a separate credit for a reusable Tempo session, or top this credit up with another one-shot charge.",
    };
  }
  if (required) {
    clearPending(pending);
    return {
      ...base,
      status: "unavailable",
      requiredRail: required,
      error: err instanceof DvmError ? err : undefined,
      display: `This prepaid credit was opened over ${required}, so it can't be topped up over Tempo.`,
    };
  }
  if (!pending.mppCredential) {
    clearPending(pending);
    const cause = redactUrlsInText(err instanceof Error ? err.message : String(err));
    const failure =
      mapped ??
      new DvmError(
        "tempo_session_credential_unavailable",
        `The Tempo session could not create a payment credential: ${cause}`
      );
    return {
      ...base,
      status: "refused",
      error: failure,
      display: `The Tempo prepaid-credit funding stopped before a payment credential was created (${failure.code}). ${failure.message}`,
      hint:
        failure.hint ??
        "Nothing was sent and no collateral moved. Resolve the error, then re-run the funding; it will start a fresh attempt.",
    };
  }
  if (isPermanentRefusal(err)) clearPending(pending);
  return {
    ...base,
    status: "refused",
    error: mapped,
    display:
      mapped?.display ??
      (mapped
        ? `The Tempo prepaid-credit funding did not confirm (${mapped.code}). ${mapped.message}`
        : "The Tempo prepaid-credit funding did not confirm. The exact credential is saved for retry."),
    hint:
      mapped?.hint ??
      "Re-run the funding; it will replay the saved cumulative credential rather than opening or topping up again.",
  };
}

/**
 * Journal the invoice request before the wallet hop, then retain its paid principal and fees
 * before polling the original (credit_id, fund_id). Caps and receive floors apply before a fresh
 * invoice; a resumed potentially paid invoice must reconcile rather than pay again or cascade.
 */
async function fundOverLightning(
  args: FundCreditArgs,
  fundId: string,
  resumed?: PendingFunding
): Promise<CreditFundOutcome> {
  const base = { creditId: args.creditId, fundId, rail: "lightning" as const };
  let pending = resumed;
  if (!pending) {
    // refuse a sub-floor funding before any invoice is requested —
    // an invoice below the advertised minimum could never route, and the DVM
    // would refuse to issue it anyway. Only on a fresh attempt: a *resumed*
    // pending invoice was already issued (and may already be paid), so it is
    // never re-gated. `unavailable` so the loop's fallback still runs — on
    // the default order cashu was already tried and found short, which makes
    // this outcome the loop's final answer and its hint the way out of the
    // dead end.
    if (args.menu?.lightning_min_micro !== undefined) {
      const floorMicro = args.menu.lightning_min_micro;
      if (args.amountMicro < floorMicro) {
        const amountUsd = formatUsd(args.amountMicro / 1_000_000);
        const floorUsd = formatUsd(floorMicro / 1_000_000);
        return {
          ...base,
          status: "unavailable",
          error: new DvmError(
            "below_rail_minimum",
            `A $${amountUsd} funding is below this DVM's $${floorUsd} Lightning minimum.`,
            undefined,
            { rail: "lightning", min_micro: floorMicro }
          ),
          display: `This funding of $${amountUsd} is below the $${floorUsd} minimum this DVM sets for Lightning — no invoice was requested and nothing moved.`,
          // "Use ecash instead" is the usual way out, and it is a lie to a
          // credit the DVM bound to Lightning: `/v1/credit` refuses the
          // cross-rail top-up at any size, so the only real remedies are a
          // bigger funding or a fresh credit.
          hint:
            args.railSource === "credit_bound"
              ? `Fund at least $${floorUsd} to use Lightning. ${releaseForcedRailHint(args).text}`
              : `Refill the agent's ecash pocket with 'dvm wallet fund' and retry — ecash funds any amount here. Or fund at least $${floorUsd} to use Lightning.` +
                (args.rail === "lightning" ? ` ${releaseForcedRailHint(args).text}` : ""),
        };
      }
    }

    // `null` means "explicitly no float" — the same distinction
    // `availableRails` draws, and `??` would erase it by falling through to the
    // configured one.
    const float = args.float === undefined ? loadFloat() : args.float;
    if (!float) {
      return {
        ...base,
        status: "unavailable",
        display: "No Lightning wallet is connected, so the credit can't be funded that way.",
      };
    }

    const rate = (await tryResolveBtcUsdRate())?.rate ?? 0;
    if (rate <= 0) {
      return {
        ...base,
        status: "unavailable",
        display:
          "The bitcoin exchange rate couldn't be read, so the funding amount can't be sized.",
      };
    }
    try {
      await assertFloatBudget(microToSats(args.amountMicro, rate) * 1000);
    } catch (err) {
      return budgetRefusal(base, err);
    }

    // This write precedes the invoice request. A process death anywhere after
    // it can therefore recover the same `(credit_id, fund_id)` rather than
    // minting a second payable invoice for the same intent.
    pending = {
      endpoint: args.ref.endpoint,
      callerPubkey: args.signing.pubkey,
      creditId: args.creditId,
      fundId,
      amountMicro: args.amountMicro,
      rail: "lightning",
      targetMicro: args.targetMicro ?? args.amountMicro,
      ...(args.menu ? { menu: args.menu } : {}),
      requestedAt: Date.now(),
    };
    recordPendingFunding(pending);
  }

  const creditBody = lightningCreditBody(pending);

  let offer: LightningFundingOffer;
  try {
    // A DVM that already saw this funding settle answers 200 straight away.
    const replay = await postCredit(args, creditBody);
    return settleAndClear(args, base, replay, lightningSpendFromPending(pending), pending);
  } catch (err) {
    const parsed = lightningOffer(err);
    if (!parsed) {
      if (shouldClearPending(err)) clearPending(pending);
      return lightningRefusal(base, err);
    }
    offer = parsed;
    pending = withLightningOffer(pending, offer);
    recordPendingFunding(pending);
  }

  if (pendingFundingExpired(pending)) {
    clearPending(pending);
    return expiredFunding(base);
  }

  const float = args.float === undefined ? loadFloat() : args.float;
  if (!float) {
    return {
      ...base,
      status: "unavailable",
      display:
        "The original Lightning invoice is still pending, but no wallet is connected to pay or reconcile it.",
      hint: "Reconnect the Lightning wallet, then re-run this funding. The same invoice and funding id will be reused.",
    };
  }

  let payment: Awaited<ReturnType<typeof fundViaFloat>>;
  try {
    emitFloatBudgetWarning({
      float,
      operation: "credit_funding",
      principalMsats: offer.amount_msats,
      human: args.human,
    });
    payment = await fundViaFloat({
      bolt11: offer.invoice,
      amountMsats: offer.amount_msats,
      // The credit id + this DVM, so `dvm wallet history` rows say what the
      // sats bought. The fund id rides the label — it is the funding event's
      // own identity, and two top-ups of one credit must stay distinguishable.
      reference: `credit:${args.creditId}`,
      counterparty: args.ref.endpoint,
      label: `credit funding · ${fundId}`,
      float,
    });
  } catch (err) {
    const mapped = err instanceof DvmError ? err : undefined;
    // A payment below a floor we know about can never succeed on a retry —
    // reachable only on a resumed invoice minted before the floor was known,
    // since a fresh sub-floor attempt is refused above. Name the way that
    // works instead of relaying generic payment advice.
    const belowKnownFloor =
      args.menu?.lightning_min_micro !== undefined &&
      args.amountMicro < args.menu.lightning_min_micro;
    return {
      ...base,
      status: "refused",
      error: mapped,
      // The wallet's own words, always — either its composed `display` or, when
      // it wrote none, its message appended to ours. A wallet that said "no
      // route to the destination" is telling the caller something a generic
      // "didn't go through" throws away, and this is the one funding failure a
      // human has to act on themselves.
      display:
        typeof mapped?.data?.display === "string"
          ? mapped.data.display
          : `The Lightning payment for this credit didn't go through${mapped ? ` (${mapped.code})` : ""}. The credit was not funded.${mapped?.message ? ` ${mapped.message}` : ""}`,
      hint: belowKnownFloor
        ? `This amount is below the $${formatUsd((args.menu?.lightning_min_micro ?? 0) / 1_000_000)} minimum this DVM sets for Lightning, so no retry can pay it. Refill the agent's ecash pocket with 'dvm wallet fund' and fund with ecash instead.`
        : mapped?.hint,
    };
  }

  pending = {
    ...pending,
    principalMsats: payment.principalMsats,
    routingFeeMsats: payment.routingFeeMsats,
    totalWalletFeeMsats: payment.totalWalletFeeMsats,
    unitemizedWalletFeeMsats: payment.unitemizedWalletFeeMsats,
    walletDebitMsats: payment.walletDebitMsats,
    paymentOutcome: payment.outcome,
  };
  recordPendingFunding(pending);

  // The money has left. From here no outcome may say "nothing happened" — the
  // worst honest answer is "paid, not yet observed", which the next request
  // settles. So only a refusal the DVM will repeat forever still counts as a
  // refusal; a timeout or an unreachable DVM is a story about the confirmation,
  // not about the money. Neither may reach `lightningRefusal`, which is written
  // for the pre-payment hop and can answer `unavailable` — and `unavailable`
  // sends `fundCredit` on to the next rail, i.e. pays a second time.
  const paid = lightningSpend(payment);
  let unconfirmed: DvmError | undefined;
  for (let attempt = 0; attempt < SETTLEMENT_POLLS; attempt++) {
    try {
      const result = await postCredit(args, creditBody);
      return {
        ...settleAndClear(args, base, result, paid, pending),
      };
    } catch (err) {
      if (isPermanentRefusal(err)) {
        const mapped = err as DvmError;
        clearPending(pending);
        // Composed, never the server's own `display`: that copy is written for
        // a caller who hasn't paid, so `lightning_invoice_expired` relays as
        // "Nothing was charged" — the one sentence that must not reach someone
        // whose sats have left. "Won't be crediting it" covers both shapes the
        // DVM answers with here: a refusal, and `credit_funding_unrecorded`,
        // which took the payment and lost the row.
        return {
          ...base,
          ...paid,
          status: "refused",
          error: mapped,
          display: `The Lightning payment went out, but the DVM won't be crediting it (${mapped.code}). ${mapped.message} ${floatPaymentDisplay(payment)}`,
          hint: `Don't fund again — a fresh funding id issues a second invoice. The payment is on record ('dvm wallet history'); quote funding id ${fundId} to the operator of ${args.ref.endpoint}.`,
        };
      }
      // Keep the last non-pending failure: "we couldn't reach the DVM" and
      // "the DVM says it hasn't landed yet" are different stories to relay.
      unconfirmed = err instanceof DvmError && !isSettlementPending(err) ? err : undefined;
      if (attempt < SETTLEMENT_POLLS - 1) await sleep(SETTLEMENT_POLL_DELAY_MS);
    }
  }

  // The record already exists, but this final durable write is intentional:
  // `settlement_pending` is the process boundary where money is known to have
  // moved while the server's confirmation is not yet in hand.
  recordPendingFunding(pending);
  return {
    ...base,
    ...paid,
    status: "settlement_pending",
    ...(unconfirmed ? { error: unconfirmed } : {}),
    display: unconfirmed
      ? `The Lightning payment went out and is recorded, but the DVM couldn't be reached to confirm it (${unconfirmed.code}). It credits the balance the next time it hears from you — nothing is lost. ${floatPaymentDisplay(payment)}`
      : `The Lightning payment went out and is recorded, but the DVM hasn't seen it land yet. It credits the balance on your next call — nothing is lost. ${floatPaymentDisplay(payment)}`,
    // Both verbs poll the durable `(credit_id, fund_id)`: neither can mint a
    // second invoice while this intent remains in flight.
    hint: "Re-run this funding or check with 'dvm credit balance' — both re-poll the original funding id, and any next request makes the DVM look for settlement.",
  };
}

async function postCredit(
  args: FundCreditArgs,
  body: Record<string, unknown>,
  payment?: Payment
): Promise<CreditOpResult> {
  const transport = args.transport;
  if (!transport.credit) {
    throw new DvmError(
      "credit_not_supported",
      "This transport cannot reach /v1/credit.",
      "Use the HTTPS transport."
    );
  }
  const signedBody = args.signBody
    ? args.signBody(args.signing.privkey, body)
    : signDvmRequestData(
        args.signing.privkey,
        body,
        signedRequestDomain({
          provider: args.providerInfo ?? (await transport.describe(args.ref)),
          endpoint: args.ref.endpoint,
          method: "POST",
          path: "v1/credit",
          capability: null,
        })
      );
  // Re-signed per attempt: the discovery hop deliberately does not burn its
  // nonce, and a stale envelope would fall out of the replay window while the
  // invoice is being paid. Idempotency lives on `(credit_id, fund_id)`.
  return transport.credit(args.ref, signedBody, payment, {
    timeoutMs: CREDIT_POST_TIMEOUT_MS,
  });
}

function settled(
  args: FundCreditArgs,
  base: {
    creditId: string;
    fundId: string;
    rail: CreditFundRail;
    /** Set by both x402 legs; the instrument half of the binding they pin. */
    x402Flavour?: X402CreditFlavour;
  },
  result: CreditOpResult,
  spentSats?: number,
  /**
   * The chain the settlement channel this funding rode lives on.
   * Passed separately rather than on `base`, which is spread into the outcome:
   * this is a store fact, not something an agent reads off a successful funding.
   */
  x402ChannelNetwork?: string
): CreditFundOutcome {
  const fundingReceiptStatus = captureFundingReceipt({
    receipt: result.fundingReceipt,
    parseError: result.fundingReceiptParseError,
    endpoint: args.ref.endpoint,
    builder: args.providerInfo?.builder,
    expectedCreditId: result.credit?.credit_id ?? base.creditId,
    expectedFundId: base.fundId,
    expectedFundedMicro: result.funded_micro,
    ...(result.replayed
      ? {}
      : {
          expectedBalanceAfterMicro: result.credit?.remaining_micro,
          expectedLedgerSeq: result.credit?.ledger_seq,
        }),
    expectedCallerPubkey: args.signing.pubkey,
  });
  if (
    result.credit &&
    (fundingReceiptStatus === "verified" ||
      fundingReceiptStatus === "verified_unattested" ||
      fundingReceiptStatus === "absent")
  ) {
    recordFundResponse({
      endpoint: args.ref.endpoint,
      ...identityArg(fundedDvmIdentity(args.providerInfo)),
      callerPubkey: args.signing.pubkey,
      credit: result.credit,
      select: true,
      targetMicro: args.targetMicro ?? result.credit.remaining_micro,
      // The rail is a pin, not a preference: every later top-up of this credit
      // has to arrive on it or the DVM refuses. Within x402 the instrument is
      // pinned the same way and for the same reason.
      rail: base.rail,
      ...(base.x402Flavour ? { x402Instrument: x402InstrumentForFlavour(base.x402Flavour) } : {}),
      ...(x402ChannelNetwork ? { x402ChannelNetwork } : {}),
      ...(args.menu ? { menu: args.menu } : {}),
      // Identity, so the offline headroom view can match a `trustOverrides`
      // pre-grant without re-describing the DVM.
      ...(args.providerInfo?.builder?.pubkey
        ? { builderPubkey: args.providerInfo.builder.pubkey }
        : {}),
      sequenced: result.replayed !== true,
    });
  }
  const fundedMicro = result.funded_micro ?? args.amountMicro;
  const balance = result.credit
    ? ` — balance $${formatUsd(result.credit.remaining_micro / 1_000_000)}`
    : "";
  // A repaired invoice may fund the operator-selected credit rather than the requested one.
  // Adopt that acknowledged credit while preserving the original funding id and separating
  // provider prose from ordinary top-up copy.
  const reconciled = result.reconciled === true && result.credit !== undefined;
  return {
    ...base,
    ...(reconciled && result.credit ? { creditId: result.credit.credit_id, reconciled } : {}),
    status: "funded",
    fundedMicro,
    ...(result.credit ? { credit: result.credit } : {}),
    ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
    ...(spentSats !== undefined ? { spentSats } : {}),
    ...(result.display !== undefined ? { providerDisplay: result.display } : {}),
    ...(result.hint !== undefined ? { providerHint: result.hint } : {}),
    display: reconciled
      ? `Funded $${formatUsd(fundedMicro / 1_000_000)} of prepaid credit at ${args.ref.endpoint}${balance}, on credit ${result.credit?.credit_id ?? base.creditId} rather than the one this funding named.`
      : `Funded $${formatUsd(fundedMicro / 1_000_000)} of prepaid credit at ${args.ref.endpoint}${balance}.`,
    hint: reconciled
      ? `Draw against credit ${result.credit?.credit_id ?? base.creditId} from here on — the credit this funding was requested under holds nothing. Check the balance any time with 'dvm credit balance'.`
      : "Draws come off this balance with no payment per job. Check it any time with 'dvm credit balance'.",
  };
}

function sameTempoTransaction(current: string | undefined, candidate: string): string {
  const normalized = candidate.toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(normalized)) {
    throw new DvmError("payment_invalid", "Tempo funding returned an invalid transaction hash.");
  }
  if (current && current !== normalized) {
    throw new DvmError(
      "payment_invalid",
      "One Tempo funding returned conflicting management transaction hashes."
    );
  }
  return normalized;
}

/** Adopt a confirmed Lightning funding, then retire its crash journal entry. */
function settleAndClear(
  args: FundCreditArgs,
  base: { creditId: string; fundId: string; rail: "lightning" },
  result: CreditOpResult,
  spend: LightningSpend | undefined,
  pending: PendingFunding
): CreditFundOutcome {
  const outcome = settled(args, base, result, spend?.spentSats);
  clearPending(pending);
  return {
    ...outcome,
    ...(spend ?? {}),
    ...(spend ? { display: `${outcome.display} ${lightningSpendDisplay(spend)}` } : {}),
  };
}

type LightningSpend = Pick<
  CreditFundOutcome,
  | "spentSats"
  | "principalSats"
  | "routingFeeSats"
  | "totalWalletFeeSats"
  | "unitemizedWalletFeeSats"
  | "walletDebitSats"
  | "paymentOutcome"
>;

function lightningSpend(payment: FloatPayment): LightningSpend {
  const walletDebitSats =
    payment.walletDebitMsats === null ? null : payment.walletDebitMsats / 1000;
  return {
    ...(walletDebitSats !== null ? { spentSats: walletDebitSats } : {}),
    principalSats: payment.principalMsats / 1000,
    routingFeeSats: payment.routingFeeMsats === null ? null : payment.routingFeeMsats / 1000,
    totalWalletFeeSats:
      payment.totalWalletFeeMsats === null ? null : payment.totalWalletFeeMsats / 1000,
    unitemizedWalletFeeSats:
      payment.unitemizedWalletFeeMsats === null
        ? null
        : payment.unitemizedWalletFeeMsats / 1000,
    walletDebitSats,
    paymentOutcome: payment.outcome,
  };
}

function lightningSpendFromPending(pending: PendingFunding): LightningSpend | undefined {
  if (pending.principalMsats === undefined || pending.paymentOutcome === undefined)
    return undefined;
  const walletDebitSats = pending.walletDebitMsats == null ? null : pending.walletDebitMsats / 1000;
  return {
    ...(walletDebitSats !== null ? { spentSats: walletDebitSats } : {}),
    principalSats: pending.principalMsats / 1000,
    routingFeeSats: pending.routingFeeMsats == null ? null : pending.routingFeeMsats / 1000,
    totalWalletFeeSats:
      pending.totalWalletFeeMsats == null ? null : pending.totalWalletFeeMsats / 1000,
    unitemizedWalletFeeSats:
      pending.unitemizedWalletFeeMsats == null
        ? null
        : pending.unitemizedWalletFeeMsats / 1000,
    walletDebitSats,
    paymentOutcome: pending.paymentOutcome,
  };
}

function lightningSpendDisplay(spend: LightningSpend): string {
  const principal = spend.principalSats ?? 0;
  if (spend.walletDebitSats == null) {
    const routing =
      spend.routingFeeSats == null
        ? "The wallet did not report its routing fee."
        : `The wallet reported ${String(spend.routingFeeSats)} sats of routing fee.`;
    return `Invoice principal ${String(principal)} sats; the total wallet debit and total wallet fee are unknown. ${routing}`;
  }
  if (spend.totalWalletFeeSats == null) {
    return `${String(spend.walletDebitSats)} sats went out for invoice principal ${String(principal)} sats; the total wallet fee is unknown.`;
  }
  if (spend.routingFeeSats == null) {
    return `${String(spend.walletDebitSats)} sats went out: invoice principal ${String(principal)} sats and total wallet fee ${String(spend.totalWalletFeeSats)} sats. The wallet did not report its routing fee, so the fee split is unknown.`;
  }
  if (spend.unitemizedWalletFeeSats == null) {
    return `${String(spend.walletDebitSats)} sats went out: invoice principal ${String(principal)} sats and total wallet fee ${String(spend.totalWalletFeeSats)} sats. The wallet reported ${String(spend.routingFeeSats)} sats of routing fee; the remaining fee split is unknown.`;
  }
  return `${String(spend.walletDebitSats)} sats went out: invoice principal ${String(principal)} sats and total wallet fee ${String(spend.totalWalletFeeSats)} sats (${String(spend.routingFeeSats)} sats wallet-reported routing fee and ${String(spend.unitemizedWalletFeeSats)} sats unitemized wallet fee).`;
}

/** The unsigned `/v1/credit` body a pending Lightning funding always replays. */
function lightningCreditBody(pending: PendingFunding): Record<string, unknown> {
  return {
    op: "fund",
    credit_id: pending.creditId,
    // No commitment: `/v1/credit` refuses one on this rail, because the
    // invoice it issues is already bound to the credit, fund id and amount.
    fund: {
      amount_micro: pending.amountMicro,
      fund_id: pending.fundId,
      method: "lightning",
    },
  };
}

/** The unsigned fund body rebuilt around the credential journaled on disk. */
function mppCreditBody(pending: PendingFunding): Record<string, unknown> {
  return {
    op: "fund",
    credit_id: pending.creditId,
    fund: {
      amount_micro: pending.amountMicro,
      fund_id: pending.fundId,
      commitment: pending.mppCredential ? sha256hex(pending.mppCredential) : "0".repeat(64),
      method: "tempo",
      intent: "session",
    },
  };
}

/** Rebuild {@link FundCreditArgs} from the durable intent, not fresh CLI flags. */
function argsFromPending(
  args: Pick<
    FundCreditArgs,
    | "transport"
    | "ref"
    | "signing"
    | "signBody"
    | "float"
    | "tempoAccount"
    | "tempoGetClient"
    | "tempoFetch"
  >,
  pending: PendingFunding
): FundCreditArgs {
  return {
    transport: args.transport,
    ref: { endpoint: pending.endpoint },
    signing: args.signing,
    creditId: pending.creditId,
    fundId: pending.fundId,
    amountMicro: pending.amountMicro,
    targetMicro: pending.targetMicro,
    maxDepositMicro: pending.maxDepositMicro ?? pending.amountMicro,
    rail: pending.rail,
    ...(pending.menu ? { menu: pending.menu } : {}),
    ...(args.signBody ? { signBody: args.signBody } : {}),
    ...("float" in args ? { float: args.float } : {}),
    ...("tempoAccount" in args ? { tempoAccount: args.tempoAccount } : {}),
    ...(args.tempoGetClient ? { tempoGetClient: args.tempoGetClient } : {}),
    ...(args.tempoFetch ? { tempoFetch: args.tempoFetch } : {}),
  };
}

/** Rebuild an x402 request from the durable intent selected for this caller. */
function argsFromPendingX402(args: FundCreditArgs, pending: PendingX402Funding): FundCreditArgs {
  return {
    ...args,
    ref: { endpoint: pending.endpoint },
    creditId: pending.creditId,
    fundId: pending.fundId,
    amountMicro: pending.amountMicro,
    targetMicro: pending.targetMicro,
    rail: "x402",
  };
}

/**
 * The signed channel intent this very credit already owns, if any. Scoped to
 * the credit and nothing else: a journalled header authorizes one credit's
 * funding, so it is the answer to that funding and to no other.
 * Channel-only by construction; the exact flavour keeps its own journal, read
 * by {@link pendingX402ExactForCredit}.
 */
function pendingX402ForCredit(args: FundCreditArgs): PendingX402Funding | undefined {
  return loadResumableX402Funding({
    endpoint: args.ref.endpoint,
    callerPubkey: args.signing.pubkey,
    creditId: args.creditId,
  });
}

/** Rebuild an exact x402 request from the authorization already signed for it. */
function argsFromPendingX402Exact(
  args: FundCreditArgs,
  pending: PendingX402ExactFunding
): FundCreditArgs {
  return {
    ...args,
    ref: { endpoint: pending.endpoint },
    creditId: pending.creditId,
    fundId: pending.fundId,
    amountMicro: pending.amountMicro,
    targetMicro: pending.targetMicro,
    rail: "x402",
  };
}

/**
 * The exact authorization this very credit already owns, if any.
 * Scoped to the credit, like its channel counterpart: the header authorizes one
 * credit's funding and is the answer to that funding and to no other.
 */
function pendingX402ExactForCredit(args: FundCreditArgs): PendingX402ExactFunding | undefined {
  return loadResumableX402ExactFunding({
    endpoint: args.ref.endpoint,
    callerPubkey: args.signing.pubkey,
    creditId: args.creditId,
  });
}

/**
 * Do not fund over another rail while this credit's presented exact header can still settle.
 * Replay its original fund id; an expired header alone does not undo an already recorded
 * payment.
 */
function exactAuthorizationPendingOutcome(
  args: FundCreditArgs,
  blocking: PendingX402ExactFunding,
  walletConnected: boolean
): CreditFundOutcome {
  const display = walletConnected
    ? `This credit already has a signed x402 authorization awaiting its answer, so it cannot be funded over ${args.rail} — that would be a second payment for the same top-up.`
    : "This credit already has a signed x402 authorization awaiting its answer, and no x402 wallet is connected to re-present it.";
  const hint = walletConnected
    ? `Re-run the x402 funding ('dvm credit fund ${blocking.endpoint} --credit-id ${blocking.creditId}') — it re-presents what was already signed, so it cannot pay twice. It stops being submittable ${x402ExactAuthorizationDeadline(blocking.paymentHeader)}, after which another rail is safe.`
    : `Reconnect the x402 wallet that signed it ('dvm wallet x402-connect') and re-run the funding, or wait: the authorization stops being submittable ${x402ExactAuthorizationDeadline(blocking.paymentHeader)}, after which another rail is safe.`;
  return {
    creditId: blocking.creditId,
    fundId: blocking.fundId,
    ...(args.rail ? { rail: args.rail } : {}),
    status: "unavailable",
    error: new DvmError("x402_exact_authorization_pending", display, hint, {
      credit_id: blocking.creditId,
      fund_id: blocking.fundId,
    }),
    display,
    hint,
  };
}

/** Rebuild a Tempo charge request from the funding already signed for it. */
function argsFromPendingTempoCharge(
  args: FundCreditArgs,
  pending: PendingTempoChargeFunding
): FundCreditArgs {
  return {
    ...args,
    ref: { endpoint: pending.endpoint },
    creditId: pending.creditId,
    fundId: pending.fundId,
    amountMicro: pending.amountMicro,
    targetMicro: pending.targetMicro,
    rail: "tempo",
  };
}

/**
 * The Tempo charge this very credit already owns, if any. Scoped to
 * the credit, like both x402 counterparts: the credential pays one credit's
 * funding and is the answer to that funding and to no other.
 */
function pendingTempoChargeForCredit(args: FundCreditArgs): PendingTempoChargeFunding | undefined {
  return loadResumableTempoChargeFunding({
    endpoint: args.ref.endpoint,
    callerPubkey: args.signing.pubkey,
    creditId: args.creditId,
  });
}

/**
 * The unanswered Tempo intent is bounded by the durable reconciliation backstop, not just the
 * short credential expiry. Passing a signature deadline does not prove the payment never
 * settled.
 */
function tempoChargePendingDeadline(pending: PendingTempoChargeFunding): string {
  const lapsesAt = pending.requestedAt + TEMPO_CHARGE_PENDING_STALE_MS;
  return Number.isFinite(lapsesAt) ? `at ${new Date(lapsesAt).toISOString()}` : "after 24 hours";
}

/**
 * Refuse another rail while this credit's Tempo funding remains unresolved; retry the original
 * fund id rather than risking a second payment.
 */
function tempoChargePendingOutcome(
  args: FundCreditArgs,
  blocking: PendingTempoChargeFunding,
  accountConnected: boolean
): CreditFundOutcome {
  const display = accountConnected
    ? `This credit already has a Tempo charge awaiting its answer, so it cannot be funded over ${args.rail} — that would be a second payment for the same top-up.`
    : "This credit already has a Tempo charge awaiting its answer, and no Tempo wallet is connected to finish it.";
  const lapses = tempoChargePendingDeadline(blocking);
  const hint = accountConnected
    ? `Re-run the Tempo funding ('dvm credit fund ${blocking.endpoint} --credit-id ${blocking.creditId}') — it asks under the fund id already used, so it cannot pay twice. That answer is the only thing that resolves this; failing it, the block lapses ${lapses} and another rail is allowed again, with the charge still unconfirmed.`
    : `Reconnect the Tempo wallet that signed it ('dvm wallet tempo-connect') and re-run the funding. Failing that, the block lapses ${lapses} and another rail is allowed again, with the charge still unconfirmed.`;
  return {
    creditId: blocking.creditId,
    fundId: blocking.fundId,
    ...(args.rail ? { rail: args.rail } : {}),
    status: "unavailable",
    error: new DvmError("tempo_charge_pending", display, hint, {
      credit_id: blocking.creditId,
      fund_id: blocking.fundId,
    }),
    display,
    hint,
  };
}

/**
 * The oldest signed intent at this DVM that would stand between this funding
 * and a fresh signature: another credit's live voucher, or any credit's refused
 * one whose deposit authorization has not expired yet. A refused entry counts
 * against its *own* credit too, because nothing replays it — the same reason
 * `assertNoRivalVoucher` stopped exempting the same credit.
 */
function otherCreditPendingX402(args: FundCreditArgs): PendingX402Funding | undefined {
  return listPendingX402Fundings({
    endpoint: args.ref.endpoint,
    callerPubkey: args.signing.pubkey,
  })
    .filter(
      (entry) =>
        x402PendingUnsettled(entry) &&
        (entry.creditId !== args.creditId || x402PendingRetired(entry))
    )
    .sort((a, b) => a.requestedAt - b.requestedAt)[0];
}

function withLightningOffer(pending: PendingFunding, offer: LightningFundingOffer): PendingFunding {
  return {
    ...pending,
    bolt11: offer.invoice,
    paymentHash: offer.payment_hash,
    amountMsats: offer.amount_msats,
    expiresAtMs: offer.expires_at_ms,
  };
}

function pendingFundingExpired(pending: PendingFunding, now = Date.now()): boolean {
  return pending.expiresAtMs !== undefined && pending.expiresAtMs <= now;
}

function clearPending(pending: PendingFunding): void {
  clearPendingFunding(pending.endpoint, pending.callerPubkey, pending.creditId, pending.fundId);
}

/** Terminal pre-payment answers that prove no useful retry remains. */
function shouldClearPending(err: unknown): boolean {
  return (
    isPermanentRefusal(err) || (err instanceof DvmError && err.code === "lightning_unavailable")
  );
}

/** Local expiry outcome for an invoice we deliberately did not put on the wire. */
function expiredFunding(base: {
  creditId: string;
  fundId: string;
  rail: CreditFundRail;
}): CreditFundOutcome {
  const error = new DvmError(
    "lightning_invoice_expired",
    "The original Lightning funding invoice expired before it was confirmed.",
    "Re-run the funding to start a new intent with a new funding id."
  );
  return {
    ...base,
    status: "refused",
    error,
    display:
      "The original Lightning invoice expired before it was funded. It was cleared and will not be polled again.",
    hint: error.hint,
  };
}

function lightningOffer(err: unknown): LightningFundingOffer | undefined {
  if (!isSettlementPending(err)) return undefined;
  const offer = (err as DvmError).data?.lightning;
  return offer as LightningFundingOffer | undefined;
}

function isSettlementPending(err: unknown): boolean {
  return (
    err instanceof DvmError &&
    err.code === "lightning_settlement_pending" &&
    isRecord(err.data?.lightning)
  );
}

/**
 * Only a definitive permanent refusal ends polling. Transport errors and timeouts do not
 * establish nonpayment. A paid-but-unrecorded invoice is permanent for crediting but still
 * represents real spend.
 */
function isPermanentRefusal(err: unknown): boolean {
  if (!(err instanceof DvmError)) return false;
  if (err.data?.retryable === false) return true;
  return CREDIT_PERMANENT_REFUSALS.has(err.code) || boundRail(err) !== undefined;
}

/**
 * The rail a credit is bound to, when the DVM refused a top-up for arriving on
 * a different one. `undefined` for every other failure.
 */
function boundRail(err: unknown): CreditFundRail | undefined {
  if (!(err instanceof DvmError)) return undefined;
  const rail = err.data?.credit_rail;
  return isCreditFundRail(rail) ? rail : undefined;
}

/** Rail-specific binding named by a terminal top-up refusal. */
function boundInstrument(err: unknown): string | undefined {
  if (!(err instanceof DvmError)) return undefined;
  return typeof err.data?.credit_instrument === "string" ? err.data.credit_instrument : undefined;
}

/** The reusable channel a terminal top-up refusal names, when it names one. */
function boundChannelId(err: unknown): string | undefined {
  if (!(err instanceof DvmError)) return undefined;
  return typeof err.data?.credit_channel_id === "string" ? err.data.credit_channel_id : undefined;
}

/** The credit that already owns the channel a terminal refusal named. */
function boundCreditId(err: unknown): string | undefined {
  if (!(err instanceof DvmError)) return undefined;
  return typeof err.data?.bound_credit_id === "string" ? err.data.bound_credit_id : undefined;
}

/**
 * Binding refusals can retire unusable journals, but paid bearer evidence must remain
 * recoverable. A different channel owner's binding cannot be adopted by the selected credit.
 */
function isBindingRefusal(err: unknown): boolean {
  return boundInstrument(err) !== undefined || boundRail(err) !== undefined;
}

/**
 * Map a **pre-payment** `/v1/credit` failure on the Lightning rail onto an
 * outcome. Only the first hop may come here: two of these answers are
 * `unavailable`, which sends `fundCredit` to the next rail — correct while
 * nothing has moved, a second payment once the float has paid.
 */
function lightningRefusal(
  base: { creditId: string; fundId: string; rail: CreditFundRail },
  err: unknown
): CreditFundOutcome {
  const mapped = err instanceof DvmError ? err : undefined;
  // Bound to another rail. The refusal lands on the *first* hop here — before
  // any invoice exists, let alone a payment — which is exactly why the server
  // checks it there (credit-routes.ts): on this rail a post-settlement refusal
  // would strand paid sats that only an operator could reconcile.
  const required = boundRail(err);
  if (required) {
    return {
      ...base,
      status: "unavailable",
      requiredRail: required,
      error: mapped,
      display: `This credit was opened over ${required}, so a Lightning top-up can't be added to it.`,
    };
  }
  // Below the DVM's Lightning receive floor. A refusal of this
  // *rail*, not this funding — ecash can carry any amount — so `unavailable`
  // keeps the loop's cashu fallback live. Reached only when the local menu
  // snapshot predates the floor (the client pre-check refuses first
  // otherwise), which is exactly when healing from the server's own numbers
  // matters.
  if (mapped?.code === "below_rail_minimum") {
    const minMicro = typeof mapped.data?.min_micro === "number" ? mapped.data.min_micro : undefined;
    return {
      ...base,
      status: "unavailable",
      error: mapped,
      display:
        typeof mapped.data?.display === "string"
          ? mapped.data.display
          : "This amount is below the minimum this DVM can receive over Lightning, so no invoice was issued.",
      hint:
        "Refill the agent's ecash pocket with 'dvm wallet fund' and retry — ecash funds any amount here." +
        (minMicro !== undefined
          ? ` Or fund at least $${formatUsd(minMicro / 1_000_000)} to use Lightning.`
          : ""),
    };
  }
  // A DVM whose receive wallet is unreachable hasn't refused the funding — it
  // just can't offer this rail right now, so another one may still work.
  if (mapped?.code === "lightning_unavailable") {
    return {
      ...base,
      status: "unavailable",
      error: mapped,
      display:
        typeof mapped.data?.display === "string"
          ? mapped.data.display
          : "This DVM can't issue a Lightning invoice right now.",
      hint: mapped.hint,
    };
  }
  return {
    ...base,
    status: "refused",
    error: mapped,
    // The DVM's own `display` when it wrote one; otherwise its message, so the
    // composed prose is never thinner than the error it was built from —
    // callers relay `display`, not `error.message`.
    display:
      typeof mapped?.data?.display === "string"
        ? mapped.data.display
        : `The credit funding was refused${mapped ? ` (${mapped.code}). ${mapped.message}` : "."}`,
    hint: mapped?.hint,
  };
}

/**
 * A local budget-cap refusal. Buffer semantics: the funding is skipped, and
 * any balance already at the DVM keeps working.
 */
function budgetRefusal(
  base: { creditId: string; fundId: string; rail: CreditFundRail },
  err: unknown
): CreditFundOutcome {
  const mapped = err instanceof DvmError ? err : undefined;
  const display =
    typeof mapped?.data?.display === "string" ? mapped.data.display : (mapped?.message ?? "");
  return {
    ...base,
    status: "refused",
    error: mapped,
    display:
      `${display} Nothing was charged, and any prepaid balance already at this DVM keeps working.`.trim(),
    hint: mapped?.hint,
  };
}

/**
 * Why a caller-forced rail can't be used. The menu is the only evidence this
 * function has about the DVM; without one the reason is necessarily local, and
 * saying otherwise blames the DVM for a wallet that isn't connected here.
 */
function forcedRailHint(args: FundCreditArgs, rail: CreditFundRail): string {
  const release = releaseForcedRailHint(args);
  const advertised = args.menu?.funding;
  if (advertised && !advertised.includes(rail)) {
    return `This DVM advertises credit funding over ${advertised.join(", ") || "no rail at all"}, not ${rail}. ${release.text}`;
  }
  if (rail === "lightning") {
    const connect = `No Lightning wallet is connected here, so there is nothing to pay an invoice with. Connect one with 'dvm wallet connect', piping the connection string in`;
    // Only an instruction can be offered as the alternative half of "do this,
    // or that". A binding is a statement of fact, and splicing it after "or"
    // reads as nonsense — it gets its own sentence.
    return release.instruction
      ? `${connect}, or ${lowerFirst(release.text)}`
      : `${connect}. ${release.text}`;
  }
  if (rail === "x402") {
    // Three different failures used to share one "connect a wallet" sentence,
    // so a caller holding a perfectly good wallet was told to reconnect it
    // Separate them: no wallet, wrong chain, or a DVM whose
    // menu names no x402 funding at all — only the last is about the DVM's own
    // terms. The chains come from both flavours: pinning to the
    // channel networks alone would tell an exact-only DVM's caller to reconnect
    // to nowhere.
    const wallet = loadX402Wallet();
    if (!wallet) {
      return `No x402 wallet is connected here, so there is nothing to sign a funding payment with. Run 'dvm wallet x402-connect' to create one, or add --key-file <path> to import a key you already hold. ${release.text}`;
    }
    const networks = x402CreditFundingNetworks(args.menu);
    if (networks.length > 0) {
      return `This DVM takes x402 credit funding on ${networks.map(x402NetworkLabel).join(", ")}, and the connected wallet is pinned to ${x402NetworkLabel(wallet.network)}. Re-pin it without handling its key: 'dvm wallet x402-network ${networks[0]}'. ${release.text}`;
    }
    if (args.menu) {
      return `This DVM's funding menu names no x402 scheme, so there is no requirement to sign a payment against. ${release.text}`;
    }
    return `This DVM's funding menu hasn't been read here, so no x402 scheme is known to sign a payment against. ${release.text}`;
  }
  if (rail === "tempo") {
    if (!hasConnectedTempoWallet(args)) {
      const connect = `No Tempo wallet is connected here, so there is nothing to sign a funding payment with. Connect one with 'dvm wallet tempo-connect'`;
      return release.instruction
        ? `${connect}, or ${lowerFirst(release.text)}`
        : `${connect}. ${release.text}`;
    }
    if (args.menu) {
      return `This DVM advertises Tempo credit funding, but its funding menu names no supported Tempo charge or session intent, so this caller has no payment to build. ${release.text}`;
    }
    return `This DVM's funding menu hasn't been read here, so no Tempo charge or session intent is known to build a payment against. ${release.text}`;
  }
  if (!args.providerInfo) {
    return `This DVM's '/v1/info' hasn't been read here, so no Cashu offer is known to attach a proof to. ${release.text}`;
  }
  return `This DVM publishes no Cashu offer for a proof to be locked to, so ecash can't fund it. ${release.text}`;
}

/**
 * Offer a command that releases the actual force: a per-call rail choice or wallet pin. A
 * server-bound credit is immutable and cannot be described as a removable preference.
 */
function releaseForcedRailHint(args: FundCreditArgs): { text: string; instruction: boolean } {
  switch (args.railSource) {
    case "per_dvm":
      return {
        text: `Run 'dvm credit rail --clear --dvm ${args.ref.endpoint}' to let the global pin or amount rule decide.`,
        instruction: true,
      };
    case "global":
      return {
        text: "Run 'dvm credit rail --clear' to let the amount rule decide.",
        instruction: true,
      };
    case "credit_bound":
      return {
        text: "This credit is bound to that rail by the DVM, so it can only be topped up over it — drain it and open a new credit to change rails.",
        instruction: false,
      };
    default:
      return { text: "Drop --rail to let the CLI pick.", instruction: true };
  }
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function unavailableDisplay(args: { ref: ProviderRef }, rail?: CreditFundRail): string {
  const what =
    rail === "lightning"
      ? "over Lightning"
      : rail === "cashu"
        ? "with ecash"
        : rail === "x402"
          ? "over x402"
          : "";
  return `No way to fund a prepaid credit at ${args.ref.endpoint}${what ? ` ${what}` : ""} right now.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
