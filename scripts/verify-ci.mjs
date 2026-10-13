#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const diagnosticsPath = join(root, ".artifacts", "verify-diagnostics.txt");
const fixtureIndex = process.argv.indexOf("--sanitize-file");
const fixtureMode = fixtureIndex >= 0;
const installMode = process.argv.includes("--install");

if (fixtureMode) {
  const fixture = process.argv[fixtureIndex + 1];
  if (!fixture) fail("--sanitize-file requires a file");
  const sanitized = sanitizeOutput(readFileSync(resolve(fixture), "utf8"));
  if (containsAbsolutePath(sanitized)) fail("unsafe absolute path remained after sanitization");
  process.stdout.write(sanitized);
  process.exit(0);
}

rmSync(diagnosticsPath, { force: true });
const npmArguments = installMode ? ["ci", "--ignore-scripts"] : ["run", "verify"];
const result = spawnSync(process.execPath, [join(root, "scripts", "pinned-npm.mjs"), ...npmArguments], {
  cwd: root,
  encoding: "utf8",
  env: process.env,
  maxBuffer: 64 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
});
if (result.error) fail("verification process could not be captured");

const captured = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const sanitized = sanitizeOutput(captured);
if (containsAbsolutePath(sanitized)) fail("unsafe absolute path remained after sanitization");

mkdirSync(dirname(diagnosticsPath), { recursive: true });
writeFileSync(diagnosticsPath, sanitized || "verification produced no diagnostics\n");
process.stdout.write(sanitized);
process.exit(result.status ?? 1);

function sanitizeOutput(output) {
  let sanitized = output.replaceAll("\r\n", "\n");
  const repositoryRoots = new Set([root, process.env.GITHUB_WORKSPACE].filter(Boolean));
  for (const repositoryRoot of [...repositoryRoots].sort(longestFirst)) {
    sanitized = replaceRoot(sanitized, repositoryRoot);
  }
  const genericRoots = [
    [process.env.RUNNER_WORKSPACE, "<runner-workspace>"],
    [process.env.RUNNER_TEMP, "<runner-temp>"],
    [tmpdir(), "<temporary-directory>"],
    [homedir(), "<home-directory>"],
    [dirname(process.execPath), "<node-directory>"],
  ].filter(([path]) => path);
  for (const [path, replacement] of genericRoots.sort(([left], [right]) => longestFirst(left, right))) {
    sanitized = replaceLiteral(sanitized, path, replacement);
  }
  return sanitized;
}

function replaceRoot(text, path) {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/u, "");
  let result = replaceLiteral(text, `${normalized}/`, "");
  result = replaceLiteral(result, normalized, ".");
  return result;
}

function replaceLiteral(text, value, replacement) {
  const normalizedText = text.replaceAll("\\", "/");
  const normalizedValue = value.replaceAll("\\", "/");
  return normalizedText.split(normalizedValue).join(replacement);
}

function containsAbsolutePath(output) {
  const posixPath = /(?:^|[\s("'`=])\/(?!\/)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._@+-]+)+/mu;
  const windowsPath = /(?:^|[\s("'`=])[A-Za-z]:\/[A-Za-z0-9._ -]+\//mu;
  return posixPath.test(output) || windowsPath.test(output);
}

function longestFirst(left, right) {
  return String(right).length - String(left).length;
}

function fail(message) {
  const diagnostic = `verify diagnostics: ${message}\n`;
  if (!fixtureMode) {
    mkdirSync(dirname(diagnosticsPath), { recursive: true });
    writeFileSync(diagnosticsPath, diagnostic);
  }
  console.error(diagnostic.trimEnd());
  process.exit(1);
}
