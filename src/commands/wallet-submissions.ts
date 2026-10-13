/**
 * `dvm wallet submissions` — inspect and close out the
 * unconfirmed-payment journal (`wallet.pending_submissions[]`).
 *
 * `dvm wallet show` reconciles resumable entries automatically, but `stale`
 * and `unresumable` entries (a mid-job payment spend with no persisted body, a
 * spend past the 24h resume window, a dead endpoint) are deliberately held and
 * never dropped — their proofs are P2PK-locked to the DVM with no refund, so
 * silently deleting them would erase the only record of the loss. Without a
 * verb to inspect and deliberately forget them, they accumulate forever and
 * `dvm doctor` flags them with no path to resolution.
 *
 * This is a pure inspect surface (no network, unlike `wallet show`) plus an
 * explicit, per-entry `--forget` that abandons one entry's sats. Never bulk,
 * never automatic — money must never disappear silently.
 *
 * To prevent accidental loss, `--forget` refuses outright on an entry the wallet can still
 * reclaim by itself, and takes a separate `--force` to override. Those sats are
 * coming back; forgetting them is the only way left to actually lose them.
 */

import {
  DvmError,
  loadAgentWallet,
} from "@dvmkit/sdk/internal";
import {
  info,
  json,
} from "../lib/output";
import { abandonPendingSubmission } from "../lib/wallet-agent/spend";
import { createInterface } from "node:readline";

import { listSubmissionEvidence } from "../lib/submission-evidence";
import {
  describePendingSubmissions,
  describeSubmissionEvidence,
  formatPendingSubmission,
  type PendingSubmissionsSummary,
  type PendingSubmissionView,
  type SubmissionEvidenceView,
} from "../lib/wallet-agent/submissions-view";

export interface WalletSubmissionsOptions {
  /** Forget exactly one entry, named by its `request_id`. Abandons its sats. */
  forget?: string;
  /** Skip the confirmation prompt — required to `--forget` non-interactively. */
  yes?: boolean;
  /**
   * Forget an entry the wallet was going to reclaim by itself.
   * Separate from `--yes` on purpose: `--yes` waives a prompt, this waives
   * money that was on its way back.
   */
  force?: boolean;
  human?: boolean;
}

/**
 * List the pending-submission journal, or forget one entry with `--forget`.
 *
 * The list path is a pure read — it does not reconcile with any DVM (that is
 * `dvm wallet show`'s job). It exists so an agent that hit a paid-submit
 * timeout can inspect every entry's `state` and reason mid-task without running
 * the full `doctor` diagnostic, and reach a deliberate ending for entries the
 * wallet can no longer act on itself.
 */
export async function walletSubmissions(opts: WalletSubmissionsOptions): Promise<void> {
  if (opts.forget !== undefined) {
    await forgetSubmission(opts.forget, opts);
    return;
  }
  listSubmissions(opts);
}

