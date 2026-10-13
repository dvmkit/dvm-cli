/**
 * Credit funding headroom — what this caller *may* load at one DVM, and why
 * *
 * The trust ladder in `credit-policy.ts` bounds the amounts the auto-path
 * chooses for itself; an explicit `dvm credit fund --amount` is never hard-
 * capped below the builder's menu and the local budget. That freedom is
 * deliberate — but it was invisible: nothing told an agent what the current
 * rung permits, what the next one costs, or where the machine's own bounds sit.
 * An agent can't exercise sizing judgment it can't see the bounds of.
 *
 * This module computes that block once and renders it two ways: structured
 * snake_case fields to branch on, and a `display` sentence to relay verbatim.
 * It is pure — no network, no store reads — so a caller can attach it to a
 * refusal without a round trip.
 */

import {
  attestedDvmIdentity,
  type AttestedDvmIdentity,
  type CreditFundRail,
  type CreditMenu,
  DvmError,
  formatUsd,
  isCreditFundRail,
  normalizeCreditEndpoint,
  type StoredReceipt,
} from "@dvmkit/sdk/internal";
import {
  type CreditConfig,
} from "./identity";
import {
  effectiveFundingRail,
  tierCapOverrides,
  type TrustLadder,
  trustLadderFor,
  trustOverrideCapMicro,
} from "./credit-policy";
import { pickCreditFundRail } from "./credit-fund";

import type { CreditRefillUnavailable } from "./credit-notice";

export interface RailMinimum {
  rail: string;
  minMicro: number;
}

export type CreditRouteCompatibilityStatus =
  | "compatible"
  | "blocked_by_rail_minimum"
  | "blocked_by_trust_cap"
  | "unavailable_locally";

export type CreditRouteAvailabilitySource =
  | "cashu_balance"
  | "lightning_float"
  | "x402_wallet"
  | "tempo_wallet";

/** Caller-side availability for one rail; absent `available` means it is not known here. */
export interface CreditRouteAvailability {
  rail: CreditFundRail;
  available?: boolean;
  source?: CreditRouteAvailabilitySource;
  /** A connected float can refill the ecash pocket without another human funding step. */
  replenishableFromFloat?: boolean;
}

export interface CreditRouteCompatibility {
  rail: CreditFundRail;
  status: CreditRouteCompatibilityStatus;
  minMicro: number;
  availableLocally?: boolean;
  availabilitySource?: CreditRouteAvailabilitySource;
  replenishableFromFloat?: boolean;
}

export interface CreditHeadroom {
  endpoint: string;
  ladder: TrustLadder;
  /**
   * The cap actually in force: the tier's, raised by a config pre-grant, and
   * floored at the builder's `min` (a machine whose minimum exceeds the tier
   * cap stays fundable — the floor binds last, exactly as `sizeCreditMicro`
   * has it). Undefined when nothing local knows the figure.
   */
  effectiveCapMicro?: number;
  capSource: "tier" | "pre-grant" | "unknown";
  builderPubkey?: string;
  /** Balance already held here, when known — what the cap is measured against. */
  balanceMicro?: number;
  /**
   * What one more funding may add without naming `--over-trust`: the cap less
   * the balance already held, clamped by the builder's residual ceiling.
   * Undefined when the cap isn't known; zero means the cap is already reached.
   */
  fundableNowMicro?: number;
  menuMinMicro?: number;
  menuMaxMicro?: number;
  railMinimums: RailMinimum[];
  /** Amount the route diagnosis evaluates: an explicit request, else current fundable headroom. */
  routeAmountMicro?: number;
  routeCompatibility: CreditRouteCompatibility[];
  /** Amount-compatible automatic route, only when caller-side availability is known. */
  effectiveRoute?: CreditFundRail;
  /** Immutable rail of the existing server-side credit, when this is a refill diagnosis. */
  boundRail?: CreditFundRail;
  effectiveRouteSource?: CreditRouteAvailabilitySource;
  /** False only when the effective route is known and requires no new human funding action. */
  humanFundingRequired?: boolean;
  /** Why the held credit cannot currently refill, when locally provable. */
  refillUnavailable?: CreditRefillUnavailable;
}

/**
 * Derive the headroom block. Every input is optional except the endpoint and
 * the receipts, because the offline surfaces (`dvm credit list`) only have
 * whatever menu snapshot the store happens to hold — an absent menu degrades
 * to "bounds unknown", never to an invented figure.
 */
