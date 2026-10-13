#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const rootArgument = process.argv.indexOf("--root");
const root = rootArgument >= 0 ? resolve(process.argv[rootArgument + 1] ?? "") : resolve(import.meta.dirname, "..");

const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const manifest = readJson(".release-please-manifest.json");
const releasePleaseConfig = readJson("release-please-config.json");
const releasePlease = readText(".github/workflows/release-please.yml");
const release = readText(".github/workflows/release.yml");
const artifact = readText("scripts/release-artifact.mjs");
const tagger = readText("scripts/release-tag.mjs");
const publisher = readText("scripts/pinned-publish-npm.mjs");
const consumerInstaller = readText("scripts/install-published-release.mjs");
const releasePublisher = readText("scripts/publish-release.mjs");
const signers = readText(".github/release-signers");
const docs = readText("docs/releasing.md");
const changelog = readText("CHANGELOG.md");
const gate = readText("scripts/verify.mjs");
const cleanInstall = readText("scripts/clean-install-smoke.mjs");
const publicSafety = readText("scripts/public-safety.mjs");

if (packageJson.scripts?.["check:release"] !== "node scripts/check-release.mjs") {
  fail("package.json must expose check:release");
}
if (packageJson.scripts?.["release:tag"] !== "node scripts/release-tag.mjs") {
  fail("package.json must expose release:tag");
}
if (packageJson.scripts?.verify !== "node scripts/verify.mjs") {
  fail("verify must use the measured verification orchestrator");
}
for (const step of [
  'name: "lint"',
  'name: "build"',
  'name: "typecheck"',
  'name: "tests"',
  '"check:package"',
  '"check:public-safety"',
  '"check:release"',
  '"clean-install-smoke"',
]) {
  if (!gate.includes(step)) fail(`verify must retain ${step}`);
}
if (
  !gate.includes("--clean-source") ||
  !gate.includes("--skip-pack") ||
  !gate.includes("--pack-only") ||
  !cleanInstall.includes("DVM_CLI_CLEAN_SOURCE") ||
  !cleanInstall.includes('"--clean-source"') ||
  !cleanInstall.includes("publishVerifiedDist(temporaryRoot)") ||
  !cleanInstall.includes("sanitizeOutput") ||
  !publicSafety.includes('argument === "--pack-only"')
) {
  fail("the verify gate must run once in the isolated locked-install tree and preserve its verified dist");
}
if (manifest["."] !== packageJson.version) fail("release-please manifest version differs from package.json");
assertExactRegistryDependency("@dvmkit/sdk");
const cashuVersion = assertExactRegistryDependency("@cashu/cashu-ts");
if (!/^4\.(?:9|[1-9]\d+)\.\d+$/u.test(cashuVersion)) {
  fail(`@cashu/cashu-ts must use a stable rotation-aware 4.x release, not "${cashuVersion}"`);
}
if (!release.includes(`node_modules/${packageJson.name}`) || !artifact.includes(`"${packageJson.name}"`) || !releasePublisher.includes(`"${packageJson.name}"`)) {
  fail("release pipeline must bind the manifest package name");
}
if (releasePleaseConfig["skip-github-release"] !== true) {
  fail("release-please must not create tags or GitHub releases");
}
if (
  releasePleaseConfig["include-component-in-tag"] !== false ||
  releasePleaseConfig["include-v-in-tag"] !== true ||
  releasePleaseConfig.packages?.["."]?.["release-type"] !== "node"
) {
  fail("release-please must configure the root Node package with unprefixed v tags");
}
if (!/googleapis\/release-please-action@[a-f0-9]{40}\s+# v5\.0\.0/u.test(releasePlease)) {
  fail("release-please action must be pinned to its reviewed v5.0.0 commit");
}
if (!/permissions:\s*\n\s+contents: read/u.test(releasePlease)) {
  fail("release-please must leave the ordinary workflow token read-only");
}
if (!/if: vars\.RELEASE_PLEASE_ENABLED == 'true'/u.test(releasePlease)) {
  fail("release-please must stay disabled until its repository variable is explicitly enabled");
}
if (!/actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1\s+# v3\.2\.0/u.test(releasePlease)) {
  fail("release-please must mint its GitHub App token from the reviewed v3.2.0 action pin");
}
for (const input of [
  "app-id: ${{ vars.RELEASE_PLEASE_APP_ID }}",
  "private-key: ${{ secrets.RELEASE_PLEASE_APP_PRIVATE_KEY }}",
  "owner: ${{ github.repository_owner }}",
  "repositories: ${{ github.event.repository.name }}",
  "permission-contents: write",
  "permission-issues: write",
  "permission-pull-requests: write",
  "token: ${{ steps.app-token.outputs.token }}",
]) {
  if (!releasePlease.includes(input)) fail(`release-please is missing required GitHub App token input: ${input}`);
}
if (/id-token:\s*write/u.test(releasePlease) || /self-hosted/u.test(releasePlease)) {
  fail("release-please must not have OIDC or self-hosted execution");
}
if (!/push:\s*\n\s+branches: \[master\]/u.test(releasePlease)) {
  fail("release-please must run only on master pushes");
}

