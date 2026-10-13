#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { isApprovedCommitEmail } from "./check-commit-identity.mjs";

const options = parseArguments(process.argv.slice(2));
const root = resolve(options.root ?? process.cwd());
const reportPath = resolve(options.report ?? join(root, ".artifacts", "public-safety-report.json"));
const violations = [];
const seenLocations = new Set();
const counts = { files: 0, commits: 0, packedFiles: 0, pullRequestBodies: 0 };
let packageTemporaryRoot;

try {
  if (!options.packOnly) {
    if (options.scanRoots.length > 0) {
      for (const scanRoot of options.scanRoots) {
        scanTree(resolve(scanRoot), locationForRoot(scanRoot));
      }
    } else {
      scanTree(root, ".", { allowIgnoredRootRuntime: true });
    }

    if (!options.skipGit) scanGitMetadata();
    if (options.gitMetadataFile) scanGitMetadataFixture(options.gitMetadataFile);

    const pullRequestBodyPath = options.prBodyFile ?? process.env.PUBLIC_SAFETY_PR_BODY_PATH;
    if (pullRequestBodyPath) {
      classifyText(readFileSync(resolve(pullRequestBodyPath), "utf8"), "pull-request-body");
      counts.pullRequestBodies += 1;
    }
  }

  if (!options.skipPack) scanPackedPackage();
} catch {
  addViolation("scanner_error", "scanner");
} finally {
  if (packageTemporaryRoot) rmSync(packageTemporaryRoot, { recursive: true, force: true });
}

writeReport();
if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`public safety: ${violation.category} at ${violation.location}`);
  }
  process.exit(1);
}
console.log(
  `public safety ok: ${counts.files} files, ${counts.packedFiles} packed files, ${counts.commits} commits, ${counts.pullRequestBodies} pull request bodies`
);

