import type { ProcessResult } from "./bounded-process.mjs";

/** Installs one exact release, retrying only npm's exact-version propagation errors. */
export function installPublishedRelease(options: {
  availabilityTimeoutMs?: number;
  installTimeoutMs?: number;
  nowFn?: () => number;
  outputFn?: (result: ProcessResult) => void;
  prefix: string;
  retryDelayMs?: number;
  runFn?: (options: {
    prefix: string;
    target: string;
    timeoutMs: number;
  }) => ProcessResult | Promise<ProcessResult>;
  version: string;
  waitFn?: (milliseconds: number) => Promise<void>;
}): Promise<void>;

/** Run one owned process group and kill the wrapper plus descendants on timeout. */
export { runBoundedProcess } from "./bounded-process.mjs";
