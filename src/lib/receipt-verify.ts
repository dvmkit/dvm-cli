import { ReceiptVerification, ReceiptInvalidReason } from "@dvmkit/sdk/internal";

import { costAnchor } from "./currency";
import { formatUsd, msatsToUsd } from "@dvmkit/sdk/internal";

import { type JobReceipt as SignedJobReceipt } from "@dvmkit/sdk/internal";

/**
 * Pre-rendered line an intermediary agent can relay verbatim about a set of
 * drain receipts — {@link receiptDisplay}'s counterpart for the reclaim path.
 *
 * Says what the evidence is worth, not what the refund is worth: the drain's
 * own `display` already carries the money. `sound` is how many of `total` held
 * up at all — every verdict but `invalid` — which under a `verified` bundle is
 * all of them.
 */
export function drainReceiptsDisplay(
  status: ReceiptVerification,
  sound: number,
  total: number
): string {
  const tally = `${String(sound)} of ${String(total)}`;
  switch (status) {
    case "verified":
      return `Verified reclaim receipts (${tally}): signed by the key this DVM's builder identity attests.`;
    case "verified_unattested":
      return `Reclaim receipts, signed but unattested (${tally}): the signature holds, but this DVM publishes no builder identity to vouch for the signing key.`;
    case "invalid":
      return `UNVERIFIED reclaim receipts: only ${tally} hold up — the refund is still owed, but this evidence is not sound.`;
    case "absent":
      return "No reclaim receipts: this DVM returned no signed evidence of the drain.";
  }
}

/**
 * Next-step guidance about drain *evidence* — never about the refund, which is
 * owed whatever the receipts say.
 */
export function drainReceiptsHint(status: ReceiptVerification): string {
  switch (status) {
    case "verified":
      return "The refund evidence chains to this DVM's published builder identity, and is stored locally with that identity pinned beside it — so an unhonoured refund stays provable against the builder, not against an anonymous key.";
    case "verified_unattested":
      return "The receipts are signed, but nothing vouches for the signing key — expected for a locally-run or development DVM, not for a deployed one. Stored either way; the refund is owed regardless.";
    case "invalid":
      return "The refund is unaffected — this is a problem with the proof, not the money. Keep this output, and treat the reclaim as unattested when deciding how much to leave on deposit at this DVM.";
    case "absent":
      return "This DVM countersigned nothing, so the only artifact behind this reclaim is the drain request the caller signed. Weaker evidence than a countersigned drain, and worth weighing before funding here again.";
  }
}

/**
 * Pre-rendered line an intermediary agent can relay verbatim to a human with
 * no Bitcoin knowledge — the money in dollars first, then what it bought and
 * how it ended. Never includes provider free text: `receipt.reason` is
 * untrusted and is surfaced separately, provenance-wrapped.
 *
 * `rate` is the BTC/USD spot price. Pass 0 (or omit) when no rate is available
 * the line degrades to sats rather than claiming a dollar figure it can't
 * support.
 */
export function receiptDisplay(
  receipt: SignedJobReceipt,
  status: ReceiptVerification,
  rate = 0
): string {
  const what = `${receipt.dvm}/${receipt.capability} (DVM ID ${receipt.dvm_id})`;
  const when = receiptIssuedAtIso(receipt)?.slice(0, 10);
  return `${VERDICT_PREFIX[status]}: paid ${formatPaid(receipt.paid.msats, rate)} for ${what}, ${receipt.outcome}${when ? ` ${when}` : ""}.`;
}

/**
 * The receipt's `issued_at` (epoch **seconds**) rendered as ISO-8601, or `null`
 * when it can't be.
 *
 * `issued_at` is a number the DVM chooses. `1e300` is valid JSON, survives the
 * transport's shape guard, and makes `new Date(x).toISOString()` throw
 * `RangeError` — which on the completed branch of `dvm request` would turn a
 * job the caller already paid for into exit 1. Every render of this field goes
 * through here so a provider's bad clock costs a date, not a result.
 */
export function receiptIssuedAtIso(receipt: SignedJobReceipt): string | null {
  const seconds: unknown = receipt.issued_at;
  return typeof seconds === "number" ? epochMsToIso(seconds * 1000) : null;
}

