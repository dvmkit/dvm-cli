import type {
  JobRecord,
} from "./job-store";

/**
 * Local interaction history with a single provider, derived from this client's job store.
 * This is NOT network reputation — it reflects only this client's experience.
 */
export interface LocalProviderHistory {
  endpoint: string;
  totalJobs: number;
  /** Fraction of jobs that completed successfully (0-1) */
  successRate: number;
  avgLatencyMs: number;
  /** Unix timestamp (ms) of the most recent job */
  lastUsed: number;
  totalPaidMsats: number;
  avgCostMsats: number;
  /** Fraction of paid jobs that completed successfully (0-1) */
  paymentSuccessRate: number;
  cashuPayments: number;
}

/** Compute local history for a single provider from job records. Returns null if no jobs found. */
export function getProviderHistory(
  jobs: JobRecord[],
  endpoint: string
): LocalProviderHistory | null {
  const providerJobs = jobs.filter((j) => j.endpoint === endpoint);
  if (providerJobs.length === 0) return null;
  return computeHistory(endpoint, providerJobs);
}

export function getAllProviderHistory(jobs: JobRecord[]): LocalProviderHistory[] {
  const byEndpoint = new Map<string, JobRecord[]>();
  for (const job of jobs) {
    if (!job.endpoint) continue;
    const list = byEndpoint.get(job.endpoint) ?? [];
    list.push(job);
    byEndpoint.set(job.endpoint, list);
  }

  const stats: LocalProviderHistory[] = [];
  for (const [endpoint, providerJobs] of byEndpoint) {
    stats.push(computeHistory(endpoint, providerJobs));
  }
  return stats;
}

function computeHistory(endpoint: string, jobs: JobRecord[]): LocalProviderHistory {
  const completed = jobs.filter((j) => j.status === "completed");
  const successRate = completed.length / jobs.length;

  const latencies = completed
    .filter((j): j is JobRecord & { completedAt: number } => !!j.completedAt && !!j.submittedAt)
    .map((j) => j.completedAt - j.submittedAt);
  const avgLatencyMs =
    latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

  const lastUsed = Math.max(...jobs.map((j) => j.submittedAt));

  const paidJobs = jobs.filter((j) => (j.totalPaidMsats ?? j.costMsats ?? 0) > 0);
  const totalPaidMsats = jobs.reduce((sum, j) => sum + (j.totalPaidMsats ?? j.costMsats ?? 0), 0);
  const avgCostMsats = paidJobs.length > 0 ? Math.round(totalPaidMsats / paidJobs.length) : 0;
  const paidCompleted = paidJobs.filter((j) => j.status === "completed");
  const paymentSuccessRate = paidJobs.length > 0 ? paidCompleted.length / paidJobs.length : 0;

  // Count payment methods — prefer explicit field, fall back to changeProcessed heuristic
  const cashuPayments = jobs.filter(
    (j) => j.paymentMethod === "cashu" || (!j.paymentMethod && j.changeProcessed)
  ).length;

  return {
    endpoint,
    totalJobs: jobs.length,
    successRate,
    avgLatencyMs,
    lastUsed,
    totalPaidMsats,
    avgCostMsats,
    paymentSuccessRate,
    cashuPayments,
  };
}
