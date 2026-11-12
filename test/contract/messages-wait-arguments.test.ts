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
