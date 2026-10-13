/**
 * Select a Cashu mint for an agent-wallet fund operation. The selector is shared
 * by the interactive fund command
 * and the post-job pocket refill so both paths ask the same fresh question of
 * the configured mints before opening a Lightning quote.
 */

import {
  amountBoundsVerdict,
  checkMintHealth,
  type MintAmountBounds,
  type MintHealthCheckResult,
} from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";

/** Why the selector replaced the preferred funding mint. */
export type FundFallbackKind = "health" | "capability" | "bounds" | null;

export interface FundMintFallback {
  preferred: string;
  /** Configured mint selected for this amount. */
  selected: string;
  /** Machine-readable reason the preferred mint was passed over. */
  reason: string;
}

export interface FundMintSelection {
  url: string;
  /** Category of fallback, or `null` when the preferred mint was selected. */
  fallbackKind: FundFallbackKind;
  /** Fresh probe result for the preferred mint. */
  preferredProbe: MintHealthCheckResult;
  /** Present when an alternative replaced the preferred mint. */
  fallback?: FundMintFallback;
}

export interface ResolveFundMintOptions {
  /** Mint selected by the caller or wallet configuration. */
  preferred: string;
  /** Whether the caller explicitly named the preferred mint. */
  explicit: boolean;
  /** Mints to probe, in configured selection order. */
  configured: string[];
  /** Amount to issue, in sats. */
  sats: number;
}

/**
 * Probe and select a mint before a Lightning quote is opened. Explicit mint
 * choices stay authoritative when the mint is reachable; an unreachable
 * explicit choice remains an error rather than being silently replaced.
 *
 * Every probe is a single bounded `checkMintHealth` attempt with no backoff.
 * The result is deliberately side-effect-free so callers can choose their own
 * human or JSON narration; failures are represented by the same DvmErrors the
 * manual fund flow has always exposed.
 */
export async function resolveFundMint(args: ResolveFundMintOptions): Promise<FundMintSelection> {
  const { preferred, explicit, configured, sats } = args;
  const probe = await probeMintHealthOnce(preferred);
  if (explicit) {
    if (probe.ok) {
      return { url: preferred, fallbackKind: null, preferredProbe: probe };
    }
    const healthy = await findFundableAlternatives(configured, preferred, sats);
    const hint =
      healthy.length > 0
        ? `Pass --mint one of: ${healthy.join(", ")}, or drop --mint to auto-select a healthy mint.`
        : `No other wallet-configured mint can issue ${sats} sats right now — wait and retry, or add a new mint with \`dvm wallet mint-add\`.`;
    throw new DvmError(
      "mint_unhealthy",
      `Mint ${preferred} failed health probe (${probe.error?.code ?? "unknown"}: ${probe.error?.message ?? "—"}).`,
      hint
    );
  }

  if (canFund(probe, sats)) {
    return { url: preferred, fallbackKind: null, preferredProbe: probe };
  }
  const preferredReason = fundRefusalReason(probe, sats);
  /** Every mint passed over, and why — a refusal names limits and outages apart. */
  const passedOver: { mint: string; reason: string; bounds: MintAmountBounds }[] = [];
  const notePassedOver = (mint: string, candidate: MintHealthCheckResult): void => {
    passedOver.push({
      mint,
      reason: fundRefusalReason(candidate, sats),
      bounds: candidate.mintAmountBounds ?? { minSats: null, maxSats: null },
    });
  };
  notePassedOver(preferred, probe);

  for (const candidate of configured) {
    if (candidate === preferred) continue;
    const candidateProbe = await probeMintHealthOnce(candidate);
    if (canFund(candidateProbe, sats)) {
      const fallbackKind = fallbackKindFor(preferredReason);
      return {
        url: candidate,
        fallbackKind,
        preferredProbe: probe,
        fallback: { preferred, selected: candidate, reason: preferredReason },
      };
    }
    notePassedOver(candidate, candidateProbe);
  }

  // Keep amount-limit refusals distinct from unavailable mints: the caller's
  // next move is different, and a concurrent outage may recover later.
  const outOfRange = passedOver.filter((m) => isBoundsRefusal(m.reason));
  const unavailable = passedOver.filter((m) => !isBoundsRefusal(m.reason));
  if (outOfRange.length > 0) {
    const named = outOfRange
      .map((m) => `${m.mint} takes ${describeMintBounds(m.bounds)}`)
      .join("; ");
    const alsoDown =
      unavailable.length > 0
        ? ` ${unavailable.map((m) => `${m.mint} (${m.reason})`).join(", ")} couldn't be used at all right now.`
        : "";
    const retryNote =
      unavailable.length > 0
        ? " Retrying later may also help — at least one mint is currently unavailable rather than limited."
        : "";
    throw new DvmError(
      "mint_amount_out_of_range",
      `No configured mint will issue ${sats} sats in one go: ${named}.${alsoDown}`,
      `${suggestInRangeAmount(outOfRange, sats)}${retryNote} Or add a mint with different limits using \`dvm wallet mint-add\`. Nothing was charged and no Lightning invoice was created.`,
      {
        amount_sats: sats,
        mint_bounds: outOfRange.map((m) => ({
          mint: m.mint,
          min_sats: m.bounds.minSats,
          max_sats: m.bounds.maxSats,
        })),
        unavailable_mints: unavailable.map((m) => ({ mint: m.mint, reason: m.reason })),
      }
    );
  }

  throw new DvmError(
    "all_mints_unhealthy",
    `No wallet-configured mint can currently issue ecash (preferred: ${preferred}, ${preferredReason}).`,
    "Wait for at least one mint to recover, or add a new mint with `dvm wallet mint-add`. Existing balance is unaffected — `dvm wallet cash-out` still works against a mint that can only melt."
  );
}

