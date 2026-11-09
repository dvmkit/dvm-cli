import { AsyncLocalStorage } from "node:async_hooks";
import type { AutoPayWarning } from "./auto-pay-warning";
import { writeSync } from "node:fs";
import { withJobPersistence } from "./job-persistence";

export interface DrawFundingWarning {
  code: "draw_funding_unverified";
  job_id: string;
  reason: string;
  hint: string;
  display: string;
}

export interface LocalJobStateWarning {
  code: "local_job_state_unsaved";
  display: string;
  hint: string;
}

export type OutputWarning = AutoPayWarning | DrawFundingWarning | LocalJobStateWarning;

const warnings = new AsyncLocalStorage<OutputWarning[]>();

export function withOutputWarnings<T>(run: () => Promise<T>, human?: boolean): Promise<T> {
  return warnings.run([], () => withJobPersistence(run, ({ accessPreserved, accessUnpreserved }) => {
    const hint = accessUnpreserved
      ? "Job access was not preserved. Supply --endpoint <url> and --job-token <hex>, or DVM_JOB_ENDPOINT and DVM_JOB_TOKEN, to read this job; do not submit or pay again."
      : "Refresh the job with dvm status <job_id> --messages before paying or submitting a replacement.";
    addOutputWarnings([{
      code: "local_job_state_unsaved",
      display: "The provider's outcome is unchanged, but local job state could not be saved and may lag. Automatic payments are paused for this command." +
        (accessUnpreserved ? ` ${hint}` : accessPreserved ? ` Job access is preserved privately. ${hint}` : ""),
      hint,
    }], human);
  }));
}

function sameWarning(prior: OutputWarning, entry: OutputWarning): boolean {
  if (prior.code === "local_job_state_unsaved" && entry.code === "local_job_state_unsaved") return true;
  if (prior.code === "auto_pay_bound_exceeded" && entry.code === "auto_pay_bound_exceeded") {
    return prior.auto_pay_below === entry.auto_pay_below && prior.source === entry.source;
  }
  if (prior.code === "draw_funding_unverified" && entry.code === "draw_funding_unverified") {
    // The display text carries the evidence, so identical evidence collapses and distinct evidence stays visible.
    return prior.job_id === entry.job_id && prior.reason === entry.reason && prior.display === entry.display;
  }
  return false;
}

/** Returns the entries not already recorded for this command. */
export function addOutputWarnings(entries: OutputWarning[], human?: boolean): OutputWarning[] {
  const pending = warnings.getStore();
  const added: OutputWarning[] = [];
  for (const entry of entries) {
    const index = pending?.findIndex((prior) => sameWarning(prior, entry)) ?? -1;
    if (index !== -1) {
      const prior = pending![index];
      if (entry.code !== "local_job_state_unsaved" || JSON.stringify(prior) === JSON.stringify(entry)) continue;
      pending![index] = entry;
      if (human) info(`Warning: ${entry.display}`);
      continue;
    }
    pending?.push(entry);
    added.push(entry);
    if (human) info(`Warning: ${entry.display}`);
  }
  return added;
}

/**
 * Module-level trace_id injected into every `json()` call.
 *
 * Set at CLI startup and overwritten by `platformFetch` when an HTTP
 * response carries a `traceparent` header. For multi-call commands the last
 * response's trace_id wins.
 */
let _traceId: string | null = null;

/** Set (or clear) the trace_id that `json()` injects into output. */
export function setOutputTraceId(id: string | null): void {
  _traceId = id;
}

/** Read the current trace_id (if any) for human-mode echo. */
export function getOutputTraceId(): string | null {
  return _traceId;
}

/**
 * Write structured JSON data to stdout, synchronously even when stdout is a
 * pipe. `console.log` writes via the buffered stream layer; for pipes Node
 * holds bytes in a JS-side queue until the OS pipe drains, and any pending
 * bytes are dropped if the process exits first (truncation at ~64 KB on
 * macOS). `fs.writeSync` on fd 1 bypasses that queue.
 *
 * When a trace_id has been set via `setOutputTraceId`, it is injected as the
 * first key of the output object — unless `data` already contains `trace_id`
 * (a trace lookup may return the queried trace's ID).
 */
export function json(data: unknown): void {
  const pending = warnings.getStore();
  if (pending?.length && data && typeof data === "object" && !Array.isArray(data)) {
    const existing = (data as { warnings?: unknown[] }).warnings ?? [];
    data = { ...data, warnings: [...existing, ...pending] };
  }
  const out =
    _traceId !== null &&
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    !("trace_id" in data)
      ? { trace_id: _traceId, ...(data as Record<string, unknown>) }
      : data;
  writeAllSync(1, JSON.stringify(out) + "\n");
}

/** Write informational messages to stderr (visible to humans, ignored by JSON consumers). */
export function info(msg: string): void {
  writeAllSync(2, msg + "\n");
}

/**
 * Write a raw line to stdout, synchronously (same pipe-safety as `json`).
 * Used for plain-text output with no JSON envelope — so output stays vim-pasteable and shell-redirectable.
 */
export function raw(msg: string): void {
  writeAllSync(1, msg + "\n");
}

/**
 * Write a structured progress event to stderr as one JSON line.
 *
 * Lets long-running JSON-mode commands stream
 * progress events to streaming callers — agents-as-intermediaries can tail
 * stderr while keeping stdout reserved for the final single-line result.
 */
export function progress(event: object): void {
  writeAllSync(2, JSON.stringify(event) + "\n");
}

function writeAllSync(fd: number, text: string): void {
  const buf = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += writeSync(fd, buf, offset, buf.length - offset);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EINTR") continue;
      throw err;
    }
  }
}
