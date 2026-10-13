#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "dvm-cli-clean-install-"));
let failure;

try {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 }
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (!files.includes("package-lock.json")) {
    throw new Error("package-lock.json is not committed, so a clean install cannot be reproduced");
  }

  for (const relative of files) {
    const source = join(root, relative);
    if (lstatSync(source).isSymbolicLink()) throw new Error(`refusing source symlink ${relative}`);
    const destination = join(temporaryRoot, relative);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
  }

  const installStarted = Date.now();
  npm(["ci", "--ignore-scripts"], temporaryRoot, process.env);
  console.log(`clean install: locked dependencies installed in ${secondsSince(installStarted)}s`);

  npm(["run", "verify", "--", "--clean-source"], temporaryRoot, {
    ...process.env,
    DVM_CLI_CLEAN_SOURCE: "1",
    DVM_CLI_PACKED_SAFETY_REPORT: join(
      root,
      ".artifacts",
      "public-safety-packed-report.json"
    ),
  });
  publishVerifiedDist(temporaryRoot);
  console.log(
    `clean install ok: ${files.length} repository files, locked install, complete source gate, packed-package checks, verified dist published`
  );
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
if (failure) fail(failure);

function publishVerifiedDist(sourceRoot) {
  const source = join(sourceRoot, "dist");
  if (!lstatSync(source).isDirectory()) throw new Error("the clean build did not produce a dist directory");

  const artifacts = join(root, ".artifacts");
  const staged = join(artifacts, `verified-dist-${process.pid}`);
  const destination = join(root, "dist");
  mkdirSync(artifacts, { recursive: true });
  rmSync(staged, { recursive: true, force: true });
  try {
    cpSync(source, staged, { recursive: true });
    rmSync(destination, { recursive: true, force: true });
    renameSync(staged, destination);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

function npm(args, cwd, env) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("run this check through npm so the active npm executable is unambiguous");
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...env, npm_config_audit: "false", npm_config_fund: "false" },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(sanitizeOutput(result.stdout ?? "", cwd));
  process.stderr.write(sanitizeOutput(result.stderr ?? "", cwd));
  if (result.error) throw new Error(`npm ${args.join(" ")} could not be started: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} failed`);
}

function sanitizeOutput(output, cleanRoot) {
  let sanitized = output;
  const roots = [...new Set([cleanRoot, realpathSync(cleanRoot)])].sort(
    (left, right) => right.length - left.length
  );
  for (const path of roots) {
    sanitized = sanitized.replaceAll(path, "<clean-source>");
  }
  return sanitized;
}

function secondsSince(started) {
  return ((Date.now() - started) / 1000).toFixed(1);
}

function fail(message) {
  console.error(`clean install: ${message}`);
  process.exit(1);
}
