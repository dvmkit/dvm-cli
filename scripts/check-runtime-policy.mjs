import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

try {
  const root = resolve(import.meta.dirname, "..");
  const workflow = parse(readFileSync(process.argv[2] ?? resolve(root, ".github/workflows/verify.yml"), "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.equal(manifest.engines.node, ">=22");
  assert.deepEqual(workflow.jobs.runtime.strategy.matrix, {
    os: ["ubuntu-latest", "macos-latest", "windows-latest"],
    node: ["22.0.0", "22.x", "24.x", "26.x"],
  });
  assert.equal(workflow.jobs.runtime.strategy["fail-fast"], false);
  assert.equal(workflow.jobs.runtime.needs, "build");
  assert.deepEqual(workflow.jobs.verify.needs, ["build", "runtime"]);
  assert.equal(workflow.jobs.verify.name, "verify");
  const trusted = "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository";
  assert.equal(workflow.jobs.build.if, trusted);
  assert.equal(workflow.jobs.runtime.if, trusted);
  assert.equal(workflow.jobs.verify.if, `always() && (${trusted})`);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
  assert.deepEqual(workflow.on.push.branches, ["master"]);
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(!job["continue-on-error"]);
    assert.ok(!job.permissions);
    for (const step of job.steps ?? []) {
      assert.ok(!step["continue-on-error"]);
      if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/u);
      if (step.uses?.startsWith("actions/checkout@")) assert.equal(step.with["persist-credentials"], false);
    }
  }
  const runtimeRuns = workflow.jobs.runtime.steps.filter((step) => step.run).map((step) => step.run);
  assert.deepEqual(runtimeRuns, ["node scripts/runtime-smoke.mjs .artifacts/runtime"]);
  const buildRuns = workflow.jobs.build.steps.map((step) => step.run);
  const verifyIndex = buildRuns.indexOf("node scripts/verify-ci.mjs");
  const packIndex = buildRuns.indexOf("node scripts/pinned-npm.mjs run artifact:runtime");
  assert.ok(verifyIndex >= 0 && packIndex >= 0);
  assert.ok(verifyIndex < packIndex);
  const uploads = workflow.jobs.build.steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@") && step.with.name === "caller-runtime");
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].with["retention-days"], 1);
  assert.equal(uploads[0].with["if-no-files-found"], "error");
  assert.equal(uploads[0].if, undefined);
  const gate = workflow.jobs.verify.steps[0];
  assert.equal(gate.env.BUILD_RESULT, "${{ needs.build.result }}");
  assert.equal(gate.env.RUNTIME_RESULT, "${{ needs.runtime.result }}");
  assert.equal(gate.run, `node -e "if (process.env.BUILD_RESULT !== 'success' || process.env.RUNTIME_RESULT !== 'success') process.exit(1)"`);
  console.log("runtime policy: minimum, maintained majors, trusted build, complete matrix, and fail-closed aggregate ok");
} catch {
  console.error("runtime policy: incompatible workflow or engine declaration");
  process.exitCode = 1;
}
