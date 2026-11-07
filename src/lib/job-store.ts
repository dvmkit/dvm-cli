import { jobPersistence, hasUnsavedJobState } from "./job-persistence";
import { DvmError } from "@dvmkit/sdk/internal";
import { sameEndpoint } from "./provider-endpoint";
import { existsSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync } from "fs";

import { JOBS_FILE } from "@dvmkit/sdk/internal";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import type { PaymentContent, UpfrontPayment } from "@dvmkit/sdk";
import { parseUpfrontPayment, parseUpfrontRailPayment, type UpfrontRailPayment } from "./upfront-payment";
import type { PaymentRequestContent } from "@dvmkit/sdk/internal";
import type { JobCompletion } from "./completion-hints";
import { ensureConfigDir } from "@dvmkit/sdk/internal";
import type { TerminalJobStatus } from "./next-action";
import type { JobReceipt as SignedJobReceipt } from "@dvmkit/sdk/internal";
import type { DrawFundingReceipt } from "@dvmkit/sdk/internal";
import type { ReceiptTrustAnchor } from "@dvmkit/sdk/internal";
import type { ProviderRef, ReceiptParseError } from "@dvmkit/sdk/internal";

export type PaymentApproval = "auto" | "explicit";

export interface CreditPaymentIntent {
  approval?: PaymentApproval;
  authorization: NonNullable<PaymentContent["credit"]>;
  request: PaymentRequestContent;
  /** Caller-priced consumption, pinned before send for replay after rate changes. */
  amountMsats?: number;
  /** This pair was selected for a job with no server-bound draw yet. */
  selectedUnbound?: true;
}

interface SubmissionBooking {
  /** The ask's `amount_msats`, which this submission answers. */
  requestAmountMsats: number;
  /** Amount booked once the provider takes the payment. */
  amountMsats: number;
  btcRate: number;
  /** Approval of the send that signed this payment; a re-delivery keeps it. */
  approval?: PaymentApproval;
  /** Provider-supplied ask reason, recorded with the spend. */
  reason?: string;
  /**
   * Set when this token cannot be re-delivered: no command sends it again.
   * Whether a fresh token may be signed for the ask is the job's
   * `askPaymentBlocks`, which outlives this record. A `not_resendable` token
   * leaves decline or cancel while it is held.
   */
  blocked?: HeldPaymentBlock;
}

/** An ask for which no fresh payment may be signed automatically; an explicit `dvm pay` still may. */
export type AskPaymentBlock = Extract<HeldPaymentBlock, { reason: "credit_held" | "proofs_spent" }>;

export type HeldPaymentBlock =
  /** The provider answered that the payment fell short; a Cashu token is kept, on credit where it has a ledger. */
  | { reason: "credit_held"; creditId?: string }
  /** Reserve proofs this token used are spent at the mint, and the provider recorded no payment. */
  | { reason: "proofs_spent"; detail?: string }
  /** The provider's answer does not change on a re-send, but it may still redeem this payment. */
  | { reason: "not_resendable"; detail: string };

export type UnconfirmedPaymentSubmission =
  | (SubmissionBooking & {
      rail: "cashu_p2pk";
      /** Wallet pending-submission id, sent as `cashu_request_id`. The token stays in the wallet journal. */
      cashuRequestId: string;
      /** The token is reserve proofs shipped as-is, which could also have been spent elsewhere. */
      reserve?: true;
    })
  | (SubmissionBooking & {
      rail: "x402" | "tempo";
      /** Exact signed `payment` message content, re-sent unchanged. */
      content: Record<string, unknown>;
      /** Exact signed x402 value in USDC microunits. */
      amountUsdcMicro?: string;
    });

