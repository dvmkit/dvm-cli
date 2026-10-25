import { completionSnapshot } from "../lib/completion-hints";
import {
  canonicalRequestPath,
  DvmError,
  isPublicRequestId,
  type JobEnvelope,
  shellQuoteArg,
  type TransportJobReceipt as JobReceipt,
  signDvmRequestData,
} from "@dvmkit/sdk/internal";
import {
  captureTransportReceipt,
  receiptJsonFields,
  renderReceiptHuman,
} from "../lib/receipt-capture";
import {
  findSigningIdentityByPubkey,
} from "../lib/cli-identity-resolve";
import {
  info,
  json,
} from "../lib/output";
import {
  loadAllJobs,
  loadJob,
  markJobTerminal,
  saveJob,
  recordUpfrontCreditPayment,
  recordUpfrontRailPayment,
  updateJob,
} from "../lib/job-store";

import { sameEndpoint } from "../lib/job-access";
import { parseUpfrontPayment, parseUpfrontRailPayment } from "../lib/upfront-payment";
import { isIdentityFailure, type ProviderIdentityError, withRequestResultRecovery } from "../lib/job-identity";
import { loadRequestIntent, type RequestIntent } from "../lib/request-intent-store";
import { requestRecoveryPath } from "../lib/request-recovery-path";
import { recordLocalJobCollision, recordSubmissionEvidence } from "../lib/submission-evidence";
import { bookRecoveredSubmissions } from "../lib/wallet-agent/recovery-submissions";
import { createDvmTransport } from "../lib/transport";
import { settleCreditAfterRead } from "../lib/credit-topup";
import { dvmIdentity } from "./dvm-identity";

export interface RequestResultOptions {
  human?: boolean;
}

