import {
  AGENT_MNEMONIC_FILE,
  type AgentWallet,
  assertAgentMnemonicReplaceable,
  deleteAgentMnemonic,
  deriveAgentMasterKeypair,
  derivePubkeyFromPrivkey,
  DvmError,
  generateAgentMnemonic,
  looksLikeMnemonic,
  mnemonicFingerprint,
  PRIVKEY_HEX_RE,
  saveAgentWallet,
  validateAgentMnemonic,
  WALLET_FILE,
  WALLET_VERSION,
  walletExists,
  writeAgentMnemonic,
} from "@dvmkit/sdk/internal";
import {
  info,
  json,
} from "../lib/output";
import * as readline from "node:readline";

import { resolveSecretInput, type SecretInputConfig } from "../lib/secret-input";

export interface WalletInitOptions {
  /** Overwrite an existing wallet file (destroys the current privkey). */
  force?: boolean;
  /** Skip the human-mode backup-confirmation prompt. */
  yes?: boolean;
  human?: boolean;
  /**
   * Opt-in to surfacing the derived `lock_privkey` (and, in JSON mode, the
   * raw 12-word mnemonic) on stdout / stderr. JSON mode adds a `secrets`
   * block carrying both; `--human` mode adds the `Lock privkey:`
   * stderr line. Off by default so an agent relaying stdout/stderr never
   * leaks the recovery material — the mnemonic is always persisted to the
   * 0600 sidecar file regardless of this flag.
   */
  showSecret?: boolean;
}

export interface WalletAgentRecoverOptions {
  /** Overwrite an existing wallet file (destroys the current privkey). */
  force?: boolean;
  human?: boolean;
  /**
   * Read the mnemonic (or hex privkey) from a file instead of the positional
   * arg — avoids leaking the secret via shell history, `ps`, and
   * `/proc/<pid>/cmdline`. Paths under shell-history or world-readable temp
   * directories are rejected (see `secret-input.ts`).
   */
  file?: string;
}

/**
 * Secret-input config for the BIP-39 mnemonic / hex privkey accepted by
 * `dvm wallet recover` and `dvm wallet restore`. Drives the stderr warning,
 * file-not-found hint, stdin-timeout message, and TTY prompt label.
 */
export const MNEMONIC_SECRET_CONFIG: SecretInputConfig = {
  kind: "mnemonic",
  promptLabel: "Enter 12-word BIP-39 mnemonic (input hidden, press enter to submit):",
  warningCommands: [
    "cat ~/mnemonic.txt | dvm wallet recover --force      # pipe via stdin",
    "dvm wallet recover --file ~/mnemonic.txt --force     # read from file",
    "dvm wallet recover --force                           # interactive prompt",
  ],
};

/**
 * Generate a fresh agent-wallet mnemonic, derive the master keypair at
 * `m/1789'/1'`, and persist the wallet to `~/.dvm/wallet.json` plus the
 * mnemonic to `~/.dvm/wallet.mnemonic` (mode 0600). The mnemonic
 * is the wallet's source of truth — displayed once **and** persisted to
 * disk so NUT-13 deterministic secrets can stay active across CLI runs.
 * Refuses to overwrite an existing wallet without `--force` so a misfire
 * never destroys a funded wallet's master keypair.
 *
 * In `--human` mode the function pauses for a backup-confirmation step
 * (ask the user to type a randomly chosen word from the mnemonic) so the
 * wallet only gets written once the user has actually read the words.
 * Skipped under `--yes` or when stdin is not a TTY.
 */
