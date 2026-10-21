import type { SignedRequestDomain } from "@dvmkit/sdk";
import { dvmFetch } from "../http";
/**
 * Resume with the original payment token, request ID and body. Descriptor-auth
 * bodies are freshly signed because request timestamps expire before the
 * resume window; payment idempotency is independent of signature nonce.
 *
 * Refund-clause outputs can instead be reclaimed after locktime. NUT-07 checks
 * for a late provider redemption first, and the mint arbitrates any race.
 * Bodyless legacy and mid-job entries remain visible rather than being dropped.
 */

import {
  Amount,
  CheckStateEnum,
  getEncodedToken,
  type Proof,
  type Token,
  type Wallet,
} from "@cashu/cashu-ts";

import { deriveAgentRefundSubkey } from "@dvmkit/sdk/internal";
import { missingDleqRecoveryDiagnostic } from "@dvmkit/sdk/internal";
import { swapFeeForProofs } from "@dvmkit/sdk/internal";
import { getWallet } from "@dvmkit/sdk/internal";
import {
  findSigningIdentityByPubkey,
} from "../cli-identity-resolve";
import { signDvmRequestData } from "@dvmkit/sdk/internal";
import { readFundValuation } from "@dvmkit/sdk/internal";
import { loadCredit, recordBalanceResponse, recordFundResponse } from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";
import {
  type JobRecord,
  loadJob,
  saveJob,
  updateJob,
} from "../job-store";
import { sameEndpoint } from "../job-access";
import { requestRecoveryPath } from "../request-recovery-path";
import { isFundingReceipt } from "@dvmkit/sdk/internal";
import {
  captureFundingReceipt,
} from "../receipt-capture";
import { ROUTER_FEEDBACK_CLAIM_HEADER } from "@dvmkit/sdk/internal";

import type { CreditWire } from "@dvmkit/sdk/internal";
import { readAgentMnemonic } from "@dvmkit/sdk/internal";
import { inFlightTimeoutSeconds, proofKey, revertInFlight } from "./inflight";
import { rehydrateOutputData } from "@dvmkit/sdk/internal";
import { toAgentProof, toCashuProofs } from "@dvmkit/sdk/internal";
import {
  abandonSubmissionInWallet,
  correctPendingFundAmount,
  markPendingSubmissionUnresolved,
  withAcceptedUnresolved,
} from "./spend";
import {
  identityError,
  type IdentityObservation,
  isOpaqueJobToken,
  jobIdentityHeaderValue,
  routerConflictObservation,
  settleJobIdentity,
  withIdentityRecovery,
} from "../job-identity";
import {
  journalMarkerFor,
  loadSubmissionEvidence,
  recordLocalJobCollision,
  recordSubmissionEvidence,
} from "../submission-evidence";
import {
  type AgentProof,
  type AgentRecentSpend,
  type AgentWallet,
  canonicalRequestPath,
  isPublicRequestId,
  loadAgentWallet,
  type PendingSubmission,
  type PendingSubmissionAcceptedUnresolved,
  RECENT_SPENDS_CAP,
  saveAgentWallet,
  withWalletLock,
} from "@dvmkit/sdk/internal";
import {
  cashuSubmissionBindingFingerprint,
  cashuSubmissionBindingFromContext,
} from "@dvmkit/sdk/internal";
import { bindCashuTokenToSubmissionContext } from "@dvmkit/sdk/internal";

/**
 * How long an entry stays eligible for a resume attempt. Past this, re-POSTing
 * a days-old job body would run work the caller has long since given up on, so
 * the entry goes `stale`: kept and surfaced, never re-shipped.
 */
export const RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Resume attempts before an entry is declared `stale`. */
export const RESUME_MAX_ATTEMPTS = 5;

export type SubmissionSweepOutcome =
  | { kind: "shipped"; entry: PendingSubmission; jobId?: string }
  | { kind: "already_accepted"; entry: PendingSubmission }
  | { kind: "abandoned"; entry: PendingSubmission; reason: string }
  | { kind: "still_pending"; entry: PendingSubmission; reason: string }
  /** Pre-swap crash whose inputs the in-flight sweep has since recovered. Entry dropped. */
  | { kind: "pruned"; entry: PendingSubmission }
  /** Pre-swap crash still inside the in-flight window. Entry kept, untouched. */
  | { kind: "no_swap"; entry: PendingSubmission }
  | {
      kind: "swap_restored";
      entry: PendingSubmission;
      outputs: AgentProof[];
      keep: AgentProof[];
      cashuToken: string;
    }
  | { kind: "swap_reverted"; entry: PendingSubmission }
  /**
   * Accepted by the provider without a settled job identity. Never POSTed
   * again; the marker is already on disk. `evidence` is `missing` when the
   * marker names a record that is not there, and `unreadable` when the record
   * is there but damaged.
   */
  | {
      kind: "accepted_unresolved";
      entry: PendingSubmission;
      marker: PendingSubmissionAcceptedUnresolved;
      evidence: "recorded" | "missing" | "unreadable";
      /** Set when this pass observed the failure. */
      observation?: IdentityObservation;
    }
  /**
   * An unmarked entry whose evidence record exists but cannot be read. A
   * record means an earlier pass may have seen the payment accepted, so the
   * entry is held with no POST until the file is restored. Entry kept.
   */
  | { kind: "evidence_unreadable"; entry: PendingSubmission }
  | { kind: "swap_recovery_pending"; entry: PendingSubmission; reason: string }
  | { kind: "stale"; entry: PendingSubmission; reason: string }
  /** No way to re-POST the call — no persisted body, or the signing key is gone. Entry kept and surfaced. */
  | { kind: "unresumable"; entry: PendingSubmission }
  /**
   * Past-locktime outputs the DVM never redeemed, swapped back to spendable via
   * the NUT-11 refund path. Entry dropped, `outputs` credited.
   */
  | {
      kind: "reclaimed";
      entry: PendingSubmission;
      outputs: AgentProof[];
      reclaimed_sats: number;
      /**
       * Value the DVM had already taken out of this entry, in sats — non-zero
       * only on a partial redeem. Recorded as a `recent_spend` so the two halves
       * of a split entry are both accounted for.
       */
      spent_sats: number;
    }
  /**
   * The reclaim window is open but the swap didn't happen — mint unreachable,
   * proofs still PENDING, no mnemonic, or the mint's fee would eat the whole
   * value. The reason is persisted onto the entry (`reclaim_error`) so the read
   * side stops promising a self-heal that isn't happening; the next sweep tries
   * again.
   */
  | {
      kind: "reclaim_skipped";
      entry: PendingSubmission;
      reason: string;
      /**
       * Whether retrying is pointless rather than merely unlucky. Set for the
       * sub-fee guard and for legacy proofs whose mint-required DLEQ evidence
       * cannot be reconstructed. Persisted as `reclaim_terminal` so the read
       * side does not promise a retry that cannot work.
       */
      terminal: boolean;
    };

export interface SubmissionSweepResult {
  outcomes: SubmissionSweepOutcome[];
}

export interface SubmissionSweepOptions {
  /**
   * Override the HTTP POST. Returns the response status, parsed JSON body (or
   * `null` when it could not be read or parsed), any router-issued feedback
   * claim, and the raw `DVM-Job-Identity-V1` value. The default uses `fetch`.
   */
  httpPost?: (req: { url: string; headers: Record<string, string>; body: string }) => Promise<{
    status: number;
    body: Record<string, unknown> | null;
    feedbackClaim?: string;
    jobIdentity?: string | null;
  }>;
  /**
   * Override the `fetch` the default HTTP POST calls; the global `fetch` by
   * default. A consumer that wraps `fetch` to raise its own `DvmError` — the
   * caller CLI turns an HTTP 426 into `client_upgrade_required` this way — gets
   * that error back unchanged rather than flattened into `provider_unreachable`.
   */
  fetchImpl?: typeof fetch;
  now?: () => number;
  getWalletForMint?: (mintUrl: string) => Promise<Wallet>;
  readMnemonic?: () => string | null;
}

export interface RecoverPendingSubmissionOptions extends SubmissionSweepOptions {
  /** Exact UUID from `X-Cashu-Request-Id`. */
  requestId: string;
  /** Approved request-binding hash; no endpoint/amount heuristic is accepted. */
  bindingFingerprint: string;
}

