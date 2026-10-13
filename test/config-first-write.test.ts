import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const firstWriteDir = join(process.env.DVM_CONFIG_DIR!, "first-write");
process.env.DVM_CONFIG_DIR = firstWriteDir;
const { ensureConfig } = await import("../src/lib/identity");

describe("config first write", () => {
  it("leaves the dir owner-only when the config write is the first thing to create it", async () => {
    const dir = firstWriteDir;
    expect(existsSync(dir)).toBe(false);
    await ensureConfig({});
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);
  });
});
