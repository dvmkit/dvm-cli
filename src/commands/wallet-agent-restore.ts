/**
 * `dvm wallet restore <mnemonic>`. Rebuilds an agent wallet's
 * proof set from the BIP-39 mnemonic alone, by walking NUT-13
 * deterministic counters from 0 per V2 keyset against each configured
 * mint, calling NUT-09 `/v1/restore` (via cashu-ts's `batchRestore`) to
 * learn signed derivations, and NUT-7 `checkProofsStates` to filter
 * already-spent proofs. The "three consecutive empty batches" termination
 * rule is encoded by cashu-ts's `gapLimit=300` / `batchSize=100` defaults.
 *
 * Distinct from `dvm wallet recover`: recover only re-installs the
 * identity material (lock keypair + mnemonic file + fingerprint).
 * Restore is the full proof-set rehydration on a fresh device.
 */
import type { Wallet } from "@cashu/cashu-ts";
import { CheckStateEnum, parseSecret, type Proof } from "@cashu/cashu-ts";
import {
  AGENT_MNEMONIC_FILE,
  type AgentProof,
  type AgentWallet,
  DEFAULT_AGENT_MINT_URL,
  deriveAgentMasterKeypair,
  DvmError,
  effectiveMints,
  getWallet,
  loadAgentWallet,
  looksLikeMnemonic,
  mnemonicFingerprint,
  type MnemonicValidationResult,
  PersistentCounterSource,
  saveAgentWallet,
  toAgentProof,
  validateAgentMnemonic,
  WALLET_FILE,
  WALLET_VERSION,
  walletExists,
  withWalletLock,
  writeAgentMnemonic,
} from "@dvmkit/sdk/internal";
import {
  info,
  json,
} from "../lib/output";
import { loadConfiguredMints } from "../lib/wallet-agent/mint-inventory";

import { resolveSecretInput } from "../lib/secret-input";
import { MNEMONIC_SECRET_CONFIG } from "./wallet-agent";

const RESTORE_BATCH_SIZE = 100;
const RESTORE_GAP_LIMIT = 300; // = 3 × batchSize ⇒ "three consecutive empty batches"

export interface WalletRestoreOptions {
  /** Mint URL to restore against (repeatable). Defaults to the wallet's effective mints. */
  mint?: string[];
  /** Overwrite an existing wallet file (destroys any current proofs/counters). */
  force?: boolean;
  human?: boolean;
  /**
   * Read the mnemonic from a file instead of the positional arg — avoids
   * leaking the secret via shell history, `ps`, and `/proc/<pid>/cmdline`.
   * Paths under shell-history or world-readable temp directories are
   * rejected (see `secret-input.ts`).
   */
  file?: string;
}

interface MintRestoreOutcome {
  mint: string;
  recovered_proofs: AgentProof[];
  skipped_non_master: { id: string; locked_to_pubkey: string | null; amount: number }[];
  filtered_spent: number;
  counters: Record<string, number>;
}

export async function walletRestore(
  input: string | undefined,
  opts: WalletRestoreOptions
): Promise<void> {
  const resolved = await resolveSecretInput({
    positional: input,
    file: opts.file,
    config: MNEMONIC_SECRET_CONFIG,
  });
  const trimmed = resolved.value.trim();
  if (!looksLikeMnemonic(trimmed)) {
    throw new DvmError(
      "invalid_mnemonic",
      "Restore requires the full 12-word BIP-39 mnemonic — NUT-13 derivation needs the BIP-39 seed, not the derived signing key.",
      "Pass 12 space-separated BIP-39 words via --file, piped stdin, or the interactive prompt. If you only have the hex master privkey, use `dvm wallet recover --file <path>` (or pipe via stdin) with the hex instead (degraded mode, no NUT-13)."
    );
  }
  const validation = validateAgentMnemonic(trimmed);
  if (!validation.ok) {
    throw mnemonicValidationError(validation);
  }
  const mnemonic = trimmed.toLowerCase().split(/\s+/).join(" ");
  const { privkey, pubkey } = deriveAgentMasterKeypair(mnemonic);
  const fingerprint = mnemonicFingerprint(mnemonic);

  if (walletExists() && !opts.force) {
    throw new DvmError(
      "wallet_exists",
      `Wallet already exists at ${WALLET_FILE}.`,
      "Use --force to overwrite. WARNING: this destroys local proof state — anything not on the mint becomes unrecoverable."
    );
  }

  // Migrate any legacy `config.cashuMints` into `wallet.mints` before the
  // resolve so a legacy user's mint choices carry through restore.
  await loadConfiguredMints();

  // Determine mint set BEFORE we overwrite the wallet so an existing
  // `mints[]` carries through. --mint flags win.
  const mintUrls = resolveMintUrls(opts.mint);

  // Persist the fresh wallet + mnemonic first so `getWallet` activates
  // NUT-13 on this very command.
  await withWalletLock(() => {
    writeAgentMnemonic(mnemonic, { force: opts.force });
    saveAgentWallet(newWallet(privkey, pubkey, fingerprint, mintUrls));
  });

  const outcomes: MintRestoreOutcome[] = [];
  for (const mintUrl of mintUrls) {
    outcomes.push(await restoreMint(mintUrl, pubkey));
  }

  await withWalletLock(() => {
    const current = loadAgentWallet();
    if (!current) return;
    saveAgentWallet({
      ...current,
      proofs: outcomes.flatMap((o) => o.recovered_proofs),
    });
  });

  emit(outcomes, pubkey, fingerprint, opts);
}