/** Safe result of one exact recovery attempt; never contains tokens, proofs, or signatures. */
export interface RecoverPendingSubmissionResult {
  requestId: string;
  outcome: "shipped" | "already_accepted" | "pending";
  jobId: string | null;
  attemptCount: 1;
}

/**
 * Reconcile every entry in `wallet.pending_submissions[]` against its DVM.
 * Returns a structured summary so callers can surface what was recovered.
 * Network errors are non-fatal — affected entries are kept on the list for
 * the next sweep.
 *
 * A resumed call that the DVM accepts writes a local `JobRecord`, so the
 * caller gets a job id back and can `dvm status` / `dvm messages` against it
 * Without that, even a successful re-ship left the caller with a
 * debited wallet and no handle on what it had bought.
 *
 * The sweep does not perform `wrong_lock_pubkey` rotation-retry or
 * `proof_pending` backoff — those policies live in the fresh-call path
 * where the caller has access to the transport for `/v1/info` refetch.
 * Here we make a single best-effort re-ship per entry; ambiguous outcomes
 * leave the entry in place for the next call.
 */
export async function sweepPendingSubmissions(
  opts: SubmissionSweepOptions = {}
): Promise<SubmissionSweepResult> {
  const wallet = loadAgentWallet();
  if (!wallet || wallet.pending_submissions.length === 0) {
    return { outcomes: [] };
  }

  const deps: SweepDeps = {
    httpPost: opts.httpPost ?? createDefaultHttpPost(opts.fetchImpl ?? dvmFetch),
    getWalletForMint: opts.getWalletForMint ?? getWallet,
    readMnemonic: opts.readMnemonic ?? readAgentMnemonic,
    lockPubkey: wallet.lock_pubkey,
    persistUnresolved: async (entry, observation) => {
      const marker = journalMarkerFor(recordSubmissionEvidence(evidenceInput(entry, observation)));
      await markPendingSubmissionUnresolved({ requestId: entry.request_id, marker });
      return marker;
    },
  };
  const now = opts.now ?? (() => Date.now());

  const { entries, unreadable } = await reconcileEvidenceMarkers(wallet);
  const outcomes: SubmissionSweepOutcome[] = [];
  for (const entry of entries) {
    outcomes.push(await resolveEntry(entry, deps, now(), unreadable.has(entry.request_id)));
  }

  if (outcomes.some(mutatesWallet)) {
    await withWalletLock(() => {
      const fresh = loadAgentWallet() ?? wallet;
      const next = outcomes.reduce<AgentWallet>(
        (acc, outcome) => applyOutcome(acc, outcome, now),
        fresh
      );
      saveAgentWallet(next);
    });
  }

  return { outcomes };
}

/**
 * Recover one strict per-call submission by exact UUID and exact request binding.
 *
 * The wallet lock is held from lookup through the same-ID POST and final journal
 * update. The attempt marker is persisted before network I/O, so a crash can
 * never authorize a second attempt. Unrelated entries are copied byte-for-byte.
 */
export async function recoverPendingSubmission(
  opts: RecoverPendingSubmissionOptions
): Promise<RecoverPendingSubmissionResult> {
  if (!UUID_V4_RE.test(opts.requestId))
    throw new DvmError("invalid_request_id", "The pending-submission request id must be a UUIDv4.");
  if (!SHA256_RE.test(opts.bindingFingerprint))
    throw new DvmError(
      "invalid_submission_binding",
      "The pending-submission binding fingerprint must be lowercase SHA-256 hex."
    );

  return withWalletLock(async () => {
    const wallet = loadAgentWallet();
    if (!wallet)
      throw new DvmError("wallet_missing", "No agent wallet found.", "Run: dvm wallet init");
    const matches = wallet.pending_submissions.filter(
      (entry) => entry.request_id === opts.requestId
    );
    if (matches.length !== 1)
      throw new DvmError(
        "submission_not_found",
        `No unique pending submission exists for request ${opts.requestId}.`,
        "Inspect the journal with: dvm wallet submissions"
      );
    const entry = matches[0];
    const binding = entry.context && cashuSubmissionBindingFromContext(entry.context);
    const recomputed = binding ? cashuSubmissionBindingFingerprint(binding) : null;
    if (
      entry.context?.binding_fingerprint !== opts.bindingFingerprint ||
      recomputed !== opts.bindingFingerprint
    )
      throw new DvmError(
        "submission_binding_mismatch",
        "The saved submission does not match the approved strict request binding.",
        "Do not recover by endpoint, mint, or amount. Rebuild evidence for the exact saved request."
      );
    const evidence = entry.accepted_unresolved ? null : loadSubmissionEvidence(entry.request_id);
    // A record with no marker is a crash between the two writes. The lock is
    // already held, so the marker is written here directly.
    if (evidence)
      saveAgentWallet(withAcceptedUnresolved(wallet, entry.request_id, journalMarkerFor(evidence)));
    if (entry.accepted_unresolved || evidence)
      throw new DvmError(
        "submission_accepted_unresolved",
        "The provider already accepted this submission without stating a settled job identity.",
        "Do not pay for or resubmit this request. Run 'dvm wallet submissions' to see the recorded evidence and how to read the job.",
        {
          request_id: entry.request_id,
          ambiguity_id: entry.accepted_unresolved?.ambiguity_id ?? entry.request_id,
        }
      );
    if (entry.output_proofs.length === 0 || entry.swapping)
      throw new DvmError(
        "submission_not_ready",
        "The exact submission has no completed payment output to recover.",
        "Use read-only NUT-09/NUT-07 reconciliation for the interrupted swap."
      );
    if ((entry.attempts ?? 0) !== 0)
      throw new DvmError(
        "submission_recovery_exhausted",
        "The exact strict submission already consumed its one recovery attempt.",
        "Use read-only receipt and job lookup; do not re-submit the payment."
      );

    const now = opts.now ?? (() => Date.now());
    const attempted: PendingSubmission = {
      ...entry,
      attempts: 1,
      last_attempt_at: new Date(now()).toISOString(),
    };
    saveAgentWallet({
      ...wallet,
      pending_submissions: wallet.pending_submissions.map((candidate) =>
        candidate.request_id === opts.requestId ? attempted : candidate
      ),
    });

    const outcome = await shipEntry(
      attempted,
      opts.httpPost ?? createDefaultHttpPost(opts.fetchImpl ?? dvmFetch),
      // This function already holds the wallet lock, which is not reentrant.
      async (target, observation) => {
        const marker = journalMarkerFor(
          recordSubmissionEvidence(evidenceInput(target, observation))
        );
        const current = loadAgentWallet() ?? wallet;
        saveAgentWallet(withAcceptedUnresolved(current, target.request_id, marker));
        return marker;
      }
    );
    if (outcome.kind === "accepted_unresolved") {
      const observation = outcome.observation ?? { kind: outcome.marker.kind };
      throw withIdentityRecovery(identityError(observation), {
        ambiguityId: outcome.marker.ambiguity_id,
        cashuRequestId: entry.request_id,
        ...publicRequestIdField(entry),
      });
    }
    if (outcome.kind === "shipped" || outcome.kind === "already_accepted") {
      const current = loadAgentWallet() ?? wallet;
      saveAgentWallet(applyOutcome(current, outcome, now));
      return {
        requestId: opts.requestId,
        outcome: outcome.kind,
        jobId: outcome.kind === "shipped" ? (outcome.jobId ?? null) : null,
        attemptCount: 1,
      };
    }

    return { requestId: opts.requestId, outcome: "pending", jobId: null, attemptCount: 1 };
  });
}

/**
 * Book the journal entries a request recovered through `dvm request-result`
 * had paid for: the provider has named the accepted job, so the payment is
 * confirmed, including on an entry held as accepted without a settled job
 * identity. Returns the wallet request IDs booked.
 */
export async function bookRecoveredSubmissions(args: {
  publicRequestId: string;
  endpoint: string;
  jobId: string;
  now?: () => number;
}): Promise<string[]> {
  const matches = (wallet: AgentWallet | null) =>
    (wallet?.pending_submissions ?? []).filter(
      (entry) =>
        entry.output_proofs.length > 0 &&
        publicRequestIdOf(entry) === args.publicRequestId &&
        sameEndpoint(entry.endpoint, args.endpoint)
    );
  if (matches(loadAgentWallet()).length === 0) return [];
  const now = args.now ?? (() => Date.now());
  return withWalletLock(() => {
    const fresh = loadAgentWallet();
    const booked = matches(fresh);
    if (!fresh || booked.length === 0) return [];
    saveAgentWallet(
      booked.reduce<AgentWallet>(
        (acc, entry) => applyOutcome(acc, { kind: "shipped", entry, jobId: args.jobId }, now),
        fresh
      )
    );
    return booked.map((entry) => entry.request_id);
  });
}

