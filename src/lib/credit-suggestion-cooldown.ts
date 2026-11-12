/**
 * When the prepaid-credit suggestion may be shown again at a DVM.
 *
 * The suggestion is an offer, and an offer repeated on every priced request
 * stops being read and starts being obeyed, so it is shown at most once per
 * DVM per {@link CREDIT_SUGGESTION_COOLDOWN_MS}. The record lives in
 * `credit-suggestions.json` beside `credits.json` under `CONFIG_DIR`, so a
 * fresh state directory starts with no memory. Keyed by endpoint origin, the
 * same normalization the credit store uses, so a handle and a capability URL
 * at one host share one cooldown.
 */

import { CONFIG_DIR, ensureConfigDir, normalizeCreditEndpoint } from "@dvmkit/sdk/internal";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

export const CREDIT_SUGGESTIONS_FILE = join(CONFIG_DIR, "credit-suggestions.json");

export const CREDIT_SUGGESTION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/** True when no suggestion was recorded for this DVM inside the cooldown. */
export function creditSuggestionDue(endpoint: string, now: number = Date.now()): boolean {
  const shownAt = loadState()[normalizeCreditEndpoint(endpoint)];
  if (shownAt === undefined) return true;
  const at = Date.parse(shownAt);
  // A stamp in the future (a clock set back, a hand edit) is no memory, not a
  // cooldown that outlasts its week.
  return !Number.isFinite(at) || at > now || now - at >= CREDIT_SUGGESTION_COOLDOWN_MS;
}

/**
 * Stamp a shown suggestion. Best-effort: the job it rides on is already paid,
 * and a lost stamp costs at most one repeated offer.
 */
export function recordCreditSuggestionShown(endpoint: string, now: number = Date.now()): void {
  try {
    const state = loadState();
    state[normalizeCreditEndpoint(endpoint)] = new Date(now).toISOString();
    saveState(state);
  } catch {
    // Cooldown bookkeeping only.
  }
}

type SuggestionState = Record<string, string>;

/** Absent, unparseable or wrong-shaped bytes read as no memory, never as a failure. */
function loadState(): SuggestionState {
  if (!existsSync(CREDIT_SUGGESTIONS_FILE)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(CREDIT_SUGGESTIONS_FILE, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
  } catch {
    return {};
  }
}

/**
 * Atomic tmp+rename write, mode 0600, pid-suffixed tmp: the credit-store
 * pattern. Written under no lock, so two concurrent invocations each publish
 * a whole file and the later one wins, never a torn one.
 */
function saveState(state: SuggestionState): void {
  ensureConfigDir();
  const tmp = `${CREDIT_SUGGESTIONS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  try {
    renameSync(tmp, CREDIT_SUGGESTIONS_FILE);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw err;
  }
}
