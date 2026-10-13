/**
 * Low-level file/stdin byte-source mechanics shared by curl-style CLI flags
 * that accept a bare value, `@path`, or `@-` — e.g. `--data` and
 * `--body`. Callers wrap these in their own source-labeled
 * DvmError; this module owns only the I/O.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Default timeout for {@link drainStdin} — long enough for a human to paste, short enough to fail fast when nothing is piped in. */
export const STDIN_TIMEOUT_MS = 10_000;

/** Reads a file as UTF-8 text, resolved relative to the current working directory. Throws the raw Node fs error (e.g. `ENOENT`) on failure. */
export function readFileText(path: string): string {
  return readFileSync(resolve(path), "utf-8");
}

/** Thrown by {@link drainStdin} when nothing arrives before `timeoutMs`. */
export class StdinTimeoutError extends Error {
  constructor(public timeoutMs: number) {
    super(`stdin timed out after ${timeoutMs / 1000}s`);
    this.name = "StdinTimeoutError";
  }
}

/** Drains stdin as UTF-8 text. Rejects with {@link StdinTimeoutError} if nothing arrives within `timeoutMs`; rejects with the raw stream error on a stdin `"error"` event. */
export function drainStdin(timeoutMs: number = STDIN_TIMEOUT_MS): Promise<string> {
  return new Promise((resolveText, reject) => {
    const timer = setTimeout(() => {
      process.stdin.destroy();
      reject(new StdinTimeoutError(timeoutMs));
    }, timeoutMs);

    let text = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      text += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolveText(text);
    });
    process.stdin.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