/** Recover one accepted request without submitting a job or presenting payment. */
export async function requestResult(
  requestId: string,
  opts: RequestResultOptions = {}
): Promise<void> {
  if (!isPublicRequestId(requestId)) {
    throw new DvmError(
      "invalid_request_id",
      "Invalid request id.",
      "Use 1–128 characters: letters, digits, dot, underscore, colon, or hyphen."
    );
  }
  const intent = loadRequestIntent(requestId);
  if (!intent) {
    throw new DvmError(
      "request_not_found",
      `No local intent exists for request ${requestId}.`,
      "The outcome is unknown. Do not submit or pay for a replacement; restore the original caller state and retry.",
      { request_id: requestId, status: "unknown" }
    );
  }
  const signer = findSigningIdentityByPubkey(intent.callerPubkey);
  if (!signer) {
    throw new DvmError(
      "request_identity_unavailable",
      `The identity that signed request ${requestId} is no longer available.`,
      "Restore that caller identity. Recovery deliberately refuses a different signer."
    );
  }

  const transport = createDvmTransport();
  const envelope = signedIntentEnvelope(
    intent,
    signer.privkey,
    requestRecoveryPath("request-result", requestId)
  );
  let receipt: JobReceipt;
  try {
    receipt = await transport.requestResult({ endpoint: intent.endpoint }, requestId, envelope);
  } catch (err) {
    if (isIdentityFailure(err)) throw recordRequestResultIdentityFailure(err, intent);
    throw err;
  } finally {
    transport.close();
  }

  const conflicting = loadAllJobs().find(
    (job) => job.requestId === requestId && job.id !== receipt.jobId
  );
  if (conflicting) {
    throw new DvmError(
      "request_result_conflict",
      `Request ${requestId} is already linked locally to a different job.`,
      "Do not overwrite either record; caller state or provider state has been tampered with.",
      { request_id: requestId, local_job_id: conflicting.id, server_job_id: receipt.jobId }
    );
  }

  const existing = loadJob(receipt.jobId);
  // The provider chose this job ID. A local job with the same ID from another
  // endpoint is a different job, and is never overwritten by this one.
  if (existing && !sameEndpoint(existing.endpoint, intent.endpoint)) {
    // The recovered job's token is kept as evidence, so the read below can be
    // run without displacing the local job.
    const kept = recordLocalJobCollision({
      publicRequestId: requestId,
      endpoint: intent.endpoint,
      jobId: receipt.jobId,
      jobToken: receipt.jobToken,
      ...(intent.dvmId ? { dvmId: intent.dvmId } : {}),
      capability: intent.capability,
      rail: "none",
    });
    const read = `DVM_JOB_TOKEN=<job_token_bearer_secret> dvm status ${shellQuoteArg(receipt.jobId)} --endpoint ${shellQuoteArg(intent.endpoint)}`;
    throw new DvmError(
      "request_result_conflict",
      `Job ${receipt.jobId} is already a local job from another provider, so the recovered job was not added to the local job list.`,
      kept.job_token
        ? `Do not overwrite the local record. Read the recovered job with '${read}', taking job_token_bearer_secret from evidence row ${kept.ambiguity_id} in 'dvm wallet submissions'.`
        : `Do not overwrite the local record. The provider sent no job token for job ${receipt.jobId}, so this caller cannot read it directly; evidence row ${kept.ambiguity_id} in 'dvm wallet submissions' records the request.`,
      {
        request_id: requestId,
        local_job_id: existing.id,
        local_endpoint: existing.endpoint,
        server_job_id: receipt.jobId,
        ambiguity_id: kept.ambiguity_id,
      }
    );
  }
  const originalData = intent.body.data as Record<string, unknown> | undefined;
  const creditBinding = typeof originalData?.credit_id === "string" && typeof originalData.draw_id === "string"
    ? { creditId: originalData.credit_id, drawId: originalData.draw_id, callerPubkey: intent.callerPubkey }
    : undefined;
  const restored = {
    ...(creditBinding ? { creditBinding } : {}),
    requestId,
    transactionHash: receipt.transactionHash,
    jobToken: receipt.jobToken,
    receipt: receipt.receipt,
    receiptParseError: receipt.receiptParseError,
  };
  if (existing) {
    if (existing.requestId && existing.requestId !== requestId) {
      throw new DvmError(
        "request_result_conflict",
        `Job ${receipt.jobId} is already linked to another request id.`,
        "Do not overwrite the local record."
      );
    }
    updateJob(receipt.jobId, restored);
  } else {
    saveJob({
      id: receipt.jobId,
      endpoint: intent.endpoint,
      dvmId: intent.dvmId,
      capability: intent.capability,
      status: receipt.status === "processing" ? "processing" : "submitted",
      submittedAt: intent.createdAt,
      policy: intent.policy,
      pinnedMint: intent.pinnedMint,
      strictPerCall: intent.strictPerCall,
      maxCashuFeeSats: intent.maxCashuFeeSats,
      paymentMethod: creditBinding && !originalData?.fund ? "credit" : intent.railPayment?.method ?? paymentMethod(receipt),
      receiptsSupported: intent.receiptsSupported,
      builderAnchor: intent.builderAnchor,
      ...restored,
    });
  }

  if (!(creditBinding && !originalData?.fund) && existing?.paymentMethod !== "credit") {
    const accepted = parseUpfrontPayment(receipt.upfrontPayment);
    // A crash can leave the caller price booked by the sweep but absent from the intent.
    const localPayment = intent.railPayment ?? parseUpfrontRailPayment(existing?.upfrontRailPayment);
    const method = localPayment?.method ?? existing?.paymentMethod ?? accepted?.rail ?? paymentMethod(receipt);
    const free = existing?.upfrontRailPayment === "free" || (accepted?.amount_msats === 0 && !method);
    recordUpfrontRailPayment(receipt.jobId, localPayment ?? (free ? "free" : accepted && method
      ? { method, amountMsats: accepted.amount_msats } : undefined));
  }
  recordUpfrontCreditPayment(receipt.jobId, receipt.upfrontPayment, originalData?.fund !== undefined);

  if (
    receipt.status === "completed" ||
    receipt.status === "failed" ||
    receipt.status === "cancelled"
  ) {
    markJobTerminal(receipt.jobId, receipt.status, completionSnapshot(receipt), restored);
  } else {
    updateJob(receipt.jobId, {
      status: receipt.status === "awaiting-input" ? "awaiting-input" : "processing",
      ...restored,
    });
  }
  const captured = captureTransportReceipt(receipt.jobId, receipt);
  const recovered = loadJob(receipt.jobId);
  if (recovered && (receipt.status === "completed" || receipt.status === "failed" || receipt.status === "cancelled")) {
    await settleCreditAfterRead({ job: recovered, capture: captured, transport, human: opts.human });
  }
  // A Cashu payment held for this request is confirmed by the job the provider
  // named; booking it stops the wallet holding it as unconfirmed.
  const confirmed = await bookRecoveredSubmissions({
    publicRequestId: requestId,
    endpoint: intent.endpoint,
    jobId: receipt.jobId,
  });

  if (opts.human) {
    info(`Recovered request ${requestId} as job ${receipt.jobId} (${receipt.status}).`);
    if (confirmed.length > 0) {
      info(`The wallet payment held for this request is now confirmed as spent on that job.`);
    }
    renderReceiptHuman(captured);
    return;
  }
  json({
    request_id: requestId,
    jobId: receipt.jobId,
    status: receipt.status,
    ...(receipt.transactionHash ? { transaction_hash: receipt.transactionHash } : {}),
    ...dvmIdentity(intent.dvmId, intent.capability),
    ...(receipt.summary !== undefined ? { summary: receipt.summary } : {}),
    ...(confirmed.length > 0 ? { confirmed_pending_submissions: confirmed } : {}),
    ...receiptJsonFields(captured),
    next_action:
      receipt.status === "completed" ||
      receipt.status === "failed" ||
      receipt.status === "cancelled"
        ? null
        : {
            type: "poll",
            job_id: receipt.jobId,
            hint: "Recovered the original job; check it for updates",
          },
  });
}

