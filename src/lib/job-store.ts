import { existsSync, readFileSync, writeFileSync } from "fs";

import { JOBS_FILE } from "@dvmkit/sdk/internal";
import type { JobCompletion } from "./completion-hints";
import { ensureConfigDir } from "@dvmkit/sdk/internal";
import type { TerminalJobStatus } from "./next-action";
import type { JobReceipt as SignedJobReceipt } from "@dvmkit/sdk/internal";
import type { ReceiptTrustAnchor } from "@dvmkit/sdk/internal";
import type { ProviderRef, ReceiptParseError } from "@dvmkit/sdk/internal";

export interface JobRecord {
  id: string;
  endpoint: string;
  /** Canonical DVM name. Optional for older job records. */
  dvmId?: string;
  /** Router-issued claim authorizing DVM attribution for feedback on this job. */
  feedbackClaim?: string;
  /** Capability dispatched against this DVM. Optional for older job records. */
  capability?: string;
  /** Caller-generated public request id used to recover this exact job. */
  requestId?: string;
  status:
    | "submitted"
    | "processing"
    | "completed"
    | "failed"
    | "timeout"
    | "cancelled"
    | "awaiting-input";
  /** Unix timestamp (ms) when submitted */
  submittedAt: number;
  /** Unix timestamp (ms) when completed/failed */
  completedAt?: number;
  /**
   * the terminal outcome (summary + artifact metadata + failure
   * message), snapshotted the moment the CLI learns the job is over. `dvm status`
   * replays it instead of re-reading the provider, so a finished job answers
   * with the same field set on every call — and still answers with the provider
   * down. Written by `markJobTerminal` in lockstep with a terminal `status`;
   * absent only on records written before this landed.
   */
  completion?: JobCompletion;
  /** Cost in millisatoshis */
  costMsats?: number;
  /** Rail the upfront spend settled on. `credit` — drawn from a prepaid credit. */
  paymentMethod?: "cashu" | "x402" | "tempo" | "credit";
  /** Validated Tempo settlement transaction associated with the request. */
  transactionHash?: string;
  /**
   * Caller-pinned Cashu spend mint. When set, every spend leg for
   * this job (upfront, mid-job `payment-request`, `dvm pay`) draws only from
   * this mint — no fallback to another allowlisted mint.
   */
  pinnedMint?: string;
  /** Request was submitted through the fail-closed direct-Cashu mode. */
  strictPerCall?: true;
  /** Job-wide Cashu swap-fee ceiling in sats, including later recovery swaps. */
  maxCashuFeeSats?: number;
  /** Whether Cashu change has been processed (prevents double-processing on repeated polls) */
  changeProcessed?: boolean;
  /**
   * Sequence numbers of inbound `payment` messages (refund/change) whose Cashu
   * proofs have already been claimed into the local wallet. Per-`seq` (unlike
   * the coarse `changeProcessed`) because a job may carry several such messages,
   * and prevents double-claim on replay/re-poll.
   */
  claimedPaymentSeqs?: number[];
  /** Last seen message sequence number for cursor-based polling */
  messageCursor?: number;
  /** Running total of payments sent (millisatoshis) */
  totalPaidMsats?: number;
  /** Number of payments honoured for this job (auto + manual). */
  paymentsHonoured?: number;
  /** Index of received artifact deliverables. */
  artifacts?: ArtifactRef[];
  /** Spending policy for this job's conversation. */
  policy?: {
    maxTotalMsats: number;
    autoPayBelowMsats: number;
    maxIncrementMsats: number;
    maxPayments: number;
  };
  /**
   * opaque per-job token issued by the DVM at create-time when the
   * caller resolved to anonymous (the default for free DVMs). Persisted on
   * the local job record and sent as `X-Job-Token` on every subsequent
   * `status`/`messages`/`message`/`pay`/`cancel` request. Absent for
   * authenticated callers (bearer / signed-request).
   */
  jobToken?: string;
  /**
   * platform `trace_id` captured from the submit response's
   * `traceparent` header. Persisted locally so `dvm feedback --job <id>` can
   * derive it without re-querying the platform. Absent on legacy job records
   * created before this field landed.
   */
  traceId?: string;
  /**
   * the DVM-signed receipt for this job, snapshotted the moment the
   * CLI first saw it. Lets `dvm status` replay `receipt_verified` from the
   * local record with the provider down, alongside `completion`. The durable
   * copy lives in `~/.dvm/receipts.jsonl` — this one dies with the job record.
   */
  receipt?: SignedJobReceipt;
  /** Receipt value was offered but failed the transport's structural guard. */
  receiptParseError?: ReceiptParseError;
  /**
   * whether `/v1/info` advertised `receipts` at submit time. Gates
   * the one follow-up read the streamed arc spends to collect a receipt, so a
   * DVM that doesn't issue them costs nothing.
   */
  receiptsSupported?: boolean;
  /**
   * `/v1/info#builder` as the endpoint served it at submit time —
   * the anchor a receipt's attestation chain terminates at. Persisted so
   * verification stays offline; `dvm receipts verify --endpoint` is the opt-in
   * to re-fetch a possibly-rotated one.
   */
  builderAnchor?: ReceiptTrustAnchor;
}

export interface ArtifactRef {
  seq: number;
  name?: string;
  mimeType?: string;
}

export function saveJob(job: JobRecord): void {
  const jobs = loadAllJobs();
  jobs.push(job);
  writeJobs(jobs);
}

/** Merge a partial update into an existing job record. No-op if job not found. */
export function updateJob(id: string, update: Partial<Omit<JobRecord, "id">>): void {
  const jobs = loadAllJobs();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return;
  jobs[idx] = { ...jobs[idx], ...update };
  writeJobs(jobs);
}

/** Persist status and completion together for offline replay. Empty completion is allowed.
 * Repeated terminal updates preserve the original completedAt. Missing jobs are unchanged. */
export function markJobTerminal(
  id: string,
  status: TerminalJobStatus,
  completion: JobCompletion,
  extra?: Partial<Omit<JobRecord, "id" | "status" | "completedAt" | "completion">>
): void {
  const existing = loadJob(id);
  if (!existing) return;
  updateJob(id, {
    ...extra,
    status,
    completedAt: existing.completedAt ?? Date.now(),
    completion,
  });
}

export function loadJob(id: string): JobRecord | null {
  const jobs = loadAllJobs();
  return jobs.find((j) => j.id === id) ?? null;
}

/** Load all job records. Returns [] on missing/corrupt file. */
export function loadAllJobs(): JobRecord[] {
  if (!existsSync(JOBS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(JOBS_FILE, "utf-8")) as JobRecord[];
  } catch {
    return [];
  }
}

/** Add a payment to a job's running total and increment its honoured-payment count. No-op if job not found. */
export function addPayment(jobId: string, amountMsats: number): void {
  const job = loadJob(jobId);
  if (!job) return;
  updateJob(jobId, {
    totalPaidMsats: (job.totalPaidMsats ?? 0) + amountMsats,
    paymentsHonoured: (job.paymentsHonoured ?? 0) + 1,
  });
}

export function refFromJob(job: JobRecord): ProviderRef {
  return { endpoint: job.endpoint };
}

function writeJobs(jobs: JobRecord[]): void {
  ensureConfigDir();
  writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2) + "\n");
}
