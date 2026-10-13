/**
 * Read-side view of `wallet.pending_submissions[]`.
 *
 * A pending submission holds real value that has already left the wallet: the
 * proofs were swapped at the mint and P2PK-locked to the DVM, so they no longer
 * count toward the spendable balance.
 *
 * Payments made from the agent wallet carry a NUT-11 refund clause, so an entry the
 * provider never confirms is no longer a permanent loss — it reads
 * `reclaimable`, names the date the wallet takes it back, and stays out of the
 * `stranded_count` that steers a user toward `--forget`. A promise of a
 * self-heal is only worth making while it's true, so an entry whose reclaim has
 * been tried and failed reads `reclaim_failed` and carries the reason: a wallet
 * that lost its mnemonic, or a mint that stays down, must not go on reporting
 * money as on its way back. And a payment worth less than the mint charges to
 * move it reads `unreclaimable` and goes back into `stranded_count`, because
 * there the honest advice is the one the refund clause was built to avoid
 * giving: these sats are gone, forget the entry when you like.
 *
 * Written for a relaying agent: `display` explains the situation without
 * assuming the reader knows what a proof or a mint is.
 */

import {
  type AgentWallet,
  type PendingSubmission,
  type PendingSubmissionAcceptedUnresolved,
  shellQuoteArg,
} from "@dvmkit/sdk/internal";
import { type SubmissionEvidenceRecord } from "../submission-evidence";
import {
  isResumable,
  publicRequestIdOf,
  reclaimAtMs,
  RESUME_MAX_AGE_MS,
  RESUME_MAX_ATTEMPTS,
  type SubmissionSweepOutcome,
} from "./recovery-submissions";

export type PendingSubmissionState =
  /** Mint never signed the swap — no value at risk; the inputs revert on their own. */
  | "awaiting_swap"
  /** Mint may have signed; the wallet is restoring outputs or checking inputs. */
  | "recovering_swap"
  /** Will be re-shipped to the DVM on the next paid call or `dvm wallet show`. */
  | "resumable"
  /** Re-shipping is over, but a NUT-11 refund clause lets the wallet take the sats back. */
  | "reclaimable"
  /** The refund clause has come due and the reclaim keeps failing. Needs a human. */
  | "reclaim_failed"
  /**
   * The refund clause came due and automatic recovery cannot succeed: the
   * value is below fees or legacy mint evidence is absent. Held like `stale`.
   */
  | "unreclaimable"
  /** Past the resume window or the attempt cap, with no refund clause. Held, not retried. */
  | "stale"
  /** Can never be re-shipped and carries no refund clause. Held. */
  | "unresumable"
  /**
   * The provider accepted the call without stating a settled job identity.
   * Never re-shipped; a refund clause still returns an unredeemed payment.
   */
  | "accepted_unresolved";

export interface PendingSubmissionView {
  request_id: string;
  endpoint: string;
  mint: string;
  amount_sats: number;
  /** Null when `created_at` is unparseable — better than a made-up 0. */
  age_seconds: number | null;
  attempts: number;
  state: PendingSubmissionState;
  /** Whether these sats are outstanding (spent, unconfirmed by the DVM). */
  at_risk: boolean;
  /**
   * ISO-8601 instant from which the wallet can take these sats back by itself
   *, or `null` when the payment carries no refund clause. A time in
   * the past means the next sweep will do it.
   */
  reclaim_at: string | null;
  /**
   * Why the last reclaim attempt didn't go through, or `null` when
   * none has been attempted or the entry carries no refund clause. Non-null is
   * exactly the `reclaim_failed` and `unreclaimable` states — the first is worth
   * waiting out, the second isn't, and the reason is what tells them apart.
   */
  reclaim_error: string | null;
  /** What was observed when the provider accepted the call without a settled job identity. */
  accepted_unresolved?: PendingSubmissionAcceptedUnresolved;
  /**
   * The public request ID the paid submit carried, when it had one:
   * `dvm request-result` takes this, not the wallet's own `request_id`.
   */
  public_request_id?: string;
  display: string;
}

export interface PendingSubmissionsSummary {
  entries: PendingSubmissionView[];
  /** Total sats spent but not yet confirmed by any DVM. */
  at_risk_sats: number;
  /**
   * Entries the wallet can no longer act on by itself (`stale`, `unresumable`,
   * `unreclaimable`). `unreclaimable` belongs here and `reclaim_failed` does
   * not: both are stuck, but only one is stuck for a reason a retry can undo.
   */
  stranded_count: number;
  reclaimable_count: number;
  reclaim_failed_count: number;
  /** Accepted without a settled job identity: held so nothing pays for it twice. */
  accepted_unresolved_count: number;
}