/** Re-sign a persisted secret-free request body with its original caller identity. */
export function signedIntentEnvelope(
  intent: RequestIntent,
  privkey: string,
  route: string
): JobEnvelope {
  const body = intent.body;
  const data = body.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new DvmError("request_intent_unreadable", "The saved request body is not signable.");
  }
  return {
    input: typeof body.input === "string" ? body.input : "",
    capability: typeof body.capability === "string" ? body.capability : undefined,
    params:
      typeof body.params === "object" && body.params !== null && !Array.isArray(body.params)
        ? Object.entries(body.params as Record<string, string>)
        : undefined,
    data: signDvmRequestData(privkey, data as Record<string, unknown>, {
      audience: intent.authAudience,
      method: "POST",
      path: canonicalRequestPath(new URL(route, `${intent.endpoint.replace(/\/$/, "")}/`).href),
      capability: intent.capability,
    }),
    outputType: typeof body.output_type === "string" ? body.output_type : undefined,
    bidMsats: typeof body.bid_msats === "number" ? body.bid_msats : undefined,
  };
}

/**
 * File the refusal as evidence, so the row the hint points at exists even when
 * the original submit timed out and left none. The record is keyed by the
 * request ID; an earlier record under that key is kept as it was.
 */
function recordRequestResultIdentityFailure(
  err: ProviderIdentityError,
  intent: RequestIntent
): ProviderIdentityError {
  const record = recordSubmissionEvidence({
    observation: err.observation,
    endpoint: intent.endpoint,
    ...(intent.dvmId ? { dvmId: intent.dvmId } : {}),
    capability: intent.capability,
    publicRequestId: intent.requestId,
    rail: "none",
  });
  return withRequestResultRecovery(err, {
    ambiguityId: record.ambiguity_id,
    requestId: intent.requestId,
    endpoint: intent.endpoint,
  });
}

function paymentMethod(receipt: JobReceipt): "cashu" | "x402" | "tempo" | "credit" | undefined {
  if (receipt.receipt?.credit) return "credit";
  const rail = receipt.receipt?.paid.rail;
  return rail === "cashu" || rail === "x402" || rail === "tempo" ? rail : undefined;
}
