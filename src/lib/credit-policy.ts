/**
 * Pure caller-side credit planning: first contact stays per-call, later opens
 * use 20 jobs and Cashu refills target 40 jobs, bounded by the receipt-earned
 * tier and builder limits. Default consent is suggest, so sizing becomes an
 * offer rather than a purchase. Network and wallet work belongs to callers.
 */

import { randomUUID } from "crypto";
import { type CreditFundRail, isCreditFundRail } from "@dvmkit/sdk/internal";

import {
  type CreditRailReason,
  type CreditRailSource,
  pickCreditFundRail,
} from "./credit-fund";
import type { StoredCredit, StoredImplicitCredit } from "@dvmkit/sdk/internal";
import { normalizeCreditEndpoint } from "@dvmkit/sdk/internal";
import { microToSats, msatsToMicro } from "@dvmkit/sdk/internal";
export { microToSats, msatsToMicro } from "@dvmkit/sdk/internal";
export { type FundValuation, fundWireAmountMicro, readFundValuation } from "@dvmkit/sdk/internal";
import {
  type CreditConfig,
  type CreditPosture,
  isCreditPosture,
} from "./identity";
import { offersTempoCreditFunding } from "@dvmkit/sdk/internal";
import type { StoredReceipt } from "@dvmkit/sdk/internal";
import { type AttestedDvmIdentity, attestedDvmIdentity, verifyJobReceipt } from "@dvmkit/sdk/internal";
import type { CreditMenu } from "@dvmkit/sdk/internal";
import { offersX402CreditFunding } from "@dvmkit/sdk/internal";

/**
 * A multi-job credit purchase the consent posture held back.
 *
 * Carries the figures the purchase *would* have used, so the suggestion the
 * caller renders quotes the real amount rather than a rounded illustration.
 */
export interface SuppressedPurchase {
  /** `open` — the second-interaction sizing-up. `refill` — deepening a credit already held. */
  reason: "open" | "refill";
  /** What would have been funded, micro-units of {@link currency}. */
  fundMicro: number;
  targetMicro: number;
  currency: string;
}

/**
 * A purchase the planner sized in-request but routed to the post-job healthy
 * moment instead.
 *
 * Every mode this planner can return funds *on the job request*, and a bolt11
 * has no header to ride — so a funding that should go over
 * Lightning cannot be one of them. It becomes this: the same figures, handed
 * to `credit-fund.ts` after the job settles, when the wallet has demonstrably
 * just worked. The job itself pays per-call, exactly as it would have if no
 * credit had been planned at all.
 */
export interface DeferredFunding {
  /** `open` — a first credit here. `refill` — deepening one already held. */
  reason: "open" | "refill";
  /** Caller-minted uuid on an open; the stored id on a refill. */
  creditId: string;
  /**
   * What to fund, micro-units of {@link currency}. Final: the healthy moment
   * pays this figure and never re-sizes it. A *forced* Lightning rail has
   * already floored it at the advertised minimum here, for the same reason
   * `fundTopup` does — an unforced sizing is never rounded up to
   * reach a rail.
   */
  fundMicro: number;
  targetMicro: number;
  /** Additional session deposit allowed for this funding; rebased over prior authorization. */
  maxDepositMicro?: number;
  currency: string;
  menu: CreditMenu;
  /**
   * The rail this funding is *forced* onto, when one is — a `fundingRail` pin,
   * or the DVM's own binding on a credit already open. Carried rather than
   * re-derived at the healthy moment, because re-picking by amount there would
   * spend a round trip (and a prepared ecash spend) on a rail `/v1/credit` is
   * certain to refuse `rail_mismatch`.
   */
  pinnedRail?: CreditFundRail;
  pinnedRailSource?: ForcedFundingRail["source"];
}

/** Explains an eligible automatic purchase left per-call; carries no spending authorization or amounts. */
export interface FundingSkip {
  reason: "btc_rate_unavailable";
  operation: "open" | "refill";
}

export type CreditPlan =
  /**
   * Per-call implicit N=1 — wire-identical to the pre-credits request.
   * `suppressed` is set only under `posture: "suggest"`, and only where a
   * purchasing plan would otherwise have been returned; `deferred` only under
   * `auto`, where the sizing stands but the rail it belongs on can't ride the
   * job request.
   */
  | {
      mode: "none";
      suppressed?: SuppressedPurchase;
      deferred?: DeferredFunding;
      drawSkipped?: DrawSkip;
      fundingSkipped?: FundingSkip;
    }
  /** Draw on an existing credit: credit fields in the signed body, no payment attach. */
  | {
      mode: "draw";
      creditId: string;
      drawId: string;
      /** Released per-call value is selected ahead of drainable prepaid credit. */
      source?: "implicit" | "prepaid";
    }
  /** Fund-and-draw on `/v1/job`: open a new credit or deepen an existing one. */
  | {
      mode: "open" | "topup";
      /** Caller-minted uuid on `open`; the stored id on `topup`. */
      creditId: string;
      /** Caller-minted draw id — reused verbatim on any retry (idempotency key). */
      drawId: string;
      /** Signed `fund.amount_micro`, menu currency. */
      fundMicro: number;
      fundSats: number;
      /** Budget-ledger figure (`fundSats × 1000`). */
      fundMsats: number;
      currency: string;
      targetMicro: number;
      /**
       * The signed `fund.amount_micro` — {@link fundWireAmountMicro} over
       * server-authored figures. Set by the submit path once the server's
       * fiat price is known; absent means the wire amount isn't computable
       * and the plan must stand down.
       */
      wireAmountMicro?: number;
      /**
       * Why this sizing rides the job request as ecash instead of going to the
       * float — "below the Lightning minimum", "no float connected",
       * "pinned to cashu". The route is only half the transparency; without the
       * reason, a caller watching a connected float go unused learns nothing.
       */
      railReason?: CreditRailReason;
    };

