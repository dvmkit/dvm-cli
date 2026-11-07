import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";

import { ensureConfigDir, JOBS_FILE, type AgentProof, type PersistedOutputData } from "@dvmkit/sdk/internal";

import { journalFile } from "./journal-file";

export interface ReleaseIntent {
  id: string;
  builderHandle: string;
  mint: string;
  walletPubkey: string;
  lockPubkey: string | null;
  keysetId: string;
  inputs: AgentProof[];
  outputs: PersistedOutputData[];
  createdAt: number;
}

// Submission reclaim cleanup removes records without pending submissions.
// Reserve releases have no submission, so their recovery data lives separately.
const intents = journalFile<ReleaseIntent>("release-intents.json");

/** Serialize release/recovery across mint I/O without holding the wallet lock. */
export async function withReleaseLock<T>(walletPubkey: string, builderHandle: string, mint: string, operation: () => Promise<T>): Promise<T> {
  ensureConfigDir();
  const key = createHash("sha256").update(JSON.stringify([walletPubkey, builderHandle, mint])).digest("hex");
  let unlock: () => Promise<void>;
  try {
    // proper-lockfile also keys its in-process ownership by the target path.
    unlock = await lockfile.lock(join(dirname(JOBS_FILE), `release-${key}`), {
      realpath: false,
      stale: 2 * 60_000,
      retries: 0,
    });
  } catch {
    throw new Error("Could not acquire the release lock; another release may be running for this builder and mint. Retry `dvm wallet release` shortly.");
  }
  try { return await operation(); } finally {
    try { await unlock(); } catch { /* a stale lock expires; recovery data is retained separately */ }
  }
}

export function allReleaseIntents(): ReleaseIntent[] {
  return intents.read();
}

export function loadReleaseIntent(walletPubkey: string, builderHandle: string, mint: string): ReleaseIntent | undefined {
  return intents.read().find((intent) =>
    intent.walletPubkey === walletPubkey && intent.builderHandle === builderHandle && intent.mint === mint
  );
}

export function recordReleaseIntent(intent: ReleaseIntent): void {
  intents.withLock(() => {
    if (loadReleaseIntent(intent.walletPubkey, intent.builderHandle, intent.mint)) {
      throw new Error("Another release is awaiting recovery; retry `dvm wallet release`.");
    }
    intents.write([...intents.read(), intent]);
  });
}

export function clearReleaseIntent(intent: ReleaseIntent): void {
  intents.withLock(() => intents.write(intents.read().filter((held) => held.id !== intent.id)));
}
