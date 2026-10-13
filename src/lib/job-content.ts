import { type JobStatus, type ProviderRef, type Transport } from "@dvmkit/sdk/internal";
import { type JobContentMetadata } from "@dvmkit/sdk/server";

// The transport's shared status type predates these optional wire fields.
export type ContentStatus = JobStatus & Partial<JobContentMetadata>;

export function parseJobContent(data: Record<string, unknown>): Partial<JobContentMetadata> {
  return {
    ...(data.content_expires_at === null ||
    (typeof data.content_expires_at === "number" &&
      Number.isSafeInteger(data.content_expires_at) &&
      Math.abs(data.content_expires_at) <= 8.64e15)
      ? { content_expires_at: data.content_expires_at }
      : {}),
    ...(typeof data.content_available === "boolean"
      ? { content_available: data.content_available }
      : {}),
  };
}

export function jobContentFields(
  jobId: string,
  observed?: Partial<JobContentMetadata>
): Record<string, unknown> {
  const metadata = parseJobContent((observed ?? {}) as Record<string, unknown>);
  const known =
    metadata.content_expires_at !== undefined && metadata.content_available !== undefined;
  const availability = metadata.content_available === false
    ? "Provider content is unavailable. The job outcome and financial receipt remain separate evidence."
    : metadata.content_available === true
      ? "Provider content is available."
      : "Current provider content availability is unknown.";
  const expiry = metadata.content_expires_at === null
    ? "No automatic content expiry is scheduled."
    : metadata.content_expires_at !== undefined
      ? `Automatic content expiry: ${new Date(metadata.content_expires_at).toISOString()}. A passed deadline alone does not prove content is unavailable.`
      : "Current automatic content expiry is unknown.";
  const save = metadata.content_available === false
    ? `Check existing local saves and 'dvm receipts verify ${jobId}' for stored receipt evidence.`
    : `Save message output with 'dvm messages ${jobId} --no-stream > messages.json'. For portable jobs, retain your original --endpoint and --job-token options before the redirection, or keep DVM_JOB_ENDPOINT and DVM_JOB_TOKEN set. Use '--human' to save artifacts to private temporary files at the printed paths. Reads do not extend expiry.`;
  return {
    ...metadata,
    content_metadata_source: observed ? "provider" : "unknown",
    content_metadata_known: known,
    content_hint: `${availability} ${expiry} ${save}`,
  };
}

// SSE carries messages only. Failure to observe metadata must not discard a
// successful message read or overwrite durable completion/receipt evidence.
export async function observeJobContent(
  jobId: string,
  transport: Transport,
  ref: ProviderRef,
  options: { timeoutMs: number; jobToken?: string }
): Promise<Partial<JobContentMetadata> | undefined> {
  try {
    const status: ContentStatus = await transport.status(jobId, ref, {
      ...options,
      timeoutMs: options.timeoutMs > 0 ? Math.min(options.timeoutMs, 5000) : 5000,
    });
    return parseJobContent(status as unknown as Record<string, unknown>);
  } catch {
    return undefined;
  }
}
