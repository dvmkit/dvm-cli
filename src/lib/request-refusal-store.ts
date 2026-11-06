import {
  CONFIG_DIR,
  ensureConfigSubdir,
  isPublicRequestId,
  REQUEST_INTENTS_DIR,
} from "@dvmkit/sdk/internal";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";

/**
 * Local refusals of a `dvm request` that ran before any intent was saved.
 *
 * Kept apart from the intent store on purpose: `saveRequestIntent` claims an ID
 * by creating its directory exclusively, so a refusal record in that directory
 * would block the retry the refusal hint asks for.
 */
export const REQUEST_REFUSALS_DIR = join(CONFIG_DIR, "request-refusals");

export interface RequestRefusal {
  v: 1;
  requestId: string;
  /** Error code the CLI refused with. */
  code: string;
  /** Short machine reason from the refusal, when it carried one. */
  reason?: string;
  /** Epoch milliseconds. */
  refusedAt: number;
}

const SAFE_TOKEN = /^[a-z0-9_.:-]{1,64}$/;

/**
 * Whether this ID has, or may be about to have, a real intent. Checks the
 * directory rather than the file: an interrupted intent write leaves the
 * directory behind, and that ID must still be treated as possibly submitted.
 */
export function requestIntentMayExist(requestId: string): boolean {
  return existsSync(join(REQUEST_INTENTS_DIR, requestId));
}

/**
 * Record that the CLI refused this request ID before sending it.
 *
 * Writes nothing and returns false when an intent may exist for the ID: a rerun
 * of an already-submitted ID can reach the same refusals, and its original
 * outcome is not known to be unsent. Returns true when no intent exists, so the
 * ID was never sent, whether or not the record itself could be written.
 */
export function recordRequestRefusal(
  requestId: string,
  refusal: { code: string; reason?: unknown }
): boolean {
  if (!isPublicRequestId(requestId) || requestIntentMayExist(requestId)) return false;
  const record: RequestRefusal = {
    v: 1,
    requestId,
    code: SAFE_TOKEN.test(refusal.code) ? refusal.code : "refused",
    ...(typeof refusal.reason === "string" && SAFE_TOKEN.test(refusal.reason)
      ? { reason: refusal.reason }
      : {}),
    refusedAt: Date.now(),
  };
  try {
    ensureConfigSubdir(REQUEST_REFUSALS_DIR);
    const target = refusalPath(requestId);
    const temp = `${target}.${String(process.pid)}.tmp`;
    const fd = openSync(temp, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(record, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
  } catch {
    // The refusal output still reports the request unsent; only the later
    // lookup loses its evidence and falls back to the unknown answer.
  }
  return true;
}

/**
 * Drop the refusal for an ID once a real intent exists. Without this, losing
 * the intent later (partial restore, manual cleanup) would let the old refusal
 * tell the caller that a submitted request was never sent.
 */
export function clearRequestRefusal(requestId: string): void {
  if (!isPublicRequestId(requestId)) return;
  try {
    rmSync(refusalPath(requestId), { force: true });
  } catch {
    // Best effort: lookups read the intent first, so a leftover record is inert
    // while the intent exists.
  }
}

/** Load the refusal recorded for this ID; null when none exists or it is unreadable. */
export function loadRequestRefusal(requestId: string): RequestRefusal | null {
  if (!isPublicRequestId(requestId)) return null;
  try {
    const parsed = JSON.parse(readFileSync(refusalPath(requestId), "utf8")) as Record<string, unknown>;
    if (
      parsed.v !== 1 ||
      parsed.requestId !== requestId ||
      typeof parsed.code !== "string" ||
      typeof parsed.refusedAt !== "number" ||
      (parsed.reason !== undefined && typeof parsed.reason !== "string")
    ) {
      return null;
    }
    return parsed as unknown as RequestRefusal;
  } catch {
    return null;
  }
}

function refusalPath(requestId: string): string {
  return join(REQUEST_REFUSALS_DIR, `${requestId}.json`);
}
