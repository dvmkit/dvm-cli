/**
 * Filesystem-layer diagnostics for the caller-side state tree under
 * `CONFIG_DIR` (`~/.dvm` by default; `DVM_CONFIG_DIR`-overridable).
 *
 * Two audiences:
 * - `dvm init` uses {@link detectSetupState} for the narrow first-run snapshot
 *   that flags partial-state setups on a shared workstation.
 * - `dvm doctor` uses {@link runFileChecks} for the exhaustive sweep — every
 *   caller-side file's presence, JSON parseability, and (where required) 0600
 *   file mode.
 *
 * Read-only: no disk writes, no network. Never throws — JSON-parse and stat
 * failures are surfaced as data on the returned rows.
 */

import {
  AGENT_MNEMONIC_FILE,
  BTC_RATE_FILE,
  BUDGET_FILE,
  CONFIG_AUDIT_FILE,
  CONFIG_BACKUP_FILE,
  CONFIG_DIR,
  CONFIG_FILE,
  CONFIG_PINNED_FILE,
  CREDITS_FILE,
  FAVORITES_FILE,
  FEEDBACK_NUDGES_FILE,
  IDENTITIES_FILE,
  JOBS_FILE,
  MESSAGES_DIR,
  RECEIPTS_FILE,
  RECOVERY_MNEMONIC_FILE,
  REQUEST_INTENTS_DIR,
  WALLET_FILE,
  X402_CHANNELS_FILE,
} from "@dvmkit/sdk/internal";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, join } from "path";

import { SUBMISSION_EVIDENCE_DIR } from "./submission-evidence";

/**
 * Pre-init snapshot of caller-state files under `CONFIG_DIR`. Surfaced in
 * `dvm init` output so a fresh user on a shared-agent workstation can see
 * which setup files were already there and which were missing.
 */
export interface SetupState {
  existingState: { jobs: boolean; messages: boolean };
  missing: { config: boolean; identity: boolean; wallet: boolean };
}

export function detectSetupState(): SetupState {
  return {
    existingState: {
      jobs: existsSync(JOBS_FILE),
      messages: existsSync(MESSAGES_DIR),
    },
    missing: {
      config: !existsSync(CONFIG_FILE),
      identity: !existsSync(IDENTITIES_FILE),
      wallet: !existsSync(WALLET_FILE),
    },
  };
}

/**
 * True when some caller history exists (jobs or messages) but at least one
 * core setup file (config / identity / wallet) is missing — the
 * partial-state case worth surfacing to a fresh re-init on a shared box.
 */
export function isPartialSetup(state: SetupState): boolean {
  const hasExisting = state.existingState.jobs || state.existingState.messages;
  const hasMissing = state.missing.config || state.missing.identity || state.missing.wallet;
  return hasExisting && hasMissing;
}

export function describeExisting(state: SetupState): string {
  const { jobs, messages } = state.existingState;
  if (jobs && messages) return "job and message history";
  if (jobs) return "job history";
  if (messages) return "message history";
  return "";
}

/**
 * One row in {@link runFileChecks}' exhaustive sweep. Carries everything a
 * diagnostic command (e.g. `dvm doctor`) needs to emit a structured check —
 * presence, parseability for JSON files, and POSIX mode for secrets.
 */
export interface FileCheckRow {
  name: string;
  path: string;
  exists: boolean;
  /** Whether the file's JSON content parsed cleanly. Undefined for non-JSON or absent files. */
  parseable?: boolean;
  /** Whether the file's POSIX mode is 0600. Undefined for non-secret files or absent files. */
  modeOk?: boolean;
  /** Actual POSIX mode in octal (e.g. "0644") when {@link modeOk} is defined. */
  modeOctal?: string;
  /** For a directory of secrets, each file in it whose mode is not 0600. */
  offendingPaths?: string[];
  error?: string;
}

interface FileSpec {
  name: string;
  path: string;
  json: boolean;
  secret: boolean;
  directory: boolean;
}

