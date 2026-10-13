import {
  DvmError,
  isStorableJobId,
  JOB_IDENTITY_HEADER,
  parseJobIdentityHeader,
  type PendingSubmissionAcceptedUnresolved,
  shellQuoteArg,
} from "@dvmkit/sdk/internal";

import { info, progress } from "./output";

type DvmErrorProseSources = DvmError["proseSources"];

export type IdentityFailureKind = PendingSubmissionAcceptedUnresolved["kind"];

/** Error code per failure kind. None of them is in a paid-submit retry set. */
export const IDENTITY_FAILURE_CODES: Readonly<Record<IdentityFailureKind, string>> = {
  identity_mismatch: "provider_identity_mismatch",
  body_unreadable: "provider_body_unreadable",
  router_identity_conflict: "hosting_job_identity_conflict",
};

/**
 * What the caller saw when a provider accepted a submission without a settled
 * job identity. The job IDs are bounded to what the wallet journal accepts.
 */
export interface IdentityObservation {
  kind: IdentityFailureKind;
  headerJobId?: string;
  bodyJobId?: string;
  acceptedJobId?: string;
  /**
   * Observed IDs the wallet journal cannot store as-is, escaped and bounded by
   * {@link escapeObservedValue}. Kept for the evidence record; safe to print.
   */
  unstorable?: UnstorableJobIds;
  /** Bearer secret for an anonymous job. Never copied into error `data`, which is printed. */
  jobToken?: string;
  transactionHash?: string;
}

/**
 * A provider or router accepted the submission but the caller cannot tell which
 * job it started. The payment may have landed, so nothing may pay for or resubmit
 * this request automatically.
 */
export class ProviderIdentityError extends DvmError {
  readonly observation: IdentityObservation;

  constructor(
    observation: IdentityObservation,
    message: string,
    hint: string,
    data: Record<string, unknown>,
    proseSources?: DvmErrorProseSources
  ) {
    super(IDENTITY_FAILURE_CODES[observation.kind], message, hint, data, undefined, proseSources);
    this.observation = observation;
  }
}

export function isIdentityFailure(err: unknown): err is ProviderIdentityError {
  return err instanceof ProviderIdentityError;
}

/**
 * A body `job_id` the caller can act on: the same rule `request-result`
 * applies to its body. It is wider than the response-head field's grammar.
 */
export function isParseableBodyJobId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 512 &&
    !hasAsciiControl(value)
  );
}

export function isOpaqueJobToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    value.trim() === value &&
    !hasAsciiControl(value)
  );
}

export interface UnstorableJobIds {
  body_job_id?: string;
  accepted_job_id?: string;
}

/**
 * An observed job ID the wallet journal can store, or undefined. The SDK's
 * wallet save refuses an `accepted_unresolved` record holding anything else.
 */
export function observedJobId(value: unknown): string | undefined {
  return isStorableJobId(value) ? value : undefined;
}

/**
 * Split an observed ID into the storable value, or an escaped and bounded
 * rendering when it is present but not storable. A provider controls these
 * values, so the raw string is never printed or stored unescaped.
 */
export function observeJobId(value: unknown): { stored?: string; escaped?: string } {
  if (value === undefined) return {};
  if (isStorableJobId(value)) return { stored: value };
  return { escaped: escapeObservedValue(value) };
}

/** Longest source text an escaped rendering covers, in UTF-16 code units. */
export const ESCAPED_OBSERVED_VALUE_SOURCE_LIMIT = 1024;

/**
 * JSON-quote a value with every C0, DEL and C1 control character as a `\uXXXX`
 * escape, truncating its source past {@link ESCAPED_OBSERVED_VALUE_SOURCE_LIMIT}.
 * The result contains no control characters.
 */