export async function walletInit(opts: WalletInitOptions): Promise<void> {
  if (walletExists() && !opts.force) {
    throw new DvmError(
      "wallet_exists",
      `Wallet already exists at ${WALLET_FILE}.`,
      "Use --force to overwrite. WARNING: this destroys the existing recovery mnemonic and privkey — any funds locked to it become unrecoverable without a backup."
    );
  }
  // Before generating anything: in --human mode the words are printed and the
  // user is walked through a backup confirmation, so a refusal has to happen
  // ahead of that or they back up a wallet that never gets created.
  assertAgentMnemonicReplaceable({ force: opts.force });

  const mnemonic = generateAgentMnemonic();
  const { privkey, pubkey } = deriveAgentMasterKeypair(mnemonic);
  const fingerprint = mnemonicFingerprint(mnemonic);

  if (opts.human) {
    info("Agent wallet created.\n");
    info("⚠  Write down these 12 words — they are the ONLY way to recover");
    info("   funds locked to this wallet. We never see them.\n");
    const words = mnemonic.split(" ");
    for (let i = 0; i < words.length; i++) {
      info(`  ${String(i + 1).padStart(2)}. ${words[i]}`);
    }
    info("");
    if (opts.showSecret) {
      info(`  Lock privkey: ${privkey}`);
    }
    info(`  Lock pubkey:  ${pubkey}\n`);

    if (!opts.yes && process.stdin.isTTY) {
      await confirmBackup(words);
      info("");
    }

    writeAgentMnemonic(mnemonic, { force: opts.force });
    saveAgentWallet(newWallet(privkey, pubkey, fingerprint));
    info(`Wallet file: ${WALLET_FILE}`);
    info(`Mnemonic file: ${AGENT_MNEMONIC_FILE}`);
  } else {
    writeAgentMnemonic(mnemonic, { force: opts.force });
    saveAgentWallet(newWallet(privkey, pubkey, fingerprint));
    const base = {
      status: "created" as const,
      mnemonic_fingerprint: fingerprint,
      lock_pubkey: pubkey,
      walletFile: WALLET_FILE,
      mnemonicFile: AGENT_MNEMONIC_FILE,
      secret_written: true as const,
      display: `Agent wallet created at ${WALLET_FILE}`,
    };
    if (opts.showSecret) {
      json({
        ...base,
        secrets: { mnemonic, lock_privkey: privkey },
        hint: `This object contains recovery-secret material under "secrets" (12-word mnemonic + derived lock_privkey). Do NOT log, relay, or echo this object to other systems — write the mnemonic to durable backup, then drop it. The same mnemonic is also persisted at ${AGENT_MNEMONIC_FILE} (mode 0600); backing up that file is equivalent.`,
      });
    } else {
      json({
        ...base,
        hint: `The 12-word recovery mnemonic was written to ${AGENT_MNEMONIC_FILE} (mode 0600). Back up that file — it is the only way to recover funds locked to this wallet. Default JSON intentionally omits the mnemonic so an agent relaying stdout never leaks it; re-run with --show-secret if automation needs to capture it on stdout.`,
      });
    }
  }
}

/**
 * Restore wallet metadata from a known recovery secret. Accepts either a
 * 12-word BIP-39 mnemonic (preferred — also restores the BIP-32 derivation
 * tree for per-DVM subkeys and activates NUT-13 deterministic secrets via
 * `~/.dvm/wallet.mnemonic` + the wallet's `mnemonic_fingerprint`) or a
 * 64-char hex master privkey (back-compat for wallets without mnemonic recovery;
 * degraded mode — no NUT-13). Refuses to overwrite an existing
 * wallet without `--force` (explicit recovery is fine, accidental
 * overwrite is not).
 *
 * Note: `dvm wallet recover` does NOT walk NUT-13 + NUT-09 to rebuild the
 * proof set — use `dvm wallet restore <mnemonic>` for that. Recover only
 * (re)installs the identity material.
 */