/**
 * Epoch **milliseconds** rendered as ISO-8601, or `null` when the value can't
 * be a date.
 *
 * Takes `unknown` on purpose. Its callers read timestamps back out of files a
 * user can edit by hand (`receipts.jsonl`, `jobs.json`), where a field the type
 * calls `number` may be missing, a string, or past ECMAScript's ±8.64e15 ms
 * range — each of which turns an unguarded `toISOString()` into a `RangeError`
 * that surfaces as an `internal` exit on a pure read command.
 */
export function epochMsToIso(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || Math.abs(ms) > MAX_TIMESTAMP_MS) {
    return null;
  }
  return new Date(ms).toISOString();
}

/**
 * Next-step guidance for a receipt verdict — what the agent should do, or tell
 * its human, about the *proof* (never about the job, which succeeded or failed
 * on its own terms).
 */
export function receiptHint(status: ReceiptVerification, jobId?: string): string {
  const verifyCmd = jobId ? `'dvm receipts verify ${jobId}'` : "'dvm receipts verify <job-id>'";
  switch (status) {
    case "verified":
      return `Proof of purchase is stored locally. Re-check it any time with ${verifyCmd}, or hand over the raw bundle with 'dvm receipts export'.`;
    case "verified_unattested":
      return `The receipt's signature is valid, but this DVM publishes no builder identity to vouch for the signing key — expected for a locally-run or development DVM, not for a deployed one. Stored either way; inspect it with ${verifyCmd}.`;
    case "invalid":
      return `The job itself is unaffected — this is a problem with the proof, not the result. Run ${verifyCmd} to see which check failed before relying on this receipt as evidence.`;
    case "absent":
      return "This DVM does not issue signed receipts, so there is no proof of purchase to store. Nothing went wrong.";
  }
}

/**
 * One-line explanation of a failed link, for `--human` output and for an agent
 * relaying *why* a receipt didn't hold up.
 */
export function receiptFailureDetail(reason: ReceiptInvalidReason): string {
  switch (reason) {
    case "job_id_mismatch":
      return "The receipt names a different job than the one it was collected for — it is not proof of this job, whoever signed it.";
    case "drain_id_mismatch":
      return "The receipt names a different reclaim than the one it is filed under — it is not evidence of this drain, whoever signed it.";
    case "credit_id_mismatch":
      return "The receipt names a different credit than the one this reclaim was against — it is not evidence of this refund, whoever signed it.";
    case "fund_id_mismatch":
      return "The receipt names a different funding operation than the caller submitted.";
    case "funding_amount_mismatch":
      return "The signed funded amount differs from the provider's funding response.";
    case "funding_balance_mismatch":
      return "The signed post-funding balance differs from the provider's fresh balance response.";
    case "funding_ledger_seq_mismatch":
      return "The signed funding sequence differs from the provider's fresh balance response.";
    case "caller_pubkey_mismatch":
      return "The funding receipt names a different caller than the key that submitted the funding.";
    case "signature_invalid":
      return "The receipt's signature does not verify under the key it names — the bytes were altered, or it was never signed by that key.";
    case "attestation_invalid":
      return "The DVM's published builder attestation does not verify under its own builder pubkey.";
    case "dvm_identity_mismatch":
      return "The receipt names a different immutable DVM ID than the builder attestation, so it is not evidence for this provider.";
    case "receipt_key_mismatch":
      return "The receipt was signed by a different key than the one the DVM's builder attested.";
    case "result_hash_mismatch":
      return "The receipt attests a different result than the one delivered.";
  }
}

/** ECMAScript's `Date` range: ±8.64e15 ms from the epoch. Beyond it, `toISOString` throws. */
const MAX_TIMESTAMP_MS = 8.64e15;

const VERDICT_PREFIX: Record<ReceiptVerification, string> = {
  verified: "Verified receipt",
  verified_unattested: "Receipt (signed, unattested)",
  invalid: "UNVERIFIED receipt",
  absent: "No receipt",
};

function formatPaid(msats: number, rate: number): string {
  if (msats === 0) return "nothing (free job)";
  const sats = msats % 1000 === 0 ? msats / 1000 : Math.round((msats / 1000) * 100) / 100;
  const satsLabel = `${sats.toLocaleString("en-US")} sats`;
  if (rate <= 0) return satsLabel;
  const usd = msatsToUsd(msats, rate);
  return `~$${formatUsd(usd)} (${satsLabel}, ${costAnchor(usd)})`;
}