import { probeRailLabel, railLabelAtSentenceStart } from "../lib/rail-labels";
import { parseBudget } from "../lib/currency";
import {
  nwcRejectionDisplay,
  rpcEndpointSuffix,
  tempoKeyImportRoutes,
  unreachableRailDisplay,
  unreachableRailHint,
} from "../lib/wallet-rail-copy";
import {
  AGENT_MNEMONIC_FILE,
  checkMintHealth,
  CONFIG_DIR,
  CONFIG_FILE,
  type ConfigDirModeResult,
  CREDIT_FUND_RAILS,
  DvmError,
  fetchBtcUsdRate,
  isCreditFundRail,
  listTempoChannelAssociations,
  listX402Channels,
  loadAgentWallet,
  loadIdentities,
  loadTempoChannelController,
  parseNwcUri,
  RAIL_FLAGS,
  repairConfigDirMode,
  resolveTempoAsset,
  resolveTempoNetwork,
  resolveX402Asset,
  shellQuoteArg,
  type StoredX402ChannelMetadata,
  TEMPO_CHANNELS_FILE,
  tempoChannelControlledBy,
  X402_CHANNELS_FILE,
  x402ChannelControlledBy,
} from "@dvmkit/sdk/internal";
import {
  type Config,
  CREDIT_POSTURES,
  FEEDBACK_POSTURES,
  isCreditPosture,
  isFeedbackPosture,
  loadConfig,
} from "../lib/identity";
import {
  configSnapshotPath,
  type ConfigSnapshotSlot,
  describeConfigBackup,
} from "../lib/config-mutation";
import {
  connectedTempoAccount,
  tempoWrongAssetHint,
} from "../lib/payment-rails/tempo-wallet";
import {
  connectedX402Payer,
} from "../lib/x402/wallet";
import {
  info,
  json,
} from "../lib/output";
import {
  probeWallets,
  type RailProbe,
} from "../lib/wallet-probe";
import {
  x402WrongAssetHint,
} from "../lib/x402/asset";
import { loadConfiguredMints } from "../lib/wallet-agent/mint-inventory";
import { loadLedger } from "../lib/budget-ledger";
import { NWC_FUNDING_FLOAT_ROLE } from "../lib/float";

import { checkBuildFreshness } from "../lib/build-freshness";
import {
  detectSetupState,
  type FileCheckRow,
  findQuarantinedCreditStores,
  isPartialSetup,
  readBtcRateCacheAge,
  runFileChecks,
} from "../lib/caller-state";
import { CALLER_VERSION } from "../lib/caller-version";
import { resolveDvmReference } from "../lib/dvm-identifier";
import { resolveEndpoint } from "../lib/favorites";
import { dvmFetch } from "../lib/http";
import { describeMnemonicBackups } from "../lib/mnemonic-backups";
import { describePendingSubmissions } from "../lib/wallet-agent/submissions-view";
import {
  tempoAccountNetwork,
  tempoNetworkFromChainId,
  tempoNetworkLabel,
} from "../lib/tempo-network";
import { assertTempoBalanceRpcNetwork } from "../lib/tempo-rpc";

/** Stale-threshold for the on-disk BTC/USD cache before doctor warns (1 day). */
const BTC_RATE_STALE_MS = 24 * 60 * 60 * 1000;

const DEFAULT_PROBE_TIMEOUT_MS = 3000;

export interface DoctorOptions {
  human?: boolean;
  /**
   * Toggle for live network probes. Set to `false` via commander's
   * `--no-network` flag for a fast local-only sweep (no rail probes, no BTC
   * rate fetch, no mint /v1/info hits). Defaults to `true`.
   */
  network?: boolean;
  /** Optional DVM endpoint, alias, favorite, or qualified selector to compare with the wallet. */
  target?: string;
}

export interface DoctorCheck {
  name: string;
  group: "files" | "config" | "wallets" | "network";
  /** Traffic-light status. `ok` = clean, `warn` = working-but-suspect, `fail` = broken. */
  status: "ok" | "warn" | "fail";
  display: string;
  /** Suggested next-step (typically a CLI command). Omitted on `ok`. */
  hint?: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  summary: { ok: number; warn: number; fail: number };
  configDir: string;
  cliVersion: string;
  nodeVersion: string;
}

/**
 * Diagnose caller-side state. Invalid arguments throw before any checks begin;
 * after that, every failed diagnostic surfaces as a `status: "fail"` row so
 * the report always completes. Exits with code 1 when `summary.fail > 0` so
 * shell users can chain `dvm doctor && dvm request …`.
 *
 * One deliberate write: doctor tightens a group/other-accessible `CONFIG_DIR`
 * back to 0700 and reports that it did. It is the early path an
 * existing install actually reaches, and mode-on-create can never repair a
 * directory that already exists.
 */
export async function doctor(opts: DoctorOptions): Promise<void> {
  if (opts.target && opts.network === false) {
    throw new DvmError(
      "invalid_argument",
      "A doctor target cannot be combined with --no-network.",
      "Remove --no-network to inspect the target, or omit the target to run local-only checks."
    );
  }

  const checks: DoctorCheck[] = [];

  checks.push(buildConfigDirModeCheck(repairConfigDirMode()));
  checks.push(...buildFileChecks());
  checks.push(...buildConfigChecks());
  // Local read of the wallet file, so it runs even under --no-network: stranded
  // sats are exactly what a user reaches for doctor to explain.
  checks.push(buildPendingSubmissionCheck());
  checks.push(buildPendingMeltCheck());
  // Also a local read, and also a state nothing else explains: a recorded Tempo
  // channel outlives the key that opened it, and the caller has no other way to
  // learn that the collateral a row reports is unreachable from here.
  checks.push(...(await buildTempoChannelOwnerChecks()));
  checks.push(...(await buildX402ChannelOwnerChecks()));

  const runNetwork = opts.network !== false;
  if (runNetwork) {
    const [walletChecks, networkChecks, targetCheck] = await Promise.all([
      buildWalletChecks(),
      buildNetworkChecks(),
      opts.target ? checkTempoTargetNetwork(opts.target) : Promise.resolve(undefined),
    ]);
    checks.push(...walletChecks, ...networkChecks);
    if (targetCheck) checks.push(targetCheck);
  }

  const summary = countSummary(checks);

  const report: DoctorReport = {
    checks,
    summary,
    configDir: CONFIG_DIR,
    cliVersion: CALLER_VERSION,
    nodeVersion: process.version,
  };

  if (opts.human) {
    renderHuman(report, runNetwork);
  } else {
    json(report);
  }

  if (summary.fail > 0) {
    process.exitCode = 1;
  }
}

// --- Files group ---

/**
 * Report (and, when it was loose, having just repaired) the mode on
 * `CONFIG_DIR` itself. The secrets underneath are independently 0600, so a
 * loose directory is never `fail` — what it costs is the isolation layer that
 * keeps a second local user from listing which rails you have configured.
 */
function buildConfigDirModeCheck(result: ConfigDirModeResult): DoctorCheck {
  const details: Record<string, unknown> = { path: result.path, modeOctal: result.modeOctal };

  if (result.skippedNonPosix) {
    return {
      name: "config_dir_mode",
      group: "files",
      status: "ok",
      display: "Config directory permissions are not enforced on this platform.",
      details: { ...details, platform: process.platform },
    };
  }

  if (!result.exists) {
    return {
      name: "config_dir_mode",
      group: "files",
      status: "ok",
      display: result.error
        ? `Could not read the permissions on ${result.path}.`
        : `Config directory ${result.path} does not exist yet — 'dvm init' creates it owner-only.`,
      ...(result.error ? { hint: `Check that ${result.path} is readable.` } : {}),
      details: { ...details, exists: false, ...(result.error ? { error: result.error } : {}) },
    };
  }

  if (result.repaired) {
    return {
      name: "config_dir_mode",
      group: "files",
      status: "ok",
      display: `Config directory ${result.path} was readable by other users on this machine (${result.previousModeOctal}) — tightened to 0700.`,
      details: { ...details, repaired: true, previousModeOctal: result.previousModeOctal },
    };
  }

  if (result.error) {
    return {
      name: "config_dir_mode",
      group: "files",
      status: "warn",
      display: `Config directory ${result.path} is readable by other users on this machine (${result.modeOctal}) and could not be tightened automatically.`,
      hint: `Tighten it yourself: chmod 700 ${result.path}`,
      details: { ...details, error: result.error },
    };
  }

  return {
    name: "config_dir_mode",
    group: "files",
    status: "ok",
    display: `Config directory ${result.path} is owner-only (${result.modeOctal}).`,
    details,
  };
}

