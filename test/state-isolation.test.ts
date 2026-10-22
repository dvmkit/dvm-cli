import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, it } from "vitest";

// Allow the child's 20-second cap plus five seconds for termination and reporting.
it.each(["absent", "default"] as const)("ordinary npm test isolates inherited %s state roots before SDK evaluation", (environment) => {
  const env = { ...process.env };
  if (environment === "absent") {
    delete env.DVM_CONFIG_DIR;
    delete env.DVMKIT_CONFIG_DIR;
  } else {
    env.DVM_CONFIG_DIR = join(homedir(), ".dvm");
    env.DVMKIT_CONFIG_DIR = join(homedir(), ".dvmkit");
  }
  env.FORCE_COLOR = "1";
  const npmCli = env.npm_execpath;
  if (!npmCli) throw new Error("Run the startup isolation contract through npm");
  const result = execFileSync(process.execPath, [npmCli, "test", "--", "test/support/state-paths.probe.test.ts"], {
    cwd: resolve(import.meta.dirname, ".."), env, encoding: "utf8", timeout: 20_000,
  });
  expect(stripVTControlCharacters(result)).toMatch(/Tests\s+2 passed/);
}, 25_000);
