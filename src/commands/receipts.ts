/**
 * `dvm receipts` — the caller's collection of DVM-signed receipts.
 *
 * Every terminal job on a receipt-issuing DVM leaves a signed proof of what was
 * bought, what it cost, and how it ended. `dvm request` / `dvm status` collect
 * them automatically into `~/.dvm/receipts.jsonl`; this is where an agent (or a
 * human it is relaying to) reads them back.
 *
 * Offline by default. `verify` re-walks the whole trust chain from stored bytes
 * with no network at all — including the `result_hash` recompute against the
 * message log, which is a check the capture-time pass can't make because it
 * doesn't hold the artifacts yet. `--endpoint` is the explicit opt-in to
 * re-fetch a possibly-rotated `/v1/info`.
 *
 * `export` is the portability story: raw JSONL to stdout, each line carrying
 * the receipt *and* the trust anchor it chains to, so a third party can check
 * the bundle without asking us for anything.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { ArtifactContent } from "@dvmkit/sdk";

import {
  asProviderText,
  type DeliveredResult,
  DvmError,
  getLastKnownBtcRate,
  isArtifactMessage,
  isCancelMessage,
  isCompleteMessage,
  type JsonValue,
  loadReceipt,
  loadReceipts,
  type Message,
  type ReceiptTrustAnchor,
  type ReceiptVerification,
  type ReceiptVerifyResult,
  type JobReceipt as SignedJobReceipt,
  type StoredReceipt,
  verifyJobReceipt,
} from "@dvmkit/sdk/internal";
import {
  epochMsToIso,
  receiptDisplay,
  receiptFailureDetail,
  receiptHint,
  receiptIssuedAtIso,
} from "../lib/receipt-verify";
import {
  info,
  json,
  raw,
} from "../lib/output";
import {
  loadJob,
} from "../lib/job-store";
import {
  receiptTrustFields,
} from "../lib/receipt-capture";

import { resolveEndpoint } from "../lib/favorites";
import { loadMessages } from "../lib/messages";
import { createDvmTransport } from "../lib/transport";

export interface ReceiptsListOptions {
  /** Only receipts whose display DVM name matches this value. */
  dvm?: string;
  /** Only receipts issued by this immutable DVM identity. */
  dvmId?: string;
  /** Max rows, newest first. Defaults to {@link DEFAULT_LIMIT}. */
  limit?: string;
  human?: boolean;
}

export interface ReceiptsShowOptions {
  human?: boolean;
}

export interface ReceiptsVerifyOptions {
  file?: string[];
  artifact?: string;
  /** Re-fetch `/v1/info` from this endpoint (or `@alias`) instead of using the stored anchor. */
  endpoint?: string;
  human?: boolean;
}

export interface ReceiptsExportOptions {
  /** Only receipts whose display DVM name matches this value. */
  dvm?: string;
  /** Only receipts issued by this immutable DVM identity. */
  dvmId?: string;
}

export const DEFAULT_LIMIT = 50;

/** List collected receipts, newest first, each re-verified as it is read. */
export function receiptsList(opts: ReceiptsListOptions): void {
  const limit = resolveLimit(opts.limit);
  const matched = newestFirst(filterReceipts(loadReceipts(), opts));
  // Re-derive rather than print `entry.verification`: that field is what we
  // concluded at collection time, read back out of a file anyone can edit.
  // Roughly one Schnorr verify per row at the default limit — cheap enough that
  // trusting the stored word instead would be a saving on nothing.
  const shown = matched.slice(0, limit).map((entry) => ({ entry, status: reverify(entry).status }));
  const rate = getLastKnownBtcRate()?.rate ?? 0;

  if (opts.human) {
    if (shown.length === 0) {
      info(emptyMessage(opts));
      return;
    }
    for (const { entry, status } of shown) {
      info(`${entry.receipt.job_id}  ${receiptDisplay(entry.receipt, status, rate)}`);
    }
    info(`\n${shown.length} of ${matched.length} receipt(s).`);
    return;
  }

  json({
    entries: shown.map(({ entry, status }) => listEntryJson(entry, status, rate)),
    count: shown.length,
    total: matched.length,
    filter: { dvm: opts.dvm ?? null, dvm_id: opts.dvmId ?? null, limit },
    display: summaryLine(shown.length, matched.length, opts),
    hint:
      shown.length === 0
        ? emptyMessage(opts)
        : "Each entry is a DVM-signed proof of one job. Re-check one offline with 'dvm receipts verify <job-id>', or hand over the raw bundle with 'dvm receipts export'.",
  });
}

