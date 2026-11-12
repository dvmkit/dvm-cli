/**
 * The crash journal for token and hosted-checkout card top-ups.
 * Checkout entries retain the fund id before session creation and the link
 * before display, so a resume can book a paid session even after link expiry.
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

import lockfile from "proper-lockfile";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  renameSync,
  linkSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { CONFIG_DIR, ensureConfigSubdir, normalizeCreditEndpoint } from "@dvmkit/sdk/internal";

export const CARD_FUNDINGS_DIR = join(CONFIG_DIR, "card-fundings");
const RETIRED_CHECKOUTS_DIR = join(CARD_FUNDINGS_DIR, "retired");
const RETIRED_CHECKOUT_TTL_MS = 24 * 60 * 60 * 1_000;

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

export interface PendingCheckoutFunding {
  v: 2;
  endpoint: string;
  callerPubkey: string;
  creditId: string;
  fundId: string;
  amountMicro: number;
  targetMicro: number;
  presentedAt: number;
  checkout?: { url: string; expires_at: number };
}

interface RetiredCheckoutFunding {
  endpoint: string;
  callerPubkey: string;
  creditId: string;
  fundId: string;
  retiredAt: number;
}

export type CardFundingEntry = PendingCardFunding | PendingCheckoutFunding;

/** Keep discovery and reservation together; network calls happen after releasing this lock. */
export async function withCardFundingLock<T>(
  scope: { endpoint: string; callerPubkey: string },
  reserve: () => T
): Promise<T> {
  ensureConfigSubdir(CARD_FUNDINGS_DIR);
  const key = sha256Hex(`${normalizeCreditEndpoint(scope.endpoint)}\n${scope.callerPubkey}`);
  const release = await lockfile.lock(join(CARD_FUNDINGS_DIR, `scope-${key}`), {
    realpath: false,
    stale: 30_000,
    retries: { retries: 100, factor: 1, minTimeout: 50, maxTimeout: 50 },
  });
  try {
    return reserve();
  } finally {
    await release();
  }
}

/** Call under the scope lock so a stale discovery cannot miss a completed intent. */
export function checkoutRetiredSince(
  scope: { endpoint: string; callerPubkey: string },
  startedAt: number
): RetiredCheckoutFunding | undefined {
  const endpoint = normalizeCreditEndpoint(scope.endpoint);
  return recentCheckoutRetirements()
    .filter((entry) => normalizeCreditEndpoint(entry.endpoint) === endpoint &&
      entry.callerPubkey === scope.callerPubkey && entry.retiredAt > startedAt)
    .sort((a, b) => b.retiredAt - a.retiredAt)[0];
}

export async function retireCheckoutFunding(entry: PendingCheckoutFunding): Promise<void> {
  await withCardFundingLock(entry, () => {
    if (loadPendingCardFunding(entry.endpoint, entry.callerPubkey, entry.creditId)?.fundId !== entry.fundId) return;
    const previous = recentCheckoutRetirements().find((retired) =>
      normalizeCreditEndpoint(retired.endpoint) === normalizeCreditEndpoint(entry.endpoint) &&
      retired.callerPubkey === entry.callerPubkey && retired.creditId === entry.creditId && retired.fundId === entry.fundId);
    ensureConfigSubdir(RETIRED_CHECKOUTS_DIR);
    const retired: RetiredCheckoutFunding = previous ?? {
      endpoint: entry.endpoint, callerPubkey: entry.callerPubkey,
      creditId: entry.creditId, fundId: entry.fundId, retiredAt: Date.now(),
    };
    const key = sha256Hex(`${normalizeCreditEndpoint(entry.endpoint)}\n${entry.callerPubkey}\n${entry.creditId}\n${entry.fundId}`);
    // Commit the fence before removing the resumable intent, including across a crash.
    writeSyncedJson(join(RETIRED_CHECKOUTS_DIR, `${key}.json`), retired);
    fsyncDirectory(CARD_FUNDINGS_DIR);
    clearPendingCardFunding(entry);
    fsyncDirectory(CARD_FUNDINGS_DIR);
  });
}