/**
 * Whether the sweep can still re-POST this entry. False for entries with no
 * persisted body (legacy, and mid-job `payment` spends), and for signed
 * calls whose caller identity is no longer in `~/.dvm/identities.json` — the
 * body can be rebuilt but not re-signed as the caller who paid.
 *
 * Exported so the read-side view (`dvm wallet show`, `dvm doctor`) states the
 * same thing the sweep will actually do, rather than promising a retry that
 * cannot happen.
 */
export function isResumable(entry: PendingSubmission): boolean {
  return resumeBody(entry) !== null;
}

/**
 * Wall-clock ms at which this entry's outputs become reclaimable by the wallet
 * itself, or `null` when the payment carries no refund clause.
 *
 * Exported so the read-side view (`dvm wallet show`, `dvm wallet submissions`)
 * can promise a self-heal only where the sweep will actually deliver one.
 */
export function reclaimAtMs(entry: PendingSubmission): number | null {
  if (entry.output_proofs.length === 0) return null;
  if (!entry.canonical_id || typeof entry.t_expire !== "number") return null;
  return entry.t_expire;
}

/** What {@link resolveEntry} needs from the outside world. */
interface SweepDeps {
  httpPost: NonNullable<SubmissionSweepOptions["httpPost"]>;
  getWalletForMint: (mintUrl: string) => Promise<Wallet>;
  readMnemonic: () => string | null;
  /** The agent's master pubkey — reclaimed outputs are locked back to it. */
  lockPubkey: string;
  persistUnresolved: PersistUnresolved;
}

/**
 * Write the evidence record, then the journal marker, before the outcome is
 * reported. Returns the marker written.
 */
type PersistUnresolved = (
  entry: PendingSubmission,
  observation: IdentityObservation
) => Promise<PendingSubmissionAcceptedUnresolved>;

async function resolveEntry(
  entry: PendingSubmission,
  deps: SweepDeps,
  nowMs: number,
  evidenceUnreadable: boolean
): Promise<SubmissionSweepOutcome> {
  // Once a swap preview exists, elapsed time is not evidence that the mint did
  // or did not commit. Restore the exact blinded outputs through NUT-09, then
  // fall back to NUT-07 only to prove that every input is still UNSPENT.
  if (entry.output_proofs.length === 0) {
    const inFlightWindowMs = inFlightTimeoutSeconds() * 1000;
    if (entry.swapping) {
      return ageMs(entry, nowMs) >= inFlightWindowMs
        ? recoverPreparedSwap(entry, deps)
        : { kind: "no_swap", entry };
    }
    // A crash before the preview was persisted is known not to have reached
    // the mint. The ordinary in-flight timeout returns its inputs.
    return ageMs(entry, nowMs) >= inFlightWindowMs
      ? { kind: "pruned", entry }
      : { kind: "no_swap", entry };
  }

  // The refund window is open. Checked before resume eligibility,
  // but it can only be reached long after the resume window closed — the
  // locktime is deliberately the longer of the two — so this never pre-empts a
  // re-ship to a DVM that is merely slow.
  const reclaimAt = reclaimAtMs(entry);
  if (reclaimAt !== null && nowMs >= reclaimAt) {
    return reclaimEntry(entry, deps);
  }

  // Accepted without a settled job identity: the payment may have landed under
  // a job this caller cannot name, so no POST may repeat it.
  if (entry.accepted_unresolved) {
    return {
      kind: "accepted_unresolved",
      entry,
      marker: entry.accepted_unresolved,
      evidence: evidenceState(entry.accepted_unresolved.ambiguity_id),
    };
  }
  if (evidenceUnreadable) return { kind: "evidence_unreadable", entry };

  // Legacy and mid-job entries have no POST body; missing identities cannot re-sign.
  if (!isResumable(entry)) {
    return { kind: "unresumable", entry };
  }

  if (ageMs(entry, nowMs) > RESUME_MAX_AGE_MS) {
    return { kind: "stale", entry, reason: "older than the resume window" };
  }
  if ((entry.attempts ?? 0) >= RESUME_MAX_ATTEMPTS) {
    return { kind: "stale", entry, reason: `no response after ${RESUME_MAX_ATTEMPTS} attempts` };
  }

  return shipEntry(entry, deps.httpPost, deps.persistUnresolved);
}

/** Recover a swap whose mint response may have been lost after commit. */
async function recoverPreparedSwap(
  entry: PendingSubmission,
  deps: SweepDeps
): Promise<SubmissionSweepOutcome> {
  const swapping = entry.swapping;
  if (!swapping) return { kind: "pruned", entry };

  let cashuWallet: Wallet;
  try {
    cashuWallet = await deps.getWalletForMint(entry.mint);
  } catch (err) {
    return { kind: "swap_recovery_pending", entry, reason: errorText(err) };
  }

  let sendData: ReturnType<typeof rehydrateOutputData>;
  let keepData: ReturnType<typeof rehydrateOutputData>;
  try {
    sendData = rehydrateOutputData(swapping.send_outputs);
    keepData = rehydrateOutputData(swapping.keep_outputs);
  } catch (err) {
    return { kind: "swap_recovery_pending", entry, reason: errorText(err) };
  }
  const allData = [...sendData, ...keepData];
  let restoreError: string | undefined;
  try {
    const restored = await cashuWallet.mint.restore({
      outputs: allData.map((data) => data.blindedMessage),
    });
    if (restored.outputs.length !== restored.signatures.length) {
      return {
        kind: "swap_recovery_pending",
        entry,
        reason: "mint returned mismatched NUT-09 outputs and signatures",
      };
    }
    const signaturesByOutput = new Map(
      restored.outputs.map((output, index) => [output.B_, restored.signatures[index]])
    );
    if (
      allData.length > 0 &&
      allData.every((data) => signaturesByOutput.has(data.blindedMessage.B_))
    ) {
      const restoreGroup = (data: typeof allData): Proof[] =>
        data.map((output) => {
          const signature = signaturesByOutput.get(output.blindedMessage.B_);
          if (!signature) throw new Error("mint omitted a restored output");
          if (signature.id !== swapping.keyset_id) {
            throw new Error("mint restored an output under an unexpected keyset");
          }
          return output.toProof(signature, cashuWallet.keyChain.getKeyset(swapping.keyset_id));
        });
      const send = restoreGroup(sendData);
      const keep = restoreGroup(keepData);
      const cashuToken = getEncodedToken({ mint: entry.mint, proofs: send });
      return {
        kind: "swap_restored",
        entry,
        outputs: send.map((proof) => toAgentProof(proof, entry.mint, entry.intended_lock_pubkey)),
        keep: keep.map((proof) => toAgentProof(proof, entry.mint, deps.lockPubkey)),
        cashuToken,
      };
    }
    if (restored.outputs.length > 0) {
      return {
        kind: "swap_recovery_pending",
        entry,
        reason: "mint restored only part of the interrupted swap",
      };
    }
  } catch (err) {
    // A legacy mint may not expose NUT-09. NUT-07 can still prove a definite
    // rejection when every input remains UNSPENT, so continue to that check.
    restoreError = errorText(err);
  }

  try {
    const states = await cashuWallet.checkProofsStates(toCashuProofs(swapping.input_proofs));
    if (
      states.length === swapping.input_proofs.length &&
      states.every((state) => state.state === CheckStateEnum.UNSPENT)
    ) {
      return { kind: "swap_reverted", entry };
    }
    return {
      kind: "swap_recovery_pending",
      entry,
      reason: restoreError
        ? `NUT-09 restore failed (${restoreError}); mint still reports the interrupted swap inputs spent or pending`
        : "mint still reports the interrupted swap inputs spent or pending",
    };
  } catch (err) {
    return { kind: "swap_recovery_pending", entry, reason: errorText(err) };
  }
}