export async function walletRecover(
  input: string | undefined,
  opts: WalletAgentRecoverOptions
): Promise<void> {
  const resolved = await resolveSecretInput({
    positional: input,
    file: opts.file,
    config: MNEMONIC_SECRET_CONFIG,
  });
  const trimmed = resolved.value.trim();

  let privkey: string;
  let pubkey: string;
  let recoveredFrom: "mnemonic" | "privkey";
  let mnemonic: string | null = null;

  if (looksLikeMnemonic(trimmed)) {
    const result = validateAgentMnemonic(trimmed);
    if (!result.ok) {
      throw mnemonicValidationError(result);
    }
    const normalised = trimmed.toLowerCase().split(/\s+/).join(" ");
    const kp = deriveAgentMasterKeypair(normalised);
    privkey = kp.privkey;
    pubkey = kp.pubkey;
    recoveredFrom = "mnemonic";
    mnemonic = normalised;
  } else {
    const normalised = trimmed.toLowerCase();
    if (!PRIVKEY_HEX_RE.test(normalised)) {
      throw new DvmError(
        "invalid_privkey",
        "Recovery input must be either 12 BIP-39 words (space-separated) or a 64-char hex privkey.",
        "Provide the mnemonic with spaces between words, or the recovery privkey as a 64-char lowercase hex string."
      );
    }
    privkey = normalised;
    pubkey = derivePubkeyFromPrivkey(normalised);
    recoveredFrom = "privkey";
  }

  if (walletExists() && !opts.force) {
    throw new DvmError(
      "wallet_exists",
      `Wallet already exists at ${WALLET_FILE}.`,
      "Use --force to overwrite. WARNING: this destroys the existing recovery mnemonic and privkey — any funds locked to it become unrecoverable without a backup."
    );
  }
  // Covers both branches below: recovering from a hex privkey *discards* the
  // mnemonic rather than replacing it, which is at least as destructive, so it
  // takes the same opt-in.
  assertAgentMnemonicReplaceable({ force: opts.force });

  // Replace any pre-existing sibling mnemonic file so we never leave a
  // stale-fingerprint mismatch behind that would trip `getWallet`.
  const { backupFile } = mnemonic
    ? writeAgentMnemonic(mnemonic, { force: opts.force })
    : deleteAgentMnemonic();
  const fingerprint = mnemonic ? mnemonicFingerprint(mnemonic) : null;
  saveAgentWallet(newWallet(privkey, pubkey, fingerprint));

  if (opts.human) {
    info(`Agent wallet recovered from ${recoveredFrom}.\n`);
    info(`  Lock pubkey: ${pubkey}\n`);
    info(`Wallet file: ${WALLET_FILE}`);
    if (mnemonic) {
      info(`Mnemonic file: ${AGENT_MNEMONIC_FILE}`);
    } else {
      info("NUT-13 deterministic secrets are INACTIVE — recovered from hex privkey only.");
      info(
        "Re-run with the full mnemonic to re-activate: `dvm wallet recover --force --file <path>`, or pipe via stdin, or run with no args for an interactive prompt."
      );
    }
    if (backupFile) {
      info(`Previous mnemonic backed up to: ${backupFile}`);
    }
  } else {
    json({
      status: "recovered",
      recoveredFrom,
      lock_pubkey: pubkey,
      mnemonic_fingerprint: fingerprint,
      walletFile: WALLET_FILE,
      mnemonicFile: mnemonic ? AGENT_MNEMONIC_FILE : null,
      ...(backupFile ? { backupFile } : {}),
      display: `Agent wallet recovered at ${WALLET_FILE}`,
      hint: mnemonic
        ? backupFile
          ? `The mnemonic this replaced was copied to ${backupFile} (mode 0600). Funds locked to keys derived from it are not spendable with the recovered wallet.`
          : undefined
        : `NUT-13 deterministic secrets are inactive in this mode — to re-activate, re-run with the full 12-word mnemonic via \`dvm wallet recover --force --file <path>\`, piped stdin, or the interactive prompt (no positional arg, to avoid shell-history leaks).${backupFile ? ` The mnemonic this discarded was copied to ${backupFile} (mode 0600).` : ""}`,
    });
  }
}

function newWallet(privkey: string, pubkey: string, mnemonicFp: string | null): AgentWallet {
  return {
    version: WALLET_VERSION,
    lock_privkey: privkey,
    lock_pubkey: pubkey,
    mnemonic_fingerprint: mnemonicFp,
    mints: [],
    proofs: [],
    nut13_counters: {},
    pending_mints: [],
    pending_melts: [],
    pending_submissions: [],
    recent_spends: [],
    created_at: new Date().toISOString(),
  };
}

const MAX_CONFIRM_ATTEMPTS = 3;

/**
 * Force the user to demonstrate they've actually read the mnemonic by typing
 * a randomly chosen word back at us. On a final mismatch we abort init
 * without saving the wallet — the user can re-run from a clean state.
 */
async function confirmBackup(words: string[]): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (let attempt = 0; attempt < MAX_CONFIRM_ATTEMPTS; attempt++) {
      const idx = Math.floor(Math.random() * words.length);
      const answer = await prompt(
        rl,
        `Type word #${idx + 1} to confirm you've saved the mnemonic: `
      );
      if (answer.trim().toLowerCase() === words[idx]) {
        info("Backup confirmed.");
        return;
      }
      info(
        `That doesn't match word #${idx + 1}. ${MAX_CONFIRM_ATTEMPTS - attempt - 1} attempt(s) left.`
      );
    }
  } finally {
    rl.close();
  }
  throw new DvmError(
    "backup_unconfirmed",
    "Could not confirm mnemonic backup after 3 attempts.",
    "The wallet was not saved. Re-run 'dvm wallet init' once you've written the words down."
  );
}

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

function mnemonicValidationError(
  result: Exclude<ReturnType<typeof validateAgentMnemonic>, { ok: true }>
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
      'Check that word for a typo — BIP-39 words are at most 4 letters distinguishing, so a near-miss like "abandom" vs "abandon" is the usual culprit.'
    );
  }
  return new DvmError(
    "invalid_mnemonic",
    "Mnemonic checksum failed.",
    'All 12 words are valid BIP-39 words but the checksum doesn\'t match — one word is likely a near-miss (e.g. "abandon" vs "about"). Re-check each word against your written backup.'
  );
}