function recentCheckoutRetirements(): RetiredCheckoutFunding[] {
  if (!existsSync(RETIRED_CHECKOUTS_DIR)) return [];
  const entries: RetiredCheckoutFunding[] = [];
  let pruned = false;
  for (const name of readdirSync(RETIRED_CHECKOUTS_DIR).filter((name) => name.endsWith(".json"))) {
    const path = join(RETIRED_CHECKOUTS_DIR, name);
    let parsed: Partial<RetiredCheckoutFunding>;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RetiredCheckoutFunding>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!parsed || typeof parsed.endpoint !== "string" || typeof parsed.callerPubkey !== "string" ||
      typeof parsed.creditId !== "string" || typeof parsed.fundId !== "string" ||
      typeof parsed.retiredAt !== "number" || !Number.isSafeInteger(parsed.retiredAt)) {
      throw new Error("Invalid checkout retirement record");
    }
    if (parsed.retiredAt <= Date.now() - RETIRED_CHECKOUT_TTL_MS) {
      rmSync(path, { force: true });
      pruned = true;
    } else entries.push(parsed as RetiredCheckoutFunding);
  }
  if (pruned) fsyncDirectory(RETIRED_CHECKOUTS_DIR);
  return entries;
}

export function updatePendingCheckout(entry: PendingCheckoutFunding): void {
  const path = entryPath(entry.endpoint, entry.callerPubkey, entry.creditId);
  if (readEntry(path)?.fundId !== entry.fundId) throw new Error("Checkout journal changed during funding");
  writeSyncedJson(path, entry);
}

function writeSyncedJson(path: string, value: unknown): void {
  const temp = `${path}.${String(process.pid)}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  fsyncDirectory(dirname(path));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Written before the paid POST: the response is what goes missing, so a write
 * after it can't help. Exclusive: returns false when another run already holds
 * an entry for this credit, so two overlapping top-ups can never overwrite
 * each other's record. The entry is complete on disk before it appears under
 * its name (hard link of a synced temp file), so a reader never sees half.
 */
export function recordPendingCardFunding(entry: CardFundingEntry): boolean {
  ensureConfigSubdir(CARD_FUNDINGS_DIR);
  const target = entryPath(entry.endpoint, entry.callerPubkey, entry.creditId);
  const temp = `${target}.${String(process.pid)}.${entry.fundId}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(entry, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        linkSync(temp, target);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        // An unreadable entry protects nothing (no run can resume from it) and
        // would otherwise block this credit's card top-ups for good.
        if (attempt > 0 || readEntry(target) !== undefined) return false;
        rmSync(target, { force: true });
      }
    }
  } finally {
    rmSync(temp, { force: true });
  }
  fsyncDirectory(CARD_FUNDINGS_DIR);
  return true;
}

export function loadPendingCardFunding(
  endpoint: string,
  callerPubkey: string,
  creditId: string
): CardFundingEntry | undefined {
  return readEntry(entryPath(endpoint, callerPubkey, creditId));
}

/** Every journalled card top-up for this caller at this DVM, oldest first. */
export function listPendingCardFundings(scope: {
  endpoint: string;
  callerPubkey: string;
}): CardFundingEntry[] {
  if (!existsSync(CARD_FUNDINGS_DIR)) return [];
  const endpoint = normalizeCreditEndpoint(scope.endpoint);
  return readdirSync(CARD_FUNDINGS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readEntry(join(CARD_FUNDINGS_DIR, name)))
    .filter(
      (entry): entry is CardFundingEntry =>
        entry !== undefined &&
        normalizeCreditEndpoint(entry.endpoint) === endpoint &&
        entry.callerPubkey === scope.callerPubkey
    )
    .sort((a, b) => a.presentedAt - b.presentedAt);
}

/** Retire this entry, and only this one: a different fund id on disk belongs to another run. */
export function clearPendingCardFunding(
  entry: Pick<PendingCardFunding, "endpoint" | "callerPubkey" | "creditId" | "fundId">
): void {
  const path = entryPath(entry.endpoint, entry.callerPubkey, entry.creditId);
  if (readEntry(path)?.fundId !== entry.fundId) return;
  rmSync(path, { force: true });
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

function readEntry(path: string): CardFundingEntry | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Omit<PendingCardFunding, "v"> & Omit<PendingCheckoutFunding, "v">> & { v?: number };
    if (
      (parsed.v !== 1 && parsed.v !== 2) ||
      typeof parsed.endpoint !== "string" ||
      typeof parsed.callerPubkey !== "string" ||
      typeof parsed.creditId !== "string" ||
      typeof parsed.fundId !== "string" ||
      typeof parsed.amountMicro !== "number" ||
      (parsed.v === 1 && (typeof parsed.challenge !== "string" ||
        typeof parsed.sptSha256 !== "string" || typeof parsed.commitment !== "string")) ||
      (parsed.v === 2 && parsed.checkout !== undefined &&
        (typeof parsed.checkout.url !== "string" || !Number.isFinite(parsed.checkout.expires_at))) ||
      typeof parsed.presentedAt !== "number"
    ) {
      return undefined;
    }
    return parsed as CardFundingEntry;
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