export function describePendingSubmissions(
  wallet: AgentWallet,
  nowMs: number = Date.now()
): PendingSubmissionsSummary {
  const entries = wallet.pending_submissions.map((entry) => toView(entry, nowMs));
  return {
    entries,
    at_risk_sats: entries.filter((e) => e.at_risk).reduce((sum, e) => sum + e.amount_sats, 0),
    stranded_count: entries.filter(
      (e) => e.state === "stale" || e.state === "unresumable" || e.state === "unreclaimable"
    ).length,
    reclaimable_count: entries.filter((e) => e.state === "reclaimable").length,
    reclaim_failed_count: entries.filter((e) => e.state === "reclaim_failed").length,
    accepted_unresolved_count: entries.filter((e) => e.state === "accepted_unresolved").length,
  };
}

/**
 * One-line human rendering, mirroring `formatRecentSpend`'s shape. A failing
 * reclaim carries its reason inline — `reclaim_failed` on its own tells the
 * reader something is wrong but nothing about what to fix.
 */
export function formatPendingSubmission(view: PendingSubmissionView): string {
  const reqShort = `${view.request_id.slice(0, 8)}…${view.request_id.slice(-4)}`;
  const age = view.age_seconds === null ? "age unknown" : `${formatAge(view.age_seconds)} old`;
  const why = view.reclaim_error ? `: ${view.reclaim_error}` : "";
  const readBack = view.public_request_id ? `; dvm request-result ${view.public_request_id}` : "";
  return `${view.amount_sats} sats  ${view.endpoint}  (req ${reqShort}, ${age}, ${view.state}${why}${readBack})`;
}

export interface ResumedSubmissionView {
  request_id: string;
  /** See {@link PendingSubmissionView.public_request_id}. */
  public_request_id?: string;
  endpoint: string;
  amount_sats: number;
  /**
   * Job id the DVM returned for the resumed call, or `null` when it confirmed
   * the payment but handed back no job — a pre- replay (`already_accepted`)
   * or a resumed credit funding, which starts no job. No id is invented.
   */
  job_id: string | null;
  /** Agent-relayable one-liner. */
  display: string;
}

/**
 * Render the sweep's `shipped` / `already_accepted` outcomes for JSON callers
 * Every other outcome kind is left to the `pending_submissions`
 * block — this one reports only what the current sweep re-shipped and cleared.
 * Pure — no network, no writes.
 */
export function describeResumedSubmissions(
  outcomes: SubmissionSweepOutcome[]
): ResumedSubmissionView[] {
  const views: ResumedSubmissionView[] = [];
  for (const outcome of outcomes) {
    const publicRequestId = publicRequestIdOf(outcome.entry);
    const locate = locateAdvice(outcome.entry, publicRequestId);
    if (outcome.kind === "shipped") {
      const jobId = outcome.jobId ?? null;
      views.push({
        request_id: outcome.entry.request_id,
        ...(publicRequestId ? { public_request_id: publicRequestId } : {}),
        endpoint: outcome.entry.endpoint,
        amount_sats: outcome.entry.amount_sats,
        job_id: jobId,
        display: jobId
          ? `${outcome.entry.amount_sats} sats paid to ${outcome.entry.endpoint} was reconciled — the job resumed as ${jobId}. Look it up with \`dvm status ${jobId}\`.`
          : `${outcome.entry.amount_sats} sats paid to ${outcome.entry.endpoint} was reconciled, but the provider returned no job id. ${locate}`,
      });
    } else if (outcome.kind === "already_accepted") {
      views.push({
        request_id: outcome.entry.request_id,
        ...(publicRequestId ? { public_request_id: publicRequestId } : {}),
        endpoint: outcome.entry.endpoint,
        amount_sats: outcome.entry.amount_sats,
        job_id: null,
        display: `${outcome.entry.amount_sats} sats paid to ${outcome.entry.endpoint} was already confirmed by the provider, which returned no job id. ${locate}`,
      });
    }
  }
  return views;
}

