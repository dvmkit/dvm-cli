import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdirSync, rmSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { JOBS_FILE } from "@dvmkit/sdk/internal";
import lockfile from "proper-lockfile";
import { describe, expect, it, vi } from "vitest";
import { withJobPaymentLock } from "../src/lib/payment-lock";

// A separate process must contend on the same filesystem lock, rather than
// relying on an in-memory mutex that cannot protect concurrent CLI commands.
async function acquireFromChild(file: string) {
  const child = spawn(process.execPath, ["-e", `
    const lockfile = require("proper-lockfile");
    lockfile.lockSync(process.argv[1], { realpath: false, stale: 120000, update: 10000 });
    process.stdout.write("locked\\n");
    process.stdin.resume();
  `, file], { stdio: ["pipe", "pipe", "inherit"] });
  await once(child.stdout, "data");
  return child;
}

describe("per-job payment locks", () => {
  it("blocks another process and recovers a stale lock after its owner crashes", async () => {
    const jobId = "cross-process";
    // Discover the actual lock path without duplicating the job-key algorithm.
    const file = await withJobPaymentLock(jobId, async () => {
      const entry = readdirSync(dirname(JOBS_FILE)).find((name) => name.includes(".payment-") && name.endsWith(".lock"));
      if (!entry) throw new Error("No payment lock found");
      return join(dirname(JOBS_FILE), entry.slice(0, -5));
    });
    const child = await acquireFromChild(file);
    try {
      await expect(withJobPaymentLock(jobId, async () => "duplicate send")).rejects.toMatchObject({ code: "payment_settling" });
      await expect(withJobPaymentLock("another-job", async () => "independent send")).resolves.toBe("independent send");
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      // Advance the abandoned lock's age without a two-minute wall-clock sleep.
      const old = new Date(Date.now() - 120_001);
      utimesSync(`${file}.lock`, old, old);
      await expect(withJobPaymentLock(jobId, async () => "recovered send")).resolves.toBe("recovered send");
      expect(lockfile.checkSync(file, { realpath: false })).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
  it("reports lock loss from the library heartbeat without releasing a successor's lock", async () => {
    const acquire = lockfile.lockSync.bind(lockfile);
    let file!: string;
    vi.spyOn(lockfile, "lockSync").mockImplementation((path, options) => {
      file = String(path);
      return acquire(path, { ...options, update: 1000 });
    });
    let finish!: () => void;
    const held = withJobPaymentLock("compromised-heartbeat", async (assertOwned) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      assertOwned();
    });
    const outcome = expect(held).rejects.toMatchObject({ code: "payment_settling" });
    rmSync(`${file}.lock`, { recursive: true });
    // A different mtime makes the actual heartbeat declare the first owner compromised.
    const releaseSuccessor = acquire(file, { realpath: false, update: 10_000 });
    const different = new Date(Date.now() + 5000);
    utimesSync(`${file}.lock`, different, different);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      finish();
      await outcome;
      expect(lockfile.checkSync(file, { realpath: false })).toBe(true);
    } finally {
      finish();
      releaseSuccessor();
    }
  });

});
