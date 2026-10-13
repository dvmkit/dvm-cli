/**
 * `dvm wallet reserve` and `dvm wallet release`.
 *
 * Reserve mints proofs P2PK-locked to a builder DVM with a NUT-11 locktime
 * + refund tag — the pre-fund-per-builder shape that makes cheap-tier
 * calls viable (~0.3–1 sat amortized vs ~1.3 sats for per-call swap).
 * Release reclaims unshipped reserve proofs after the locktime expires,
 * signing the NUT-11 refund path with the agent's per-DVM refund subkey
 * */

import {
  DvmError,
  effectiveMints,
  loadAgentWallet,
} from "@dvmkit/sdk/internal";
import {
  info,
  json,
} from "../lib/output";
import {
  DEFAULT_RESERVE_LOCKTIME_SECONDS,
  formatLocktime,
  parseLocktime,
} from "../lib/wallet-agent/locktime";
import { extractBuilderHandle } from "../lib/wallet-agent/builder-handle";
import { loadConfiguredMints } from "../lib/wallet-agent/mint-inventory";
import { releaseAgentReserve, type ReleaseMintOutcome } from "../lib/wallet-agent/release";
import { reserveAgentWallet } from "../lib/wallet-agent/reserve";
import { toString as qrToString } from "qrcode";

import { resolveEndpoint } from "../lib/favorites";
import { createDvmTransport } from "../lib/transport";
import {
  amountSourceFields,
  describeAmount,
  resolveFundingAmountSats,
} from "../lib/wallet-agent/amount";

export interface WalletReserveOptions {
  builder?: string;
  /** Locktime — `Nd`, `Nh`, `Nm`, `Ns`. Defaults to 30d. */
  locktime?: string;
  /** Override the mint URL (must be in the builder's allowlist). */
  mint?: string;
  /** Override the reserve timeout, in seconds. */
  timeout?: string;
  /** Treat the positional amount as sats even without a leading `$`. */
  sats?: boolean;
  human?: boolean;
}

export interface WalletReleaseOptions {
  builder?: string;
  /** Output policy. `locked` (default) re-locks outputs to the agent master pubkey; `unlocked` keeps them anyone-can-spend. */
  output?: string;
  human?: boolean;
}

/**
 * `dvm wallet reserve --builder <endpoint> <amount> [--locktime Nd]` —
 * mint NUT-11 P2PK-locked proofs reserved at a specific builder. Outputs
 * carry `locktime + refund` so the agent can reclaim unshipped portions
 * post-`t_expire` via {@link walletRelease}.
 */