function resolveMintUrls(flag: string[] | undefined): string[] {
  if (flag && flag.length > 0) {
    return Array.from(new Set(flag));
  }
  const wallet = loadAgentWallet();
  if (wallet) return effectiveMints(wallet);
  return [DEFAULT_AGENT_MINT_URL];
}

async function restoreMint(mintUrl: string, masterPubkey: string): Promise<MintRestoreOutcome> {
  const wallet = await getWallet(mintUrl);
  // A retired V1 keyset remains excluded: dvmkit never derived NUT-13 outputs
  // under V1, so its historical proofs used random secrets and cannot be
  // reconstructed from the mnemonic. Retired V2 keysets stay in the walk.
  const keysets = wallet.keyChain.getKeysets().filter((keyset) => !keyset.id.startsWith("00"));

  const counters: Record<string, number> = {};
  const collected: Proof[] = [];
  const counterSource = new PersistentCounterSource(mintUrl);

  for (const keyset of keysets) {
    const { proofs, lastCounterWithSignature } = await wallet.batchRestore(
      RESTORE_GAP_LIMIT,
      RESTORE_BATCH_SIZE,
      0,
      keyset.id
    );
    const next = (lastCounterWithSignature ?? -1) + 1;
    counters[keyset.id] = next;
    await counterSource.setNext(keyset.id, next);
    collected.push(...proofs);
  }

  const { unspent, filteredSpent } = await filterSpent(wallet, collected);

  const recovered: AgentProof[] = [];
  const skipped: MintRestoreOutcome["skipped_non_master"] = [];
  for (const proof of unspent) {
    const lockedTo = lockedToPubkey(proof.secret);
    if (lockedTo === masterPubkey) {
      recovered.push(toAgentProof(proof, mintUrl, masterPubkey));
    } else {
      skipped.push({
        id: proof.id,
        locked_to_pubkey: lockedTo,
        amount: numericAmount(proof.amount),
      });
    }
  }

  return {
    mint: mintUrl,
    recovered_proofs: recovered,
    skipped_non_master: skipped,
    filtered_spent: filteredSpent,
    counters,
  };
}

async function filterSpent(
  wallet: Wallet,
  proofs: Proof[]
): Promise<{ unspent: Proof[]; filteredSpent: number }> {
  if (proofs.length === 0) return { unspent: [], filteredSpent: 0 };
  const states = await wallet.checkProofsStates(proofs);
  if (states.length !== proofs.length) {
    throw new DvmError(
      "cashu_checkstate_shape_mismatch",
      `Mint returned ${states.length} proof states for ${proofs.length} proofs (NUT-7 contract violated).`,
      "Retry the restore; if it persists, the mint may be misbehaving."
    );
  }
  let filteredSpent = 0;
  const unspent: Proof[] = [];
  for (let i = 0; i < proofs.length; i++) {
    if (states[i].state === CheckStateEnum.SPENT) {
      filteredSpent++;
      continue;
    }
    unspent.push(proofs[i]);
  }
  return { unspent, filteredSpent };
}

function lockedToPubkey(secret: string): string | null {
  try {
    const parsed = parseSecret(secret);
    if (!Array.isArray(parsed) || parsed[0] !== "P2PK") return null;
    const data = parsed[1].data;
    return typeof data === "string" ? data : null;
  } catch {
    return null;
  }
}

