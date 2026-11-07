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
 * A prior release intent is recovered before classifying SPENT inputs;
 * only spends without a release result are treated as builder redemptions.
 *
 * Shipped proofs do not appear in `release` by construction: they have
 * already been removed from `wallet.proofs[]` at ship time (per the
 * `commitAgentSpend` / `submission` flow). `release` only ever swaps proofs
 * that the agent never handed over.
 */

import { randomUUID } from "node:crypto";

import { MintOperationError, type Proof, type SwapPreview, type Wallet } from "@cashu/cashu-ts";

import { deriveAgentRefundSubkey } from "@dvmkit/sdk/internal";
import { swapFeeForProofs } from "@dvmkit/sdk/internal";
import { getWallet } from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";
import type { ProviderInfo } from "@dvmkit/sdk/internal";
import { readAgentMnemonic } from "@dvmkit/sdk/internal";
import { reservedForMarker } from "./builder-handle";
import { restoreProofsFromOutputs, serializeOutputData, toAgentProof, toCashuProofs } from "@dvmkit/sdk/internal";
import {
  type AgentProof,
  type AgentWallet,
  loadAgentWallet,
  saveAgentWallet,
  withWalletLock,
} from "@dvmkit/sdk/internal";

import {
  allReleaseIntents,
  clearReleaseIntent,
  loadReleaseIntent,
  recordReleaseIntent,
  type ReleaseIntent,
  withReleaseLock,
} from "./release-intents";

const RELEASE_IN_FLIGHT_MS = 2 * 60_000;

export interface ReleaseMintOutcome {
  mint: string;
  /** Policy of newly reclaimed outputs; null when no outputs were saved. */
  output_mode: "locked" | "unlocked" | null;
  /** Proofs the mint marked SPENT in a prior race with the builder's melt. Dropped from the wallet. */
  alreadySpent: AgentProof[];
  /** Proofs the mint reported PENDING — kept on disk, retry next run. */
  pending: AgentProof[];
  reclaimedInputs: AgentProof[];
  reclaimedOutputs: AgentProof[];
  /** A failure at the mint or while saving or recovering the release. */
  error: string | null;
}

export interface ReleaseResult {
  builder_handle: string;
  /** Actual reclaimed policies, or the requested policy when nothing was reclaimed. */
  output_mode: "locked" | "unlocked" | "mixed";
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

  const getWalletForMint = opts.getWalletForMint ?? getWallet;

  const byMint = new Map<string, AgentProof[]>();
  for (const p of candidates) {
    const bucket = byMint.get(p.mint) ?? [];
    bucket.push(p);
    byMint.set(p.mint, bucket);
  }

  // Include landed swaps whose journal cleanup failed, even with no reserve left.
  for (const intent of allReleaseIntents()) {
    if (intent.walletPubkey === initial.lock_pubkey && intent.builderHandle === opts.builderHandle && !byMint.has(intent.mint)) {
      byMint.set(intent.mint, []);
    }
  }

  const outcomes: ReleaseMintOutcome[] = [];
  for (const [mintUrl, mintProofs] of byMint) {
    try {
      outcomes.push(await withReleaseLock(initial.lock_pubkey, opts.builderHandle, mintUrl, () =>
        releaseAtMint(mintUrl, mintProofs, refund.privkey, initial, outputMode, getWalletForMint, opts.builderHandle, now)
      ));
    } catch (err) {
      outcomes.push({ mint: mintUrl, output_mode: null, alreadySpent: [], pending: [], reclaimedInputs: [], reclaimedOutputs: [], error: errorText(err) });
    }
  }

  const modes = new Set(outcomes.flatMap((outcome) => outcome.output_mode === null ? [] : [outcome.output_mode]));
  return {
    builder_handle: opts.builderHandle,
    output_mode: modes.size > 1 ? "mixed" : modes.values().next().value ?? outputMode,
    mints: outcomes,
  };
}

