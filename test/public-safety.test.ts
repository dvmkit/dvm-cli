import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const scanner = join(repositoryRoot, "scripts", "public-safety.mjs");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("public-safety scanner", () => {
  it.each([
    ["personal_email", ["person", "workplace.test"].join("@")],
    ["absolute_private_path", ["", "Users", "sample-user", "project", "file.ts"].join("/")],
    ["secret", ["github", "pat", "abcdefghijklmnopqrstuvwx"].join("_")],
    ["internal_issue_id", ["DVM", "1234"].join("-")],
  ])("rejects %s content", (category, unsafeContent) => {
    const fixture = createFixture({ "README.md": unsafeContent });
    const result = runScanner(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`public safety: ${category}`);
    expect(result.stderr).not.toContain(unsafeContent);
  });

  it("accepts the bundled third-party licence attribution the bundler emits", () => {
    const attribution = ["einaros", "gmail.com"].join("@");
    const fixture = createFixture({
      "dist/dvm.js": [
        "/*! Bundled license information:",
        "",
        "undici/lib/web/websocket/frame.js:",
        `  (*! ws. MIT License. Einar Otto Stangvik <${attribution}> *)`,
        "*/",
      ].join("\n"),
    });
    const result = runScanner(fixture);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("personal_email");
  });

  it.each(["security", "support"])("accepts the published %s contact channel", (role) => {
    const fixture = createFixture({ "SECURITY.md": `${role}@dvmkit.com\n` });
    const result = runScanner(fixture);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("personal_email");
  });

  it("rejects a repository locator whose owner and repository names are identical", () => {
    const fixture = createFixture({ "README.md": sameOwnerRepositoryUrl() });
    const result = runScanner(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("public safety: private_repository");
  });

  it("rejects symlinks without reading their targets", () => {
    const fixture = createFixture({ "target.txt": "safe" });
    symlinkSync(join(fixture, "target.txt"), join(fixture, "link.txt"));
    const result = runScanner(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("public safety: symlink");
  });

  it("rejects source maps and generated logs", () => {
    const fixture = createFixture({
      "dist/index.js.map": JSON.stringify({ version: 3, sources: ["src/index.ts"] }),
      "reports/verify.log": "safe-looking output",
    });
    const result = runScanner(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("public safety: source_map");
    expect(result.stderr).toContain("public safety: generated_artifact");
  });

  it("does not descend into dependency trees", () => {
    const fixture = createFixture({
      "README.md": "safe",
      "node_modules/dependency/debug.log": ["person", "workplace.test"].join("@"),
    });
    const result = runScanner(fixture);
    expect(result.status).toBe(0);
  });

  it("leaves ignored untracked root runtime metadata untouched", () => {
    const fixture = createFixture({
      "README.md": "safe\n",
      ".runtime/credential-token": syntheticSecret(),
      ".runtime/runtime.json": ["DVM", "1234"].join("-"),
    });
    initializeGitFixture(fixture, ["/.runtime/"]);
    const before = runtimeSnapshot(fixture);

    const result = runRepositoryScanner(fixture);

    expect(result.status).toBe(0);
    expect(runtimeSnapshot(fixture)).toEqual(before);
  });

  it("applies the root exemption to a configured runtime directory", () => {
    const fixture = createFixture({ ".agent-state/credential-token": syntheticSecret() });
    initializeGitFixture(fixture, ["/.agent-state/"]);
    const withoutOptIn = runRepositoryScanner(fixture);
    expect(withoutOptIn.status).toBe(1);
    expect(withoutOptIn.stderr).toContain("public safety: secret");
    const result = runRepositoryScanner(fixture, [], true, true, {
      PUBLIC_SAFETY_RUNTIME_DIR: ".agent-state",
    });
    expect(result.status).toBe(0);
    const explicit = runScanner(fixture, [], true, fixture, true, {
      PUBLIC_SAFETY_RUNTIME_DIR: ".agent-state",
    });
    expect(explicit.status).toBe(1);
    expect(explicit.stderr).toContain("public safety: secret");
  });

  it.each([".", "..", "/runtime", ".runtime/nested", "../runtime", ".git", ".tooling"])(
    "rejects an invalid runtime directory %s",
    (runtimeDirectory) => {
      const fixture = createFixture({ "README.md": "safe" });
      const result = runRepositoryScanner(fixture, [], true, true, {
        PUBLIC_SAFETY_RUNTIME_DIR: runtimeDirectory,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("public safety: scanner_error");
    }
  );

  it.each(["staged", "tracked"])("rejects %s root runtime metadata", (state) => {
    const fixture = createFixture({
      "README.md": "safe\n",
      ".runtime/runtime.json": "safe runtime metadata\n",
    });
    initializeGitFixture(fixture, ["/.runtime/"]);
    git(fixture, ["add", "--force", ".runtime/runtime.json"]);
    if (state === "tracked") git(fixture, ["commit", "-m", "chore: add runtime fixture"]);

    const result = runRepositoryScanner(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("public safety: tracked_runtime_metadata at .runtime");
  });

  it("scans an unignored root runtime directory", () => {
    const fixture = createFixture({ ".runtime/credential-token": syntheticSecret() });
    initializeGitFixture(fixture);

    const result = runRepositoryScanner(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("public safety: secret at .runtime/credential-token");
    expect(result.stderr).not.toContain(syntheticSecret());
  });

  it("fails closed when root runtime metadata cannot be classified through Git", () => {
    const fixture = createFixture({ ".runtime/runtime.json": "safe runtime metadata\n" });

    const result = runRepositoryScanner(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("public safety: scanner_error at scanner");
  });

  it("scans nested runtime directories even when the root runtime directory is ignored", () => {
    const fixture = createFixture({
      ".runtime/runtime.json": syntheticSecret(),
      "src/.runtime/credential-token": syntheticSecret(),
    });
    initializeGitFixture(fixture, ["/.runtime/"]);

    const result = runRepositoryScanner(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("public safety: secret at src/.runtime/credential-token");
    expect(result.stderr).not.toContain("secret at .runtime/credential-token");
  });

  it("scans ignored root runtime metadata when the repository is an explicit scan root", () => {
    const fixture = createFixture({ ".runtime/credential-token": syntheticSecret() });
    initializeGitFixture(fixture, ["/.runtime/"]);

    const result = runScanner(fixture, [], true, fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("public safety: secret at .runtime/credential-token");
  });

  it("scans ignored root runtime metadata included in the packed package", () => {
    const fixture = createFixture({
      ".runtime/credential-token": syntheticSecret(),
      ".npmignore": "",
      "package.json": `${JSON.stringify({
        name: "public-safety-runtime-fixture",
        version: "1.0.0",
        files: [".runtime"],
      })}\n`,
    });
    initializeGitFixture(fixture, ["/.runtime/"]);

    const result = runRepositoryScanner(fixture, [], false);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "public safety: secret at package/.runtime/credential-token"
    );
  });

  it("rejects a root runtime symlink without reading its target", () => {
    const fixture = createFixture({ "README.md": "safe\n" });
    const target = join(dirname(fixture), "runtime-target");
    mkdirSync(target);
    writeFileSync(join(target, "credential-token"), syntheticSecret());
    symlinkSync(target, join(fixture, ".runtime"));

    const result = runRepositoryScanner(fixture);
    const report = JSON.parse(
      readFileSync(join(dirname(fixture), "default-report.json"), "utf8")
    ) as { violations: Array<{ category: string; location: string }> };

    expect(result.status).toBe(1);
    expect(report.violations).toEqual([{ category: "symlink", location: ".runtime" }]);
    expect(result.stderr).not.toContain(syntheticSecret());
  });

  it("continues to scan ignored secrets and generated artifacts outside root runtime metadata", () => {
    const fixture = createFixture({
      ".cache/credential-token": syntheticSecret(),
      ".cache/verify.log": "safe-looking output\n",
      ".runtime/credential-token": syntheticSecret(),
    });
    initializeGitFixture(fixture, ["/.cache/", "/.runtime/"]);

    const result = runRepositoryScanner(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("public safety: secret at .cache/credential-token");
    expect(result.stderr).toContain("public safety: generated_artifact at .cache/verify.log");
    expect(result.stderr).not.toContain(syntheticSecret());
  });

  it("allows only the named sanitized verification reports", () => {
    const fixture = createFixture({
      ".artifacts/public-safety-report.json": "{}\n",
      ".artifacts/public-safety-packed-report.json": "{}\n",
      ".artifacts/verify-diagnostics.txt": "verification passed\n",
      ".artifacts/unexpected-report.json": "{}\n",
    });

    const result = runRepositoryScanner(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "public safety: generated_artifact at .artifacts/unexpected-report.json"
    );
    expect(result.stderr).not.toContain("public-safety-report.json");
    expect(result.stderr).not.toContain("public-safety-packed-report.json");
    expect(result.stderr).not.toContain("verify-diagnostics.txt");
  });

  it("rejects unsafe commit author, committer, and message metadata", () => {
    const fixture = createFixture({ "README.md": "safe" });
    const metadata = join(dirname(fixture), "metadata.json");
    writeFileSync(
      metadata,
      JSON.stringify([
        {
          sha: "a".repeat(40),
          authorEmail: ["author", "workplace.test"].join("@"),
          committerEmail: ["committer", "workplace.test"].join("@"),
          message: sameOwnerRepositoryUrl(),
        },
      ])
    );
    const result = runScanner(fixture, ["--git-metadata-file", metadata]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsafe_commit_author_email");
    expect(result.stderr).toContain("unsafe_commit_committer_email");
    expect(result.stderr).toContain("private_repository");
  });

  it("allows the exact public author and GitHub squash committer identities", () => {
    const fixture = createFixture({ "README.md": "safe\n" });
    git(fixture, ["init", "-b", "main"]);
    git(fixture, ["config", "user.name", "GitHub"]);
    git(fixture, ["config", "user.email", "noreply@github.com"]);
    git(fixture, ["add", "README.md"]);
    git(fixture, ["commit", "-m", "feat: safe squash metadata"], {
      GIT_AUTHOR_NAME: "aioli3",
      GIT_AUTHOR_EMAIL: "265668992+aioli3@users.noreply.github.com",
      GIT_COMMITTER_NAME: "GitHub",
      GIT_COMMITTER_EMAIL: "noreply@github.com",
    });

    const result = runScanner(fixture, [], true, fixture, false);
    expect(result.status).toBe(0);
  });

  it.each([
    ["nearby author", ["another", "dvmkit.com"].join("@"), "noreply@github.com", "author"],
    ["nearby committer", "265668992+aioli3@users.noreply.github.com", ["notifications", "github.com"].join("@"), "committer"],
    ["nearby subdomain", "265668992+aioli3@users.noreply.github.com", ["noreply", "merge.github.com"].join("@"), "committer"],
    ["unapproved bot author", "123+unapproved[bot]@users.noreply.github.com", "noreply@github.com", "author"],
    ["unapproved bot committer", "265668992+aioli3@users.noreply.github.com", "123+unapproved[bot]@users.noreply.github.com", "committer"],
    ["ordinary custom", ["author", "workplace.test"].join("@"), "noreply@github.com", "author"],
  ])("rejects a %s email identity", (_label, authorEmail, committerEmail, unsafeField) => {
    const fixture = createFixture({ "README.md": "safe" });
    const metadata = join(dirname(fixture), "variant-metadata.json");
    writeFileSync(
      metadata,
      JSON.stringify([
        {
          sha: "b".repeat(40),
          authorEmail,
          committerEmail,
          message: "feat: safe metadata variant",
        },
      ])
    );

    const result = runScanner(fixture, ["--git-metadata-file", metadata]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`unsafe_commit_${unsafeField}_email`);
    expect(result.stderr).not.toContain(authorEmail);
    expect(result.stderr).not.toContain(committerEmail);
  });

  it("rejects unsafe pull request body input", () => {
    const fixture = createFixture({ "README.md": "safe" });
    const body = join(dirname(fixture), "pull-request-body.txt");
    writeFileSync(body, ["npm", "abcdefghijklmnopqrstuvwx"].join("_"));
    const result = runScanner(fixture, ["--pr-body-file", body]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("public safety: secret at pull-request-body");
  });

  it("inspects the actual npm pack file set", () => {
    const fixture = createFixture({
      "package.json": `${JSON.stringify({
        name: "public-safety-fixture",
        version: "1.0.0",
        files: ["dist", "src", ".tooling"],
        scripts: { postinstall: "node setup.js" },
      })}\n`,
      "dist/index.js": "export {};\n",
      "src/index.js": "export {};\n",
      ".tooling/credential-token": syntheticSecret(),
    });
    const result = runScanner(fixture, [], false, fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("public safety: secret at package/.tooling/credential-token");
    expect(result.stderr).toContain("public safety: forbidden_packed_path at package/src/index.js");
    expect(result.stderr).toContain(
      "public safety: packed_lifecycle_hook at package/package.json:postinstall"
    );
  });

  it("scans a packed artifact without requiring repository metadata", () => {
    const fixture = createFixture({
      "package.json": `${JSON.stringify({
        name: "public-safety-pack-only-fixture",
        version: "1.0.0",
        files: ["dist"],
      })}\n`,
      "dist/index.js": "export const safe = true;\n",
    });
    const report = join(dirname(fixture), "packed-report.json");

    const result = runRepositoryScanner(
      fixture,
      ["--pack-only", "--report", report],
      false
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("2 files, 2 packed files, 0 commits");
    expect(JSON.parse(readFileSync(report, "utf8"))).toMatchObject({
      status: "passed",
      scanned: { files: 2, packedFiles: 2, commits: 0 },
    });
  });

  it("scans commits reachable only from a non-HEAD ref", () => {
    const fixture = createFixture({ "README.md": "safe\n" });
    git(fixture, ["init", "-b", "main"]);
    git(fixture, ["config", "user.name", "Public Contributor"]);
    git(fixture, ["config", "user.email", "265668992+aioli3@users.noreply.github.com"]);
    git(fixture, ["add", "README.md"]);
    git(fixture, ["commit", "-m", "chore: safe root"]);
    git(fixture, ["checkout", "-b", "non-head-ref"]);
    writeFileSync(join(fixture, "side.txt"), "side\n");
    git(fixture, ["add", "side.txt"]);
    git(fixture, ["commit", "-m", "chore: side history"], {
      GIT_AUTHOR_EMAIL: ["author", "workplace.test"].join("@"),
    });
    git(fixture, ["checkout", "main"]);

    const result = runScanner(fixture, [], true, fixture, false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsafe_commit_author_email");
  });

  it("excludes current and stale generated pull request merges only while they stay ephemeral", () => {
    const fixture = createFixture({ "README.md": "safe\n" });
    git(fixture, ["init", "-b", "main"]);
    git(fixture, ["config", "user.name", "Public Contributor"]);
    git(fixture, ["config", "user.email", "265668992+aioli3@users.noreply.github.com"]);
    git(fixture, ["add", "README.md"]);
    git(fixture, ["commit", "-m", "chore: safe root"]);
    const baseParent = gitOutput(fixture, ["rev-parse", "HEAD"]);
    git(fixture, ["checkout", "-b", "feature-one"]);
    writeFileSync(join(fixture, "feature-one.txt"), "feature one\n");
    git(fixture, ["add", "feature-one.txt"]);
    git(fixture, ["commit", "-m", "feat: first project parent"], {
      GIT_AUTHOR_EMAIL: ["first-parent", "workplace.test"].join("@"),
    });
    const firstParent = gitOutput(fixture, ["rev-parse", "HEAD"]);
    git(fixture, ["checkout", "-b", "feature-two", baseParent]);
    writeFileSync(join(fixture, "feature-two.txt"), "feature two\n");
    git(fixture, ["add", "feature-two.txt"]);
    git(fixture, ["commit", "-m", "feat: second project parent"], {
      GIT_COMMITTER_EMAIL: ["second-parent", "workplace.test"].join("@"),
    });
    const secondParent = gitOutput(fixture, ["rev-parse", "HEAD"]);
    const staleMerge = createSyntheticMerge(fixture, baseParent, firstParent, "stale");
    const currentMerge = createSyntheticMerge(fixture, baseParent, secondParent, "current");
    git(fixture, ["update-ref", "refs/pull/1/merge", staleMerge]);
    git(fixture, ["update-ref", "refs/remotes/pull/2/merge", currentMerge]);
    git(fixture, ["checkout", "--detach", currentMerge]);

    const result = runScanner(fixture, [], true, fixture, false);
    const report = JSON.parse(
      readFileSync(join(dirname(fixture), "default-report.json"), "utf8")
    ) as {
      scanned: { commits: number };
      violations: Array<{ category: string; location: string }>;
    };
    expect(result.status).toBe(1);
    expect(report.scanned.commits).toBe(3);
    expect(report.violations).toContainEqual({
      category: "unsafe_commit_author_email",
      location: `git:${firstParent.slice(0, 12)}`,
    });
    expect(report.violations).toContainEqual({
      category: "unsafe_commit_committer_email",
      location: `git:${secondParent.slice(0, 12)}`,
    });
    for (const generatedMerge of [staleMerge, currentMerge]) {
      expect(report.violations.some(({ location }) => location.includes(generatedMerge.slice(0, 12))))
        .toBe(false);
    }

    git(fixture, ["tag", "persisted-stale-merge", staleMerge]);
    git(fixture, ["branch", "persisted-current-merge", currentMerge]);
    const persistedResult = runScanner(fixture, [], true, fixture, false);
    const persistedReport = JSON.parse(
      readFileSync(join(dirname(fixture), "default-report.json"), "utf8")
    ) as {
      scanned: { commits: number };
      violations: Array<{ category: string; location: string }>;
    };
    expect(persistedResult.status).toBe(1);
    expect(persistedReport.scanned.commits).toBe(5);
    for (const generatedMerge of [staleMerge, currentMerge]) {
      expect(persistedReport.violations).toContainEqual({
        category: "unsafe_commit_author_email",
        location: `git:${generatedMerge.slice(0, 12)}`,
      });
      expect(persistedReport.violations).toContainEqual({
        category: "unsafe_commit_committer_email",
        location: `git:${generatedMerge.slice(0, 12)}`,
      });
    }
  });

  it("fails closed when a generated merge ref does not name a commit", () => {
    const fixture = createFixture({ "README.md": "safe\n" });
    git(fixture, ["init", "-b", "main"]);
    git(fixture, ["config", "user.name", "Public Contributor"]);
    git(fixture, ["config", "user.email", "265668992+aioli3@users.noreply.github.com"]);
    git(fixture, ["add", "README.md"]);
    git(fixture, ["commit", "-m", "chore: safe root"]);
    const blob = gitOutput(fixture, ["rev-parse", "HEAD:README.md"]);
    git(fixture, ["update-ref", "refs/remotes/pull/3/merge", blob]);

    const result = runScanner(fixture, [], true, fixture, false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("public safety: scanner_error at scanner");
  });

  it("scans a generated merge that is a parent of another generated merge", () => {
    const fixture = createFixture({ "README.md": "safe\n" });
    git(fixture, ["init", "-b", "main"]);
    git(fixture, ["config", "user.name", "Public Contributor"]);
    git(fixture, ["config", "user.email", "265668992+aioli3@users.noreply.github.com"]);
    git(fixture, ["add", "README.md"]);
    git(fixture, ["commit", "-m", "chore: safe root"]);
    const baseParent = gitOutput(fixture, ["rev-parse", "HEAD"]);
    git(fixture, ["checkout", "-b", "feature"]);
    writeFileSync(join(fixture, "feature.txt"), "feature\n");
    git(fixture, ["add", "feature.txt"]);
    git(fixture, ["commit", "-m", "feat: safe project parent"]);
    const featureParent = gitOutput(fixture, ["rev-parse", "HEAD"]);
    const innerMerge = createSyntheticMerge(fixture, baseParent, featureParent, "inner");
    const outerMerge = createSyntheticMerge(fixture, baseParent, innerMerge, "outer");
    git(fixture, ["update-ref", "refs/remotes/pull/4/merge", innerMerge]);
    git(fixture, ["update-ref", "refs/remotes/pull/5/merge", outerMerge]);
    git(fixture, ["checkout", "--detach", outerMerge]);

    const result = runScanner(fixture, [], true, fixture, false);
    const report = JSON.parse(
      readFileSync(join(dirname(fixture), "default-report.json"), "utf8")
    ) as {
      scanned: { commits: number };
      violations: Array<{ category: string; location: string }>;
    };
    expect(result.status).toBe(1);
    expect(report.scanned.commits).toBe(3);
    expect(report.violations).toContainEqual({
      category: "unsafe_commit_author_email",
      location: `git:${innerMerge.slice(0, 12)}`,
    });
    expect(report.violations).toContainEqual({
      category: "unsafe_commit_committer_email",
      location: `git:${innerMerge.slice(0, 12)}`,
    });
    expect(report.violations.some(({ location }) => location.includes(outerMerge.slice(0, 12))))
      .toBe(false);
  });

  it("writes a sanitized report without matched content", () => {
    const unsafeContent = ["person", "workplace.test"].join("@");
    const fixture = createFixture({ "README.md": unsafeContent });
    const report = join(dirname(fixture), "report.json");
    runScanner(fixture, ["--report", report]);
    const parsed = JSON.parse(readFileSync(report, "utf8")) as {
      status: string;
      violations: Array<Record<string, string>>;
    };
    expect(parsed.status).toBe("failed");
    expect(JSON.stringify(parsed)).not.toContain(unsafeContent);
    expect(parsed.violations.every((violation) => Object.keys(violation).length === 2)).toBe(true);
    expect(parsed.violations).toContainEqual(
      expect.objectContaining({ category: "personal_email", location: "explicit-root/README.md" })
    );
  });
});

function createFixture(files: Record<string, string>): string {
  const parent = mkdtempSync(join(tmpdir(), "dvm-cli-safety-test-"));
  temporaryRoots.push(parent);
  const fixture = join(parent, "input");
  mkdirSync(fixture);
  for (const [path, content] of Object.entries(files)) {
    const destination = join(fixture, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  return fixture;
}

function runScanner(
  fixture: string,
  extra: string[] = [],
  skipPack = true,
  scannerRoot = repositoryRoot,
  skipGit = true,
  env: Record<string, string> = {}
) {
  const report = join(dirname(fixture), "default-report.json");
  const args = [
    scanner,
    "--root",
    scannerRoot,
    "--scan-root",
    fixture,
    "--report",
    report,
    ...(skipGit ? ["--skip-git"] : []),
    ...(skipPack ? ["--skip-pack"] : []),
    ...extra,
  ];
  return spawnSync(process.execPath, args, {
    cwd: fixture,
    encoding: "utf8",
    env: { ...process.env, PUBLIC_SAFETY_RUNTIME_DIR: ".runtime", ...env },
  });
}

function runRepositoryScanner(
  fixture: string,
  extra: string[] = [],
  skipPack = true,
  skipGit = true,
  env: Record<string, string> = {}
) {
  const report = join(dirname(fixture), "default-report.json");
  const args = [
    scanner,
    "--root",
    fixture,
    "--report",
    report,
    ...(skipGit ? ["--skip-git"] : []),
    ...(skipPack ? ["--skip-pack"] : []),
    ...extra,
  ];
  return spawnSync(process.execPath, args, {
    cwd: fixture,
    encoding: "utf8",
    env: { ...process.env, PUBLIC_SAFETY_RUNTIME_DIR: ".runtime", ...env },
  });
}

function initializeGitFixture(cwd: string, excludes: string[] = []): void {
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.name", "Public Contributor"]);
  git(cwd, ["config", "user.email", "265668992+aioli3@users.noreply.github.com"]);
  if (excludes.length > 0) {
    writeFileSync(join(cwd, ".git", "info", "exclude"), `${excludes.join("\n")}\n`);
  }
}

function runtimeSnapshot(fixture: string) {
  const runtime = join(fixture, ".runtime");
  const token = join(runtime, "credential-token");
  const metadata = join(runtime, "runtime.json");
  return {
    runtime: selectedStat(runtime),
    token: { ...selectedStat(token), content: readFileSync(token, "utf8") },
    metadata: { ...selectedStat(metadata), content: readFileSync(metadata, "utf8") },
  };
}

function selectedStat(path: string) {
  const stat = lstatSync(path);
  return { ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs };
}

function syntheticSecret(): string {
  return ["github", "pat", "abcdefghijklmnopqrstuvwx"].join("_");
}

function sameOwnerRepositoryUrl(): string {
  const locator = new URL("https://github.com");
  locator.pathname = "/internal-example/internal-example";
  return locator.href.replace(/\/$/u, "");
}

function git(cwd: string, args: string[], env: Record<string, string> = {}): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PUBLIC_SAFETY_RUNTIME_DIR: ".runtime", ...env },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function gitOutput(
  cwd: string,
  args: string[],
  env: Record<string, string> = {}
): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PUBLIC_SAFETY_RUNTIME_DIR: ".runtime", ...env },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function createSyntheticMerge(
  cwd: string,
  baseParent: string,
  featureParent: string,
  label: string
): string {
  const tree = gitOutput(cwd, ["rev-parse", `${baseParent}^{tree}`]);
  return gitOutput(
    cwd,
    [
      "commit-tree",
      tree,
      "-p",
      baseParent,
      "-p",
      featureParent,
      "-m",
      `Merge ${label} pull request`,
    ],
    {
      GIT_AUTHOR_EMAIL: [`${label}-merge`, "github.test"].join("@"),
      GIT_COMMITTER_EMAIL: [`${label}-merge`, "github.test"].join("@"),
    }
  );
}
