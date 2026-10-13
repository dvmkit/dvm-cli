#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runBoundedProcess } from "./bounded-process.mjs";

const defaultRegistry = "https://registry.npmjs.org";
const expectedPackageName = "@dvmkit/dvm-cli";
const defaultAvailabilityTimeoutMs = 30 * 60 * 1_000;
const defaultRetryDelayMs = 15_000;
const defaultRequestTimeoutMs = 30_000;

if (isMainModule()) {
  try {
    await main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

/** Publishes an archive once, or accepts an exact prior registry publication after a disrupted run. */
export async function publishRelease({
  archive,
  distTag,
  fetchFn = fetch,
  publishFn = publishArchive,
  registry = defaultRegistry,
  availabilityTimeoutMs = defaultAvailabilityTimeoutMs,
  retryDelayMs = defaultRetryDelayMs,
  requestTimeoutMs = defaultRequestTimeoutMs,
  waitFn = wait,
  nowFn = Date.now,
  signalFn = timeoutSignal,
}) {
  assertPositiveDuration(availabilityTimeoutMs, "availabilityTimeoutMs");
  assertPositiveDuration(retryDelayMs, "retryDelayMs");
  assertPositiveDuration(requestTimeoutMs, "requestTimeoutMs");
  const deadlineMs = nowFn() + availabilityTimeoutMs;
  const absoluteArchive = resolve(archive);
  const local = archiveIdentity(absoluteArchive);
  assertReleaseIdentity(local, distTag);
  const expected = { ...local, distTag };
  const inspection = { expected, fetchFn, registry, deadlineMs, requestTimeoutMs, nowFn, signalFn };
  const initial = await inspectPublishedRelease(inspection);
  if (initial === "match") {
    process.stdout.write(`npm release already matches ${local.packageName}@${local.packageVersion} (${distTag})\n`);
    return "already-published";
  }
  if (initial === "mismatch") throw new Error("existing npm release does not match the reviewed archive and dist-tag");
  if (initial === "pending-tarball") {
    await waitForPublishedRelease({
      expected,
      fetchFn,
      registry,
      deadlineMs,
      retryDelayMs,
      requestTimeoutMs,
      waitFn,
      nowFn,
      signalFn,
      phase: "existing",
      waitBeforeFirstAttempt: true,
    });
    process.stdout.write(`npm release already matches ${local.packageName}@${local.packageVersion} (${distTag})\n`);
    return "already-published";
  }

  const publishTimeoutMs = deadlineMs - nowFn();
  if (publishTimeoutMs <= 0) throw availabilityDeadlineError();
  const publishResult = await publishFn({
    archive: absoluteArchive,
    distTag,
    timeoutMs: publishTimeoutMs,
  });
  writeProcessOutput(publishResult);
  const publishStatus = publishResultSummary(publishResult);
  await waitForPublishedRelease({
    ...inspection,
    retryDelayMs,
    waitFn,
    phase: "published",
    publishStatus,
  });
  process.stdout.write(`npm release matches ${local.packageName}@${local.packageVersion} (${distTag})\n`);
  return "published";
}

/** Returns whether the exact version is absent, awaiting archive propagation, byte-for-byte matching, or conflicting. */
export async function inspectPublishedRelease({
  expected,
  fetchFn = fetch,
  registry = defaultRegistry,
  deadlineMs = Number.POSITIVE_INFINITY,
  requestTimeoutMs = defaultRequestTimeoutMs,
  nowFn = Date.now,
  signalFn = timeoutSignal,
}) {
  const registryUrl = new URL(registry);
  const packageUrl = new URL(`${encodeURIComponent(expected.packageName)}?release_check=${Date.now()}`, registryUrl);
  const metadataSignal = requestSignal({ deadlineMs, requestTimeoutMs, nowFn, signalFn });
  const metadataResponse = await fetchFn(packageUrl, {
    cache: "no-store",
    headers: {
      accept: "application/vnd.npm.install-v1+json",
      "cache-control": "no-cache",
    },
    redirect: "error",
    signal: metadataSignal,
  });
  assertBeforeDeadline(deadlineMs, nowFn);
  if (metadataResponse.status === 404) return "missing";
  if (!metadataResponse.ok) throw new Error(`npm registry metadata request failed (${metadataResponse.status})`);
  const metadata = await metadataResponse.json();
  assertBeforeDeadline(deadlineMs, nowFn);
  const version = metadata?.versions?.[expected.packageVersion];
  if (!version) return "missing";
  if (
    version.name !== expected.packageName ||
    version.version !== expected.packageVersion ||
    metadata?.["dist-tags"]?.[expected.distTag] !== expected.packageVersion
  ) {
    return "mismatch";
  }
  const tarball = version.dist?.tarball;
  if (typeof tarball !== "string") return "mismatch";
  const tarballUrl = new URL(tarball);
  if (tarballUrl.origin !== registryUrl.origin) return "mismatch";
  const tarballSignal = requestSignal({ deadlineMs, requestTimeoutMs, nowFn, signalFn });
  const tarballResponse = await fetchFn(tarballUrl, {
    cache: "no-store",
    redirect: "error",
    signal: tarballSignal,
  });
  assertBeforeDeadline(deadlineMs, nowFn);
  if (tarballResponse.status === 404) return "pending-tarball";
  if (!tarballResponse.ok) throw new Error(`npm registry tarball request failed (${tarballResponse.status})`);
  const remoteBytes = Buffer.from(await tarballResponse.arrayBuffer());
  assertBeforeDeadline(deadlineMs, nowFn);
  return sha256(remoteBytes) === expected.sha256 ? "match" : "mismatch";
}

async function waitForPublishedRelease({
  expected,
  fetchFn,
  registry,
  deadlineMs,
  retryDelayMs,
  requestTimeoutMs,
  waitFn,
  nowFn,
  signalFn,
  phase,
  publishStatus,
  waitBeforeFirstAttempt = false,
}) {
  let firstAttempt = true;
  while (nowFn() < deadlineMs) {
    if (waitBeforeFirstAttempt || !firstAttempt) {
      const remainingMs = deadlineMs - nowFn();
      if (remainingMs <= 0) break;
      await waitFn(Math.min(retryDelayMs, remainingMs));
      if (nowFn() >= deadlineMs) break;
    }
    firstAttempt = false;
    let observed;
    try {
      observed = await inspectPublishedRelease({
        expected,
        fetchFn,
        registry,
        deadlineMs,
        requestTimeoutMs,
        nowFn,
        signalFn,
      });
    } catch (error) {
      throw inspectionFailure({ phase, publishStatus, error });
    }
    if (observed === "match") return;
    if (observed === "mismatch") {
      throw new Error(`${phase === "existing" ? "existing" : "published"} npm release does not match the reviewed archive and dist-tag`);
    }
  }
  if (phase === "existing") {
    throw new Error(
      "the existing npm release is still processing after the availability window; no publish was attempted. Run the read-only --check command before rerunning the immutable tag"
    );
  }
  throw new Error(
    `npm publish exited ${String(publishStatus)}, but the exact release is still unavailable and may be processing. Do not publish again; run the read-only --check command before rerunning the immutable tag`
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const archive = required(options, "archive");
  const distTag = required(options, "dist-tag");
  if (options.check !== undefined && options.check !== "true") {
    throw new Error("--check must be exactly true for a read-only registry check");
  }
  if (options.check === "true") {
    await checkPublishedRelease({ archive, distTag });
    return;
  }
  await publishRelease({ archive, distTag });
}

/** Read-only exact-byte and dist-tag check for recovery diagnosis. */
export async function checkPublishedRelease({
  archive,
  distTag,
  fetchFn = fetch,
  registry = defaultRegistry,
  requestTimeoutMs = defaultRequestTimeoutMs,
  nowFn = Date.now,
  signalFn = timeoutSignal,
}) {
  const local = archiveIdentity(resolve(archive));
  assertReleaseIdentity(local, distTag);
  const observed = await inspectPublishedRelease({
    expected: { ...local, distTag },
    fetchFn,
    registry,
    requestTimeoutMs,
    nowFn,
    signalFn,
  });
  if (observed === "match") {
    process.stdout.write(
      `npm release already matches ${local.packageName}@${local.packageVersion} (${distTag})\n`
    );
    return "match";
  }
  if (observed === "mismatch") {
    throw new Error("existing npm release does not match the reviewed archive and dist-tag");
  }
  throw new Error(
    observed === "pending-tarball"
      ? "npm metadata matches, but the exact archive is still processing"
      : "the exact npm release is not visible; it may be absent or still processing"
  );
}

function archiveIdentity(archive) {
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" }));
  return {
    packageName: manifest.name,
    packageVersion: manifest.version,
    sha256: sha256(readFileSync(archive)),
  };
}

function assertReleaseIdentity(identity, distTag) {
  if (identity.packageName !== expectedPackageName) throw new Error(`archive package name is not ${expectedPackageName}`);
  if (/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(identity.packageVersion)) {
    if (distTag !== "latest") throw new Error("stable versions must use npm dist-tag latest");
  } else if (/^[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$/u.test(identity.packageVersion)) {
    if (distTag !== "next") throw new Error("release candidates must use npm dist-tag next");
  } else {
    throw new Error("archive version must be stable or an rc");
  }
}

function publishArchive({ archive, distTag, timeoutMs }) {
  const publisher = resolve(import.meta.dirname, "pinned-publish-npm.mjs");
  return runBoundedProcess(
    process.execPath,
    [publisher, "publish", archive, "--tag", distTag],
    timeoutMs
  );
}

function parseArguments(args) {
  const allowed = new Set(["archive", "dist-tag", "check"]);
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`invalid argument: ${key ?? ""}`);
    const name = key.slice(2);
    if (!allowed.has(name)) throw new Error(`unknown option: --${name}`);
    result[name] = value;
  }
  return result;
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function writeProcessOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function publishResultSummary(result) {
  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : result.error.name;
    return `${code}: ${result.error.message} (upload outcome unknown)`;
  }
  return result.status ?? result.signal ?? 1;
}

function requestSignal({ deadlineMs, requestTimeoutMs, nowFn, signalFn }) {
  const remainingMs = deadlineMs - nowFn();
  if (remainingMs <= 0) throw availabilityDeadlineError();
  return signalFn(Math.max(1, Math.min(requestTimeoutMs, remainingMs)));
}

function assertBeforeDeadline(deadlineMs, nowFn) {
  if (nowFn() >= deadlineMs) throw availabilityDeadlineError();
}

function availabilityDeadlineError() {
  return new Error("npm release availability deadline expired during registry I/O");
}

function inspectionFailure({ phase, publishStatus, error }) {
  const detail = error instanceof Error ? error.message : String(error);
  if (phase === "existing") {
    return new Error(
      `Registry inspection failed while an existing release archive was processing: ${detail}. No publish was attempted; run the read-only --check command before rerunning the immutable tag`
    );
  }
  return new Error(
    `Registry inspection failed after npm publish exited ${String(publishStatus)}: ${detail}. The upload may still be processing. Do not publish again; run the read-only --check command before rerunning the immutable tag`
  );
}

function timeoutSignal(milliseconds) {
  return AbortSignal.timeout(milliseconds);
}

function assertPositiveDuration(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
}

function isMainModule() {
  return typeof process.argv[1] === "string" && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

function fail(message) {
  console.error(`release publish: ${message}`);
  process.exitCode = 1;
}
