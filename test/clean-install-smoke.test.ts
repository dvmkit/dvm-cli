import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("clean-install failure diagnostics", () => {
  it.each(["ci", "run"])("drains both output streams when npm %s fails", (step) => {
    const root = mkdtempSync(join(tmpdir(), "dvm-cli-clean-output-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "scripts"));
    copyFileSync(
      join(repositoryRoot, "scripts", "clean-install-smoke.mjs"),
      join(root, "scripts", "clean-install-smoke.mjs")
    );
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    const initialized = spawnSync("git", ["init", "--quiet"], { cwd: root });
    expect(initialized.status).toBe(0);
    const invocation = join(root, "invocations.jsonl");
    const npmCli = join(root, "npm-fixture.mjs");
    const bytes = 2 * 1024 * 1024;
    writeFileSync(npmCli, `import { appendFileSync, realpathSync, writeFileSync } from "node:fs";
appendFileSync(process.env.INVOCATION_PATH, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + "\\n");
if (process.argv[2] === process.env.FAIL_STEP) {
  writeFileSync(1, "#".repeat(${bytes}) + "\\n" + process.cwd() + "/stdout.ts: STDOUT_FINAL\\n");
  writeFileSync(2, "^".repeat(${bytes}) + "\\n" + realpathSync(process.cwd()) + "/stderr.ts: STDERR_FINAL\\n");
  process.exitCode = 23;
}
`);

    const result = spawnSync(process.execPath, [join(root, "scripts", "clean-install-smoke.mjs")], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, npm_execpath: npmCli, FAIL_STEP: step, INVOCATION_PATH: invocation },
    });
    expect(result.error).toBeUndefined();
    expect(result.stdout.endsWith("\n<clean-source>/stdout.ts: STDOUT_FINAL\n")).toBe(true);
    expect(result.stderr.includes("\n<clean-source>/stderr.ts: STDERR_FINAL\n")).toBe(true);
    expect(result.stdout.split("#").length - 1).toBe(bytes);
    expect(result.stderr.split("^").length - 1).toBe(bytes);
    expect(result.status).toBe(23);
    expect(result.stderr.endsWith(`clean install: npm ${step === "ci" ? "ci --ignore-scripts" : "run verify -- --clean-source"} failed\n`)).toBe(true);
    const calls: { cwd: string; args: string[] }[] = readFileSync(invocation, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.map((call) => call.args)).toEqual(step === "ci"
      ? [["ci", "--ignore-scripts"]]
      : [["ci", "--ignore-scripts"], ["run", "verify", "--", "--clean-source"]]);
    for (const call of calls) {
      expect(result.stdout.includes(call.cwd)).toBe(false);
      expect(result.stderr.includes(call.cwd)).toBe(false);
      expect(existsSync(call.cwd)).toBe(false);
    }
    expect(existsSync(join(root, "dist"))).toBe(false);
  });
});