/** Identifies the setting behind a draw ceiling so refusal hints name the right command. */
export type DrawCeilingSource = "auto_pay_below" | "config_threshold" | "budget";

/** Explains why held credit was left undrawn rather than implying a provider refused it. */
export interface DrawSkip {
  reason:
    | "posture_off"
    | "not_active"
    | "reconciliation_pending"
    | "exhausted"
    | "expired"
    | "price_above_ceiling";
  creditId: string;
  /** Its believed spendable balance, micro-units. */
  remainingMicro: number;
  /** The ceiling the price proxy was measured against. `price_above_ceiling` only. */
  ceilingMicro?: number;
  /** The last drawn amount that exceeded it. `price_above_ceiling` only. */
  lastPriceMicro?: number;
  /** Which knob set that ceiling, so the hint names it. `price_above_ceiling` only. */
  ceilingSource?: DrawCeilingSource;
}

export interface TrustTier {
  tier: 0 | 1 | 2;
  /** Cap on the credit size this tier permits, micro-units. */
  capMicro: number;
}

/** Receipt evidence and next-tier requirements, including an unknown builder cap without a menu. */
export interface TrustLadder {
  tier: 0 | 1 | 2;
  /**
   * Cap this tier permits, micro-units. Undefined only at tier 2 with no menu
   * to read the builder's maximum off — the cap is the builder's word, and
   * inventing one would be worse than saying "unknown".
   */
  capMicro?: number;
  /**
   * Completed, re-verified receipts this signing identity collected from this
   * endpoint. Another identity's history at the same DVM is not counted — see
   * {@link trustLadderFor}.
   */
  receipts: number;
  /** Span those receipts cover, ms. Zero below two receipts. */
  spanMs: number;
  /** What the next rung needs. Absent at tier 2 — there is no rung above it. */
  next?: {
    tier: 1 | 2;
    /** The cap that rung permits; undefined for tier 2 with no menu. */
    capMicro?: number;
    /** Further completed receipts needed, beyond those already held. */
    receiptsNeeded: number;
    /** Span the receipts must cover — set on the tier-2 rung only. */
    spanMs?: number;
  };
}

/** Ratified tier-0 cap: $0.50. */
export const TIER0_CAP_MICRO = 500_000;
/** Ratified tier-1 cap: $2. */
export const TIER1_CAP_MICRO = 2_000_000;
export const TIER1_MIN_RECEIPTS = 3;
export const TIER2_MIN_RECEIPTS = 15;
export const TIER2_MIN_SPAN_MS = 7 * 24 * 60 * 60 * 1000;
export const OPEN_TARGET_JOBS = 20;
/** Ratified refill target multiple on the Cashu rail (deeper: outage runway). */
export const CASHU_REFILL_TARGET_JOBS = 40;
export const TOPUP_THRESHOLD_FRACTION = 0.25;
/** Unconfigured callers receive suggestions, never automatic purchases. */
export const DEFAULT_CREDIT_POSTURE: CreditPosture = "suggest";
/** Default ecash pocket target is $5; credit.pocketTarget may override it. */
export const POCKET_TARGET_MICRO = 5_000_000;

/**
 * Derive the trust tier for one DVM from the receipt collection.
 *
 * Counts only receipts that (a) re-verify right now — the stored verdict is a
 * hand-editable file and a tier ladder built on it would be trivially forged —
 * (b) attest a `completed` outcome, (c) were collected from the same endpoint
 * origin, and (d) name {@link signingPubkey} as their requester.
 */
export function trustTierFor(args: {
  receipts: StoredReceipt[];
  endpoint: string;
  /** Whose trust this is. See {@link trustLadderFor} for the `undefined` case. */
  signingPubkey: string | undefined;
  /** This DVM's attested identity, when a live `/v1/info` supplied one. */
  identity?: AttestedDvmIdentity;
  tier0CapMicro?: number;
  tier1CapMicro?: number;
  menu: CreditMenu;
}): TrustTier {
  const ladder = trustLadderFor(args);
  return { tier: ladder.tier, capMicro: ladder.capMicro ?? args.menu.max_micro };
}

/**
 * The same derivation as {@link trustTierFor}, carrying the receipt evidence
 * and the next rung's terms.
 *
 * The menu is optional here: this runs on offline surfaces (`dvm credit list`)
 * where the only menu is whatever snapshot the store happens to hold. Without
 * one, tier 2's cap — the builder's own maximum — reads as unknown rather than
 * as a number nobody advertised.
 *
 * `signingPubkey` is not optional, deliberately. The ladder is
 * per-identity — the published contract is that switching `--as` starts a
 * separate relationship rather than continuing the one that earned the trust —
 * and a call site that omitted it would silently hand a fresh identity whatever
 * tier its neighbour earned. Passing `undefined` is a real answer ("this surface
 * doesn't know who is asking"), and it counts nothing: an unknown identity has
 * earned nothing, which is the safe direction.
 */
