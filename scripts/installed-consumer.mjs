import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { consumerNpmrc } from "./consumer-npmrc.mjs";

// Capture all dependency output: npm diagnostics can include paths and credentials.
export function runConsumer(command, args, { cwd, env = {}, timeout = 120_000, windowsVerbatimArguments = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true, windowsVerbatimArguments, detached: process.platform !== "win32",
    });
    let terminated = false;
    let stdout = "";
    let stderr = "";
    const terminate = () => {
      terminated = true;
      if (!child.pid) return;
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", timeout: 10_000 });
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* Process already exited. */ }
      }
    };
    const timer = setTimeout(terminate, timeout);
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 8 * 1024 * 1024) terminate(); });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > 8 * 1024 * 1024) terminate(); });
    child.on("error", () => { clearTimeout(timer); reject(new Error("consumer process could not start")); });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status: terminated ? null : status, stdout, stderr });
    });
  });
}

export async function consumerNpm(args, cwd, env = {}) {
  // setup-node's npm is beside node on Windows and under ../lib/node_modules on Unix.
  const npmCli = process.env.npm_execpath ?? (process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  const result = await runConsumer(process.execPath, [npmCli, ...args], {
    cwd, env: { ...env, npm_config_engine_strict: "false", npm_config_legacy_peer_deps: "false", npm_config_audit: "false", npm_config_fund: "false", npm_config_ignore_scripts: "true" },
  });
  if (result.status !== 0) throw new Error(`consumer npm ${args[0]} failed (output withheld)`);
  if (/deprecated @cashu\/cashu-ts@/u.test(result.stdout + result.stderr)) {
    throw new Error("consumer install resolved deprecated cashu-ts");
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
  await consumerNpm(["install", "--ignore-scripts", "--install-links", legacyRoot], consumer, env);
  const installedPackage = join(consumer, "node_modules", "@dvmkit", "dvm-cli");
  if (readFileSync(join(installedPackage, "skills", "dvm", "SKILL.md"), "utf8") !== "legacy skill\n") {
    throw new Error("legacy consumer skill was not installed");
  }
  await consumerNpm(["install", "--ignore-scripts", archive], consumer, env);
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
