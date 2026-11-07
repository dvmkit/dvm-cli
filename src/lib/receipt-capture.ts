/**
 * Receipt failures are warnings about evidence, not changes to the job outcome.
 * Persistence errors are logged without changing the job's outcome.
 */

import type { TrustAnchorRead } from "@dvmkit/sdk/internal";

import { getLastKnownBtcRate } from "@dvmkit/sdk/internal";
import { type JobRecord, loadJob, updateObservedJob } from "./job-store";
import { info } from "./output";
import { type FundingReceipt, isSignedJobReceipt, type JobReceipt as SignedJobReceipt } from "@dvmkit/sdk/internal";
import { appendFundingReceipt, appendReceipt } from "@dvmkit/sdk/internal";
import { receiptCurrencyHint, receiptDisplay, receiptFailureDetail, receiptHint, receiptPieceContext } from "./receipt-verify";
import { type ReceiptTrustAnchor, type ReceiptVerification, type ReceiptVerifyResult, verifyFundingReceiptChain, verifyJobReceipt } from "@dvmkit/sdk/internal";
import type { JobStatus, ProviderInfo, ProviderRef, ReceiptParseError, Transport } from "@dvmkit/sdk/internal";
import { captureDrawFundingReceipts } from "./draw-funding";
import { completionSnapshot } from "./completion-hints";
import { parseJobContent, type ContentStatus } from "./job-content";
import { receiptSettlement, type SettlementFields, terminalSettlementFields } from "./job-settlement";
import { isTerminalJobStatus } from "./next-action";
import { loadMessages } from "./messages";
import { formatMicro, pieceSettlement, type PieceContext, settlementCurrencyHint } from "./piece-settlement";