export function trustLadderFor(args: {
  receipts: StoredReceipt[];
  endpoint: string;
  /** The signing identity whose trust this is; `undefined` earns nothing. */
  signingPubkey: string | undefined;
  /**
   * This DVM's attested identity, when a live `/v1/info` supplied one
   * It pools the history a DVM answering on more than one hostname
   * would otherwise split — and only across receipts that chain to the *same
   * builder key*, so a stranger self-attesting this `dvm_id` earns nothing.
   * Omitting it falls back to the identity this origin's own attested receipts
   * prove, which is what the offline surfaces have.
   */
  identity?: AttestedDvmIdentity;
  tier0CapMicro?: number;
  tier1CapMicro?: number;
  menu?: CreditMenu;
}): TrustLadder {
  const successes = completedReceiptsFor(
    args.receipts,
    args.endpoint,
    args.signingPubkey,
    args.identity
  );
  const tier0Cap = args.tier0CapMicro ?? TIER0_CAP_MICRO;
  const tier1Cap = args.tier1CapMicro ?? TIER1_CAP_MICRO;
  const builderMax = args.menu?.max_micro;

  const issued = successes.map((r) => r.receipt.issued_at * 1000);
  const spanMs = issued.length > 1 ? Math.max(...issued) - Math.min(...issued) : 0;
  const count = successes.length;

  if (count >= TIER2_MIN_RECEIPTS && spanMs >= TIER2_MIN_SPAN_MS) {
    return {
      tier: 2,
      ...(builderMax !== undefined ? { capMicro: builderMax } : {}),
      receipts: count,
      spanMs,
    };
  }
  // The tier-2 rung is quoted with both of its conditions, because a caller
  // holding 20 receipts from one afternoon is short on *time*, not receipts —
  // and "0 more receipts needed" without the span would read as a bug.
  const toTier2 = {
    tier: 2 as const,
    ...(builderMax !== undefined ? { capMicro: builderMax } : {}),
    receiptsNeeded: Math.max(TIER2_MIN_RECEIPTS - count, 0),
    spanMs: TIER2_MIN_SPAN_MS,
  };
  if (count >= TIER1_MIN_RECEIPTS) {
    return { tier: 1, capMicro: tier1Cap, receipts: count, spanMs, next: toTier2 };
  }
  return {
    tier: 0,
    capMicro: tier0Cap,
    receipts: count,
    spanMs,
    next: { tier: 1, capMicro: tier1Cap, receiptsNeeded: TIER1_MIN_RECEIPTS - count },
  };
}

/** A posture and where it came from — what `dvm credit list` renders as provenance. */
export interface EffectivePosture {
  posture: CreditPosture;
  /** `per_dvm` beats `global` beats `default`. */
  source: "default" | "global" | "per_dvm";
}

/**
 * Resolve the consent posture in force for one DVM.
 *
 * Layered on the existing `perDvm` shape, so a global `suggest` with `auto` at
 * one DVM and a global `auto` with `suggest` at one DVM are both expressible.
 *
 * A value that isn't one of the three coerces to the default rather than
 * throwing on the money path: the safe reading of a typo is "don't spend".
 * `dvm doctor` is the surface that names it as malformed.
 */
export function effectiveCreditPosture(
  config: CreditConfig | undefined,
  endpoint: string,
  identity?: AttestedDvmIdentity
): EffectivePosture {
  const postures = perDvmEntriesFor(config, endpoint, identity)
    .map(([, per]) => per.posture)
    .filter(isCreditPosture);
  // Most-restrictive wins across the spellings. A caller who typed
  // `off` at one hostname said "don't spend here"; the other spelling is the
  // same DVM, and reading their two entries as two policies is what let a job
  // draw at a DVM they had opted out of.
  const per = postures.reduce<CreditPosture | undefined>(
    (strictest, posture) =>
      strictest === undefined || POSTURE_STRICTNESS[posture] > POSTURE_STRICTNESS[strictest]
        ? posture
        : strictest,
    undefined
  );
  if (per !== undefined) return { posture: per, source: "per_dvm" };
  const global = config?.posture;
  if (isCreditPosture(global)) return { posture: global, source: "global" };
  return { posture: DEFAULT_CREDIT_POSTURE, source: "default" };
}

export interface ForcedFundingRail {
  rail: CreditFundRail;
  /**
   * What forced it. `credit_bound` is the DVM's own binding on an open credit —
   * physics, and it outranks a caller pin; the other two are the pin itself.
   * `flag` never reaches here, because `--rail` is a manual-funding verb.
   */
  source: Exclude<CreditRailSource, "flag">;
}

export interface EffectiveFundingRail {
  /** The pinned rail, or undefined when nothing is pinned and the amount rule decides. */
  rail?: CreditFundRail;
  /** `per_dvm` beats `global`; `default` means no pin. */
  source: "default" | "global" | "per_dvm";
  /**
   * Set when two spellings of one DVM carry different pins, which is why the
   * per-DVM layer contributed nothing. Names both former rails and
   * the config keys holding them, so the caller can re-pin the one they meant.
   * The layer below still applies, so `rail` may be the global pin.
   */
  conflict?: { rails: CreditFundRail[]; endpoints: string[] };
}

/**
 * Resolve the `fundingRail` pin in force for one DVM, or the global
 * layer when no endpoint is supplied. This is the persisted form of `dvm
 * credit fund --rail`, layered exactly like the consent posture.
 *
 * A value outside the funding-rail registry is ignored rather than throwing on
 * the money path, matching {@link effectiveCreditPosture}: the safe reading of
 * a typo is "no pin", which leaves the amount rule in charge instead of
 * forcing a rail nobody named. `dvm doctor` is the surface that calls it
 * malformed.
 */
