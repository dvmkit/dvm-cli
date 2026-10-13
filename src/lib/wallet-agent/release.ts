/**
 * Agent-side refund flow for the pre-fund-per-builder reserve.
 *
 * `dvm wallet release --builder <handle>` reclaims unshipped reserve proofs
 * at a builder whose NUT-11 `locktime` has expired. The agent's per-DVM
 * refund subkey signs the refund-path witness; the mint marks the
 * inputs SPENT atomically and produces fresh outputs locked back to the
 * agent's master pubkey (default) or unlocked (`--output unlocked`).
 *
 * Race-with-builder-melt is handled at the mint via NUT-7 single-spend: a
 * pre-swap NUT-7 checkstate filters proofs the builder already melted (no
 * sense submitting them), and the mint rejects whatever survives the race.
 * Already-SPENT proofs are dropped from the wallet locally — they are the
 * builder's now by definition.
 *
 * Shipped proofs do not appear in `release` by construction: they have
 * already been removed from `wallet.proofs[]` at ship time (per the
 * `commitAgentSpend` / `submission` flow). `release` only ever swaps proofs
 * that the agent never handed over.
 */

import { type Proof, type Wallet } from "@cashu/cashu-ts";

import { deriveAgentRefundSubkey } from "@dvmkit/sdk/internal";
import { swapFeeForProofs } from "@dvmkit/sdk/internal";
import { getWallet } from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";
import type { ProviderInfo } from "@dvmkit/sdk/internal";
import { readAgentMnemonic } from "@dvmkit/sdk/internal";
import { reservedForMarker } from "./builder-handle";
import { toAgentProof, toCashuProofs } from "@dvmkit/sdk/internal";
import {
  type AgentProof,
  type AgentWallet,
  loadAgentWallet,
  saveAgentWallet,
  withWalletLock,
} from "@dvmkit/sdk/internal";

export interface ReleaseMintOutcome {
  mint: string;
  /** Proofs the mint marked SPENT in a prior race with the builder's melt. Dropped from the wallet. */
  alreadySpent: AgentProof[];
  /** Proofs the mint reported PENDING — kept on disk, retry next run. */
  pending: AgentProof[];
  reclaimedInputs: AgentProof[];
  reclaimedOutputs: AgentProof[];
  /** If `null`, the refund swap succeeded; otherwise the mint error message. */
  error: string | null;
}

export interface ReleaseResult {
  builder_handle: string;
  output_mode: "locked" | "unlocked";
  /** Per-mint outcomes — release groups reserve proofs by mint and runs one swap per mint. */
  mints: ReleaseMintOutcome[];
}

export interface ReleaseOptions {
  builderHandle: string;
  /** Provider /v1/info — required for the DVM's `cashu.canonical_id`. */
  providerInfo: ProviderInfo;
  /** Output lock policy. Defaults to `"locked"`. */
  outputMode?: "locked" | "unlocked";
  now?: () => number;
  getWalletForMint?: (mintUrl: string) => Promise<Wallet>;
  readMnemonic?: () => string | null;
}

/**
 * Reclaim unshipped reserve proofs at a builder. Groups candidate proofs by
 * mint, runs one refund swap per mint, persists results under
 * {@link withWalletLock}. Returns the per-mint outcomes so the caller can
 * surface what was reclaimed and what's still in flight.
 */
export async function releaseAgentReserve(opts: ReleaseOptions): Promise<ReleaseResult> {
  const cashu = opts.providerInfo.cashu;
  if (!cashu?.canonical_id) {
    throw new DvmError(
      "missing_canonical_id",
      "DVM advertises no `cashu.canonical_id` on /v1/info.",
      "Release needs canonical_id so the agent can derive the matching per-DVM refund subkey. Upgrade the builder SDK."
    );
  }
  const outputMode = opts.outputMode ?? "locked";

  const initial = loadAgentWallet();
  if (!initial) {
    throw new DvmError("wallet_missing", "No agent wallet found.", "Run `dvm wallet init` first.");
  }

  const readMnemonic = opts.readMnemonic ?? readAgentMnemonic;
  const mnemonic = readMnemonic();
  if (!mnemonic) {
    throw new DvmError(
      "mnemonic_required",
      "Release requires a BIP-39 mnemonic at ~/.dvm/wallet.mnemonic.",
      "Restore the mnemonic with `dvm wallet recover --force --file <path>` (or pipe it via stdin) — it's the only way to derive the refund subkey privkey."
    );
  }
  const refund = deriveAgentRefundSubkey(mnemonic, cashu.canonical_id);

  const marker = reservedForMarker(opts.builderHandle);
  const now = (opts.now ?? Date.now)();
  const candidates = initial.proofs.filter(
    (p) =>
      p.reserved_for === marker &&
      p.status === "valid" &&
      typeof p.t_expire === "number" &&
      p.t_expire < now
  );

  if (candidates.length === 0) {
    return { builder_handle: opts.builderHandle, output_mode: outputMode, mints: [] };
  }

  const getWalletForMint = opts.getWalletForMint ?? getWallet;

  const byMint = new Map<string, AgentProof[]>();
  for (const p of candidates) {
    const bucket = byMint.get(p.mint) ?? [];
    bucket.push(p);
    byMint.set(p.mint, bucket);
  }

  const outcomes: ReleaseMintOutcome[] = [];
  for (const [mintUrl, mintProofs] of byMint) {
    outcomes.push(
      await releaseAtMint(
        mintUrl,
        mintProofs,
        refund.privkey,
        initial,
        outputMode,
        getWalletForMint
      )
    );
  }

  return { builder_handle: opts.builderHandle, output_mode: outputMode, mints: outcomes };
}