export interface JobRecord {
  /** A successful local cancel send; legacy terminal statuses do not establish caller intent. */
  callerCancelled?: true;
  /**
   * The caller's end was a decline at an open ask, which releases the piece in
   * progress; a cancel charges it. Set beside {@link callerCancelled}.
   */
  callerDeclined?: true;
  /** Hashes of locally sent message payloads; remote sender labels are not ownership evidence. */
  callerMessageHashes?: string[];
  /** Booked upfront rail price, a free start, or unresolved accounting. */
  upfrontRailPayment?: UpfrontRailPayment | "free" | "unknown";
  upfrontRailConflict?: true;
  /** Original accepted debit, independent of later draw growth and receipts. */
  upfrontPayment?: UpfrontPayment;
  upfrontCreditBooked?: true;
  upfrontCreditConflict?: true;
  /** Absent on legacy jobs: their existing draw must never be guessed. */
  creditBinding?: { creditId: string; drawId: string; callerPubkey: string } | { unbound: true; callerPubkey: string };
  pendingCreditPayment?: CreditPaymentIntent;
  bookedCreditPayments?: CreditPaymentIntent[];
  /** Signed external funding facts retained for offline terminal reconciliation. */
  drawFundingReceipts?: DrawFundingReceipt[];
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
  /** Only this prepaid credit may pay; no new rail spend is authorized. */
  creditOnly?: string;
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
  /** Wallet-confirmed amounts for replay; older records retain sequence numbers only. */
  claimedPaymentAmountsMsats?: Record<number, number>;
  /** Rail sends started without a confirmed acknowledgement; reconcile before spending again. */
  inFlightPaymentRequestSeqs?: number[];
  /**
   * The exact payment dispatched for each mid-job ask, keyed by request seq. It
   * is held until the provider takes it (booked once, then dropped), refuses it
   * with a listed definite refusal, a newer ask supersedes it, or the wallet
   * confirms it reclaimed the Cashu token. While held, no other payment is
   * signed for that ask; a retry re-delivers this one.
   */
  unconfirmedPaymentSubmissions?: Record<string, UnconfirmedPaymentSubmission>;
  /**
   * Asks, keyed by request seq, that automatic commands must not pay with a
   * fresh token. Cleared only when a replacement is recorded as taken, or by
   * `dvm decline` or `dvm cancel`: never by a refusal, a dropped submission or
   * a sweep verdict.
   */
  askPaymentBlocks?: Record<string, AskPaymentBlock>;
  /** Latest dispatch or uncertain-outcome times (Unix milliseconds), keyed by request seq. Missing on older records, which skip the settle delay. */
  inFlightPaymentRequestStartedAtMs?: Record<string, number>;
  /** Sequence numbers of settled payment requests, retained across restarts. */
  paidPaymentRequestSeqs?: number[];
  /** Last seen message sequence number for cursor-based polling */
  messageCursor?: number;
  /** Running total of payments sent (millisatoshis) */
  totalPaidMsats?: number;
  /** Number of payments honoured for this job (auto + manual). */
  paymentsHonoured?: number;
  /** Approval of mid-job asks, keyed by provider request sequence. Absent on older records. */
  paymentApprovals?: { requestSeq: number; approval: PaymentApproval }[];
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
  mutateJobs((jobs) => { jobs.push(job); });
}

/** A provider-accepted job stays usable in this command even if its local copy cannot be saved. */
export function saveAcceptedJob(job: JobRecord): void {
  mutateJobs((jobs) => { jobs.push(job); }, true);
}

/** Replayed submits preserve the original record, including subsequent payments. */
export function saveSubmittedJob(job: JobRecord): void {
  mutateJobs((jobs) => {
    const existing = jobs.find((entry) => entry.id === job.id);
    if (!existing) jobs.push(job);
    else if (existing.endpoint !== job.endpoint || (existing.requestId && existing.requestId !== job.requestId))
      throw new Error("Submitted job conflicts with an existing local job.");
  }, true);
}