export function effectiveFundingRail(
  config: CreditConfig | undefined,
  endpoint?: string,
  identity?: AttestedDvmIdentity
): EffectiveFundingRail {
  let conflict: EffectiveFundingRail["conflict"];
  if (endpoint !== undefined) {
    const pinned = perDvmEntriesFor(config, endpoint, identity).flatMap(([origin, per]) =>
      isCreditFundRail(per.fundingRail) ? [[origin, per.fundingRail] as const] : []
    );
    const rails = [...new Set(pinned.map(([, rail]) => rail))];
    // Two spellings of one DVM pinned to different rails is not a pin — there
    // is no reading of it that honours both. The per-DVM layer contributes
    // nothing and the layers below decide, exactly as they would once the
    // dropped pins are gone from the file; name what was there so the caller
    // can re-pin deliberately.
    if (rails.length > 1) conflict = { rails, endpoints: pinned.map(([origin]) => origin) };
    else if (rails.length === 1) return { rail: rails[0], source: "per_dvm" };
  }
  const global = config?.fundingRail;
  if (isCreditFundRail(global))
    return { rail: global, source: "global", ...(conflict ? { conflict } : {}) };
  return { source: "default", ...(conflict ? { conflict } : {}) };
}

/** Immutable rail of the active credit the automatic planner will refill. */
export function automaticCreditBoundRail(
  stored: Pick<StoredCredit, "status" | "rail" | "reconciliationPending"> | undefined
): CreditFundRail | undefined {
  if (stored?.status !== "active" || stored.reconciliationPending) return undefined;
  return isCreditFundRail(stored.rail) ? stored.rail : undefined;
}

/**
 * The cap a config pre-grant sets for every DVM signed by one builder, or
 * undefined when none applies. Keyed by the **builder pubkey**: a
 * pre-grant is builder-wide, and only an authenticated live builder block may
 * select it on the money-moving path.
 *
 * `"builder-max"` means "whatever this builder advertises" — with no menu in
 * hand that is unbounded rather than unknown, because the caller pre-granted
 * the builder, not a figure.
 *
 * Both sides of the lookup are lowercased. Hex is case-insensitive and a pubkey
 * gets pasted in from wherever the caller found it; a pre-grant that silently
 * fails to match because it was written in uppercase is the exact failure this
 * whole surface exists to prevent.
 */
export function trustOverrideCapMicro(args: {
  config?: CreditConfig;
  builderPubkey?: string;
  menu?: CreditMenu;
}): number | undefined {
  const raw = args.builderPubkey
    ? lookupOverride(args.config?.trustOverrides, args.builderPubkey)
    : undefined;
  if (!raw) return undefined;
  if (raw.trim().toLowerCase() === "builder-max") {
    return args.menu?.max_micro ?? Number.POSITIVE_INFINITY;
  }
  return parseCapMicro(raw);
}

export function tierCapOverrides(config: CreditConfig | undefined): {
  tier0CapMicro?: number;
  tier1CapMicro?: number;
} {
  const out: { tier0CapMicro?: number; tier1CapMicro?: number } = {};
  const tier0 = parseCapMicro(config?.tier0Cap);
  const tier1 = parseCapMicro(config?.tier1Cap);
  if (tier0 !== undefined) out.tier0CapMicro = tier0;
  if (tier1 !== undefined) out.tier1CapMicro = tier1;
  return out;
}

/**
 * Ratified open sizing: `clamp(builder_min, 20 × job_price, tier_cap)`, then
 * capped so the residual after the draw stays within the builder's `max`
 * (`/v1/job` doesn't enforce the residual ceiling, `/v1/credit` does — an
 * over-max open would strand the next top-up). The builder floor binds last:
 * a `min` above the tier cap means the smallest fundable credit, not zero.
 */
export function sizeCreditMicro(args: {
  menu: CreditMenu;
  priceMicro: number;
  capMicro: number;
  targetJobs?: number;
}): number {
  const target = (args.targetJobs ?? OPEN_TARGET_JOBS) * args.priceMicro;
  let size = Math.max(args.menu.min_micro, Math.min(target, args.capMicro));
  const residualCeiling = args.menu.max_micro + args.priceMicro;
  size = Math.min(size, residualCeiling);
  return Math.max(size, args.menu.min_micro);
}

/** The refill target for a Cashu-funded credit: 40 × price, tier-capped, min-floored. */
export function refillTargetMicro(args: {
  menu: CreditMenu;
  priceMicro: number;
  capMicro: number;
  targetJobs?: number;
}): number {
  const target = (args.targetJobs ?? CASHU_REFILL_TARGET_JOBS) * args.priceMicro;
  return Math.max(args.menu.min_micro, Math.min(target, args.capMicro, args.menu.max_micro));
}

/**
 * Decide how the upfront payment for a quoted job engages the credit ledger.
 * Returns `{mode: "none"}` — per-call implicit N=1, wire-identical to today —
 * unless every gate passes.
 *
 * Under `posture: "suggest"` (the default since the behavior was introduced) the sizing is done
 * exactly as it would be under `auto` and then handed back as
 * {@link SuppressedPurchase} instead of a purchasing plan, so the caller can
 * offer the real figure. The posture governs whether a plan is *returned*; it
 * never touches how a returned plan settles, so both idempotency regimes —
 * request/proof-keyed implicit N=1, `draw_id`-keyed explicit draws — are
 * untouched.
 */
