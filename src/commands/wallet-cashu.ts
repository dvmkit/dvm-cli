import { RECOMMENDED_MINTS } from "../lib/mints";
import {
  assertNutSupport,
  checkMintHealth,
  DEFAULT_AGENT_MINT_URL,
  DvmError,
  effectiveFundingMint,
  getBalanceByMint,
  getWallet,
  loadAgentWallet,
  type MintAmountBounds,
  saveAgentWallet,
  withWalletLock,
} from "@dvmkit/sdk/internal";
import {
  info,
  json,
} from "../lib/output";
import { loadConfiguredMints, type MintSource } from "../lib/wallet-agent/mint-inventory";

import { getMintReliability, type MintReliabilityRow } from "../lib/caller-platform-client";
import { getPlatformUrl } from "../lib/platform";

export const ADD_CASHU_MINT_HINT = "Add one with: dvm wallet mint-add <url>";

export interface WalletMintAddOptions {
  human?: boolean;
}

export interface WalletMintListOptions {
  human?: boolean;
}

export interface WalletMintHealthOptions {
  human?: boolean;
  /** Check one mint URL instead of every configured mint. */
  mint?: string;
}

export async function walletMintAdd(url: string, opts: WalletMintAddOptions): Promise<void> {
  const health = await checkMintHealth(url, { retries: 1, backoffMs: [0] });
  if (!health.ok) {
    throw new DvmError(
      "cashu_mint_unreachable",
      `Cannot connect to mint: ${url}`,
      "The mint is not responding. Try again later."
    );
  }
  assertNutSupport(url, health.nutsRaw ?? {});
  // Load the cashu-ts Wallet to run the keyset-collision guard.
  await getWallet(url);

  // Pick up any legacy `config.cashuMints` entries before we mutate
  // `wallet.mints` so the legacy list is migrated, not clobbered.
  await loadConfiguredMints();

  const alreadyConfigured = await withWalletLock(() => {
    const wallet = loadAgentWallet();
    if (!wallet) {
      throw new DvmError(
        "wallet_missing",
        "No agent wallet found.",
        "Run `dvm wallet init` first to generate a lock keypair."
      );
    }
    if (wallet.mints.includes(url)) return true;
    saveAgentWallet({ ...wallet, mints: [...wallet.mints, url] });
    return false;
  });

  if (alreadyConfigured) {
    const display = `Mint already configured: ${url}`;
    if (opts.human) {
      info(display);
    } else {
      json({ status: "already_configured", mint: url, display });
    }
    return;
  }

  if (opts.human) {
    info(`Mint added: ${url}`);
    info(
      "\nNote: Cashu mints are custodial — the mint operator holds your funds. " +
        "Only deposit what you're willing to lose."
    );
  } else {
    json({
      status: "added",
      mint: url,
      hint: "Cashu mints are custodial. Only deposit what you're willing to lose.",
    });
  }
}

/**
 * List the wallet's configured mints with their balances and a **live**
 * reachability read.
 *
 * The probe is one `/v1/info` per mint, run in parallel, and its answer is
 * thrown away when the command exits: a mint that didn't answer is skipped by
 * the next payment and picked back up the moment it does, with nothing written
 * to `wallet.json` and no config to edit either way. `checked_at` is on every
 * row so the reading is unambiguously "now", not "known to be down".
 */
