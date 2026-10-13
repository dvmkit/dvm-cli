import {
  DvmError,
  isPublicRequestId,
} from "@dvmkit/sdk/internal";
import {
  findSigningIdentityByPubkey,
} from "../lib/cli-identity-resolve";

import { loadRequestIntent } from "../lib/request-intent-store";
import { requestRecoveryPath } from "../lib/request-recovery-path";
import { createDvmTransport } from "../lib/transport";
import { requestResult, type RequestResultOptions, signedIntentEnvelope } from "./request-result";

export interface RequestResumeOptions extends RequestResultOptions {
  /** Submit timeout in seconds. */
  timeout?: string;
}

/**
 * Resume only a server-side acceptance already durably bound to this request.
 * No payment credential is loaded or attached; the dedicated server route
 * refuses unless the original request already has a committed draw.
 */
export async function requestResume(
  requestId: string,
  opts: RequestResumeOptions = {}
): Promise<void> {
  if (!isPublicRequestId(requestId)) {
    throw new DvmError(
      "invalid_request_id",
      "Invalid request id.",
      "Use 1–128 characters: letters, digits, dot, underscore, colon, or hyphen."
    );
  }

  // A job may have landed since the caller last checked. Prefer the strictly
  // read-only route and enter the mutating resume path only on a real 404.
  try {
    await requestResult(requestId, opts);
    return;
  } catch (error) {
    if (!(error instanceof DvmError) || error.code !== "request_not_found") throw error;
  }

  const intent = loadRequestIntent(requestId);
  if (!intent) {
    throw new DvmError(
      "request_not_found",
      `No local intent exists for request ${requestId}.`,
      "The outcome is unknown. Restore the original caller state; never submit or pay for a replacement.",
      { request_id: requestId, status: "unknown" }
    );
  }
  const signer = findSigningIdentityByPubkey(intent.callerPubkey);
  if (!signer) {
    throw new DvmError(
      "request_identity_unavailable",
      `The identity that signed request ${requestId} is no longer available.`,
      "Restore that caller identity. Resume deliberately refuses a different signer."
    );
  }

  const timeoutMs = parseTimeout(opts.timeout);
  const transport = createDvmTransport();
  try {
    await transport.requestResume(
      { endpoint: intent.endpoint },
      requestId,
      signedIntentEnvelope(intent, signer.privkey, requestRecoveryPath("request-resume", requestId)),
      timeoutMs === undefined ? undefined : { timeoutMs }
    );
  } catch (error) {
    if (error instanceof DvmError && error.code === "request_id_exists") {
      await requestResult(requestId, opts);
      return;
    }
    if (error instanceof DvmError && error.code === "request_not_accepted") throw error;
    throw new DvmError(
      "request_outcome_unknown",
      `The provider did not complete recovery for request ${requestId}.`,
      `No payment credential was sent. Run 'dvm request-result ${requestId}', then retry 'dvm request-resume ${requestId}' if it is still unknown.`,
      {
        request_id: requestId,
        status: "unknown",
        cause: error instanceof Error ? error.message : String(error),
      }
    );
  } finally {
    transport.close();
  }

  // Read the canonical server record through the strict response validator and
  // restore local job/token/receipt state in one place.
  await requestResult(requestId, opts);
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new DvmError("invalid_timeout", "Invalid timeout.", "Pass a positive number of seconds.");
  }
  return seconds * 1000;
}