async function releaseAtMint(
  mintUrl: string,
  mintProofs: AgentProof[],
  refundPrivkey: string,
  initial: AgentWallet,
  outputMode: "locked" | "unlocked",
  getWalletForMint: (mintUrl: string) => Promise<Wallet>,
  builderHandle: string,
  now: number
): Promise<ReleaseMintOutcome> {
  const outcome: ReleaseMintOutcome = {
    mint: mintUrl, output_mode: null, alreadySpent: [], pending: [], reclaimedInputs: [], reclaimedOutputs: [], error: null,
  };
  let cashuWallet: Wallet;
  try {
    cashuWallet = await getWalletForMint(mintUrl);
    const intent = loadReleaseIntent(initial.lock_pubkey, builderHandle, mintUrl);
    if (intent) {
      const recovered = await recoverRelease(intent, cashuWallet, outcome, now);
      if (recovered) return recovered;
    }
    const available = new Set(currentWallet(initial.lock_pubkey).proofs
      .filter((p) => p.mint === mintUrl && p.status === "valid").map(proofIdKey));
    mintProofs = mintProofs.filter((p) => available.has(proofIdKey(p)));
  } catch (err) {
    return { ...outcome, error: errorText(err) };
  }
  if (mintProofs.length === 0) return outcome;

  // NUT-7 checkstate before the swap — drop builder-melted proofs locally
  // (they're the builder's, not ours to reclaim), and skip mint-PENDING
  // entries so we don't race a transient state into a hard rejection.
  let grouped;
  try {
    grouped = await cashuWallet.groupProofsByState(toCashuProofs(mintProofs));
  } catch (err) {
    return { ...outcome, error: errorText(err) };
  }
  const spentSecrets = new Set(grouped.spent.map((p) => p.secret));
  const pendingSecrets = new Set(grouped.pending.map((p) => p.secret));
  const alreadySpent = mintProofs.filter((p) => spentSecrets.has(p.secret));
  const pending = mintProofs.filter((p) => pendingSecrets.has(p.secret));
  const unspent = mintProofs.filter(
    (p) => !spentSecrets.has(p.secret) && !pendingSecrets.has(p.secret)
  );

  outcome.pending = pending;
  try {
    await withWalletLock(() => {
      // The mint round trip may have overlapped another command's release.
      assertNoRelease(initial.lock_pubkey, builderHandle, mintUrl);
      const fresh = currentWallet(initial.lock_pubkey);
      if (alreadySpent.length > 0) {
        const spentKeys = new Set(alreadySpent.map(proofIdKey));
        saveAgentWallet({ ...fresh, proofs: fresh.proofs.filter((p) => p.mint !== mintUrl || !spentKeys.has(proofIdKey(p))) });
      }
    });
    outcome.alreadySpent = alreadySpent;
  } catch (err) {
    return { ...outcome, error: errorText(err) };
  }

  if (unspent.length === 0) return outcome;

  // Sweep everything, less what the mint charges to swap it. The
  // agent is both sender and receiver here, so there is no receiver fee to
  // cover — asking for the full input sum would make cashu-ts demand more
  // inputs than exist and fail every release at a fee-charging mint.
  const totalSats = unspent.reduce((sum, p) => sum + p.amount, 0);
  const inputs = toCashuProofs(unspent);
  let preview: SwapPreview;
  try {
    const swapFeeSats = swapFeeForProofs(cashuWallet, inputs);
    const reclaimSats = totalSats - swapFeeSats;
    if (reclaimSats <= 0) {
      throw new Error(
        `Reserve at ${mintUrl} is ${totalSats} sats, which does not cover the mint's ${swapFeeSats}-sat swap fee.`
      );
    }
    const builder = cashuWallet.ops.send(reclaimSats, inputs).privkey(refundPrivkey);
    preview = outputMode === "locked"
      ? await builder.asP2PK({ pubkey: initial.lock_pubkey }).keepAsP2PK({ pubkey: initial.lock_pubkey }).prepare()
      : await builder.asRandom().keepAsRandom().prepare();
  } catch (err) {
    return { ...outcome, error: errorText(err) };
  }

  const selected = new Set(preview.inputs.map(proofIdKey));
  const intent: ReleaseIntent = {
    id: randomUUID(),
    builderHandle,
    mint: mintUrl,
    walletPubkey: initial.lock_pubkey,
    lockPubkey: outputMode === "locked" ? initial.lock_pubkey : null,
    keysetId: preview.keysetId,
    inputs: unspent.filter((p) => selected.has(proofIdKey(p))),
    outputs: serializeOutputData([...(preview.sendOutputs ?? []), ...(preview.keepOutputs ?? [])]),
    createdAt: now,
  };
  try {
    await withWalletLock(() => {
      const fresh = currentWallet(initial.lock_pubkey);
      const available = new Set(fresh.proofs.filter((p) => p.mint === mintUrl && p.status === "valid").map(proofIdKey));
      if (intent.inputs.length === 0 || !intent.inputs.every((p) => available.has(proofIdKey(p)))) {
        throw new Error("Reserve proofs changed during release; retry `dvm wallet release`.");
      }
      recordReleaseIntent(intent);
    });
  } catch (err) {
    return { ...outcome, error: `Could not record the release, so nothing was swapped: ${errorText(err)}` };
  }

  let outputs: Proof[];
  try {
    const result = await cashuWallet.completeSwap(preview, refundPrivkey);
    // cashu-ts includes unselected inputs in `keep`; they remain reserved.
    const inputKeys = new Set(inputs.map(proofIdKey));
    outputs = [...result.send, ...result.keep.filter((p) => !inputKeys.has(proofIdKey(p)))];
  } catch (err) {
    // Transport failures can follow a committed swap. Keep its recovery data.
    if (err instanceof MintOperationError) {
      try { clearReleaseIntent(intent); } catch { /* retried by the next release */ }
    }
    return { ...outcome, error: errorText(err) };
  }
  return commitRelease(intent, outputs, outcome);
}