export async function walletMintList(opts: WalletMintListOptions): Promise<void> {
  const mints = await loadConfiguredMints();
  const byMint = getBalanceByMint();
  const funding = effectiveFundingMint(mints);

  const checkedAt = new Date().toISOString();
  const probes = await Promise.all(
    mints.map((url) => checkMintHealth(url, { retries: 1, backoffMs: [0] }))
  );
  const mintData = mints.map((url, i) => ({
    url,
    source: "configured" as const,
    balanceMsats: byMint.get(url) ?? 0,
    reachable: probes[i].ok,
    // Null when the mint couldn't be reached to ask. `false` is the melt-only
    // recovery posture — reachable, well-formed, and unable to serve the swap
    // every per-call payment needs.
    swap_enabled: probes[i].ok ? (probes[i].swapEnabled ?? null) : null,
    checked_at: checkedAt,
  }));

  if (opts.human) {
    if (mints.length === 0) {
      info("No mints configured.");
      info(ADD_CASHU_MINT_HINT);
      info(`\nFund flow falls back to (built-in): ${DEFAULT_AGENT_MINT_URL}`);
      info("\nRecommended mints:");
      for (const m of RECOMMENDED_MINTS) {
        info(`  ${m.name} — ${m.description}`);
        info(`    ${m.url}`);
      }
    } else {
      for (const m of mintData) {
        const tag = m.url === funding.url ? "  [funding default — `dvm wallet fund` target]" : "";
        const state = !m.reachable
          ? "  [not answering right now]"
          : m.swap_enabled === false
            ? "  [not serving swaps right now]"
            : "";
        info(`${m.url}: ${Math.round(m.balanceMsats / 1000)} sats${state}${tag}`);
      }
      if (mintData.some((m) => !m.reachable || m.swap_enabled === false)) {
        info("");
        info(
          "Live reading, not a verdict: payments route to another configured mint meanwhile, and this one is used again as soon as it answers."
        );
      }
    }
  } else {
    json({
      mints: mintData,
      mints_checked_at: checkedAt,
      // `funding_mint` is what a no-`--mint` `dvm wallet fund` call targets now
      // (first configured mint, or the built-in fallback when none); distinct
      // from `fallback_mint`, the static built-in constant.
      funding_mint: funding.url,
      funding_mint_source: funding.source,
      fallback_mint: DEFAULT_AGENT_MINT_URL,
      recommended: mints.length === 0 ? RECOMMENDED_MINTS : undefined,
      hint: mintData.some((m) => !m.reachable || m.swap_enabled === false)
        ? "One or more mints aren't usable for payments right now. Payments route to another configured mint meanwhile, and this reading is re-taken on every call — nothing is remembered about a mint between calls."
        : undefined,
    });
  }
}

/**
 * Probe the live health of configured Cashu mints (or one via `--mint`) before
 * funding. Each mint's `/v1/info` is hit directly; a mint outage at funding
 * time is worse than at pay time, so this lets an agent avoid funding an
 * unhealthy mint and a human decide which to top up.
 *
 * The live probe is merged with the platform's `cashu-mint-health-cron`
 * history: when `GET /api/v1/mint-health` is reachable, each mint it
 * tracks gets a real `recent_failures_7d` count and a server-side
 * `last_check_at`. When the platform is unreachable, or for mints it doesn't
 * track, `recent_failures_7d` stays `null` and `last_check_at` falls back to
 * the local probe time — live-probe-only, exactly as before.
 */
export async function walletMintHealth(opts: WalletMintHealthOptions): Promise<void> {
  const configured = await loadConfiguredMints();
  const targets = opts.mint ? [opts.mint] : configured;
  const funding = effectiveFundingMint(configured);

  if (targets.length === 0) {
    if (opts.human) {
      info("No mints configured.");
      info(ADD_CASHU_MINT_HINT);
      info(`\nFund flow falls back to (built-in): ${DEFAULT_AGENT_MINT_URL}`);
    } else {
      json({
        mints: [],
        funding_mint: funding.url,
        funding_mint_source: funding.source,
        fallback_mint: DEFAULT_AGENT_MINT_URL,
        display: "No mints configured.",
        hint: ADD_CASHU_MINT_HINT,
      });
    }
    return;
  }

  const configuredSet = new Set(configured);
  const checkedAt = new Date().toISOString();
  const [results, reliability] = await Promise.all([
    Promise.all(targets.map((url) => checkMintHealth(url))),
    fetchReliability(),
  ]);
  const mints = results.map((health) =>
    summarizeMintHealth(
      health,
      checkedAt,
      configuredSet.has(health.mintUrl) ? "configured" : "ad_hoc",
      reliability.get(normalizeMintUrl(health.mintUrl))
    )
  );

  const unhealthy = mints.filter((m) => m.liveness !== "ok");
  const okCount = mints.length - unhealthy.length;

  if (opts.human) {
    const rows = mints.map((m) => ({
      url: m.url,
      status: m.liveness.toUpperCase(),
      latency: m.liveness === "down" ? "—" : `${m.latency_ms}ms`,
    }));
    const urlWidth = Math.max(4, ...rows.map((r) => r.url.length));
    const statusWidth = Math.max(8, ...rows.map((r) => r.status.length));
    info(`${"MINT".padEnd(urlWidth)}  ${"STATUS".padEnd(statusWidth)}  LATENCY`);
    for (const r of rows) {
      info(`${r.url.padEnd(urlWidth)}  ${r.status.padEnd(statusWidth)}  ${r.latency}`);
    }
    if (unhealthy.length > 0) {
      info("");
      for (const m of unhealthy) {
        info(`! ${m.display}`);
      }
    }
    const bounded = mints.filter(
      (m) =>
        (m.mint_amount_bounds !== null && hasBound(m.mint_amount_bounds)) ||
        (m.melt_amount_bounds !== null && hasBound(m.melt_amount_bounds))
    );
    if (bounded.length > 0) {
      info("");
      info("Per-call amount limits (advertised by the mint):");
      for (const m of bounded) {
        info(
          `  ${m.url}  fund ${describeBounds(m.mint_amount_bounds ?? { min_sats: null, max_sats: null })} · cash-out ${describeBounds(m.melt_amount_bounds ?? { min_sats: null, max_sats: null })}`
        );
      }
    }
  } else {
    json({
      mints,
      funding_mint: funding.url,
      funding_mint_source: funding.source,
      fallback_mint: DEFAULT_AGENT_MINT_URL,
      display: `${okCount} of ${mints.length} mint(s) healthy.`,
      hint:
        unhealthy.length > 0
          ? `Avoid funding: ${unhealthy.map((m) => m.url).join(", ")}.`
          : undefined,
    });
  }
}

