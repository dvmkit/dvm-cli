#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cleanSource = process.argv.includes("--clean-source");
const knownArguments = new Set(["--clean-source"]);
const unknown = process.argv.slice(2).filter((argument) => !knownArguments.has(argument));
if (unknown.length > 0) fail(`unknown argument: ${unknown[0]}`);
if (cleanSource && process.env.DVM_CLI_CLEAN_SOURCE !== "1") {
  fail("--clean-source is internal to the isolated clean-install gate");
}

const npmCli =
  process.env.npm_execpath ??
  fail("run the gate through npm so the active npm executable is unambiguous");

const sourceSteps = [
  { name: "lint", args: ["run", "lint"] },
  { name: "build", args: ["run", "build"] },
  { name: "typecheck", args: ["run", "typecheck"] },
  { name: "tests", args: ["test"] },
  { name: "package smoke", args: ["run", "check:package"] },
  {
    name: "packed artifact safety",
    args: [
      "run",
      "check:public-safety",
      "--",
      "--pack-only",
      ...(process.env.DVM_CLI_PACKED_SAFETY_REPORT
        ? ["--report", process.env.DVM_CLI_PACKED_SAFETY_REPORT]
        : []),
    ],
  },
  { name: "release contract", args: ["run", "check:release"] },
];

const outerSteps = [
  { name: "toolchain", args: ["run", "check:toolchain"] },
  {
    name: "repository safety",
    args: ["run", "check:public-safety", "--", "--skip-pack"],
  },
  { name: "clean source gate", args: ["run", "clean-install-smoke"] },
];

const results = runSteps(cleanSource ? sourceSteps : outerSteps);
report(results);
console.log("verify passed: every gate step ran");

function runSteps(steps) {
  const stepResults = [];
  for (const step of steps) {
    console.log(`\n=== ${step.name} ===`);
    const started = Date.now();
    const result = spawnSync(process.execPath, [npmCli, ...step.args], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    if (result.error) fail(`${step.name} could not be started: ${result.error.message}`);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (result.status !== 0) {
      stepResults.push(`${step.name}: FAILED after ${seconds}s`);
      report(stepResults);
      fail(`${step.name} failed`);
    }
    stepResults.push(`${step.name}: ok in ${seconds}s`);
  }
  return stepResults;
}

function report(lines) {
  console.log("\n=== verify summary ===");
  for (const line of lines) console.log(`  ${line}`);
}

function fail(message) {
  console.error(`verify: ${message}`);
  process.exit(1);
}