async function releaseAtMint(
  mintUrl: string,
  mintProofs: AgentProof[],
  refundPrivkey: string,
  initial: AgentWallet,
  outputMode: "locked" | "unlocked",
  getWalletForMint: (mintUrl: string) => Promise<Wallet>
): Promise<ReleaseMintOutcome> {
  let cashuWallet: Wallet;
  try {
    cashuWallet = await getWalletForMint(mintUrl);
  } catch (err) {
    return {
      mint: mintUrl,
      alreadySpent: [],
      pending: [],
      reclaimedInputs: [],
      reclaimedOutputs: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // NUT-7 checkstate before the swap — drop builder-melted proofs locally
  // (they're the builder's, not ours to reclaim), and skip mint-PENDING
  // entries so we don't race a transient state into a hard rejection.
  let grouped;
  try {
    grouped = await cashuWallet.groupProofsByState(toCashuProofs(mintProofs));
  } catch (err) {
    return {
      mint: mintUrl,
      alreadySpent: [],
      pending: [],
      reclaimedInputs: [],
      reclaimedOutputs: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const spentSecrets = new Set(grouped.spent.map((p) => p.secret));
  const pendingSecrets = new Set(grouped.pending.map((p) => p.secret));
  const alreadySpent = mintProofs.filter((p) => spentSecrets.has(p.secret));
  const pending = mintProofs.filter((p) => pendingSecrets.has(p.secret));
  const unspent = mintProofs.filter(
    (p) => !spentSecrets.has(p.secret) && !pendingSecrets.has(p.secret)
  );

  if (alreadySpent.length > 0) {
    await withWalletLock(() => {
      const fresh = loadAgentWallet() ?? initial;
      const spentKeys = new Set(alreadySpent.map((p) => proofIdKey(p)));
      saveAgentWallet({
        ...fresh,
        proofs: fresh.proofs.filter((p) => !spentKeys.has(proofIdKey(p))),
      });
    });
  }

  if (unspent.length === 0) {
    return {
      mint: mintUrl,
      alreadySpent,
      pending,
      reclaimedInputs: [],
      reclaimedOutputs: [],
      error: null,
    };
  }

  // Sweep everything, less what the mint charges to swap it. The
  // agent is both sender and receiver here, so there is no receiver fee to
  // cover — asking for the full input sum would make cashu-ts demand more
  // inputs than exist and fail every release at a fee-charging mint.
  const totalSats = unspent.reduce((sum, p) => sum + p.amount, 0);
  const inputs = toCashuProofs(unspent);
  let outputs: Proof[];
  try {
    const swapFeeSats = swapFeeForProofs(cashuWallet, inputs);
    const reclaimSats = totalSats - swapFeeSats;
    if (reclaimSats <= 0) {
      throw new Error(
        `Reserve at ${mintUrl} is ${totalSats} sats, which does not cover the mint's ${swapFeeSats}-sat swap fee.`
      );
    }
    const builder = cashuWallet.ops.send(reclaimSats, inputs).privkey(refundPrivkey);
    const result =
      outputMode === "locked"
        ? await builder.asP2PK({ pubkey: initial.lock_pubkey }).run()
        : await builder.asRandom().run();
    outputs = result.send;
  } catch (err) {
    // Inputs untouched at the mint (the swap is atomic) — leave them on
    // disk for the next release attempt. PENDING entries similarly stay.
    return {
      mint: mintUrl,
      alreadySpent,
      pending,
      reclaimedInputs: [],
      reclaimedOutputs: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Swap landed: remove the reserve inputs, add free-balance outputs.
  // `null` `locked_to_pubkey` for `--output unlocked` is a typed signal that
  // these are anyone-can-spend outputs, distinct from any real pubkey.
  const reclaimedOutputs = outputs.map((p) =>
    toAgentProof(p, mintUrl, outputMode === "locked" ? initial.lock_pubkey : null)
  );
  await withWalletLock(() => {
    const fresh = loadAgentWallet() ?? initial;
    const inputKeys = new Set(unspent.map((p) => proofIdKey(p)));
    saveAgentWallet({
      ...fresh,
      proofs: [...fresh.proofs.filter((p) => !inputKeys.has(proofIdKey(p))), ...reclaimedOutputs],
    });
  });

  return {
    mint: mintUrl,
    alreadySpent,
    pending,
    reclaimedInputs: unspent,
    reclaimedOutputs,
    error: null,
  };
}

function proofIdKey(p: { secret: string; C: string }): string {
  return `${p.secret}:${p.C}`;
}
