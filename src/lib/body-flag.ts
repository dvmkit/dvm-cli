/**
 * Shared resolver for the `--body` flag on `dvm feedback`. Follows curl's
 * convention (see data-flag.ts): a bare value is used as-is,
 * `@path` reads a file, and `@-` reads stdin — so a caller never has to
 * round-trip free-form text through a shell argument.
 */
import { DvmError } from "@dvmkit/sdk/internal";

import { drainStdin, readFileText, StdinTimeoutError } from "./byte-source";

/**
 * Resolve a `--body` flag value: literal text, `@path/to/file`, or `@-` for
 * stdin. Returns outer-whitespace-trimmed, non-empty text — the same trim
 * policy the positional body form applies; internal newlines and all other
 * characters pass through unchanged. Call only when the raw flag value is
 * present.
 */
export async function resolveBodyFlag(raw: string): Promise<string> {
  let text: string;
  let sourceLabel: string;

  if (raw.startsWith("@") && raw.length > 1) {
    const path = raw.slice(1);
    if (path === "-") {
      sourceLabel = "--body @-";
      text = await readBodyStdin(sourceLabel);
    } else {
      sourceLabel = `--body @${path}`;
      text = readBodyFile(path, sourceLabel);
    }
  } else {
    sourceLabel = "--body";
    text = raw;
  }

  if (text.includes(String.fromCharCode(0))) {
    throw new DvmError(
      "body_contains_nul",
      `${sourceLabel}: body contains a NUL byte.`,
      "The body was corrupted before it reached dvm — often a shell/exec-harness quoting bug. Re-check the source and retry, ideally via --body @file so the text never passes through a shell argument."
    );
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new DvmError(
      "bad_arguments",
      `${sourceLabel}: feedback body is empty.`,
      `Provide non-empty text — e.g. --body "great work" or --body @file.txt.`
    );
  }

  return trimmed;
}

function readBodyFile(path: string, sourceLabel: string): string {
  try {
    return readFileText(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new DvmError(
        "body_file_unreadable",
        `${sourceLabel}: file not found.`,
        "Check the path is correct and relative to the current directory."
      );
    }
    throw new DvmError(
      "body_file_unreadable",
      `${sourceLabel}: cannot read file (${(err as Error).message}).`,
      "Check the file exists and is readable."
    );
  }
}

async function readBodyStdin(sourceLabel: string): Promise<string> {
  try {
    return await drainStdin();
  } catch (err) {
    if (err instanceof StdinTimeoutError) {
      throw new DvmError(
        "no_input",
        `${sourceLabel}: no input received on stdin (timed out after ${err.timeoutMs / 1000}s).`,
        "Pipe the feedback body in, or pass --body @path/to/file."
      );
    }
    throw err;
  }
}
