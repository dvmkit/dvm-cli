import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";

const root = resolve(import.meta.dirname, "..");
const temporaryRoots: string[] = [];
afterEach(() => { for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true }); });

it.each(["success", "failure", "skipped", "cancelled"])("aggregate accepts only successful runtime cells: %s", (result) => {
  const workflow = parse(readFileSync(join(root, ".github/workflows/verify.yml"), "utf8"));
  const command = workflow.jobs.verify.steps[0].run;
  const script = command.slice('node -e "'.length, -1);
  for (const build of ["success", "failure", "skipped", "cancelled"]) {
    const outcome = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, BUILD_RESULT: build, RUNTIME_RESULT: result } });
    expect(outcome.status).toBe(build === "success" && result === "success" ? 0 : 1);
  }
});

it.each(["minimum", "major", "os", "allow-failure", "skipped-aggregate", "untrusted", "unpinned-action", "rebuild", "missing-verification", "missing-pack"])("policy rejects weakened runtime coverage: %s", (mutation) => {
  const workflow = parse(readFileSync(join(root, ".github/workflows/verify.yml"), "utf8"));
  const matrix = workflow.jobs.runtime.strategy.matrix;
  if (mutation === "minimum") matrix.node.shift();
  if (mutation === "major") matrix.node.pop();
  if (mutation === "os") matrix.os.pop();
  if (mutation === "allow-failure") workflow.jobs.runtime["continue-on-error"] = true;
  if (mutation === "skipped-aggregate") workflow.jobs.verify.if = "success()";
  if (mutation === "untrusted") workflow.jobs.build.if = "always()";
  if (mutation === "unpinned-action") workflow.jobs.runtime.steps[0].uses = "actions/checkout@v4";
  if (mutation === "missing-verification") workflow.jobs.build.steps = workflow.jobs.build.steps.filter((step: { run?: string }) => step.run !== "node scripts/verify-ci.mjs");
  if (mutation === "missing-pack") workflow.jobs.build.steps = workflow.jobs.build.steps.filter((step: { run?: string }) => step.run !== "node scripts/pinned-npm.mjs run artifact:runtime");
  if (mutation === "rebuild") workflow.jobs.runtime.steps.push({ run: "npm run build" });
  const temporary = mkdtempSync(join(tmpdir(), "dvm-runtime-policy-"));
  temporaryRoots.push(temporary);
  const file = join(temporary, "workflow.yml");
  writeFileSync(file, stringify(workflow));
  const outcome = spawnSync(process.execPath, [join(root, "scripts/check-runtime-policy.mjs"), file], { encoding: "utf8" });
  expect(outcome.status).toBe(1);
  expect(outcome.stderr).toContain("incompatible workflow");
  expect(outcome.stderr).not.toContain(temporary);
});

it("accepts the complete runtime workflow", () => {
  expect(spawnSync(process.execPath, [join(root, "scripts/check-runtime-policy.mjs")]).status).toBe(0);
});

it("rejects a tampered archive before installation without printing its path", () => {
  const temporary = mkdtempSync(join(tmpdir(), "dvm-runtime-integrity-"));
  temporaryRoots.push(temporary);
  writeFileSync(join(temporary, "runtime.json"), JSON.stringify({
    archive: "caller.tgz", name: "@dvmkit/dvm-cli", version: "0.9.2", engines: { node: ">=22" }, sha256: "0".repeat(64),
  }));
  writeFileSync(join(temporary, "caller.tgz"), "corrupted archive");
  const outcome = spawnSync(process.execPath, [join(root, "scripts/runtime-smoke.mjs"), temporary], { encoding: "utf8" });
  expect(outcome.status).toBe(1);
  expect(outcome.stderr).toBe("runtime failed: archive integrity (captured output withheld)\n");
  expect(outcome.stdout).toBe("");
});

it("withholds consumer npm diagnostics on a real invalid-archive install", () => {
  const temporary = mkdtempSync(join(tmpdir(), "dvm-runtime-invalid-"));
  temporaryRoots.push(temporary);
  const archive = "invalid archive containing a private credential marker";
  writeFileSync(join(temporary, "caller.tgz"), archive);
  writeFileSync(join(temporary, "runtime.json"), JSON.stringify({
    archive: "caller.tgz", name: "@dvmkit/dvm-cli", version: "0.9.2", engines: { node: ">=22" },
    sha256: createHash("sha256").update(archive).digest("hex"),
  }));
  const outcome = spawnSync(process.execPath, [join(root, "scripts/runtime-smoke.mjs"), temporary], {
    encoding: "utf8", timeout: 30_000,
  });
  expect(outcome.status).toBe(1);
  expect(outcome.stderr).toMatch(/^runtime failed: consumer install and upgrade; archive-upgrade: reason=nonzero-exit, elapsed_ms=[0-9]+, exit=[1-9][0-9]*, signal=none, exit_before_timeout=true, npm_category=unknown \(captured output withheld\)\n$/u);
  const lines = outcome.stdout.trimEnd().split("\n");
  expect(lines.slice(0, 3)).toEqual(["consumer operation start: legacy-install", "consumer operation start: legacy-skill-check", "consumer operation start: archive-upgrade"]);
  expect(lines).toHaveLength(4);
  expect(lines[3]).toMatch(/^consumer npm progress: /u);
  const progress = JSON.parse(lines[3].slice("consumer npm progress: ".length));
  expect(progress.total_lines).toBeGreaterThan(0);
  expect(progress.last_output_ms).toEqual(expect.any(Number));
  expect(outcome.stdout).not.toContain(temporary);
  expect(outcome.stdout).not.toContain(archive);
});