type MintLiveness = "ok" | "degraded" | "down";

interface MintHealthRow {
  url: string;
  /**
   * Why this URL was probed. `configured` for any mint in
   * `wallet.mints`; `ad_hoc` for a `--mint <url>` target that isn't.
   * Shares the {@link MintSource} vocabulary with `wallet show` / `mint-list`
   * so agents see one taxonomy across inventory views; the other variants
   * (`default`/`proofs`/`pending`) are never set here because `mint-health`
   * only probes URLs the caller explicitly asks for.
   */
  source: MintSource;
  liveness: MintLiveness;
  last_check_at: string;
  /**
   * Count of platform-observed `/v1/info` liveness failures in the trailing 7
   * days. A number when the platform's mint-health rollup is reachable
   * and tracks this mint; `null` when the platform is unreachable or the mint
   * isn't tracked (live-probe-only fallback).
   */
  recent_failures_7d: number | null;
  latency_ms: number;
  recommended: boolean;
  /**
   * Whether the mint is currently issuing ecash — NUT-04 present and not
   * switched off. This is what a no-`--mint` `dvm wallet fund`
   * consults, so a `false` here is the reason a fund call would route around
   * this mint. `null` when the mint couldn't be reached to ask.
   */
  minting_enabled: boolean | null;
  /**
   * Whether the mint is currently paying out — NUT-05 present and not switched
   * off. A mint in recovery is commonly `minting_enabled: false` with this
   * `true`, which is precisely when `dvm wallet cash-out` still works.
   */
  melting_enabled: boolean | null;
  /**
   * Whether the mint is currently serving swaps — what every per-call payment
   * needs. A `false` is the reason a spend routes around this mint;
   * `null` when the mint couldn't be reached to ask.
   */
  swap_enabled: boolean | null;
  /**
   * Amount limits the mint advertises for a single fund, in sats (from
   * NUT-04 `min_amount`/`max_amount`). Either end is `null` when the mint
   * advertises nothing there, which means unbounded; the whole object is `null`
   * when the mint couldn't be reached to ask. A fund outside this range is
   * refused locally, and a no-`--mint` fund routes around a mint that can't
   * serve the amount asked for.
   */
  mint_amount_bounds: AmountBoundsRow | null;
  /** The NUT-05 twin — limits on a single `dvm wallet cash-out` leg at this mint. */
  melt_amount_bounds: AmountBoundsRow | null;
  version?: string;
  missing_required_nuts?: string[];
  error?: string;
  display: string;
}

/** One direction's advertised amount limits, in sats. `null` at either end means unbounded. */
interface AmountBoundsRow {
  min_sats: number | null;
  max_sats: number | null;
}

function toBoundsRow(bounds: MintAmountBounds | undefined): AmountBoundsRow {
  return { min_sats: bounds?.minSats ?? null, max_sats: bounds?.maxSats ?? null };
}

function hasBound(row: AmountBoundsRow): boolean {
  return row.min_sats !== null || row.max_sats !== null;
}

