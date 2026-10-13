import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CALLER_VERSION: string = readCallerVersion();

function readCallerVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifestPath = join(dir, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = readManifest(manifestPath);
      if (manifest.name === "@dvmkit/dvm-cli") return manifest.version;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`No @dvmkit/dvm-cli package.json found walking up from ${import.meta.url}`);
    }
    dir = parent;
  }
}

function readManifest(path: string): { name?: string; version: string } {
  return JSON.parse(readFileSync(path, "utf8")) as { name?: string; version: string };
}
