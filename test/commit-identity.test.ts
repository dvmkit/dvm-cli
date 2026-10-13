import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "../scripts/check-commit-identity.mjs");
const approved = "265668992+aioli3@users.noreply.github.com";
const privateEmail = "person@example.com";

function repository() {
  const root = mkdtempSync(join(tmpdir(), "commit-identity-"));
  const git = (args: string[], input?: string) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", input,
  }).trim();
  git(["init", "--quiet"]);
  const tree = git(["mktree"], "");
  const commit = (parents: string[], author = approved, committer = approved) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit-tree", tree,
      ...parents.flatMap((parent) => ["-p", parent])], {
      cwd: root, encoding: "utf8", input: "test commit\n",
      // Synthetic identities are confined to this disposable repository.
      env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: author,
        GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: committer },
    }).trim();
  const base = commit([]);
  const check = (head: string, baseHash = base) => spawnSync(process.execPath, [script, baseHash, head], {
    cwd: root, encoding: "utf8",
  });
  return { root, base, commit, check };
}

function withRepository(run: (repo: ReturnType<typeof repository>) => void) {
  const repo = repository();
  try { run(repo); } finally { rmSync(repo.root, { recursive: true, force: true }); }
}

describe("public commit identity", () => {
  it("accepts approved maintainer and GitHub bot identities", () => withRepository((repo) => {
    const first = repo.commit([repo.base]);
    const head = repo.commit([first], "41898282+github-actions[bot]@users.noreply.github.com", "noreply@github.com");
    const release = repo.commit([head], approved, "319907686+dvmkit-release-automation[bot]@users.noreply.github.com");
    expect(repo.check(release).status).toBe(0);
    expect(repo.check(release).stdout).toContain("3 commits");
  }));

  it.each(["author", "committer"])("rejects a private %s on an older commit despite an approved tip", (role) => withRepository((repo) => {
    const older = repo.commit([repo.base], role === "author" ? privateEmail : approved,
      role === "committer" ? privateEmail : approved);
    const head = repo.commit([older]);
    const result = repo.check(head);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`unapproved ${role} on ${older}`);
    expect(result.stderr).not.toContain(privateEmail);
  }));

  it.each([
    ["account", "123+other@users.noreply.github.com", approved],
    ["release App lookalike", approved, "319907687+dvmkit-release-automation[bot]@users.noreply.github.com"],
  ])("rejects an unapproved %s noreply identity", (_label, author, committer) => withRepository((repo) => {
    const head = repo.commit([repo.base], author, committer);
    expect(repo.check(head).status).toBe(1);
  }));

  it("includes unapproved commits introduced through a merge", () => withRepository((repo) => {
    const clean = repo.commit([repo.base]);
    const branch = repo.commit([repo.base], privateEmail);
    const head = repo.commit([clean, branch]);
    const result = repo.check(head);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(branch);
  }));

  it("fails closed on an empty range or unavailable history", () => withRepository((repo) => {
    expect(repo.check(repo.base).status).toBe(1);
    expect(repo.check("f".repeat(40)).status).toBe(1);
    expect(repo.check(repo.base, "--all").status).toBe(1);
  }));
});