/** Show one stored receipt in full, re-verified at read time. */
export function receiptsShow(jobId: string, opts: ReceiptsShowOptions): void {
  const entry = requireStored(jobId);
  const result = reverify(entry, jobId);
  const rate = getLastKnownBtcRate()?.rate ?? 0;

  if (opts.human) {
    renderVerdictHuman(entry, result, rate);
    info(`\nEndpoint: ${entry.endpoint || "(unknown)"}`);
    info(`Collected: ${epochMsToIso(entry.verified_at) ?? "(unknown)"}`);
    info(`Sequence:  ${entry.receipt.seq} (per-DVM terminal counter)`);
    return;
  }

  json({
    ...storedReceiptJson(entry, result, rate),
    hint: receiptHint(result.status, jobId),
  });
}

/**
 * Re-verify one stored receipt from scratch.
 *
 * Stronger than the capture-time pass in one respect: it recomputes
 * `result_hash` against the locally-stored message log, which capture time
 * couldn't do because the artifacts hadn't been fetched yet. That check only
 * runs when the log is provably complete — see {@link deliveredFromMessages}.
 */
export async function receiptsVerify(jobId: string, opts: ReceiptsVerifyOptions): Promise<void> {
  if (opts.artifact !== undefined && !opts.file?.length) {
    throw new DvmError("invalid_argument", "--artifact requires --file.", "Pass --file <path> with --artifact to select the file artifact to check.");
  }
  const entry = requireStored(jobId);
  const builder = opts.endpoint
    ? await refetchAnchor(opts.endpoint)
    : (entry.builder ?? loadJob(jobId)?.builderAnchor);

  const delivered = deliveredFromMessages(jobId, entry.receipt);
  const result = verifyJobReceipt({
    receipt: entry.receipt,
    builder,
    expectedJobId: jobId,
    delivered,
  });
  const files = await verifyFiles(jobId, opts, delivered, result);
  if (files.some((file) => !["match", "no_signed_digest", "unverifiable"].includes(file.status))) process.exitCode = 1;
  const rate = getLastKnownBtcRate()?.rate ?? 0;

  if (opts.human) {
    renderVerdictHuman(entry, result, rate);
    for (const file of files) {
      info(`${file.path}: ${file.display}`);
      info(`  ${file.hint}`);
    }
    info(`\nSignature:   ${result.checks.signature ? "valid" : "INVALID"}`);
    info(`Attestation: ${result.checks.attestation}`);
    info(`Result hash: ${result.checks.result_hash}`);
    if (opts.endpoint) info(`Anchor:      re-fetched from ${opts.endpoint}`);
    return;
  }

  json({
    ...storedReceiptJson(entry, result, rate),
    ...(opts.file?.length ? { files } : {}),
    anchor_source: opts.endpoint ? "refetched" : "stored",
    hint: receiptHint(result.status, jobId),
  });
}

interface FileVerdict {
  path: string;
  sha256: string | null;
  matched_artifact: { name: ReturnType<typeof asProviderText> | null; index: number } | null;
  status: "match" | "mismatch" | "no_signed_digest" | "unverifiable" | "unreadable";
  display: string;
  hint: string;
}