export function planCreditForQuote(args: {
  menu: CreditMenu | undefined;
  endpoint: string;
  /**
   * This DVM's attested identity off `/v1/info`. Resolves the
   * posture, the rail pin and the trust ladder against every hostname the
   * caller has used for this DVM rather than only the one they typed.
   */
  identity?: AttestedDvmIdentity;
  signingPubkey: string | undefined;
  priceMsats: number;
  btcRate: number;
  receipts: StoredReceipt[];
  stored: StoredCredit | undefined;
  config?: CreditConfig;
  /**
   * Whether an NWC float is connected here. Passed in rather than
   * read, so this module stays pure — and `false` keeps a no-float caller's
   * behaviour byte-identical to the pre-1806 cashu-only path.
   */
  floatConnected?: boolean;
  /** Whether an x402 signing wallet is connected for deferred channel funding. */
  x402Connected?: boolean;
  /**
   * CAIP-2 chain that wallet is pinned to, when one is connected. Passed in
   * for the same purity reason as the flags above; omitting it leaves the
   * channel check scheme-level, which is the honest answer when the caller
   * genuinely doesn't know their own chain.
   */
  x402Network?: string;
  /** Whether a caller-side Tempo account can drive an advertised charge or session. */
  tempoConnected?: boolean;
  now?: number;
}): CreditPlan {
  const none: CreditPlan = { mode: "none" };
  const menu = args.menu;
  if (!menu || !args.signingPubkey) return none;
  const posture = effectiveCreditPosture(args.config, args.endpoint, args.identity).posture;
  if (posture === "off") return none;
  // USD-denominated menus only. Both stablecoin rails are eligible: Tempo and
  // x402 each prefer a durable channel where one is advertised, while a
  // one-shot charge/exact authorization is signed fresh per top-up.
  //
  // Cashu is the only rail a *returned plan* can ride, for a structural reason
  // rather than a policy one: every mode this function returns funds on the job
  // request, and a bolt11 has no header to hang on. Lightning is no
  // longer excluded from the *decision*, though — a sizing this
  // caller's float should carry comes back as {@link DeferredFunding} and lands
  // at the post-job healthy moment through `credit-fund.ts`.
  if (menu.currency.toLowerCase() !== "usd") return none;
  const canCashu = menu.funding.includes("cashu");
  const canFloat = menu.funding.includes("lightning") && args.floatConnected === true;
  // Both stablecoin rails need the menu to name the actual instrument, not just
  // the rail: a Tempo charge or session method for `tempo`, and for `x402` a
  // scheme this caller can build on the wallet's own chain — either flavour
  // Scheduling an open against a DVM that offers neither
  // re-defers the same dead route on every job.
  const canX402 =
    menu.funding.includes("x402") &&
    args.x402Connected === true &&
    offersX402CreditFunding(menu, args.x402Network);
  const canMpp =
    menu.funding.includes("tempo") &&
    args.tempoConnected === true &&
    offersTempoCreditFunding(menu);
  if (!canCashu && !canFloat && !canX402 && !canMpp) return none;
  if (!Number.isFinite(args.priceMsats) || args.priceMsats <= 0) return none;

  const stored = args.stored;
  if (stored?.reconciliationPending) return none;
  const refilling = stored?.status === "active" && stored.currency === menu.currency;

  // First contact stays per-call. An open requires completed receipt evidence
  // earned by this signer at this DVM; an active credit already permits a refill.
  const rateUnavailable = !Number.isFinite(args.btcRate) || args.btcRate <= 0;
  if (!refilling) {
    const completed = completedReceiptsFor(
      args.receipts,
      args.endpoint,
      args.signingPubkey,
      args.identity
    );
    if (completed.length === 0) return none;
    // Same-origin history can predate the live identity. Do not attribute a
    // rate diagnostic to that history; valid-rate policy remains unchanged.
    const identity = args.identity;
    if (
      rateUnavailable &&
      identity &&
      !completed.some((entry) => {
        const attested = attestedDvmIdentity(entry.builder);
        return attested?.dvmId === identity.dvmId && attested.builderPubkey === identity.builderPubkey;
      })
    ) {
      return none;
    }
  }
  // Diagnose only after the policy gates: missing pricing cannot explain a
  // purchase the caller would not have made. No sizing or deferred spend is safe here.
  if (rateUnavailable) {
    return posture === "auto"
      ? {
          mode: "none",
          fundingSkipped: {
            reason: "btc_rate_unavailable",
            operation: refilling ? "refill" : "open",
          },
        }
      : none;
  }

  const priceMicro = msatsToMicro(args.priceMsats, args.btcRate);
  if (priceMicro <= 0) return none;

  const tier = trustTierFor({
    receipts: args.receipts,
    endpoint: args.endpoint,
    signingPubkey: args.signingPubkey,
    ...(args.identity ? { identity: args.identity } : {}),
    menu,
    ...tierCapOverrides(args.config),
  });

  const targetJobs = targetJobsFor(args.config, args.endpoint, args.identity);
  const pin = effectiveFundingRail(args.config, args.endpoint, args.identity);
  const eligible: CreditFundRail[] = [
    ...(canCashu ? (["cashu"] as const) : []),
    ...(canFloat ? (["lightning"] as const) : []),
    ...(canX402 ? (["x402"] as const) : []),
    ...(canMpp ? (["tempo"] as const) : []),
  ];

  /**
   * Which mechanism this sizing belongs to — the in-request Cashu fund-and-draw
   * (one round trip, rides the job) or a `/v1/credit` call at the post-job
   * healthy moment (the only way a bolt11 can pay) — and why.
   *
   * The pick itself is {@link pickCreditFundRail}, so this is the same rule
   * `dvm credit fund` and the post-job refill run rather than a second copy of
   * it. Precedence is binding → pin → amount, and the first two are forces: a
   * pinned rail routes here even when it will be refused, so the refusal is the
   * DVM's own `below_rail_minimum` naming the alternatives rather than a silent
   * reroute the caller never sees. Size is never consulted in the other
   * direction — the route follows the amount, the amount never chases a route.
   */
  const routeFor = (
    fundMicro: number,
    boundRail?: CreditFundRail
  ): { route: "deferred" | "cashu"; reason: CreditRailReason } => {
    const forced = boundRail ?? pin.rail;
    const pick = pickCreditFundRail({
      rails: eligible,
      amountMicro: fundMicro,
      menu,
      ...(args.x402Network ? { x402Network: args.x402Network } : {}),
      ...(forced ? { forced } : {}),
    });
    // A forced rail with nothing eligible yields an empty order; the force still
    // decides the mechanism, and the refusal is reported where it happens.
    const head = forced ?? pick.order[0];
    return { route: head === "cashu" ? "cashu" : "deferred", reason: pick.reason };
  };
  const pinned: ForcedFundingRail | undefined =
    pin.rail && pin.source !== "default" ? { rail: pin.rail, source: pin.source } : undefined;
  const defer = (
    reason: "open" | "refill",
    creditId: string,
    fundMicro: number,
    targetMicro: number,
    maxDepositMicro: number,
    forced = pinned
  ): CreditPlan => ({
    mode: "none",
    deferred: {
      reason,
      creditId,
      fundMicro,
      targetMicro,
      maxDepositMicro,
      currency: menu.currency,
      menu,
      ...(forced ? { pinnedRail: forced.rail, pinnedRailSource: forced.source } : {}),
    },
  });

  if (refilling) {
    const targetMicro = refillTargetMicro({
      menu,
      priceMicro,
      capMicro: tier.capMicro,
      ...(targetJobs !== undefined ? { targetJobs } : {}),
    });
    // A credit the DVM bound to Lightning cannot be deepened on the job request
    // at all, so this is not only the float engaging — it is the one route that
    // exists. Before the plan came back as a Cashu fund-and-draw the
    // DVM was always going to refuse `rail_mismatch`. The binding outranks the
    // pin for the same reason: it is the server's, not the caller's.
    const boundRail = isCreditFundRail(stored.rail) ? stored.rail : undefined;
    const forcedRefill: ForcedFundingRail | undefined = boundRail
      ? { rail: boundRail, source: "credit_bound" }
      : pinned;
    // A refill whose rail is *forced* to Lightning floors at the rail's
    // advertised minimum, exactly as `fundTopup` does: the gap can
    // easily sit under the receive floor, and a bare-gap invoice can never
    // route — so the refill could only ever be refused `below_rail_minimum`,
    // once per job, forever. The excess over `targetMicro` is spendable
    // balance, not waste. Forced only: an unforced sizing the amount rule
    // *might* send to Lightning keeps its natural size, because the route
    // follows the amount and never the other way round.
    const railFloorMicro =
      forcedRefill?.rail === "lightning" && menu.lightning_min_micro !== undefined
        ? Math.max(menu.min_micro, menu.lightning_min_micro)
        : menu.min_micro;
    const fundMicro = Math.min(
      Math.max(railFloorMicro, targetMicro - Math.max(stored.remainingMicro, 0) + priceMicro),
      menu.max_micro
    );
    if (posture === "suggest") {
      return {
        mode: "none",
        suppressed: { reason: "refill", fundMicro, targetMicro, currency: menu.currency },
      };
    }
    const refillRoute = routeFor(fundMicro, boundRail);
    if (refillRoute.route === "deferred") {
      return defer("refill", stored.creditId, fundMicro, targetMicro, fundMicro, forcedRefill);
    }
    if (!canCashu) return none;
    return {
      mode: "topup",
      creditId: stored.creditId,
      drawId: randomUUID(),
      ...fundAmounts(fundMicro, args.btcRate),
      currency: menu.currency,
      targetMicro,
      railReason: refillRoute.reason,
    };
  }

  const fundMicro = sizeCreditMicro({
    menu,
    priceMicro,
    capMicro: tier.capMicro,
    ...(targetJobs !== undefined ? { targetJobs: Math.min(targetJobs, OPEN_TARGET_JOBS) } : {}),
  });
  const targetMicro = refillTargetMicro({
    menu,
    priceMicro,
    capMicro: tier.capMicro,
    ...(targetJobs !== undefined ? { targetJobs } : {}),
  });
  if (posture === "suggest") {
    return {
      mode: "none",
      suppressed: { reason: "open", fundMicro, targetMicro, currency: menu.currency },
    };
  }
  // Opening size expresses approved risk; do not inflate it to reach a rail minimum.
  const openRoute = routeFor(fundMicro);
  if (openRoute.route === "deferred") {
    return defer("open", randomUUID(), fundMicro, targetMicro, fundMicro);
  }
  if (!canCashu) return none;
  return {
    mode: "open",
    creditId: randomUUID(),
    drawId: randomUUID(),
    ...fundAmounts(fundMicro, args.btcRate),
    currency: menu.currency,
    targetMicro,
    railReason: openRoute.reason,
  };
}

