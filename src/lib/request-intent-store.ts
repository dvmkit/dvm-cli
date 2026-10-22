import type { SignedRequestAudience } from "@dvmkit/sdk";
import {
  DvmError,
  ensureConfigSubdir,
  isPublicRequestId,
  type JobPolicy,
  type ReceiptTrustAnchor,
  REQUEST_INTENTS_DIR,
} from "@dvmkit/sdk/internal";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { join } from "path";

export interface RequestIntent {
  v: 2;
  requestId: string;
  /** Provider endpoint that accepted or may have accepted the request. */
  endpoint: string;
  dvmId?: string;
  capability: string;
  /** Original wire body with the expiring auth envelope removed. */
  body: Record<string, unknown>;
  /** x-only caller public key that signed the original body. */
  callerPubkey: string;
  policy: JobPolicy;
  pinnedMint?: string;
  /** Fail-closed direct-Cashu mode marker. */
  strictPerCall?: true;
  maxCashuFeeSats?: number;
  /** Whether the provider advertised terminal signed receipts. */
  receiptsSupported?: boolean;
  /** Builder trust anchor advertised when the request began. */
  builderAnchor?: ReceiptTrustAnchor;
  /** Audience advertised when the original v2 proof was created. */
  authAudience: SignedRequestAudience;
  /** Epoch milliseconds when the intent became durable. */
  createdAt: number;
}

/**
 * Persist one request intent before any submit or payment mutation.
 *
 * The per-id directory is created exclusively, so a concurrent process cannot
 * reuse the same id. The file is fsynced before this returns; an interrupted
 * write leaves the directory behind and future callers fail closed rather than
 * treating the id as unused.
 */
export function saveRequestIntent(intent: RequestIntent): boolean {
  assertRequestId(intent.requestId);
  assertNoPaymentOrAuthSecrets(intent.body);
  ensureConfigSubdir(REQUEST_INTENTS_DIR);
  const dir = intentDirectory(intent.requestId);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  fsyncDirectory(REQUEST_INTENTS_DIR);

  const temp = join(dir, `intent.${String(process.pid)}.tmp`);
  const target = join(dir, "intent.json");
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(intent, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  fsyncDirectory(dir);
  return true;
}

/** Load a durable request intent, or null when this id was never recorded locally. */
export function loadRequestIntent(requestId: string): RequestIntent | null {
  assertRequestId(requestId);
  const dir = intentDirectory(requestId);
  if (!existsSync(dir)) return null;
  const path = join(dir, "intent.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRequestIntent(parsed) || parsed.requestId !== requestId)
      throw new Error("invalid shape");
    return parsed;
  } catch (error) {
    throw new DvmError(
      "request_intent_unreadable",
      `The saved request intent for ${requestId} is incomplete or unreadable.`,
      "Do not submit a replacement request. The provider may already have accepted and charged the original; restore this intent from backup before using request-result.",
      { request_id: requestId, cause: error instanceof Error ? error.message : String(error) }
    );
  }
}

function assertNoPaymentOrAuthSecrets(body: Record<string, unknown>): void {
  if (!containsForbiddenSecret(body)) return;
  throw new DvmError(
    "request_intent_contains_secret",
    "Request recovery cannot persist a payment credential, bearer token, or request auth signature.",
    "No payment was attempted. Remove the secret-bearing input or omit --request-id."
  );
}

function containsForbiddenSecret(value: unknown): boolean {
  if (typeof value === "string") return /^Bearer\s/i.test(value);
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsForbiddenSecret);
  const record = value as Record<string, unknown>;
  if (["pubkey", "timestamp", "nonce", "signature"].every((key) => Object.hasOwn(record, key))) {
    return true;
  }
  const forbidden = new Set([
    "authorization",
    "bearer_token",
    "access_token",
    "cashu_token",
    "x402_payment",
    "tempo_credential",
  ]);
  return Object.entries(record).some(
    ([key, child]) => forbidden.has(key.toLowerCase()) || containsForbiddenSecret(child)
  );
}

function assertRequestId(requestId: string): void {
  if (isPublicRequestId(requestId)) return;
  throw new DvmError(
    "invalid_request_id",
    "Invalid request id.",
    "Use 1–128 characters: letters, digits, dot, underscore, colon, or hyphen."
  );
}

function intentDirectory(requestId: string): string {
  return join(REQUEST_INTENTS_DIR, requestId);
}

function fsyncDirectory(path: string): void {
  // Windows keeps synced file contents and atomic replacement; equivalent
  // directory-entry crash durability is not established there.
  if (process.platform === "win32") return;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isRequestIntent(value: unknown): value is RequestIntent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.v === 2 &&
    isPublicRequestId(candidate.requestId) &&
    typeof candidate.endpoint === "string" &&
    typeof candidate.capability === "string" &&
    typeof candidate.callerPubkey === "string" &&
    isSignedRequestAudience(candidate.authAudience) &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.body === "object" &&
    candidate.body !== null &&
    !Array.isArray(candidate.body) &&
    typeof candidate.policy === "object" &&
    candidate.policy !== null
  );
}

function isSignedRequestAudience(value: unknown): value is SignedRequestAudience {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.dvm_id === "string" && typeof candidate.builder_pubkey === "string";
}
