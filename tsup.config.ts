import { join } from "node:path";

import { defineConfig } from "tsup";

const packageRoot = import.meta.dirname;

/**
 * ESM shim every bundle of this CLI needs: the dependency graph inlines CommonJS
 * packages, whose `require` calls have no definition in an ES module. Exported so
 * a test that bundles part of the CLI itself produces the same artifact shape.
 */
export const NODE_REQUIRE_BANNER = [
  'import { createRequire as __dvmCreateRequire } from "node:module";',
  "const require = __dvmCreateRequire(import.meta.url);",
].join("\n");

export default defineConfig({
  entry: { dvm: join(packageRoot, "src", "cli", "dvm.ts") },
  outDir: join(packageRoot, "dist"),
  format: "esm",
  target: "node22",
  clean: true,
  noExternal: [/.*/],
  banner: {
    js: ["#!/usr/bin/env node", NODE_REQUIRE_BANNER].join("\n"),
  },
});
