import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const helper = pathToFileURL(join(resolve(import.meta.dirname, ".."), "scripts/npm-progress.mjs")).href;
function summarize(chunks: Array<[string, number]>) {
  const outcome = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createNpmProgress } from ${JSON.stringify(helper)};
    const progress = createNpmProgress();
    for (const [chunk, elapsedMs] of ${JSON.stringify(chunks)}) progress.push(chunk, elapsedMs);
    console.log(JSON.stringify(progress.finish()));
  `], { encoding: "utf8" });
  expect(outcome.status).toBe(0);
  expect(outcome.stderr).toBe("");
  expect(outcome.stdout).not.toContain("do-not-print-progress-content");
  expect(outcome.stdout).not.toContain(helper);
  return JSON.parse(outcome.stdout);
}

it("counts split native stderr events without exposing specs, URLs, names, or unknown output", () => {
  expect(summarize([
    ["npm silly fetch mani", 1],
    [`fest do-not-print-progress-content ${helper}\n`, 3],
    ["npm silly placeDep ROOT do-not-print-progress-content\nnpm http fetch GET 200 https://do-not-print-progress-content.invalid/\n", 7],
    ["npm silly tarball no local data for do-not-print-progress-content\nnpm silly reify moves do-not-print-progress-content\n", 8],
    ["npm timing reifyNode:node_modules/do-not-print-progress-content Completed in 2ms\n", 9],
    ["unrecognized do-not-print-progress-content", 12],
  ])).toEqual({
    total_lines: 7,
    counts: { "manifest-observed": 1, "dependency-placement-observed": 1, "registry-fetch-observed": 1, "tarball-observed": 1, "reify-observed": 1, "node-reify-complete": 1, unknown: 1 },
    last_event: "node-reify-complete", last_event_ms: 9, last_output_ms: 12, truncated: false,
  });
});

it.each([
  ["idealTree", "resolution-complete"],
  ["reify:loadTrees", "tree-load-complete"],
  ["reify:retireShallow", "retire-complete"],
  ["reify:createSparse", "sparse-tree-complete"],
  ["reify:unpack", "unpack-complete"],
  ["build:link", "link-complete"],
  ["reify:build", "build-complete"],
  ["reify:trash", "cleanup-complete"],
  ["reify:save", "save-complete"],
])("labels completed npm timer %s without claiming an active phase", (timer, label) => {
  expect(summarize([[`npm timing ${timer} Completed in 23ms\r\n`, 30]])).toEqual({
    total_lines: 1, counts: { [label]: 1 }, last_event: label, last_event_ms: 30, last_output_ms: 30, truncated: false,
  });
});

it("leaves changed or unrecognized timer formats unknown", () => {
  expect(summarize([["npm timing reify:unpack Started\nnpm timing new-phase Completed in 2ms\n", 20]])).toEqual({
    total_lines: 2, counts: { unknown: 2 }, last_event: "unknown", last_event_ms: null, last_output_ms: 20, truncated: false,
  });
});

it("drops overlong lines instead of classifying a valid-looking suffix", () => {
  const oversized = "do-not-print-progress-content".repeat(200) + "npm timing reify:unpack Completed in 2ms\n";
  expect(summarize([[oversized, 10], ["npm timing idealTree Completed in 3ms\n", 15]])).toEqual({
    total_lines: 2, counts: { unknown: 1, "resolution-complete": 1 }, last_event: "resolution-complete", last_event_ms: 15, last_output_ms: 15, truncated: true,
  });
});