export function escapeObservedValue(value: unknown): string {
  const source = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  const truncated = source.length > ESCAPED_OBSERVED_VALUE_SOURCE_LIMIT;
  const quoted = JSON.stringify(
    truncated ? source.slice(0, ESCAPED_OBSERVED_VALUE_SOURCE_LIMIT) : source
  ).replace(
    /[\u007f-\u009f]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
  return truncated ? `${quoted} [truncated from ${String(source.length)} characters]` : quoted;
}

export type SettledJobIdentity =
  | {
      kind: "settled";
      jobId: string;
      /** False when the field was malformed: a claim minted beside it is not stored. */
      claimAllowed: boolean;
      headerInvalid: boolean;
    }
  | { kind: "unresolved"; observation: IdentityObservation };

/**
 * Settle a 2xx submission's job identity from its `DVM-Job-Identity-V1` value
 * and its body, `null` when the body could not be read or was not a JSON
 * object. A valid field must equal the body's `job_id`; an absent or malformed
 * field leaves the body as the only source.
 */
export function settleJobIdentity(
  headerValue: string | null,
  body: Record<string, unknown> | null
): SettledJobIdentity {
  const header = parseJobIdentityHeader(headerValue);
  const headerJobId = header.kind === "valid" ? header.jobId : undefined;
  const rawBodyJobId = body?.job_id;
  const jobToken = isOpaqueJobToken(body?.job_token) ? body.job_token : undefined;
  const observed = (kind: IdentityFailureKind): SettledJobIdentity => {
    const bodyJob = observeJobId(rawBodyJobId);
    return {
      kind: "unresolved",
      observation: {
        kind,
        ...(headerJobId ? { headerJobId } : {}),
        ...optionalField("bodyJobId", bodyJob.stored),
        ...(bodyJob.escaped ? { unstorable: { body_job_id: bodyJob.escaped } } : {}),
        ...(jobToken ? { jobToken } : {}),
      },
    };
  };
  if (!isParseableBodyJobId(rawBodyJobId)) return observed("body_unreadable");
  if (headerJobId !== undefined && headerJobId !== rawBodyJobId) {
    return observed("identity_mismatch");
  }
  return {
    kind: "settled",
    jobId: rawBodyJobId,
    claimAllowed: header.kind !== "invalid",
    headerInvalid: header.kind === "invalid",
  };
}

/**
 * A funded router's 409 refusing a provider that answered a request with a job
 * other than the one the router first accepted. The router's envelope is
 * `{error: {code, message, display, hint, accepted_job_id, request_id?}, trace_id}`.
 */
export function routerConflictObservation(
  status: number,
  body: Record<string, unknown> | null
): IdentityObservation | undefined {
  if (status !== 409 || !body) return undefined;
  const error = body.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const envelope = error as Record<string, unknown>;
  if (envelope.code !== IDENTITY_FAILURE_CODES.router_identity_conflict) return undefined;
  const accepted = observeJobId(envelope.accepted_job_id);
  return {
    kind: "router_identity_conflict",
    ...optionalField("acceptedJobId", accepted.stored),
    ...(accepted.escaped ? { unstorable: { accepted_job_id: accepted.escaped } } : {}),
  };
}

/** Read the raw field value the way the shared parser expects it. */
export function jobIdentityHeaderValue(headers: Headers): string | null {
  return headers.get(JOB_IDENTITY_HEADER);
}

/** Build the transport error for an unresolved identity. Callers add recovery context later. */
export function identityError(
  observation: IdentityObservation,
  providerProse?: { display?: string; proseSources?: DvmErrorProseSources }
): ProviderIdentityError {
  const { message, display } = describeIdentityFailure(observation);
  return new ProviderIdentityError(
    observation,
    message,
    "Do not pay for this request again. Run 'dvm wallet submissions' to see what was recorded.",
    {
      identity_kind: observation.kind,
      ...identityDataFields(observation),
      display: providerProse?.display ?? display,
    },
    providerProse?.proseSources
  );
}

/**
 * Point the error at the recorded evidence. The hint leads with the read-only
 * request lookup when the submission carried a public request ID.
 */
export function withIdentityRecovery(
  err: ProviderIdentityError,
  ctx: { ambiguityId: string; publicRequestId?: string; cashuRequestId?: string }
): ProviderIdentityError {
  const hint = ctx.publicRequestId
    ? `Run 'dvm request-result ${ctx.publicRequestId}' to read the accepted job. Do not pay for this request again; 'dvm wallet submissions' shows the recorded evidence (${ctx.ambiguityId}).`
    : `Run 'dvm wallet submissions' to see the recorded evidence (${ctx.ambiguityId}) and how to read each job it names. Do not pay for this request again.`;
  return new ProviderIdentityError(
    err.observation,
    err.message,
    hint,
    {
      ...err.data,
      ambiguity_id: ctx.ambiguityId,
      ...(ctx.publicRequestId ? { request_id: ctx.publicRequestId } : {}),
      ...(ctx.cashuRequestId ? { cashu_request_id: ctx.cashuRequestId } : {}),
      claim_stored: false,
    },
    err.proseSources
  );
}

/**
 * Recovery for an identity failure met by `request-result` itself. The router's
 * own hint, and the usual one, point back at request-result, which would meet
 * the same refusal while the provider keeps answering another job; this hint
 * names a direct read of the accepted job instead.
 */
export function withRequestResultRecovery(
  err: ProviderIdentityError,
  ctx: { ambiguityId: string; requestId: string; endpoint: string }
): ProviderIdentityError {
  const jobId = err.observation.acceptedJobId;
  const read = `dvm status ${jobId ? shellQuoteArg(jobId) : "<accepted_job_id>"} --endpoint ${shellQuoteArg(ctx.endpoint)} --job-token <job_token_bearer_secret>`;
  const hint =
    `Do not pay again. Running request-result again meets the same refusal while the provider keeps answering with a different job. ` +
    `Read ${jobId ? `job ${jobId}` : "the accepted job"} directly with '${read}', taking the job token from a row for request ${ctx.requestId} in 'dvm wallet submissions' (this refusal is recorded as ${ctx.ambiguityId}). ` +
    `If no row for it holds a job token, this caller never received one for that job.`;
  return new ProviderIdentityError(
    err.observation,
    err.message,
    hint,
    { ...err.data, ambiguity_id: ctx.ambiguityId, request_id: ctx.requestId, claim_stored: false },
    err.proseSources
  );
}

/**
 * The printable identity fields. Never includes the job token; an ID that is
 * not storable appears only in its escaped form.
 */
export function identityDataFields(observation: IdentityObservation): Record<string, string> {
  return {
    ...optionalField("header_job_id", observation.headerJobId),
    ...optionalField("body_job_id", observation.bodyJobId),
    ...optionalField("body_job_id_escaped", observation.unstorable?.body_job_id),
    ...optionalField("accepted_job_id", observation.acceptedJobId),
    ...optionalField("accepted_job_id_escaped", observation.unstorable?.accepted_job_id),
  };
}

/**
 * Report a malformed field without echoing it. JSON callers get a structured
 * stderr event so stdout keeps its single result document.
 */
export function warnInvalidJobIdentityHeader(): void {
  const display =
    "The provider sent a malformed job identity header, so it was ignored and the job ID was taken from the response body.";
  if (process.stderr.isTTY === true) {
    info(`Warning: ${display}`);
    return;
  }
  progress({ event: "warning", code: "job_identity_header_invalid", display });
}

function describeIdentityFailure(observation: IdentityObservation): {
  message: string;
  display: string;
} {
  switch (observation.kind) {
    case "identity_mismatch":
      return {
        message: `The provider accepted the request but named job ${observation.headerJobId ?? "(unknown)"} in its response header and job ${observation.bodyJobId ?? "(unrepresentable)"} in its body.`,
        display:
          "The provider took this request but gave two different job IDs for it, so it is unclear which job is yours. Do not pay for it again.",
      };
    case "body_unreadable":
      return {
        message: observation.headerJobId
          ? `The provider accepted the request as job ${observation.headerJobId}, but its response body could not be read.`
          : "The provider accepted the request, but its response did not state a readable job ID.",
        display:
          "The provider took this request but its reply could not be read, so it is unclear which job is yours. Do not pay for it again.",
      };
    case "router_identity_conflict":
      return {
        message: `The router had already accepted job ${observation.acceptedJobId ?? "(unknown)"} for this request, and the provider answered with a different job.`,
        display:
          "This request was already accepted as a different job. Do not pay for it again.",
      };
  }
}

function hasAsciiControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function optionalField<K extends string>(
  key: K,
  value: string | undefined
): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}
