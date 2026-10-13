
import type { Wallet } from "@cashu/cashu-ts";
import { type AgentProof, getWallet } from "@dvmkit/sdk/internal";
import { type MintSource } from "./mint-inventory";

export interface MintBalance {
  url: string;
  /**
   * Why this URL appears in the wallet's mint inventory. Lets
   * agents distinguish a user-configured mint from the implicit default
   * fallback or from a historical mint that still holds proofs.
   */
  source: MintSource;
  balance_sats: number;
  proof_count: number;
  /**
   * `input_fee_ppk` for the mint's first active keyset, in parts-per-thousand
   * (NUT-02). On Coinos this is `100` → 1 sat per consumed proof on a swap.
   */
  input_fee_ppk: number;
  /**
   * Whether the mint answered the fee probe **on this run**.
   *
   * A live observation with no memory: nothing is persisted, and the next
   * command asks again. A `false` here means a spend would route around this
   * mint right now — it does not mean the balance is lost or the mint is
   * written off, and the moment the mint answers again it is used again.
   */
  reachable: boolean;
}

export function groupProofsByMint(proofs: AgentProof[]): Map<string, AgentProof[]> {
  const out = new Map<string, AgentProof[]>();
  for (const p of proofs) {
    const list = out.get(p.mint);
    if (list) list.push(p);
    else out.set(p.mint, [p]);
  }
  return out;
}

/**
 * Read each mint's first active keyset to recover its `input_fee_ppk`.
 * Returns 0 when the mint advertises no keysets (defensive: cashu-ts can
 * return an empty list during partial loads). Network errors fall back to
 * `null` so the caller can still render the row with a "-" placeholder.
 *
 * Probes run in parallel — each `try` already isolates failures, and the
 * sequential await per mint serialised network latency for no good reason
 * on a wallet with several mints.
 */
export async function loadMintFeeProfiles(
  mintUrls: string[],
  getWalletForMint: (mintUrl: string) => Promise<Wallet> = getWallet
): Promise<Map<string, number | null>> {
  const probes = mintUrls.map(async (url): Promise<[string, number | null]> => {
    try {
      const wallet = await getWalletForMint(url);
      const keysets = wallet.keyChain.getKeysets();
      if (keysets.length === 0) return [url, 0];
      const active = keysets.find((k) => k.isActive) ?? keysets[0];
      return [url, active.fee];
    } catch {
      return [url, null];
    }
  });
  const settled = await Promise.all(probes);
  return new Map(settled);
}

/**
 * Combine grouped proofs and fee profiles into the per-mint rows surfaced by
 * `dvm wallet show`. `input_fee_ppk` defaults to `0` for the JSON shape when
 * the network probe failed — agents reading the JSON shouldn't have to
 * branch on a null fee profile during alpha; the human view shows "-", and
 * `reachable: false` is what says the number is a placeholder.
 *
 * `sources` maps each URL to its inventory classification. URLs
 * not present in the map default to `"proofs"` — proof-bearing mints the
 * inventory walk missed are still historical evidence rather than current
 * configuration.
 */
export function summarizeMints(
  proofs: AgentProof[],
  fees: Map<string, number | null>,
  sources: Map<string, MintSource>
): MintBalance[] {
  const grouped = groupProofsByMint(proofs);
  const seen = new Set<string>();
  const rows: MintBalance[] = [];
  for (const [url, list] of grouped) {
    seen.add(url);
    rows.push(buildRow(url, list, fees.get(url) ?? null, sources.get(url) ?? "proofs"));
  }
  for (const [url, fee] of fees) {
    if (seen.has(url)) continue;
    rows.push(buildRow(url, [], fee, sources.get(url) ?? "proofs"));
  }
  rows.sort((a, b) => b.balance_sats - a.balance_sats || a.url.localeCompare(b.url));
  return rows;
}

function buildRow(
  url: string,
  list: AgentProof[],
  fee: number | null,
  source: MintSource
): MintBalance {
  return {
    url,
    source,
    balance_sats: list.reduce((acc, p) => acc + p.amount, 0),
    proof_count: list.length,
    input_fee_ppk: fee ?? 0,
    // The fee probe *is* the reachability probe — a null fee means the mint
    // didn't answer just now. No extra round-trip.
    reachable: fee !== null,
  };
}
