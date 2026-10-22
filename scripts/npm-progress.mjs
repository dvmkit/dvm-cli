const lineLimit = 4096;
const completedTimers = new Map([
  ["idealTree", "resolution-complete"],
  ["reify:loadTrees", "tree-load-complete"],
  ["reify:retireShallow", "retire-complete"],
  ["reify:createSparse", "sparse-tree-complete"],
  ["reify:unpack", "unpack-complete"],
  ["build:link", "link-complete"],
  ["reify:build", "build-complete"],
  ["reify:trash", "cleanup-complete"],
  ["reify:save", "save-complete"],
]);

function eventFor(line) {
  if (/^npm silly fetch manifest /u.test(line)) return "manifest-observed";
  if (/^npm silly placeDep /u.test(line)) return "dependency-placement-observed";
  if (/^npm http fetch /u.test(line)) return "registry-fetch-observed";
  if (/^npm silly tarball /u.test(line)) return "tarball-observed";
  if (/^npm silly reify /u.test(line)) return "reify-observed";
  const timer = /^npm timing ([^\s]+) Completed in [0-9]+ms$/u.exec(line);
  if (timer) {
    if (timer[1].startsWith("reifyNode:")) return "node-reify-complete";
    return completedTimers.get(timer[1]) ?? "unknown";
  }
  return "unknown";
}

// Only fixed event labels and numbers leave this bounded stderr accumulator.
export function createNpmProgress() {
  const summary = { total_lines: 0, counts: {}, last_event: "unknown", last_event_ms: null, last_output_ms: null, truncated: false };
  let pending = "";
  let dropping = false;
  function record(line, elapsedMs) {
    const event = line === null ? "unknown" : eventFor(line);
    summary.total_lines++;
    summary.counts[event] = (summary.counts[event] ?? 0) + 1;
    if (event !== "unknown") {
      summary.last_event = event;
      summary.last_event_ms = elapsedMs;
    }
  }
  return {
    push(chunk, elapsedMs) {
      const text = String(chunk);
      if (!text) return;
      summary.last_output_ms = Math.max(0, Math.round(elapsedMs));
      const parts = text.split("\n");
      for (let index = 0; index < parts.length; index++) {
        if (!dropping && pending.length + parts[index].length <= lineLimit) pending += parts[index];
        else { pending = ""; dropping = true; summary.truncated = true; }
        if (index < parts.length - 1) {
          record(dropping ? null : pending.replace(/\r$/u, ""), summary.last_output_ms);
          pending = "";
          dropping = false;
        }
      }
    },
    finish() {
      if (pending || dropping) record(dropping ? null : pending, summary.last_output_ms);
      pending = "";
      dropping = false;
      return summary;
    },
  };
}