it("contains malformed job JSON in the asynchronous fixture callback", () => {
  const temporary = mkdtempSync(join(tmpdir(), "dvm-runtime-callback-"));
  temporaryRoots.push(temporary);
  const scripts = join(temporary, "scripts");
  mkdirSync(scripts);
  copyFileSync(join(root, "scripts/runtime-smoke.mjs"), join(scripts, "runtime-smoke.mjs"));
  // Stub installation and CLI prerequisites; the real harness owns HTTP parsing.
  writeFileSync(join(scripts, "runtime-artifact.mjs"), `
    export const digest = () => "skill-digest";
    export const readRuntimeArtifact = () => ({ archive: "caller.tgz", name: "@dvmkit/dvm-cli", version: "0.9.2",
      skills: Object.fromEntries(["SKILL.md", "calling.md", "wallets.md", "credit.md", "recovery.md"].map(file => [file, "skill-digest"])) });
  `);
  writeFileSync(join(scripts, "installed-consumer.mjs"), `
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    export class ConsumerProcessError extends Error {}
    export const checkConsumer = (_operation, check) => check();
    let installed;
    export async function installConsumer({ temporaryRoot }) {
      writeFileSync(process.env.RUNTIME_ROOT_RECORD, temporaryRoot);
      installed = join(temporaryRoot, "installed");
      mkdirSync(join(installed, "skills/dvm"), { recursive: true });
      writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "@dvmkit/dvm-cli", version: "0.9.2" }));
      for (const file of ["SKILL.md", "calling.md", "wallets.md", "credit.md", "recovery.md"])
        writeFileSync(join(installed, "skills/dvm", file), "---\\nname: dvm\\n---\\n[Calling](calling.md) [Wallets](wallets.md) [Credit](credit.md) [Recovery](recovery.md)");
      return { consumer: temporaryRoot, installedPackage: installed };
    }
    export async function runConsumer() { return { status: 0, stdout: join(installed, "skills/dvm/SKILL.md") }; }
    export async function runLauncher(_consumer, args) {
      let stdout;
      if (args[0] === "--version") stdout = "0.9.2";
      else if (args[0] === "--help") stdout = "Usage: dvm";
      else if (args[0] === "init") stdout = JSON.stringify({ identity: { pubkey: "ab".repeat(32) } });
      else if (args[0] === "status") return { status: 1, stderr: "", stdout: JSON.stringify({ error: {
        code: "job_access_required", message: "not in the local store", hint: "--endpoint and --job-token" } }) };
      else if (args[0] === "request") {
        const endpoint = args[args.indexOf("--endpoint") + 1];
        const response = await fetch(endpoint + "/v1/job", { method: "POST", body: process.env.MALFORMED_JOB_BODY });
        if (response.status !== 500) throw new Error("fixture accepted invalid JSON");
        stdout = JSON.stringify({ jobId: "runtime-job" });
      }
      return { status: 0, stderr: "", stdout };
    }
  `);
  const marker = "do-not-print-job-body";
  const rootRecord = join(temporary, "consumer-root.txt");
  const outcome = spawnSync(process.execPath, [join(scripts, "runtime-smoke.mjs")], {
    encoding: "utf8", timeout: 10_000,
    env: { ...process.env, MALFORMED_JOB_BODY: `{${marker}`, RUNTIME_ROOT_RECORD: rootRecord },
  });
  const installedRoot = readFileSync(rootRecord, "utf8");
  temporaryRoots.push(installedRoot);
  expect(outcome.status).toBe(1);
  expect(outcome.stdout).toBe("");
  expect(outcome.stderr).toBe("runtime failed: loopback free request and poll (captured output withheld)\n");
  expect(outcome.stderr).not.toContain(temporary);
  expect(outcome.stderr).not.toContain(marker);
  expect(existsSync(installedRoot)).toBe(false);
});