const FILE_SPECS: readonly FileSpec[] = [
  // 0600 since it was first written: the config carries the NWC connection
  // string, the Tempo API key and the x402 signing key in plaintext. The
  // rollback copy beside it gets its own row through `describeConfigBackup`,
  // which reports the generation without opening it.
  { name: "config", path: CONFIG_FILE, json: true, secret: true, directory: false },
  // JSONL, and 0600 because it records which rails and identities this caller
  // configures and when — behavioural state, even though it holds no values.
  { name: "config_audit", path: CONFIG_AUDIT_FILE, json: false, secret: true, directory: false },
  // The two stored copies of the configuration. `json: false`
  // because a copy deliberately retains bytes too corrupt to parse — that is
  // the case worth keeping, not a fault to report. `dvm doctor` carries their
  // recovery semantics in its own `config_rollback` / `config_pinned_snapshot`
  // rows; these are here so anything enumerating caller state sees the two
  // files that hold plaintext credentials.
  {
    name: "config_backup",
    path: CONFIG_BACKUP_FILE,
    json: false,
    secret: true,
    directory: false,
  },
  {
    name: "config_pinned",
    path: CONFIG_PINNED_FILE,
    json: false,
    secret: true,
    directory: false,
  },
  { name: "identities", path: IDENTITIES_FILE, json: true, secret: true, directory: false },
  { name: "wallet", path: WALLET_FILE, json: true, secret: true, directory: false },
  {
    name: "wallet_mnemonic",
    path: AGENT_MNEMONIC_FILE,
    json: false,
    secret: true,
    directory: false,
  },
  // Legacy caller-side mirror of the builder recovery mnemonic. The builder
  // CLI auto-migrates it to `~/.dvmkit/` on next run, but a caller-only box
  // can still carry a stale-mode copy here — doctor flags that.
  {
    name: "recovery_mnemonic",
    path: RECOVERY_MNEMONIC_FILE,
    json: false,
    secret: true,
    directory: false,
  },
  { name: "budget", path: BUDGET_FILE, json: true, secret: false, directory: false },
  // 0600 since `drainEvidence` holds DVM-signed receipts for refunds
  // still owed, which is money-recovery material and not world-readable state.
  // A store written by an older dvm keeps its old mode until the next write
  // replaces it — doctor warns, and the write repairs it.
  { name: "credits", path: CREDITS_FILE, json: true, secret: true, directory: false },
  {
    name: "x402_channels",
    path: X402_CHANNELS_FILE,
    json: true,
    secret: true,
    directory: false,
  },
  { name: "favorites", path: FAVORITES_FILE, json: true, secret: false, directory: false },
  // Feedback nudge cooldowns + intro stamp. Written 0600: the caller's own
  // behavioural record — which DVMs it talks to and when — not shared state.
  {
    name: "feedback_nudges",
    path: FEEDBACK_NUDGES_FILE,
    json: true,
    secret: true,
    directory: false,
  },
  { name: "jobs", path: JOBS_FILE, json: true, secret: false, directory: false },
  {
    name: "request_intents",
    path: REQUEST_INTENTS_DIR,
    json: false,
    secret: false,
    directory: true,
  },
  { name: "messages", path: MESSAGES_DIR, json: false, secret: false, directory: true },
  // Evidence of paid calls accepted without a settled job identity. Each file
  // is 0600 because a record can hold an anonymous job's access token, so
  // every file in the directory is checked.
  {
    name: "submission_evidence",
    path: SUBMISSION_EVIDENCE_DIR,
    json: false,
    secret: true,
    directory: true,
  },
  // JSONL, not JSON — `json: false` because a whole-file `JSON.parse` would
  // report the healthy multi-line form as corrupt. `dvm receipts list` already
  // skips malformed lines individually.
  { name: "receipts", path: RECEIPTS_FILE, json: false, secret: false, directory: false },
  { name: "btc_rate_cache", path: BTC_RATE_FILE, json: true, secret: false, directory: false },
] as const;

/**
 * Exhaustive sweep over every caller-side file/dir under `CONFIG_DIR`.
 * For JSON files, attempts `JSON.parse` and reports `parseable: false` with
 * the underlying error on a corrupt body. For the 0600 secrets (identities,
 * wallet, wallet_mnemonic, recovery_mnemonic, credits, x402_channels), reads
 * `statSync().mode & 0o777` and reports `modeOk = (mode === 0o600)` with the
 * actual mode in `modeOctal` so a stale-permissions case shows up clearly.
 *
 * Never throws — every per-file failure is recorded on the row.
 */