function listSubmissions(opts: WalletSubmissionsOptions): void {
  // Evidence can exist without a wallet: an x402, Tempo or credit call records
  // it too, and it must stay visible however the wallet is set up.
  const listed = listSubmissionEvidence();
  const evidence = describeSubmissionEvidence(listed.records);
  const unreadable = listed.unreadable;
  const wallet =
    evidence.length > 0 || unreadable.length > 0 ? loadAgentWallet() : loadWalletOrThrow();
  const summary = wallet ? describePendingSubmissions(wallet) : EMPTY_SUMMARY;

  if (opts.human) {
    printEvidenceHuman(evidence);
    for (const file of unreadable) {
      info(`Unreadable evidence record (${file.cause}): ${file.path}. Restore it from a backup; do not pay again for any request it may describe.`);
    }
    if (summary.entries.length === 0) {
      info("No unconfirmed payments — every spend has been acknowledged by its provider.");
      return;
    }
    info(
      `Unconfirmed payments: ${summary.entries.length} (${summary.at_risk_sats} sats spent, not yet confirmed)`
    );
    for (const entry of summary.entries) {
      info(`  ${formatPendingSubmission(entry)}`);
    }
    if (summary.stranded_count > 0) {
      info("");
      info(
        `  ${summary.stranded_count} of these are no longer retried automatically and the sats are not coming back — the payment was locked to the provider with no refund, or is worth less than the mint charges to move it. Quote the request id to its operator to find out whether the job ran, or forget one with: dvm wallet submissions --forget <request_id>`
      );
    }
    if (summary.reclaimable_count > 0) {
      info("");
      info(
        `  ${summary.reclaimable_count} of these expire if the provider never takes them — see reclaim_at. The wallet swaps those sats back into your balance on its own; don't forget them.`
      );
    }
    if (summary.reclaim_failed_count > 0) {
      info("");
      info(
        `  ${summary.reclaim_failed_count} of these have expired but the wallet keeps failing to take the sats back — the reason is on each line above. Fix the cause and the next call retries; the sats are still recoverable.`
      );
    }
    if (summary.accepted_unresolved_count > 0) {
      info("");
      info(
        `  ${summary.accepted_unresolved_count} of these were accepted by the provider without a clear job ID. They are never paid for or sent again; the evidence above says how to find each job.`
      );
    }
    return;
  }

  json({
    status: "ok",
    count: summary.entries.length,
    pending_submissions: summary.entries,
    pending_submission_sats: summary.at_risk_sats,
    stranded_count: summary.stranded_count,
    // entries that self-heal. Deliberately not folded into
    // `stranded_count` — `--forget` would throw away money that is coming back.
    reclaimable_count: summary.reclaimable_count,
    // entries whose self-heal has come due and keeps failing. Also
    // not stranded — the sats are recoverable once the cause is fixed — but
    // unlike `reclaimable` this one needs someone to act.
    reclaim_failed_count: summary.reclaim_failed_count,
    // Accepted without a settled job identity: held so nothing pays twice.
    accepted_unresolved_count: summary.accepted_unresolved_count,
    submission_evidence: evidence,
    ...(unreadable.length > 0 ? { submission_evidence_unreadable: unreadable } : {}),
    display: [
      summary.entries.length === 0
        ? "No unconfirmed payments."
        : `${summary.entries.length} unconfirmed payment(s), ${summary.at_risk_sats} sats spent but not yet confirmed by a provider.`,
      evidence.length > 0
        ? `${evidence.length} paid call(s) were accepted without a clear job ID; see submission_evidence. None was paid for again.`
        : null,
      unreadable.length > 0
        ? `${unreadable.length} evidence record(s) cannot be read; see submission_evidence_unreadable. The payments they may describe are held and not sent again.`
        : null,
    ]
      .filter(Boolean)
      .join(" "),
    hint: [
      summary.stranded_count > 0
        ? "Entries in state stale/unresumable/unreclaimable will not retry and their sats are not coming back. Close one out with: dvm wallet submissions --forget <request_id> (abandons its sats)."
        : null,
      summary.reclaimable_count > 0
        ? "Entries in state reclaimable need no action — the wallet takes those sats back after reclaim_at."
        : null,
      summary.reclaim_failed_count > 0
        ? "Entries in state reclaim_failed have expired but could not be taken back — see each entry's reclaim_error. The sats are recoverable once that is fixed."
        : null,
      unreadable.length > 0
        ? "Restore each file in submission_evidence_unreadable from a backup. Do not pay again for any request it may describe."
        : null,
      evidence.length > 0
        ? "Do not pay for a request listed in submission_evidence again. Each row's read_job lists lookups that never pay; job_token_bearer_secret, where present, is a bearer secret: treat it like a password and do not share it."
        : null,
      "Resumable entries retry on the next paid call or `dvm wallet show`.",
    ]
      .filter(Boolean)
      .join(" "),
  });
}

async function forgetSubmission(requestId: string, opts: WalletSubmissionsOptions): Promise<void> {
  const wallet = loadWalletOrThrow();
  const view = describePendingSubmissions(wallet).entries.find((e) => e.request_id === requestId);
  if (!view) {
    throw new DvmError(
      "submission_not_found",
      `No pending submission with request id "${requestId}".`,
      "List them with: dvm wallet submissions"
    );
  }

  refuseIfSelfHealing(view, opts);
  await confirmForget(view, opts);
  await abandonPendingSubmission({ requestId });

  const abandoned = view.at_risk ? view.amount_sats : 0;
  if (opts.human) {
    info(
      view.at_risk
        ? `Forgot request ${requestId} — abandoned ${abandoned} sats paid to ${view.endpoint}.`
        : `Forgot request ${requestId} — no sats were spent (nothing to abandon).`
    );
    return;
  }
  json({
    status: "forgotten",
    request_id: requestId,
    endpoint: view.endpoint,
    abandoned_sats: abandoned,
    display: !view.at_risk
      ? `Forgot request ${requestId}. No sats were spent, so nothing was abandoned.`
      : view.state === "reclaimable" || view.state === "reclaim_failed"
        ? `Forgot the unconfirmed payment for request ${requestId}. ${abandoned} sats paid to ${view.endpoint} are abandoned — and this one was still recoverable: the wallet would have returned it to your balance by itself${view.reclaim_at ? ` after ${view.reclaim_at}` : ""}.`
        : view.state === "accepted_unresolved"
          ? `Forgot the journal entry for request ${requestId}. ${abandoned} sats paid to ${view.endpoint} are no longer tracked; the provider accepted that call, and its evidence stays under submission_evidence.`
          : view.state === "unreclaimable"
          ? `Forgot the unconfirmed payment for request ${requestId}. ${abandoned} sats paid to ${view.endpoint} are abandoned — nothing was given up by forgetting it, since ${view.reclaim_error ?? "the mint's fee exceeds the value"}.`
          : `Forgot the unconfirmed payment for request ${requestId}. ${abandoned} sats paid to ${view.endpoint} are abandoned — the proofs were locked to the provider with no refund.`,
    hint: "The entry is gone from the journal. This cannot be undone.",
  });
}