function buildFileChecks(): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  let rows: FileCheckRow[];
  try {
    rows = runFileChecks();
  } catch (err) {
    return [
      {
        name: "files_scan",
        group: "files",
        status: "fail",
        display: "Could not enumerate caller-state files.",
        hint: "Check filesystem permissions on the config directory.",
        details: { error: err instanceof Error ? err.message : String(err) },
      },
    ];
  }

  for (const row of rows) {
    checks.push(fileRowToCheck(row));
  }

  checks.push(buildConfigRollbackCheck("backup"));
  checks.push(buildConfigRollbackCheck("pinned"));

  try {
    const warning = describeMnemonicBackups(AGENT_MNEMONIC_FILE);
    if (warning) {
      checks.push({
        name: "mnemonic_backups",
        group: "files",
        status: "warn",
        ...warning,
      });
    }
  } catch (err) {
    checks.push({
      name: "mnemonic_backups",
      group: "files",
      status: "fail",
      display: `Could not check ${CONFIG_DIR} for plaintext recovery-mnemonic backups.`,
      hint: `Check that ${CONFIG_DIR} is readable.`,
      details: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  const quarantined = buildQuarantinedCreditCheck();
  if (quarantined) checks.push(quarantined);

  try {
    const state = detectSetupState();
    if (isPartialSetup(state)) {
      checks.push({
        name: "partial_setup_state",
        group: "files",
        status: "warn",
        display: "Caller history (jobs / messages) is present but core setup files are missing.",
        hint: "Run 'dvm init' to recreate the missing config, identity, and wallet without touching existing history.",
        details: { existingState: state.existingState, missing: state.missing },
      });
    }
  } catch {
    // detectSetupState only does existsSync; if even that throws we're already
    // in trouble — the file rows above will have already surfaced the cause.
  }

  checks.push(buildStaleBuildCheck());

  return checks;
}

/**
 * Surface every `credits.json.corrupt-*` file the credit store set aside, as a
 * standing warning.
 *
 * The quarantine names its path once, in the `credit_store_corrupt`
 * error that throws at the moment of the torn read; from the next invocation on
 * the CLI reads an empty store and says nothing. Those bytes can hold
 * `drainEvidence` — DVM-signed receipts proving a refund is still owed — so
 * doctor is the second chance for an agent that relayed the error once or a
 * human who scrolled past it.
 *
 * `warn`, never `fail`: a quarantined file is a preserved artifact rather than
 * a broken install, and `dvm doctor && dvm request …` must keep working. No row
 * at all when there is nothing set aside — unlike the fixed file rows, an "all
 * clear" here would be a row about a file that has never existed.
 */
function buildQuarantinedCreditCheck(): DoctorCheck | null {
  const found = findQuarantinedCreditStores();
  if (found.length === 0) return null;

  const paths = found.map((f) => f.path);
  const single = found.length === 1;

  return {
    name: "credits_quarantined",
    group: "files",
    status: "warn",
    display: single
      ? `A damaged copy of your prepaid-credit record is set aside at ${paths[0]} — it may hold signed proof of a refund you are owed.`
      : `${found.length} damaged copies of your prepaid-credit record are set aside under ${CONFIG_DIR} (newest ${found[0].name}) — they may hold signed proof of a refund you are owed.`,
    hint: single
      ? `Do not delete ${paths[0]} — it may hold DVM-signed drain receipts for a refund that is still owed. Balances themselves live on the DVM, so 'dvm credit balance <dvm>' re-reads them.`
      : `Do not delete them — each may hold DVM-signed drain receipts for a refund that is still owed; list them with 'ls ${CONFIG_DIR}/credits.json.corrupt-*'. Balances themselves live on the DVM, so 'dvm credit balance <dvm>' re-reads them.`,
    details: { count: found.length, paths },
  };
}

/**
 * Warn when the `dvm` binary on PATH is older than the checkout it was built
 * from.
 *
 * Never `fail` — a stale build still works, and `dvm doctor && dvm request`
 * has to keep working. Always emits a row, including the benign
 * `not_applicable` case, so an agent reading the envelope can tell "checked
 * and fine" from "never checked".
 */
function buildStaleBuildCheck(): DoctorCheck {
  let freshness;
  try {
    freshness = checkBuildFreshness();
  } catch (err) {
    return {
      name: "cli_build_stale",
      group: "files",
      status: "warn",
      display:
        "Could not tell whether the dvm build you are running is up to date with its source.",
      hint: "If you installed from a checkout, rebuild with 'npm run install-cli' from the repo root.",
      details: { error: err instanceof Error ? err.message : String(err) },
    };
  }

  if (freshness.status === "not_applicable") {
    return {
      name: "cli_build_stale",
      group: "files",
      status: "ok",
      display:
        freshness.skipReason === "no_source_tree"
          ? "Running an installed dvm package — there is no source checkout beside it to be out of date with."
          : "Running dvm straight from source, so there is no build to be out of date.",
      details: { skipped: freshness.skipReason },
    };
  }

  if (freshness.status === "fresh") {
    return {
      name: "cli_build_stale",
      group: "files",
      status: "ok",
      display: `The dvm build you are running is current with its source (built ${freshness.builtAt?.slice(0, 10)}).`,
      details: {
        bundlePath: freshness.bundlePath,
        builtAt: freshness.builtAt,
        buildAgeDays: freshness.buildAgeDays,
      },
    };
  }

  const age = freshness.buildAgeDays;
  const ageText = age === 0 ? "today" : `${age} day${age === 1 ? "" : "s"} ago`;
  return {
    name: "cli_build_stale",
    group: "files",
    status: "warn",
    display: `The dvm you are running was built ${ageText} (${freshness.builtAt?.slice(0, 10)}) and its source has changed since — you are not running the code in your checkout.`,
    hint: "Rebuild it: 'npm run install-cli' from the repo root (not from a worktree — it relinks the global binary).",
    details: {
      bundlePath: freshness.bundlePath,
      builtAt: freshness.builtAt,
      buildAgeDays: freshness.buildAgeDays,
      newestSourceAt: freshness.newestSourceAt,
      newerPaths: freshness.newerPaths,
    },
  };
}

/**
 * Report a stored copy of the configuration: that there is one, when
 * it was taken, and whether it is owner-only.
 *
 * Two slots, two rows. `backup` rolls — it is the state before the last change.
 * `pinned` does not: `dvm config reset` puts the settings it cleared there, and
 * nothing but an explicit restore removes it, so a caller can find their way
 * back long after the command that cleared them.
 *
 * Never the contents. Both copies carry the same NWC connection string and
 * signing keys the live config does, so a diagnostic surface has to be able to
 * say a copy exists without any path by which it reaches output — the same
 * reason the builder side flags a leftover plaintext `.bak` rather than reading
 * one.
 */
function buildConfigRollbackCheck(slot: ConfigSnapshotSlot): DoctorCheck {
  const name = slot === "pinned" ? "config_pinned_snapshot" : "config_rollback";
  const label = slot === "pinned" ? "pinned snapshot" : "rollback copy";
  const backup = describeConfigBackup(slot);

  if (!backup) {
    return {
      name,
      group: "files",
      status: "ok",
      display: `No ${label} of the local configuration is stored.`,
      details: { path: configSnapshotPath(slot), slot, exists: false },
    };
  }

  const details = {
    path: backup.path,
    slot,
    exists: true,
    modifiedAt: backup.modifiedAt,
    bytes: backup.bytes,
    modeOctal: backup.modeOctal,
  };

  if (!backup.ownerOnly) {
    return {
      name,
      group: "files",
      status: "warn",
      display: `The ${label} of your configuration at ${backup.path} is readable by other users on this machine (${backup.modeOctal ?? "?"}), and it holds the same wallet credentials the live configuration does.`,
      hint: `Tighten permissions: chmod 600 ${backup.path}`,
      details,
    };
  }

  // Deliberately not "copy it back over config.json": a hand `cp`
  // writes no audit line, does not rotate the rolling copy — so the manual
  // restore is not itself undoable — and skips the check that would refuse
  // while a channel still holds funds only the key being restored away can move.
  const provenance =
    slot === "pinned"
      ? `A ${label} of the settings as they stood before you last ran 'dvm config reset' is stored at ${backup.path} (taken ${backup.modifiedAt}).`
      : `A ${label} of the configuration as it stood before the last change is stored at ${backup.path} (taken ${backup.modifiedAt}).`;
  const restore = `'dvm config rollback${slot === "pinned" ? " --slot pinned" : ""}' says what restoring it would change before it changes anything, and '--yes' carries it out.`;

  return {
    name,
    group: "files",
    status: "ok",
    display: `${provenance} ${restore}`,
    details,
  };
}

function fileRowToCheck(row: FileCheckRow): DoctorCheck {
  // Absent files are fine; presence isn't required.
  if (!row.exists) {
    return {
      name: `file_${row.name}`,
      group: "files",
      status: "ok",
      display: `${row.name} not present (optional).`,
      details: { path: row.path, exists: false },
    };
  }

  if (row.parseable === false) {
    return {
      name: `file_${row.name}`,
      group: "files",
      status: "fail",
      display: `${row.name} file is not valid JSON.`,
      hint: hintForCorruptFile(row.name),
      details: { path: row.path, error: row.error },
    };
  }

  // 0600 violations are a warning (file works, but secrets are world-readable).
  if (row.modeOk === false) {
    const offending = row.offendingPaths;
    return {
      name: `file_${row.name}`,
      group: "files",
      status: "warn",
      display: offending
        ? `${row.name} holds ${String(offending.length)} file(s) with permissions other than 0600 (first: ${row.modeOctal ?? "?"}).`
        : `${row.name} has permissions ${row.modeOctal ?? "?"} (expected 0600).`,
      hint: `Tighten permissions: chmod 600 ${offending ? offending.map(shellQuoteArg).join(" ") : row.path}`,
      details: {
        path: row.path,
        modeOctal: row.modeOctal,
        ...(offending ? { offending_paths: offending } : {}),
      },
    };
  }

  return {
    name: `file_${row.name}`,
    group: "files",
    status: "ok",
    display: `${row.name} present and well-formed.`,
    details: {
      path: row.path,
      ...(row.parseable !== undefined ? { parseable: row.parseable } : {}),
      ...(row.modeOctal !== undefined ? { modeOctal: row.modeOctal } : {}),
    },
  };
}

function hintForCorruptFile(name: string): string {
  switch (name) {
    case "config": {
      const rolling = describeConfigBackup();
      const backup = rolling ?? describeConfigBackup("pinned");
      return backup
        ? `Run 'dvm config rollback${rolling ? "" : " --slot pinned"}' to see what restoring the stored copy at ${backup.path} would change, then '--yes' to carry it out. Failing that, move ${CONFIG_FILE} aside and run 'dvm init'.`
        : `Move ${CONFIG_FILE} aside and run 'dvm init'. Reconnecting each wallet and re-importing the x402 key is the cost; nothing else under ~/.dvm is affected.`;
    }
    case "identities":
      return "Restore from backup or delete the file and run 'dvm identity create <name>'.";
    case "wallet":
      return "Restore the wallet from your mnemonic with 'dvm wallet restore'.";
    case "budget":
      return "Reset budgets with 'dvm budget set --clear', then re-add desired caps.";
    case "favorites":
      return "Restore ~/.dvm/favorites.json from backup, or move it aside before re-adding favorites with 'dvm fav add'.";
    case "jobs":
      return "Job history is non-critical; delete ~/.dvm/jobs.json to clear it.";
    case "btc_rate_cache":
      return "Delete ~/.dvm/btc-rate.json; it will be re-fetched on the next command.";
    // Deliberately not "delete it": the file may hold DVM-signed drain
    // receipts for a refund still owed. The next dvm command moves it aside
    // under a credits.json.corrupt-* name and reports where.
    case "credits":
      return "Do not delete ~/.dvm/credits.json — it may hold signed proof of a refund you are owed. The next dvm command sets it aside as ~/.dvm/credits.json.corrupt-* and names the path; balances re-read from each DVM with 'dvm credit balance <dvm>'.";
    default:
      return `Restore from a backup or delete the file to let dvm recreate it.`;
  }
}

// --- Config group ---

function buildConfigChecks(): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  let config: Config | null;
  try {
    config = loadConfig();
  } catch (err) {
    return [
      {
        name: "config_parse",
        group: "config",
        status: "fail",
        display: "Could not load config.json.",
        // Never "reinitialise": the bytes that will not parse still hold the
        // only copy of the NWC string and both private keys, and a fresh config
        // written over them is the incident by another route. Restore,
        // or move the file aside deliberately.
        hint: `Restore a stored copy with 'dvm config rollback' ('--slot pinned' for the snapshot a reset took). Failing that, move ${CONFIG_FILE} aside yourself and run 'dvm init' — a wallet reconnect and a key re-import are the cost, and the existing wallet and identities files are untouched either way.`,
        details: { error: err instanceof Error ? err.message : String(err) },
      },
    ];
  }

  if (!config) {
    checks.push({
      name: "config_present",
      group: "config",
      status: "warn",
      display: "No config.json yet.",
      hint: "Run 'dvm init' to create one.",
    });
    return checks;
  }

  if (config.nwcUri) {
    checks.push(checkNwcUri(config.nwcUri));
  }

  if (config.defaultBudget !== undefined) {
    checks.push(checkBudgetField("default_budget", "defaultBudget", config.defaultBudget));
  }
  if (config.autoPayThreshold !== undefined) {
    checks.push(
      checkBudgetField("auto_pay_threshold", "autoPayThreshold", config.autoPayThreshold)
    );
  }

  if (config.defaultRail !== undefined) {
    checks.push(checkDefaultRail(config.defaultRail));
  }

  if (config.defaultIdentity !== undefined) {
    checks.push(checkDefaultIdentity(config.defaultIdentity));
  }

  if (config.cashuMints?.length) {
    checks.push(...checkCashuMintUrls(config.cashuMints));
  }

  if (config.x402 !== undefined) {
    checks.push(checkX402Shape(config.x402));
  }
  if (config.tempo !== undefined) {
    checks.push(checkTempoShape(config.tempo));
  }
  if (config.credit !== undefined) {
    checks.push(checkCreditShape(config.credit));
  }
  if (config.feedback !== undefined) {
    checks.push(checkFeedbackShape(config.feedback));
  }

  return checks;
}

function checkNwcUri(uri: string): DoctorCheck {
  try {
    parseNwcUri(uri);
    return {
      name: "config_nwc_uri",
      group: "config",
      status: "ok",
      display: "NWC connection string parses cleanly.",
    };
  } catch (err) {
    return {
      name: "config_nwc_uri",
      group: "config",
      status: "fail",
      display: "NWC connection string is malformed.",
      hint: "Re-run 'dvm wallet connect' with a fresh string from your wallet, piped in rather than typed as an argument.",
      details: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

function checkBudgetField(checkName: string, field: string, value: string): DoctorCheck {
  // For raw-msats values the rate doesn't matter; pass 1 as a no-op rate.
  // For $-prefixed values we still need a rate to translate to msats — try
  // with rate=1 first; on success we know the format parses.
  try {
    parseBudget(value, 1);
    return {
      name: `config_${checkName}`,
      group: "config",
      status: "ok",
      display: `${field} (${value}) parses cleanly.`,
    };
  } catch (err) {
    return {
      name: `config_${checkName}`,
      group: "config",
      status: "fail",
      display: `${field} (${value}) is not a valid budget string.`,
      hint: "Use a raw msats integer (e.g. '5000') or a USD string (e.g. '$0.50').",
      details: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

function checkDefaultRail(rail: string): DoctorCheck {
  if (RAIL_FLAGS.includes(rail as (typeof RAIL_FLAGS)[number])) {
    return {
      name: "config_default_rail",
      group: "config",
      status: "ok",
      display: `defaultRail (${rail}) is a recognised payment rail.`,
    };
  }
  return {
    name: "config_default_rail",
    group: "config",
    status: "fail",
    display: `defaultRail (${rail}) is not a recognised payment rail.`,
    hint: `Set with 'dvm wallet set-default-rail <${RAIL_FLAGS.join("|")}>'.`,
    details: { recognised: [...RAIL_FLAGS] },
  };
}

function checkDefaultIdentity(name: string): DoctorCheck {
  try {
    const identities = loadIdentities();
    if (!identities) {
      return {
        name: "config_default_identity",
        group: "config",
        status: "fail",
        display: `defaultIdentity (${name}) is set, but identities.json is missing.`,
        hint: `Run 'dvm identity create ${name}' to provision the referenced identity.`,
      };
    }
    if (!(name in identities.identities)) {
      return {
        name: "config_default_identity",
        group: "config",
        status: "fail",
        display: `defaultIdentity (${name}) does not exist in identities.json.`,
        hint: `Either 'dvm identity create ${name}' or 'dvm identity use <existing-name>'.`,
        details: { knownIdentities: Object.keys(identities.identities) },
      };
    }
    return {
      name: "config_default_identity",
      group: "config",
      status: "ok",
      display: `defaultIdentity (${name}) resolves to a stored identity.`,
    };
  } catch (err) {
    return {
      name: "config_default_identity",
      group: "config",
      status: "fail",
      display: "Could not load identities.json to verify defaultIdentity.",
      hint: "Restore identities.json from backup or run 'dvm identity create <name>'.",
      details: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

function checkCashuMintUrls(mints: string[]): DoctorCheck[] {
  return mints.map((url, idx): DoctorCheck => {
    try {
      new URL(url);
      return {
        name: `config_cashu_mint_url_${idx}`,
        group: "config",
        status: "ok",
        display: `Cashu mint URL (${url}) is well-formed.`,
        details: { url },
      };
    } catch {
      return {
        name: `config_cashu_mint_url_${idx}`,
        group: "config",
        status: "fail",
        display: `Cashu mint URL (${url}) is malformed.`,
        hint: `Remove with 'dvm wallet mint-list' and re-add with 'dvm wallet mint-add <url>'.`,
        details: { url },
      };
    }
  });
}

function checkX402Shape(x402: NonNullable<Config["x402"]>): DoctorCheck {
  if (typeof x402.privateKey === "string" && x402.privateKey.length > 0) {
    return {
      name: "config_x402_shape",
      group: "config",
      status: "ok",
      display: "x402 wallet config has a privateKey.",
    };
  }
  return {
    name: "config_x402_shape",
    group: "config",
    status: "fail",
    display: "x402 config is present but privateKey is missing or empty.",
    hint: "Run 'dvm wallet x402-connect' to create a wallet, or add --key-file <path> to import a key you already hold.",
  };
}

function checkTempoShape(tempo: NonNullable<Config["tempo"]>): DoctorCheck {
  if (tempo.method === "tempo") {
    if (typeof tempo.apiKey === "string" && tempo.apiKey.length > 0) {
      if (tempo.network !== undefined && tempo.network !== "mainnet" && tempo.network !== "moderato") {
        return {
          name: "config_tempo_shape",
          group: "config",
          status: "fail",
          display: `Tempo wallet network (${String(tempo.network)}) is not recognised.`,
          hint: "Reconnect with 'dvm wallet tempo-connect --network mainnet' or '--network moderato'; no payment should be attempted from this config.",
        };
      }
      const network = tempo.network ?? "mainnet";
      const chain = resolveTempoNetwork(network);
      return {
        name: "config_tempo_shape",
        group: "config",
        status: "ok",
        display: `Tempo config has an apiKey and selects ${tempoNetworkLabel(network)} (chain ${String(chain.chainId)}).`,
        details: { network, chain_id: chain.chainId },
      };
    }
    return {
      name: "config_tempo_shape",
      group: "config",
      status: "fail",
      display: "Tempo config is present but apiKey is missing or empty.",
      hint: "Re-run 'dvm wallet tempo-connect' to generate a replacement key, or add '--key-file <path>' to import one you already hold. A key never goes on the command line: a positional argument is refused outright, and '--api-key' imports but leaks the value to shell history and ps.",
    };
  }
  return {
    name: "config_tempo_shape",
    group: "config",
    status: "fail",
    display: `Tempo config method (${tempo.method}) is not recognised.`,
    hint: "Only 'tempo' is supported. Re-run 'dvm wallet tempo-connect'.",
  };
}

function checkCreditShape(credit: NonNullable<Config["credit"]>): DoctorCheck {
  const problems: string[] = [];
  const badTarget = (value: unknown): boolean =>
    value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 1);
  const badCap = (value: unknown): boolean =>
    value !== undefined &&
    (typeof value !== "string" || !/^\$?\d+(\.\d{1,6})?$/.test(value.trim()));
  // A posture the resolver doesn't recognise falls back to `suggest` rather
  // than throwing on the money path, so this row is the only place a typo
  // surfaces — and the difference it hides is "buys credit" vs "doesn't".
  const badPosture = (value: unknown): boolean => value !== undefined && !isCreditPosture(value);
  // Same shape, same reason: an unrecognised `fundingRail` resolves
  // to "no pin", so the caller who meant to keep large fundings on ecash would
  // silently get the amount rule instead. Enumerated from the registry, so a
  // rail added there is accepted — and named — without touching this row.
  const badRail = (value: unknown): boolean => value !== undefined && !isCreditFundRail(value);
  if (badTarget(credit.targetJobs)) problems.push("targetJobs must be a positive integer");
  if (badPosture(credit.posture))
    problems.push(`posture must be one of ${CREDIT_POSTURES.join(", ")}`);
  if (badRail(credit.fundingRail))
    problems.push(`fundingRail must be one of ${CREDIT_FUND_RAILS.join(", ")}`);
  if (badCap(credit.tier0Cap)) problems.push('tier0Cap must be a "$0.50"-style USD string');
  if (badCap(credit.tier1Cap)) problems.push('tier1Cap must be a "$2"-style USD string');
  if (badCap(credit.pocketTarget)) problems.push('pocketTarget must be a "$5"-style USD string');
  // Two spellings of one DVM pinned to different rails resolve to *no* pin
  //, so a caller reading their own config would see a pin that
  // nothing routes onto. The CLI clears such a pair the next time it reaches
  // that DVM; until then this row is what says so.
  const railsByIdentity = new Map<string, Map<string, string[]>>();
  for (const [endpoint, per] of Object.entries(credit.perDvm ?? {})) {
    if (badTarget(per.targetJobs))
      problems.push(`perDvm["${endpoint}"].targetJobs must be a positive integer`);
    if (badPosture(per.posture))
      problems.push(`perDvm["${endpoint}"].posture must be one of ${CREDIT_POSTURES.join(", ")}`);
    if (badRail(per.fundingRail))
      problems.push(
        `perDvm["${endpoint}"].fundingRail must be one of ${CREDIT_FUND_RAILS.join(", ")}`
      );
    if (per.dvmId !== undefined && (typeof per.dvmId !== "string" || per.dvmId.trim() === "")) {
      problems.push(`perDvm["${endpoint}"].dvmId must be the DVM's identifier from /v1/info`);
    }
    if (per.builderPubkey !== undefined && !/^[0-9a-f]{64}$/i.test(per.builderPubkey)) {
      problems.push(`perDvm["${endpoint}"].builderPubkey must be a 64-hex builder pubkey`);
    }
    if (typeof per.dvmId !== "string" || !isCreditFundRail(per.fundingRail)) continue;
    const byRail = railsByIdentity.get(per.dvmId) ?? new Map<string, string[]>();
    byRail.set(per.fundingRail, [...(byRail.get(per.fundingRail) ?? []), endpoint]);
    railsByIdentity.set(per.dvmId, byRail);
  }
  for (const byRail of railsByIdentity.values()) {
    if (byRail.size < 2) continue;
    const keys = [...byRail.values()].flat();
    problems.push(
      `perDvm entries ${keys.map((key) => `"${key}"`).join(" and ")} are the same DVM but pin different funding rails (${[...byRail.keys()].join(", ")}), so neither pin applies and the layer beneath them decides`
    );
  }
  // A pre-grant that silently fails to parse is the worst failure mode here:
  // the caller believes a builder is exempt from the trust-tier speed bump and
  // only finds out when a funding is refused.
  for (const [pubkey, cap] of Object.entries(credit.trustOverrides ?? {})) {
    if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
      problems.push(`trustOverrides key "${pubkey}" must be a 64-hex builder pubkey`);
    }
    if (typeof cap !== "string" || (cap.trim().toLowerCase() !== "builder-max" && badCap(cap))) {
      problems.push(
        `trustOverrides["${pubkey}"] must be "builder-max" or a USD string with at most six decimal places`
      );
    }
  }
  if (problems.length === 0) {
    return {
      name: "config_credit_shape",
      group: "config",
      status: "ok",
      display: "credit policy overrides parse cleanly.",
    };
  }
  return {
    name: "config_credit_shape",
    group: "config",
    status: "fail",
    display: `credit policy overrides are malformed: ${problems.join("; ")}.`,
    hint: 'Fix ~/.dvm/config.json#credit — e.g. { "posture": "suggest", "targetJobs": 40, "tier0Cap": "$0.50" }.',
    details: { problems },
  };
}

function checkFeedbackShape(feedback: NonNullable<Config["feedback"]>): DoctorCheck {
  // Same stakes as the credit posture row above: an unrecognised posture
  // coerces to the default (`ask`) rather than throwing on a job terminal, so
  // this row is the only place a typo surfaces — and the difference it hides
  // is "nudges ask first" vs "nudges are off".
  if (feedback.posture === undefined || isFeedbackPosture(feedback.posture)) {
    return {
      name: "config_feedback_shape",
      group: "config",
      status: "ok",
      display: "feedback settings parse cleanly.",
    };
  }
  return {
    name: "config_feedback_shape",
    group: "config",
    status: "fail",
    display: `feedback settings are malformed: posture must be one of ${FEEDBACK_POSTURES.join(", ")}.`,
    hint: "Set it with 'dvm feedback --posture ask' (or auto, or off), or fix ~/.dvm/config.json#feedback by hand.",
  };
}

// --- Wallets group ---

/**
 * Surface Cashu payments that left the wallet but which no DVM has confirmed
 * These sats are P2PK-locked to the provider and excluded from
 * every balance the CLI reports, so without this row a caller whose paid submit
 * timed out sees an unexplained shortfall and nothing to act on.
 *
 * Never `fail`: a `resumable` entry is transient bookkeeping and clears itself
 * on the next paid call, and even a stranded one is a resolved-with-the-builder
 * problem, not a broken local setup. Chaining `dvm doctor && dvm request` should
 * not stop working because a spend is in flight.
 */
function buildPendingSubmissionCheck(): DoctorCheck {
  let summary;
  try {
    const wallet = loadAgentWallet();
    summary = wallet ? describePendingSubmissions(wallet) : null;
  } catch (err) {
    return {
      name: "wallet_pending_submissions",
      group: "wallets",
      status: "warn",
      display: "Could not read the agent wallet to check for unconfirmed payments.",
      hint: "Run 'dvm wallet submissions' for a focused error message.",
      details: { error: err instanceof Error ? err.message : String(err) },
    };
  }

  if (!summary || summary.entries.length === 0) {
    return {
      name: "wallet_pending_submissions",
      group: "wallets",
      status: "ok",
      display: "No unconfirmed payments — every spend has been acknowledged by its provider.",
    };
  }

  const details = {
    count: summary.entries.length,
    at_risk_sats: summary.at_risk_sats,
    stranded_count: summary.stranded_count,
    reclaimable_count: summary.reclaimable_count,
    reclaim_failed_count: summary.reclaim_failed_count,
    entries: summary.entries,
  };
  const lockedToProviderEntries = summary.entries.filter(
    (entry) => entry.state === "stale" || entry.state === "unresumable"
  );
  const unreclaimableEntries = summary.entries.filter((entry) => entry.state === "unreclaimable");
  const lockedToProviderSats = lockedToProviderEntries.reduce(
    (sum, entry) => sum + entry.amount_sats,
    0
  );
  const unreclaimableSats = unreclaimableEntries.reduce((sum, entry) => sum + entry.amount_sats, 0);

  // an expired payment the wallet keeps failing to take back is the
  // one case here that is genuinely stuck *and* fixable — a mnemonic to restore,
  // a mint to bring back — so it leads, ahead of the stranded row a caller can
  // only escalate to the provider.
  if (summary.reclaim_failed_count > 0) {
    // Only from a `reclaim_failed` entry: `unreclaimable` carries a reason too,
    // and quoting "does not cover the mint's swap fee" under a warning that says
    // the sats are recoverable would send the reader after the wrong thing.
    const reasons = summary.entries
      .filter((e) => e.state === "reclaim_failed")
      .map((e) => e.reclaim_error)
      .filter((r): r is string => r !== null);
    if (summary.stranded_count > 0) {
      const strandedDisplay = [
        lockedToProviderEntries.length > 0
          ? `${lockedToProviderEntries.length} payment(s) totalling ${lockedToProviderSats} sats were sent to a provider that never confirmed them, and are no longer being retried.`
          : null,
        unreclaimableEntries.length > 0
          ? `${unreclaimableEntries.length} payment(s) totalling ${unreclaimableSats} sats expired unclaimed, but the mint charges more to take them back than they are worth.`
          : null,
      ]
        .filter((sentence): sentence is string => sentence !== null)
        .join(" ");
      const strandedHint = [
        lockedToProviderEntries.length > 0
          ? "Ask the provider's operator whether the locked payments ran."
          : null,
        unreclaimableEntries.length > 0
          ? "Retrying will not recover the payments that are too small for the mint's fee — treat those sats as spent."
          : null,
      ]
        .filter((sentence): sentence is string => sentence !== null)
        .join(" ");
      return {
        name: "wallet_pending_submissions",
        group: "wallets",
        status: "warn",
        display: `${summary.reclaim_failed_count} expired payment(s) should have returned to your balance by now, but the wallet has not managed to take them back. ${strandedDisplay}`,
        hint: `${reasons[0] ?? "The last attempt failed."} The payment(s) the wallet could not take back are still recoverable — every call retries. ${strandedHint} Run 'dvm wallet submissions' for the request ids and per-entry reason, then close an unrecoverable entry with 'dvm wallet submissions --forget <request_id>'.`,
        details,
      };
    }
    return {
      name: "wallet_pending_submissions",
      group: "wallets",
      status: "warn",
      display: `${summary.reclaim_failed_count} expired payment(s) should have returned to your balance by now, but the wallet has not managed to take them back.`,
      hint: `${reasons[0] ?? "The last attempt failed."} The sats are still recoverable — every call retries. Run 'dvm wallet submissions' for the per-entry reason.`,
      details,
    };
  }

  // A reclaimable entry is waiting, not stuck — no operator action exists or is
  // wanted, so it must not read as a warning to chase.
  if (summary.stranded_count === 0 && summary.reclaimable_count === summary.entries.length) {
    return {
      name: "wallet_pending_submissions",
      group: "wallets",
      status: "ok",
      display: `${summary.entries.length} payment(s) totalling ${summary.at_risk_sats} sats were never taken by their provider. They expire, and the wallet returns those sats to your balance on its own.`,
      hint: "Nothing to do. Run 'dvm wallet submissions' to see when each one expires.",
      details,
    };
  }

  if (summary.stranded_count > 0) {
    if (unreclaimableEntries.length === 0) {
      return {
        name: "wallet_pending_submissions",
        group: "wallets",
        status: "warn",
        display: `${lockedToProviderEntries.length} payment(s) totalling ${lockedToProviderSats} sats were sent to a provider that never confirmed them, and are no longer being retried.`,
        hint: "Run 'dvm wallet submissions' for the request ids and per-entry reason, then ask the provider's operator whether those jobs ran — or close one out with 'dvm wallet submissions --forget <request_id>'.",
        details,
      };
    }
    if (lockedToProviderEntries.length === 0) {
      return {
        name: "wallet_pending_submissions",
        group: "wallets",
        status: "warn",
        display: `${unreclaimableEntries.length} payment(s) totalling ${unreclaimableSats} sats expired unclaimed, but the mint charges more to take them back than they are worth.`,
        hint: "Retrying will not recover these sats — treat them as spent. Run 'dvm wallet submissions' for the request ids and per-entry reason, then close one out with 'dvm wallet submissions --forget <request_id>'.",
        details,
      };
    }
    return {
      name: "wallet_pending_submissions",
      group: "wallets",
      status: "warn",
      display: `${lockedToProviderEntries.length} payment(s) totalling ${lockedToProviderSats} sats were sent to a provider that never confirmed them, and are no longer being retried. ${unreclaimableEntries.length} payment(s) totalling ${unreclaimableSats} sats expired unclaimed, but the mint charges more to take them back than they are worth.`,
      hint: "Run 'dvm wallet submissions' for the request ids and per-entry reason. Ask the provider's operator whether the locked payments ran; retrying or asking the provider will not recover the payments that are too small for the mint's fee. Close either one out with 'dvm wallet submissions --forget <request_id>'.",
      details,
    };
  }

  return {
    name: "wallet_pending_submissions",
    group: "wallets",
    status: "warn",
    display: `${summary.entries.length} payment(s) totalling ${summary.at_risk_sats} sats are awaiting confirmation from a provider.`,
    hint: "These retry automatically on your next paid call. Run 'dvm wallet show' to retry now, or 'dvm wallet submissions' to inspect them.",
    details,
  };
}

/**
 * Surface cash-outs the mint hasn't confirmed. Unlike a pending
 * submission, the committed proofs are still in the wallet file and still
 * counted in every balance — they're held in-flight and unspendable, so the
 * shortfall shows up as a spend that fails for insufficient balance with a
 * balance that looks sufficient.
 *
 * Never `fail`, for the same reason as the submissions check: a melt in flight
 * is a transient state the next `dvm wallet show` reconciles, not a broken
 * local setup.
 */
function buildPendingMeltCheck(): DoctorCheck {
  let melts;
  try {
    melts = loadAgentWallet()?.pending_melts ?? [];
  } catch (err) {
    return {
      name: "wallet_pending_melts",
      group: "wallets",
      status: "warn",
      display: "Could not read the agent wallet to check for unconfirmed cash-outs.",
      hint: "Run 'dvm wallet show' for a focused error message.",
      details: { error: err instanceof Error ? err.message : String(err) },
    };
  }

  if (melts.length === 0) {
    return {
      name: "wallet_pending_melts",
      group: "wallets",
      status: "ok",
      display: "No unconfirmed cash-outs — every melt has been settled with its mint.",
    };
  }

  const committedSats = melts.reduce(
    (sum, m) => sum + m.input_proofs.reduce((n, p) => n + p.amount, 0),
    0
  );
  return {
    name: "wallet_pending_melts",
    group: "wallets",
    status: "warn",
    display: `${melts.length} cash-out(s) committing ${committedSats} sats haven't been confirmed by their mint yet.`,
    hint: "Run 'dvm wallet show' to reconcile them against the mint — it settles the ones that paid and returns the rest to spendable. Don't re-run the cash-out until it has.",
    details: {
      count: melts.length,
      committed_sats: committedSats,
      entries: melts.map((m) => ({
        mint: m.mint,
        quote_id: m.quote_id,
        destination: m.destination,
        amount_sats: m.amount_sats,
        created_at: m.created_at,
      })),
    },
  };
}

/**
 * Whether the recorded Tempo channels belong to the key configured today.
 *
 * A channel record survives until something proves the channel terminal, so a
 * key that was lost and replaced leaves its channels in the journal — holding
 * collateral only the old key can close. This local read runs under
 * `--no-network` too. No row at all when the journal holds no channels: a
 * caller who has never used the rail does not need a line about it.
 */
async function buildTempoChannelOwnerChecks(): Promise<DoctorCheck[]> {
  const name = "wallet_tempo_channel_owner";
  let records: ReturnType<typeof listTempoChannelAssociations>;
  let connected: Awaited<ReturnType<typeof connectedTempoAccount>>;
  const foreign: Record<string, unknown>[] = [];
  try {
    records = listTempoChannelAssociations();
    if (records.length === 0) return [];
    connected = await connectedTempoAccount();
    // Inside the try with the journal read: the entry each descriptor lives in
    // is `JSON.parse`d by mppx's own store, so one corrupt value throws from
    // here rather than from `listTempoChannelAssociations` — and doctor's job
    // is to report that, not to die of it.
    for (const record of records) {
      const controller = await loadTempoChannelController(record);
      if (tempoChannelControlledBy(controller, connected?.address)) continue;
      foreign.push({
        endpoint: record.endpoint,
        credit_id: record.creditId,
        channel_id: record.channelId,
        payer: controller?.payer,
      });
    }
  } catch (err) {
    return [
      {
        name,
        group: "wallets",
        status: "warn",
        display: "Could not read the saved Tempo channel journal to check who owns its channels.",
        hint: `Run 'dvm wallet balance' for a focused error message. Do not delete ${TEMPO_CHANNELS_FILE}; it is the only route back to any collateral those channels hold.`,
        details: { error: err instanceof Error ? err.message : String(err) },
      },
    ];
  }
  if (foreign.length === 0) {
    return [
      {
        name,
        group: "wallets",
        status: "ok",
        display: `Every recorded Tempo channel (${records.length}) belongs to the connected Tempo key.`,
        details: { channels: records.length, foreign: 0 },
      },
    ];
  }
  const plural = foreign.length === 1 ? "" : "s";
  return [
    {
      name,
      group: "wallets",
      status: "warn",
      display: connected
        ? `${foreign.length} recorded Tempo channel${plural} ${foreign.length === 1 ? "was" : "were"} opened by a different Tempo key, so the connected wallet cannot close ${foreign.length === 1 ? "it" : "them"} or reach the collateral ${foreign.length === 1 ? "it holds" : "they hold"}.`
        : `${foreign.length} Tempo channel${plural} ${foreign.length === 1 ? "is" : "are"} still recorded here, but no Tempo key is connected, so nothing on this machine can close ${foreign.length === 1 ? "it" : "them"}.`,
      // `replacingConnectedKey` tracks `connected` because it is the same
      // fact: with a key configured the import is a replacement and refuses
      // without `--force`, and with none it needs no flag.
      hint: connected
        ? `Run 'dvm wallet balance' to see what the escrow says each one holds. Reconnecting the exact key that opened one (${tempoKeyImportRoutes({ replacingConnectedKey: true })}) is what recovers its collateral; 'dvm wallet tempo-exit <dvm> --credit-id <id> --abandon' retires the record instead, discarding this machine's only descriptor for it. Neither the record nor this warning blocks disconnecting or replacing the Tempo key.`
        : `Run 'dvm wallet balance' to see what the escrow says each one holds. Connecting the key that opened one (${tempoKeyImportRoutes({ replacingConnectedKey: false })}) is what recovers its collateral — while none is connected there is nothing to compare these records against, so the exit will not retire one the escrow still holds collateral for. Neither the record nor this warning blocks connecting a key.`,
      details: { channels: records.length, foreign: foreign.length, entries: foreign },
    },
  ];
}

/**
 * Whether the recorded x402 channels belong to the key configured today.
 *
 * The x402 twin of {@link buildTempoChannelOwnerChecks}, and a caller reading
 * either rail generically gets the same row in the same shape. The state it
 * reports is the same one too: a channel record survives a cooperative drain,
 * so a key that was replaced leaves its channels behind holding collateral the
 * settlement contract will only ever repay to that original payer. Nothing else
 * on this rail said so, and reaching the timed exit at all meant already
 * knowing a channel id.
 *
 * `warn`, never `fail`: such a record blocks nothing — `assertX402WalletIdle`
 * judges only the connected key's own channels — so flipping doctor's exit code
 * would break `dvm doctor && dvm request` over a report the caller may have
 * nothing to do about. A local read, so it runs under `--no-network` too, and
 * no row at all when the store holds no channels.
 */
async function buildX402ChannelOwnerChecks(): Promise<DoctorCheck[]> {
  const name = "wallet_x402_channel_owner";
  let channels: StoredX402ChannelMetadata[];
  let connected: string | null;
  let foreign: Record<string, unknown>[];
  try {
    channels = listX402Channels();
    if (channels.length === 0) return [];
    connected = await connectedX402Payer();
    foreign = channels
      .filter((channel) => !x402ChannelControlledBy(channel, connected))
      .map((channel) => ({
        endpoint: channel.endpoint,
        credit_id: channel.creditId,
        channel_id: channel.channelId,
        network: channel.network,
        payer: channel.config.payer,
      }));
  } catch (err) {
    return [
      {
        name,
        group: "wallets",
        status: "warn",
        display: "Could not read the saved x402 channel store to check who owns its channels.",
        hint: `Run 'dvm wallet balance' for a focused error message. Do not delete ${X402_CHANNELS_FILE}; it is the only route back to any collateral those channels hold.`,
        details: { error: err instanceof Error ? err.message : String(err) },
      },
    ];
  }
  if (foreign.length === 0) {
    return [
      {
        name,
        group: "wallets",
        status: "ok",
        display: `Every recorded x402 channel (${channels.length}) belongs to the connected x402 key.`,
        details: { channels: channels.length, foreign: 0 },
      },
    ];
  }
  const one = foreign.length === 1;
  const plural = one ? "" : "s";
  return [
    {
      name,
      group: "wallets",
      status: "warn",
      display: connected
        ? `${foreign.length} recorded x402 channel${plural} ${one ? "was" : "were"} opened by a different x402 key, so the connected wallet cannot withdraw ${one ? "it" : "them"} or reach the collateral ${one ? "it holds" : "they hold"}.`
        : `${foreign.length} x402 channel${plural} ${one ? "is" : "are"} still recorded here, but no x402 key is connected, so nothing on this machine can withdraw ${one ? "it" : "them"}.`,
      hint: connected
        ? "Run 'dvm wallet balance' to see what the settlement contract says each one holds. Reconnecting the exact key that opened one ('dvm wallet x402-connect --key-file <path>', or DVM_X402_KEY=<key> dvm wallet x402-connect) is what recovers its collateral, because the contract only ever pays a withdrawal back to the payer that opened the channel. Neither the record nor this warning blocks disconnecting or replacing the x402 key."
        : "Run 'dvm wallet balance' to see what the settlement contract says each one holds. Connecting the key that opened one ('dvm wallet x402-connect --key-file <path>') is what recovers its collateral, because the contract only ever pays a withdrawal back to the payer that opened the channel. Neither the record nor this warning blocks connecting a key.",
      details: { channels: channels.length, foreign: foreign.length, entries: foreign },
    },
  ];
}

async function buildWalletChecks(): Promise<DoctorCheck[]> {
  try {
    const tempo = await connectedTempoAccount();
    if (tempo) {
      await assertTempoBalanceRpcNetwork(tempo, { timeoutMs: DEFAULT_PROBE_TIMEOUT_MS });
    }
  } catch (err) {
    return [
      {
        name: "wallet_tempo_rpc_chain",
        group: "wallets",
        status: "fail",
        display: "Tempo balance was not read because its RPC did not prove the wallet's selected chain.",
        hint:
          err instanceof DvmError
            ? err.hint
            : "Correct DVM_TEMPO_RPC_URL, or unset it to use the bundled endpoint.",
        details: {
          error: err instanceof Error ? err.message : String(err),
          ...(err instanceof DvmError && err.data ? err.data : {}),
        },
      },
    ];
  }
  let probe;
  try {
    probe = await probeWallets({ timeoutMs: DEFAULT_PROBE_TIMEOUT_MS });
  } catch (err) {
    return [
      {
        name: "wallet_probe",
        group: "wallets",
        status: "fail",
        display: "Unexpected error while probing wallet rails.",
        hint: "Run 'dvm wallet balance' for a focused error message.",
        details: { error: err instanceof Error ? err.message : String(err) },
      },
    ];
  }

  if (probe.rails.length === 0) {
    return [
      {
        name: "wallet_present",
        group: "wallets",
        status: "warn",
        display: "No wallet rails configured.",
        hint: "Run 'dvm wallet setup' to fund a wallet on one of the supported rails.",
      },
    ];
  }

  return [...probe.rails.map(railToCheck), ...floatChecks(probe.rails)];
}

/** Compare one target's public Tempo chain advertisement with the selected wallet. */
export async function checkTempoTargetNetwork(
  target: string,
  opts: { fetchImpl?: typeof fetch; account?: Awaited<ReturnType<typeof connectedTempoAccount>> } = {}
): Promise<DoctorCheck> {
  let endpoint: string;
  try {
    endpoint = doctorTargetEndpoint(target);
  } catch (err) {
    return {
      name: "network_tempo_target",
      group: "network",
      status: "fail",
      display: `Could not resolve doctor target ${target}.`,
      hint: "Use a valid endpoint, alias, favorite, or qualified DVM selector.",
      details: { target, error: err instanceof Error ? err.message : String(err) },
    };
  }
  let account: Awaited<ReturnType<typeof connectedTempoAccount>>;
  try {
    account = opts.account === undefined ? await connectedTempoAccount() : opts.account;
  } catch (err) {
    return {
      name: "network_tempo_target",
      group: "network",
      status: "fail",
      display: "The connected Tempo wallet could not be read for the target comparison.",
      hint: "Run 'dvm doctor --no-network' to inspect the local config error first.",
      details: { endpoint, error: err instanceof Error ? err.message : String(err) },
    };
  }
  if (!account) {
    return {
      name: "network_tempo_target",
      group: "network",
      status: "warn",
      display: `No Tempo wallet is connected, so ${endpoint} cannot be compared with a selected Tempo chain.`,
      hint: "Connect a Tempo wallet, then rerun this doctor target check.",
      details: { endpoint, wallet_network: null },
    };
  }
  const network = tempoAccountNetwork(account);
  const expected = resolveTempoNetwork(network);
  let response: Response;
  try {
    response = await (opts.fetchImpl ?? dvmFetch)(`${endpoint}/v1/info`, {
      method: "GET",
      signal: AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      name: "network_tempo_target",
      group: "network",
      status: "fail",
      display: `Could not read ${endpoint}/v1/info to compare its Tempo chain.`,
      hint: "Check the target endpoint and retry; no payment or signature was attempted.",
      details: { endpoint, error: err instanceof Error ? err.message : String(err) },
    };
  }
  if (!response.ok) {
    return {
      name: "network_tempo_target",
      group: "network",
      status: "fail",
      display: `${endpoint}/v1/info returned HTTP ${String(response.status)}; its Tempo chain was not compared.`,
      hint: "Repair the target's public info endpoint and retry; no payment or signature was attempted.",
      details: { endpoint, http_status: response.status },
    };
  }
  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    return {
      name: "network_tempo_target",
      group: "network",
      status: "fail",
      display: `${endpoint}/v1/info did not return valid JSON; its Tempo chain was not compared.`,
      hint: "Repair the target's public info response and retry; no payment or signature was attempted.",
      details: { endpoint },
    };
  }
  const tempo = body.tempo;
  if (!tempo || typeof tempo !== "object" || Array.isArray(tempo)) {
    return {
      name: "network_tempo_target",
      group: "network",
      status: "warn",
      display: `${endpoint} does not advertise Tempo on /v1/info.`,
      hint: "Use another advertised rail, or ask the operator to publish its Tempo configuration.",
      details: { endpoint, wallet_network: network, wallet_chain_id: expected.chainId },
    };
  }
  const advertised = (tempo as Record<string, unknown>).chain_id;
  if (advertised === undefined) {
    return {
      name: "network_tempo_target",
      group: "network",
      status: "warn",
      display: `${endpoint} advertises Tempo but omits tempo.chain_id, so its chain cannot be compared safely.`,
      hint: "Ask the operator to publish tempo.chain_id before using this wallet with the target.",
      details: { endpoint, wallet_network: network, wallet_chain_id: expected.chainId },
    };
  }
  if (typeof advertised !== "number" || !Number.isSafeInteger(advertised) || advertised <= 0) {
    return {
      name: "network_tempo_target",
      group: "network",
      status: "fail",
      display: `${endpoint} publishes an invalid tempo.chain_id.`,
      hint: "Ask the operator to publish a positive integer chain id; no payment or signature was attempted.",
      details: {
        endpoint,
        wallet_network: network,
        wallet_chain_id: expected.chainId,
        advertised_chain_id: advertised,
      },
    };
  }
  if (advertised !== expected.chainId) {
    return {
      name: "network_tempo_target",
      group: "network",
      status: "fail",
      display: `${endpoint} advertises Tempo chain ${String(advertised)}, but this wallet selects ${tempoNetworkLabel(network)} (chain ${String(expected.chainId)}).`,
      hint: "Use a wallet configured for the target's chain, or use a target configured for this wallet. No payment or signature was attempted.",
      details: {
        endpoint,
        wallet_network: network,
        wallet_chain_id: expected.chainId,
        advertised_chain_id: advertised,
        payment_signed: false,
      },
    };
  }
  return {
    name: "network_tempo_target",
    group: "network",
    status: "ok",
    display: `${endpoint} and this wallet both select ${tempoNetworkLabel(network)} (chain ${String(expected.chainId)}).`,
    details: {
      endpoint,
      wallet_network: network,
      wallet_chain_id: expected.chainId,
      advertised_chain_id: advertised,
    },
  };
}

function doctorTargetEndpoint(target: string): string {
  const endpoint = target.startsWith("@")
    ? resolveEndpoint(target)
    : /^https?:\/\//.test(target)
      ? target
      : resolveDvmReference(target).endpoint;
  return endpoint.replace(/\/+$/, "");
}

/**
 * Float-specific rows beyond "is it reachable".
 *
 * A float is money the agent moves on its own, so the two things worth
 * checking are whether the connection can still do that, whether a wallet-side
 * connection budget is recorded, and whether local principal caps are set.
 * NIP-47 cannot apply a caller-chosen routing-fee ceiling to `pay_invoice`.
 */
function floatChecks(rails: RailProbe[]): DoctorCheck[] {
  const lightning = rails.find((r) => r.rail === "lightning");
  if (!lightning?.configured) return [];
  const checks: DoctorCheck[] = [];
  const details = lightning.details ?? {};

  if (lightning.reachable && details.can_pay === false) {
    checks.push({
      name: "wallet_float_can_pay",
      group: "wallets",
      status: "fail",
      display:
        "The connected Lightning wallet can't send payments, so the agent can't top itself up.",
      hint: "Recreate the connection in your wallet app with payment permission enabled, then pipe it into 'dvm wallet connect'.",
      details: { methods: details.methods },
    });
  }

  if (lightning.reachable && details.can_reconcile === false) {
    checks.push({
      name: "wallet_float_can_reconcile",
      group: "wallets",
      status: "warn",
      display:
        "The connected Lightning wallet can't be asked about past payments, so an interrupted top-up can't be confirmed automatically.",
      hint: "Prefer a wallet that supports lookup_invoice — see docs/wallets.md. Otherwise check the wallet's own history after any interrupted funding.",
      details: { methods: details.methods },
    });
  }

  const caps = loadLedger().caps;
  const statedWalletBudget = details.stated_budget ?? null;
  const walletReportedBudget = details.wallet_reported_budget ?? null;
  const walletBudgetRecorded = statedWalletBudget !== null || walletReportedBudget !== null;
  checks.push(
    walletBudgetRecorded
      ? {
          name: "wallet_float_budget",
          group: "wallets",
          status: "ok",
          display:
            "A wallet-side connection policy is recorded. The wallet enforces that policy, but dvm cannot read its remaining allowance, tell whether routing fees count toward it, or choose a Lightning route.",
          details: {
            stated_wallet_budget: statedWalletBudget,
            wallet_reported_budget: walletReportedBudget,
            routing_fee_inclusion: "unknown",
          },
        }
      : {
          name: "wallet_float_budget",
          group: "wallets",
          status: "warn",
          display: "No wallet-side spending policy is recorded for this NWC connection.",
          hint: "Set a connection policy in your wallet app, confirm whether it counts routing fees, then re-connect with --budget to record it. NIP-47 gives dvm no per-payment routing-fee ceiling.",
          details: {
            stated_wallet_budget: null,
            wallet_reported_budget: null,
            routing_fee_inclusion: "unknown",
          },
        }
  );

  const capped =
    caps.dailyUsd !== undefined || caps.weeklyUsd !== undefined || caps.monthlyUsd !== undefined;
  checks.push(
    capped
      ? {
          name: "wallet_float_principal_budget",
          group: "wallets",
          status: "ok",
          display:
            "Local dvm spending caps check each invoice principal before payment. They do not cap the Lightning routing fee added by the wallet.",
          details: { caps, routing_fee_ceiling_sats: null },
        }
      : {
          name: "wallet_float_principal_budget",
          group: "wallets",
          status: "warn",
          display:
            "No local dvm spending caps are set. A wallet connection policy is separate, and dvm does not know whether it counts routing fees.",
          hint: "Set a principal budget with 'dvm budget set --monthly \"$20\"'. The wallet still chooses the Lightning route and fee.",
          details: { caps, routing_fee_ceiling_sats: null },
        }
  );

  return checks;
}

function railToCheck(rail: RailProbe): DoctorCheck {
  const name = `wallet_${rail.rail}`;
  const isNwcFundingFloat = rail.rail === "lightning";

  const details: Record<string, unknown> = {
    configured: rail.configured,
    reachable: rail.reachable,
    ...(rail.balanceMsats !== undefined ? { balanceMsats: rail.balanceMsats } : {}),
    ...(rail.balanceUsdc !== undefined ? { balanceUsdc: rail.balanceUsdc } : {}),
    ...(isNwcFundingFloat ? { funding: NWC_FUNDING_FLOAT_ROLE } : {}),
    ...(rail.details ?? {}),
  };
  const tempoNetwork =
    rail.rail === "tempo"
      ? tempoNetworkFromChainId(rail.details?.chain_id as number | undefined)
      : undefined;
  const tempoWhere = tempoNetwork ? ` on ${tempoNetworkLabel(tempoNetwork)}` : "";

  if (!rail.reachable) {
    // The unsupported-chain split lives in `unreachableRailDisplay`,
    // shared with `dvm wallet balance`. The NWC float keeps its own
    // copy so the funding-role sentence rides along, but a wallet that answered
    // and *refused* is not an unreachable rail — that diagnosis comes from
    // `nwcRejectionDisplay`, and the remedy from the probe's own hint.
    return {
      name,
      group: "wallets",
      status: "fail",
      display: isNwcFundingFloat
        ? `${nwcRejectionDisplay(rail) ?? "NWC funding float is configured but not reachable."} It funds ecash wallet top-ups and eligible prepaid credits, not direct dvm request payments.`
        : unreachableRailDisplay(rail),
      hint: isNwcFundingFloat
        ? `${NWC_FUNDING_FLOAT_ROLE.hint} ${unreachableRailHint(rail)}`
        : unreachableRailHint(rail),
      details: {
        ...details,
        ...(rail.error ? { error: rail.error } : {}),
      },
    };
  }

  // Wrong settlement asset (Tempo) or chain (x402): a stablecoin balance read only ever
  // queries one contract, so a wallet funded with the wrong dollar — or, on
  // x402, the right dollar on the wrong chain — is indistinguishable from an
  // unfunded one. Both read $0.00 under an `ok` badge. Name what the rail does
  // accept and the remedy instead.
  const wrongAsset = wrongAssetDiagnosis(rail);
  if (wrongAsset) {
    return {
      name,
      group: "wallets",
      // A rail with no money is not a broken install: warn, never fail.
      status: "warn",
      // the endpoint sits with the amount, because "read the wrong
      // endpoint" is one of the ways a funded wallet reports $0.00 — and
      // `--human` doctor prints `display` and `hint`, nothing else.
      display: `${railLabelAtSentenceStart(probeRailLabel(rail.rail))} rail${tempoWhere} is reachable but holds no ${wrongAsset.assetLabel} ($0.00${rpcEndpointSuffix(rail)}), so it cannot pay for anything.`,
      hint: wrongAsset.hint,
      // The contract itself is already in `details.token`, carried by the probe
      // that read the balance against it — naming it twice only invites an
      // agent to wonder how the two differ.
      details: { ...details, settlement_asset: wrongAsset.symbol },
    };
  }

  return {
    name,
    group: "wallets",
    status: "ok",
    display: isNwcFundingFloat
      ? `NWC funding float reachable${formatBalanceTail(rail)}. ${NWC_FUNDING_FLOAT_ROLE.display}`
      : `${railLabelAtSentenceStart(probeRailLabel(rail.rail))} rail${tempoWhere} reachable${formatBalanceTail(rail)}.`,
    details,
  };
}

/**
 * The zero-balance copy for a stablecoin rail whose balance read can't tell an
 * unfunded wallet from a wrongly-funded one. Null for a non-zero balance, for
 * rails without that failure mode, and for an x402 wallet on a chain we carry
 * no USDC contract for — that one already reports as unreachable, and there is
 * no asset to name.
 *
 * A copy branch on the balance already fetched — no rail is probed twice.
 */
function wrongAssetDiagnosis(
  rail: RailProbe
): { assetLabel: string; symbol: string | null; hint: string } | null {
  if (rail.balanceUsdc !== 0) return null;

  if (rail.rail === "tempo") {
    const network = tempoNetworkFromChainId(rail.details?.chain_id as number | undefined);
    const asset = resolveTempoAsset(process.env, network);
    return {
      assetLabel: asset.label,
      symbol: asset.symbol,
      hint:
        network === "moderato"
          ? `${tempoWrongAssetHint(asset)} If you simply haven't funded it yet, run \"dvm wallet fund '$1' --rail tempo\" to use the faucet.`
          : `${tempoWrongAssetHint(asset)} If you simply haven't funded it yet, run 'dvm wallet fund $10 --rail tempo'.`,
    };
  }

  if (rail.rail === "x402") {
    const asset = resolveX402Asset(rail.details?.network as string | undefined);
    if (!asset) return null;
    return {
      // x402 is multi-network, so the asset is only named once the chain is.
      assetLabel: `${asset.label} on ${asset.networkLabel}`,
      symbol: asset.symbol,
      hint: `${x402WrongAssetHint(asset)} If you simply haven't funded it yet, run 'dvm wallet setup --rail x402' for a walkthrough of buying it and sending it here.`,
    };
  }

  return null;
}

function formatBalanceTail(rail: RailProbe): string {
  if (rail.balanceMsats !== undefined) {
    return ` (${Math.round(rail.balanceMsats / 1000)} sats)`;
  }
  if (rail.balanceUsdc === undefined) return "";
  const amount = `$${rail.balanceUsdc.toFixed(2)}`;
  // a stablecoin balance also means something only next to the
  // endpoint it was read from, which the caller can point elsewhere.
  const via = rpcEndpointSuffix(rail);
  if (rail.rail === "tempo") {
    const network = tempoNetworkFromChainId(rail.details?.chain_id as number | undefined);
    return ` (${amount} ${resolveTempoAsset(process.env, network).unit}${via})`;
  }
  if (rail.rail === "x402") {
    // x402 reads one chain, so a balance only means something next
    // to the chain it was read on.
    const asset = resolveX402Asset(rail.details?.network as string | undefined);
    return asset
      ? ` (${amount} ${asset.unit} on ${asset.networkLabel}${via})`
      : ` (${amount} USDC${via})`;
  }
  return ` (${amount} USDC${via})`;
}

// --- Network group ---

async function buildNetworkChecks(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  try {
    const rate = await fetchBtcUsdRate();
    checks.push({
      name: "network_btc_rate",
      group: "network",
      status: "ok",
      display: `BTC/USD rate reachable (${rate.toFixed(0)} USD/BTC).`,
      details: { rate },
    });
  } catch (err) {
    checks.push({
      name: "network_btc_rate",
      group: "network",
      status: "warn",
      display: "Could not fetch BTC/USD rate; commands fall back to the cached value.",
      hint: "Check internet connectivity; rate APIs may be temporarily down.",
      details: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  // Cache freshness — informational, doesn't fail.
  const cacheAge = readBtcRateCacheAge();
  if (cacheAge !== null) {
    if (cacheAge.ageMs > BTC_RATE_STALE_MS) {
      checks.push({
        name: "network_btc_rate_cache",
        group: "network",
        status: "warn",
        display: `BTC/USD cache is ${Math.round(cacheAge.ageMs / 3_600_000)}h old.`,
        hint: "Run any command with network access to refresh the cache.",
        details: { ageMs: cacheAge.ageMs },
      });
    } else {
      checks.push({
        name: "network_btc_rate_cache",
        group: "network",
        status: "ok",
        display: `BTC/USD cache is fresh (${Math.round(cacheAge.ageMs / 60_000)}m old).`,
        details: { ageMs: cacheAge.ageMs },
      });
    }
  }

  // Per-mint /v1/info probe in parallel. Reads the canonical `wallet.mints`
  // inventory rather than the legacy `config.cashuMints` field, so
  // mints added via `dvm wallet mint-add` are probed.
  let mints: string[] = [];
  try {
    mints = await loadConfiguredMints();
  } catch {
    // Wallet store unreadable — let the file-checks group surface the cause.
  }
  if (mints.length > 0) {
    const results = await Promise.allSettled(
      mints.map((url) => checkMintHealth(url, { timeoutMs: DEFAULT_PROBE_TIMEOUT_MS, retries: 1 }))
    );
    for (let i = 0; i < mints.length; i++) {
      const url = mints[i];
      const res = results[i];
      if (res.status === "fulfilled") {
        const r = res.value;
        if (r.ok) {
          checks.push({
            name: `network_mint_${i}`,
            group: "network",
            status: "ok",
            display: `Mint ${url} reachable (${r.latencyMs}ms).`,
            details: {
              url,
              latencyMs: r.latencyMs,
              version: r.version,
              missingRequiredNuts: r.missingRequiredNuts ?? [],
            },
          });
        } else {
          checks.push({
            name: `network_mint_${i}`,
            group: "network",
            status: "fail",
            display: `Mint ${url} unhealthy: ${r.error?.message ?? "unknown error"}.`,
            hint: "Check mint status with 'dvm wallet mint-health' or remove with 'dvm wallet mint-list'.",
            details: { url, error: r.error, latencyMs: r.latencyMs },
          });
        }
      } else {
        checks.push({
          name: `network_mint_${i}`,
          group: "network",
          status: "fail",
          display: `Mint ${url} probe threw unexpectedly.`,
          hint: "Re-run 'dvm wallet mint-health' for a focused error.",
          details: { url, error: String(res.reason) },
        });
      }
    }
  }

  return checks;
}

// --- Rendering ---

function countSummary(checks: DoctorCheck[]): { ok: number; warn: number; fail: number } {
  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) summary[c.status]++;
  return summary;
}

function renderHuman(report: DoctorReport, ranNetwork: boolean): void {
  const { summary } = report;
  info(`Doctor — OK ${summary.ok}  WARN ${summary.warn}  FAIL ${summary.fail}`);
  info(`configDir: ${report.configDir}`);
  info(`cli: ${report.cliVersion}  node: ${report.nodeVersion}`);
  if (!ranNetwork) {
    info("(network checks skipped — --no-network)");
  }
  info("");

  for (const group of ["files", "config", "wallets", "network"] as const) {
    const rows = report.checks.filter((c) => c.group === group);
    if (rows.length === 0) continue;
    info(`[${group.toUpperCase()}]`);
    for (const r of rows) {
      const badge = r.status === "ok" ? "OK  " : r.status === "warn" ? "WARN" : "FAIL";
      info(`  ${badge}  ${r.display}`);
      if (r.hint) info(`        ↳ ${r.hint}`);
    }
    info("");
  }
}
