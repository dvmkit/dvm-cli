import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Files outside `src/` whose change also invalidates the bundle. */
const EXTRA_SOURCES = ["package.json", "tsup.config.ts"] as const;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "__snapshots__"]);

/** Cap on directory entries visited, so a pathological tree can't stall `dvm doctor`. */
const MAX_ENTRIES = 20_000;

export interface BuildFreshness {
  /**
   * `"fresh"` — the bundle is at least as new as every source file.
   * `"stale"` — source has changed since the bundle was built.
   * `"not_applicable"` — nothing to compare (running from source, or an
   * installed package with no checkout alongside it).
   */
  status: "fresh" | "stale" | "not_applicable";
  bundlePath: string | null;
  /** ISO timestamp the bundle was written; `null` when not applicable. */
  builtAt: string | null;
  /** Whole days since the bundle was built; `null` when not applicable. */
  buildAgeDays: number | null;
  /** ISO timestamp of the newest source file; `null` when not applicable. */
  newestSourceAt: string | null;
  /** Up to five repo-relative paths newer than the bundle (stale only). */
  newerPaths: string[];
  /** Why the comparison was skipped, for `not_applicable`. */
  skipReason?: "running_from_source" | "no_source_tree";
}

export interface BuildFreshnessOptions {
  /** Directory the running module lives in. Defaults to this file's own directory. */
  moduleDir?: string;
  now?: () => number;
}

/**
 * Compare the running CLI bundle against the source tree it was built from.
 *
 * mtime rather than git state, deliberately: the failure mode is "the tree
 * moved and the bundle didn't", and that covers a pull, a rebase, a branch
 * switch, and uncommitted local edits alike — none of which a commit-count
 * comparison would catch on its own.
 *
 * Returns `not_applicable` rather than guessing when there is nothing to
 * compare: running from `src/` under `tsx`, or from a published package with
 * no checkout beside it.
 */
export function checkBuildFreshness(opts?: BuildFreshnessOptions): BuildFreshness {
  const now = opts?.now ?? Date.now;
  const moduleDir = opts?.moduleDir ?? dirname(fileURLToPath(import.meta.url));
  const root = findPackageRoot(moduleDir);

  const skipped = (skipReason: BuildFreshness["skipReason"]): BuildFreshness => ({
    status: "not_applicable",
    bundlePath: null,
    builtAt: null,
    buildAgeDays: null,
    newestSourceAt: null,
    newerPaths: [],
    skipReason,
  });

  if (root === null) return skipped("running_from_source");

  // The bundle is what's executing only when the module resolved out of
  // `<root>/dist`; under `tsx src/cli/dvm.ts` the same walk finds the same
  // root, but nothing was built.
  const bundlePath = join(root, "dist", "dvm.js");
  if (dirname(moduleDir) !== root || !existsSync(bundlePath)) {
    return skipped("running_from_source");
  }

  const srcDir = join(root, "src");
  if (!existsSync(srcDir)) return skipped("no_source_tree");

  const builtAtMs = statSync(bundlePath).mtimeMs;
  const newer: { path: string; mtimeMs: number }[] = [];
  let newestMs = 0;

  const visit = (dir: string, rel: string, budget: { left: number }): void => {
    if (budget.left <= 0) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (budget.left-- <= 0) return;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(abs, relPath, budget);
        continue;
      }
      if (!entry.isFile()) continue;
      const mtimeMs = statSync(abs).mtimeMs;
      if (mtimeMs > newestMs) newestMs = mtimeMs;
      if (mtimeMs > builtAtMs) newer.push({ path: relPath, mtimeMs });
    }
  };

  const budget = { left: MAX_ENTRIES };
  visit(srcDir, "src", budget);
  for (const name of EXTRA_SOURCES) {
    const abs = join(root, name);
    if (!existsSync(abs)) continue;
    const mtimeMs = statSync(abs).mtimeMs;
    if (mtimeMs > newestMs) newestMs = mtimeMs;
    if (mtimeMs > builtAtMs) newer.push({ path: name, mtimeMs });
  }

  newer.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return {
    status: newer.length > 0 ? "stale" : "fresh",
    bundlePath,
    builtAt: new Date(builtAtMs).toISOString(),
    buildAgeDays: Math.max(0, Math.floor((now() - builtAtMs) / (24 * 60 * 60 * 1000))),
    newestSourceAt: newestMs > 0 ? new Date(newestMs).toISOString() : null,
    newerPaths: newer.slice(0, 5).map((n) => n.path),
  };
}


function findPackageRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