/**
 * Decide whether the *initial* signed submit should draw on a credit already
 * held at this DVM — one round trip, no payment attach. The job price is
 * unknowable pre-probe, so the consent gate runs against the last drawn
 * amount: a DVM that hiked its price past the caller's threshold surfaces as
 * `insufficient_credit` or as a visible receipt line, both recoverable.
 *
 * A draw is deliberately **not** gated on the caller's per-call payment
 * consent (`--auto-pay`). Drawing attaches no payment: the money left the
 * caller's wallet when the credit was funded, and gating it on the flag that
 * approves *new* charges produced the exact inversion the posture rule below
 * warns about — a caller holding a funded balance was offered an upfront
 * charge instead of spending it.
 *
 * `drawCeilingMsats` is the caller's declared ceiling for the whole job, not
 * the per-call auto-pay increment. Borrowing the increment made a draw
 * self-disabling: the first one records `lastPriceMicro`, and a threshold
 * derived as a fraction of the budget then refuses every draw after it.
 * A ceiling of 0 (no budget declared) leaves the price proxy unenforced, the
 * same as before — the credit's own balance is then the only bound.
 *
 * `drawCeilingSource` names which knob supplied it. Required rather than
 * optional so a caller can't produce a skip the hint has to guess at.
 */
export function planProbeDraw(args: {
  stored: StoredCredit | undefined;
  /** Receipt-backed per-call balances at this DVM, already scoped to this caller. */
  implicit?: readonly StoredImplicitCredit[];
  drawCeilingMsats: number;
  drawCeilingSource: DrawCeilingSource;
  btcRate: number;
  config?: CreditConfig;
  /** This DVM's attested identity, so a posture written at another spelling applies. */
  identity?: AttestedDvmIdentity;
  now?: number;
}): CreditPlan {
  const now = args.now ?? Date.now();
  const implicit = [...(args.implicit ?? [])]
    .filter(
      (credit) => credit.status === "active" && credit.remainingMicro > 0 && credit.expiryMs > now
    )
    .sort((a, b) => a.expiryMs - b.expiryMs)
    .at(0);
  if (implicit) {
    if (effectiveCreditPosture(args.config, implicit.endpoint, args.identity).posture === "off") {
      return {
        mode: "none",
        drawSkipped: {
          reason: "posture_off",
          creditId: implicit.creditId,
          remainingMicro: implicit.remainingMicro,
        },
      };
    }
    return {
      mode: "draw",
      creditId: implicit.creditId,
      drawId: randomUUID(),
      source: "implicit",
    };
  }
  const stored = args.stored;
  if (!stored) return { mode: "none" };
  const skip = (reason: DrawSkip["reason"], extra?: Partial<DrawSkip>): CreditPlan => ({
    mode: "none",
    drawSkipped: {
      reason,
      creditId: stored.creditId,
      remainingMicro: stored.remainingMicro,
      ...extra,
    },
  });
  // Only `off` stops a draw. `suggest` gates *purchases*, not the spending of a
  // balance the caller already consented to funding — refusing to draw on it
  // would make them pay per-call on top of money already parked at the DVM.
  if (effectiveCreditPosture(args.config, stored.endpoint, args.identity).posture === "off") {
    return skip("posture_off");
  }
  if (stored.status !== "active") return skip("not_active");
  if (stored.reconciliationPending) return skip("reconciliation_pending");
  // A provisional zero is this CLI's own placeholder, not the DVM's word:
  // `ensureProvisionalCredit` writes `remainingMicro: 0` *before* the
  // fund-and-draw that fills it, so reporting it as `exhausted` tells the agent
  // money it is holding has been spent — and under posture `auto` sizes a
  // second full deposit off that zero. Draw instead and let the
  // server settle it: every refusal a draw can earn already has a recovery
  // (`credit_not_found` retires the record, `insufficient_credit` refills under
  // the DVM's own figures), where a local skip only defers the question.
  if (stored.remainingMicro <= 0 && !stored.provisional) return skip("exhausted");
  if (stored.expiryMs > 0 && stored.expiryMs <= now) return skip("expired");
  if (stored.lastPriceMicro !== undefined && args.btcRate > 0) {
    const ceilingMicro = msatsToMicro(args.drawCeilingMsats, args.btcRate);
    if (ceilingMicro > 0 && stored.lastPriceMicro > ceilingMicro) {
      return skip("price_above_ceiling", {
        ceilingMicro,
        lastPriceMicro: stored.lastPriceMicro,
        ceilingSource: args.drawCeilingSource,
      });
    }
  }
  return { mode: "draw", creditId: stored.creditId, drawId: randomUUID(), source: "prepaid" };
}