async function verifyFiles(
  jobId: string,
  opts: ReceiptsVerifyOptions,
  delivered: DeliveredResult | undefined,
  result: ReceiptVerifyResult
): Promise<FileVerdict[]> {
  if (!opts.file?.length) return [];
  const artifacts = (result.checks.result_hash === "ok" ? delivered?.artifactContents ?? [] : []).map((content, index) => ({
    content: content as unknown as ArtifactContent,
    index: index + 1,
  }));
  const selected = opts.artifact === undefined ? artifacts : artifacts.filter(({ content, index }) =>
    /^[1-9]\d*$/.test(opts.artifact!) ? String(index) === opts.artifact : content.name === opts.artifact
  );
  if (opts.artifact !== undefined && result.checks.result_hash === "ok" && selected.length === 0) {
    throw new DvmError("artifact_not_found", "No artifact matches --artifact.",
      artifacts.length ? "Select an artifact by its 1-based index, or by its exact name as shown in `dvm messages <job-id>`. JSON output lists them in available_artifacts." : "This receipt has no delivered artifacts to select. Omit --artifact.",
      { available_artifacts: artifacts.map(({ content, index }) => ({ index, name: content.name === undefined ? null : asProviderText(content.name) })) });
  }
  if (opts.artifact !== undefined && selected.length > 1) {
    throw new DvmError("ambiguous_artifact", "More than one artifact matches --artifact.", "Select its unique 1-based artifact index instead.");
  }
  const candidates = selected.filter(({ content }) =>
    typeof content.url === "string" && content.url.length > 0 &&
    typeof content.sha256 === "string" && /^[a-f0-9]{64}$/i.test(content.sha256)
  );
  const files: FileVerdict[] = [];
  for (const path of opts.file ?? []) {
    const base = { path, sha256: null, matched_artifact: null };
    try {
      // Check the type before opening: opening a named pipe with no writer blocks forever.
      if (!(await stat(path)).isFile()) throw new Error("Not a regular file");
      const file = await open(path, "r");
      try {
        if (!(await file.stat()).isFile()) throw new Error("Not a regular file");
      } finally {
        await file.close();
      }
      if (result.checks.result_hash !== "ok" || result.status === "invalid") {
        files.push({ ...base, status: "unverifiable",
          display: "The file cannot be checked against signed evidence.",
          hint: `The receipt could not be checked, so the file cannot be checked against it. Run 'dvm receipts verify ${jobId}' without --file to see why.` });
        continue;
      }
      if (candidates.length === 0) {
        files.push({ ...base, status: "no_signed_digest",
          display: "No signed file fingerprint is available for this selection.",
          hint: "The DVM did not sign a usable SHA-256 fingerprint for a URL artifact in this selection. Check --artifact if supplied." });
        continue;
      }
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of createReadStream(path)) {
        size += chunk.length;
        hash.update(chunk);
      }
      const sha256 = hash.digest("hex");
      const match = candidates.find(({ content }) => content.sha256!.toLowerCase() === sha256 &&
        (typeof content.size_bytes !== "number" || content.size_bytes === size));
      files.push({ path, sha256,
        matched_artifact: match ? { name: match.content.name === undefined ? null : asProviderText(match.content.name), index: match.index } : null,
        status: match ? "match" : "mismatch",
        display: match ? "The file matches the fingerprint the DVM signed in its receipt."
          : `The file does not match the fingerprint${candidates.some(({ content }) => typeof content.size_bytes === "number") ? " or size" : ""} the DVM signed in its receipt.`,
        hint: match ? "The file's bytes match signed evidence; this does not assess the quality of the result."
          : "Check that you selected the intended file and artifact. Do not rely on this file as the signed result." });
    } catch {
      files.push({ ...base, status: "unreadable",
        display: "The local file could not be read.",
        hint: "Check that the path names an existing, readable file, not a directory, and try again." });
    }
  }
  return files;
}

/**
 * Stream the raw collection to stdout as JSONL — no envelope, no trace_id, one
 * self-contained line per receipt. This is the artifact a caller hands to
 * someone else; wrapping it would make it ours rather than theirs.
 */
export function receiptsExport(opts: ReceiptsExportOptions): void {
  for (const entry of filterReceipts(loadReceipts(), opts)) {
    raw(JSON.stringify(entry));
  }
}


/**
 * Re-walk the trust chain for a stored entry. Every read path runs this rather
 * than reporting `entry.verification`, which is only the verdict this receipt
 * earned at collection time — editing the file must change the answer.
 *
 * `expectedJobId` is the id the caller asked about, when they asked about one.
 * `list` doesn't, so it leaves that link honestly `unchecked` rather than
 * comparing the receipt against itself.
 */