assertPinnedActions(release);
assertNoGitHubExpressionInRunBlocks(release, "release workflow");
assertNoGitHubExpressionInRunBlocks(releasePlease, "release-please workflow");
if (/self-hosted/u.test(release)) fail("release workflow must run only on GitHub-hosted runners");
if (
  !/tags: \["v\*"\]/u.test(release) ||
  !/workflow_dispatch:/u.test(release) ||
  !/github_release_recovery:/u.test(release)
) {
  fail("release workflow must accept tags and a manual GitHub-release recovery");
}
if (!/release tag must be vX\.Y\.Z or vX\.Y\.Z-rc\.N/u.test(release)) {
  fail("release workflow must reject non-stable and non-RC tags");
}
if (!/git verify-tag "\$release_tag"/u.test(release) || !/release-signers/u.test(release)) {
  fail("release workflow must verify the signed tag against committed signers");
}
if (!/package-manager-cache: false/g.test(release)) fail("release jobs must disable package-manager caches");
if (!/node-version: 22\.18\.0/u.test(release) || !/node scripts\/pinned-npm\.mjs run verify/u.test(release)) {
  fail("build job must use the pinned toolchain and full verification gate");
}
if (!/node scripts\/release-artifact\.mjs create/u.test(release) || !/node scripts\/release-artifact\.mjs verify/u.test(release)) {
  fail("release artifact must be bound and reverified before publication");
}
if (!/retention-days: 1/u.test(release)) fail("release artifact retention must be one day");
if (/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.NPM|npm login|npm token/u.test(release)) {
  fail("release workflow must not use npm tokens or interactive npm authentication");
}