export function computeHeadroom(args: {
  endpoint: string;
  receipts: StoredReceipt[];
  /**
   * The signing identity these bounds are for. Required rather than
   * optional so every surface states whose trust it is rendering; `undefined`
   * is a real answer and reads as tier 0. See {@link trustLadderFor}.
   */
  signingPubkey: string | undefined;
  /**
   * This DVM's attested identity off `/v1/info`, when the surface has one
   * Pools the trust ladder and resolves the rail pin across every
   * hostname the caller has reached this DVM at.
   */
  identity?: AttestedDvmIdentity;
  menu?: CreditMenu;
  config?: CreditConfig;
  builderPubkey?: string;
  balanceMicro?: number;
  refillUnavailable?: CreditRefillUnavailable;
  routeAmountMicro?: number;
  routeAvailability?: CreditRouteAvailability[];
  /** Immutable server-side rail binding of the existing credit, when one exists. */
  boundRail?: string;
}): CreditHeadroom {
  const menu = args.menu;
  const ladder = trustLadderFor({
    receipts: args.receipts,
    endpoint: args.endpoint,
    signingPubkey: args.signingPubkey,
    ...(args.identity ? { identity: args.identity } : {}),
    ...(menu ? { menu } : {}),
    ...tierCapOverrides(args.config),
  });

  const granted = trustOverrideCapMicro({
    ...(args.config ? { config: args.config } : {}),
    ...(args.builderPubkey ? { builderPubkey: args.builderPubkey } : {}),
    ...(menu ? { menu } : {}),
  });
  const base = granted ?? ladder.capMicro;
  const effectiveCapMicro = base === undefined ? undefined : Math.max(base, menu?.min_micro ?? 0);
  const fundableNowMicro = fundableNow(effectiveCapMicro, args.balanceMicro, menu);
  const routeAmountMicro = args.routeAmountMicro ?? fundableNowMicro;
  const routeCompatibility = compatibilityFor({
    menu,
    routeAmountMicro,
    fundableNowMicro,
    availability: args.routeAvailability,
  });
  const pin = effectiveFundingRail(args.config, args.endpoint, args.identity);
  const boundRail = isCreditFundRail(args.boundRail) ? args.boundRail : undefined;
  const effective = effectiveRoute(
    routeCompatibility,
    menu,
    routeAmountMicro,
    boundRail ?? (pin.source === "default" ? undefined : pin.rail)
  );

  return {
    endpoint: args.endpoint,
    ladder,
    ...(effectiveCapMicro !== undefined ? { effectiveCapMicro } : {}),
    capSource: granted !== undefined ? "pre-grant" : base === undefined ? "unknown" : "tier",
    ...(args.builderPubkey ? { builderPubkey: args.builderPubkey } : {}),
    ...(args.balanceMicro !== undefined ? { balanceMicro: args.balanceMicro } : {}),
    ...(fundableNowMicro !== undefined ? { fundableNowMicro } : {}),
    ...(menu ? { menuMinMicro: menu.min_micro, menuMaxMicro: menu.max_micro } : {}),
    railMinimums: railMinimums(menu),
    ...(routeAmountMicro !== undefined ? { routeAmountMicro } : {}),
    routeCompatibility,
    ...(boundRail ? { boundRail } : {}),
    ...(effective
      ? {
          effectiveRoute: effective.rail,
          ...(effective.availabilitySource
            ? { effectiveRouteSource: effective.availabilitySource }
            : {}),
          humanFundingRequired: false,
        }
      : availabilityResolved(routeCompatibility)
        ? { humanFundingRequired: true }
        : {}),
    ...(args.refillUnavailable ? { refillUnavailable: args.refillUnavailable } : {}),
  };
}

/**
 * The wire shape: snake_case fields plus the relay-able sentence.
 *
 * `null` means "this caller doesn't know the figure". An unbounded pre-grant is
 * *not* that — it's a figure the caller deliberately declined to set — but it is
 * `Infinity` internally, which `JSON.stringify` also emits as `null`. So
 * `cap_unbounded` is always present and carries the distinction: `true` means
 * nothing local bounds a funding here, and the `null` caps are unbounded rather
 * than unknown.
 */