export function needsTopup(balanceMicro: number, targetMicro: number): boolean {
  return targetMicro > 0 && balanceMicro < targetMicro * TOPUP_THRESHOLD_FRACTION;
}

/** The ecash pocket target: the config override when parseable, else $5. */
export function pocketTargetMicro(config?: CreditConfig): number {
  return parseCapMicro(config?.pocketTarget) ?? POCKET_TARGET_MICRO;
}

/**
 * True when the held-ecash pocket has dropped below the refill threshold —
 * the same 25% low-water mark the credit top-up uses, so both buffers refill
 * at the same healthy moments.
 */
export function needsPocketRefill(balanceMicro: number, targetMicro: number): boolean {
  return needsTopup(balanceMicro, targetMicro);
}

/**
 * Every `perDvm` entry that governs one DVM, in config order.
 *
 * The key is still the origin the caller typed — this is hand-edited config,
 * and an opaque uuid there would be unreadable — so an entry is selected by
 * that key *or* by the attested identity stamped onto it. The identity half is
 * gated on the builder pubkey as well as the `dvm_id`: the attestation is
 * self-signed, so `dvm_id` alone would let a stranger's endpoint inherit the
 * rules a caller wrote for someone else.
 */
function perDvmEntriesFor(
  config: CreditConfig | undefined,
  endpoint: string,
  identity?: AttestedDvmIdentity
): [string, NonNullable<CreditConfig["perDvm"]>[string]][] {
  const perDvm = config?.perDvm;
  if (!perDvm) return [];
  const key = normalizeCreditEndpoint(endpoint);
  return Object.entries(perDvm).filter(
    ([origin, per]) =>
      normalizeCreditEndpoint(origin) === key ||
      (identity !== undefined &&
        per.dvmId === identity.dvmId &&
        per.builderPubkey?.trim().toLowerCase() === identity.builderPubkey)
  );
}