function describeBounds(row: AmountBoundsRow): string {
  const { min_sats: min, max_sats: max } = row;
  if (min !== null && max !== null) return `${fmtSats(min)}–${fmtSats(max)} sats`;
  if (max !== null) return `up to ${fmtSats(max)} sats`;
  if (min !== null) return `at least ${fmtSats(min)} sats`;
  return "no limit";
}

function fmtSats(n: number): string {
  return n.toLocaleString("en-US");
}

function normalizeMintUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Fetch the platform's mint reliability rollup, keyed by normalized URL. Any
 * failure (platform unreachable, non-2xx) degrades to an empty map so
 * `mint-health` falls back to live-probe-only without erroring.
 */
async function fetchReliability(): Promise<Map<string, MintReliabilityRow>> {
  try {
    const rows = await getMintReliability(getPlatformUrl());
    return new Map(rows.map((r) => [normalizeMintUrl(r.url), r]));
  } catch {
    return new Map();
  }
}

function summarizeMintHealth(
  health: Awaited<ReturnType<typeof checkMintHealth>>,
  checkedAt: string,
  source: MintSource,
  reliability: MintReliabilityRow | undefined
): MintHealthRow {
  const { mintUrl: url } = health;
  let liveness: MintLiveness;
  let display: string;

  if (!health.ok) {
    liveness = "down";
    display = `${url} is unreachable (${health.error?.code ?? "network"}) — do not fund right now.`;
  } else {
    const hasBolt11Sat = health.bolt11SatMintSupported && health.bolt11SatMeltSupported;
    const fullSupport = (health.missingRequiredNuts?.length ?? 0) === 0 && hasBolt11Sat;
    if (!fullSupport) {
      liveness = "degraded";
      display = `${url} is reachable but missing required capabilities (Lightning mint/melt) — not recommended for funding.`;
    } else if (health.swapEnabled === false) {
      // swaps are what a per-call payment runs on, so this is the
      // one capability gap that stops the wallet paying DVMs from here. Said
      // before the funding verdict because it's the more consequential half.
      liveness = "degraded";
      display = `${url} is not currently serving swaps (NUT-3 disabled) — payments route to another mint, and any balance here can still be moved out with \`dvm wallet cash-out\` while melting stays on.`;
    } else if (health.mintingEnabled === false) {
      // the mint advertises everything and has issuance switched off
      // — a recovery posture. Say which half still works, because the balance
      // already sitting there is recoverable and that is not obvious.
      liveness = "degraded";
      display =
        health.meltingEnabled === false
          ? `${url} has both minting and melting switched off — nothing can move in or out right now.`
          : `${url} is not currently issuing ecash (NUT-04 disabled) — funding routes elsewhere, but any balance here can still be moved out with \`dvm wallet cash-out\`.`;
    } else if (health.meltingEnabled === false) {
      liveness = "degraded";
      display = `${url} is issuing normally but has melting switched off (NUT-05 disabled) — \`dvm wallet cash-out\` won't work here until it returns.`;
    } else {
      liveness = "ok";
      display = `${url} is healthy — safe to fund.`;
    }
  }

  // a mint that caps what it will issue or pay out in one go is still
  // healthy — the limit isn't a fault, it's the shape of the mint. Say it on
  // every reachable row that advertises one, so an agent relaying this can size
  // a fund or a cash-out before it's refused.
  const mintBounds = health.ok ? toBoundsRow(health.mintAmountBounds) : null;
  const meltBounds = health.ok ? toBoundsRow(health.meltAmountBounds) : null;
  if (mintBounds && meltBounds && (hasBound(mintBounds) || hasBound(meltBounds))) {
    display += ` Per-call limits: fund ${describeBounds(mintBounds)}, cash-out ${describeBounds(meltBounds)}.`;
  }

  return {
    url,
    source,
    liveness,
    last_check_at: reliability?.last_check_at ?? checkedAt,
    recent_failures_7d: reliability ? reliability.recent_failures_7d : null,
    latency_ms: health.latencyMs,
    recommended: liveness === "ok",
    minting_enabled: health.ok ? (health.mintingEnabled ?? null) : null,
    melting_enabled: health.ok ? (health.meltingEnabled ?? null) : null,
    swap_enabled: health.ok ? (health.swapEnabled ?? null) : null,
    mint_amount_bounds: mintBounds,
    melt_amount_bounds: meltBounds,
    version: health.version,
    missing_required_nuts: health.missingRequiredNuts,
    error: health.error?.code,
    display,
  };
}