export function headroomJson(h: CreditHeadroom): Record<string, unknown> {
  return {
    tier: h.ladder.tier,
    tier_cap_micro: h.ladder.capMicro ?? null,
    effective_cap_micro: finiteOrNull(h.effectiveCapMicro),
    cap_unbounded: h.effectiveCapMicro !== undefined && !Number.isFinite(h.effectiveCapMicro),
    cap_source: h.capSource,
    receipts_held: h.ladder.receipts,
    receipts_span_ms: h.ladder.spanMs,
    ...(h.ladder.next
      ? {
          next_tier: h.ladder.next.tier,
          next_cap_micro: h.ladder.next.capMicro ?? null,
          receipts_for_next_tier: h.ladder.next.receiptsNeeded,
          ...(h.ladder.next.spanMs !== undefined
            ? { next_span_days: h.ladder.next.spanMs / DAY_MS }
            : {}),
        }
      : {}),
    ...(h.builderPubkey ? { builder_pubkey: h.builderPubkey } : {}),
    ...(h.balanceMicro !== undefined ? { balance_micro: h.balanceMicro } : {}),
    ...(h.fundableNowMicro !== undefined
      ? { fundable_now_micro: finiteOrNull(h.fundableNowMicro) }
      : {}),
    menu_min_micro: h.menuMinMicro ?? null,
    menu_max_micro: h.menuMaxMicro ?? null,
    rail_minimums: h.railMinimums.map((r) => ({ rail: r.rail, min_micro: r.minMicro })),
    ...(h.routeAmountMicro !== undefined ? { route_amount_micro: h.routeAmountMicro } : {}),
    route_compatibility: h.routeCompatibility.map((route) => ({
      rail: route.rail,
      status: route.status,
      min_micro: route.minMicro,
      ...(route.availableLocally !== undefined
        ? { available_locally: route.availableLocally }
        : {}),
      ...(route.availabilitySource ? { availability_source: route.availabilitySource } : {}),
      ...(route.replenishableFromFloat ? { replenishable_from_float: true } : {}),
    })),
    effective_route: h.effectiveRoute ?? null,
    effective_route_source: h.effectiveRouteSource ?? null,
    bound_rail: h.boundRail ?? null,
    ...(h.humanFundingRequired !== undefined
      ? { human_funding_required: h.humanFundingRequired }
      : {}),
    ...(h.refillUnavailable ? { refill: h.refillUnavailable } : {}),
    display: headroomDisplay(h),
  };
}

/**
 * The headroom as prose an intermediary agent can hand to its human verbatim,
 * and orient by itself: what's fundable now, what the next rung is worth, and
 * where the machine's own bounds sit.
 */
export function headroomDisplay(h: CreditHeadroom): string {
  const parts: string[] = [];

  if (h.effectiveCapMicro === undefined) {
    parts.push(
      `Funding bounds at ${h.endpoint} aren't known locally yet — this DVM hasn't advertised its credit menu to this agent.`
    );
  } else if (h.capSource === "pre-grant") {
    parts.push(
      `You can fund up to ${usd(h.effectiveCapMicro)} at ${h.endpoint} — every DVM signed by this builder is pre-granted in the caller's config, so the trust ladder doesn't bound it.`
    );
  } else {
    parts.push(
      `You can fund up to ${usd(h.effectiveCapMicro)} at ${h.endpoint} now (trust tier ${String(h.ladder.tier)}, ${countPhrase(h.ladder.receipts, "completed job")} here).`
    );
  }

  const next = h.ladder.next;
  if (next && h.capSource !== "pre-grant") {
    const cap = next.capMicro !== undefined ? usd(next.capMicro) : "the builder's own maximum";
    const receipts =
      next.receiptsNeeded > 0
        ? `${String(next.receiptsNeeded)} more completed job${next.receiptsNeeded === 1 ? "" : "s"}`
        : undefined;
    const span =
      next.spanMs !== undefined && h.ladder.spanMs < next.spanMs
        ? `${String(Math.round(next.spanMs / DAY_MS))} days of history`
        : undefined;
    const needs = [receipts, span].filter(Boolean).join(" and ");
    parts.push(needs ? `${cap} once you have ${needs}.` : `${cap} is the next rung.`);
  }

  if (h.menuMinMicro !== undefined && h.menuMaxMicro !== undefined) {
    parts.push(`This DVM accepts ${usd(h.menuMinMicro)}–${usd(h.menuMaxMicro)} of credit.`);
  }
  for (const rail of h.railMinimums) {
    parts.push(`Funding over ${rail.rail} needs at least ${usd(rail.minMicro)}.`);
  }
  parts.push(...routeDisplay(h));
  if (h.refillUnavailable) {
    parts.push(`${h.refillUnavailable.display} ${h.refillUnavailable.hint}`);
  }

  return parts.join(" ");
}