/**
 * Refuse to forget an entry the wallet is going to reclaim by itself,
 * unless `--force` says otherwise.
 *
 * `--yes` cannot be the gate here. It is the documented agent path — it waives a
 * prompt no non-interactive caller could answer — so an agent tidying its
 * journal with `--forget <id> --yes` would silently destroy sats that were on
 * their way back, which is the one outcome this whole feature exists to prevent.
 * `--force` is a second, separate decision, and the message states what it costs.
 *
 * A `reclaim_failed` entry is refused on the same footing: the reclaim is stuck,
 * not impossible, and the fix is usually a mnemonic away. `unreclaimable` is
 * deliberately *not* refused — those sats are worth less than the mint charges
 * to move them, so there is nothing on its way back to protect and making the
 * caller pass `--force` to tidy up would be theatre.
 */
function refuseIfSelfHealing(view: PendingSubmissionView, opts: WalletSubmissionsOptions): void {
  if (opts.force) return;
  if (view.state !== "reclaimable" && view.state !== "reclaim_failed") return;

  const situation =
    view.state === "reclaimable"
      ? `The provider never took it, so it expires and the wallet returns those sats to your balance by itself${view.reclaim_at ? ` after ${view.reclaim_at}` : ""}.`
      : `It has expired and the sats are yours to take back, but the last attempt failed${view.reclaim_error ? `: ${view.reclaim_error}` : ""}. Every call retries.`;

  throw new DvmError(
    "reclaim_pending",
    `Request ${view.request_id} is ${view.state}: ${view.amount_sats} sats paid to ${view.endpoint} are still recoverable. ${situation}`,
    `Forgetting it throws those sats away for good. Leave it alone and it resolves on its own; if you really want it gone, add --force: dvm wallet submissions --forget ${view.request_id} --yes --force`
  );
}

async function confirmForget(
  view: PendingSubmissionView,
  opts: WalletSubmissionsOptions
): Promise<void> {
  if (opts.yes) return;

  const consequence = !view.at_risk
    ? `clears the journal entry for ${view.endpoint} (nothing was spent)`
    : view.state === "reclaimable" || view.state === "reclaim_failed"
      ? // Worth spelling out: this is the one case where forgetting *costs* the
        // caller money they were otherwise getting back. Reaching
        // here at all means they already passed --force.
        `throws away ${view.amount_sats} sats paid to ${view.endpoint} that the wallet can still reclaim by itself, so this cannot be undone`
      : view.state === "accepted_unresolved"
        ? `stops tracking ${view.amount_sats} sats paid to ${view.endpoint} for a call the provider accepted without a clear job ID${view.reclaim_at ? `, including the wallet's claim to take them back after ${view.reclaim_at} if the provider never redeems them` : ""}; the recorded evidence is kept, but this cannot be undone`
      : view.state === "unreclaimable"
        ? `clears ${view.amount_sats} sats paid to ${view.endpoint} that are too small to be worth taking back, so nothing recoverable is lost — but this cannot be undone`
        : `abandons ${view.amount_sats} sats paid to ${view.endpoint} — the proofs are locked to the provider with no refund, so this cannot be undone`;

  if (opts.human && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        `Forgetting request ${view.request_id} ${consequence}. Type the request id to confirm: `,
        (a) => {
          rl.close();
          resolve(a.trim());
        }
      );
    });
    if (answer !== view.request_id) {
      throw new DvmError("cancelled", "Forget cancelled.");
    }
    return;
  }

  throw new DvmError(
    "confirmation_required",
    "Pass --yes to forget in non-interactive mode.",
    `This ${consequence}. Use: dvm wallet submissions --forget ${view.request_id} --yes`
  );
}

const EMPTY_SUMMARY: PendingSubmissionsSummary = {
  entries: [],
  at_risk_sats: 0,
  stranded_count: 0,
  reclaimable_count: 0,
  reclaim_failed_count: 0,
  accepted_unresolved_count: 0,
};

function printEvidenceHuman(evidence: SubmissionEvidenceView[]): void {
  if (evidence.length === 0) return;
  info(`Accepted without a clear job ID: ${evidence.length} (never paid for again)`);
  for (const row of evidence) {
    info(`  ${row.ambiguity_id}  ${row.endpoint}  (${row.kind}, ${row.observed_at})`);
    info(`    ${row.display}`);
    for (const command of row.read_job) info(`    read: ${command}`);
    if (row.job_token_bearer_secret) {
      info(
        `    job_token_bearer_secret (treat like a password; do not share): ${row.job_token_bearer_secret}`
      );
    }
  }
  info("");
}

function loadWalletOrThrow() {
  const wallet = loadAgentWallet();
  if (!wallet) {
    throw new DvmError(
      "wallet_missing",
      "No agent wallet found.",
      "Run `dvm wallet init` first to generate a lock keypair."
    );
  }
  return wallet;
}
