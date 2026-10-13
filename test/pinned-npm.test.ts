import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pinned npm bootstrap", () => {
  it("recreates a version-spoofed cached CLI from the integrity-verified archive", () => {
    const activeNpmCli = process.env.npm_execpath;
    if (!activeNpmCli) throw new Error("test must run through the pinned npm bootstrap");
    const activeTooling = resolve(dirname(activeNpmCli), "../../..");
    const archiveName = "npm-10.9.3.tgz";
    const sourceArchive = join(activeTooling, archiveName);

    const root = mkdtempSync(join(tmpdir(), "dvm-cli-pinned-npm-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, ".tooling", "npm", "package", "bin"), { recursive: true });
    copyFileSync(join(repositoryRoot, "scripts", "pinned-npm.mjs"), join(root, "scripts", "pinned-npm.mjs"));
    copyFileSync(sourceArchive, join(root, ".tooling", archiveName));
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({
        packageManager: "npm@10.9.3",
        engines: { node: ">=22" },
      })}\n`
    );
    writeFileSync(join(root, ".nvmrc"), `${process.versions.node}\n`);
    const cachedCli = join(root, ".tooling", "npm", "package", "bin", "npm-cli.js");
    const poisonMarker = "version spoof survived";
    writeFileSync(cachedCli, `console.log('10.9.3'); // ${poisonMarker}\n`);

    const result = spawnSync(process.execPath, [join(root, "scripts", "pinned-npm.mjs"), "--version"], {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("10.9.3");
    expect(readFileSync(cachedCli, "utf8")).not.toContain(poisonMarker);
  });
});
