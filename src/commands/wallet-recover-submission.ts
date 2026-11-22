import {
  DvmError,
} from "@dvmkit/sdk/internal";
import {
  info,
  json,
} from "../lib/output";
import { recoverPendingSubmission } from "../lib/wallet-agent/recovery-submissions";

import { dvmFetch } from "../lib/http";

export interface WalletRecoverSubmissionOptions {
  /** Exact approved request-binding SHA-256 fingerprint. */
  bindingFingerprint?: string;
  human?: boolean;
}

/** Recover exactly one strict Cashu pending submission, never the whole wallet journal. */
export async function walletRecoverSubmission(
  requestId: string,
  opts: WalletRecoverSubmissionOptions
): Promise<void> {
  if (!opts.bindingFingerprint)
    throw new DvmError(
      "submission_binding_required",
      "Exact submission recovery requires --binding-fingerprint.",
      "Use the fingerprint returned by the original strict per-call request."
    );
  const result = await recoverPendingSubmission({
    requestId,
    bindingFingerprint: opts.bindingFingerprint,
    // Recovery POSTs go through the caller's own wrapper so an HTTP 426 keeps
    // surfacing as `client_upgrade_required` rather than a generic
    // `provider_unreachable`.
    fetchImpl: dvmFetch,
  });
  const lookupHint = "Use read-only receipt and job lookup for the original request.";
  if (opts.human) {
    if (result.redirect) info(`${result.redirect.display} ${lookupHint}`);
    info(
      result.jobId
        ? `Recovered request ${result.requestId} as job ${result.jobId}.`
        : `Recovery for request ${result.requestId} remains unconfirmed; no second attempt is allowed.`
    );
    return;
  }
  json({
    status: result.outcome,
    request_id: result.requestId,
    recovery_attempts: result.attemptCount,
    job_id: result.jobId,
    ...(result.redirect && { diagnostic: result.redirect }),
    next_action:
      result.jobId !== null
        ? { type: "verify_receipt", job_id: result.jobId }
        : { type: "lookup_receipt", request_id: result.requestId, ...(result.redirect && { hint: lookupHint }) },
  });
}