function parseArguments(args) {
  const parsed = {
    gitMetadataFile: undefined,
    packOnly: false,
    prBodyFile: undefined,
    report: undefined,
    root: undefined,
    scanRoots: [],
    skipGit: false,
    skipPack: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--pack-only") parsed.packOnly = true;
    else if (argument === "--skip-git") parsed.skipGit = true;
    else if (argument === "--skip-pack") parsed.skipPack = true;
    else if (argument === "--root") parsed.root = requireValue(args, ++index, argument);
    else if (argument === "--report") parsed.report = requireValue(args, ++index, argument);
    else if (argument === "--scan-root") {
      parsed.scanRoots.push(requireValue(args, ++index, argument));
    } else if (argument === "--pr-body-file") {
      parsed.prBodyFile = requireValue(args, ++index, argument);
    } else if (argument === "--git-metadata-file") {
      parsed.gitMetadataFile = requireValue(args, ++index, argument);
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  if (parsed.packOnly && parsed.skipPack) {
    throw new Error("--pack-only cannot be combined with --skip-pack");
  }
  return parsed;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function scanTree(scanRoot, label, { allowIgnoredRootRuntime = false, excludeMetadata = true } = {}) {
  const rootStat = lstatSync(scanRoot);
  if (rootStat.isSymbolicLink()) {
    addViolation("symlink", label);
    return;
  }
  if (rootStat.isFile()) {
    scanFile(scanRoot, label, "explicit");
    return;
  }
  const runtimeDirectory = process.env.PUBLIC_SAFETY_RUNTIME_DIR ?? ".runtime";
  if (!/^\.[A-Za-z0-9_-]+$/u.test(runtimeDirectory) || [".git", ".tooling"].includes(runtimeDirectory)) {
    throw new Error("runtime directory must be one hidden root directory");
  }
  const ignoredRootRuntime = allowIgnoredRootRuntime ? join(scanRoot, runtimeDirectory) : undefined;
  walk(scanRoot, label, ignoredRootRuntime, excludeMetadata);
}

function walk(directory, label, ignoredRootRuntime, excludeMetadata) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (excludeMetadata && dependencyOrMetadataDirectory(entry.name)) continue;
    const absolute = join(directory, entry.name);
    const location = `${label}/${entry.name}`.replace(/^\.\//u, "");
    if (entry.isSymbolicLink()) {
      addViolation("symlink", location);
    } else if (entry.isDirectory()) {
      if (
        absolute === ignoredRootRuntime &&
        ignoredUntrackedRootRuntime(entry.name)
      ) {
        continue;
      }
      walk(absolute, location, ignoredRootRuntime, excludeMetadata);
    } else if (entry.isFile()) {
      scanFile(absolute, location, "tree");
    } else {
      addViolation("unsupported_file_type", location);
    }
  }
}

function ignoredUntrackedRootRuntime(directory) {
  if (git(["ls-files", "--cached", "--", directory]).trim()) {
    addViolation("tracked_runtime_metadata", directory);
    return false;
  }

  try {
    git(["check-ignore", "--quiet", "--", directory]);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 1) {
      return false;
    }
    throw error;
  }
}

function dependencyOrMetadataDirectory(name) {
  return name === ".git" || name === ".tooling" || name === "node_modules";
}

function scanFile(absolute, location, scope) {
  if (resolve(absolute) === reportPath) return;
  counts.files += 1;
  const normalized = location.split(sep).join("/");
  const sanitizedArtifacts = new Set([
    ".artifacts/public-safety-report.json",
    ".artifacts/public-safety-packed-report.json",
    ".artifacts/verify-diagnostics.txt",
  ]);
  if (generatedLeak(normalized) && !sanitizedArtifacts.has(normalized)) {
    addViolation("generated_artifact", normalized);
  }
  if (normalized.endsWith(".map")) addViolation("source_map", normalized);
  const content = readFileSync(absolute);
  if (content.includes(0)) return;
  classifyText(content.toString("utf8"), normalized, scope);
}

function classifyText(text, location) {
  const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu) ?? [];
  for (const email of emails) {
    if (!safeEmail(email)) addViolation("personal_email", location);
  }

  const userPath =
    /(?:^|[\s"'`=(])(?:\/(?:Users|home)\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\)/u;
  if (userPath.test(text)) addViolation("absolute_private_path", location);

  classifyRepositoryLocators(text, location);
  if (/\bDVM-[0-9]+\b/u.test(text)) addViolation("internal_issue_id", location);

  const secretPatterns = [
    /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{40,}-----END (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
    /\bnpm_[A-Za-z0-9]{20,}\b/u,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
    /\bAKIA[A-Z0-9]{16}\b/u,
  ];
  if (secretPatterns.some((pattern) => pattern.test(text))) addViolation("secret", location);
}

function classifyRepositoryLocators(text, location) {
  const locators = [
    ...text.matchAll(/https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[\s#?"'`]|$)/giu),
    ...text.matchAll(/git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[\s#?"'`]|$)/giu),
  ];
  for (const match of locators) {
    const owner = match[1]?.toLowerCase();
    const repository = match[2]?.toLowerCase();
    if (owner && repository && owner === repository) {
      addViolation("private_repository", location);
    }
  }
}

function safeEmail(email) {
  const normalized = email.toLowerCase();
  return (
    normalized.endsWith("@users.noreply.github.com") ||
    normalized.endsWith("@example.com") ||
    normalized.endsWith("@example.invalid") ||
    normalized === "noreply@github.com" ||
    normalized === "alice@getalby.com" ||
    // SUPPORT.md is the only file using the published project contact address.
    // Personal addresses at the same domain remain blocked.
    normalized === "security@dvmkit.com" ||
    normalized === "support@dvmkit.com" ||
    // Third-party attribution the bundler copies into dist/ from a dependency's
    // `/*! ... */` legal comment (ws, reached through undici's WebSocket frame
    // code). The MIT licence requires the notice to travel with the bundle, so
    // it is a credit the package must carry, not a contact detail of ours.
    normalized === "einaros@gmail.com"
  );
}

function generatedLeak(path) {
  return (
    /(^|\/)(?:coverage|test-results|playwright-report|artifacts|\.artifacts|\.verify-logs)(\/|$)/u.test(
      path
    ) || /(?:\.log|\.jsonl|\.tgz|\.tar\.gz|\.zip)$/u.test(path)
  );
}

function scanGitMetadata() {
  const generatedMergeCommits = generatedPullRequestMergeCommits();
  const commits = git(["rev-list", "--all", "HEAD"])
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const commit of commits) {
    if (generatedMergeCommits.has(commit)) continue;
    const record = git([
      "show",
      "-s",
      "--format=%H%x1f%ae%x1f%ce%x1f%B",
      commit,
    ]);
    const [sha, authorEmail, committerEmail, ...messageParts] = record.split("\x1f");
    scanCommit({ sha, authorEmail, committerEmail, message: messageParts.join("\x1f") });
  }
}

function generatedPullRequestMergeCommits() {
  const candidates = new Set();
  for (const line of git(["for-each-ref", "--format=%(refname)%00%(objectname)"])
    .trim()
    .split("\n")
    .filter(Boolean)) {
    const [ref, object, ...unexpected] = line.split("\0");
    if (!ref || !object || unexpected.length > 0) throw new Error("could not inspect Git refs");
    if (generatedPullRequestMergeRef(ref)) candidates.add(object);
  }
  if (candidates.size === 0) return new Set();
  const outermostCandidates = new Set(
    git(["merge-base", "--independent", ...candidates])
      .trim()
      .split("\n")
      .filter(Boolean)
  );

  const generatedMerges = new Set();
  for (const candidate of candidates) {
    const [commit, parentsText, ...unexpected] = git([
      "show",
      "-s",
      "--format=%H%x00%P",
      candidate,
    ])
      .trim()
      .split("\0");
    if (!commit || parentsText === undefined || unexpected.length > 0 || commit !== candidate) {
      throw new Error("could not inspect generated merge commit");
    }
    if (parentsText.split(" ").filter(Boolean).length !== 2) continue;
    if (!outermostCandidates.has(candidate)) continue;

    const containingRefs = git(["for-each-ref", "--contains", candidate, "--format=%(refname)"])
      .trim()
      .split("\n")
      .filter(Boolean);
    if (containingRefs.length === 0) throw new Error("could not inspect containing Git refs");
    if (containingRefs.every(generatedPullRequestMergeRef)) generatedMerges.add(candidate);
  }
  return generatedMerges;
}

function generatedPullRequestMergeRef(ref) {
  return /^refs\/(?:remotes\/)?pull\/[1-9][0-9]*\/merge$/u.test(ref);
}

function scanGitMetadataFixture(path) {
  const records = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (!Array.isArray(records)) throw new Error("git metadata fixture must be an array");
  for (const record of records) scanCommit(record);
}

function scanCommit(record) {
  const sha = typeof record.sha === "string" ? record.sha.slice(0, 12) : "unknown";
  if (!isApprovedCommitEmail(String(record.authorEmail ?? ""))) {
    addViolation("unsafe_commit_author_email", `git:${sha}`);
  }
  if (!isApprovedCommitEmail(String(record.committerEmail ?? ""))) {
    addViolation("unsafe_commit_committer_email", `git:${sha}`);
  }
  classifyText(String(record.message ?? ""), `git:${sha}:message`);
  counts.commits += 1;
}

function scanPackedPackage() {
  packageTemporaryRoot = mkdtempSync(join(tmpdir(), "dvm-cli-public-pack-"));
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("npm executable is unavailable for packed-file inspection");
  const output = execFileSync(
    process.execPath,
    [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", packageTemporaryRoot, root],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const packed = JSON.parse(output)[0];
  const destination = join(packageTemporaryRoot, "unpacked");
  mkdirSync(destination);
  execFileSync("tar", ["-xzf", join(packageTemporaryRoot, packed.filename), "-C", destination]);
  for (const file of packed.files) {
    const path = file.path.split(sep).join("/");
    counts.packedFiles += 1;
    if (
      path.endsWith(".map") ||
      /(^|\/)(?:src|test|scripts|\.github|coverage|node_modules)(?:\/|$)/u.test(path)
    ) {
      addViolation("forbidden_packed_path", `package/${path}`);
    }
  }
  const packedManifest = JSON.parse(
    readFileSync(join(destination, "package", "package.json"), "utf8")
  );
  for (const hook of lifecycleHooks(packedManifest)) {
    addViolation("packed_lifecycle_hook", `package/package.json:${hook}`);
  }
  scanTree(join(destination, "package"), "package", { excludeMetadata: false });
}

function lifecycleHooks(manifest) {
  const hooks = new Set([
    "preinstall",
    "install",
    "postinstall",
    "prepack",
    "prepare",
    "postpack",
    "prepublish",
    "prepublishOnly",
    "publish",
    "postpublish",
  ]);
  return Object.keys(manifest?.scripts ?? {}).filter((name) => hooks.has(name));
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function locationForRoot(scanRoot) {
  const absolute = resolve(scanRoot);
  const withinRepository = relative(root, absolute);
  if (withinRepository === "") return ".";
  if (!withinRepository.startsWith(`..${sep}`) && withinRepository !== "..") {
    return withinRepository.split(sep).join("/");
  }
  return "explicit-root";
}

function addViolation(category, location) {
  const safeLocation = sanitizeLocation(location);
  const key = `${category}\0${safeLocation}`;
  if (seenLocations.has(key)) return;
  seenLocations.add(key);
  violations.push({ category, location: safeLocation });
}

function sanitizeLocation(location) {
  const value = String(location).replaceAll("\\", "/");
  if (value.startsWith(root.replaceAll("\\", "/"))) {
    return value.slice(root.length).replace(/^\//u, "") || ".";
  }
  return value.startsWith("/") || /^[A-Za-z]:\//u.test(value) ? "external-input" : value;
}

function writeReport() {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        status: violations.length === 0 ? "passed" : "failed",
        scanned: counts,
        violations,
      },
      null,
      2
    )}\n`
  );
}