/**
 * Swap a past-locktime entry's outputs back to spendable over the NUT-11 refund
 * path. Modelled on `releaseAtMint`; the deltas are that the proofs
 * come off `pending_submissions[].output_proofs` rather than `wallet.proofs[]`,
 * and that success clears the submission entry.
 *
 * NUT-7 checkstate runs first and settles the race with a late-redeeming DVM at
 * the mint rather than in policy: proofs the DVM already swapped read SPENT, and
 * the entry clears as `already_accepted` — the money was earned. Whatever
 * survives the check is submitted, and the mint's single-spend rule arbitrates
 * anything that moved in between.
 *
 * Every failure comes back as `reclaim_skipped` rather than throwing: the sweep
 * runs opportunistically inside `dvm wallet show` and every paid call, and a
 * mint outage must not take those down. Nothing is committed on the failure
 * path — the swap is atomic — so the entry is simply retried next sweep. The
 * reason is persisted to `entry.reclaim_error` all the same: a reclaim that
 * fails every pass is money the caller is owed and isn't getting, and it must
 * not go on reading as a payment quietly on its way back.
 */
async function reclaimEntry(
  entry: PendingSubmission,
  deps: SweepDeps
): Promise<SubmissionSweepOutcome> {
  const skipped = (reason: string, terminal = false): SubmissionSweepOutcome => ({
    kind: "reclaim_skipped",
    entry,
    reason,
    terminal,
  });

  const mnemonic = deps.readMnemonic();
  if (!mnemonic) {
    return skipped(
      "no mnemonic at ~/.dvm/wallet.mnemonic, so the refund key can't be derived — restore it with `dvm wallet recover`"
    );
  }
  let refundPrivkey: string;
  try {
    const refund = deriveAgentRefundSubkey(mnemonic, entry.canonical_id ?? "");
    // A mismatch means this wallet's mnemonic isn't the one that paid. The
    // mint would reject the witness anyway; saying so here is the difference
    // between an actionable message and an opaque swap error.
    if (entry.refund_pubkey && entry.refund_pubkey !== refund.pubkey) {
      return skipped(
        "this wallet's mnemonic does not derive the refund key the payment was locked to"
      );
    }
    refundPrivkey = refund.privkey;
  } catch (err) {
    return skipped(errorText(err));
  }

  let cashuWallet: Wallet;
  try {
    cashuWallet = await deps.getWalletForMint(entry.mint);
  } catch (err) {
    return skipped(errorText(err));
  }

  let grouped;
  try {
    grouped = await cashuWallet.groupProofsByState(toCashuProofs(entry.output_proofs));
  } catch (err) {
    return skipped(errorText(err));
  }
  const spentSecrets = new Set(grouped.spent.map((p) => p.secret));
  const pendingSecrets = new Set(grouped.pending.map((p) => p.secret));
  const spent = entry.output_proofs.filter((p) => spentSecrets.has(p.secret));
  const pending = entry.output_proofs.filter((p) => pendingSecrets.has(p.secret));
  const unspent = entry.output_proofs.filter(
    (p) => !spentSecrets.has(p.secret) && !pendingSecrets.has(p.secret)
  );
  if (unspent.length === 0) {
    // Nothing left to reclaim. All-SPENT means the DVM redeemed after all —
    // that's an accepted payment, not a loss. Anything PENDING is mid-flight at
    // the mint; leave the entry for the next sweep.
    return pending.length > 0
      ? skipped("the mint still reports these proofs in flight")
      : { kind: "already_accepted", entry };
  }
  // A split entry: some proofs settled at the mint, the rest are still ours to
  // take. Reclaiming the remainder now would drop the entry and with it the
  // record of what is still moving, so wait for the mint to settle instead —
  // one sweep later this reads as a clean all-SPENT or all-unspent entry.
  if (pending.length > 0) {
    return skipped("the mint still reports some of these proofs in flight");
  }

  // Everything below tolerates a spent/unspent split. No dvmkit SDK path
  // produces one — a DVM redeems the token whole, in a single atomic swap — but
  // the mint permits a partial spend and money code shouldn't rest on a
  // counterparty's implementation. The spent half is the DVM's earned payment
  // and is booked as a `recent_spend`; only the rest comes back.
  const totalSats = unspent.reduce((sum, p) => sum + p.amount, 0);
  const inputs = toCashuProofs(unspent);
  let outputs: Proof[];
  try {
    // No `includeFees` here, unlike the spend: the agent is both sender and
    // receiver, so the only fee is this swap's own and it comes off the top.
    const swapFeeSats = swapFeeForProofs(cashuWallet, inputs);
    const allowance = reclaimFeeAllowance(entry);
    if (!allowance.ok) {
      return skipped(allowance.reason, true);
    }
    if (allowance.remainingSats !== null && swapFeeSats > allowance.remainingSats) {
      return skipped(
        `the initial swap used ${allowance.initialSats} sats of this job's ${allowance.maxSats}-sat Cashu fee ceiling, leaving a ${allowance.remainingSats}-sat allowance; the mint's ${swapFeeSats}-sat recovery swap fee exceeds that remainder`,
        true
      );
    }
    const reclaimSats = totalSats - swapFeeSats;
    if (reclaimSats <= 0) {
      // Surfaced as still-stranded, deliberately: burning the whole value to
      // move it is worse than leaving it visible (the 2-sat field entries).
      // Terminal — the fee is a property of the mint's keyset, not of this
      // moment, so the next sweep would reach the identical conclusion.
      return skipped(
        `worth ${totalSats} sats, which does not cover the mint's ${swapFeeSats}-sat swap fee`,
        true
      );
    }
    const result = await cashuWallet.ops
      .send(reclaimSats, inputs)
      .privkey(refundPrivkey)
      .asP2PK({ pubkey: deps.lockPubkey })
      .run();
    outputs = result.send;
  } catch (err) {
    const diagnostic = missingDleqRecoveryDiagnostic(inputs, err);
    return skipped(diagnostic ?? errorText(err), diagnostic !== null);
  }

  return {
    kind: "reclaimed",
    entry,
    outputs: outputs.map((p) => toAgentProof(p, entry.mint, deps.lockPubkey)),
    reclaimed_sats: outputs.reduce((sum, p) => sum + Amount.from(p.amount).toNumber(), 0),
    spent_sats: spent.reduce((sum, p) => sum + p.amount, 0),
  };
}

type ReclaimFeeAllowance =
  | {
      ok: true;
      maxSats: number | null;
      initialSats: number;
      remainingSats: number | null;
    }
  | { ok: false; reason: string };