export async function walletReserve(amount: string, opts: WalletReserveOptions): Promise<void> {
  if (!opts.builder) {
    throw new DvmError(
      "missing_builder",
      "`--builder <endpoint>` is required.",
      "Pass the builder DVM's endpoint, e.g. `dvm wallet reserve --builder https://scrape.dvmkit.ai $1 --locktime 30d` (or a `@alias` favorite)."
    );
  }
  const endpoint = resolveEndpoint(opts.builder);
  const builderHandle = extractBuilderHandle(endpoint);
  const locktimeSeconds = opts.locktime
    ? parseLocktime(opts.locktime)
    : DEFAULT_RESERVE_LOCKTIME_SECONDS;

  // Migrate any legacy `config.cashuMints` into `wallet.mints` so the
  // reserve mint pick honours the user's configured choice.
  await loadConfiguredMints();

  const wallet = loadAgentWallet();
  if (!wallet) {
    throw new DvmError("wallet_missing", "No agent wallet found.", "Run `dvm wallet init` first.");
  }

  const transport = createDvmTransport();
  let providerInfo;
  try {
    providerInfo = await transport.describe({ endpoint });
  } catch (err) {
    transport.close();
    throw new DvmError(
      "describe_failed",
      `Could not fetch ${endpoint}/v1/info: ${err instanceof Error ? err.message : String(err)}`,
      "Confirm the builder endpoint is reachable, then retry."
    );
  }

  const preferredMint = opts.mint ?? effectiveMints(wallet)[0];
  const amt = await resolveFundingAmountSats(amount, opts.sats);
  const sats = amt.sats;
  const amountPhrase = describeAmount(amt);
  const timeoutMs = parseTimeout(opts.timeout);
  const human = opts.human ?? false;

  if (human) {
    info(
      `Reserving ${amountPhrase} at ${preferredMint} locked to ${builderHandle} for ${formatLocktime(locktimeSeconds)}…`
    );
  }

  try {
    const result = await reserveAgentWallet(sats, {
      mintUrl: preferredMint,
      builderHandle,
      locktimeSeconds,
      providerInfo,
      timeoutMs,
      onInvoice: async (invoice) => {
        if (human) {
          info("");
          info("Pay this Lightning invoice from any Lightning wallet:");
          info("");
          info(invoice);
          info("");
          const ascii = await qrToString(invoice, { type: "terminal", small: true });
          info(ascii);
          info(
            "Polling for payment every 2s; press Ctrl-C to bail (the quote will be recoverable on next run)."
          );
        } else {
          json({
            status: "awaiting_payment",
            mint: preferredMint,
            amount_sats: sats,
            ...amountSourceFields(amt),
            invoice,
            builder_handle: builderHandle,
            locktime_seconds: locktimeSeconds,
            display: `Pay ${sats} sats to the Lightning invoice to reserve ${amountPhrase} at ${builderHandle} for ${formatLocktime(locktimeSeconds)}.`,
            hint: "After payment the CLI will mint NUT-11-locked Cashu proofs into ~/.dvm/wallet.json.",
          });
        }
      },
    });

    const totalSats = result.proofs.reduce((sum, p) => sum + p.amount, 0);

    if (human) {
      info("");
      info(`Reserved ${totalSats} sats across ${result.proofs.length} NUT-11-locked proofs.`);
      info(`  builder: ${result.builder_handle}`);
      info(`  lock pubkey: ${result.lock_pubkey}`);
      info(`  refund pubkey: ${result.refund_pubkey}`);
      info(`  expires: ${new Date(result.t_expire_ms).toISOString()}`);
      info(
        `Once expired, reclaim unshipped reserve with: dvm wallet release --builder ${opts.builder}`
      );
    } else {
      json({
        status: "reserved",
        mint: result.mint,
        amount_sats: sats,
        ...amountSourceFields(amt),
        sats_minted: totalSats,
        proof_count: result.proofs.length,
        denominations: result.denominations,
        builder_handle: result.builder_handle,
        lock_pubkey: result.lock_pubkey,
        refund_pubkey: result.refund_pubkey,
        t_expire_ms: result.t_expire_ms,
        t_expire_iso: new Date(result.t_expire_ms).toISOString(),
        quote_id: result.quote_id,
        display: `Reserved ${totalSats} sats at ${result.builder_handle} until ${new Date(result.t_expire_ms).toISOString()}.`,
        hint: `Inspect with \`dvm wallet show\`. Reclaim unshipped reserve post-expiry with \`dvm wallet release --builder ${opts.builder}\`.`,
      });
    }
  } finally {
    transport.close();
  }
}

/**
 * `dvm wallet release --builder <endpoint>` — swap expired unshipped
 * reserve proofs at a builder back to free balance via the NUT-11 refund
 * path. Race-with-builder-melt at the mint resolves cleanly via NUT-7
 * single-spend; already-melted proofs are dropped from the wallet locally.
 */