export interface UnresolvedSubmissionView {
  request_id: string;
  /** See {@link PendingSubmissionView.public_request_id}. */
  public_request_id?: string;
  endpoint: string;
  amount_sats: number;
  /** Absent when the evidence record that would say it cannot be read. */
  kind?: PendingSubmissionAcceptedUnresolved["kind"];
  ambiguity_id: string;
  /**
   * `missing` when the journal marks the entry but its evidence record is gone;
   * `unreadable` when the record is there but damaged.
   */
  evidence: "recorded" | "missing" | "unreadable";
  display: string;
}

/**
 * Render the sweep's `accepted_unresolved` outcomes worth telling the caller
 * about: one detected on this call, and one whose evidence record is missing,
 * which every call repeats until someone looks. A known marked entry is already
 * in the `pending_submissions` block. Pure — no network, no writes.
 */
export function describeUnresolvedSubmissions(
  outcomes: SubmissionSweepOutcome[]
): UnresolvedSubmissionView[] {
  const views: UnresolvedSubmissionView[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === "evidence_unreadable") {
      const { entry } = outcome;
      const publicRequestId = publicRequestIdOf(entry);
      views.push({
        request_id: entry.request_id,
        ...(publicRequestId ? { public_request_id: publicRequestId } : {}),
        endpoint: entry.endpoint,
        amount_sats: entry.amount_sats,
        ambiguity_id: entry.request_id,
        evidence: "unreadable",
        display: `${entry.amount_sats} sats paid to ${entry.endpoint} has an evidence record that cannot be read, so the payment is held and not sent again until the file under ${entry.request_id} in \`dvm wallet submissions\` is restored. ${locateAdvice(entry, publicRequestId)}`,
      });
      continue;
    }
    if (outcome.kind !== "accepted_unresolved") continue;
    if (outcome.evidence === "recorded" && !outcome.observation) continue;
    const { entry, marker } = outcome;
    const publicRequestId = publicRequestIdOf(entry);
    const readBack = publicRequestId
      ? ` Read the job back with \`dvm request-result ${publicRequestId}\`, which never pays.`
      : "";
    views.push({
      request_id: entry.request_id,
      ...(publicRequestId ? { public_request_id: publicRequestId } : {}),
      endpoint: entry.endpoint,
      amount_sats: entry.amount_sats,
      kind: marker.kind,
      ambiguity_id: marker.ambiguity_id,
      evidence: outcome.evidence,
      display:
        outcome.evidence === "recorded"
          ? `${entry.amount_sats} sats paid to ${entry.endpoint} was accepted on retry, but the provider did not say clearly which job it started. It will not be paid for or sent again; \`dvm wallet submissions\` shows the evidence (${marker.ambiguity_id}).${readBack}`
          : `${entry.amount_sats} sats paid to ${entry.endpoint} was accepted without a clear job ID, and the evidence record ${marker.ambiguity_id} is ${outcome.evidence === "missing" ? "missing from this machine" : "damaged"}. The payment is still never sent again. ${locateAdvice(entry, publicRequestId)}`,
    });
  }
  return views;
}

export interface ReclaimedSubmissionView {
  request_id: string;
  endpoint: string;
  /** What the payment was worth when it left the wallet. */
  amount_sats: number;
  /** What came back — the mint's swap fee comes off the top. */
  reclaimed_sats: number;
  /**
   * What the provider had already taken out of this payment before the rest
   * expired, in sats. Zero on every ordinary reclaim — a provider redeems the
   * whole token or none of it — and non-zero only on a partial redeem, where
   * this is the part that really was paid for service.
   */
  provider_took_sats: number;
  display: string;
}

/**
 * Render the sweep's `reclaimed` outcomes for JSON callers. Pure —
 * no network, no writes. `reclaim_skipped` has its own renderer
 * ({@link describeSkippedReclaims}) rather than sharing this one: a reclaim that
 * didn't happen is not a smaller version of one that did.
 */
export function describeReclaimedSubmissions(
  outcomes: SubmissionSweepOutcome[]
): ReclaimedSubmissionView[] {
  const views: ReclaimedSubmissionView[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind !== "reclaimed") continue;
    // The fee is what the mint kept out of the part actually swapped back, so
    // a partial redeem's provider-taken half must come out first — otherwise it
    // would be reported as the mint's cut.
    const fee = outcome.entry.amount_sats - outcome.spent_sats - outcome.reclaimed_sats;
    const took =
      outcome.spent_sats > 0
        ? ` The provider had already taken ${outcome.spent_sats} sats of it, which it keeps.`
        : ` The provider was never paid, so nothing was delivered for it.`;
    views.push({
      request_id: outcome.entry.request_id,
      endpoint: outcome.entry.endpoint,
      amount_sats: outcome.entry.amount_sats,
      reclaimed_sats: outcome.reclaimed_sats,
      provider_took_sats: outcome.spent_sats,
      display:
        `${outcome.entry.amount_sats} sats paid to ${outcome.entry.endpoint} was never taken by the provider, so it expired and the wallet took it back — ${outcome.reclaimed_sats} sats are spendable again` +
        (fee > 0 ? ` (${fee} sats went to the mint's fee).` : ".") +
        took,
    });
  }
  return views;
}

