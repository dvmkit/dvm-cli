import { sameEndpoint } from "./provider-endpoint";
export { sameEndpoint } from "./provider-endpoint";
import {
  DvmError,
  type ProviderRef,
} from "@dvmkit/sdk/internal";
import {
  type JobRecord,
  loadJob,
} from "./job-store";

import { resolveEndpoint } from "./favorites";
import { listSubmissionEvidence } from "./submission-evidence";

export interface JobAccessOptions {
  /** Provider base URL. Falls back through DVM_JOB_ENDPOINT to the stored job. */
  endpoint?: string;
  /** Opaque per-job bearer credential. Falls back through DVM_JOB_TOKEN to the stored job. */
  jobToken?: string;
}

export interface ResolvedJobAccess {
  stored: JobRecord | null;
  ref: ProviderRef;
  jobToken?: string;
  /** True when either value came from a flag or environment variable. */
  overridden: boolean;
  /** True when the endpoint, specifically, came from a flag or environment variable. */
  endpointOverridden: boolean;
}

export interface ResolvedStoredJobAccess extends ResolvedJobAccess {
  stored: JobRecord;
}

/**
 * Resolve portable job access without persisting either override.
 *
 * A locally-known authenticated job can legitimately have no `jobToken`, so a
 * token is mandatory only when there is no record to carry the caller's other
 * authentication context. Endpoint aliases retain the same `@favorite`
 * behaviour as `request --endpoint`.
 */
export function resolveJobAccess(jobId: string, opts: JobAccessOptions): ResolvedJobAccess {
  const stored = loadJob(jobId);
  return resolveJobAccessWithRecord(jobId, opts, stored);
}

function resolveJobAccessWithRecord(
  jobId: string,
  opts: JobAccessOptions,
  record: JobRecord | null
): ResolvedJobAccess {
  const endpointOverride = opts.endpoint ?? process.env.DVM_JOB_ENDPOINT;
  const tokenOverride = opts.jobToken ?? process.env.DVM_JOB_TOKEN;
  const endpointOverridden = endpointOverride !== undefined;
  const tokenOverridden = tokenOverride !== undefined;
  // A local job with this ID from another endpoint is a different job. Its
  // token was issued by that endpoint and is never sent to this one, so the
  // access resolves as if no local record existed.
  const foreign =
    record !== null &&
    endpointOverride !== undefined &&
    !sameEndpoint(resolveEndpoint(endpointOverride), record.endpoint);
  const stored = foreign ? null : record;
  const rawEndpoint = endpointOverride ?? stored?.endpoint;
  const jobToken = tokenOverride ?? stored?.jobToken;

  if (!stored && rawEndpoint === undefined && jobToken === undefined) {
    throw new DvmError(
      "job_access_required",
      `Job ${jobId} is not in the local store, and no portable job access was supplied.`,
      "Pass --endpoint <url> and --job-token <hex>, or set DVM_JOB_ENDPOINT and DVM_JOB_TOKEN."
    );
  }
  if (rawEndpoint === undefined) {
    throw new DvmError(
      "job_endpoint_required",
      `No provider endpoint is available for job ${jobId}.`,
      "Pass --endpoint <url> or set DVM_JOB_ENDPOINT."
    );
  }
  if (foreign && jobToken === undefined) {
    throw foreignJobTokenRequired(jobId, record.endpoint, resolveEndpoint(endpointOverride));
  }
  if (!stored && jobToken === undefined) {
    throw new DvmError(
      "job_token_required",
      `No job token is available for job ${jobId}.`,
      "Pass --job-token <hex> or set DVM_JOB_TOKEN."
    );
  }
  if (tokenOverridden && !isJobToken(jobToken)) {
    throw new DvmError(
      "invalid_job_token",
      "The supplied job token is not a 64-character hexadecimal value.",
      "Copy the job_token returned when the job was submitted; the value is never printed by this command."
    );
  }

  return {
    stored,
    ref: { endpoint: validateProviderEndpoint(resolveEndpoint(rawEndpoint)) },
    ...(jobToken !== undefined ? { jobToken } : {}),
    overridden: endpointOverridden || tokenOverridden,
    endpointOverridden,
  };
}

