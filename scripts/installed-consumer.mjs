import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { consumerNpmrc } from "./consumer-npmrc.mjs";

// Capture all dependency output: npm diagnostics can include paths and credentials.
export function runConsumer(command, args, { cwd, env = {}, timeout = 120_000, windowsVerbatimArguments = false } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true, windowsVerbatimArguments, detached: process.platform !== "win32",
    });
    let termination;
    let exitStatus = null;
    let exitSignal = null;
    let exitBeforeTimeout = false;
    let exited = false;
    let stdout = "";
    let stderr = "";
    const terminate = (reason) => {
      if (termination) return;
      termination = reason;
      exitBeforeTimeout = exited;
      if (!child.pid) return;
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", timeout: 10_000 });
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* Process already exited. */ }
      }
    };
    const timer = setTimeout(() => terminate("timeout"), timeout);
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 8 * 1024 * 1024) terminate("output-limit"); });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > 8 * 1024 * 1024) terminate("output-limit"); });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ status: null, termination: "spawn-error", exitStatus, exitSignal, exitBeforeTimeout, elapsedMs: Date.now() - started, stdout, stderr });
    });
    child.on("exit", (status, signal) => {
      exited = true;
      exitStatus = status;
      exitSignal = signal;
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status: termination ? null : status, termination: termination ?? (status === 0 ? undefined : "nonzero-exit"), exitStatus, exitSignal, exitBeforeTimeout: termination ? exitBeforeTimeout : exited, elapsedMs: Date.now() - started, stdout, stderr });
    });
  });
}

const operations = new Set(["legacy-install", "archive-upgrade", "legacy-skill-check", "installed-metadata-check"]);
function operationLabel(operation) { return operations.has(operation) ? operation : "npm"; }
function startOperation(operation) {
  const label = operationLabel(operation);
  if (label !== "npm") console.log(`consumer operation start: ${label}`);
}

function npmCategory(output) {
  if (/\b(?:ERESOLVE|EOVERRIDE|ETARGET|EPEERINVALID)\b/u.test(output)) return "dependency-resolution";
  if (/\b(?:EAI_AGAIN|ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|E401|E403|E404|E429|E5[0-9]{2})\b/u.test(output)) return "registry-network";
  if (/\b(?:EACCES|EPERM|ENOENT|ENOSPC|EBUSY|ENOTEMPTY)\b/u.test(output)) return "filesystem-access";
  return "unknown";
}

export class ConsumerProcessError extends Error {
  constructor(operation, result) {
    const reason = ["timeout", "output-limit", "spawn-error", "nonzero-exit", "assertion"].includes(result.termination)
      ? result.termination : "assertion";
    const exit = Number.isInteger(result.exitStatus) ? result.exitStatus : "none";
    const signal = /^SIG[A-Z0-9]{1,12}$/u.test(result.exitSignal ?? "") ? result.exitSignal : "none";
    const elapsed = Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0 ? Math.round(result.elapsedMs) : 0;
    const category = npmCategory(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    super(`${operationLabel(operation)}: reason=${reason}, elapsed_ms=${elapsed}, exit=${exit}, signal=${signal}, exit_before_timeout=${result.exitBeforeTimeout === true}, npm_category=${category}`);
  }
}

export function checkConsumer(operation, check) {
  startOperation(operation);
  const started = Date.now();
  try { return check(); } catch {
    throw new ConsumerProcessError(operation, { termination: "assertion", elapsedMs: Date.now() - started });
  }
}

export async function consumerNpm(args, cwd, env = {}, phase = "npm") {
  // setup-node's npm is beside node on Windows and under ../lib/node_modules on Unix.
  const npmCli = process.env.npm_execpath ?? (process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  startOperation(phase);
  const result = await runConsumer(process.execPath, [npmCli, ...args], {
    cwd, env: { ...env, npm_config_engine_strict: "false", npm_config_legacy_peer_deps: "false", npm_config_audit: "false", npm_config_fund: "false", npm_config_ignore_scripts: "true" },
  });
  if (result.status !== 0) throw new ConsumerProcessError(phase, result);
  if (/deprecated @cashu\/cashu-ts@/u.test(result.stdout + result.stderr)) {
    throw new ConsumerProcessError(phase, { ...result, termination: "assertion" });
  }
  return result.stdout;
}

export async function installConsumer({ archive, manifest, temporaryRoot }) {
  const consumer = join(temporaryRoot, "consumer with spaces");
  const legacyRoot = join(temporaryRoot, "legacy");
  mkdirSync(join(legacyRoot, "dist"), { recursive: true });
  mkdirSync(join(legacyRoot, "skills", "dvm"), { recursive: true });
  writeFileSync(join(legacyRoot, "package.json"), JSON.stringify({
    name: manifest.name, version: "0.0.0", type: "module", bin: { dvm: "dist/dvm.js" },
  }));
  writeFileSync(join(legacyRoot, "dist", "dvm.js"), "#!/usr/bin/env node\nconsole.log('0.0.0');\n");
  chmodSync(join(legacyRoot, "dist", "dvm.js"), 0o755);
  writeFileSync(join(legacyRoot, "skills", "dvm", "SKILL.md"), "legacy skill\n");
  mkdirSync(consumer, { recursive: true });
  // Consumer npm gets no contributor peer/engine settings or workstation registry map.
  const npmrc = join(temporaryRoot, "consumer.npmrc");
  writeFileSync(npmrc, "registry=https://registry.npmjs.org/\n" + consumerNpmrc(readFileSync(new URL("../.npmrc", import.meta.url), "utf8")));
  const env = { npm_config_userconfig: npmrc, npm_config_globalconfig: join(temporaryRoot, "empty.npmrc") };
  writeFileSync(env.npm_config_globalconfig, "");
  // A directory install uses a symlink unless install-links is enabled.
  await consumerNpm(["install", "--ignore-scripts", "--install-links", legacyRoot], consumer, env, "legacy-install");
  const installedPackage = join(consumer, "node_modules", "@dvmkit", "dvm-cli");
  checkConsumer("legacy-skill-check", () => {
    if (readFileSync(join(installedPackage, "skills", "dvm", "SKILL.md"), "utf8") !== "legacy skill\n") {
      throw new Error("legacy consumer skill was not installed");
    }
  });
  await consumerNpm(["install", "--ignore-scripts", archive], consumer, env, "archive-upgrade");
  return { consumer, installedPackage };
}

export function runLauncher(consumer, args, env = {}) {
  const bin = join(consumer, "node_modules", ".bin");
  const options = { cwd: consumer, env: { ...env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` } };
  if (process.platform === "win32") {
    // cmd.exe is required for npm's real .cmd launcher. Arguments are harness-owned.
    if ([bin, ...args].some((value) => /["%\r\n&|<>^]/u.test(value))) throw new Error("unsafe launcher argument");
    const line = `""${join(bin, "dvm.cmd")}" ${args.map((arg) => `"${arg}"`).join(" ")}"`;
    return runConsumer(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/v:off", "/c", line], { ...options, windowsVerbatimArguments: true });
  }
  return runConsumer(join(bin, "dvm"), args, options);
}
