import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const verifier = join(repositoryRoot, "scripts", "verify-ci.mjs");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CI verification diagnostics", () => {
  it("rewrites workspace paths to repository-relative diagnostics", () => {
    const root = temporaryRoot();
    const workspace = join(root, "workspace");
    mkdirSync(join(workspace, "src"), { recursive: true });
    const fixture = join(root, "output.txt");
    writeFileSync(fixture, `${join(workspace, "src", "index.ts")}: failed\n`);

    const result = sanitize(fixture, { GITHUB_WORKSPACE: workspace });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("src/index.ts: failed\n");
  });

  it("fails closed without echoing an unrecognized absolute runner path", () => {
    const root = temporaryRoot();
    const fixture = join(root, "output.txt");
    const unsafePath = ["", "srv", "actions-runner", "_work", "repository", "file.ts"].join("/");
    writeFileSync(fixture, `${unsafePath}: failed\n`);

    const result = sanitize(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsafe absolute path remained after sanitization");
    expect(result.stderr).not.toContain(unsafePath);
    expect(result.stdout).toBe("");
  });

  it.each(["/v1/job/:id", "/v1/job/:id/messages"])(
    "continues rejecting raw fixture span route %s",
    (route) => {
      const fixture = join(temporaryRoot(), "output.txt");
      writeFileSync(fixture, `isolate info: dvm.request http.route=${route}\n`);

      const result = sanitize(fixture);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unsafe absolute path remained after sanitization");
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain(route);
    }
  );

  it("captures an install failure without exposing npm's absolute log path", () => {
    expect(readFileSync(join(repositoryRoot, ".github", "workflows", "verify.yml"), "utf8")).toContain(
      "run: node scripts/verify-ci.mjs --install"
    );
    const root = temporaryRoot();
    const scripts = join(root, "scripts");
    mkdirSync(scripts, { recursive: true });
    copyFileSync(verifier, join(scripts, "verify-ci.mjs"));
    const invocation = join(root, "invocation.json");
    const unsafeLogPath = [
      "",
      "srv",
      "actions-runner",
      "_work",
      "_tooling",
      "npm",
      "_logs",
      "debug.log",
    ].join("/");
    writeFileSync(
      join(scripts, "pinned-npm.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.INVOCATION_PATH, JSON.stringify(process.argv.slice(2)));\nconsole.error(${JSON.stringify(
        `npm error log: ${unsafeLogPath}`
      )});\nprocess.exit(1);\n`
    );

    const result = spawnSync(process.execPath, [join(scripts, "verify-ci.mjs"), "--install"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, INVOCATION_PATH: invocation },
    });
    expect(JSON.parse(readFileSync(invocation, "utf8"))).toEqual(["ci", "--ignore-scripts"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsafe absolute path remained after sanitization");
    expect(result.stderr).not.toContain(unsafeLogPath);
    expect(result.stdout).toBe("");
    const diagnostic = readFileSync(join(root, ".artifacts", "verify-diagnostics.txt"), "utf8");
    expect(diagnostic).not.toContain(unsafeLogPath);
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dvm-cli-verify-output-"));
  temporaryRoots.push(root);
  return root;
}

function sanitize(fixture: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [verifier, "--sanitize-file", fixture], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}