export function runFileChecks(): FileCheckRow[] {
  return FILE_SPECS.map(checkOne);
}

/**
 * One `credits.json.corrupt-*` file set aside under `CONFIG_DIR` by the
 * credit store's quarantine path.
 */
export interface QuarantinedCreditStore {
  path: string;
  name: string;
}

/**
 * List every quarantined prepaid-credit store under `CONFIG_DIR`, newest first.
 *
 * A `credits.json` whose bytes will not parse is renamed rather than
 * overwritten, because it may hold `drainEvidence` — the DVM-signed receipts
 * proving a refund is still owed. The `credit_store_corrupt` error names the
 * path once, and from the next invocation on the CLI reads an empty store and
 * says nothing, so `dvm doctor` is the standing pointer back to those bytes
 * *
 * Unlike {@link runFileChecks}' fixed sweep this result is variable-length, so
 * it is its own scan. Ordering is by the quarantine stamp in the name, not
 * `mtime`: `renameSync` carries the *original* file's mtime across, which is
 * the last write to the store rather than the moment it was set aside.
 *
 * Never throws — an absent or unreadable `CONFIG_DIR` yields no entries.
 */
export function findQuarantinedCreditStores(): QuarantinedCreditStore[] {
  const prefix = `${basename(CREDITS_FILE)}.corrupt-`;
  let entries: string[];
  try {
    entries = readdirSync(CONFIG_DIR);
  } catch {
    return [];
  }
  return (
    entries
      .filter((name) => name.startsWith(prefix))
      // Codepoint order, not `localeCompare`: the stamps differ only in digits
      // and separators, which a locale collation is free to reorder.
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
      .map((name) => ({ path: join(CONFIG_DIR, name), name }))
  );
}

function checkOne(spec: FileSpec): FileCheckRow {
  const exists = existsSync(spec.path);
  if (!exists) {
    return { name: spec.name, path: spec.path, exists: false };
  }

  const row: FileCheckRow = { name: spec.name, path: spec.path, exists: true };

  if (spec.json) {
    try {
      JSON.parse(readFileSync(spec.path, "utf-8"));
      row.parseable = true;
    } catch (err) {
      row.parseable = false;
      row.error = err instanceof Error ? err.message : String(err);
    }
  }

  if (spec.secret && spec.directory) {
    checkSecretDirectory(spec.path, row);
  } else if (spec.secret) {
    try {
      const mode = statSync(spec.path).mode & 0o777;
      const modeOctal = octalMode(mode);
      row.modeOk = mode === 0o600;
      row.modeOctal = modeOctal;
      if (!row.modeOk && !row.error) {
        row.error = `expected mode 0600, found ${modeOctal}`;
      }
    } catch (err) {
      row.modeOk = false;
      row.error = err instanceof Error ? err.message : String(err);
    }
  }

  return row;
}

function checkSecretDirectory(dir: string, row: FileCheckRow): void {
  try {
    const offenders: { path: string; modeOctal: string }[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      const mode = stat.mode & 0o777;
      if (mode !== 0o600) offenders.push({ path, modeOctal: octalMode(mode) });
    }
    row.modeOk = offenders.length === 0;
    if (offenders.length > 0) {
      row.modeOctal = offenders[0]!.modeOctal;
      row.offendingPaths = offenders.map((o) => o.path);
      row.error = `expected mode 0600, found ${row.modeOctal} on ${String(offenders.length)} file(s)`;
    }
  } catch (err) {
    row.modeOk = false;
    row.error = err instanceof Error ? err.message : String(err);
  }
}

function octalMode(mode: number): string {
  return "0" + mode.toString(8).padStart(3, "0");
}

/**
 * Read the timestamp of the last successful BTC/USD rate fetch from the
 * on-disk cache. Returns null when the cache file is absent, unreadable, or
 * malformed. Stale-cache detection lives in the caller (e.g. `dvm doctor`)
 * so each consumer can pick its own freshness threshold.
 */
export function readBtcRateCacheAge(now: number = Date.now()): { ageMs: number } | null {
  if (!existsSync(BTC_RATE_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(BTC_RATE_FILE, "utf-8")) as { timestamp?: number };
    if (typeof data.timestamp !== "number") return null;
    return { ageMs: now - data.timestamp };
  } catch {
    return null;
  }
}
