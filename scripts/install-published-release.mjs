#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runBoundedProcess } from "./bounded-process.mjs";

export { runBoundedProcess } from "./bounded-process.mjs";

const expectedPackageName = "@dvmkit/dvm-cli";
const defaultAvailabilityTimeoutMs = 30 * 60 * 1_000;
const defaultRetryDelayMs = 10_000;
const defaultInstallTimeoutMs = 2 * 60 * 1_000;

if (isMainModule()) {
  try {
    await main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

/** Installs one exact release, retrying only npm's exact-version propagation errors. */
export async function installPublishedRelease({
  version,
  prefix,
  availabilityTimeoutMs = defaultAvailabilityTimeoutMs,
  retryDelayMs = defaultRetryDelayMs,
  installTimeoutMs = defaultInstallTimeoutMs,
  runFn = runPinnedInstall,
  waitFn = wait,
  nowFn = Date.now,
  outputFn = writeProcessOutput,
}) {
  assertReleaseVersion(version);
  if (typeof prefix !== "string" || prefix.length === 0) throw new Error("--prefix is required");
  assertPositiveDuration(availabilityTimeoutMs, "availabilityTimeoutMs");
  assertPositiveDuration(retryDelayMs, "retryDelayMs");
  assertPositiveDuration(installTimeoutMs, "installTimeoutMs");

  const target = `${expectedPackageName}@${version}`;
  const deadlineMs = nowFn() + availabilityTimeoutMs;
  for (;;) {
    const remainingMs = deadlineMs - nowFn();
    if (remainingMs <= 0) throw installDeadlineError(target);
    const result = await runFn({
      prefix,
      target,
      timeoutMs: Math.max(1, Math.min(installTimeoutMs, remainingMs)),
    });
    outputFn(result);
    if (result.error) throw result.error;
    const afterRunMs = deadlineMs - nowFn();
    if (afterRunMs <= 0) throw installDeadlineError(target);
    if (result.status === 0) return;
    if (!isExactPropagationError(result, target)) {
      throw new Error(`npm could not install ${target} (exit ${String(result.status ?? 1)})`);
    }
    await waitFn(Math.min(retryDelayMs, afterRunMs));
    if (nowFn() >= deadlineMs) throw installDeadlineError(target);
  }
}

function runPinnedInstall({ prefix, target, timeoutMs }) {
  const publisher = resolve(import.meta.dirname, "pinned-publish-npm.mjs");
  return runBoundedProcess(
    process.execPath,
    [publisher, "install", "--ignore-scripts", "--prefix", prefix, target],
    timeoutMs
  );
}

function isExactPropagationError(result, target) {
  const lines = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .split("\n")
    .filter((line) => /^(?:npm ERR!|npm error) /u.test(line));
  const codes = lines.flatMap((line) => [...line.matchAll(/^(?:npm ERR!|npm error) code (\S+)/gu)].map((match) => match[1]));
  if (codes.length !== 1 || (codes[0] !== "ETARGET" && codes[0] !== "E404")) return false;
  if (codes[0] === "ETARGET") {
    const exactTarget = new RegExp(`No matching version found for ${escapeRegExp(target)}(?:\\.$|$)`, "u");
    return lines.some((line) => exactTarget.test(line));
  }
  return isExactE404Detail(lines, target);
}

function isExactE404Detail(lines, target) {
  const urls = lines.flatMap((line) => [...line.matchAll(/https:\/\/[^\s]+/gu)].map((match) => match[0]));
  return urls.length > 0 && urls.every((url) => isExactRegistryUrl(url, target));
}

function isExactRegistryUrl(url, target) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== "https://registry.npmjs.org") return false;
    const path = decodeURIComponent(parsed.pathname);
    const versionIndex = target.lastIndexOf("@");
    const packageName = target.slice(0, versionIndex);
    const version = target.slice(versionIndex + 1);
    const tarballName = packageName.split("/").at(-1);
    return path === `/${packageName}/${version}` || path === `/${packageName}/-/${tarballName}-${version}.tgz`;
  } catch {
    return false;
  }
}

function writeProcessOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function assertReleaseVersion(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u.test(version)) {
    throw new Error("--version must be a stable or release-candidate semver version");
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await installPublishedRelease({ version: required(options, "version"), prefix: required(options, "prefix") });
}

function parseArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`invalid argument: ${key ?? ""}`);
    result[key.slice(2)] = value;
  }
  return result;
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function installDeadlineError(target) {
  return new Error(
    `npm could not install ${target} before the exact-version availability deadline`
  );
}

function assertPositiveDuration(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
}

function isMainModule() {
  return typeof process.argv[1] === "string" && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

function fail(message) {
  console.error(`release consumer install: ${message}`);
  process.exitCode = 1;
}