/** Verify and persist a funding receipt; callers may anchor state only on a sound verdict. */
export function captureFundingReceipt(args: {
  receipt?: FundingReceipt;
  parseError?: ReceiptParseError;
  endpoint: string;
  builder?: ReceiptTrustAnchor;
  expectedCreditId: string;
  expectedFundId: string;
  expectedFundedMicro?: number;
  expectedBalanceAfterMicro?: number;
  expectedLedgerSeq?: number;
  expectedCallerPubkey: string;
}): ReceiptVerification | "unparseable" | "absent" {
  if (!args.receipt) return args.parseError ? "unparseable" : "absent";
  const result = verifyFundingReceiptChain({
    receipt: args.receipt,
    builder: args.builder,
    expectedCreditId: args.expectedCreditId,
    expectedFundId: args.expectedFundId,
    expectedFundedMicro: args.expectedFundedMicro,
    expectedBalanceAfterMicro: args.expectedBalanceAfterMicro,
    expectedLedgerSeq: args.expectedLedgerSeq,
    expectedCallerPubkey: args.expectedCallerPubkey,
  });
  if (result.status !== "invalid") {
    try {
      appendFundingReceipt({
        receipt: args.receipt,
        endpoint: args.endpoint,
        ...(args.builder ? { builder: args.builder } : {}),
        verification: result.status,
        verified_at: Date.now(),
      });
    } catch (err) {
      info(
        `Warning: could not store funding receipt: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    info(`Warning: this credit funding receipt did not verify (${result.reason ?? "invalid"}).`);
  }
  return result.status;
}

export type ReceiptCaptureStatus = ReceiptVerification | "unparseable";

export interface ReceiptCapture {
  /** The verdict. `"absent"` when none was offered; `"unparseable"` for an invalid shape. */
  status: ReceiptCaptureStatus;
  receipt?: SignedJobReceipt;
  /** Per-link detail, present whenever {@link receipt} is. */
  checks?: ReceiptVerifyResult["checks"];
  /** Machine slug for an `invalid` or `unparseable` verdict. */
  reason?: ReceiptVerifyResult["reason"] | ReceiptParseError;
  /** Pre-rendered line an intermediary agent can relay verbatim. */
  display: string;
  /** Why {@link display} names no currency, when it carries the "(currency not recorded)" label. */
  currencyHint?: string;
}

/**
 * Verify a receipt seen on a submit or status response, persist it to both
 * homes (the job record and `~/.dvm/receipts.jsonl`), and return it rendered.
 *
 * Pass `undefined` when the response carried no receipt — that is the common
 * case and yields an `"absent"` capture with no side effects.
 */
export function captureJobReceipt(
  jobId: string,
  receipt: SignedJobReceipt | undefined,
  parseError?: ReceiptParseError
): ReceiptCapture {
  if (!receipt && parseError) {
    persistParseError(jobId, parseError);
    const capture = unparseableCapture(parseError);
    info(`Warning: this job's receipt could not be parsed (${parseError}). ${capture.display}`);
    return capture;
  }
  if (!receipt) return absentCapture();

  const job = loadJob(jobId);
  const result = verifyJobReceipt({ receipt, builder: job?.builderAnchor, expectedJobId: jobId });

  // A receipt naming another job is surfaced (the caller should see what the
  // provider sent) but never stored: both homes are keyed by job, so filing it
  // would either overwrite this job's proof or squat the other job's slot with
  // an entry nothing collected.
  if (result.reason !== "job_id_mismatch") persist(jobId, receipt, result.status, job);

  if (result.status === "invalid") {
    info(
      `Warning: this job's receipt did not verify. ${receiptFailureDetail(result.reason ?? "signature_invalid")}`
    );
  } else if (result.reason !== "job_id_mismatch") {
    warnPieceOvercharge(jobId, receipt, job);
  }

  return toCapture(receipt, result);
}

/**
 * Flag a signed settlement that charges more than the finished pieces this CLI
 * paid for. The receipt stays stored as evidence; nothing is paid or refused.
 */
function warnPieceOvercharge(jobId: string, receipt: SignedJobReceipt, job: JobRecord | null): void {
  const pieces = pieceSettlement(receipt, { job, messages: loadMessages(jobId) });
  if (!pieces?.overcharged || pieces.ceiling_micro === undefined) return;
  const ceiling = formatMicro(pieces.ceiling_micro, pieces.currency);
  const basis = pieces.ceiling_basis === "payments"
    ? `the ${ceiling} of finished pieces this CLI paid for`
    : pieces.ceiling_basis === "declined_ask"
      ? `the ${ceiling} the job's last ask said stopping would cost`
      : `the ${ceiling} its own pieces add up to`;
  info(
    `Warning: the signed receipt for job ${jobId} charges ${formatMicro(pieces.charged_micro, pieces.currency)}, ` +
      `more than ${basis}. Keep the receipt as evidence ('dvm receipts show ${jobId}') and raise it with the provider.` +
      (pieces.currency ? "" : ` ${settlementCurrencyHint(pieces, job?.endpoint)}`)
  );
}

export function captureTransportReceipt(
  jobId: string,
  response: Pick<JobStatus, "receipt" | "receiptParseError" | "drawFundingReceipts" | "drawFundingReceiptParseError">
): ReceiptCapture {
  captureDrawFundingReceipts(jobId, response.drawFundingReceipts);
  if (response.drawFundingReceiptParseError) info("Warning: mid-job funding evidence has an invalid shape.");
  return captureJobReceipt(jobId, response.receipt, response.receiptParseError);
}

/**
 * `receipt_verified` is always present. Non-absent captures include display
 * text even when unparseable; raw receipt/checks require a parsed receipt.
 * Emit only on terminal responses: absent during a running job means not yet
 * issued, rather than unsupported receipts.
 */
export function receiptJsonFields(capture: ReceiptCapture, jobId?: string): Record<string, unknown> {
  const out: Record<string, unknown> = { receipt_verified: capture.status };
  if (jobId) Object.assign(out, terminalSettlementFields(jobId, { receipt: capture.receipt }));
  else if (capture.receipt) out.settlement = receiptSettlement(capture.receipt, capture.status);
  if (capture.status !== "absent") out.receipt_display = capture.display;
  // One explanation per output: the receipt line and the settlement share it.
  if (capture.currencyHint) {
    out.receipt_hint = capture.currencyHint;
    delete out.settlement_hint;
  }
  if (capture.receipt) {
    out.receipt = capture.receipt;
    if (capture.checks) out.receipt_checks = capture.checks;
  }
  if (capture.reason) out.receipt_error = capture.reason;
  return out;
}

export function renderReceiptHuman(capture: ReceiptCapture, jobId?: string): void {
  const fields = jobId ? terminalSettlementFields(jobId, { receipt: capture.receipt }) : {};
  if (fields.settlement) info(fields.settlement.display);
  if (capture.status !== "absent") info(`🧾 ${capture.display}`);
  const hint = capture.status !== "absent" && capture.currencyHint ? capture.currencyHint : fields.settlement_hint;
  if (hint) info(`  ${hint}`);
}

/** The settlement line, and below it why its amounts name no currency when they don't. */
export function renderSettlementHuman(fields: SettlementFields): void {
  if (fields.settlement) info(fields.settlement.display);
  if (fields.settlement_hint) info(`  ${fields.settlement_hint}`);
}

export function observedSettlementFields(jobId: string, response?: Partial<ContentStatus>, persistLocalState = true, currency?: string) {
  if (persistLocalState && response?.status && isTerminalJobStatus(response.status)
    && (response.receipt || response.receiptParseError)) captureTransportReceipt(jobId, response);
  return terminalSettlementFields(jobId, { status: response?.status, receipt: response?.receipt, persistLocalState, currency });
}

/**
 * Snapshot `/v1/info`'s receipt trust anchor onto a job record at `saveJob`
 * time, so verification later stays offline and pins the anchor that was live
 * when the job ran rather than whatever the DVM advertises by then.
 */
export function receiptTrustFields(
  provider: ProviderInfo
): Pick<JobRecord, "receiptsSupported" | "builderAnchor"> {
  return {
    ...(provider.receipts === true ? { receiptsSupported: true } : {}),
    ...(provider.builder ? { builderAnchor: provider.builder } : {}),
  };
}

export type { TrustAnchorRead } from "@dvmkit/sdk/internal";

/**
 * Drain receipts lack a job's pinned anchor, so read it from the known endpoint.
 * Unreachable reads return reachable=false; a successful read may still have no
 * anchor. A present anchor is passed through for cryptographic verification,
 * where a forged attestation is invalid rather than unattested.
 */
export async function fetchTrustAnchor(
  transport: Transport,
  ref: ProviderRef
): Promise<TrustAnchorRead> {
  try {
    const { builderAnchor } = receiptTrustFields(await transport.describe(ref));
    return { reachable: true, ...(builderAnchor ? { anchor: builderAnchor } : {}) };
  } catch {
    return { reachable: false };
  }
}

/**
 * Collect a receipt missing from a locally-known job.
 *
 * The streamed request arc learns a job is over from the log, while
 * `dvm status` can replay a terminal snapshot written by another command.
 * Neither path has necessarily seen the receipt, which only rides on a job read.
 *
 * Costs one small GET, and only against a DVM that told us at submit time it
 * issues receipts; everything else returns immediately. Best-effort throughout
 * a failure here means no receipt this time, not a failed request.
 */
export async function fetchMissingJobReceipt(
  jobId: string,
  transport: Transport,
  ref: ProviderRef
): Promise<Partial<ContentStatus>> {
  const job = loadJob(jobId);
  if (!job?.receiptsSupported) return {};
  // Already collected (a resumed stream, a prior `dvm status`): skip the GET
  // but hand back what we hold, so the response says "verified" rather than
  // "absent" about a job that demonstrably has proof.
  const held = recordedReceipt(job);
  if (held) return { receipt: held };
  try {
    const status: ContentStatus = await transport.status(jobId, ref, { jobToken: job.jobToken });
    captureDrawFundingReceipts(jobId, status.drawFundingReceipts, { endpoint: ref.endpoint });
    return {
      status: status.status,
      ...completionSnapshot(status),
      ...parseJobContent(status as unknown as Record<string, unknown>),
      ...(status.receipt ? { receipt: status.receipt } : {}),
      ...(status.receiptParseError ? { receiptParseError: status.receiptParseError } : {}),
      ...(status.drawFundingReceipts ? { drawFundingReceipts: status.drawFundingReceipts } : {}),
      ...(status.drawFundingReceiptParseError ? { drawFundingReceiptParseError: status.drawFundingReceiptParseError } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Fill in a job record's missing trust anchor from a live `/v1/info` read.
 *
 * `dvm status` can be the first command to see a receipt — for a job submitted
 * down a paid arc, or one that predates this feature — and a stored receipt
 * with no anchor verifies as `verified_unattested` when the DVM may well have
 * an attestation to offer. One describe call settles it. Best-effort: an
 * unreachable provider leaves the record as it was.
 */
export async function backfillTrustAnchor(
  jobId: string,
  transport: Transport,
  ref: ProviderRef
): Promise<ReceiptTrustAnchor | undefined> {
  try {
    const provider = await transport.describe(ref);
    const fields = receiptTrustFields(provider);
    if (Object.keys(fields).length > 0) updateObservedJob(jobId, fields);
    return fields.builderAnchor;
  } catch {
    return undefined;
  }
}

/**
 * Re-verify a receipt already on the job record — the `dvm status` local-replay
 * path. Deliberately re-runs the chain instead of caching a verdict, so a
 * tampered `jobs.json` answers `invalid` rather than replaying the verdict the
 * untampered bytes once earned.
 */
export function replayStoredReceipt(job: JobRecord): ReceiptCapture {
  const receipt = recordedReceipt(job);
  if (!receipt) {
    return job.receiptParseError === "shape_invalid"
      ? unparseableCapture(job.receiptParseError)
      : absentCapture();
  }
  return toCapture(
    receipt,
    verifyJobReceipt({
      receipt,
      builder: job.builderAnchor,
      expectedJobId: job.id,
    })
  );
}

/**
 * The receipt on a job record, or `undefined` when what is stored there isn't
 * structurally one.
 *
 * `jobs.json` is hand-editable, so `JobRecord.receipt` having a receipt's type
 * is not evidence that it holds one at runtime — and everything downstream
 * dereferences it unconditionally, so an unguarded read turns a mangled record
 * into an `internal` exit on `dvm status`. Same guard the transport applies on
 * the way in and the receipt store applies on the way out, for the same reason.
 *
 * A body that fails it is treated as no receipt rather than as an invalid one:
 * it could never have carried a valid signature, so there is nothing to report
 * a verdict about. The collection in `~/.dvm/receipts.jsonl` is a separate,
 * append-only copy — `dvm receipts show <job-id>` still has the proof.
 */
function recordedReceipt(job: JobRecord): SignedJobReceipt | undefined {
  const receipt: unknown = job.receipt;
  return isSignedJobReceipt(receipt) ? receipt : undefined;
}

function absentCapture(): ReceiptCapture {
  return { status: "absent", display: receiptHint("absent") };
}

function unparseableCapture(reason: ReceiptParseError): ReceiptCapture {
  const display =
    "UNREADABLE receipt: this DVM returned a receipt block that does not match the signed receipt protocol shape. The job itself is unaffected.";
  return { status: "unparseable", reason, display };
}

/**
 * Shape a verdict for rendering. The display line is built at the *cached* fx
 * rate — capture happens on a hot path, and a receipt is not worth a blocking
 * rate fetch. With no cached rate the line falls back to sats rather than
 * inventing a dollar figure.
 */
export function toCapture(
  receipt: SignedJobReceipt,
  result: ReceiptVerifyResult,
  context: PieceContext = receiptPieceContext(receipt),
  endpoint = context.job?.endpoint
): ReceiptCapture {
  const currencyHint = receiptCurrencyHint(receipt, result.status, context, endpoint || undefined);
  return {
    status: result.status,
    receipt,
    checks: result.checks,
    ...(result.reason ? { reason: result.reason } : {}),
    display: receiptDisplay(receipt, result.status, getLastKnownBtcRate()?.rate ?? 0, context),
    ...(currencyHint ? { currencyHint } : {}),
  };
}

/**
 * Write the receipt to both homes. Failures are logged and swallowed —
 * a full disk must not turn a completed job into a failed command.
 */
function persist(
  jobId: string,
  receipt: SignedJobReceipt,
  verification: ReceiptVerification,
  job: JobRecord | null
): void {
  try {
    updateObservedJob(jobId, { receipt });
    appendReceipt({
      receipt,
      endpoint: job?.endpoint ?? "",
      ...(job?.builderAnchor ? { builder: job.builderAnchor } : {}),
      verification,
      verified_at: Date.now(),
    });
  } catch (err) {
    info(
      `Warning: could not store job receipt: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function persistParseError(jobId: string, receiptParseError: ReceiptParseError): void {
  try {
    updateObservedJob(jobId, { receiptParseError });
  } catch (err) {
    info(
      `Warning: could not store job receipt diagnostic: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