const build = jobBlock(release, "build", "publish");
const prepare = jobBlock(release, "prepare", "build");
const publish = jobBlock(release, "publish", "github-release");
const githubRelease = jobBlock(release, "github-release", undefined);
const validation = prepare.indexOf('if [[ ! "$release_tag"');
const releaseRef = prepare.indexOf('git show-ref --verify --quiet "refs/tags/$release_tag"');
const output = prepare.indexOf('"$GITHUB_OUTPUT"');
if (
  !/EVENT_NAME: \$\{\{ github\.event_name \}\}/u.test(prepare) ||
  !/INPUT_TAG: \$\{\{ inputs\.tag \}\}/u.test(prepare) ||
  !/REF_NAME: \$\{\{ github\.ref_name \}\}/u.test(prepare) ||
  !/fetch-depth: 0/u.test(prepare) ||
  validation < 0 ||
  releaseRef < validation ||
  output < releaseRef
) {
  fail("release tag input must arrive through environment variables and be validated before use");
}
if (/id-token:\s*write/u.test(build)) fail("build job must not receive OIDC");
if (!/permissions:\s*\n\s+contents: read\s*\n\s+id-token: write/u.test(publish)) {
  fail("publish job must have only read contents plus OIDC");
}
if (!/environment: npm-release/u.test(publish)) fail("publish job must require the npm-release environment");
if (!/timeout-minutes: 75/u.test(publish)) {
  fail("publish job must cover both 30-minute availability windows plus setup");
}
if (!/if: github\.event_name == 'push'/u.test(publish)) {
  fail("manual dispatch must never publish");
}
if (
  !githubRelease.includes("needs: [prepare, build, publish]") ||
  !githubRelease.includes("github.event_name == 'push' && needs.publish.result == 'success'") ||
  !githubRelease.includes("github.event_name == 'workflow_dispatch' && inputs.github_release_recovery == true") ||
  !githubRelease.includes("needs.prepare.result == 'success'") ||
  !githubRelease.includes("needs.build.result == 'success'")
) {
  fail("GitHub release recovery must require the exact tag build, and tag pushes must require publication");
}
if (!/scripts\/publish-release\.mjs --archive "\$archive" --dist-tag "\$DIST_TAG"/u.test(publish)) {
  fail("publish job must use exact npm publication recovery");
}
if (!/scripts\/install-published-release\.mjs --version "\$VERSION" --prefix "\$consumer"/u.test(publish)) {
  fail("consumer verification must use the bounded exact-version propagation installer");
}
if (
  !/npm trusted publishing/u.test(release) ||
  !/gh release create "\$TAG" --verify-tag --generate-notes "\$\{prerelease_flag\[@\]\}"/u.test(githubRelease) ||
  !/prerelease_flag=\(\)\s*\n\s*expected_prerelease=false\s*\n\s*if \[\[ "\$TAG" == \*-rc\.\* \]\]; then\s*\n\s*prerelease_flag=\(--prerelease\)\s*\n\s*expected_prerelease=true\s*\n\s*fi/u.test(
    githubRelease
  ) ||
  !/--json isPrerelease/u.test(githubRelease)
) {
  fail("GitHub release must follow trusted publication and use the existing tag");
}
const taggedLabel = githubRelease.indexOf("labels[]=autorelease: tagged");
const pendingLabel = githubRelease.indexOf("labels/autorelease%3A%20pending");
const explicitRepositoryCount = githubRelease.split("GH_REPO: ${{ github.repository }}").length - 1;
if (
  explicitRepositoryCount !== 2 ||
  !githubRelease.includes('repos/$REPOSITORY/commits/$TAG/pulls') ||
  taggedLabel < 0 ||
  pendingLabel < taggedLabel ||
  !githubRelease.includes('index("autorelease: tagged")') ||
  !githubRelease.includes('index("autorelease: pending")')
) {
  fail("GitHub release must transition the matching release pull request from pending to tagged");
}
if (
  /id-token:\s*write/u.test(githubRelease) ||
  !/permissions:\s*\n\s+contents: write\s*\n\s+issues: write\s*\n\s+pull-requests: write/u.test(githubRelease)
) {
  fail("GitHub release job must have write contents, issues, and pull requests without OIDC");
}

if (!tagger.includes("assertCleanWorktree") || !tagger.includes("assertDefaultBranchTip") || !tagger.includes("assertTagAbsent") || !tagger.includes("assertSigningCapability")) {
  fail("release tag command must fail closed on every local release precondition");
}
if (!tagger.includes('"ls-remote", "--symref", "--exit-code", "origin", "HEAD"')) {
  fail("release tag command must resolve the remote default branch without trusting cached tracking refs");
}
if (!tagger.includes("release tag dry run passed") || !tagger.includes("signedTag(root") || !tagger.includes("verifyTag(root")) {
  fail("release tag command must prove signing in dry run and create verified signed tags");
}
if (
  !tagger.includes('"gpg.format=ssh"') ||
  !tagger.includes("gpg.ssh.allowedSignersFile=${signerAllowList}") ||
  tagger.includes('copyGitConfig(scratch, "gpg.format")') ||
  tagger.includes('copyGitConfig(scratch, "gpg.ssh.allowedSignersFile")')
) {
  fail("release tag command must force SSH signing and verify against committed release signers");
}
if (!artifact.includes("the two package archives have different SHA-256 digests") || !artifact.includes("release tarball does not match its digest manifest")) {
  fail("artifact contract must bind both package copies and downloaded bytes");
}
if (!publisher.includes('const npmVersion = "11.16.0"') || !publisher.includes("npmIntegrity")) {
  fail("trusted-publishing npm bootstrap must pin and integrity-check npm 11.16.0");
}
if (
  !consumerInstaller.includes('const expectedPackageName = "@dvmkit/dvm-cli"') ||
  !consumerInstaller.includes("const defaultAvailabilityTimeoutMs = 30 * 60 * 1_000") ||
  !consumerInstaller.includes("const defaultRetryDelayMs = 10_000") ||
  !consumerInstaller.includes("const defaultInstallTimeoutMs = 2 * 60 * 1_000") ||
  !consumerInstaller.includes("runBoundedProcess") ||
  !consumerInstaller.includes('"--ignore-scripts"') ||
  !consumerInstaller.includes("isExactPropagationError")
) {
  fail("consumer installer must pin the package and bound exact-version propagation by elapsed time");
}
if (
  !releasePublisher.includes('const defaultRegistry = "https://registry.npmjs.org"') ||
  !releasePublisher.includes("const defaultAvailabilityTimeoutMs = 30 * 60 * 1_000") ||
  !releasePublisher.includes("const defaultRequestTimeoutMs = 30_000") ||
  !releasePublisher.includes("runBoundedProcess") ||
  !releasePublisher.includes('metadata?.["dist-tags"]?.[expected.distTag]') ||
  !releasePublisher.includes('sha256(remoteBytes) === expected.sha256') ||
  !releasePublisher.includes("checkPublishedRelease") ||
  !releasePublisher.includes('"pinned-publish-npm.mjs"')
) {
  fail("npm publication recovery must bind the exact registry bytes and dist-tag before accepting a version");
}
if (!/^\S+\s+namespaces="git"\s+ssh-ed25519\s+\S+$/mu.test(signers)) {
  fail("release signer allow-list must contain an SSH git signing identity");
}
if (
  !docs.includes("npm automatically generates provenance attestations for releases published from this public repository through trusted publishing.") ||
  !docs.includes("Confirm the attestation on the npm version page after publication before claiming provenance for that release")
) {
  fail("release documentation must not overclaim source provenance");
}
if (!docs.includes("tag-without-npm recovery")) fail("release documentation must name tag-without-npm recovery");
if (!docs.includes("github_release_recovery")) fail("release documentation must name GitHub-release recovery");
if (/(?:compare|tag)\/cli-v/u.test(changelog)) fail("changelog release links must use the signed v tag namespace");

