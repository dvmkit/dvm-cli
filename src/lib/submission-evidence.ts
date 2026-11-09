import {
  CONFIG_DIR,
  DvmError,
  ensureConfigSubdir,
  type PendingSubmissionAcceptedUnresolved,
} from "@dvmkit/sdk/internal";
import { createHash, randomUUID } from "crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import type { JobRecord } from "./job-store";
import { sameEndpoint } from "./provider-endpoint";

import {
  type IdentityFailureKind,
  type IdentityObservation,
  isOpaqueJobToken,
  observedJobId,
  type ProviderIdentityError,
  type UnstorableJobIds,
  withIdentityRecovery,
} from "./job-identity";

/**
 * Private evidence of accepted submissions, including jobs whose local save failed.
 * It lives outside the job store on purpose: the job store resolves the first
 * record with a matching ID, so evidence filed under a provider-chosen ID could
 * be hidden behind an existing job. Records are keyed by a request-scoped value
 * and never by a job ID.
 */
export const SUBMISSION_EVIDENCE_DIR = join(CONFIG_DIR, "submission-evidence");

export type SubmissionEvidenceRail = "cashu" | "x402" | "tempo" | "credit" | "none";

/**
 * An identity failure, or `local_job_collision`: a job read back by request ID
 * whose job ID a local job from another provider already holds. Only an
 * identity failure marks a journal entry.
 */
export type SubmissionEvidenceKind = IdentityFailureKind | "local_job_collision";

export interface SubmissionEvidenceRecord {
  v: 1;
  /** Request-scoped key; for an identity failure, the journal marker's `ambiguity_id` too. */
  ambiguity_id: string;
  kind: SubmissionEvidenceKind;
  observed_at: string;
  endpoint: string;
  dvm_id?: string;
  capability?: string;
  /** Public request ID, when the submission carried one. */
  request_id?: string;
  /** Cashu journal `X-Cashu-Request-Id`, when a journal entry exists. */
  cashu_request_id?: string;
  /**
   * How the observed call paid. `none` when it presented no payment: a probe
   * that drew no credit, or `request-result` reading back an earlier submit.
   */
  rail: SubmissionEvidenceRail;
  rail_correlation?: Record<string, string | number>;
  /** Bearer secret for an anonymous job. Shown only where it is labelled as one. */
  job_token?: string;
  header_job_id?: string;
  body_job_id?: string;
  accepted_job_id?: string;
  /**
   * Observed IDs too long or holding control characters for the wallet journal,
   * escaped and bounded. The raw values are never stored.
   */
  unstorable_job_ids?: UnstorableJobIds;
  /** No router feedback claim was stored for any observed job ID. */
  claim_stored: false;
}

export interface AcceptedJobAccessRecord {
  v: 1;
  kind: "accepted_job_access";
  ambiguity_id: string;
  observed_at: string;
  access_id: string;
  sequence: number;
  job: JobRecord;
}

type PrivateEvidenceRecord = SubmissionEvidenceRecord | AcceptedJobAccessRecord;

/** Each snapshot has its own request-scoped key, so cleanup cannot unlink a newer observation. */
export function recordAcceptedJobAccess(job: JobRecord, accessId: string, sequence: number): void {
  publishOnce({
    v: 1,
    kind: "accepted_job_access",
    ambiguity_id: `${accessId}#accepted-access#${sequence}`,
    observed_at: new Date().toISOString(),
    access_id: accessId,
    sequence,
    job,
  });
}

export function listAcceptedJobAccess(): AcceptedJobAccessRecord[] {
  return listPrivateEvidence().records.filter((record) => record.kind === "accepted_job_access");
}

/** A job ID alone is usable only when every matching access record belongs to one endpoint. */
export function findAcceptedJobAccess(jobId: string, endpoint?: string): JobRecord | null {
  let records;
  try { records = listAcceptedJobAccess(); } catch { return null; }
  const matches = latestAcceptedJobAccess(records).filter(({ job }) =>
    job.id === jobId && (endpoint === undefined || sameEndpoint(job.endpoint, endpoint)));
  if (!matches.length || matches.some(({ job }) => !sameEndpoint(job.endpoint, matches[0].job.endpoint))) return null;
  return matches.at(-1)!.job;
}

