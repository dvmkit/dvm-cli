import { isTerminalJobStatus, type TerminalJobStatus } from "./next-action";
import { completionFromMessages, completionSnapshot, type JobCompletion } from "./completion-hints";
import {
  type JobStatus,
  type Message,
} from "@dvmkit/sdk/internal";
import {
  type JobRecord,
  loadJob,
  markJobTerminal,
  updateJob,
} from "./job-store";

import { loadMessages } from "./messages";

export type TerminalExtra = Partial<
  Omit<JobRecord, "id" | "status" | "completedAt" | "completion">
>;

export interface StreamStatusContext {
  providerStatus?: Partial<JobStatus>;
  callerCancelled?: boolean;
}

export interface StreamOutcome extends StreamStatusContext {
  jobId: string;
  messages: Message[];
  cursor: number;
  /** The seq the read started after. 0 means `messages` is the job's whole log. */
  afterSeq: number;
  extra?: TerminalExtra;
}

/**
 * Persist what a read of the message log taught us about the job, and return the
 * terminal snapshot it recorded. Prefer a provider status read when available;
 * otherwise derive the outcome from the log and local cancellation evidence.
 * `dvm status` replays the snapshot without re-reading a finished job.
 *
 * A stream-derived snapshot requires the full log: `completionFromMessages`
 * counts artifacts, so a partial batch would undercount them. A cursor-started read
 * whose local log can't be proven whole falls back to advancing the cursor alone —
 * the next `dvm status` then reads the provider, as it does today.
 *
 * A provider terminal status can still be saved without a whole log; only its
 * supplied completion fields are used, so missing artifacts are not guessed.
 */
export function persistStreamOutcome(outcome: StreamOutcome): JobCompletion | undefined {
  const { jobId, messages, cursor, afterSeq, extra, providerStatus } = outcome;
  const stored = loadJob(jobId);
  const callerCancelled = outcome.callerCancelled ?? stored?.callerCancelled;
  const terminal = streamTerminalStatus(messages, { providerStatus, callerCancelled });
  const log = terminal ? fullMessageLog(jobId, messages, afterSeq) : undefined;
  const providerTerminal = providerStatus?.status && isTerminalJobStatus(providerStatus.status);
  if (terminal && (log || providerTerminal)) {
    const completion = {
      ...(stored?.status === terminal ? stored.completion : {}),
      ...(log?.some((m) => m.type === "complete" || m.type === "cancel") ? completionFromMessages(log) : {}),
      ...(terminal === "cancelled" && callerCancelled && stored?.completion?.message !== undefined
        ? { message: stored.completion.message } : {}),
      ...(providerTerminal ? completionSnapshot(providerStatus) : {}),
    };
    markJobTerminal(jobId, terminal, completion, {
      messageCursor: cursor,
      ...extra,
    });
    return completion;
  }
  updateJob(jobId, { messageCursor: cursor });
  return undefined;
}

export function streamTerminalStatus(messages: Message[], context: StreamStatusContext = {}): TerminalJobStatus | undefined {
  const providerStatus = context.providerStatus?.status;
  if (providerStatus && isTerminalJobStatus(providerStatus)) return providerStatus;
  const last = messages.findLast((m) => m.type === "complete" || m.type === "cancel");
  if (!last) return undefined;
  if (last.type === "complete") return "completed";
  // Older SDKs use the same wire event for ctx.fail and caller cancellation.
  // A sender label alone is not evidence that this caller requested a cancel.
  return context.callerCancelled ? "cancelled" : "failed";
}

/**
 * The job's message log from seq 0, or undefined when we can't prove we hold it.
 *
 * A read that started at seq 0 *is* the whole log. A cursor-started read carries
 * only the tail, so fall back to the locally-persisted log — `streamLoop` and the
 * `--no-stream` batch path both `appendMessages` what they read, so it's a superset
 * of `messages`. Trust it only when it's whole: seqs contiguous from the provider's
 * first (1, or 0 defensively). A hole means the client never saw those messages —
 * a manual `dvm messages --after <n>` cursor jump, or a seq the provider consumed on
 * a message it never delivered — and an artifact could be hiding in it.
 */
function fullMessageLog(
  jobId: string,
  messages: Message[],
  afterSeq: number
): Message[] | undefined {
  if (afterSeq === 0) return messages;
  const local = [...loadMessages(jobId)].sort((a, b) => a.seq - b.seq);
  if (local.length === 0 || local[0].seq > 1) return undefined;
  const contiguous = local.every((m, i) => i === 0 || m.seq === local[i - 1].seq + 1);
  return contiguous ? local : undefined;
}