/**
 * Attach the headroom to a refusal so the agent reading it learns the bound in
 * the same breath as the refusal — the whole point of the block is that it
 * reaches the decision point, not a separate command the agent must know to run.
 */
export function withHeadroom(err: DvmError, h: CreditHeadroom): DvmError {
  return new DvmError(
    err.code,
    err.message,
    err.hint,
    {
      ...(err.data ?? {}),
      headroom: headroomJson(h),
    },
    err.display,
    err.proseSources
  );
}

/**
 * The builder pubkey this caller has seen at one endpoint, off the receipts it
 * already holds — the offline way to match a `trustOverrides` pre-grant when
 * there is no live `/v1/info` in hand.
 *
 * Endpoint-scoped and *not* identity-scoped, unlike the ladder: a builder key
 * is a property of the machine, so any receipt from there attests it equally
 * well, whichever of this caller's identities collected it.
 *
 * Deliberately left origin-scoped by , which pooled the ladder across
 * a DVM's hostnames. This reads `builder.pubkey` straight off the stored
 * envelope with no verification at all, and what it selects is a
 * `trustOverrides` pre-grant whose cap can be the builder's own maximum — so
 * letting receipts collected at one origin choose the builder key used at
 * another would be a cap-inflation primitive, not a keying fix. The ladder
 * pools instead, and only across receipts that chain to one attested key.
 */
export function builderPubkeyFor(receipts: StoredReceipt[], endpoint: string): string | undefined {
  const key = normalizeCreditEndpoint(endpoint);
  for (let i = receipts.length - 1; i >= 0; i--) {
    const entry = receipts[i];
    if (normalizeCreditEndpoint(entry.endpoint) !== key) continue;
    if (entry.builder?.pubkey) return entry.builder.pubkey;
  }
  return undefined;
}

/**
 * The attested identity this caller has evidence of at one endpoint, off the
 * receipts it already holds — the offline stand-in for a live `/v1/info`
 * *
 * Every candidate goes through {@link attestedDvmIdentity}, so what comes back
 * is a `(dvm_id, builder pubkey)` pair whose attestation verified, not a pair
 * copied out of an unsigned envelope. Origin-scoped, and it has to be: the
 * whole point is to learn what *this* hostname attested, and reading another
 * one's claim would be the pooling decision rather than its input.
 */
export function attestedIdentityFor(
  receipts: StoredReceipt[],
  endpoint: string
): AttestedDvmIdentity | undefined {
  const key = normalizeCreditEndpoint(endpoint);
  for (let i = receipts.length - 1; i >= 0; i--) {
    const entry = receipts[i];
    if (normalizeCreditEndpoint(entry.endpoint) !== key) continue;
    const identity = attestedDvmIdentity(entry.builder);
    if (identity) return identity;
  }
  return undefined;
}


const DAY_MS = 24 * 60 * 60 * 1000;

/** `Infinity` is a figure, not an absence — but it serializes as `null`, so pair it with `cap_unbounded`. */
function finiteOrNull(micro: number | undefined): number | null {
  return micro !== undefined && Number.isFinite(micro) ? micro : null;
}

function usd(micro: number): string {
  return Number.isFinite(micro) ? `$${formatUsd(micro / 1_000_000)}` : "any amount";
}

