import { spawn } from "node:child_process";

/** Run one owned process group and kill the wrapper plus descendants on timeout. */
export function runBoundedProcess(command, args, timeoutMs) {
  assertPositiveDuration(timeoutMs, "timeoutMs");
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killOwnedProcessGroup(child.pid);
      const error = Object.assign(new Error(`process timed out after ${timeoutMs}ms`), {
        code: "ETIMEDOUT",
      });
      resolvePromise({ status: null, signal: "SIGKILL", stdout, stderr, error });
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolvePromise({ status: null, signal: null, stdout, stderr, error });
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolvePromise({ status, signal, stdout, stderr });
    });
  });
}

function killOwnedProcessGroup(pid) {
  if (typeof pid !== "number") return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function assertPositiveDuration(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
}
