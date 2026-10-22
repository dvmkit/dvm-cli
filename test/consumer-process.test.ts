import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const helper = pathToFileURL(join(resolve(import.meta.dirname, ".."), "scripts/installed-consumer.mjs")).href;

function probe(program: string, missingCommand = false) {
  const script = `
    import { runConsumer, ConsumerProcessError } from ${JSON.stringify(helper)};
    const result = await runConsumer(${missingCommand ? JSON.stringify("missing-consumer-command") : "process.execPath"}, ["-e", ${JSON.stringify(program)}], { timeout: 500 });
    console.log(JSON.stringify({ status: result.status, exitStatus: result.exitStatus, reason: result.termination,
      exitBeforeTimeout: result.exitBeforeTimeout, diagnostic: new ConsumerProcessError("archive-upgrade", result).message }));
  `;
  const outcome = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
  expect(outcome.status).toBe(0);
  expect(outcome.stderr).toBe("");
  expect(outcome.stdout).not.toContain("do-not-print-process-output");
  expect(outcome.stdout).not.toContain(helper);
  return JSON.parse(outcome.stdout);
}

it.each([
  ["ERESOLVE", "dependency-resolution"],
  ["ENOTFOUND", "registry-network"],
  ["EPERM", "filesystem-access"],
  ["unclassified", "unknown"],
])("reports exit status and only the allowlisted npm category for %s", (code, category) => {
  const outcome = probe(`console.error(${JSON.stringify(`${code} do-not-print-process-output`)}); process.exit(7)`);
  expect(outcome).toMatchObject({ status: 7, exitStatus: 7, reason: "nonzero-exit", exitBeforeTimeout: true });
  expect(outcome.diagnostic).toMatch(new RegExp(`^archive-upgrade: reason=nonzero-exit, elapsed_ms=[0-9]+, exit=7, signal=none, exit_before_timeout=true, npm_category=${category}$`));
});

it("distinguishes a live-process timeout from an npm exit", () => {
  const outcome = probe("setInterval(() => {}, 1000)");
  expect(outcome).toMatchObject({ status: null, reason: "timeout", exitBeforeTimeout: false });
  expect(outcome.diagnostic).toContain("reason=timeout");
});

it("records an already-exited process whose descendant retains its pipes", () => {
  const outcome = probe(`require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: ['ignore', 'inherit', 'inherit'] }); process.exit(0)`);
  expect(outcome).toMatchObject({ status: null, exitStatus: 0, reason: "timeout", exitBeforeTimeout: true });
  expect(outcome.diagnostic).toContain("exit=0, signal=none, exit_before_timeout=true");
});

it("preserves output-limit as the first termination reason", () => {
  const outcome = probe("process.stdout.write('do-not-print-process-output'.repeat(400000)); setInterval(() => {}, 1000)");
  expect(outcome).toMatchObject({ status: null, reason: "output-limit" });
  expect(outcome.diagnostic).toContain("reason=output-limit");
});

it("classifies a process that cannot spawn without printing the OS error", () => {
  const outcome = probe("", true);
  expect(outcome).toMatchObject({ status: null, reason: "spawn-error" });
  expect(outcome.diagnostic).toContain("reason=spawn-error");
});

it("bounds assertion diagnostics and rejects arbitrary operation, signal, or reason strings", () => {
  const script = `
    import { ConsumerProcessError, checkConsumer } from ${JSON.stringify(helper)};
    console.log(new ConsumerProcessError("do-not-print-process-output", {
      termination: "do-not-print-process-output", exitSignal: "do-not-print-process-output", elapsedMs: Infinity,
      stderr: "do-not-print-process-output" }).message);
    try { checkConsumer("legacy-skill-check", () => { throw new Error("do-not-print-process-output"); }); }
    catch (error) { console.log(error.message); }
  `;
  const outcome = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  expect(outcome.status).toBe(0);
  expect(outcome.stderr).toBe("");
  expect(outcome.stdout).not.toContain("do-not-print-process-output");
  expect(outcome.stdout).toContain("npm: reason=assertion, elapsed_ms=0, exit=none, signal=none");
  expect(outcome.stdout).toContain("consumer operation start: legacy-skill-check");
  expect(outcome.stdout).toMatch(/legacy-skill-check: reason=assertion, elapsed_ms=[0-9]+/u);
});
