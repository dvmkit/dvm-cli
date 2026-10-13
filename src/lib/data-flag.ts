/**
 * Shared resolver for the `--data` flag on `dvm quote` and `dvm request`.
 * Follows curl's convention: a bare value is inline JSON, `@path` reads a
 * file, and `@-` reads stdin — so a caller never has to round-trip a JSON
 * document through a shell argument.
 */
import { DvmError } from "@dvmkit/sdk/internal";

import { drainStdin, readFileText, StdinTimeoutError } from "./byte-source";

export interface ResolvedDataFlag {
  data: Record<string, unknown>;
  /** True only for the `@-` form — callers must not read stdin again. */
  consumedStdin: boolean;
}

/**
 * Resolve a `--data` flag value: inline JSON, `@path/to/file.json`, or `@-`
 * for stdin. Call only when the raw flag value is present (non-empty).
 */
export async function resolveDataFlag(raw: string): Promise<ResolvedDataFlag> {
  let jsonText: string;
  let sourceLabel: string;
  let consumedStdin = false;

  if (raw.startsWith("@") && raw.length > 1) {
    const path = raw.slice(1);
    if (path === "-") {
      sourceLabel = "--data @-";
      jsonText = await readDataStdin(sourceLabel);
      consumedStdin = true;
    } else {
      sourceLabel = `--data @${path}`;
      jsonText = readDataFile(path, sourceLabel);
    }
  } else {
    sourceLabel = "--data";
    jsonText = raw;
  }

  if (jsonText.includes(String.fromCharCode(0))) {
    throw new DvmError(
      "data_contains_nul",
      `${sourceLabel}: payload contains a NUL byte.`,
      "The payload was corrupted before it reached dvm — often a shell/exec-harness quoting bug. Re-check the source and retry, ideally via --data @file.json so the JSON never passes through a shell argument."
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    const line = jsonParseErrorLine(jsonText, err);
    throw new DvmError(
      "invalid_data",
      `${sourceLabel}: invalid JSON${line !== undefined ? ` at line ${line}` : ""}.`,
      "Validate the payload (e.g. `jq . < file.json`) and retry."
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DvmError(
      "invalid_data",
      `${sourceLabel}: must be a JSON object.`,
      `Example: --data '{"url":"https://example.com"}' or --data @payload.json`
    );
  }

  return { data: parsed as Record<string, unknown>, consumedStdin };
}

function readDataFile(path: string, sourceLabel: string): string {
  try {
    return readFileText(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new DvmError(
        "data_file_unreadable",
        `${sourceLabel}: file not found.`,
        "Check the path is correct and relative to the current directory."
      );
    }
    throw new DvmError(
      "data_file_unreadable",
      `${sourceLabel}: cannot read file (${(err as Error).message}).`,
      "Check the file exists and is readable."
    );
  }
}

async function readDataStdin(sourceLabel: string): Promise<string> {
  try {
    return await drainStdin();
  } catch (err) {
    if (err instanceof StdinTimeoutError) {
      throw new DvmError(
        "no_input",
        `${sourceLabel}: no input received on stdin (timed out after ${err.timeoutMs / 1000}s).`,
        "Pipe the JSON payload in, or pass --data @path/to/file.json."
      );
    }
    throw err;
  }
}

function jsonParseErrorLine(jsonText: string, err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const match = /position (\d+)/.exec(err.message);
  if (!match) return undefined;
  const position = Number(match[1]);
  let line = 1;
  for (let i = 0; i < position && i < jsonText.length; i++) {
    if (jsonText[i] === "\n") line++;
  }
  return line;
}
