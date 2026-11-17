import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const binary = resolve(import.meta.dirname, "../../dist/dvm.js");

function run(args: string[]) {
  return spawnSync(process.execPath, [binary, ...args], { encoding: "utf8", timeout: 30_000 });
}

// The parser rejects these before any command code runs.
it.each([
  [["messages", "job", "--wait", "--until"], "option '--until <duration>' argument missing"],
  [["messages", "--wait"], "missing required argument 'job-id'"],
  [["messages", "job", "--wait", "--bogus"], "unknown option '--bogus'"],
])("ends a malformed JSON --wait command line with one error line (%j)", (args, message) => {
  const outcome = run(args);
  expect(outcome.status).toBe(1);
  expect(outcome.stderr).toBe("");
  const lines = outcome.stdout.trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0])).toEqual({ event: "error", error: { code: "invalid_arguments", message } });
});

it.each([
  ["--human", ["messages", "--wait", "--human"]],
  ["without --wait", ["messages"]],
])("keeps the parser's own error for a malformed command line %s", (_label, args) => {
  const outcome = run(args);
  expect(outcome.status).toBe(1);
  expect(outcome.stdout).toBe("");
  expect(outcome.stderr).toContain("error: missing required argument 'job-id'");
});

// A malformed wait limit is the caller's input error; it must name the accepted forms, not report an internal error.
// Portable access gets past job lookup; the port is unroutable, so any read would fail differently.
const portable = ["--endpoint", "http://127.0.0.1:9", "--job-token", "ab".repeat(32)];

it("ends a JSON --wait with an unreadable --until as one invalid_arguments line", () => {
  const outcome = run(["messages", "job", ...portable, "--wait", "--until", "9am"]);
  expect(outcome.status).toBe(1);
  expect(outcome.stderr).toBe("");
  const lines = outcome.stdout.trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0])).toEqual({ event: "error", error: {
    code: "invalid_arguments", message: 'Invalid duration "9am"; use e.g. 30s, 5m, 2h, 1d', hint: expect.stringContaining("1h30m") } });
});

it("explains an unreadable --until in --human --wait instead of an internal error", () => {
  const outcome = run(["messages", "job", ...portable, "--wait", "--human", "--until", "7.5h"]);
  expect(outcome.status).toBe(1);
  expect(outcome.stdout).toBe("");
  expect(outcome.stderr).toContain('Error: Invalid duration "7.5h"');
  expect(outcome.stderr).toContain("1h30m");
  expect(outcome.stderr).not.toContain("internal");
});
