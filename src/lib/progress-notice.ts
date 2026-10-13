import {
  info,
} from "./output";

/**
 * Print a one-line progress notice — but only when someone is there to read it.
 *
 * `info()` has always written to stderr, so a shell pipeline (`dvm search … |
 * jq`) was never broken by these lines. Agent harnesses are the problem: they
 * hand the model stdout and stderr merged into a single buffer, so
 * "Searching for providers..." lands immediately above the JSON document the
 * agent is trying to parse, and callers work around it with `tail -1`. The
 * caller CLI promises agent-first JSON by default, so a non-interactive run
 * has to emit the document and nothing else.
 *
 * The gate is `process.stderr.isTTY` — the stream this actually writes to —
 * rather than stdout's, so `dvm search foo | jq` still narrates for the person
 * who typed it while stdout stays machine-clean. `--human` forces the notice
 * on, so redirecting a human-mode run into a log file keeps its narration.
 *
 * This is for transient status prose only. Output a caller is meant to keep —
 * results, errors, `--human` renderings — goes through `info`/`json` directly.
 */
export function progressNotice(msg: string, human?: boolean): void {
  if (human === true || process.stderr.isTTY === true) info(msg);
}
