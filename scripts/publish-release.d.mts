import type { ProcessResult } from "./bounded-process.mjs";

/** Publishes an archive once, or accepts an exact prior registry publication after a disrupted run. */
export function publishRelease(options: {
  archive: string;
  availabilityTimeoutMs?: number;
  distTag: string;
  fetchFn?: typeof fetch;
  publishFn?: (options: {
    archive: string;
    distTag: string;
    timeoutMs: number;
  }) => ProcessResult | Promise<ProcessResult>;
  registry?: string;
  nowFn?: () => number;
  requestTimeoutMs?: number;
  retryDelayMs?: number;
  signalFn?: (milliseconds: number) => AbortSignal;
  waitFn?: (milliseconds: number) => Promise<void>;
}): Promise<"already-published" | "published">;

/** Returns whether the exact version is absent, awaiting archive propagation, byte-for-byte matching, or conflicting. */
export function inspectPublishedRelease(options: {
  expected: {
    packageName: string;
    packageVersion: string;
    sha256: string;
    distTag: string;
  };
  fetchFn?: typeof fetch;
  deadlineMs?: number;
  nowFn?: () => number;
  requestTimeoutMs?: number;
  registry?: string;
  signalFn?: (milliseconds: number) => AbortSignal;
}): Promise<"match" | "missing" | "pending-tarball" | "mismatch">;

/** Read-only exact-byte and dist-tag check for recovery diagnosis. */
export function checkPublishedRelease(options: {
  archive: string;
  distTag: string;
  fetchFn?: typeof fetch;
  nowFn?: () => number;
  registry?: string;
  requestTimeoutMs?: number;
  signalFn?: (milliseconds: number) => AbortSignal;
}): Promise<"match">;
