#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { parse } from "yaml";

import { installConsumer } from "./installed-consumer.mjs";
import { verifyContentRetention } from "./content-retention-smoke.mjs";
import { verifyWalletHistory } from "./wallet-history-smoke.mjs";
import { verifyRefundRecovery } from "./refund-recovery-smoke.mjs";
import { verifyCreditReceiptRecovery } from "./credit-receipt-smoke.mjs";
import { verifyDrawFunding } from "./draw-funding-smoke.mjs";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const temporaryRoot = mkdtempSync(join(tmpdir(), "dvm-cli-package-"));
const skillFiles = ["SKILL.md", "calling.md", "wallets.md", "credit.md", "recovery.md"];

try {
  const packed = pack(root, temporaryRoot);
  const packedManifest = readPackedManifest(join(temporaryRoot, packed.filename));
  assertNoLifecycleHooks(packedManifest);
  assertSupportedEngines(packedManifest);
  const files = packed.files.map((entry) => entry.path).sort();
  const required = [
    "LICENSE",
    "NOTICE",
    "README.md",
    "dist/dvm.js",
    "package.json",
    ...skillFiles.map((file) => `skills/dvm/${file}`),
  ];
  for (const path of required) {
    if (!files.includes(path)) fail(`packed package is missing ${path}`);
  }
  const forbidden = files.filter(
    (path) =>
      path.endsWith(".map") ||
      /(^|\/)(?:src|test|scripts|\.github|coverage|node_modules)(?:\/|$)/u.test(path)
  );
  if (forbidden.length > 0) fail(`packed package contains forbidden paths: ${forbidden.join(", ")}`);

  const builtBinary = join(root, "dist", "dvm.js");
  if (!readFileSync(builtBinary, "utf8").startsWith("#!/usr/bin/env node\n")) {
    fail("dist/dvm.js is missing its executable shebang");
  }

  const { consumer, installedPackage } = await installConsumer({
    archive: join(temporaryRoot, packed.filename), manifest, temporaryRoot,
  });
  assertSingleCashuVersion(consumer, manifest.dependencies["@cashu/cashu-ts"]);
  const exportedSkill = execFileSync(
    process.execPath,
    ["-p", "require.resolve('@dvmkit/dvm-cli/skill')"],
    { cwd: consumer, encoding: "utf8" }
  ).trim();
  const harnessSkill = join(temporaryRoot, "harness", "skills", "dvm");
  cpSync(dirname(exportedSkill), harnessSkill, { recursive: true });
  for (const file of skillFiles) {
    const expected = readFileSync(join(root, "skills", "dvm", file), "utf8");
    if (readFileSync(join(harnessSkill, file), "utf8") !== expected) {
      fail(`package upgrade or harness install did not preserve skill file ${file}`);
    }
  }
  const entry = readFileSync(join(harnessSkill, "SKILL.md"), "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(entry);
  const metadata = frontmatter ? parse(frontmatter[1]) : null;
  if (metadata?.name !== "dvm" || typeof metadata.description !== "string") {
    fail("installed skill has invalid discovery metadata");
  }
  for (const file of skillFiles.slice(1)) {
    if (!entry.includes(`](${file})`)) fail(`installed skill does not route to ${file}`);
  }

  const installedBinary = join(installedPackage, "dist", "dvm.js");
  const version = runNode(installedBinary, ["--version"], consumer).stdout.trim();
  if (version !== manifest.version) {
    fail(`installed dvm reports ${JSON.stringify(version)}, expected ${manifest.version}`);
  }
  const help = runNode(installedBinary, ["--help"], consumer).stdout;
  if (!help.includes("Usage: dvm") || !help.includes("request")) {
    fail("installed dvm help does not expose the caller command tree");
  }
  const binLink = join(consumer, "node_modules", ".bin", "dvm");
  if ((statSync(binLink).mode & 0o111) === 0) fail("installed dvm executable is not executable");

  await verifyWalletHistory(installedPackage, manifest.dependencies["@dvmkit/sdk"]);
  await verifyRefundRecovery(installedPackage, manifest.dependencies["@dvmkit/sdk"]);
  await verifyCreditReceiptRecovery(installedPackage, manifest.dependencies["@dvmkit/sdk"]);
  verifyDrawFunding(installedPackage, manifest.dependencies["@dvmkit/sdk"]);
  await verifyContentRetention(installedPackage, manifest.dependencies["@dvmkit/sdk"]);

  console.log(
    `package ok: ${files.length} files, clean tarball install, upgrade path, bundled skill, dvm ${manifest.version}`
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function pack(packageRoot, destination) {
  return JSON.parse(
    npm(
      ["pack", "--ignore-scripts", "--json", "--pack-destination", destination, packageRoot],
      packageRoot
    )
  )[0];
}

function readPackedManifest(archive) {
  return JSON.parse(
    execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" })
  );
}

function assertNoLifecycleHooks(packedManifest) {
  const lifecycle = new Set([
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
  const found = Object.keys(packedManifest.scripts ?? {}).filter((name) => lifecycle.has(name));
  if (found.length > 0) fail(`packed manifest contains lifecycle hooks: ${found.join(", ")}`);
}

function assertSupportedEngines(packedManifest) {
  const engines = packedManifest.engines;
  if (
    !engines ||
    typeof engines !== "object" ||
    Array.isArray(engines) ||
    engines.node !== ">=22" ||
    Object.keys(engines).length !== 1
  ) {
    fail("packed manifest engines must support Node >=22 without restricting npm");
  }
}

function npm(args, cwd = root) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) fail("npm executable is unavailable");
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
  });
  if (result.status !== 0) fail(`npm ${args[0]} failed: ${result.stderr || result.stdout}`);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/deprecated @cashu\/cashu-ts@/u.test(output)) {
    fail(`clean install emitted a deprecated cashu-ts warning: ${output.trim()}`);
  }
  return result.stdout;
}

function assertSingleCashuVersion(consumer, expectedVersion) {
  if (typeof expectedVersion !== "string") fail("packed manifest must depend on cashu-ts");
  const tree = JSON.parse(
    npm(["ls", "@cashu/cashu-ts", "--all", "--json", "--prefix", consumer])
  );
  const versions = new Set();
  collectCashuVersions(tree, versions);
  if (versions.size !== 1 || !versions.has(expectedVersion)) {
    fail(
      `clean install must resolve only @cashu/cashu-ts@${expectedVersion}, found ${[
        ...versions,
      ].join(", ")}`
    );
  }
}

function collectCashuVersions(node, versions) {
  for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
    if (name === "@cashu/cashu-ts" && typeof dependency.version === "string") {
      versions.add(dependency.version);
    }
    collectCashuVersions(dependency, versions);
  }
}

function runNode(binary, args, cwd) {
  const result = spawnSync(process.execPath, [binary, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, DVM_CONFIG_DIR: join(cwd, "config"), LANG: "C", LC_ALL: "C" },
  });
  if (result.status !== 0) {
    fail(`installed dvm failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function fail(message) {
  console.error(`package: ${message}`);
  process.exit(1);
}