export function latestAcceptedJobAccess(records: AcceptedJobAccessRecord[]): AcceptedJobAccessRecord[] {
  const latest = new Map<string, AcceptedJobAccessRecord>();
  for (const record of records) {
    const previous = latest.get(record.access_id);
    if (!previous || previous.sequence < record.sequence) latest.set(record.access_id, record);
  }
  return [...latest.values()].sort((a, b) => a.observed_at.localeCompare(b.observed_at));
}

/** Remove only snapshots already covered by a durable jobs-file write. */
export function removeAcceptedJobAccess(records: AcceptedJobAccessRecord[]): void {
  for (const record of records) {
    try { unlinkSync(evidencePath(record.ambiguity_id)); } catch { /* A leftover snapshot is safe to fold again. */ }
  }
}

export interface SubmissionEvidenceInput {
  observation: IdentityObservation;
  endpoint: string;
  dvmId?: string;
  capability?: string;
  publicRequestId?: string;
  cashuRequestId?: string;
  rail: SubmissionEvidenceRail;
  railCorrelation?: Record<string, string | number>;
  now?: () => number;
}

/** The record key: the Cashu journal ID, else the public request ID, else a fresh UUID. */
export function submissionEvidenceKey(args: {
  cashuRequestId?: string;
  publicRequestId?: string;
}): string {
  return args.cashuRequestId ?? args.publicRequestId ?? randomUUID();
}

/**
 * Write the record once and return what is stored. A second write under the
 * same key keeps the first observation, so a crash-and-replay that detects the
 * same failure again changes nothing.
 */
export function recordSubmissionEvidence(input: SubmissionEvidenceInput): SubmissionEvidenceRecord {
  const ambiguityId = submissionEvidenceKey(input);
  const existing = loadSubmissionEvidence(ambiguityId);
  if (existing) return existing;

  const { observation } = input;
  const jobToken = isOpaqueJobToken(observation.jobToken) ? observation.jobToken : undefined;
  const record: SubmissionEvidenceRecord = {
    v: 1,
    ambiguity_id: ambiguityId,
    kind: observation.kind,
    observed_at: new Date((input.now ?? Date.now)()).toISOString(),
    endpoint: input.endpoint,
    ...(input.dvmId ? { dvm_id: input.dvmId } : {}),
    ...(input.capability ? { capability: input.capability } : {}),
    ...(input.publicRequestId ? { request_id: input.publicRequestId } : {}),
    ...(input.cashuRequestId ? { cashu_request_id: input.cashuRequestId } : {}),
    rail: input.rail,
    ...(input.railCorrelation && Object.keys(input.railCorrelation).length > 0
      ? { rail_correlation: input.railCorrelation }
      : {}),
    ...(jobToken ? { job_token: jobToken } : {}),
    ...boundedIds(observation),
    ...(observation.unstorable && Object.keys(observation.unstorable).length > 0
      ? { unstorable_job_ids: observation.unstorable }
      : {}),
    claim_stored: false,
  };
  return publishOnce(record);
}

/**
 * Keep a job read back by request ID whose job ID a local job from another
 * provider already holds. The job store never takes it, so this record is
 * where its job token is kept for a direct read. Its key differs from every
 * journal ID, which keeps it from marking a journal entry, and from the key of
 * the request's identity records.
 */
export function recordLocalJobCollision(input: {
  publicRequestId: string;
  endpoint: string;
  jobId: string;
  jobToken: unknown;
  dvmId?: string;
  capability?: string;
  cashuRequestId?: string;
  rail: SubmissionEvidenceRail;
  railCorrelation?: Record<string, string | number>;
  now?: () => number;
}): SubmissionEvidenceRecord {
  // `#` is in neither the public request-ID grammar nor a journal UUID.
  const ambiguityId = `${input.publicRequestId}#local-job-collision`;
  const existing = loadSubmissionEvidence(ambiguityId);
  if (existing) return existing;
  const jobToken = isOpaqueJobToken(input.jobToken) ? input.jobToken : undefined;
  return publishOnce({
    v: 1,
    ambiguity_id: ambiguityId,
    kind: "local_job_collision",
    observed_at: new Date((input.now ?? Date.now)()).toISOString(),
    endpoint: input.endpoint,
    ...(input.dvmId ? { dvm_id: input.dvmId } : {}),
    ...(input.capability ? { capability: input.capability } : {}),
    request_id: input.publicRequestId,
    ...(input.cashuRequestId ? { cashu_request_id: input.cashuRequestId } : {}),
    rail: input.rail,
    ...(input.railCorrelation && Object.keys(input.railCorrelation).length > 0
      ? { rail_correlation: input.railCorrelation }
      : {}),
    ...(jobToken ? { job_token: jobToken } : {}),
    ...boundedIds({ acceptedJobId: input.jobId }),
    claim_stored: false,
  });
}

