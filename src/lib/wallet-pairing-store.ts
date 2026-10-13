import { DvmError, ensureConfigSubdir, PAIRINGS_DIR } from "@dvmkit/sdk/internal";
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";
import { z } from "zod";

import { walletPairingManifestSchema } from "./wallet-pairing";

const pairingIdPattern = /^[0-9a-f]{64}$/;

const stateSchema = z
  .object({
    version: z.literal(1),
    pairing_id: z.string().regex(pairingIdPattern),
    recipient_private_key: z.string().regex(/^[0-9a-f]{64}$/),
    polling_verifier: z.string().regex(/^[0-9a-f]{64}$/),
    manifest: walletPairingManifestSchema,
    replacement: z
      .object({
        event_id: z.string().regex(/^[0-9a-f]{64}$/),
        current_wallet_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
        candidate_facts: z.record(z.string(), z.unknown()),
      })
      .strict()
      .optional(),
    commit: z
      .object({
        event_id: z.string().regex(/^[0-9a-f]{64}$/),
        candidate_wallet_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
        candidate_facts: z.record(z.string(), z.unknown()),
      })
      .strict()
      .optional(),
  })
  .strict();

export type WalletPairingState = z.infer<typeof stateSchema>;

/** Persist a newly-created pairing without overwriting a colliding id. */
export function createWalletPairingState(state: WalletPairingState): void {
  ensurePairingsDirectory();
  const path = pairingPath(state.pairing_id);
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

export function loadWalletPairingState(pairingId: string): WalletPairingState {
  const path = pairingPath(pairingId);
  if (!existsSync(path)) {
    throw new DvmError(
      "wallet_pairing_not_found",
      "No local state exists for that wallet pairing.",
      "Run 'dvm wallet pair' to create a fresh private link."
    );
  }
  try {
    return stateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new DvmError(
      "wallet_pairing_state_invalid",
      "The local wallet-pairing state is corrupt or from an unsupported version.",
      `Delete ${path} and run 'dvm wallet pair' again.`
    );
  }
}

/** Atomically replace one pairing state file, preserving mode 0600. */
export function saveWalletPairingState(state: WalletPairingState): void {
  stateSchema.parse(state);
  ensurePairingsDirectory();
  const path = pairingPath(state.pairing_id);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  try {
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw err;
  }
}

/** Delete local pairing state after save and relay acknowledgement. */
export function deleteWalletPairingState(pairingId: string): void {
  const path = pairingPath(pairingId);
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Opportunistically remove local pairings whose signed manifest expired. */
export function cleanupExpiredWalletPairingStates(
  nowSeconds = Math.floor(Date.now() / 1_000)
): number {
  if (!existsSync(PAIRINGS_DIR)) return 0;
  let removed = 0;
  for (const name of readdirSync(PAIRINGS_DIR)) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    const path = join(PAIRINGS_DIR, name);
    try {
      const state = stateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      if (state.manifest.expires_at <= nowSeconds) {
        unlinkSync(path);
        removed += 1;
      }
    } catch {
      // A malformed file is not silently deleted; load gives the actionable error.
    }
  }
  return removed;
}

/** Serialise completion attempts for one pairing, including wait-mode polling. */
export async function withWalletPairingLock<T>(
  pairingId: string,
  fn: () => Promise<T> | T
): Promise<T> {
  const path = pairingPath(pairingId);
  if (!existsSync(path)) return fn();
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(path, {
      lockfilePath: `${path}.lock`,
      realpath: false,
      stale: 12 * 60 * 1_000,
      update: 20_000,
      retries: { retries: 2, factor: 1, minTimeout: 250, maxTimeout: 250 },
    });
  } catch {
    throw new DvmError(
      "wallet_pairing_busy",
      "Another process is already completing this wallet pairing.",
      "Let the existing command finish; do not start a second completion."
    );
  }
  try {
    return await fn();
  } finally {
    await release().catch(() => undefined);
  }
}

function pairingPath(pairingId: string): string {
  if (!pairingIdPattern.test(pairingId)) {
    throw new DvmError(
      "invalid_wallet_pairing_id",
      "Wallet pairing id must be 64 lowercase hexadecimal characters."
    );
  }
  return join(PAIRINGS_DIR, `${pairingId}.json`);
}

function ensurePairingsDirectory(): void {
  ensureConfigSubdir(PAIRINGS_DIR);
  chmodSync(PAIRINGS_DIR, 0o700);
}