export function recordUpfrontCreditPayment(jobId: string, value: unknown, paidOnRail = false): void {
  const payment = parseUpfrontPayment(value);
  mutateJobs((jobs) => {
    const job = jobs.find((entry) => entry.id === jobId);
    if (!job || !payment) return;
    // Fund-and-draw submissions already book their attached rail payment.
    if (paidOnRail || (job.paymentMethod && job.paymentMethod !== "credit")) {
      job.upfrontPayment ??= payment;
      return;
    }
    if (!payment.credit_id || !payment.draw_id) {
      if (job.paymentMethod === "credit") job.upfrontCreditConflict = true;
      return;
    }
    const binding = job.creditBinding;
    if (!binding || "unbound" in binding || binding.creditId !== payment.credit_id || binding.drawId !== payment.draw_id) {
      job.upfrontCreditConflict = true;
      return;
    }
    if (job.upfrontPayment && JSON.stringify(job.upfrontPayment) !== JSON.stringify(payment)) {
      job.upfrontCreditConflict = true;
      return;
    }
    job.upfrontPayment = payment;
    job.paymentMethod = "credit";
    if (job.upfrontCreditBooked) return;
    job.totalPaidMsats = (job.totalPaidMsats ?? 0) + payment.amount_msats;
    job.paymentsHonoured = (job.paymentsHonoured ?? 0) + (payment.amount_msats > 0 ? 1 : 0);
    job.upfrontCreditBooked = true;
  }, true);
}

export function hasUnknownUpfrontCredit(job: JobRecord): boolean {
  return job.upfrontCreditConflict === true || (job.paymentMethod === "credit" && (!job.upfrontCreditBooked || !parseUpfrontPayment(job.upfrontPayment)));
}

export function recordUpfrontRailPayment(jobId: string, value: unknown, freshSubmit = false): void {
  const payment = parseUpfrontRailPayment(value);
  mutateJobs((jobs) => {
    const job = jobs.find((entry) => entry.id === jobId);
    if (!job) return;
    const booked = parseUpfrontRailPayment(job.upfrontRailPayment);
    if (booked) {
      if (payment && (booked.method !== payment.method || booked.amountMsats !== payment.amountMsats))
        job.upfrontRailConflict = true;
      return;
    }
    if (value === "free" || (job.upfrontRailPayment === "free" && !payment)) {
      job.upfrontRailPayment = "free";
      return;
    }
    // Legacy counters do not say whether they include the upfront charge.
    // Preserve them rather than adding it twice or treating later charges as proof.
    if (!payment || (!freshSubmit && ((job.totalPaidMsats ?? 0) !== 0 || (job.paymentsHonoured ?? 0) !== 0))) {
      job.upfrontRailPayment = "unknown";
      return;
    }
    job.totalPaidMsats = (job.totalPaidMsats ?? 0) + payment.amountMsats;
    job.paymentsHonoured = (job.paymentsHonoured ?? 0) + (payment.amountMsats > 0 ? 1 : 0);
    job.paymentMethod = payment.method;
    job.upfrontRailPayment = payment;
  }, true);
}

export function hasUnknownUpfrontRail(job: JobRecord): boolean {
  return job.upfrontRailPayment === "unknown" || job.upfrontRailConflict === true;
}

/** Merge a partial update into an existing job record. No-op if job not found. */
export function updateJob(id: string, update: Partial<Omit<JobRecord, "id">>): void {
  mutateJobs((jobs) => {
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx !== -1) jobs[idx] = { ...jobs[idx], ...update };
  });
}

/** Snapshot remote observations without turning their local storage failure into a remote failure. */
export function updateObservedJob(id: string, update: Partial<Omit<JobRecord, "id">>): void {
  mutateJobs((jobs) => {
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx !== -1) jobs[idx] = { ...jobs[idx], ...update };
  }, true);
}