export async function walletRelease(opts: WalletReleaseOptions): Promise<void> {
  if (!opts.builder) {
    throw new DvmError(
      "missing_builder",
      "`--builder <endpoint>` is required.",
      "Pass the builder DVM's endpoint, e.g. `dvm wallet release --builder https://scrape.dvmkit.ai`."
    );
  }
  const endpoint = resolveEndpoint(opts.builder);
  const builderHandle = extractBuilderHandle(endpoint);
  const outputMode = parseOutputMode(opts.output);

  const transport = createDvmTransport();
  let providerInfo;
  try {
    providerInfo = await transport.describe({ endpoint });
  } catch (err) {
    transport.close();
    throw new DvmError(
      "describe_failed",
      `Could not fetch ${endpoint}/v1/info: ${err instanceof Error ? err.message : String(err)}`,
      "Confirm the builder endpoint is reachable, then retry."
    );
  }

  try {
    const result = await releaseAgentReserve({
      builderHandle,
      providerInfo,
      outputMode,
    });

    const totals = summariseRelease(result.mints);

    if (opts.human) {
      if (result.mints.length === 0) {
        info(`No expired unshipped reserve at ${builderHandle}.`);
        return;
      }
      info(
        `Released ${totals.reclaimedSats} sats at ${builderHandle} (output mode: ${result.output_mode}).`
      );
      for (const mintOutcome of result.mints) {
        info(`  ${mintOutcome.mint}:`);
        info(
          `    reclaimed: ${sumSats(mintOutcome.reclaimedOutputs)} sats from ${mintOutcome.reclaimedInputs.length} proof(s)`
        );
        if (mintOutcome.alreadySpent.length > 0) {
          info(
            `    already melted by builder: ${sumSats(mintOutcome.alreadySpent)} sats — dropped`
          );
        }
        if (mintOutcome.pending.length > 0) {
          info(`    mint-pending (skipped, retry next run): ${sumSats(mintOutcome.pending)} sats`);
        }
        if (mintOutcome.error) {
          info(`    error: ${mintOutcome.error}`);
        }
      }
    } else {
      json({
        status: result.mints.length === 0 ? "nothing_to_release" : "released",
        builder_handle: builderHandle,
        output_mode: result.output_mode,
        reclaimed_sats: totals.reclaimedSats,
        already_spent_sats: totals.alreadySpentSats,
        pending_sats: totals.pendingSats,
        mints: result.mints.map((m) => ({
          mint: m.mint,
          reclaimed_sats: sumSats(m.reclaimedOutputs),
          reclaimed_input_count: m.reclaimedInputs.length,
          already_spent_sats: sumSats(m.alreadySpent),
          pending_sats: sumSats(m.pending),
          error: m.error,
        })),
        display:
          result.mints.length === 0
            ? `No expired unshipped reserve at ${builderHandle}.`
            : `Released ${totals.reclaimedSats} sats at ${builderHandle}.`,
      });
    }
  } finally {
    transport.close();
  }
}

function summariseRelease(mints: ReleaseMintOutcome[]): {
  reclaimedSats: number;
  alreadySpentSats: number;
  pendingSats: number;
} {
  let reclaimedSats = 0;
  let alreadySpentSats = 0;
  let pendingSats = 0;
  for (const m of mints) {
    reclaimedSats += sumSats(m.reclaimedOutputs);
    alreadySpentSats += sumSats(m.alreadySpent);
    pendingSats += sumSats(m.pending);
  }
  return { reclaimedSats, alreadySpentSats, pendingSats };
}

function sumSats(proofs: { amount: number }[]): number {
  return proofs.reduce((sum, p) => sum + p.amount, 0);
}

function parseOutputMode(raw: string | undefined): "locked" | "unlocked" {
  if (raw === undefined || raw === "locked") return "locked";
  if (raw === "unlocked") return "unlocked";
  throw new DvmError(
    "invalid_output_mode",
    `Unknown --output value: "${raw}".`,
    "Pass `locked` (default — re-lock to the agent master pubkey) or `unlocked` (anyone-can-spend)."
  );
}

function parseTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new DvmError(
      "invalid_timeout",
      `Invalid --timeout value: "${raw}".`,
      "Pass a positive integer number of seconds, e.g. --timeout 600."
    );
  }
  return Math.floor(n) * 1_000;
}