console.log("release contract ok");

function readText(path) {
  try {
    return readFileSync(resolve(root, path), "utf8");
  } catch {
    fail(`required release file is missing: ${path}`);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readText(path));
  } catch {
    fail(`invalid JSON: ${path}`);
  }
}

/**
 * A published dependency must be an exact registry version, resolved from the
 * public npm registry with an integrity hash. A range, a dist-tag, or a
 * `git`/`github:`/`file:`/`link:`/`workspace:`/URL specifier would let the bytes
 * behind a signed release change without the release changing.
 */
function assertExactRegistryDependency(name) {
  const specifier = packageJson.dependencies?.[name];
  if (typeof specifier !== "string") fail(`${name} must be a runtime dependency`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(specifier)) {
    fail(`${name} must be pinned to an exact semver version, not "${specifier}"`);
  }
  const entry = packageLock.packages?.[`node_modules/${name}`];
  if (!entry) fail(`package-lock.json is missing node_modules/${name}`);
  if (entry.version !== specifier) {
    fail(`package-lock.json resolves ${name} to ${String(entry.version)}, not ${specifier}`);
  }
  if (typeof entry.resolved !== "string" || !entry.resolved.startsWith("https://registry.npmjs.org/")) {
    fail(`${name} must resolve from https://registry.npmjs.org/, not ${String(entry.resolved)}`);
  }
  if (typeof entry.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry.integrity)) {
    fail(`${name} must carry a sha512 integrity hash in package-lock.json`);
  }
  return specifier;
}

function assertPinnedActions(workflow) {
  const actions = [...workflow.matchAll(/^\s+uses: ([^\s@]+)@([^\s#]+)(?:\s+# .+)?$/gmu)];
  if (actions.length === 0) fail("release workflow must use pinned actions");
  for (const [, action, pin] of actions) {
    if (!/^[a-f0-9]{40}$/u.test(pin)) fail(`action ${action} is not pinned by full commit SHA`);
  }
}

function assertNoGitHubExpressionInRunBlocks(workflow, name) {
  let document;
  try {
    document = parse(workflow);
  } catch {
    fail(`${name} must be valid YAML`);
  }
  const pending = [document];
  const seen = new Set();
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (typeof value.run === "string" && value.run.includes("${{")) {
      fail(`${name} must not interpolate GitHub expressions directly into shell`);
    }
    pending.push(...Object.values(value));
  }
}

function jobBlock(workflow, job, nextJob) {
  const start = workflow.indexOf(`  ${job}:\n`);
  if (start < 0) fail(`release workflow is missing ${job} job`);
  const end = nextJob ? workflow.indexOf(`  ${nextJob}:\n`, start + 1) : workflow.length;
  if (end < 0) fail(`release workflow is missing ${nextJob} job`);
  return workflow.slice(start, end);
}

function fail(message) {
  console.error(`release check: ${message}`);
  process.exit(1);
}