/**
 * Record an identity failure and point the error at the record, before the
 * error surfaces. An error that already names its record passes through, so an
 * outer layer never writes a second record for the same failure.
 */
export function recordIdentityFailure(
  err: ProviderIdentityError,
  input: Omit<SubmissionEvidenceInput, "observation">
): { error: ProviderIdentityError; record: SubmissionEvidenceRecord | null } {
  if (identityFailureRecorded(err)) return { error: err, record: null };
  const record = recordSubmissionEvidence({ ...input, observation: err.observation });
  return {
    error: withIdentityRecovery(err, {
      ambiguityId: record.ambiguity_id,
      ...(input.publicRequestId ? { publicRequestId: input.publicRequestId } : {}),
      ...(input.cashuRequestId ? { cashuRequestId: input.cashuRequestId } : {}),
    }),
    record,
  };
}

export function identityFailureRecorded(err: ProviderIdentityError): boolean {
  return typeof err.data?.ambiguity_id === "string";
}

export function loadSubmissionEvidence(ambiguityId: string): SubmissionEvidenceRecord | null {
  const record = loadPrivateEvidence(ambiguityId);
  return record?.kind === "accepted_job_access" ? null : record;
}

function loadPrivateEvidence(ambiguityId: string): PrivateEvidenceRecord | null {
  const path = evidencePath(ambiguityId);
  if (!existsSync(path)) return null;
  const record = readRecord(path);
  if (record.ambiguity_id !== ambiguityId) throw unreadable(path, "key mismatch");
  return record;
}

export interface UnreadableSubmissionEvidence {
  path: string;
  cause: string;
}

/**
 * Every readable record, oldest first, and every damaged file by path. A
 * damaged file is reported rather than hidden, and never hides the others.
 */
export function listSubmissionEvidence(): {
  records: SubmissionEvidenceRecord[];
  unreadable: UnreadableSubmissionEvidence[];
} {
  const listed = listPrivateEvidence();
  return { ...listed, records: listed.records.filter((record) => record.kind !== "accepted_job_access") };
}

function listPrivateEvidence(): { records: PrivateEvidenceRecord[]; unreadable: UnreadableSubmissionEvidence[] } {
  if (!existsSync(SUBMISSION_EVIDENCE_DIR)) return { records: [], unreadable: [] };
  const records: PrivateEvidenceRecord[] = [];
  const unreadable: UnreadableSubmissionEvidence[] = [];
  for (const name of readdirSync(SUBMISSION_EVIDENCE_DIR).filter((n) => n.endsWith(".json"))) {
    const path = join(SUBMISSION_EVIDENCE_DIR, name);
    try {
      records.push(readRecord(path));
    } catch (error) {
      const cause = error instanceof DvmError ? error.data?.cause : undefined;
      unreadable.push({ path, cause: typeof cause === "string" ? cause : "unreadable" });
    }
  }
  records.sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  return { records, unreadable };
}

/** The wallet journal marker that points at this record. */
export function journalMarkerFor(record: SubmissionEvidenceRecord): PendingSubmissionAcceptedUnresolved {
  const kind = record.kind;
  // A collision record is keyed apart from every journal ID, and the journal
  // takes only the SDK's identity kinds.
  if (kind === "local_job_collision") {
    throw unreadable(evidencePath(record.ambiguity_id), "not an identity failure");
  }
  return {
    kind,
    observed_at: record.observed_at,
    ...boundedMarkerIds(record),
    ambiguity_id: record.ambiguity_id,
  };
}

