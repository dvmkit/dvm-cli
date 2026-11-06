import { loadAgentWallet } from "@dvmkit/sdk/internal";
import { blockHeldPayment, heldCashuSubmissionAsks, releaseReclaimedSubmissions } from "../job-store";
import { settleTakenPayment } from "../taken-payment";
import { journalFile } from "./journal-file";
import { allReclaimIntents, clearReclaimIntent } from "./reclaim-intents";

/**
 * What a submission sweep proved about a wallet entry it dropped. The wallet
 * keeps no record of a reclaim, so this journal carries the verdict to any job
 * ask still holding that token until it has been applied.
 */
export interface SubmissionVerdict {
  requestId: string;
  verdict: "reclaimed" | "spent" | "partly_spent";
  /** The token was reserve proofs, which could have been spent for another call. */
  reserve?: true;
  spentSats?: number;
  amountSats?: number;
}

const verdictJournal = journalFile<SubmissionVerdict>("submission-verdicts.json");
const readVerdicts = verdictJournal.read;
const withVerdictsLock = verdictJournal.withLock;
const writeVerdicts = verdictJournal.write;

/** Journal verdicts before the wallet save that drops their entries. */
export function recordSubmissionVerdicts(verdicts: SubmissionVerdict[]): void {
  if (verdicts.length === 0) return;
  withVerdictsLock(() => {
    const journalled = readVerdicts();
    // A reclaim whose wallet save failed leaves the entry for the next sweep,
    // which then sees the reclaim's own swap as spent proofs. The reclaim is
    // the truth: the provider was never paid with this token.
    const reclaimed = new Set(journalled.filter((verdict) => verdict.verdict === "reclaimed").map((verdict) => verdict.requestId));
    const incoming = verdicts.filter((verdict) => !reclaimed.has(verdict.requestId));
    const ids = new Set(incoming.map((verdict) => verdict.requestId));
    writeVerdicts([...journalled.filter((verdict) => !ids.has(verdict.requestId)), ...incoming]);
  });
}

/**
 * Apply journalled verdicts whose wallet save landed (the wallet no longer
 * holds the entry), then drop them. Safe to run again after a failure: a
 * verdict leaves the journal only once applied.
 */
export async function applySubmissionVerdicts(): Promise<void> {
  // A reclaim that cannot be journalled yet must not hold back the verdicts
  // already journalled, so run both and report the first failure.
  let failure: { error: unknown } | undefined;
  try { finalizeLandedReclaims(); } catch (error) { failure = { error }; }
  try { await applyJournalledVerdicts(); } catch (error) { failure ??= { error }; }
  if (failure) throw failure.error;
}

async function applyJournalledVerdicts(): Promise<void> {
  const journalled = readVerdicts();
  if (journalled.length === 0) return;
  const held = new Set(loadAgentWallet()?.pending_submissions.map((entry) => entry.request_id) ?? []);
  const landed = journalled.filter((verdict) => !held.has(verdict.requestId));
  if (landed.length === 0) return;
  releaseReclaimedSubmissions(new Set(landed.filter((verdict) => verdict.verdict === "reclaimed").map((verdict) => verdict.requestId)));
  for (const verdict of landed) {
    if (verdict.verdict === "reclaimed") continue;
    for (const ask of heldCashuSubmissionAsks(new Set([verdict.requestId]))) {
      // A token the provider kept as credit is drainable balance when it is
      // redeemed, not a payment of the ask; its block and drain hint stay.
      if (ask.blocked?.reason === "credit_held") continue;
      // Freshly swapped outputs only ever went to this ask's provider, so all
      // of them spent means it redeemed this token.
      if (verdict.verdict === "spent" && !verdict.reserve) await settleTakenPayment(ask.jobId, ask.requestSeq);
      else blockHeldPayment(ask.jobId, ask.requestSeq, { reason: "proofs_spent",
        detail: verdict.verdict === "partly_spent"
          ? `The provider redeemed ${verdict.spentSats ?? "part"} of the ${verdict.amountSats ?? "?"} sats in the earlier token, and the wallet took back the rest; that is not a payment of this charge.`
          : "The reserve proofs the earlier token used are spent at the mint and the provider recorded no payment for this charge, but it may already have redeemed this token for this charge, so paying again may pay twice." });
    }
  }
  const applied = new Set(landed.map((verdict) => verdict.requestId));
  withVerdictsLock(() => writeVerdicts(readVerdicts().filter((verdict) => !applied.has(verdict.requestId))));
}

/**
 * Journal the verdict of every reclaim whose wallet save landed (the entry has
 * left the wallet) and drop its intent. A crash or write failure between the
 * save and the journal write leaves the intent behind, so the next read
 * finishes the job; the intent is only dropped once its verdict is journalled.
 * Throws on a journal failure, with the intent kept for the next attempt.
 */
export function finalizeLandedReclaims(): void {
  const intents = allReclaimIntents();
  if (intents.length === 0) return;
  const wallet = loadAgentWallet();
  if (!wallet) return;
  const held = new Set(wallet.pending_submissions.map((entry) => entry.request_id));
  for (const intent of intents) {
    if (held.has(intent.requestId)) continue;
    recordSubmissionVerdicts([intent.verdict]);
    clearReclaimIntent(intent.requestId);
  }
}