export interface SkippedReclaimView {
  request_id: string;
  endpoint: string;
  /** What the payment was worth when it left the wallet. */
  amount_sats: number;
  reason: string;
  /**
   * Whether the next sweep would reach the same conclusion no matter what
   * changes in the meantime. False for the outages and missing files that make
   * up almost every skip; true when fees exceed the value or required legacy
   * mint evidence is irretrievably absent. An agent should not tell its human
   * to sit tight on a `true`.
   */
  terminal: boolean;
  display: string;
}

/**
 * Render the sweep's `reclaim_skipped` outcomes for JSON callers.
 * Pure — no network, no writes.
 *
 * These are the failures that would otherwise be invisible: the sweep runs
 * inside `dvm wallet show` and every paid call, so a wallet with no mnemonic or
 * a mint that stays down would go on reporting an expired payment as one on its
 * way back, indefinitely. Nothing is lost — the proofs are still there and every
 * call retries — but the caller has to be told the self-heal isn't happening.
 *
 * Terminal skips read differently: retrying is not slow there, it is
 * pointless, so "every call retries" would be the wrong thing to relay.
 */
export function describeSkippedReclaims(outcomes: SubmissionSweepOutcome[]): SkippedReclaimView[] {
  const views: SkippedReclaimView[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind !== "reclaim_skipped") continue;
    const subFee = outcome.reason.startsWith("worth ");
    views.push({
      request_id: outcome.entry.request_id,
      endpoint: outcome.entry.endpoint,
      amount_sats: outcome.entry.amount_sats,
      reason: outcome.reason,
      terminal: outcome.terminal,
      display: outcome.terminal
        ? subFee
          ? `${outcome.entry.amount_sats} sats paid to ${outcome.entry.endpoint} expired unclaimed, and taking them back is not worth it: ${outcome.reason}. Retrying will not change that — treat the sats as spent.`
          : `${outcome.entry.amount_sats} sats paid to ${outcome.entry.endpoint} expired unclaimed, but the wallet cannot recover them automatically: ${outcome.reason} Retrying with the same wallet will not change that.`
        : `${outcome.entry.amount_sats} sats paid to ${outcome.entry.endpoint} expired unclaimed, but the wallet could not take them back: ${outcome.reason}. The sats are still recoverable and every call retries.`,
    });
  }
  return views;
}

export interface SubmissionEvidenceView extends Omit<SubmissionEvidenceRecord, "v" | "job_token"> {
  /**
   * The anonymous job's access token. Anyone holding it can read the job, so it
   * is printed only here and only under a name that says what it is.
   */
  job_token_bearer_secret?: string;
  /** Read-only lookups that can identify the job; none of them pays or submits. */
  read_job: string[];
  display: string;
}

/**
 * Render evidence records for `dvm wallet submissions`. Every value here is
 * either caller-generated or bounded and free of control characters, so it is
 * safe to print.
 */