export function describeMintBounds(bounds: MintAmountBounds | undefined): string {
  const min = bounds?.minSats ?? null;
  const max = bounds?.maxSats ?? null;
  if (min !== null && max !== null) return `${min}–${max} sats`;
  if (max !== null) return `up to ${max} sats`;
  if (min !== null) return `at least ${min} sats`;
  return "any amount";
}

/** Whether a probe refused only because this amount is outside its bounds. */
function isBoundsRefusal(reason: string): boolean {
  return reason === "amount_below_min" || reason === "amount_above_max";
}

function canFund(probe: MintHealthCheckResult, sats: number): boolean {
  return (
    probe.ok &&
    probe.mintingEnabled !== false &&
    amountBoundsVerdict(sats, probe.mintAmountBounds) === "ok"
  );
}

/** Why a mint was passed over when picking a funding default. */
function fundRefusalReason(probe: MintHealthCheckResult, sats: number): string {
  if (!probe.ok) return probe.error?.code ?? "unhealthy";
  if (probe.mintingEnabled === false) return "minting_disabled";
  const verdict = amountBoundsVerdict(sats, probe.mintAmountBounds);
  return verdict === "below_min"
    ? "amount_below_min"
    : verdict === "above_max"
      ? "amount_above_max"
      : "unhealthy";
}

function fallbackKindFor(reason: string): FundFallbackKind {
  if (reason === "minting_disabled") return "capability";
  if (isBoundsRefusal(reason)) return "bounds";
  return "health";
}

/** Suggest a concrete amount that fits the advertised bounds. */
function suggestInRangeAmount(
  outOfRange: { mint: string; bounds: MintAmountBounds }[],
  sats: number
): string {
  const maxima = outOfRange.map((m) => m.bounds.maxSats).filter((n): n is number => n !== null);
  const largestMax = maxima.length > 0 ? Math.max(...maxima) : null;
  if (largestMax !== null && sats > largestMax) {
    return `Fund ${largestMax} sats or less, then repeat for the rest.`;
  }
  const minima = outOfRange.map((m) => m.bounds.minSats).filter((n): n is number => n !== null);
  const smallestMin = minima.length > 0 ? Math.min(...minima) : null;
  if (smallestMin !== null && sats < smallestMin) {
    return `Fund at least ${smallestMin} sats.`;
  }
  return "Try a different amount.";
}

/** One-shot mint probe — single attempt, no backoff, so post-job work is bounded. */
async function probeMintHealthOnce(mintUrl: string): Promise<MintHealthCheckResult> {
  return checkMintHealth(mintUrl, { retries: 1, backoffMs: [0] });
}

async function findFundableAlternatives(
  configured: string[],
  skip: string,
  sats: number
): Promise<string[]> {
  const healthy: string[] = [];
  for (const mint of configured) {
    if (mint === skip) continue;
    const probe = await probeMintHealthOnce(mint);
    if (canFund(probe, sats)) healthy.push(mint);
  }
  return healthy;
}
