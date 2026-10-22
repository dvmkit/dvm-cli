import { createHash } from "node:crypto";
import lockfile from "proper-lockfile";
import { DvmError, ensureConfigDir, JOBS_FILE, shellQuoteArg } from "@dvmkit/sdk/internal";

export async function withJobPaymentLock<T>(jobId: string, action: (assertOwned: () => void) => Promise<T>): Promise<T> {
  ensureConfigDir();
  // Hash untrusted job IDs so they cannot choose a path outside caller state.
  const key = createHash("sha256").update(jobId).digest("hex");
  let compromised = false;
  const assertOwned = () => {
    if (compromised) throw new DvmError("payment_settling", "Payment lock ownership was lost.",
      `Retry shortly with \`dvm pay ${shellQuoteArg(jobId)}\`, or keep watching with \`dvm messages ${shellQuoteArg(jobId)} --wait\`.`);
  };
  let release: () => void;
  try {
    release = lockfile.lockSync(`${JOBS_FILE}.payment-${key}`, {
      realpath: false, stale: 120_000, update: 10_000,
      onCompromised: () => { compromised = true; },
    });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ELOCKED") throw error;
    throw new DvmError("payment_settling", "Another dvm process is paying this job.",
      `Retry shortly with \`dvm pay ${shellQuoteArg(jobId)}\`, or keep watching with \`dvm messages ${shellQuoteArg(jobId)} --wait\`. If the lock is stale, it can take up to 2 minutes to clear.`);
  }
  // The heartbeat protects live sends; stale detection recovers a crashed owner.
  try {
    return await action(assertOwned);
  } finally {
    // A compromised lock belongs to another owner; do not release it.
    if (!compromised) release();
  }
}
