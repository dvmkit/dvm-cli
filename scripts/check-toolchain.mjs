#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const expectedNode = readFileSync(resolve(root, ".nvmrc"), "utf8").trim();
const expectedNpm = exactNpmVersion(manifest.packageManager);
const actualNode = process.versions.node;
const npmCli = process.env.npm_execpath;

if (!npmCli) fail("run this check through npm so the active npm executable is unambiguous");
const actualNpm = execFileSync(process.execPath, [npmCli, "--version"], {
  encoding: "utf8",
}).trim();

if (actualNode !== expectedNode) fail(`Node ${expectedNode} is required; found ${actualNode}`);
if (actualNpm !== expectedNpm) fail(`npm ${expectedNpm} is required; found ${actualNpm}`);

console.log(`toolchain ok: Node ${actualNode}, npm ${actualNpm}`);

function exactNpmVersion(packageManager) {
  const match = /^npm@([0-9]+\.[0-9]+\.[0-9]+)$/u.exec(packageManager);
  if (!match) fail("packageManager must pin an exact npm release");
  return match[1];
}

function fail(message) {
  console.error(`toolchain: ${message}`);
  process.exit(1);
}