function numericAmount(amount: unknown): number {
  if (typeof amount === "number") return amount;
  if (
    amount &&
    typeof amount === "object" &&
    "toNumber" in amount &&
    typeof (amount as { toNumber: unknown }).toNumber === "function"
  ) {
    return (amount as { toNumber: () => number }).toNumber();
  }
  return Number(amount);
}

function newWallet(
  privkey: string,
  pubkey: string,
  mnemonicFp: string,
  mints: string[]
): AgentWallet {
  return {
    version: WALLET_VERSION,
    lock_privkey: privkey,
    lock_pubkey: pubkey,
    mnemonic_fingerprint: mnemonicFp,
    mints,
    proofs: [],
    nut13_counters: {},
    pending_mints: [],
    pending_melts: [],
    pending_submissions: [],
    recent_spends: [],
    created_at: new Date().toISOString(),
  };
}

function emit(
  outcomes: MintRestoreOutcome[],
  pubkey: string,
  fingerprint: string,
  opts: WalletRestoreOptions
): void {
  const totalProofs = outcomes.reduce((s, o) => s + o.recovered_proofs.length, 0);
  const totalSats = outcomes.reduce(
    (s, o) => s + o.recovered_proofs.reduce((sum, p) => sum + p.amount, 0),
    0
  );
  const totalSkipped = outcomes.reduce((s, o) => s + o.skipped_non_master.length, 0);
  const totalSpent = outcomes.reduce((s, o) => s + o.filtered_spent, 0);

  if (opts.human) {
    info(`Agent wallet restored at ${WALLET_FILE} (mnemonic file: ${AGENT_MNEMONIC_FILE}).`);
    info(`Lock pubkey: ${pubkey}`);
    info("");
    for (const o of outcomes) {
      const mintSats = o.recovered_proofs.reduce((s, p) => s + p.amount, 0);
      info(`  ${o.mint}`);
      info(`    recovered: ${o.recovered_proofs.length} proofs (${mintSats} sats)`);
      info(`    filtered spent: ${o.filtered_spent}`);
      if (o.skipped_non_master.length > 0) {
        info(
          `    skipped (non-master lock target): ${o.skipped_non_master.length} — not restored; counters advanced past them`
        );
      }
      info(`    counters: ${JSON.stringify(o.counters)}`);
    }
    info("");
    info(`Total recovered: ${totalProofs} proofs (${totalSats} sats).`);
    return;
  }

  json({
    status: "restored",
    lock_pubkey: pubkey,
    mnemonic_fingerprint: fingerprint,
    total_sats: totalSats,
    recovered_proof_count: totalProofs,
    filtered_spent: totalSpent,
    skipped_non_master_pubkey: totalSkipped,
    per_mint: outcomes.map((o) => ({
      mint: o.mint,
      recovered_proof_count: o.recovered_proofs.length,
      recovered_sats: o.recovered_proofs.reduce((s, p) => s + p.amount, 0),
      filtered_spent: o.filtered_spent,
      skipped_non_master: o.skipped_non_master,
      counters: o.counters,
    })),
    walletFile: WALLET_FILE,
    mnemonicFile: AGENT_MNEMONIC_FILE,
    display: `Restored ${totalProofs} proofs (${totalSats} sats) across ${outcomes.length} mint(s)`,
    hint:
      totalSkipped > 0
        ? "Some proofs were locked to a non-master pubkey (likely a pre-fund reserve at a DVM) and were not restored. Scan counters advanced past them."
        : undefined,
  });
}

function mnemonicValidationError(
  result: Exclude<MnemonicValidationResult, { ok: true }>
): DvmError {
  if (result.reason === "wrong_length") {
    return new DvmError(
      "invalid_mnemonic",
      `Expected 12 BIP-39 words, got ${result.wordCount}.`,
      "Pass all 12 words space-separated to the mnemonic input (`--file <path>`, piped stdin, or the interactive prompt — passing the mnemonic on the command line leaks it to shell history)."
    );
  }
  if (result.reason === "unknown_word") {
    return new DvmError(
      "invalid_mnemonic",
      `Word #${result.badWordIndex} ("${result.badWord}") is not in the BIP-39 wordlist.`,
      "Check that word for a typo against your written backup."
    );
  }
  return new DvmError(
    "invalid_mnemonic",
    "Mnemonic checksum failed.",
    "All 12 words are valid BIP-39 words but the checksum doesn't match — one word is likely a near-miss. Re-check each word against your written backup."
  );
}
