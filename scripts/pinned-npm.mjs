#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const expectedNode = readFileSync(join(root, ".nvmrc"), "utf8").trim();
const expectedNpm = exactNpmVersion(manifest.packageManager);
const toolRoot = join(root, ".tooling", "npm");
const archive = join(root, ".tooling", `npm-${expectedNpm}.tgz`);
const npmCli = join(toolRoot, "package", "bin", "npm-cli.js");
const shimRoot = join(root, ".tooling", "bin");
const npmTarball = "https://registry.npmjs.org/npm/-/npm-10.9.3.tgz";
const npmIntegrity =
  "sha512-6Eh1u5Q+kIVXeA8e7l2c/HpnFFcwrkt37xDMujD5be1gloWa9p6j3Fsv3mByXXmqJHy+2cElRMML8opNT7xIJQ==";

if (process.versions.node !== expectedNode) {
  fail(`Node ${expectedNode} is required; found ${process.versions.node}`);
}
if (process.argv.length < 3) fail("pass an npm command, for example: ci");

await installPinnedNpm();
installNpmShim();
const installedVersion = execFileSync(process.execPath, [npmCli, "--version"], {
  encoding: "utf8",
}).trim();
if (installedVersion !== expectedNpm) {
  fail(`expected npm ${expectedNpm}; installed bootstrap reports ${installedVersion}`);
}

execFileSync(process.execPath, [npmCli, ...process.argv.slice(2)], {
  cwd: root,
  env: {
    ...process.env,
    PATH: `${shimRoot}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
  },
  stdio: "inherit",
});

async function installPinnedNpm() {
  mkdirSync(join(root, ".tooling"), { recursive: true });
  let bytes = existsSync(archive) ? readFileSync(archive) : undefined;
  if (!bytes || archiveIntegrity(bytes) !== npmIntegrity) {
    const response = await fetch(npmTarball, { redirect: "error" });
    if (!response.ok) fail(`could not download pinned npm (${response.status})`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (archiveIntegrity(bytes) !== npmIntegrity) {
      fail("downloaded npm archive failed integrity verification");
    }
    writeFileSync(archive, bytes);
  }
  rmSync(toolRoot, { recursive: true, force: true });
  mkdirSync(toolRoot, { recursive: true });
  execFileSync("tar", ["-xzf", "-", "-C", toolRoot], {
    input: bytes,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function archiveIntegrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function installNpmShim() {
  mkdirSync(shimRoot, { recursive: true });
  const shim = join(shimRoot, "npm");
  writeFileSync(
    shim,
    `#!/usr/bin/env node\nimport { spawnSync } from "node:child_process";\nconst result = spawnSync(process.execPath, [${JSON.stringify(
      npmCli
    )}, ...process.argv.slice(2)], { env: process.env, stdio: "inherit" });\nif (result.error) throw result.error;\nprocess.exit(result.status ?? 1);\n`
  );
  chmodSync(shim, 0o755);
}

function exactNpmVersion(packageManager) {
  const match = /^npm@([0-9]+\.[0-9]+\.[0-9]+)$/u.exec(packageManager);
  if (!match) fail("packageManager must pin an exact npm release");
  return match[1];
}

function fail(message) {
  console.error(`pinned npm: ${message}`);
  process.exit(1);
}
