/** `wallet.mints` is canonical; the implicit default is labeled separately from configuration. */

import {
  loadConfig,
  updateConfig,
} from "../identity";
import {
  type AgentWallet,
  DEFAULT_AGENT_MINT_URL,
  loadAgentWallet,
  loadWalletConfiguredMints,
  saveAgentWallet,
  withWalletLock,
} from "@dvmkit/sdk/internal";

/**
 * Where an entry in the wallet's displayed mint inventory came from. Shared
 * across `dvm wallet show`, `mint-list`, and `mint-health` so agents see a
 * single vocabulary for the same concept.
 *
 * - `configured`: explicitly added to `wallet.mints` by the user.
 * - `default`: the implicit {@link DEFAULT_AGENT_MINT_URL}, surfaced only
 * when the wallet has no configured mints and no proofs/pending mints,
 * so a fresh `dvm wallet init` still surfaces the fund-flow fallback.
 * - `proofs`: historical — proofs exist at this mint but the user removed
 * it from `wallet.mints` (or it predates the field).
 * - `pending`: a pending mint quote awaits Lightning settlement at this
 * mint but it isn't in `wallet.mints` either.
 * - `ad_hoc`: a URL probed by `dvm wallet mint-health --mint <url>` that
 * isn't in `wallet.mints` — never set by the inventory builders, only by
 * callers that probe arbitrary URLs against the wallet's configured list.
 */
export type MintSource = "configured" | "default" | "proofs" | "pending" | "ad_hoc";

export interface MintInventoryEntry {
  url: string;
  /** Why this URL appears in the inventory — see {@link MintSource}. */
  source: MintSource;
}

/**
 * Return the user's explicitly-configured mints, performing a one-shot
 * migration from the legacy `config.cashuMints` storage if needed.
 *
 * The legacy path: `dvm wallet mint-add` used to write to
 * `config.cashuMints` in `~/.dvm/config.json`. The new path is `wallet.mints`
 * in `~/.dvm/wallet.json`, which is lock-protected and atomically written.
 * When this helper sees a non-empty legacy list and an empty `wallet.mints`,
 * it copies the URLs in (deduped, preserving order) and clears
 * `config.cashuMints` so subsequent reads stay coherent. Both sides write
 * under {@link withWalletLock}.
 *
 * Returns `[]` when no wallet exists yet — that's a setup question, not an
 * inventory question, and callers handle the "no wallet" case separately.
 */
export async function loadConfiguredMints(): Promise<string[]> {
  const wallet = loadAgentWallet();
  if (!wallet) return [];

  const config = loadConfig();
  const legacy = config?.cashuMints ?? [];

  if (legacy.length === 0 || wallet.mints.length > 0) {
    return loadWalletConfiguredMints();
  }

  // Wallet lock outside, config lock inside — the tree-wide order that keeps
  // the config lock innermost.
  return withWalletLock(async () => {
    const fresh = loadAgentWallet() ?? wallet;
    if (fresh.mints.length > 0) return fresh.mints;

    const merged = dedupe(legacy);
    saveAgentWallet({ ...fresh, mints: merged });

    await updateConfig({
      reason: "cashu_mints_migration",
      patch: () => ({ unset: ["cashuMints"] }),
    });

    return merged;
  });
}

/**
 * Build the mint inventory `dvm wallet show` displays, with each URL
 * classified by source. Configured mints come first, then any
 * historical mints that still hold proofs or pending quotes, then — only
 * when none of the above apply — the implicit {@link DEFAULT_AGENT_MINT_URL}
 * so a fresh wallet still surfaces the fund-flow fallback.
 */
export function buildDisplayMintInventory(
  wallet: Pick<AgentWallet, "mints" | "proofs" | "pending_mints">
): MintInventoryEntry[] {
  const entries: MintInventoryEntry[] = [];
  const seen = new Set<string>();

  for (const url of wallet.mints) {
    if (seen.has(url)) continue;
    seen.add(url);
    entries.push({ url, source: "configured" });
  }

  for (const proof of wallet.proofs) {
    if (seen.has(proof.mint)) continue;
    seen.add(proof.mint);
    entries.push({ url: proof.mint, source: "proofs" });
  }

  for (const pending of wallet.pending_mints) {
    if (seen.has(pending.mint)) continue;
    seen.add(pending.mint);
    entries.push({ url: pending.mint, source: "pending" });
  }

  if (entries.length === 0) {
    entries.push({ url: DEFAULT_AGENT_MINT_URL, source: "default" });
  }

  return entries;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
