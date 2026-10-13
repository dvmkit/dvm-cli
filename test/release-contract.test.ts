import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..");
const checker = join(repositoryRoot, "scripts", "check-release.mjs");
const artifactTool = join(repositoryRoot, "scripts", "release-artifact.mjs");
const temporaryRoots: string[] = [];

describe("release automation contract", () => {
  it.each([
    ["a verification command that bypasses the orchestrator", "package.json", "node scripts/verify.mjs", "node scripts/check-release.mjs"],
    ["a clean source gate without its internal-mode guard", "scripts/clean-install-smoke.mjs", "DVM_CLI_CLEAN_SOURCE: \"1\"", "DVM_CLI_UNSAFE_SOURCE: \"1\""],
    ["a clean source gate that discards its verified build", "scripts/clean-install-smoke.mjs", "publishVerifiedDist(temporaryRoot);", "void temporaryRoot;"],
    ["a public-safety scanner without packed-artifact isolation", "scripts/public-safety.mjs", 'argument === "--pack-only"', 'argument === "--package-only"'],
    ["a widened publish permission", ".github/workflows/release.yml", "contents: read\n      id-token: write", "contents: write\n      id-token: write"],
    ["self-hosted release execution", ".github/workflows/release.yml", "runs-on: ubuntu-latest", "runs-on: self-hosted"],
    ["an npm token", ".github/workflows/release.yml", "environment: npm-release", "environment: npm-release\n    env:\n      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}"],
    ["an unpinned action", ".github/workflows/release.yml", "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803", "actions/checkout@v6"],
    ["release-please enabled by default", ".github/workflows/release-please.yml", "if: vars.RELEASE_PLEASE_ENABLED == 'true'", "if: always()"],
    ["component-prefixed release tags", "release-please-config.json", '"include-component-in-tag": false', '"include-component-in-tag": true'],
    ["release-please without narrowed issue permissions", ".github/workflows/release-please.yml", "permission-issues: write", "permission-issues: read"],
    ["an unpinned GitHub App token action", ".github/workflows/release-please.yml", "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1", "actions/create-github-app-token@v3"],
    ["release-please without its App token input", ".github/workflows/release-please.yml", "token: ${{ steps.app-token.outputs.token }}", "token: ${{ github.token }}"],
    ["a GitHub expression interpolated directly into shell", ".github/workflows/release.yml", 'release_tag="$INPUT_TAG"', "release_tag='${{ inputs.tag }}'"],
    ["a broad release tag mapping", ".github/workflows/release.yml", "tags: [\"v*\"]", "tags: [\"*\"]"],
    ["manual publishing", ".github/workflows/release.yml", "if: github.event_name == 'push'", "if: always()"],
    ["a tag-push release without publication success", ".github/workflows/release.yml", "needs.publish.result == 'success'", "needs.publish.result == 'skipped'"],
    ["a manual GitHub release recovery without a successful build", ".github/workflows/release.yml", "needs.build.result == 'success'", "needs.build.result == 'skipped'"],
    ["a missing artifact verification step", ".github/workflows/release.yml", "node scripts/release-artifact.mjs verify", "node scripts/release-artifact.mjs inspect"],
    ["a release job without label-write permission", ".github/workflows/release.yml", "contents: write\n      issues: write", "contents: write"],
    ["a release job without pull request write permission", ".github/workflows/release.yml", "issues: write\n      pull-requests: write", "issues: write"],
    ["a release job without an explicit repository", ".github/workflows/release.yml", "GH_REPO: ${{ github.repository }}", "RELEASE_REPO: ${{ github.repository }}"],
    ["a release job without exact npm recovery", ".github/workflows/release.yml", "node scripts/publish-release.mjs", "node scripts/pinned-publish-npm.mjs publish"],
    ["a release job that leaves release-please pending", ".github/workflows/release.yml", "labels[]=autorelease: tagged", "labels[]=release: tagged"],
    ["a consumer install that bypasses propagation recovery", ".github/workflows/release.yml", "node scripts/install-published-release.mjs", "node scripts/pinned-publish-npm.mjs install"],
    ["an unbounded consumer propagation installer", "scripts/install-published-release.mjs", "const defaultAvailabilityTimeoutMs = 30 * 60 * 1_000", "const defaultAvailabilityTimeoutMs = Number.POSITIVE_INFINITY"],
    ["a publish job too short for both availability windows", ".github/workflows/release.yml", "timeout-minutes: 75", "timeout-minutes: 30"],
    ["an RC GitHub release without prerelease metadata", ".github/workflows/release.yml", "prerelease_flag=(--prerelease)", "prerelease_flag=()"],
    ["an RC classified as a stable GitHub release", ".github/workflows/release.yml", 'if [[ "$TAG" == *-rc.* ]]; then', "if false; then"],
    ["a stable tag classified as a prerelease", ".github/workflows/release.yml", 'if [[ "$TAG" == *-rc.* ]]; then', "if true; then"],
    ["a provenance overclaim", "docs/releasing.md", "Confirm the attestation on the npm version page after publication before claiming provenance for that release", "Claim provenance for every release without checking its published attestation"],
    ["a half-renamed consumer install", "scripts/install-published-release.mjs", 'const expectedPackageName = "@dvmkit/dvm-cli"', 'const expectedPackageName = "@dvmkit/cli"'],
    ["a half-renamed consumer install path", ".github/workflows/release.yml", "node_modules/@dvmkit/dvm-cli", "node_modules/@dvmkit/cli"],
    ["an SDK dependency resolved from another registry", "package-lock.json", '"resolved": "https://registry.npmjs.org/@dvmkit/sdk/', '"resolved": "https://npm.pkg.github.com/@dvmkit/sdk/'],
    ["a Cashu dependency resolved from another registry", "package-lock.json", '"resolved": "https://registry.npmjs.org/@cashu/cashu-ts/', '"resolved": "https://npm.pkg.github.com/@cashu/cashu-ts/'],
  ])("rejects %s", (_label, path, expected, replacement) => {
    const fixture = makeFixture();
    replace(fixture, path, expected, replacement);
    expect(runCheck(fixture).status).toBe(1);
  });

  it.each([
    {
      label: "a package and manifest version drift",
      mutate: (root: string) => {
        const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
        replace(root, ".release-please-manifest.json", packageVersion, "1.0.0");
      },
    },
    {
      label: "an SDK dependency floated onto a dist-tag",
      mutate: (root: string) => replace(root, "package.json", sdkSpecifier(root), "next"),
    },
    {
      label: "an SDK dependency taken from the filesystem",
      mutate: (root: string) => replace(root, "package.json", sdkSpecifier(root), "file:../sdk"),
    },
    {
      label: "an SDK dependency widened to a caret range",
      mutate: (root: string) => {
        const version = sdkSpecifier(root);
        replace(root, "package.json", version, `^${version}`);
      },
    },
    {
      label: "an SDK dependency with no integrity hash",
      mutate: (root: string) => {
        const lockPath = join(root, "package-lock.json");
        const lock = JSON.parse(readFileSync(lockPath, "utf8"));
        delete lock.packages["node_modules/@dvmkit/sdk"].integrity;
        writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      },
    },
    {
      label: "a Cashu dependency widened to a caret range",
      mutate: (root: string) => {
        const version = dependencySpecifier(root, "@cashu/cashu-ts");
        replace(root, "package.json", `"@cashu/cashu-ts": "${version}"`, `"@cashu/cashu-ts": "^${version}"`);
      },
    },
    {
      label: "a Cashu dependency regressed below the rotation-aware baseline",
      mutate: (root: string) => {
        const packagePath = join(root, "package.json");
        const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
        packageJson.dependencies["@cashu/cashu-ts"] = "4.2.1";
        writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

        const lockPath = join(root, "package-lock.json");
        const lock = JSON.parse(readFileSync(lockPath, "utf8"));
        lock.packages["node_modules/@cashu/cashu-ts"].version = "4.2.1";
        lock.packages["node_modules/@cashu/cashu-ts"].resolved =
          "https://registry.npmjs.org/@cashu/cashu-ts/-/cashu-ts-4.2.1.tgz";
        lock.packages[""].dependencies["@cashu/cashu-ts"] = "4.2.1";
        writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      },
    },
    {
      label: "a Cashu dependency with no integrity hash",
      mutate: (root: string) => {
        const lockPath = join(root, "package-lock.json");
        const lock = JSON.parse(readFileSync(lockPath, "utf8"));
        delete lock.packages["node_modules/@cashu/cashu-ts"].integrity;
        writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      },
    },
  ])("rejects $label", ({ mutate }) => {
    const fixture = makeFixture();
    mutate(fixture);
    expect(runCheck(fixture).status).toBe(1);
  });

  it.each(["|", "|-", "|+", ">", ">-", ">+", "|2", "|2-", "|-2", ">2", ">+2"])(
    "rejects GitHub expression interpolation in run: %s",
    (style) => {
      const fixture = makeFixture();
      replace(
        fixture,
        ".github/workflows/release.yml",
        "run: |\n          set -euo pipefail",
        `run: ${style}\n          release_tag='\${{ inputs.tag }}'`
      );
      expect(runCheck(fixture).status).toBe(1);
    }
  );

  it("rejects GitHub expression interpolation in an inline run", () => {
    const fixture = makeFixture();
    replace(
      fixture,
      ".github/workflows/release.yml",
      "run: |\n          set -euo pipefail",
      "run: echo '${{ inputs.tag }}'"
    );
    expect(runCheck(fixture).status).toBe(1);
  });

  it("rejects GitHub expression interpolation in a spaced block run key", () => {
    const fixture = makeFixture();
    replace(
      fixture,
      ".github/workflows/release.yml",
      "run: |\n          set -euo pipefail",
      "run : |-\n          release_tag='${{ inputs.tag }}'"
    );
    expect(runCheck(fixture).status).toBe(1);
  });

  it("rejects GitHub expression interpolation in a spaced inline run key", () => {
    const fixture = makeFixture();
    replace(
      fixture,
      ".github/workflows/release.yml",
      "run: |\n          set -euo pipefail",
      "run : echo '${{ inputs.tag }}'"
    );
    expect(runCheck(fixture).status).toBe(1);
  });

  it.each([
    ["a double-quoted block run key", '"run": |-\n          echo "${{ inputs.tag }}"'],
    ["a single-quoted inline run key", "'run': echo '${{ inputs.tag }}'"],
    ["an escaped double-quoted inline run key", '"\\u0072un": echo "${{ inputs.tag }}"'],
  ])("rejects GitHub expression interpolation in %s", (_label, replacement) => {
    const fixture = makeFixture();
    replace(fixture, ".github/workflows/release.yml", "run: |\n          set -euo pipefail", replacement);
    expect(runCheck(fixture).status).toBe(1);
  });

  it("binds the exact tarball bytes and file shape before publication", () => {
    const root = mkdtempSync(join(tmpdir(), "dvm-cli-release-artifact-"));
    temporaryRoots.push(root);
    const source = join(root, "source", "package");
    const first = join(root, "first.tgz");
    const second = join(root, "second.tgz");
    const artifactDirectory = join(root, "artifact");
    mkdirSync(join(source, "skills", "dvm"), { recursive: true });
    writeFileSync(join(source, "package.json"), '{"name":"@dvmkit/dvm-cli","version":"1.2.3"}\n');
    writeFileSync(join(source, "skills", "dvm", "SKILL.md"), "skill\n");
    pack(join(root, "source"), first);
    pack(join(root, "source"), second);
    mkdirSync(artifactDirectory);
    expect(
      runArtifact([
        "create",
        "--first",
        first,
        "--second",
        second,
        "--output",
        join(artifactDirectory, "release-digest.json"),
        "--tag",
        "v1.2.3",
        "--version",
        "1.2.3",
        "--dist-tag",
        "latest",
      ]).status
    ).toBe(0);
    cpSync(first, join(artifactDirectory, "first.tgz"));
    expect(
      runArtifact([
        "verify",
        "--directory",
        artifactDirectory,
        "--tag",
        "v1.2.3",
        "--version",
        "1.2.3",
        "--dist-tag",
        "latest",
      ]).status
    ).toBe(0);
    replace(artifactDirectory, "release-digest.json", '"sha256": "', '"sha256": "0');
    expect(
      runArtifact([
        "verify",
        "--directory",
        artifactDirectory,
        "--tag",
        "v1.2.3",
        "--version",
        "1.2.3",
        "--dist-tag",
        "latest",
      ]).status
    ).toBe(1);
  });

  it("rejects mismatched package archives before binding a release digest", () => {
    const root = mkdtempSync(join(tmpdir(), "dvm-cli-release-artifact-mismatch-"));
    temporaryRoots.push(root);
    const firstSource = join(root, "first-source");
    const secondSource = join(root, "second-source");
    const first = join(root, "first.tgz");
    const second = join(root, "second.tgz");
    mkdirSync(join(firstSource, "package"), { recursive: true });
    mkdirSync(join(secondSource, "package"), { recursive: true });
    writeFileSync(join(firstSource, "package", "package.json"), '{"name":"@dvmkit/dvm-cli","version":"1.2.3"}\n');
    writeFileSync(join(secondSource, "package", "package.json"), '{"name":"@dvmkit/dvm-cli","version":"1.2.3"}\n');
    writeFileSync(join(firstSource, "package", "extra.txt"), "only in the first archive\n");
    pack(firstSource, first);
    pack(secondSource, second);
    expect(
      runArtifact([
        "create",
        "--first",
        first,
        "--second",
        second,
        "--output",
        join(root, "release-digest.json"),
        "--tag",
        "v1.2.3",
        "--version",
        "1.2.3",
        "--dist-tag",
        "latest",
      ]).status
    ).toBe(1);
  });

  it("rejects a Git-valid tag payload before release operations", () => {
    const payload = "v1.2.3';echo${IFS}tag=v9.9.9>>$GITHUB_OUTPUT;exit${IFS}0;'";
    expect(git(["check-ref-format", "--allow-onelevel", `refs/tags/${payload}`]).status).toBe(0);
    const result = spawnSync(process.execPath, [join(repositoryRoot, "scripts", "release-tag.mjs"), "--tag", payload, "--dry-run"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--tag must be vX.Y.Z or vX.Y.Z-rc.N");
    expect(result.stdout).toBe("");
  });

  it("rejects a stale local tracking ref when the remote default branch advanced", () => {
    const root = mkdtempSync(join(tmpdir(), "dvm-cli-release-remote-"));
    temporaryRoots.push(root);
    const remote = join(root, "remote.git");
    const worktree = join(root, "worktree");
    const updater = join(root, "updater");
    git(["init", "--bare", remote]);
    git(["init", worktree]);
    configureGitIdentity(worktree);
    mkdirSync(join(worktree, "scripts"), { recursive: true });
    writeFileSync(join(worktree, "package.json"), '{"version":"1.2.3"}\n');
    writeFileSync(join(worktree, ".release-please-manifest.json"), '{".":"1.2.3"}\n');
    cpSync(join(repositoryRoot, "scripts", "release-tag.mjs"), join(worktree, "scripts", "release-tag.mjs"));
    git(["-C", worktree, "add", "."]);
    git(["-C", worktree, "commit", "-m", "chore: seed release test"]);
    git(["-C", worktree, "branch", "-M", "master"]);
    git(["-C", worktree, "remote", "add", "origin", remote]);
    git(["-C", worktree, "push", "--set-upstream", "origin", "master"]);
    git(["-C", remote, "symbolic-ref", "HEAD", "refs/heads/master"]);
    git(["clone", remote, updater]);
    configureGitIdentity(updater);
    writeFileSync(join(updater, "advanced.txt"), "remote advanced\n");
    git(["-C", updater, "add", "advanced.txt"]);
    git(["-C", updater, "commit", "-m", "chore: advance remote"]);
    git(["-C", updater, "push", "origin", "master"]);

    const result = spawnSync(process.execPath, [join(worktree, "scripts", "release-tag.mjs"), "--tag", "v1.2.3", "--dry-run"], {
      cwd: worktree,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("current remote default-branch tip");
  });

  it("does not trust a local SSH allow-list that differs from the committed release signers", () => {
    const { root, worktree } = createReleaseTagRepository();
    temporaryRoots.push(root);
    const listedKey = join(root, "listed");
    const unlistedKey = join(root, "unlisted");
    generateSshKey(listedKey);
    generateSshKey(unlistedKey);
    const principal = "release-test@example.invalid";
    writeFileSync(
      join(worktree, ".github", "release-signers"),
      `${principal} namespaces="git" ${readFileSync(`${listedKey}.pub`, "utf8").trim()}\n`
    );
    writeFileSync(
      join(root, "local-allowed-signers"),
      `${principal} namespaces="git" ${readFileSync(`${unlistedKey}.pub`, "utf8").trim()}\n`
    );
    git(["-C", worktree, "add", ".github/release-signers"]);
    git(["-C", worktree, "commit", "-m", "chore: set committed signer"]);
    git(["-C", worktree, "push", "origin", "master"]);
    git(["-C", worktree, "config", "user.signingkey", unlistedKey]);
    git(["-C", worktree, "config", "gpg.format", "openpgp"]);
    git(["-C", worktree, "config", "gpg.ssh.allowedSignersFile", join(root, "local-allowed-signers")]);

    const result = spawnSync(process.execPath, [join(worktree, "scripts", "release-tag.mjs"), "--tag", "v1.2.3", "--dry-run"], {
      cwd: worktree,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
  });
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "dvm-cli-release-contract-"));
  temporaryRoots.push(root);
  for (const path of [
    "package.json",
    "package-lock.json",
    ".release-please-manifest.json",
    "release-please-config.json",
    ".github/release-signers",
    ".github/workflows/release-please.yml",
    ".github/workflows/release.yml",
    "scripts/check-release.mjs",
    "scripts/clean-install-smoke.mjs",
    "scripts/install-published-release.mjs",
    "scripts/publish-release.mjs",
    "scripts/release-artifact.mjs",
    "scripts/release-tag.mjs",
    "scripts/pinned-publish-npm.mjs",
    "scripts/public-safety.mjs",
    "scripts/verify.mjs",
    "docs/releasing.md",
    "CHANGELOG.md",
  ]) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(repositoryRoot, path), destination, { force: true, recursive: true });
  }
  return root;
}

function sdkSpecifier(root: string): string {
  return dependencySpecifier(root, "@dvmkit/sdk");
}

function dependencySpecifier(root: string, name: string): string {
  const specifier = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies[name];
  expect(typeof specifier).toBe("string");
  return specifier as string;
}

function replace(root: string, path: string, expected: string, replacement: string) {
  const target = join(root, path);
  const source = readFileSync(target, "utf8");
  expect(source).toContain(expected);
  writeFileSync(target, source.replace(expected, replacement));
}

function runCheck(root: string) {
  return spawnSync(process.execPath, [checker, "--root", root], { encoding: "utf8" });
}

function runArtifact(args: string[]) {
  return spawnSync(process.execPath, [artifactTool, ...args], { encoding: "utf8" });
}

function pack(source: string, archive: string) {
  // gzip's header embeds the wall-clock compression time by default, so two `tar -czf`
  // calls that straddle a one-second boundary produce different bytes for identical
  // content. Compress separately with zlib, which always writes a zero timestamp.
  const tarPath = `${archive}.tar`;
  expect(spawnSync("tar", ["-cf", tarPath, "-C", source, "package"], { encoding: "utf8" }).status).toBe(0);
  writeFileSync(archive, gzipSync(readFileSync(tarPath)));
  rmSync(tarPath);
}

function git(args: string[]) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  expect(result.status).toBe(0);
  return result;
}

function configureGitIdentity(directory: string) {
  git(["-C", directory, "config", "user.name", "Release test"]);
  git(["-C", directory, "config", "user.email", "release-test@example.invalid"]);
}

function createReleaseTagRepository() {
  const root = mkdtempSync(join(tmpdir(), "dvm-cli-release-signer-"));
  const remote = join(root, "remote.git");
  const worktree = join(root, "worktree");
  git(["init", "--bare", remote]);
  git(["init", worktree]);
  configureGitIdentity(worktree);
  mkdirSync(join(worktree, "scripts"), { recursive: true });
  mkdirSync(join(worktree, ".github"), { recursive: true });
  writeFileSync(join(worktree, "package.json"), '{"version":"1.2.3"}\n');
  writeFileSync(join(worktree, ".release-please-manifest.json"), '{".":"1.2.3"}\n');
  writeFileSync(join(worktree, ".github", "release-signers"), "placeholder namespaces=\"git\" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIOAABfWAkQaX/F7qoDtDVT1APZho1qYllrCaXQOCWXR\n");
  cpSync(join(repositoryRoot, "scripts", "release-tag.mjs"), join(worktree, "scripts", "release-tag.mjs"));
  git(["-C", worktree, "add", "."]);
  git(["-C", worktree, "commit", "-m", "chore: seed signer test"]);
  git(["-C", worktree, "branch", "-M", "master"]);
  git(["-C", worktree, "remote", "add", "origin", remote]);
  git(["-C", worktree, "push", "--set-upstream", "origin", "master"]);
  git(["-C", remote, "symbolic-ref", "HEAD", "refs/heads/master"]);
  return { root, worktree };
}

function generateSshKey(path: string) {
  expect(spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path], { encoding: "utf8" }).status).toBe(0);
}
