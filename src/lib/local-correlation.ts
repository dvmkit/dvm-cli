import {
  DvmError,
} from "@dvmkit/sdk/internal";
import {
  loadAllJobs,
  type JobRecord,
} from "./job-store";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LocallyCorrelatedJob = JobRecord & { localCorrelationId?: string };

/**
 * Validate and reserve a caller-local correlation marker before any provider I/O.
 * The marker never enters the wire request; it only disambiguates a locally saved
 * anonymous job when the command's stdout is lost after `saveJob` succeeds.
 */
export function prepareLocalCorrelationId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const id = normalizeLocalCorrelationId(raw);
  assertLocalCorrelationIdUnused(id, loadAllJobs() as LocallyCorrelatedJob[]);
  return id;
}

export function normalizeLocalCorrelationId(raw: string): string {
  if (!UUID_V4.test(raw)) {
    throw new DvmError(
      "invalid_local_correlation_id",
      "Invalid value for --local-correlation-id.",
      "Pass a freshly generated UUID v4. The value is stored only in the local job record."
    );
  }
  return raw.toLowerCase();
}

export function assertLocalCorrelationIdUnused(
  id: string,
  jobs: readonly LocallyCorrelatedJob[]
): void {
  if (!jobs.some((job) => job.localCorrelationId === id)) return;
  throw new DvmError(
    "local_correlation_id_exists",
    `Local correlation id ${id} is already attached to a job.`,
    "Read that saved job instead of submitting a replacement, or use a fresh UUID for a new request."
  );
}

export function localCorrelationJobFields(
  id: string | undefined
): { localCorrelationId?: string } {
  return id ? { localCorrelationId: id } : {};
}