function reverify(entry: StoredReceipt, expectedJobId?: string): ReceiptVerifyResult {
  return verifyJobReceipt({
    receipt: entry.receipt,
    builder: entry.builder,
    ...(expectedJobId !== undefined ? { expectedJobId } : {}),
  });
}

function requireStored(jobId: string): StoredReceipt {
  const entry = loadReceipt(jobId);
  if (entry) return entry;
  throw new DvmError(
    "receipt_not_found",
    `No stored receipt for job ${jobId}.`,
    "Receipts are collected when a job finishes. Run 'dvm status <job-id>' to fetch one the submit path missed, or 'dvm receipts list' to see what is stored. A DVM that doesn't issue receipts never produces one."
  );
}

function filterReceipts(
  entries: StoredReceipt[],
  opts: Pick<ReceiptsListOptions, "dvm" | "dvmId">
): StoredReceipt[] {
  const displayName = opts.dvm?.toLowerCase();
  return entries.filter(
    (entry) =>
      (displayName === undefined || entry.receipt.dvm.toLowerCase() === displayName) &&
      (opts.dvmId === undefined || entry.receipt.dvm_id === opts.dvmId)
  );
}

/**
 * Newest first, by the DVM's own `issued_at`. Ties break on the per-DVM `seq`
 * so two receipts issued in the same second still order deterministically.
 */
function newestFirst(entries: StoredReceipt[]): StoredReceipt[] {
  return entries
    .slice()
    .sort((a, b) => b.receipt.issued_at - a.receipt.issued_at || b.receipt.seq - a.receipt.seq);
}

function resolveLimit(limit: string | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  const n = Number(limit);
  if (!Number.isInteger(n) || n <= 0) {
    throw new DvmError("invalid_limit", `--limit must be a positive integer, got "${limit}".`);
  }
  return n;
}

function listEntryJson(
  entry: StoredReceipt,
  status: ReceiptVerification,
  rate: number
): Record<string, unknown> {
  return {
    job_id: entry.receipt.job_id,
    dvm_id: entry.receipt.dvm_id,
    dvm: entry.receipt.dvm,
    capability: entry.receipt.capability,
    outcome: entry.receipt.outcome,
    // `null` when the DVM stamped a timestamp outside the representable range —
    // see `receiptIssuedAtIso`. The raw number stays intact under `receipt`.
    issued_at: receiptIssuedAtIso(entry.receipt),
    paid_msats: entry.receipt.paid.msats,
    receipt_verified: status,
    display: receiptDisplay(entry.receipt, status, rate),
  };
}

function storedReceiptJson(
  entry: StoredReceipt,
  result: ReceiptVerifyResult,
  rate: number
): Record<string, unknown> {
  return {
    job_id: entry.receipt.job_id,
    endpoint: entry.endpoint,
    receipt: entry.receipt,
    receipt_verified: result.status,
    receipt_checks: result.checks,
    ...(result.reason
      ? { receipt_error: result.reason, receipt_error_detail: receiptFailureDetail(result.reason) }
      : {}),
    // The DVM's terminal reason is provider free text — an agent relaying it
    // must be able to see that it is untrusted (docs/cli.md).
    ...(entry.receipt.reason ? { reason: asProviderText(entry.receipt.reason) } : {}),
    // Our own bookkeeping, but read back out of a hand-editable file, so `null`
    // when the line's `verified_at` isn't a representable instant. The receipt
    // itself is unaffected — a mangled collection timestamp must not cost the
    // caller the proof it is attached to.
    collected_at: epochMsToIso(entry.verified_at),
    ...(entry.builder ? { builder: entry.builder } : {}),
    display: receiptDisplay(entry.receipt, result.status, rate),
  };
}

function renderVerdictHuman(entry: StoredReceipt, result: ReceiptVerifyResult, rate: number): void {
  info(receiptDisplay(entry.receipt, result.status, rate));
  if (result.reason) info(`  ${receiptFailureDetail(result.reason)}`);
  if (entry.receipt.reason) info(`  Provider reason: ${entry.receipt.reason}`);
}