function publishOnce<T extends PrivateEvidenceRecord>(record: T): T {
  const ambiguityId = record.ambiguity_id;
  ensureConfigSubdir(SUBMISSION_EVIDENCE_DIR);
  const target = evidencePath(ambiguityId);
  const temp = `${target}.${String(process.pid)}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(record, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    // A hard link publishes the complete file only if no record exists yet.
    linkSync(temp, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    unlinkSync(temp);
  }
  fsyncDirectory(SUBMISSION_EVIDENCE_DIR);
  const stored = loadPrivateEvidence(ambiguityId) ?? record;
  if (stored.kind !== record.kind) throw unreadable(target, "kind mismatch");
  return stored as T;
}

function boundedIds(
  observation: Pick<IdentityObservation, "headerJobId" | "bodyJobId" | "acceptedJobId">
): {
  header_job_id?: string;
  body_job_id?: string;
  accepted_job_id?: string;
} {
  const header = observedJobId(observation.headerJobId);
  const body = observedJobId(observation.bodyJobId);
  const accepted = observedJobId(observation.acceptedJobId);
  return {
    ...(header !== undefined ? { header_job_id: header } : {}),
    ...(body !== undefined ? { body_job_id: body } : {}),
    ...(accepted !== undefined ? { accepted_job_id: accepted } : {}),
  };
}

function boundedMarkerIds(record: SubmissionEvidenceRecord) {
  return boundedIds({
    headerJobId: record.header_job_id,
    bodyJobId: record.body_job_id,
    acceptedJobId: record.accepted_job_id,
  });
}

function evidencePath(ambiguityId: string): string {
  // Hashed so a public request ID never shapes a path.
  const name = createHash("sha256").update(ambiguityId).digest("hex");
  return join(SUBMISSION_EVIDENCE_DIR, `${name}.json`);
}

function readRecord(path: string): PrivateEvidenceRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // JSON parser diagnostics can quote the bearer secret from a damaged file.
    throw unreadable(path, "invalid JSON or unreadable file");
  }
  if (!isEvidenceRecord(parsed) && !isAcceptedJobAccessRecord(parsed)) throw unreadable(path, "invalid shape");
  return parsed;
}

function unreadable(path: string, cause: string): DvmError {
  return new DvmError(
    "submission_evidence_unreadable",
    `A submission evidence record at ${path} is unreadable.`,
    "Restore it from a backup. Do not pay again for any request it may describe; automatic retries stay off until it reads.",
    { cause }
  );
}

const KINDS: ReadonlySet<unknown> = new Set([
  "identity_mismatch",
  "body_unreadable",
  "router_identity_conflict",
  "local_job_collision",
]);
const RAILS: ReadonlySet<unknown> = new Set(["cashu", "x402", "tempo", "credit", "none"]);

function isEvidenceRecord(value: unknown): value is SubmissionEvidenceRecord {
  if (!isPlainObject(value)) return false;
  const record = value;
  const optionalString = (key: string) =>
    record[key] === undefined || typeof record[key] === "string";
  return (
    record.v === 1 &&
    typeof record.ambiguity_id === "string" &&
    KINDS.has(record.kind) &&
    typeof record.observed_at === "string" &&
    typeof record.endpoint === "string" &&
    RAILS.has(record.rail) &&
    record.claim_stored === false &&
    isOptionalStringRecord(record.unstorable_job_ids) &&
    (record.rail_correlation === undefined || isPlainObject(record.rail_correlation)) &&
    [
      "dvm_id",
      "capability",
      "request_id",
      "cashu_request_id",
      "job_token",
      "header_job_id",
      "body_job_id",
      "accepted_job_id",
    ].every(optionalString)
  );
}

function isAcceptedJobAccessRecord(value: unknown): value is AcceptedJobAccessRecord {
  if (!isPlainObject(value) || !isPlainObject(value.job)) return false;
  const job = value.job;
  return value.v === 1 && value.kind === "accepted_job_access" &&
    typeof value.ambiguity_id === "string" && typeof value.access_id === "string" &&
    Number.isSafeInteger(value.sequence) && (value.sequence as number) >= 0 &&
    value.ambiguity_id === `${value.access_id}#accepted-access#${value.sequence}` &&
    typeof value.observed_at === "string" && typeof job.id === "string" &&
    typeof job.endpoint === "string" && typeof job.submittedAt === "number" &&
    typeof job.status === "string" && isOpaqueJobToken(job.jobToken);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalStringRecord(value: unknown): boolean {
  return (
    value === undefined ||
    (isPlainObject(value) && Object.values(value).every((entry) => typeof entry === "string"))
  );
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