export function describeSubmissionEvidence(
  records: SubmissionEvidenceRecord[]
): SubmissionEvidenceView[] {
  return records.map((record) => {
    const { v: _v, job_token: jobToken, ...fields } = record;
    const jobIds = [
      ...new Set(
        [record.header_job_id, record.body_job_id, record.accepted_job_id].filter(
          (id): id is string => id !== undefined
        )
      ),
    ];
    // A status read carries this row's own endpoint and token, both as
    // overrides. Without a token of its own the row offers none: `dvm status`
    // would otherwise fall back to whatever local job shares the ID, and send
    // that job's token to the endpoint that chose the ID. A collision row
    // offers no request-result, which would meet the same local job again.
    const collision = record.kind === "local_job_collision";
    const readJob = [
      ...(record.request_id && !collision ? [`dvm request-result ${record.request_id}`] : []),
      ...(jobToken
        ? jobIds.map(
            (jobId) =>
              `DVM_JOB_TOKEN=<job_token_bearer_secret> dvm status ${shellQuoteArg(jobId)} --endpoint ${shellQuoteArg(record.endpoint)}`
          )
        : []),
    ];
    const what = collision
      ? `its job${record.accepted_job_id ? ` ${record.accepted_job_id}` : ""} shares its ID with a local job from another provider, so it is kept here rather than in the local job list`
      : record.kind === "router_identity_conflict"
        ? "this request had already been accepted as a different job"
        : record.kind === "identity_mismatch"
          ? "the provider named two different jobs for it"
          : "the provider's reply did not state a readable job";
    const lookup =
      readJob.length > 0
        ? ` Find the job with one of read_job; those lookups never pay.`
        : jobIds.length > 0
          ? ` No job token was received for ${jobIds.join(", ")}, so quote the request to the provider operator.`
          : " No job ID was observed, so quote the request to the provider operator.";
    const secret = jobToken
      ? " job_token_bearer_secret is a bearer secret: treat it like a password and do not share it."
      : "";
    return {
      ...fields,
      ...(jobToken ? { job_token_bearer_secret: jobToken } : {}),
      read_job: readJob,
      display: `A paid call to ${record.endpoint} was accepted, but ${what}. It was not paid for again.${lookup}${secret}`,
    };
  });
}

function toView(entry: PendingSubmission, nowMs: number): PendingSubmissionView {
  const createdMs = Date.parse(entry.created_at);
  const ageMs = Number.isNaN(createdMs) ? Number.POSITIVE_INFINITY : nowMs - createdMs;
  const attempts = entry.attempts ?? 0;
  const reclaimAt = reclaimAtMs(entry);
  const state = deriveState(entry, ageMs, attempts, reclaimAt);

  return {
    request_id: entry.request_id,
    endpoint: entry.endpoint,
    mint: entry.mint,
    amount_sats: entry.amount_sats,
    age_seconds: Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 1000)) : null,
    attempts,
    state,
    at_risk: state !== "awaiting_swap",
    reclaim_at: reclaimAt === null ? null : new Date(reclaimAt).toISOString(),
    reclaim_error:
      state === "reclaim_failed" || state === "unreclaimable"
        ? (entry.reclaim_error ?? null)
        : null,
    ...(entry.accepted_unresolved ? { accepted_unresolved: entry.accepted_unresolved } : {}),
    ...(publicRequestIdOf(entry) ? { public_request_id: publicRequestIdOf(entry) } : {}),
    display: describe(entry, state, reclaimAt, nowMs),
  };
}

/**
 * How the caller finds the job: a read-only `dvm request-result` when the
 * submit carried a public request ID, else the wallet's ID quoted to the
 * provider, which is all a provider can look up without one.
 */
function locateAdvice(entry: PendingSubmission, publicRequestId = publicRequestIdOf(entry)): string {
  return publicRequestId
    ? `Read the job back with \`dvm request-result ${publicRequestId}\`, which never pays.`
    : `Quote request ${entry.request_id} to the provider to locate the result.`;
}

function deriveState(
  entry: PendingSubmission,
  ageMs: number,
  attempts: number,
  reclaimAt: number | null
): PendingSubmissionState {
  // Once a swap preview exists, a missing response is ambiguous. The persisted
  // blinded outputs let the sweep restore it without ever guessing from age.
  if (entry.output_proofs.length === 0) {
    return entry.swapping ? "recovering_swap" : "awaiting_swap";
  }
  // Never re-shipped, so the resume window says nothing about it. A reclaim
  // that has come due and failed still needs the reclaim states' advice.
  if (entry.accepted_unresolved) {
    if (reclaimAt === null || !entry.reclaim_error) return "accepted_unresolved";
    return entry.reclaim_terminal ? "unreclaimable" : "reclaim_failed";
  }
  // Ask the sweep, not the entry: a signed call whose caller identity has since
  // been removed has a body but no way to re-sign it, so no retry is coming.
  const resumeOver =
    !isResumable(entry) || ageMs > RESUME_MAX_AGE_MS || attempts >= RESUME_MAX_ATTEMPTS;
  // A refund clause turns every dead end into a wait, so it outranks
  // both `stale` and `unresumable` — but only once re-shipping is done, because
  // getting the provider to accept the call is still the better outcome. Only
  // while the wait is real, though: a reclaim the sweep has tried and failed is
  // a wait for nothing until someone fixes the cause, and one it can never make
  // pay is a wait for nothing at all.
  if (resumeOver && reclaimAt !== null) {
    if (!entry.reclaim_error) return "reclaimable";
    return entry.reclaim_terminal ? "unreclaimable" : "reclaim_failed";
  }
  if (!isResumable(entry)) return "unresumable";
  if (resumeOver) return "stale";
  return "resumable";
}