const POSTURE_STRICTNESS: Record<CreditPosture, number> = { auto: 0, suggest: 1, off: 2 };

function fundAmounts(
  fundMicro: number,
  btcRate: number
): { fundMicro: number; fundSats: number; fundMsats: number } {
  const fundSats = microToSats(fundMicro, btcRate);
  return { fundMicro, fundSats, fundMsats: fundSats * 1000 };
}

/**
 * The completed, re-verified receipts one signing identity holds at one
 * endpoint — the evidence every rung of the ladder is counted from.
 *
 * Scoped to `signingPubkey` because that is what the published contract
 * promises: credits, receipts and accumulated trust belong to the
 * identity that earned them. The comparison is against the receipt's own
 * `requester_pubkey`, which rides inside the DVM-signed body: re-pointing a
 * neighbour's receipt at your key breaks the signature, and the re-verification
 * below then drops it entirely.
 *
 * Two absences both count for nobody, and both are correct. An `undefined`
 * `signingPubkey` is a surface that doesn't know who is asking. A `null`
 * `requester_pubkey` is a job that carried no signed-request auth, and so is
 * attributable to no identity — such a DVM cannot hold credit for a caller
 * either, which is the same fact seen from the other side.
 */
function completedReceiptsFor(
  receipts: StoredReceipt[],
  endpoint: string,
  signingPubkey: string | undefined,
  identity?: AttestedDvmIdentity
): StoredReceipt[] {
  const key = normalizeCreditEndpoint(endpoint);
  const requester = signingPubkey?.trim().toLowerCase();
  if (!requester) return [];
  const mine = (entry: StoredReceipt): boolean =>
    entry.receipt.requester_pubkey?.trim().toLowerCase() === requester &&
    entry.receipt.outcome === "completed";

  const here: StoredReceipt[] = [];
  let anchor = identity;
  for (const entry of receipts) {
    if (normalizeCreditEndpoint(entry.endpoint) !== key || !mine(entry)) continue;
    const verdict = verifyJobReceipt({ receipt: entry.receipt, builder: entry.builder });
    if (verdict.status !== "verified" && verdict.status !== "verified_unattested") continue;
    // A URL can change owners; live identity outranks same-origin history.
    if (identity !== undefined) {
      const attested =
        verdict.checks.attestation === "ok" ? attestedDvmIdentity(entry.builder) : undefined;
      if (attested?.dvmId !== identity.dvmId || attested.builderPubkey !== identity.builderPubkey) {
        continue;
      }
    }
    here.push(entry);
    // The offline anchor: with no live `/v1/info` in hand, the identity this
    // origin's own attested receipts prove is as good a statement of who
    // answers here, and forging it needs the real builder's key.
    if (anchor === undefined && verdict.checks.attestation === "ok") {
      anchor = attestedDvmIdentity(entry.builder);
    }
  }
  if (!anchor) return here;

  const elsewhere = receipts.filter((entry) => {
    if (normalizeCreditEndpoint(entry.endpoint) === key || !mine(entry)) return false;
    // Cheap string gate before the signature work: only receipts naming this
    // DVM are worth verifying, so pooling costs nothing at an unrelated DVM.
    if (entry.receipt.dvm_id !== anchor.dvmId) return false;
    const verdict = verifyJobReceipt({ receipt: entry.receipt, builder: entry.builder });
    if (verdict.checks.attestation !== "ok") return false;
    const attested = attestedDvmIdentity(entry.builder);
    return attested?.dvmId === anchor.dvmId && attested.builderPubkey === anchor.builderPubkey;
  });
  return [...here, ...elsewhere];
}

function targetJobsFor(
  config: CreditConfig | undefined,
  endpoint: string,
  identity?: AttestedDvmIdentity
): number | undefined {
  // Smallest wins, on the same most-restrictive rule the posture merges by:
  // a target sizes a purchase, so the lower figure is the cautious reading.
  const targets = perDvmEntriesFor(config, endpoint, identity)
    .map(([, per]) => per.targetJobs)
    .filter((jobs): jobs is number => typeof jobs === "number" && Number.isFinite(jobs));
  if (targets.length > 0) return Math.min(...targets);
  return config?.targetJobs;
}

function lookupOverride(
  overrides: Record<string, string> | undefined,
  builderPubkey: string
): string | undefined {
  if (!overrides) return undefined;
  const key = builderPubkey.trim().toLowerCase();
  for (const [pubkey, cap] of Object.entries(overrides)) {
    if (pubkey.trim().toLowerCase() === key) return cap;
  }
  return undefined;
}

/** Parse a `"$0.50"`-style config cap into micro-units; undefined on absence or junk. */
function parseCapMicro(cap: string | undefined): number | undefined {
  if (!cap) return undefined;
  const match = /^\$?(\d+(?:\.\d{1,6})?)$/.exec(cap.trim());
  if (!match) return undefined;
  const micro = Math.round(Number(match[1]) * 1_000_000);
  return micro > 0 ? micro : undefined;
}