export function recordCallerMessageHash(jobId: string, endpoint: string, hash: string): void {
  mutateJobs((jobs) => {
    const job = jobs.find((entry) => entry.id === jobId && sameEndpoint(entry.endpoint, endpoint));
    if (job) job.callerMessageHashes = [...new Set([...(job.callerMessageHashes ?? []), hash])];
  }, true);
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
  updateObservedJob(id, {
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
  const unsaved = jobPersistence.getStore()?.unsaved;
  if (unsaved) return structuredClone(unsaved);
  if (!existsSync(JOBS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(JOBS_FILE, "utf-8")) as JobRecord[];
  } catch {
    return [];
  }
}

/** Add a payment to a job's running total and increment its honoured-payment count. No-op if job not found. */
export function addPayment(jobId: string, amountMsats: number, approval?: { requestSeq: number; approval: PaymentApproval }): void {
  mutateJobs((jobs) => {
    const job = jobs.find((entry) => entry.id === jobId);
    if (job) bookPayment(job, amountMsats, approval);
  }, true);
}

function bookPayment(job: JobRecord, amountMsats: number, approval?: { requestSeq: number; approval: PaymentApproval }): void {
  job.totalPaidMsats = (job.totalPaidMsats ?? 0) + amountMsats;
  job.paymentsHonoured = (job.paymentsHonoured ?? 0) + 1;
  if (approval) (job.paymentApprovals ??= []).push(approval);
  // A rail may bind a previously free job to an implicit credit whose IDs
  // this message response does not expose. Future balance payments must not guess.
  if (job.creditBinding && "unbound" in job.creditBinding) delete job.creditBinding;
}

/** A `submission` is persisted in the same write, so no dispatch exists without its re-delivery record. */
export function markPaymentRequestInFlight(jobId: string, requestSeq: number, submission?: UnconfirmedPaymentSubmission): void {
  mutateJobs((jobs) => {
    const job = jobs.find((entry) => entry.id === jobId);
    if (job) {
      if (!job.inFlightPaymentRequestSeqs?.includes(requestSeq))
        (job.inFlightPaymentRequestSeqs ??= []).push(requestSeq);
      (job.inFlightPaymentRequestStartedAtMs ??= {})[requestSeq] = Date.now();
      if (submission) (job.unconfirmedPaymentSubmissions ??= {})[requestSeq] = submission;
    }
  });
}

/**
 * `keepSubmission` is for a send that never reached the provider: the ask is
 * no longer in flight, but its signed payment must still be the one delivered.
 */
export function clearPaymentRequestInFlight(jobId: string, requestSeq: number, opts?: { keepSubmission?: boolean }): void {
  mutateJobs((jobs) => {
    const job = jobs.find((entry) => entry.id === jobId);
    if (!job) return;
    if (!opts?.keepSubmission) clearUnconfirmedSubmission(job, requestSeq);
    if (!job.inFlightPaymentRequestSeqs) return;
    job.inFlightPaymentRequestSeqs = job.inFlightPaymentRequestSeqs.filter((seq) => seq !== requestSeq);
    if (!job.inFlightPaymentRequestSeqs.length) delete job.inFlightPaymentRequestSeqs;
    clearPaymentRequestStartTime(job, requestSeq);
  });
}

function clearUnconfirmedSubmission(job: JobRecord, requestSeq: number): void {
  if (!job.unconfirmedPaymentSubmissions) return;
  delete job.unconfirmedPaymentSubmissions[requestSeq];
  if (!Object.keys(job.unconfirmedPaymentSubmissions).length) delete job.unconfirmedPaymentSubmissions;
}

/**
 * Record that the provider took the payment held for this ask. Call it only
 * with evidence that the held submission itself was taken. It is booked into
 * the job's totals in the same write that drops it, and only the caller that
 * receives it back books the ledger and wallet, so a payment is booked at most
 * once: a crash before that caller finishes loses the ledger entry rather than
 * double-booking. Returns that submission, or undefined when none was held.
 */
export function markPaymentRequestPaid(jobId: string, requestSeq: number): UnconfirmedPaymentSubmission | undefined {
  const booked = mutateJobs((jobs) => {
    const job = jobs.find((entry) => entry.id === jobId);
    if (!job) return undefined;
    if (!job.paidPaymentRequestSeqs?.includes(requestSeq))
      (job.paidPaymentRequestSeqs ??= []).push(requestSeq);
    if (job.inFlightPaymentRequestSeqs) {
      job.inFlightPaymentRequestSeqs = job.inFlightPaymentRequestSeqs.filter((seq) => seq !== requestSeq);
      if (!job.inFlightPaymentRequestSeqs.length) delete job.inFlightPaymentRequestSeqs;
    }
    clearPaymentRequestStartTime(job, requestSeq);
    const booked = job.unconfirmedPaymentSubmissions?.[requestSeq];
    clearUnconfirmedSubmission(job, requestSeq);
    if (booked) bookPayment(job, booked.amountMsats, booked.approval ? { requestSeq, approval: booked.approval } : undefined);
    // A token that can still be re-delivered, recorded taken on a blocked ask,
    // is the replacement an explicit pay approved; the blocked token is not.
    if (booked && !booked.blocked && job.askPaymentBlocks?.[requestSeq]) {
      delete job.askPaymentBlocks[requestSeq];
      if (!Object.keys(job.askPaymentBlocks).length) delete job.askPaymentBlocks;
    }
    return booked;
  }, true);
  // Only durable consumption grants ownership of the ledger and wallet booking.
  return hasUnsavedJobState() ? undefined : booked;
}

/**
 * Record that the ask was answered without evidence it was by the held
 * submission (another payment, or history that no longer carries the content).
 * The submission stays: a later sweep verdict books or releases it.
 */
export function markPaymentRequestAnswered(jobId: string, requestSeq: number): void {
  mutateJobs((jobs) => {
    const job = jobs.find((entry) => entry.id === jobId);
    if (!job) return;
    if (!job.paidPaymentRequestSeqs?.includes(requestSeq))
      (job.paidPaymentRequestSeqs ??= []).push(requestSeq);
    job.inFlightPaymentRequestSeqs = job.inFlightPaymentRequestSeqs?.filter((seq) => seq !== requestSeq);
    if (!job.inFlightPaymentRequestSeqs?.length) delete job.inFlightPaymentRequestSeqs;
    clearPaymentRequestStartTime(job, requestSeq);
  }, true);
}

/** Stop re-sending a held payment; it is no longer in flight, but still held. */
export function blockHeldPayment(jobId: string, requestSeq: number, blocked: HeldPaymentBlock): void {
  mutateJobs((jobs) => {
    const job = jobs.find((entry) => entry.id === jobId);
    const submission = job?.unconfirmedPaymentSubmissions?.[requestSeq];
    if (!job || !submission) return;
    submission.blocked = blocked;
    if (blocked.reason !== "not_resendable") (job.askPaymentBlocks ??= {})[requestSeq] = blocked;
    job.inFlightPaymentRequestSeqs = job.inFlightPaymentRequestSeqs?.filter((seq) => seq !== requestSeq);
    if (!job.inFlightPaymentRequestSeqs?.length) delete job.inFlightPaymentRequestSeqs;
    clearPaymentRequestStartTime(job, requestSeq);
  });
}

/** `dvm decline` and `dvm cancel` end the job, which lifts its ask blocks. */
export function clearAskPaymentBlocks(jobId: string): void {
  mutateJobs((jobs) => {
    const job = jobs.find((entry) => entry.id === jobId);
    if (job) delete job.askPaymentBlocks;
  }, true);
}

/** Release every held Cashu submission whose token the wallet reclaimed, so its ask may be paid afresh. */
export function releaseReclaimedSubmissions(cashuRequestIds: ReadonlySet<string>): void {
  if (cashuRequestIds.size === 0) return;
  mutateJobs((jobs) => {
    for (const job of jobs) {
      for (const [seq, submission] of Object.entries(job.unconfirmedPaymentSubmissions ?? {})) {
        if (submission.rail !== "cashu_p2pk" || !cashuRequestIds.has(submission.cashuRequestId)) continue;
        clearUnconfirmedSubmission(job, Number(seq));
        job.inFlightPaymentRequestSeqs = job.inFlightPaymentRequestSeqs?.filter((held) => held !== Number(seq));
        if (!job.inFlightPaymentRequestSeqs?.length) delete job.inFlightPaymentRequestSeqs;
        clearPaymentRequestStartTime(job, Number(seq));
      }
    }
  });
}

/** Jobs and asks whose held Cashu payment is one of these wallet submissions. */
export function heldCashuSubmissionAsks(cashuRequestIds: ReadonlySet<string>): { jobId: string; requestSeq: number; cashuRequestId: string; blocked?: HeldPaymentBlock }[] {
  return loadAllJobs().flatMap((job) => Object.entries(job.unconfirmedPaymentSubmissions ?? {})
    .flatMap(([seq, submission]) => submission.rail === "cashu_p2pk" && cashuRequestIds.has(submission.cashuRequestId)
      ? [{ jobId: job.id, requestSeq: Number(seq), cashuRequestId: submission.cashuRequestId,
          ...(submission.blocked ? { blocked: submission.blocked } : {}) }] : []));
}

function clearPaymentRequestStartTime(job: JobRecord, requestSeq: number): void {
  if (!job.inFlightPaymentRequestStartedAtMs) return;
  delete job.inFlightPaymentRequestStartedAtMs[requestSeq];
  if (!Object.keys(job.inFlightPaymentRequestStartedAtMs).length) delete job.inFlightPaymentRequestStartedAtMs;
}

export function refFromJob(job: JobRecord): ProviderRef {
  return { endpoint: job.endpoint };
}

function writeJobs(jobs: JobRecord[]): void {
  ensureConfigDir();
  const temporary = `${JOBS_FILE}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(jobs, null, 2) + "\n");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temporary, JOBS_FILE);
  // Windows keeps synced file contents and atomic replacement; equivalent
  // directory-entry crash durability is not established there.
  if (process.platform !== "win32") {
    const directory = openSync(dirname(JOBS_FILE), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

const lockWait = new Int32Array(new SharedArrayBuffer(4));

function acquireJobsLock(): () => void {
  const deadline = performance.now() + 1000;
  for (let attempt = 0; ; attempt++) {
    try {
      return lockfile.lockSync(JOBS_FILE, { realpath: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt >= 40 || performance.now() >= deadline) throw error;
      // Mutations are synchronous and short; another process can release while this thread waits.
      Atomics.wait(lockWait, 0, 0, Math.min(25, Math.max(0, deadline - performance.now())));
    }
  }
}

/** Serialize intent creation and consumption booking, including concurrent pay processes. */
function mutateJobs<T>(change: (jobs: JobRecord[]) => T, observed = false): T {
  const session = jobPersistence.getStore();
  const retain = (jobs: JobRecord[]) => {
    if (!session) throw new Error("Job persistence session unavailable.");
    session.unsaved = structuredClone(jobs);
    session.warn();
  };
  if (hasUnsavedJobState()) {
    if (!observed) throw new DvmError("local_job_state_unsaved",
      "Local job state must be saved before another payment can be sent.",
      "Refresh the job once local storage is available; do not submit a replacement.");
    const jobs = loadAllJobs();
    const result = change(jobs);
    retain(jobs);
    return result;
  }
  let release: () => void;
  try {
    ensureConfigDir();
    release = acquireJobsLock();
  } catch (error) {
    if (!observed || !session) throw error;
    const jobs = loadAllJobs();
    const result = change(jobs);
    retain(jobs);
    return result;
  }
  const jobs = loadAllJobs();
  let mutationCompleted = false;
  try {
    const before = JSON.stringify(jobs);
    const result = change(jobs);
    mutationCompleted = true;
    try {
      if (JSON.stringify(jobs) !== before) writeJobs(jobs);
    } catch (error) {
      if (!observed || !session) throw error;
      retain(jobs);
    }
    return result;
  } finally {
    try { release(); } catch (error) {
      if (!mutationCompleted || !observed || !session) throw error;
      retain(jobs);
    }
  }
}

export function mutateCreditPayment<T>(jobId: string, change: (job: JobRecord) => T, observed = false): T {
  return mutateJobs((jobs) => {
    const job = jobs.find((entry) => entry.id === jobId);
    if (!job) throw new Error("Cannot persist a balance payment for an unknown job.");
    return change(job);
  }, observed);
}

export function bookCreditPayment(jobId: string, intent: CreditPaymentIntent): void {
  mutateCreditPayment(jobId, (job) => {
    if (!job.bookedCreditPayments?.some((entry) =>
      entry.authorization.payment_id === intent.authorization.payment_id)) {
      job.totalPaidMsats = (job.totalPaidMsats ?? 0) + (intent.amountMsats ?? intent.request.amount_msats);
      job.paymentsHonoured = (job.paymentsHonoured ?? 0) + 1;
      (job.bookedCreditPayments ??= []).push(intent);
      if (intent.approval) (job.paymentApprovals ??= []).push({
        requestSeq: intent.authorization.request_seq, approval: intent.approval,
      });
    }
    if (job.pendingCreditPayment?.authorization.payment_id === intent.authorization.payment_id)
      delete job.pendingCreditPayment;
  }, true);
}