function describe(
  entry: PendingSubmission,
  state: PendingSubmissionState,
  reclaimAt: number | null,
  nowMs: number
): string {
  const sats = `${entry.amount_sats} sats`;
  switch (state) {
    case "awaiting_swap":
      return `${sats} is reserved for a call to ${entry.endpoint} that never completed. Nothing was spent — it returns to your balance automatically.`;
    case "recovering_swap":
      return `${sats} is tied to a mint swap whose response was interrupted. The wallet is restoring the signed payment or proving the original inputs remain spendable; do not retry or forget request ${entry.request_id}.`;
    case "resumable":
      return publicRequestIdOf(entry)
        ? `${sats} was paid to ${entry.endpoint} but the provider never confirmed. The next call to any DVM reads request ${publicRequestIdOf(entry)} back from the provider, and re-sends the same payment only if the provider never received it.`
        : `${sats} was paid to ${entry.endpoint} but the provider never confirmed. The next call to any DVM retries it automatically.`;
    case "reclaimable":
      return reclaimAt !== null && reclaimAt > nowMs
        ? `${sats} was paid to ${entry.endpoint} and the provider never confirmed it. Retries have stopped, but the payment has an expiry: if the provider still hasn't taken it by ${new Date(reclaimAt).toISOString()}, the wallet returns it to your balance on its own. Nothing to do.`
        : `${sats} was paid to ${entry.endpoint} and the provider never confirmed it. The payment has expired, so the wallet can take it back — it returns to your balance on the next call or \`dvm wallet show\`.`;
    case "reclaim_failed":
      return `${sats} was paid to ${entry.endpoint}, the provider never took it, and the payment has expired — but the wallet has not managed to take it back: ${entry.reclaim_error ?? "the last attempt failed"}. The sats are still there and each call retries, so this is fixable, not lost.`;
    case "unreclaimable":
      return entry.reclaim_error?.startsWith("worth ")
        ? `${sats} was paid to ${entry.endpoint}, the provider never took it, and the payment has expired — but it is too small to be worth taking back: ${entry.reclaim_error}. Retrying will not change that, so treat these sats as spent; \`dvm wallet submissions --forget ${entry.request_id}\` clears the entry once you have stopped caring about it.`
        : `${sats} was paid to ${entry.endpoint}, the provider never took it, and automatic recovery cannot succeed: ${entry.reclaim_error ?? "the mint rejected the recovery permanently"} Do not delete the entry until the mint operator has reviewed request ${entry.request_id}.`;
    case "stale":
      return publicRequestIdOf(entry)
        ? `${sats} was paid to ${entry.endpoint} and the provider never confirmed it. Retries have stopped. ${locateAdvice(entry)}`
        : `${sats} was paid to ${entry.endpoint} and the provider never confirmed it. Retries have stopped. If the job never ran, ask the provider to look up request ${entry.request_id}.`;
    case "accepted_unresolved": {
      const reclaim =
        reclaimAt === null
          ? ""
          : ` If the provider never redeems the payment, the wallet takes it back after ${new Date(reclaimAt).toISOString()}.`;
      const readBack = publicRequestIdOf(entry) ? ` ${locateAdvice(entry)}` : "";
      return `${sats} was paid to ${entry.endpoint} and the provider accepted the call, but did not say clearly which job it started. Automatic retries are off for it so it is never paid twice.${reclaim} The recorded evidence is under ${entry.accepted_unresolved?.ambiguity_id ?? entry.request_id} in \`dvm wallet submissions\`.${readBack}`;
    }
    case "unresumable":
      return entry.context?.signing_pubkey
        ? `${sats} was paid to ${entry.endpoint} and the provider never confirmed it. The caller identity that signed the call (${entry.context.signing_pubkey.slice(0, 8)}…) is no longer configured, so it cannot be retried. Quote request ${publicRequestIdOf(entry) ?? entry.request_id} to the provider.`
        : `${sats} was paid to ${entry.endpoint} and the provider never confirmed it. This payment cannot be retried automatically. Quote request ${entry.request_id} to the provider.`;
  }
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return "unknown";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}
