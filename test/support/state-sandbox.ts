import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll } from "vitest";

// SDK paths are resolved at import time, before a suite's beforeAll hooks.
// Every worker must start with disposable state even when a suite mocks reads.
const sandbox = mkdtempSync(join(tmpdir(), "caller-state-test-"));
process.env.DVM_CONFIG_DIR = sandbox;
process.env.DVMKIT_CONFIG_DIR = join(sandbox, "builder");
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

// Check the root without importing SDK modules ahead of suite-specific mocks.
if (!resolve(process.env.DVM_CONFIG_DIR).startsWith(resolve(tmpdir()) + "/")) {
  throw new Error("Caller tests require disposable SDK state");
}