function reclaimFeeAllowance(entry: PendingSubmission): ReclaimFeeAllowance {
  const maxSats = entry.max_cashu_fee_sats;
  const contextMaxSats = entry.context?.max_cashu_fee_sats;
  const initialSats = entry.initial_cashu_fee_sats;
  const contextInitialSats = entry.context?.initial_cashu_fee_sats;

  if (maxSats === undefined) {
    if (contextMaxSats !== undefined) {
      return {
        ok: false,
        reason: "the saved submission's Cashu fee ceiling is missing from its money journal",
      };
    }
    if (
      (initialSats !== undefined && !isNonNegativeSafeInteger(initialSats)) ||
      (contextInitialSats !== undefined && !isNonNegativeSafeInteger(contextInitialSats)) ||
      (initialSats !== undefined &&
        contextInitialSats !== undefined &&
        initialSats !== contextInitialSats)
    ) {
      return {
        ok: false,
        reason: "the saved submission's initial Cashu fee accounting is invalid",
      };
    }
    return {
      ok: true,
      maxSats: null,
      initialSats: initialSats ?? contextInitialSats ?? 0,
      remainingSats: null,
    };
  }

  if (!isNonNegativeSafeInteger(maxSats)) {
    return { ok: false, reason: "the saved submission's Cashu fee ceiling is invalid" };
  }
  if (!isNonNegativeSafeInteger(initialSats)) {
    return {
      ok: false,
      reason: "the capped saved submission is missing valid initial Cashu fee accounting",
    };
  }
  if (entry.context && (contextMaxSats !== maxSats || contextInitialSats !== initialSats)) {
    return {
      ok: false,
      reason: "the saved submission's Cashu fee accounting disagrees with its request context",
    };
  }
  if (initialSats > maxSats) {
    return {
      ok: false,
      reason: "the saved submission's initial Cashu fee exceeds its job-wide ceiling",
    };
  }
  return {
    ok: true,
    maxSats,
    initialSats,
    remainingSats: maxSats - initialSats,
  };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;

async function shipEntry(
  entry: PendingSubmission,
  httpPost: NonNullable<SubmissionSweepOptions["httpPost"]>,
  persistUnresolved: PersistUnresolved
): Promise<SubmissionSweepOutcome> {
  const unresolved = async (observation: IdentityObservation): Promise<SubmissionSweepOutcome> => ({
    kind: "accepted_unresolved",
    entry,
    marker: await persistUnresolved(entry, observation),
    evidence: "recorded",
    observation,
  });
  // Prefer the verbatim token string persisted at swap time: a
  // fund-and-draw's signed commitment is sha256 over exactly those bytes, and
  // a re-encode from proofs is byte-identical only by library convention.
  // Earlier entries carry no token string and fall back to re-encoding.
  const token: Token = { mint: entry.mint, proofs: toCashuProofs(entry.output_proofs) };
  const cashuToken = entry.cashu_token ?? getEncodedToken(token);
  // Mirror HttpsTransport.submit exactly: the same wire body the original
  // submit sent, plus the Cashu payment headers. A body-less POST is rejected
  // at input validation before the DVM ever reaches the payment gate.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Cashu": cashuToken,
    "X-Cashu-Request-Id": entry.request_id,
  };
  const route = entry.context?.route === "credit" ? "/v1/credit" : "/v1/job";

  // A submit that carried a public request ID is read back through
  // request-result before its paid body is sent again: a provider that already
  // claimed the ID answers a re-POST with `request_id_exists`, which names no
  // job. Only a `request_not_found` falls through to the re-POST, which carries
  // the same token, so it can never be a second payment.
  const { publicRequestId } = publicRequestIdField(entry);
  if (publicRequestId && route === "/v1/job") {
    const readBack = await readBackByRequestId(entry, publicRequestId, httpPost, unresolved);
    if (readBack) return readBack;
  }

  // `active` is the entry as re-signed *this* pass: identical to the persisted
  // one except after a fund-amount correction, which rewrites one field of the
  // fund block. The loop runs at most twice.
  let active = entry;
  let correctedOnce = false;
  for (;;) {
    const body = resumeBody(active);
    if (!body) return { kind: "unresumable", entry };

    let response;
    try {
      response = await httpPost({
        url: `${entry.endpoint}${route}`,
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      return {
        kind: "still_pending",
        entry,
        reason: `network error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (response.status >= 200 && response.status < 300) {
      if (entry.context?.route === "credit") {
        applyResumedCreditFund(entry, response.body);
        return { kind: "shipped", entry };
      }
      const identity = settleJobIdentity(response.jobIdentity ?? null, response.body);
      if (identity.kind === "unresolved") return unresolved(identity.observation);
      if (active.context) {
        const record = jobRecordFromEntry(active, identity.jobId, response.body,
          identity.claimAllowed ? response.feedbackClaim : undefined);
        const existing = loadJob(identity.jobId);
        if (existing) {
          if (!sameEndpoint(existing.endpoint, active.endpoint) ||
              (existing.requestId !== undefined && existing.requestId !== record.requestId))
            return { kind: "still_pending", entry, reason: `recovery conflict: job ${identity.jobId} is already a different local job` };
          updateJob(identity.jobId, {
            ...recoveredCreditBinding(active),
            ...(record.requestId ? { requestId: record.requestId } : {}),
            ...(record.jobToken && !existing.jobToken ? { jobToken: record.jobToken } : {}),
          });
        } else saveJob(record);
      }
      await reconcileResumedJobCredit(active, response.body, httpPost);
      return { kind: "shipped", entry, jobId: identity.jobId };
    }
    // Checked before the generic 409 below, which would book the spend and
    // drop the entry as an ordinary replay.
    const conflict = routerConflictObservation(response.status, response.body);
    if (conflict) return unresolved(conflict);
    if (response.status === 409) {
      // A 409 whose body cannot be read says nothing about a replay; the
      // payment may have landed under a job this caller cannot name.
      if (!errorCodeOf(response.body)) return unresolved({ kind: "body_unreadable" });
      // The ID is claimed, possibly by a first POST still in flight. The next
      // pass reads the job back through request-result; booking the spend now
      // would drop the only handle on it.
      if (publicRequestId) {
        return { kind: "still_pending", entry, reason: errorCodeOf(response.body) ?? "http 409" };
      }
    }
    // Older servers return 409 without the original job: payment still belongs
    // to the provider, so clear the journal rather than ship it again.
    if (response.status === 409 || response.body?.error === "replay_rejected") {
      // The fund leg of that original submit committed too, so its provisional
      // record is as stale here as on the 2xx above.
      await reconcileResumedJobCredit(active, response.body, httpPost);
      return { kind: "already_accepted", entry };
    }
    const errCode = typeof response.body?.error === "string" ? response.body.error : null;

    // FX can change the provider valuation while the entry is pending. This
    // pre-commit refusal permits one corrected signature over the same token.
    if (errCode === "funding_commitment_mismatch") {
      if (!correctedOnce) {
        const correction = await correctFundAmount(active, response.body);
        if (correction.kind === "corrected") {
          correctedOnce = true;
          active = correction.entry;
          continue;
        }
        // The provider stated no valuation at all: the commitment-hash branch
        // of this code. The fund can never land under this signed body, so
        // surface it loudly rather than retry forever.
        if (correction.kind === "permanent") {
          return { kind: "abandoned", entry, reason: errCode };
        }
      }
      // Either refused again on the corrected figure, or refused while stating
      // a valuation we can't act on (malformed, or the one we already signed).
      // The fx moved twice, or the provider disagrees for a reason it isn't
      // stating. Nothing committed either way, so keep the entry: the next
      // sweep corrects against a fresh figure, and the attempt/age gates
      // surface it as `stale` rather than silently dropping the sats.
      return { kind: "still_pending", entry, reason: errCode };
    }
    // Hard rejections we can't recover from. wrong_lock_pubkey on a resume
    // means rotation has aged out the pubkey — dead capital. payment_invalid
    // means the DVM permanently rejected; same.
    if (
      errCode === "wrong_lock_pubkey" ||
      errCode === "not_p2pk_locked" ||
      errCode === "payment_invalid" ||
      errCode === "proof_not_unspent" ||
      // Credit-route permanent refusals: the fund can never land
      // under this signed body.
      errCode === "credit_id_unavailable" ||
      errCode === "caller_mismatch" ||
      errCode === "credit_not_supported"
    ) {
      return { kind: "abandoned", entry, reason: errCode };
    }
    return {
      kind: "still_pending",
      entry,
      reason: errCode ?? `http ${response.status}`,
    };
  }
}

/**
 * Read a public-ID submission back through the signed, read-only
 * request-result route. Null when the provider holds no accepted job for the ID
 * or the body cannot be signed, which leaves the paid re-POST to run.
 */
async function readBackByRequestId(
  entry: PendingSubmission,
  requestId: string,
  httpPost: NonNullable<SubmissionSweepOptions["httpPost"]>,
  unresolved: (observation: IdentityObservation) => Promise<SubmissionSweepOutcome>
): Promise<SubmissionSweepOutcome | null> {
  const body = requestResultBody(entry, requestId);
  if (!body) return null;
  let response;
  try {
    response = await httpPost({
      url: `${entry.endpoint}/${requestRecoveryPath("request-result", requestId)}`,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { kind: "still_pending", entry, reason: `network error: ${errorText(err)}` };
  }
  if (response.status === 404 && errorCodeOf(response.body) === "request_not_found") return null;
  if (response.status >= 200 && response.status < 300) {
    // An answer for another request names no job of this one.
    if (response.body && response.body.request_id !== requestId) {
      return unresolved({ kind: "body_unreadable" });
    }
    const identity = settleJobIdentity(response.jobIdentity ?? null, response.body);
    if (identity.kind === "unresolved") return unresolved(identity.observation);
    const saved = saveRecoveredJob(entry, identity.jobId, response.body, requestId);
    if (saved !== "saved") {
      // The recovered job's token goes to evidence, the one place it can be
      // read from without displacing the local job.
      const kept =
        saved === "foreign_endpoint"
          ? recordLocalJobCollision({
              ...entryEvidenceContext(entry),
              publicRequestId: requestId,
              jobId: identity.jobId,
              jobToken: response.body?.job_token,
            })
          : null;
      return {
        kind: "still_pending",
        entry,
        reason: `request_result_conflict: job ${identity.jobId} is already a different local job${kept ? `; the recovered job is kept as evidence ${kept.ambiguity_id}` : ""}`,
      };
    }
    await reconcileResumedJobCredit(entry, response.body, httpPost);
    return { kind: "shipped", entry, jobId: identity.jobId };
  }
  const conflict = routerConflictObservation(response.status, response.body);
  if (conflict) return unresolved(conflict);
  return {
    kind: "still_pending",
    entry,
    reason: `request-result: ${errorCodeOf(response.body) ?? `http ${response.status}`}`,
  };
}

/** The original wire body, signed for the request-result route of its own request ID. */
function requestResultBody(
  entry: PendingSubmission,
  requestId: string
): Record<string, unknown> | null {
  const ctx = entry.context;
  if (!ctx || ctx.route === "credit" || !ctx.signing_pubkey || !ctx.auth_domain) return null;
  const signer = findSigningIdentityByPubkey(ctx.signing_pubkey);
  if (!signer) return null;
  const unsigned = (ctx.submit_body.data as Record<string, unknown> | undefined) ?? {};
  const path = canonicalRequestPath(
    new URL(
      requestRecoveryPath("request-result", requestId),
      `${entry.endpoint.replace(/\/$/, "")}/`
    ).href
  );
  return {
    ...ctx.submit_body,
    data: signDvmRequestData(signer.privkey, unsigned, { ...ctx.auth_domain, path }),
  };
}

/**
 * Store a job read back by request ID, as `dvm request-result` does: no router
 * claim, linked to the public ID. A local job with the ID from another endpoint
 * or another request is never overwritten.
 */
function saveRecoveredJob(
  entry: PendingSubmission,
  jobId: string,
  body: Record<string, unknown> | null,
  requestId: string
): "saved" | "foreign_endpoint" | "other_request" {
  const token = body?.job_token;
  const jobToken = isOpaqueJobToken(token) ? token : undefined;
  const existing = loadJob(jobId);
  if (existing) {
    if (!sameEndpoint(existing.endpoint, entry.endpoint)) return "foreign_endpoint";
    if (existing.requestId !== undefined && existing.requestId !== requestId) return "other_request";
    updateJob(jobId, {
      ...recoveredCreditBinding(entry),
      requestId,
      ...(jobToken && !existing.jobToken ? { jobToken } : {}),
    });
    return "saved";
  }
  const { jobToken: _unchecked, ...record } = jobRecordFromEntry(entry, jobId, body, undefined);
  saveJob({ ...record, requestId, ...(jobToken ? { jobToken } : {}) });
  return "saved";
}

/** The machine code of an error body: `error` as a string, or `error.code`. */
function errorCodeOf(body: Record<string, unknown> | null): string | null {
  const error = body?.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === "string") return code;
  }
  return null;
}

type FundCorrection =
  | { kind: "corrected"; entry: PendingSubmission }
  | { kind: "hold" }
  | { kind: "permanent" };

/**
 * Rewrite a job-route entry's signed `fund.amount_micro` to the provider's own
 * valuation, off a `funding_commitment_mismatch` body.
 *
 * `hold` and `permanent` are deliberately distinct. Dropping an
 * entry burns output proofs that are P2PK-locked to the DVM — reclaimable only
 * once their locktime passes, and not at all on a clause-less entry — so that
 * is only ever right when the provider stated no valuation —
 * the commitment-hash branch, which no re-sign can fix. A provider that states
 * a valuation we can't act on (malformed, or the figure we already signed) is
 * on the amount branch and misbehaving; the entry is kept and surfaced.
 *
 * The write to disk happens BEFORE the corrected body goes on the wire, exactly
 * as the in-flight belt does it (`payWithAgentWallet`): a crash between the two
 * must leave the sweep re-shipping the provider's figure, not the one it has
 * already refused. The token — and therefore `fund.commitment` — is untouched.
 *
 * `/v1/credit` top-ups never reach here as anything but `permanent`: that route
 * checks the commitment hash only, never the amount.
 */
async function correctFundAmount(
  entry: PendingSubmission,
  body: Record<string, unknown> | null
): Promise<FundCorrection> {
  const ctx = entry.context;
  if (!ctx || ctx.route === "credit") return { kind: "permanent" };
  const data = ctx.submit_body.data as Record<string, unknown> | undefined;
  const fund = data?.fund as Record<string, unknown> | undefined;
  if (!data || !fund) return { kind: "permanent" };

  const valuation = readFundValuation({
    expectedMicro: body?.expected_micro,
    message: typeof body?.message === "string" ? body.message : undefined,
  });
  if (valuation.kind === "absent") return { kind: "permanent" };
  if (valuation.kind === "malformed") return { kind: "hold" };
  const expected = valuation.micro;
  if (expected === fund.amount_micro) return { kind: "hold" };

  await correctPendingFundAmount({ requestId: entry.request_id, amountMicro: expected });
  // Mirrors the persisted correction: the public request ID stays bound to the
  // refused data, so the corrected block is sent without it.
  const { request_id: _requestId, ...rest } = data;
  return {
    kind: "corrected",
    entry: {
      ...entry,
      context: {
        ...ctx,
        submit_body: {
          ...ctx.submit_body,
          data: { ...rest, fund: { ...fund, amount_micro: expected } },
        },
      },
    },
  };
}

/**
 * The wire body for one resume attempt, or `null` when the entry can't be
 * shipped at all. Signed calls are re-signed here — freshly, on every attempt —
 * because the DVM checks timestamp drift (~5 minutes) at request entry, before
 * it ever looks at the payment.
 */
function resumeBody(entry: PendingSubmission): Record<string, unknown> | null {
  const ctx = entry.context;
  if (!ctx) return null;
  // Credit-route entry: the whole `/v1/credit` op body is the
  // signed envelope. Idempotent server-side on the signed `(credit_id,
  // fund_id)`, so a freshly signed replay is exact.
  if (ctx.route === "credit") {
    const domain = ctx.auth_domain;
    if (!ctx.credit_body || !ctx.signing_pubkey || !domain) return null;
    const signer = findSigningIdentityByPubkey(ctx.signing_pubkey);
    if (!signer) return null;
    return signDvmRequestData(signer.privkey, ctx.credit_body, domain);
  }
  if (!ctx.signing_pubkey) return ctx.submit_body;
  const domain = ctx.auth_domain;
  if (!domain) return null;

  const signer = findSigningIdentityByPubkey(ctx.signing_pubkey);
  if (!signer) return null;
  const unsigned = (ctx.submit_body.data as Record<string, unknown> | undefined) ?? {};
  return { ...ctx.submit_body, data: signDvmRequestData(signer.privkey, unsigned, domain) };
}

/**
 * Verify and store a resumed funding's signed tuple before adopting its credit
 * projection. A missing/malformed receipt or tuple mismatch still permits the
 * live figures as explicitly unsequenced state; a locked credit store leaves
 * the projection untouched. Neither may cost the sweep its settled outcome.
 */
function applyResumedCreditFund(
  entry: PendingSubmission,
  body: Record<string, unknown> | null
): boolean {
  const pubkey = entry.context?.signing_pubkey;
  const credit = isCreditWire(body?.credit) ? body.credit : undefined;
  const rawReceipt = body?.funding_receipt;
  const receipt = isFundingReceipt(rawReceipt) ? rawReceipt : undefined;
  if (!pubkey || !credit) return false;
  const ctx = entry.context;
  const request = fundingRequest(entry);
  if (!ctx || !request) return false;
  const mutableReplay = ctx.route === "credit" && body?.replayed === true;
  const verification = captureFundingReceipt({
    receipt,
    ...(rawReceipt !== undefined && !receipt ? { parseError: "shape_invalid" as const } : {}),
    endpoint: entry.endpoint,
    ...(ctx.builder ? { builder: ctx.builder } : {}),
    expectedCreditId: credit.credit_id,
    expectedFundId: request.fundId,
    expectedFundedMicro:
      typeof body?.funded_micro === "number" ? body.funded_micro : request.amountMicro,
    ...(mutableReplay
      ? {}
      : {
          expectedBalanceAfterMicro: credit.remaining_micro,
          expectedLedgerSeq: credit.ledger_seq,
        }),
    expectedCallerPubkey: pubkey,
  });
  const sequenced =
    !mutableReplay && (verification === "verified" || verification === "verified_unattested");
  try {
    // Keyed by origin alone. The journal's `dvm_id` is what the DVM asserted
    // about itself, and a self-asserted identity may not select a credit row
    // nor does it need to here: this submission was posted to
    // `entry.endpoint`, so that origin is already in the row's own set.
    const stored = loadCredit(entry.endpoint, pubkey);
    recordFundResponse({
      endpoint: entry.endpoint,
      callerPubkey: pubkey,
      credit,
      targetMicro: stored?.targetMicro ?? credit.remaining_micro,
      sequenced,
    });
  } catch {
    return false;
  }
  return true;
}

function fundingRequest(
  entry: PendingSubmission
): { fundId: string; amountMicro?: number } | undefined {
  const ctx = entry.context;
  if (!ctx) return undefined;
  const data =
    ctx.route === "credit"
      ? ctx.credit_body
      : (ctx.submit_body.data as Record<string, unknown> | undefined);
  const fund = data?.fund as Record<string, unknown> | undefined;
  if (!fund) return undefined;
  const fundId = ctx.route === "credit" ? fund.fund_id : entry.request_id;
  if (typeof fundId !== "string") return undefined;
  return {
    fundId,
    ...(typeof fund.amount_micro === "number" ? { amountMicro: fund.amount_micro } : {}),
  };
}

/**
 * Reconcile the projection after a resumed fund-and-draw landed on `/v1/job`
 *
 * `ensureProvisionalCredit` writes a zero placeholder before the original
 * submit. Current servers return the persisted funding receipt and its exact
 * pre-draw credit snapshot even on a 202/replay; the recovery journal carries
 * the original builder anchor, so that tuple can be verified offline. Older
 * servers fall back to one signed balance request, whose live response is
 * useful but remains explicitly unsequenced until a later receipt anchors it.
 *
 * Best-effort end to end, exactly as {@link applyResumedCreditFund} is: the
 * money question is already settled by the DVM's 2xx, and no failure here may
 * change the entry's outcome.
 */
async function reconcileResumedJobCredit(
  entry: PendingSubmission,
  body: Record<string, unknown> | null,
  httpPost: NonNullable<SubmissionSweepOptions["httpPost"]>
): Promise<void> {
  const ctx = entry.context;
  if (!ctx || ctx.route === "credit") return;
  const data = ctx.submit_body.data as Record<string, unknown> | undefined;
  if (!data || (!data.fund && typeof data.credit_id !== "string")) return;
  if (applyResumedCreditFund(entry, body)) return;
  // The read costs a round trip, so spend it on the state that needs one: a
  // record still carrying the placeholder this CLI wrote before the submit.
  // Anything else is already the server's word, or no projection at all. A
  // store this process cannot read — a lock another one holds —
  // answers the same way as a settled record: leave it to `dvm credit balance`.
  const pubkey = ctx.signing_pubkey;
  if (!pubkey) return;
  try {
    if (loadCredit(entry.endpoint, pubkey)?.provisional !== true) return;
  } catch {
    return;
  }
  await readResumedCreditBalance(entry, httpPost).catch(() => undefined);
}

/** Legacy fallback: read live balance state and retain it as explicitly unsequenced. */
async function readResumedCreditBalance(
  entry: PendingSubmission,
  httpPost: NonNullable<SubmissionSweepOptions["httpPost"]>
): Promise<void> {
  const pubkey = entry.context?.signing_pubkey;
  if (!pubkey) return;
  const signer = findSigningIdentityByPubkey(pubkey);
  const storedDomain = entry.context?.auth_domain;
  if (!signer || !storedDomain) return;
  const domain = creditOperationDomain(storedDomain);
  if (!domain) return;
  const response = await httpPost({
    url: `${entry.endpoint}/v1/credit`,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signDvmRequestData(signer.privkey, { op: "balance" }, domain)),
  });
  if (response.status < 200 || response.status >= 300) return;
  const credits = (Array.isArray(response.body?.credits) ? response.body.credits : []).filter(
    isCreditWire
  );
  const primary = isCreditWire(response.body?.credit) ? response.body.credit : undefined;
  if (!primary && credits.length === 0) return;
  recordBalanceResponse({
    endpoint: entry.endpoint,
    callerPubkey: pubkey,
    credits,
    ...(primary ? { primary } : {}),
    sequenced: false,
  });
}

function creditOperationDomain(domain: SignedRequestDomain): SignedRequestDomain | null {
  const jobSuffix = "/v1/job";
  if (!domain.path.endsWith(jobSuffix)) return null;
  const mount = domain.path.slice(0, -jobSuffix.length);
  return {
    audience: domain.audience,
    method: "POST",
    path: `${mount}/v1/credit`,
    capability: null,
  };
}

function isCreditWire(value: unknown): value is CreditWire {
  if (typeof value !== "object" || value === null) return false;
  const credit = value as Partial<CreditWire>;
  return typeof credit.credit_id === "string" && typeof credit.remaining_micro === "number";
}

/** Only the persisted signed submit can identify this accepted draw and its owner. */
function recoveredCreditBinding(entry: PendingSubmission): Pick<JobRecord, "creditBinding"> {
  const ctx = entry.context;
  const data = ctx?.submit_body.data as Record<string, unknown> | undefined;
  if (ctx?.route === "credit" || !ctx?.signing_pubkey ||
      typeof data?.credit_id !== "string" || !data.credit_id ||
      typeof data.draw_id !== "string" || !data.draw_id) return {};
  return { creditBinding: { creditId: data.credit_id, drawId: data.draw_id, callerPubkey: ctx.signing_pubkey } };
}

function jobRecordFromEntry(
  entry: PendingSubmission,
  jobId: string,
  body: Record<string, unknown> | null,
  feedbackClaim: string | undefined
): JobRecord {
  const ctx = entry.context;
  const { publicRequestId } = publicRequestIdField(entry);
  return {
    id: jobId,
    endpoint: entry.endpoint,
    ...recoveredCreditBinding(entry),
    ...(publicRequestId ? { requestId: publicRequestId } : {}),
    ...(ctx?.dvm_id ? { dvmId: ctx.dvm_id } : {}),
    ...(feedbackClaim ? { feedbackClaim } : {}),
    ...(ctx?.capability ? { capability: ctx.capability } : {}),
    status: "submitted",
    submittedAt: Date.parse(entry.created_at) || Date.now(),
    paymentMethod: "cashu",
    ...(ctx?.pinned_mint ? { pinnedMint: ctx.pinned_mint } : {}),
    ...(ctx?.policy ? { policy: ctx.policy } : {}),
    ...(ctx?.strict_per_call ? { strictPerCall: true as const } : {}),
    ...(ctx?.max_cashu_fee_sats !== undefined ? { maxCashuFeeSats: ctx.max_cashu_fee_sats } : {}),
    // the per-job token an anonymous caller needs on every later read.
    ...(typeof body?.job_token === "string" ? { jobToken: body.job_token } : {}),
  };
}

function mutatesWallet(outcome: SubmissionSweepOutcome): boolean {
  // A skip only writes when the reason is new — an unreachable mint says the
  // same thing on every pass, and `dvm wallet show` runs a sweep every time.
  if (outcome.kind === "reclaim_skipped") {
    return (
      outcome.entry.reclaim_error !== outcome.reason ||
      (outcome.entry.reclaim_terminal ?? false) !== outcome.terminal
    );
  }
  return (
    outcome.kind === "shipped" ||
    outcome.kind === "already_accepted" ||
    outcome.kind === "abandoned" ||
    outcome.kind === "pruned" ||
    outcome.kind === "swap_restored" ||
    outcome.kind === "swap_reverted" ||
    outcome.kind === "still_pending" ||
    outcome.kind === "reclaimed"
  );
}

function applyOutcome(
  wallet: AgentWallet,
  outcome: SubmissionSweepOutcome,
  now: () => number
): AgentWallet {
  const drop = (): AgentWallet => ({
    ...wallet,
    pending_submissions: wallet.pending_submissions.filter(
      (s) => s.request_id !== outcome.entry.request_id
    ),
  });

  if (outcome.kind === "shipped" || outcome.kind === "already_accepted") {
    const recentSpend: AgentRecentSpend = {
      request_id: outcome.entry.request_id,
      dvm_endpoint: outcome.entry.endpoint,
      mint: outcome.entry.mint,
      amount_sats: outcome.entry.amount_sats,
      signed_at_ms: now(),
    };
    const dropped = drop();
    return {
      ...dropped,
      recent_spends: [...dropped.recent_spends, recentSpend].slice(-RECENT_SPENDS_CAP),
    };
  }
  if (outcome.kind === "abandoned") {
    return abandonSubmissionInWallet(wallet, {
      requestId: outcome.entry.request_id,
      preserveRecovery: true,
    });
  }
  if (outcome.kind === "pruned") {
    return drop();
  }
  if (outcome.kind === "swap_restored") {
    const swapping = outcome.entry.swapping;
    if (!swapping) return wallet;
    const trackedKeys = new Set(
      [...swapping.input_proofs, ...swapping.unselected_proofs].map((proof) => proofKey(proof))
    );
    const boundContext = bindCashuTokenToSubmissionContext(
      outcome.entry.context,
      outcome.cashuToken
    );
    return {
      ...wallet,
      proofs: [
        ...wallet.proofs.filter((proof) => !trackedKeys.has(proofKey(proof))),
        ...swapping.unselected_proofs.map((proof) => ({
          ...proof,
          status: "valid" as const,
          in_flight_until_ms: undefined,
        })),
        ...outcome.keep,
      ],
      pending_submissions: wallet.pending_submissions.map((submission) =>
        submission.request_id === outcome.entry.request_id
          ? {
              ...submission,
              output_proofs: outcome.outputs,
              cashu_token: outcome.cashuToken,
              swapping: undefined,
              ...(boundContext ? { context: boundContext } : {}),
            }
          : submission
      ),
    };
  }
  if (outcome.kind === "swap_reverted") {
    const swapping = outcome.entry.swapping;
    if (!swapping) return drop();
    const trackedKeys = new Set(
      [...swapping.input_proofs, ...swapping.unselected_proofs].map((proof) => proofKey(proof))
    );
    const reverted = revertInFlight(wallet, trackedKeys);
    return {
      ...reverted,
      pending_submissions: reverted.pending_submissions.filter(
        (submission) => submission.request_id !== outcome.entry.request_id
      ),
    };
  }
  if (outcome.kind === "reclaimed") {
    // The inputs were the DVM's locked outputs and never lived in
    // `wallet.proofs`, so there is nothing to filter out — only the fresh
    // refund-swap outputs to credit.
    const dropped = drop();
    const credited: AgentWallet = { ...dropped, proofs: [...dropped.proofs, ...outcome.outputs] };
    // A partial redeem: the DVM took part of this entry before the rest
    // expired. That half is an earned payment and gets its own ledger row, so
    // dropping the entry doesn't erase it.
    if (outcome.spent_sats <= 0) return credited;
    const partialSpend: AgentRecentSpend = {
      request_id: outcome.entry.request_id,
      dvm_endpoint: outcome.entry.endpoint,
      mint: outcome.entry.mint,
      amount_sats: outcome.spent_sats,
      signed_at_ms: now(),
    };
    return {
      ...credited,
      recent_spends: [...credited.recent_spends, partialSpend].slice(-RECENT_SPENDS_CAP),
    };
  }
  if (outcome.kind === "still_pending") {
    return {
      ...wallet,
      pending_submissions: wallet.pending_submissions.map((s) =>
        s.request_id === outcome.entry.request_id
          ? {
              ...s,
              attempts: (s.attempts ?? 0) + 1,
              last_attempt_at: new Date(now()).toISOString(),
            }
          : s
      ),
    };
  }
  if (outcome.kind === "reclaim_skipped") {
    return {
      ...wallet,
      pending_submissions: wallet.pending_submissions.map((s) =>
        s.request_id === outcome.entry.request_id
          ? { ...s, reclaim_error: outcome.reason, reclaim_terminal: outcome.terminal }
          : s
      ),
    };
  }
  return wallet;
}

function ageMs(entry: PendingSubmission, nowMs: number): number {
  const created = Date.parse(entry.created_at);
  // An unparseable timestamp must not read as "brand new" — that would pin the
  // entry in the resume loop forever. Treat it as maximally old.
  if (Number.isNaN(created)) return Number.POSITIVE_INFINITY;
  return nowMs - created;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function createDefaultHttpPost(
  fetchImpl: typeof fetch
): NonNullable<SubmissionSweepOptions["httpPost"]> {
  return async function defaultHttpPost(req: {
    url: string;
    headers: Record<string, string>;
    body: string;
  }) {
    let res: Response;
    try {
      res = await fetchImpl(req.url, { method: "POST", headers: req.headers, body: req.body });
    } catch (err) {
      // A `DvmError` raised by the injected `fetch` is already the accurate
      // diagnosis and is rethrown as it stands. Re-wrapping it would report a
      // refused client version as an unreachable provider, and the caller would
      // retry a call that can never succeed until it upgrades.
      if (err instanceof DvmError) throw err;
      throw new DvmError(
        "provider_unreachable",
        `Could not reach ${req.url}: ${err instanceof Error ? err.message : String(err)}`,
        "Retry once the DVM is reachable again."
      );
    }
    const jobIdentity = jobIdentityHeaderValue(res.headers);
    let body: Record<string, unknown> | null;
    try {
      const parsed: unknown = await res.json();
      body =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
    } catch {
      body = null;
    }
    const feedbackClaim = res.headers.get(ROUTER_FEEDBACK_CLAIM_HEADER) ?? undefined;
    return {
      status: res.status,
      body,
      jobIdentity,
      ...(feedbackClaim ? { feedbackClaim } : {}),
    };
  };
}

/**
 * Before any POST, put every journal entry and its evidence record back in
 * step. A record with no marker is a crash between the two writes: the marker
 * is written from the record. A marker with no record is reported by
 * {@link resolveEntry} as missing evidence. Neither is ever re-POSTed.
 */
async function reconcileEvidenceMarkers(
  wallet: AgentWallet
): Promise<{ entries: PendingSubmission[]; unreadable: Set<string> }> {
  // A damaged record holds back only its own entry; every other entry is swept.
  const unreadable = new Set<string>();
  const orphaned = wallet.pending_submissions.flatMap((entry) => {
    if (entry.accepted_unresolved) return [];
    try {
      const record = loadSubmissionEvidence(entry.request_id);
      return record ? [{ requestId: entry.request_id, marker: journalMarkerFor(record) }] : [];
    } catch {
      unreadable.add(entry.request_id);
      return [];
    }
  });
  if (orphaned.length === 0) return { entries: wallet.pending_submissions, unreadable };
  return withWalletLock(() => {
    const fresh = loadAgentWallet() ?? wallet;
    const next = orphaned.reduce<AgentWallet>(
      (acc, { requestId, marker }) => withAcceptedUnresolved(acc, requestId, marker),
      fresh
    );
    saveAgentWallet(next);
    return { entries: next.pending_submissions, unreadable };
  });
}

function evidenceState(ambiguityId: string): "recorded" | "missing" | "unreadable" {
  try {
    return loadSubmissionEvidence(ambiguityId) ? "recorded" : "missing";
  } catch {
    return "unreadable";
  }
}

function evidenceInput(entry: PendingSubmission, observation: IdentityObservation) {
  return { ...entryEvidenceContext(entry), observation, ...publicRequestIdField(entry) };
}

/** What every evidence record about a journal entry carries. */
function entryEvidenceContext(entry: PendingSubmission) {
  const ctx = entry.context;
  return {
    endpoint: entry.endpoint,
    ...(ctx?.dvm_id ? { dvmId: ctx.dvm_id } : {}),
    ...(ctx?.capability ? { capability: ctx.capability } : {}),
    cashuRequestId: entry.request_id,
    rail: "cashu" as const,
    railCorrelation: { mint: entry.mint, amount_sats: entry.amount_sats },
  };
}

/** The public request ID the original submit signed, when it carried one. */
export function publicRequestIdOf(entry: PendingSubmission): string | undefined {
  const data = entry.context?.submit_body.data;
  const requestId =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).request_id
      : undefined;
  return isPublicRequestId(requestId) ? requestId : undefined;
}

function publicRequestIdField(entry: PendingSubmission): { publicRequestId?: string } {
  const publicRequestId = publicRequestIdOf(entry);
  return publicRequestId ? { publicRequestId } : {};
}
