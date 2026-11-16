import { DvmError, shellQuoteArg } from "@dvmkit/sdk/internal";
import type { JobRecord } from "./job-store";
import { loadRequestIntent } from "./request-intent-store";

/** Refusal for a credit job whose original debit is not booked, naming the cause and a recovery that can work. */
export function unknownUpfrontCreditError(job: JobRecord, message: string): DvmError {
  const reason = job.upfrontCreditConflictReason;
  const requestId = job.requestId;
  let recovery: string;
  if (requestId && loadRequestIntent(requestId))
    recovery = `Run \`dvm request-result ${shellQuoteArg(requestId)}\` to recover the accepted upfront amount; it reads only and sends no payment.`;
  else if (requestId)
    recovery = `Request ${requestId} has no stored intent on this machine, so \`dvm request-result\` cannot recover it. Restore the caller state that submitted it.`;
  else
    recovery = "This job has no stored request id, so `dvm request-result` cannot recover it. Restore the caller state that submitted it.";
  return new DvmError("upfront_credit_unknown", `${message}${reason ? ` Cause: ${reason}.` : ""}`,
    `${recovery} Do not edit the local job store.`,
    { ...(reason ? { reason } : {}), ...(requestId ? { request_id: requestId } : {}) });
}
