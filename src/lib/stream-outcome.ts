import { type TerminalJobStatus } from "./next-action";
import { completionFromMessages, type JobCompletion } from "./completion-hints";
import {
  type Message,
} from "@dvmkit/sdk/internal";
import {
  type JobRecord,
  markJobTerminal,
  updateJob,
} from "./job-store";

import { loadMessages } from "./messages";

export type TerminalExtra = Partial<
  Omit<JobRecord, "id" | "status" | "completedAt" | "completion">
>;

export interface StreamOutcome {
  jobId: string;
  messages: Message[];
  cursor: number;
  /** The seq the read started after. 0 means `messages` is the job's whole log. */
  afterSeq: number;
  extra?: TerminalExtra;
}

/**
 * Persist what a read of the message log taught us about the job, and return the
 * terminal snapshot it recorded. A log that ran to `complete` / `cancel` is these
 * paths' only signal the job is over, so snapshot the terminal payload off the
 * log — `dvm status` replays that snapshot rather than re-reading a finished job
 * Non-terminal reads just advance the cursor.
 *
 * The snapshot is only recorded when the full log is in hand: `completionFromMessages`
 * counts artifacts, so a partial batch would undercount them. A cursor-started read
 * whose local log can't be proven whole falls back to advancing the cursor alone —
 * the next `dvm status` then reads the provider, as it does today.
 *
 * **Returns** the recorded completion, or `undefined` when the read wasn't
 * terminal or the log couldn't be proven whole. Callers render it into their own
 * JSON payload: a job that finishes on a mid-job payment has no transport
 * receipt to read `summary` / `has_artifacts` off, so this is the only place
 * those fields exist on that arc. Returning `undefined` rather than a
 * partial completion is deliberate — an undercounted `artifact_count` is worse
 * than an absent one, since an agent can't tell a wrong count from a right one.
 */
export function persistStreamOutcome(outcome: StreamOutcome): JobCompletion | undefined {
  const { jobId, messages, cursor, afterSeq, extra } = outcome;
  const terminal = streamTerminalStatus(messages);
  const log = terminal ? fullMessageLog(jobId, messages, afterSeq) : undefined;
  if (terminal && log) {
    const completion = completionFromMessages(log);
    markJobTerminal(jobId, terminal, completion, {
      messageCursor: cursor,
      ...extra,
    });
    return completion;
  }
  updateJob(jobId, { messageCursor: cursor });
  return undefined;
}

export function streamTerminalStatus(messages: Message[]): TerminalJobStatus | undefined {
  const last = messages.findLast((m) => m.type === "complete" || m.type === "cancel");
  if (!last) return undefined;
  return last.type === "complete" ? "completed" : "cancelled";
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