/** Resolve access for `pay`, which must retain its local spending guard. */
export function resolveStoredJobAccess(
  jobId: string,
  opts: JobAccessOptions
): ResolvedStoredJobAccess {
  const stored = loadJob(jobId);
  if (!stored) {
    throw new DvmError(
      "job_payment_state_required",
      `Cannot pay job ${jobId} without its local payment state.`,
      "Run 'dvm pay' where the job record and message history are available (normally the submitting machine). An endpoint and job token cannot reconstruct its pending request and spending policy."
    );
  }
  return { ...resolveJobAccessWithRecord(jobId, opts, stored), stored };
}

/** Run provider work while ensuring a hostile response cannot echo the bearer token. */
export async function withJobTokenRedaction<T>(
  jobToken: string | undefined,
  action: () => Promise<T>
): Promise<T> {
  try {
    return await action();
  } catch (err) {
    throw redactJobTokenFromError(err, jobToken);
  }
}

export function redactJobTokenFromError(err: unknown, jobToken: string | undefined): unknown {
  if (!jobToken || !(err instanceof DvmError)) return err;
  const redact = (value: string): string => value.replaceAll(jobToken, "[REDACTED]");
  return new DvmError(
    err.code,
    redact(err.message),
    err.hint === undefined ? undefined : redact(err.hint),
    err.data === undefined ? undefined : redactRecord(err.data, redact),
    err.display === undefined ? undefined : redact(err.display),
    err.proseSources
  );
}

/**
 * The refusal for a local job's ID named at another endpoint: why the stored
 * token stays home, and the evidence row that holds the other job's token
 * when this caller received one.
 */
function foreignJobTokenRequired(jobId: string, localEndpoint: string, endpoint: string): DvmError {
  const row = evidenceRowWithToken(jobId, endpoint);
  return new DvmError(
    "job_token_required",
    `Local job ${jobId} belongs to ${localEndpoint}. Its job token was issued there and is not sent to ${endpoint}.`,
    row
      ? `The job token for ${jobId} at ${endpoint} is job_token_bearer_secret on evidence row ${row} in 'dvm wallet submissions'. Pass it with --job-token or DVM_JOB_TOKEN.`
      : `Pass the job token ${endpoint} issued for ${jobId} with --job-token or DVM_JOB_TOKEN. No evidence row in 'dvm wallet submissions' holds one for it.`,
    {
      job_id: jobId,
      local_endpoint: localEndpoint,
      endpoint,
      ...(row ? { ambiguity_id: row } : {}),
    }
  );
}

/** The newest evidence row holding a job token for this job at this endpoint. */
function evidenceRowWithToken(jobId: string, endpoint: string): string | undefined {
  let records;
  try {
    ({ records } = listSubmissionEvidence());
  } catch {
    return undefined;
  }
  return records
    .filter(
      (record) =>
        record.job_token !== undefined &&
        sameEndpoint(record.endpoint, endpoint) &&
        [record.header_job_id, record.body_job_id, record.accepted_job_id].includes(jobId)
    )
    .at(-1)?.ambiguity_id;
}

function isJobToken(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-fA-F]{64}$/.test(value);
}

function validateProviderEndpoint(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname) return value;
  } catch {
  }
  throw new DvmError(
    "invalid_endpoint",
    "The supplied job endpoint is not a valid HTTP(S) provider URL.",
    "Pass a full URL such as https://provider.example, or a favorite alias such as @provider."
  );
}

function redactRecord(
  record: Record<string, unknown>,
  redact: (value: string) => string
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, redactValue(value, redact)])
  );
}

function redactValue(value: unknown, redact: (value: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, redact));
  if (value && typeof value === "object") {
    return redactRecord(value as Record<string, unknown>, redact);
  }
  return value;
}
