import type { PersistedOutputData } from "@dvmkit/sdk/internal";

import { journalFile } from "./journal-file";
import type { SubmissionVerdict } from "./submission-verdicts";

/**
 * What a reclaim swap needs to be finished after a crash. Written before the
 * mint call: the swap spends the old proofs at the mint the moment it
 * succeeds, and the new proofs exist nowhere else until the wallet is saved.
 * Mirrors the spend path's `swapping` record, which the wallet schema has no
 * field for on a reclaim.
 */
export interface ReclaimIntent {
  requestId: string;
  mint: string;
  keysetId: string;
  lockPubkey: string;
  /** Blinded outputs of the swap, enough to ask the mint for their signatures again. */
  outputs: PersistedOutputData[];
  /** Secrets of the proofs the swap consumes, to tell "never committed" from "committed". */
  inputSecrets: string[];
  /** Sats the provider had already redeemed from this entry, booked when the reclaim lands. */
  spentSats: number;
  /** The verdict a job ask holding this token needs once the reclaim has landed. */
  verdict: SubmissionVerdict;
  createdAt: string;
}

const intents = journalFile<ReclaimIntent>("reclaim-intents.json");

export function recordReclaimIntent(intent: ReclaimIntent): void {
  intents.withLock(() => {
    intents.write([...intents.read().filter((held) => held.requestId !== intent.requestId), intent]);
  });
}

export function loadReclaimIntent(requestId: string): ReclaimIntent | undefined {
  return intents.read().find((intent) => intent.requestId === requestId);
}

export function allReclaimIntents(): ReclaimIntent[] {
  return intents.read();
}

export function clearReclaimIntent(requestId: string): void {
  if (!loadReclaimIntent(requestId)) return;
  intents.withLock(() => intents.write(intents.read().filter((held) => held.requestId !== requestId)));
}

/** Request ids whose reclaim result the wallet may not hold yet. */
export function reclaimIntentIds(): Set<string> {
  return new Set(intents.read().map((intent) => intent.requestId));
}
