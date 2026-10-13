import type { Message } from "@dvmkit/sdk/internal";

/**
 * The terminal-outcome fields a job carries once it is over — the summary, the
 * artifact metadata, and (on a failure) the provider's message. Read off a
 * transport receipt / status response, persisted on the local job record
 * and rendered into the JSON payload by `buildCompletionHintFields`.
 */
export interface JobCompletion {
  /** Human-readable one-liner. Not the payload when artifacts are present. */
  summary?: string;
  /** Provider's status message (typically on a failed job). */
  message?: string;
  /** True when the provider emitted artifact messages. */
  hasArtifacts?: boolean;
  /** Count of artifact messages (present when `hasArtifacts` is true). */
  artifactCount?: number;
  /** Where the payload sits: the `summary` string, or in artifact messages. */
  payloadIn?: "summary" | "messages";
}

/**
 * Build the snake_case JSON fields (`has_artifacts`, `artifact_count`,
 * `payload_in`, `next_step_hint`) from a transport receipt or status response.
 * Returns an object meant to be spread into the parent JSON payload — agents
 * relaying a completed-job response need these to know the summary string is
 * a one-liner, not the payload, when the real output sits in artifact messages
 */
export function buildCompletionHintFields(
  jobId: string,
  input: JobCompletion
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.hasArtifacts !== undefined) out.has_artifacts = input.hasArtifacts;
  if (input.artifactCount !== undefined) out.artifact_count = input.artifactCount;
  if (input.payloadIn) out.payload_in = input.payloadIn;
  const hint = nextStepHint(jobId, input.payloadIn, input.artifactCount);
  if (hint) out.next_step_hint = hint;
  return out;
}

/** `--no-stream` replays from seq 0: the stored cursor may already be past the artifacts. */
export function nextStepHint(
  jobId: string,
  payloadIn: "summary" | "messages" | undefined,
  artifactCount: number | undefined
): string | undefined {
  if (payloadIn !== "messages") return undefined;
  const noun = artifactCount === 1 ? "artifact" : "artifacts";
  return `Run 'dvm messages ${jobId} --no-stream' to fetch the ${noun}.`;
}

/**
 * Pick the terminal-outcome fields off a receipt or status response, dropping
 * the ones the provider didn't send. What lands here is what `dvm status`
 * replays from the local record on every later read, so it must be
 * exactly the set the wire read would have rendered — no defaults, no guesses.
 */
export function completionSnapshot(src: JobCompletion): JobCompletion {
  const out: JobCompletion = {};
  if (src.summary !== undefined) out.summary = src.summary;
  if (src.message !== undefined) out.message = src.message;
  if (src.hasArtifacts !== undefined) out.hasArtifacts = src.hasArtifacts;
  if (src.artifactCount !== undefined) out.artifactCount = src.artifactCount;
  if (src.payloadIn) out.payloadIn = src.payloadIn;
  return out;
}

/**
 * Derive the terminal snapshot from a streamed message log, for the paths that
 * learn a job is over from the stream rather than a status response. Mirrors
 * the SDK's own derivation (`statusCompletionFields`, `src/sdk/server/app.ts`):
 * `payload_in` is `"messages"` iff any `artifact` message was emitted. Requires
 * the full log (from seq 0) — a partial batch would undercount the artifacts.
 */
export function completionFromMessages(messages: Message[]): JobCompletion {
  const complete = messages.findLast((m) => m.type === "complete");
  const summary = complete?.type === "complete" ? complete.content.summary : undefined;
  const artifactCount = messages.filter((m) => m.type === "artifact").length;
  const out: JobCompletion = {
    hasArtifacts: artifactCount > 0,
    payloadIn: artifactCount > 0 ? "messages" : "summary",
  };
  if (summary !== undefined) out.summary = summary;
  if (artifactCount > 0) out.artifactCount = artifactCount;
  return out;
}