function emptyMessage(opts: Pick<ReceiptsListOptions, "dvm" | "dvmId">): string {
  const provider = opts.dvmId ? `DVM ID '${opts.dvmId}'` : opts.dvm ? `'${opts.dvm}'` : undefined;
  return provider
    ? `No receipts stored from ${provider}. Receipts appear here after a job finishes on a DVM that issues them.`
    : "No receipts stored yet. They appear here automatically once a job finishes on a DVM that issues them — check with 'dvm describe <endpoint>'.";
}

function summaryLine(
  shown: number,
  total: number,
  opts: Pick<ReceiptsListOptions, "dvm" | "dvmId">
): string {
  const scope = opts.dvmId ? ` from DVM ID '${opts.dvmId}'` : opts.dvm ? ` from '${opts.dvm}'` : "";
  if (total === 0) return scope ? `No receipts${scope}.` : "No receipts stored yet.";
  return shown === total
    ? `${total} stored receipt${total === 1 ? "" : "s"}${scope}.`
    : `Showing the ${shown} newest of ${total} stored receipts${scope}.`;
}

/**
 * Re-read a DVM's `/v1/info` for a fresh trust anchor. Only reached via
 * `--endpoint`, because the *stored* anchor is what was live when the job ran —
 * a rotated key today doesn't retroactively invalidate a receipt from before it.
 *
 * A read that fails is reported as `endpoint_unreachable` rather than as
 * whatever the transport raised (a bare fetch `TypeError` surfacing as
 * `internal`, or `provider_error` on a non-2xx): the caller asked for one
 * specific thing and the actionable fact is that they can't have it. The
 * underlying message is kept on the hint so the cause isn't lost.
 */
async function refetchAnchor(endpointOrAlias: string): Promise<ReceiptTrustAnchor | undefined> {
  const endpoint = resolveEndpoint(endpointOrAlias);
  const transport = createDvmTransport();
  try {
    return receiptTrustFields(await transport.describe({ endpoint })).builderAnchor;
  } catch (err) {
    throw new DvmError(
      "endpoint_unreachable",
      `Could not read /v1/info from ${endpoint}.`,
      `${err instanceof Error ? err.message : String(err)}. Drop --endpoint to verify against the anchor stored when the job ran, which is the anchor this receipt should chain to anyway.`
    );
  } finally {
    transport.close();
  }
}

/**
 * Rebuild what the DVM delivered from the local message log, for the
 * `result_hash` recompute — but only when the log can be shown to be complete.
 *
 * A partial log hashes to something else, so returning one would report a sound
 * receipt as `invalid` — the single worst failure mode this command has. The
 * completeness proof: the log holds the terminal message, and its artifact
 * count matches the count the provider reported on the terminal response
 * (snapshotted on the job record as `completion`). Anything less and we return
 * `undefined`, which the verifier reports honestly as `unchecked`.
 */
function deliveredFromMessages(
  jobId: string,
  receipt: SignedJobReceipt
): DeliveredResult | undefined {
  const messages = loadMessages(jobId);
  if (messages.length === 0) return undefined;
  if (!messages.some((m) => isCompleteMessage(m) || isCancelMessage(m))) return undefined;

  const completion = loadJob(jobId)?.completion;
  // `has_artifacts` is only emitted on a completed terminal response, so a
  // failed/cancelled job has no count to check the log against.
  if (completion?.hasArtifacts === undefined) return undefined;

  const artifacts = messages.filter(isArtifactMessage);
  if (artifacts.length !== (completion.artifactCount ?? 0)) return undefined;

  return {
    // The summary counts only on `completed` — `computeResultHash` explains why.
    ...(receipt.outcome === "completed" && completion.summary !== undefined
      ? { summary: completion.summary }
      : {}),
    artifactContents: artifacts.map(artifactContent),
  };
}

function artifactContent(msg: Extract<Message, { type: "artifact" }>): JsonValue {
  return msg.content as unknown as JsonValue;
}