function countPhrase(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * What one more funding may add: the cap less what's already held, then held
 * under the builder's residual ceiling — a credit may not carry more than
 * `max_micro` regardless of how much trust the caller has earned.
 */
function fundableNow(
  capMicro: number | undefined,
  balanceMicro: number | undefined,
  menu: CreditMenu | undefined
): number | undefined {
  if (capMicro === undefined) return undefined;
  const held = Math.max(balanceMicro ?? 0, 0);
  let room = capMicro - held;
  if (menu) room = Math.min(room, menu.max_micro - held);
  return Math.max(room, 0);
}

function railMinimums(menu: CreditMenu | undefined): RailMinimum[] {
  if (!menu?.lightning_min_micro) return [];
  return [{ rail: "lightning", minMicro: menu.lightning_min_micro }];
}

function compatibilityFor(args: {
  menu: CreditMenu | undefined;
  routeAmountMicro: number | undefined;
  fundableNowMicro: number | undefined;
  availability: CreditRouteAvailability[] | undefined;
}): CreditRouteCompatibility[] {
  if (!args.menu || args.routeAmountMicro === undefined) return [];
  const menu = args.menu;
  const routeAmountMicro = args.routeAmountMicro;
  const availability = new Map(args.availability?.map((entry) => [entry.rail, entry]));
  return menu.funding.filter(isCreditFundRail).map((rail) => {
    const minimum =
      rail === "lightning" && menu.lightning_min_micro !== undefined
        ? Math.max(menu.min_micro, menu.lightning_min_micro)
        : menu.min_micro;
    const local = availability.get(rail);
    let status: CreditRouteCompatibilityStatus;
    if (
      args.fundableNowMicro !== undefined &&
      (routeAmountMicro > args.fundableNowMicro || minimum > args.fundableNowMicro)
    ) {
      status = "blocked_by_trust_cap";
    } else if (routeAmountMicro < minimum) {
      status = "blocked_by_rail_minimum";
    } else if (local?.available === false) {
      status = "unavailable_locally";
    } else {
      status = "compatible";
    }
    return {
      rail,
      status,
      minMicro: minimum,
      ...(local?.available !== undefined ? { availableLocally: local.available } : {}),
      ...(local?.source ? { availabilitySource: local.source } : {}),
      ...(local?.replenishableFromFloat ? { replenishableFromFloat: true } : {}),
    };
  });
}

function effectiveRoute(
  routes: CreditRouteCompatibility[],
  menu: CreditMenu | undefined,
  amountMicro: number | undefined,
  forced: CreditFundRail | undefined
): CreditRouteCompatibility | undefined {
  const available = routes.filter(
    (route) => route.status === "compatible" && route.availableLocally === true
  );
  if (amountMicro === undefined) return undefined;
  const pick = pickCreditFundRail({
    rails: available.map((route) => route.rail),
    amountMicro,
    ...(menu ? { menu } : {}),
    ...(forced ? { forced } : {}),
  });
  return available.find((route) => route.rail === pick.order[0]);
}

function availabilityResolved(routes: CreditRouteCompatibility[]): boolean {
  return routes.length > 0 && routes.every((route) => route.availableLocally !== undefined);
}

function routeDisplay(h: CreditHeadroom): string[] {
  if (h.routeCompatibility.length === 0) return [];
  const lightning = h.routeCompatibility.find((route) => route.rail === "lightning");
  const effective = h.routeCompatibility.find((route) => route.rail === h.effectiveRoute);
  const boundAlternate = h.boundRail
    ? h.routeCompatibility.find(
        (route) =>
          route.rail !== h.boundRail &&
          route.status === "compatible" &&
          route.availableLocally === true
      )
    : undefined;
  const out: string[] = [];

  if (lightning?.status === "blocked_by_trust_cap") {
    out.push(
      `Direct Lightning begins at ${usd(lightning.minMicro)}, above the ${h.fundableNowMicro !== undefined ? usd(h.fundableNowMicro) : "current"} trust headroom. No limit is being broken; that route opens after the caller earns or explicitly grants more trust.`
    );
  } else if (lightning?.status === "blocked_by_rail_minimum") {
    out.push(
      `This ${h.routeAmountMicro !== undefined ? usd(h.routeAmountMicro) : "funding"} funding is below Lightning's ${usd(lightning.minMicro)} floor.`
    );
  }

  if (effective?.rail === "cashu") {
    const amountLabel =
      lightning && h.routeAmountMicro !== undefined && h.routeAmountMicro < lightning.minMicro
        ? "this small funding"
        : "this funding";
    const refill = effective.replenishableFromFloat
      ? " The connected Lightning wallet can refill that pocket automatically, so no second human funding step is required."
      : "";
    out.push(`Ecash is the amount-compatible automatic route for ${amountLabel}.${refill}`);
  } else if (effective?.rail === "lightning") {
    out.push("The connected Lightning wallet is the compatible automatic route for this amount.");
  } else if (effective) {
    out.push(`${effective.rail} is the compatible automatic route for this amount.`);
  } else if (h.boundRail && boundAlternate) {
    out.push(
      `This credit is bound to ${h.boundRail}. ${boundAlternate.rail} is amount-compatible and locally available, but the server would reject a cross-rail top-up.`
    );
  } else if (h.humanFundingRequired === true) {
    out.push(
      "No automatic funding route is available locally: the ecash pocket cannot cover this amount and no connected funding wallet can replenish or carry it."
    );
  }
  return out;
}
