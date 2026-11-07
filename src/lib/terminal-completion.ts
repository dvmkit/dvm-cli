import { shellQuoteArg, type ProviderRef, type Transport } from "@dvmkit/sdk/internal";
import {
  buildCompletionHintFields, completionFromMessages, completionSnapshot,
  type JobCompletion, nextStepHint,
} from "./completion-hints";
import type { ContentStatus } from "./job-content";
import { isTerminalJobStatus } from "./next-action";
import { guidanceJobArg } from "./provider-output";

export async function readTerminalCompletion(args: {
  jobId: string;
  status: Partial<ContentStatus> & { status: string };
  saved?: JobCompletion;
  transport: Transport;
  ref: ProviderRef;
  jobToken?: string;
  timeoutMs?: number;
}): Promise<JobCompletion> {
  const { jobId, status, saved, transport, ref, jobToken } = args;
  let completion = completionSnapshot(status);
  if (!isTerminalJobStatus(status.status) || status.content_available === false) return completion;
  if (completion.hasArtifacts === undefined) {
    delete completion.artifactCount;
    delete completion.payloadIn;
    try {
      // Inspect the full log without consuming output owed to a later messages read.
      const messages = await transport.getMessages(jobId, 0, ref, {
        jobToken, timeoutMs: args.timeoutMs ?? 5000,
      });
      const derived = messages.length === 0 && saved?.hasArtifacts !== undefined
        ? saved : completionFromMessages(messages);
      completion = { ...derived, ...completion };
    } catch {
      // Unknown is retryable; a failed read cannot prove that no artifacts exist.
      completion = { ...saved, ...completion };
    }
  }
  return completionForStatus(status.status, completion);
}

function completionForStatus(status: string, input: JobCompletion): JobCompletion {
  const completion = { ...input };
  if (status !== "completed") {
    if (completion.hasArtifacts === true) completion.payloadIn = "messages";
    else delete completion.payloadIn;
  }
  return completion;
}

export function terminalCompletionOutput(
  jobId: string,
  status: string,
  input: JobCompletion,
  options: { human?: boolean; contentAvailable?: boolean } = {}
): { fields: Record<string, unknown>; hint?: string; display?: string } {
  if (!isTerminalJobStatus(status)) return { fields: {} };
  const completion = completionForStatus(status, input);
  const fields = buildCompletionHintFields(jobId, completion);
  if (options.contentAvailable === false) {
    delete fields.next_step_hint;
    if (fields.payload_in === "messages") delete fields.payload_in;
    return { fields };
  }
  let hint = nextStepHint(jobId, completion.payloadIn, completion.artifactCount, options.human);
  if (completion.hasArtifacts === undefined && status !== "completed") {
    const job = options.human ? shellQuoteArg(jobId) : guidanceJobArg(jobId);
    hint = `Any output from finished pieces can be read with 'dvm messages ${job} --no-stream'.`;
  }
  if (hint) fields.next_step_hint = hint;
  const count = typeof completion.artifactCount === "number" &&
    Number.isSafeInteger(completion.artifactCount) && completion.artifactCount >= 0
    ? completion.artifactCount : undefined;
  const display = completion.hasArtifacts === true && hint
    ? `The job holds ${count === undefined ? "artifacts" : `${count} artifact${count === 1 ? "" : "s"}`}. ${hint}`
    : hint;
  return { fields, hint, display };
}