async function commitRelease(
  intent: ReleaseIntent,
  outputs: Proof[],
  outcome: ReleaseMintOutcome
): Promise<ReleaseMintOutcome> {
  const reclaimedOutputs = outputs.map((p) => toAgentProof(p, intent.mint, intent.lockPubkey));
  let saved = false;
  let cleanupError: unknown;
  try {
    await withWalletLock(() => {
      const fresh = currentWallet(intent.walletPubkey);
      const active = loadReleaseIntent(intent.walletPubkey, intent.builderHandle, intent.mint);
      if (active?.id !== intent.id) return;
      const inputKeys = new Set(intent.inputs.map(proofIdKey));
      // No remaining inputs means an earlier save landed. Its outputs may
      // already have been spent again, so never re-add them from a stale journal.
      if (fresh.proofs.some((p) => p.mint === intent.mint && inputKeys.has(proofIdKey(p)))) {
        const existing = new Set(fresh.proofs.filter((p) => p.mint === intent.mint).map(proofIdKey));
        saveAgentWallet({
          ...fresh,
          proofs: [
            ...fresh.proofs.filter((p) => p.mint !== intent.mint || !inputKeys.has(proofIdKey(p))),
            ...reclaimedOutputs.filter((p) => !existing.has(proofIdKey(p))),
          ],
        });
        saved = true;
      }
      try { clearReleaseIntent(intent); } catch (err) { cleanupError = err; }
    });
  } catch (err) {
    return { ...outcome, error: `Release result is not saved to the wallet: ${errorText(err)}. Retry \`dvm wallet release\` to recover it.` };
  }
  return {
    ...outcome,
    output_mode: saved && reclaimedOutputs.length > 0 ? (intent.lockPubkey === null ? "unlocked" : "locked") : null,
    reclaimedInputs: saved ? intent.inputs : [],
    reclaimedOutputs: saved ? reclaimedOutputs : [],
    error: cleanupError ? `Release saved, but recovery journal cleanup failed: ${errorText(cleanupError)}. Retry \`dvm wallet release\`.` : null,
  };
}

async function recoverRelease(
  intent: ReleaseIntent,
  cashuWallet: Wallet,
  outcome: ReleaseMintOutcome,
  now: number
): Promise<ReleaseMintOutcome | null> {
  const fresh = currentWallet(intent.walletPubkey);
  const inputKeys = new Set(intent.inputs.map(proofIdKey));
  if (!fresh.proofs.some((p) => p.mint === intent.mint && inputKeys.has(proofIdKey(p)))) {
    return commitRelease(intent, [], outcome);
  }

  let restored: Proof[] = [];
  let restoreError: unknown;
  try {
    restored = await restoreProofsFromOutputs(cashuWallet, intent.keysetId, intent.outputs);
  } catch (err) { restoreError = err; }
  if (restored.length === intent.outputs.length && restored.length > 0) {
    return commitRelease(intent, restored, outcome);
  }
  if (restored.length > 0) {
    return { ...outcome, error: "The mint restored only part of the release outputs; retry `dvm wallet release`." };
  }

  const states = await cashuWallet.groupProofsByState(toCashuProofs(intent.inputs));
  // A young intent may belong to a command that has not reached the mint yet.
  if (now - intent.createdAt < RELEASE_IN_FLIGHT_MS) {
    return { ...outcome, error: "Another release may still be in flight; retry `dvm wallet release` shortly." };
  }
  const unspent = new Set(states.unspent.map((p) => proofIdKey(p)));
  if (states.pending.length === 0 && (
    intent.inputs.every((p) => unspent.has(proofIdKey(p))) || restoreError === undefined
  )) {
    // Either every input is still available, or NUT-09 answered with no signed
    // outputs. A SPENT input in the latter case belongs to the builder's swap.
    await withWalletLock(() => clearReleaseIntent(intent));
    return null;
  }
  return {
    ...outcome,
    error: `Release recovery is pending${restoreError ? `: ${errorText(restoreError)}` : ": the mint still reports inputs pending"}. Retry \`dvm wallet release\`.`,
  };
}

function currentWallet(pubkey: string): AgentWallet {
  const wallet = loadAgentWallet();
  if (!wallet || wallet.lock_pubkey !== pubkey) throw new Error("The agent wallet changed during release.");
  return wallet;
}

function assertNoRelease(walletPubkey: string, builderHandle: string, mint: string): void {
  if (loadReleaseIntent(walletPubkey, builderHandle, mint)) {
    throw new Error("Another release is awaiting recovery; retry `dvm wallet release`.");
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function proofIdKey(p: { secret: string; C: string }): string {
  return `${p.secret}:${p.C}`;
}
