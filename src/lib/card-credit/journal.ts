/**
 * The crash journal for card top-ups.
 *
 * A card top-up is presented once and charged by the DVM, so the one window
 * that can cost the caller money is a response lost after the charge. The
 * DVM books a resend of the same MPP credential, inside the challenge's five
 * minutes, against the same PaymentIntent. This journal is what lets a re-run
 * make that resend under the same fund id instead of starting a second top-up.
 *
 * It never holds the shared payment token or the credential. The token is a
 * bearer credential for a card charge, and it is rebuilt on resume from the
 * challenge recorded here plus the token the agent passes again; the SHA-256
 * values recorded here prove the rebuilt credential is the one already sent.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR, ensureConfigSubdir, normalizeCreditEndpoint } from "@dvmkit/sdk/internal";

export const CARD_FUNDINGS_DIR = join(CONFIG_DIR, "card-fundings");

export interface PendingCardFunding {
  v: 1;
  endpoint: string;
  callerPubkey: string;
  creditId: string;
  fundId: string;
  amountMicro: number;
  targetMicro: number;
  /** The DVM-issued MPP challenge, serialized. It carries no caller secret. */
  challenge: string;
  /** ISO time after which the DVM refuses a credential built on {@link challenge}. */
  challengeExpires?: string;
  /** SHA-256 hex of the shared payment token, so a resume can recognise the same approval. */
  sptSha256: string;
  /** SHA-256 hex of the credential: the `fund.commitment` already sent. */
  commitment: string;
  /** Epoch ms the credential was first presented. */
  presentedAt: number;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Written before the paid POST: the response is what goes missing, so a write after it can't help. */
export function recordPendingCardFunding(entry: PendingCardFunding): void {
  ensureConfigSubdir(CARD_FUNDINGS_DIR);
  const target = entryPath(entry.endpoint, entry.callerPubkey, entry.creditId);
  const temp = `${target}.${String(process.pid)}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(entry, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  fsyncDirectory(CARD_FUNDINGS_DIR);
}

export function loadPendingCardFunding(
  endpoint: string,
  callerPubkey: string,
  creditId: string
): PendingCardFunding | undefined {
  return readEntry(entryPath(endpoint, callerPubkey, creditId));
}

/** Every journalled card top-up for this caller at this DVM, oldest first. */
export function listPendingCardFundings(scope: {
  endpoint: string;
  callerPubkey: string;
}): PendingCardFunding[] {
  if (!existsSync(CARD_FUNDINGS_DIR)) return [];
  const endpoint = normalizeCreditEndpoint(scope.endpoint);
  return readdirSync(CARD_FUNDINGS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readEntry(join(CARD_FUNDINGS_DIR, name)))
    .filter(
      (entry): entry is PendingCardFunding =>
        entry !== undefined &&
        normalizeCreditEndpoint(entry.endpoint) === endpoint &&
        entry.callerPubkey === scope.callerPubkey
    )
    .sort((a, b) => a.presentedAt - b.presentedAt);
}

export function clearPendingCardFunding(
  entry: Pick<PendingCardFunding, "endpoint" | "callerPubkey" | "creditId">
): void {
  rmSync(entryPath(entry.endpoint, entry.callerPubkey, entry.creditId), { force: true });
}

/** True while the DVM would still accept a credential built on this entry's challenge. */
export function cardChallengeLive(entry: PendingCardFunding, now = Date.now()): boolean {
  if (!entry.challengeExpires) return false;
  const expires = Date.parse(entry.challengeExpires);
  return Number.isFinite(expires) && expires > now;
}

function entryPath(endpoint: string, callerPubkey: string, creditId: string): string {
  const key = sha256Hex(`${normalizeCreditEndpoint(endpoint)}\n${callerPubkey}\n${creditId}`);
  return join(CARD_FUNDINGS_DIR, `${key}.json`);
}

function readEntry(path: string): PendingCardFunding | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PendingCardFunding>;
    if (
      parsed.v !== 1 ||
      typeof parsed.endpoint !== "string" ||
      typeof parsed.callerPubkey !== "string" ||
      typeof parsed.creditId !== "string" ||
      typeof parsed.fundId !== "string" ||
      typeof parsed.amountMicro !== "number" ||
      typeof parsed.challenge !== "string" ||
      typeof parsed.sptSha256 !== "string" ||
      typeof parsed.commitment !== "string" ||
      typeof parsed.presentedAt !== "number"
    ) {
      return undefined;
    }
    return parsed as PendingCardFunding;
  } catch {
    return undefined;
  }
}

function fsyncDirectory(path: string): void {
  if (process.platform === "win32") return;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
