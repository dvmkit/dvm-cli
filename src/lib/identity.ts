import lockfile from "proper-lockfile";

import { CONFIG_FILE } from "@dvmkit/sdk/internal";
import { ensureConfigDir } from "@dvmkit/sdk/internal";
import { appendConfigAudit, applyConfigPatch, assertValidConfig, changedConfigPaths, CONFIG_SNAPSHOT_SLOTS, type ConfigBackupInfo, type ConfigPatch, configSnapshotPath, type ConfigSnapshotSlot, deepFreezeConfig, describeConfigBackup, isSecretProtectedTarget, type ProtectedFieldAuthorization, protectedRemovalError, protectedRemovals, type ProtectedTarget, protectedTargetValue, protectedValuesMatch, readConfigBackup, readRawConfig, removeConfigBackup, retainConfigBackup, supersededProtectedSecrets, withoutProtectedTargets, writeConfigBackup, writeConfigFile } from "./config-mutation";
import type { CreditFundRail } from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";
import type { RailFlag } from "@dvmkit/sdk/internal";

export interface Config {

  nwcUri?: string;
  /**
   * Metadata about the connected Lightning float, recorded at connect.
   * Separate from {@link nwcUri} so the connection string stays the single
   * credential and this stays purely descriptive — notably `statedBudget`, which
   * is what the user told us they capped the wallet at. NIP-47 does not guarantee
   * a budget-read method, so this metadata is never enforced against.
   */
  float?: {
    /** Wallet-side budget as the user stated it, e.g. "$20/month". */
    statedBudget?: string;
    /** ISO timestamp of the successful connect. */
    connectedAt: string;

    alias?: string;

    methods?: string[];
  };
  /** Default max budget per request, e.g. "5000" (msats) or "$0.50" */
  defaultBudget?: string;
  /** Auto-pay threshold — payments at or below this are paid without confirmation, e.g. "1000" or "$0.01" */
  autoPayThreshold?: string;
  /** Default max number of payments per job (overridden by --max-payments). Defaults to 5 when unset. */
  defaultMaxPayments?: number;
  /**
   * Legacy Cashu mint list. Replaced by `wallet.mints` in
   * `~/.dvm/wallet.json` as the single source of truth for `mint-add`,
   * `mint-list`, `mint-health`, and `wallet show`. `loadConfiguredMints()`
   * in `src/lib/wallet-agent/mint-inventory.ts` migrates a non-empty legacy
   * value into `wallet.mints` and strips it from disk on first read. New
   * code must not read or write this field.
   */
  cashuMints?: string[];

  x402?: { privateKey: string; network?: string };

  tempo?: {
    method: string;
    accountId?: string;
    apiKey?: string;
    /** Tempo network. Missing on older configs means mainnet. */
    network?: "mainnet" | "moderato";
  };
  /**
   * Preferred rail for `dvm request` upfront payment. When set,
   * takes precedence over the default resolver order when multiple rails are
   * locally configured AND advertised by the target DVM. Overridden per-call
   * by `--rail`.
   */
  defaultRail?: RailFlag;
  /**
   * Name of the default caller signing identity stored in
   * `~/.dvm/identities.json`. When set, `dvm request` / `dvm quote`
   * auto-sign with this identity against DVMs that advertise
   * `auth: ["secp256k1-schnorr-v2"]`. Overridden per-call by `--as <name>` or
   * `DVM_IDENTITY_KEY=<hex>`.
   */
  defaultIdentity?: string;
  /**
   * Caller-side prepaid-credit policy overrides. All optional —
   * absent keys keep the ratified defaults (open at 20× job price; refill
   * target 40× on the Cashu rail; trust-tier caps $0.50 / $2).
   */
  credit?: CreditConfig;

  feedback?: FeedbackConfig;
}

/**
 * How much authority the caller has delegated over *automatic* credit
 * purchases. Governs only whether a sizing-up plan is produced;
 * per-call payment and first contact are the same in all three.
 *
 * - `suggest` — the default. Nothing is ever purchased automatically; where a
 * purchase would have happened the job output carries a suggestion naming
 * both ways to opt in.
 * - `auto` — automatic purchases within the trust-tier caps, each reported
 * with its amount, funding route and reason.
 * - `off` — no multi-job credit at all: no opens, no refills, and no draws on
 * one already held. Per-call implicit N=1 continues.
 */
export type CreditPosture = "suggest" | "auto" | "off";

/** The three postures, in the order every surface names them. */
export const CREDIT_POSTURES: readonly CreditPosture[] = ["suggest", "auto", "off"];

export function isCreditPosture(value: unknown): value is CreditPosture {
  return typeof value === "string" && (CREDIT_POSTURES as readonly string[]).includes(value);
}

/**
 * How a feedback nudge may be acted on. Governs only the caller-side
 * nudges; `dvm feedback` itself works the same under all three.
 *
 * - `ask` — the default. Nudges are emitted, and the acting agent summarizes
 * the substance of its feedback to its human and gets a yes before sending.
 * - `auto` — nudges are emitted and the agent sends without asking.
 * - `off` — no nudges at all.
 */
export type FeedbackPosture = "ask" | "auto" | "off";

/** The three feedback postures, in the order every surface names them. */
export const FEEDBACK_POSTURES: readonly FeedbackPosture[] = ["ask", "auto", "off"];

export function isFeedbackPosture(value: unknown): value is FeedbackPosture {
  return typeof value === "string" && (FEEDBACK_POSTURES as readonly string[]).includes(value);
}

/**
 * Caller-side feedback-nudge settings (`config.json#feedback`).
 * Deliberately global-only — no per-DVM layer: a nudge posture is about how the
 * caller's agent talks to its human, not about any one provider.
 */
export interface FeedbackConfig {
  /** Consent posture for acting on feedback nudges. Defaults to `ask`. */
  posture?: FeedbackPosture;
}

export interface CreditConfig {
  /**
   * Refill target as a multiple of the job price (the "N" in fund-N-jobs).
   * Default 40 for Cashu-funded credits — credit depth is outage runway on
   * the BTC rail (the consent contract). Still clamped by the trust-tier cap and the
   * builder's `max`.
   */
  targetJobs?: number;
  /**
   * Consent posture for automatic credit purchases. Defaults to
   * `suggest`. A per-DVM entry below overrides this in either direction.
   */
  posture?: CreditPosture;
  /** Tier-0 cap override (no receipt history), e.g. `"$0.50"`. */
  tier0Cap?: string;
  /** Tier-1 cap override (≥3 successful receipts), e.g. `"$2"`. */
  tier1Cap?: string;
  /**
   * Target for the agent's ecash pocket, e.g. `"$5"`. The pocket
   * refills at healthy post-job moments when its balance drops below 25% of
   * this — the float pays a mint under the NWC cap, no human step. Default $5.
   */
  pocketTarget?: string;
  /**
   * Pin every credit funding to one rail instead of letting the amount rule
   * pick — the persisted form of `dvm credit fund --rail`.
   *
   * This is a **force**, not a preference: a funding the pinned rail can't
   * carry is refused with a structured `below_rail_minimum` naming the
   * alternatives, never quietly rerouted. Its purpose is the privacy persona —
   * pin `cashu` and large fundings keep the mint's blinding toward a DVM
   * instead of going out as a bolt11 the DVM's own node can see.
   *
   * Valid values are the rails in `CREDIT_FUND_RAILS`; `dvm doctor` names the
   * set when it finds anything else.
   */
  fundingRail?: CreditFundRail;
  /**
   * Per-DVM overrides, keyed by endpoint origin (e.g. `https://scrape.dvmkit.dev`).
   *
   * The key stays the hostname the caller typed — this file is hand-edited,
   * and an opaque uuid there would be unreadable. `dvmId`/`builderPubkey` are
   * stamped from `/v1/info` when the CLI has it, and are what lets an entry
   * written under one spelling govern a job that names another.
   * Both halves are required to match: the attestation carrying `dvm_id` is
   * self-signed, so the builder key is what makes claiming an identity cost
   * something. An entry for a DVM that publishes neither stays origin-keyed.
   */
  perDvm?: Record<
    string,
    {
      targetJobs?: number;
      posture?: CreditPosture;
      fundingRail?: CreditFundRail;
      /** Immutable DVM id off `/v1/info`, as attested by {@link builderPubkey}. */
      dvmId?: string;
      /** Builder x-only pubkey the DVM's attestation verifies under. */
      builderPubkey?: string;
    }
  >;
  /**
   * Pre-granted funding caps for builders this caller already trusts — its own
   * fleet, first-party DVMs — keyed by the **builder pubkey** (64-hex, as
   * authenticated on `/v1/info`), valued `"builder-max"` or a figure like
   * `"$50"`.
   *
   * An explicit `dvm credit fund` amount above the trust-tier cap is refused
   * unless the invocation names `--over-trust` or a pre-grant here covers the
   * authenticated builder. One key covers every DVM that builder signs; a URL
   * an injected instruction supplies cannot inherit one without presenting a
   * valid live attestation under that key.
   */
  trustOverrides?: Record<string, string>;
}

/**
 * Fold a legacy `credit.disabled` switch into the consent posture, at
 * both the global and the per-DVM layer.
 *
 * `disabled: true` meant exactly what `posture: "off"` means, so it becomes
 * that and the old key is dropped — there is no second switch left in the
 * schema for a later reader to disagree with. An explicit `posture` already on
 * the object wins: it was written by a caller who knew about the posture, and a
 * stale `disabled: true` beside it must not silently override them.
 *
 * In-memory only. Nothing here writes to disk; the migrated shape lands in the
 * file the next time any command does an ordinary field-scoped
 * {@link updateConfig}.
 */
export function migrateCreditConfig(config: Config): Config {
  const credit = config.credit as (CreditConfig & { disabled?: unknown }) | undefined;
  if (!credit) return config;

  const migrateLayer = <T extends { posture?: CreditPosture; disabled?: unknown }>(layer: T): T => {
    const railed = migrateFundingRail(layer);
    if (!("disabled" in railed)) return railed;
    const { disabled, ...rest } = railed;
    const migrated = { ...rest } as T;
    if (migrated.posture === undefined && disabled === true) migrated.posture = "off";
    return migrated;
  };

  const perDvm = credit.perDvm;
  return {
    ...config,
    credit: {
      ...migrateLayer(credit),
      ...(perDvm
        ? {
            perDvm: Object.fromEntries(
              Object.entries(perDvm).map(([endpoint, per]) => [endpoint, migrateLayer(per)])
            ),
          }
        : {}),
    },
  };
}

/**
 * Rewrite a pinned `fundingRail: "mpp"` to `tempo`.
 *
 * The rename was a hard cutover, so `mpp` is no longer a member of
 * `CREDIT_FUND_RAILS` — left alone, a caller's pin would stop matching any rail
 * and `dvm doctor` would report their own config as invalid. Same in-memory
 * discipline as the rest of {@link migrateCreditConfig}.
 */
function migrateFundingRail<T>(layer: T): T {
  const loose = layer as { fundingRail?: string };
  if (loose.fundingRail !== "mpp") return layer;
  return { ...layer, fundingRail: "tempo" };
}

/**
 * Move a connected Tempo wallet from the legacy `mpp` config key onto
 * `tempo`.
 *
 * Without it the cutover silently disconnects every caller who had already run
 * `dvm wallet tempo-connect`: the key holds their private key, and nothing
 * else on disk records it.
 */
function migrateTempoWalletKey(config: Config): Config {
  const loose = config as Config & { mpp?: Config["tempo"] };
  if (!loose.mpp || loose.tempo) return config;
  const { mpp, ...rest } = loose;
  return { ...rest, tempo: mpp };
}

export {
  authorizeProtectedRemoval,
  CONFIG_SNAPSHOT_SLOTS,
  type ConfigBackupInfo,
  type ConfigField,
  type ConfigPatch,
  type ConfigResetPlan,
  configSnapshotPath,
  type ConfigSnapshotSlot,
  describeConfigBackup,
  planConfigReset,
  PROTECTED_CONFIG_FIELDS,
  PROTECTED_CREDENTIAL_PATHS,
  type ProtectedConfigField,
  type ProtectedCredentialPath,
  ProtectedFieldAuthorization,
  type ProtectedTarget,
} from "./config-mutation";

/**
 * Apply every in-memory migration to a config as read from disk.
 *
 * Nothing here writes; the migrated shape lands the next time any command
 * mutates a field, because {@link updateConfig} diffs against the *unmigrated*
 * bytes and so counts a pending migration as a real change.
 */
export function migrateConfig(config: Config): Config {
  return migrateCreditConfig(migrateTempoWalletKey(config));
}

/** Load config from disk, or null if not found. */
export function loadConfig(): Config | null {
  const raw = readRawConfig();
  return raw === null ? null : migrateConfig(raw);
}

export interface ConfigUpdate {
  /**
   * Stable identifier for the command or code path making the change, e.g.
   * `wallet_disconnect`. Lands in the audit trail beside the changed paths.
   */
  reason: string;
  /**
   * Declares the change against the config **as reloaded inside the lock** —
   * null when there is no config file yet. Compute nested values from this
   * argument and never from a snapshot read earlier: reloading under the lock
   * is the whole mechanism that stops a slow writer from overwriting a field
   * another command changed while it worked.
   */
  patch: (current: Config | null) => ConfigPatch | Promise<ConfigPatch>;
  /**
   * Names the protected fields this change may remove. Without it a change that
   * would drop `nwcUri`, `defaultIdentity`, `tempo` or `x402` — or the
   * credential inside one — is refused and nothing is written.
   */
  authorize?: ProtectedFieldAuthorization;
  /**
   * Extra protected targets to strip from both stored copies as part of *this*
   * commit. Removals and rotations are stripped automatically; this is for a
   * command that wants a credential gone from the copies for some other reason,
   * and it exists so that never has to be a second critical section with a
   * window in the middle.
   */
  sanitizeBackup?: readonly ProtectedTarget[];
  /**
   * Which *existing* stored copies this change may strip the departing
   * credentials out of. Defaults to both.
   *
   * The rolling copy this change writes is always credential-free — it is
   * authored here, so it never carries what this change removed, and that is
   * not configurable. What this narrows is the pinned snapshot: an explicit
   * whole-configuration reset pins the state it is about to destroy and then
   * declares `sweepSlots: ["backup"]`, which says in one line "these removals
   * are intended, and the pin is the survivor". Without it the reset would
   * sweep the very snapshot it had just taken.
   */
  sweepSlots?: readonly ConfigSnapshotSlot[];
}

export interface ConfigUpdateResult {

  config: Config;
  /** The config as it stood before the change, or null when there was none. */
  previous: Config | null;
  /** Field paths whose value changed. Never carries the values themselves. */
  changed: readonly string[];
  /** False when the change was a no-op: nothing written, retained or logged. */
  written: boolean;
  /** The rollback generation available after the change, when there is one. */
  backup: ConfigBackupInfo | null;
}

/**
 * Change named caller-config fields, atomically and recoverably.
 *
 * The sequence is the contract: take the config lock, reload the file *inside*
 * it, hand that fresh config to `patch`, merge only the fields the patch
 * declares, validate, retain one rollback generation, commit by rename, and
 * append a value-free audit line. Everything the patch does not name survives —
 * including fields this build has no type for, which is what keeps a caller who
 * downgrades from losing the settings their newer dvm wrote.
 *
 * **Lock ordering: the config lock is the innermost one.** Paths that also hold
 * the wallet, identities or x402-channel lock take theirs first and call this
 * inside; nothing may take one of those while holding this.
 *
 * Throws `config_locked` when another dvm process holds the lock,
 * `config_patch_invalid` on a malformed change, `config_protected_field` on an
 * unauthorized credential removal, `config_invalid` when the result would not
 * be readable, and `config_corrupt` when the current file will not parse.
 */
export async function updateConfig(update: ConfigUpdate): Promise<ConfigUpdateResult> {
  return withConfigLock(async () => {
    const raw = readRawConfig();

    // Three independent copies, because the patch is arbitrary code and the
    // whole gate rests on comparing what the file *was* against what it becomes.
    // `snapshot` is what the diff and the copies are built
    // from; `base` is what the change merges onto; `handed` is frozen and given
    // to the patch, so a patch that edits its argument fails loudly rather than
    // quietly rewriting the evidence.
    const snapshot: Config = raw === null ? {} : structuredClone(raw);
    const base = raw === null ? null : migrateConfig(structuredClone(raw));
    const handed = raw === null ? null : deepFreezeConfig(migrateConfig(structuredClone(raw)));

    const next = applyConfigPatch(base ?? {}, await runPatch(update, handed));

    const changed = changedConfigPaths(snapshot, next);
    if (changed.length === 0) {
      return {
        config: base ?? {},
        previous: base,
        changed: [],
        written: false,
        backup: describeConfigBackup(),
      };
    }

    // The gate runs against the *migrated* view on both sides. Against the raw
    // bytes, a caller whose Tempo key still sits under the legacy `mpp` name
    // would have no `tempo` field to protect and the key would survive into the
    // rollback copy.
    const removals = protectedRemovals(base ?? {}, next);
    const unauthorized = removals.filter((target) => update.authorize?.covers(target) !== true);
    if (unauthorized.length > 0) throw protectedRemovalError(unauthorized, update.reason);

    assertValidConfig(
      next,
      changed.map((path) => path.split(".")[0])
    );

    const superseded = supersededProtectedSecrets(base ?? {}, next);
    // Secrets only. `defaultIdentity` is gated against removal because nothing
    // else records which key the CLI signs with, but it *is* not a key — taking
    // it out of a stored copy costs the caller an undo and buys nothing.
    const stripped = [
      ...new Set<ProtectedTarget>([...removals, ...superseded, ...(update.sanitizeBackup ?? [])]),
    ].filter(isSecretProtectedTarget);

    const sweeping = update.sweepSlots ?? CONFIG_SNAPSHOT_SLOTS;
    const swept: ConfigSnapshotSlot[] = [];
    if (raw !== null) {
      // The rolling copy is authored by this change, so it is written without
      // the departing credentials whatever `sweepSlots` says.
      if (stripped.length > 0) {
        writeConfigBackup(withoutProtectedTargets(raw, stripped));
        swept.push("backup");
      } else {
        retainConfigBackup();
      }
    }
    if (stripped.length > 0 && sweeping.includes("pinned")) {
      if (sweepPinnedSnapshot(stripped, base ?? {}, update.reason)) swept.push("pinned");
    }
    const backup = describeConfigBackup();

    writeConfigFile(next);
    appendConfigAudit({
      ts: new Date().toISOString(),
      event: "update",
      reason: update.reason,
      fields: changed,
      ...(removals.length > 0 ? { removed: removals } : {}),
      ...(superseded.length > 0 ? { superseded } : {}),
      ...(swept.length > 0 ? { sweptSlots: swept } : {}),
      backup: backup !== null,
      pid: process.pid,
    });

    return { config: next, previous: base, changed, written: true, backup };
  });
}

/**
 * Pin the current configuration into the non-rolling snapshot slot.
 *
 * The slot an explicit whole-config replacement writes to, because the rolling
 * `config.json.bak` is overwritten by the very next field change — an E2E
 * script that runs a destructive `init` and then keeps driving the CLI would
 * have lost the rollback within seconds.
 *
 * **First writer wins, with no override.** A pin already in the slot is left
 * alone and this returns null, so a destructive command running twice cannot
 * pin its own wreckage over the state worth recovering — and the guarantee is
 * absolute rather than one flag away from not holding. A command that really
 * means to replace an older pin retires it first, deliberately, through
 * {@link retireConfigBackup}.
 *
 * Returns null when a pin already exists or there is no config to pin.
 */
export async function pinConfigSnapshot(reason: string): Promise<ConfigBackupInfo | null> {
  return withConfigLock(() => {
    if (describeConfigBackup("pinned") !== null) return null;
    if (!retainConfigBackup("pinned")) return null;
    const pinned = describeConfigBackup("pinned");
    appendConfigAudit({
      ts: new Date().toISOString(),
      event: "pinned",
      reason,
      fields: [],
      slot: "pinned",
      backup: pinned !== null,
      pid: process.pid,
    });
    return pinned;
  });
}

export interface ConfigCreationResult {
  /** The configuration now on disk — the seed when this call wrote it, otherwise what was already there. */
  config: Config;
  /** True only when this call created the file. False means it was already there and nothing was written. */
  created: boolean;
}

/**
 * Create config.json only if absent, checking under the config lock. Existing
 * configuration is never replaced; corrupt bytes produce config_corrupt so the
 * caller can recover them rather than silently losing credentials.
 */
export async function ensureConfig(
  seed: Config = {},
  reason = "init"
): Promise<ConfigCreationResult> {
  return withConfigLock(() => {
    const existing = readRawConfig();
    if (existing !== null) return { config: migrateConfig(existing), created: false };

    assertValidConfig(seed);
    writeConfigFile(seed);
    appendConfigAudit({
      ts: new Date().toISOString(),
      event: "create",
      reason,
      fields: changedConfigPaths({}, seed),
      backup: describeConfigBackup() !== null,
      pid: process.pid,
    });

    return { config: seed, created: true };
  });
}

export interface ConfigRollbackResult {

  config: Config;

  changed: readonly string[];
  /** Protected credentials and identity pointers the restore removed. */
  removed: readonly ProtectedTarget[];
}

export interface ConfigRollbackPreview {
  /** Field paths whose value the restore would change. Never carries a value. */
  changed: readonly string[];

  removing: readonly ProtectedTarget[];
}

/**
 * Preview a restore as changed field names and departing credentials, never
 * values. Stat-only backup metadata cannot reveal a credential removal.
 * Returns null when the slot is empty or its bytes cannot be parsed.
 */
export function previewConfigRollback(
  source: ConfigSnapshotSlot = "backup"
): ConfigRollbackPreview | null {
  const restored = readConfigBackup(source);
  if (restored === null) return null;
  let currentOnDisk: Config | null = null;
  try {
    currentOnDisk = readRawConfig();
  } catch {
    // A config too corrupt to parse is exactly what a restore is for; every
    // field in the copy then counts as a change, and none as a removal.
  }
  return {
    changed: changedConfigPaths(currentOnDisk ?? {}, restored),
    removing: protectedRemovals(
      currentOnDisk === null ? {} : migrateConfig(structuredClone(currentOnDisk)),
      migrateConfig(structuredClone(restored))
    ),
  };
}

/**
 * Restore a stored copy of the configuration over the current one.
 *
 * The config being replaced becomes the new rollback generation, so a restore
 * is itself undoable exactly once and the bound stays at one copy on disk.
 *
 * **A restore is a credential removal whenever the copy predates a connect**,
 * and it goes through the same gate every other removal does.
 * Without an `authorize` naming what {@link previewConfigRollback} said would
 * go, the restore is refused and nothing is written — which is also what
 * catches a stored copy that changed between the preview the caller confirmed
 * and this commit. The trail records the departures under the same `removed`
 * key a disconnect uses.
 */
export async function rollbackConfig(
  reason = "config_rollback",
  source: ConfigSnapshotSlot = "backup",
  authorize?: ProtectedFieldAuthorization
): Promise<ConfigRollbackResult> {
  return withConfigLock(() => {
    const restored = readConfigBackup(source);
    if (restored === null) {

      const stored = describeConfigBackup(source);
      throw stored === null
        ? new DvmError(
            "config_no_rollback",
            `No ${source === "pinned" ? "pinned snapshot" : "rollback copy"} of the configuration is stored.`,
            `A rollback copy is written at ${configSnapshotPath(source)} before each change, so there is one to restore only after a change has been made on this machine.`
          )
        : new DvmError(
            "config_rollback_corrupt",
            `The stored copy at ${configSnapshotPath(source)} is not readable as a configuration.`,
            "Nothing was changed. Inspect that file yourself, or remove it and continue with the configuration you have."
          );
    }
    assertValidConfig(restored);

    let currentOnDisk: Config | null = null;
    try {
      currentOnDisk = readRawConfig();
    } catch {
      // A config too corrupt to parse is exactly what a rollback is for; the
      // swap below still keeps its bytes.
    }
    const changed = changedConfigPaths(currentOnDisk ?? {}, restored);

    const removed = protectedRemovals(
      currentOnDisk === null ? {} : migrateConfig(structuredClone(currentOnDisk)),
      migrateConfig(structuredClone(restored))
    );
    const unauthorized = removed.filter((target) => authorize?.covers(target) !== true);
    if (unauthorized.length > 0) throw protectedRemovalError(unauthorized, reason);

    if (!retainConfigBackup()) retireSlot(`${reason}:nothing_to_swap`, "backup");
    if (source === "pinned") retireSlot(`${reason}:pin_restored`, "pinned");
    writeConfigFile(restored);
    appendConfigAudit({
      ts: new Date().toISOString(),
      event: "rollback",
      reason,
      fields: changed,
      ...(removed.length > 0 ? { removed } : {}),
      source,
      backup: describeConfigBackup() !== null,
      pid: process.pid,
    });

    return { config: restored, changed, removed };
  });
}

/**
 * Discard a stored copy entirely.
 *
 * The primitive an explicit reset reaches for: once the caller has deliberately
 * emptied their configuration, a copy of what it held is the one thing that
 * still carries their credentials. Returns false when the slot was empty.
 */
export async function retireConfigBackup(
  reason: string,
  slot: ConfigSnapshotSlot = "backup"
): Promise<boolean> {
  return withConfigLock(() => retireSlot(reason, slot));
}

/**
 * Discard *both* stored copies in one critical section.
 *
 * What an explicit whole-configuration reset needs: retiring them one at a time
 * is two lock acquisitions with a window in the middle where the pinned
 * snapshot has outlived the reset that was supposed to take it. Returns the
 * slots that actually held something.
 */
export async function retireConfigSnapshots(reason: string): Promise<ConfigSnapshotSlot[]> {
  return withConfigLock(() => CONFIG_SNAPSHOT_SLOTS.filter((slot) => retireSlot(reason, slot)));
}

/**
 * Strip named protected targets from a stored copy, keeping the rest of it
 * restorable.
 *
 * The narrower twin of {@link retireConfigBackup}, for a disconnect that
 * removed one rail's credential and has no reason to cost the caller the
 * ability to undo an unrelated change. Both slots are swept when none is named.
 * A copy that cannot be parsed is retired instead of edited. Returns false when
 * nothing needed doing.
 *
 * A removal or rotation made through {@link updateConfig} already sweeps both
 * slots inside its own critical section — reach for this only for a credential
 * that some *other* command put in a copy.
 */
export async function sanitizeConfigBackup(
  targets: readonly ProtectedTarget[],
  reason: string,
  slot?: ConfigSnapshotSlot
): Promise<boolean> {
  const slots: ConfigSnapshotSlot[] = slot ? [slot] : ["backup", "pinned"];
  return withConfigLock(() =>
    slots.map((each) => sanitizeSlot(targets, reason, each)).includes(true)
  );
}

/**
 * Serialise config read-modify-write cycles that can replace wallet
 * credentials.
 *
 * Held for the duration of `fn`, and **innermost**: every other CLI-state lock
 * (wallet, identities, x402 channels) is taken before this one, so the whole
 * tree agrees on one acquisition order and no pair of commands can deadlock.
 * Not reentrant — the mutation helpers above take it themselves, so a call site
 * uses one or the other, never both.
 */
export async function withConfigLock<T>(fn: () => Promise<T> | T): Promise<T> {
  ensureConfigDir();
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(CONFIG_FILE, {
      lockfilePath: `${CONFIG_FILE}.lock`,
      realpath: false,
      stale: 30_000,
      retries: { retries: 10, factor: 1, minTimeout: 100, maxTimeout: 100 },
    });
  } catch {
    throw new DvmError(
      "config_locked",
      "Another dvm process is updating the local configuration.",
      "Wait a moment and retry."
    );
  }
  try {
    return await fn();
  } finally {
    await release().catch(() => undefined);
  }
}

/**
 * Run a change's patch, turning an attempt to edit the frozen config it was
 * handed into the taxonomy's own refusal rather than a bare `TypeError`.
 */
async function runPatch(update: ConfigUpdate, current: Config | null): Promise<ConfigPatch> {
  try {
    return await update.patch(current);
  } catch (err) {
    if (
      err instanceof TypeError &&
      /read only|not extensible|frozen|cannot delete property|cannot add property/i.test(
        err.message
      )
    ) {
      throw new DvmError(
        "config_patch_invalid",
        `The '${update.reason}' change tried to modify the configuration it was handed.`,
        "Nothing was written. A change declares what it wants through its `set` and `unset` lists; editing the current config in place bypasses the protected-field gate, so the object is frozen."
      );
    }
    throw err;
  }
}

/**
 * Strip the departing credentials out of the pinned snapshot, in the caller's
 * critical section — but only where the snapshot holds *the same value*.
 *
 * Sweeping by field name alone is what made the pin worthless: pin holds wallet
 * A, the caller reconnects as wallet B while working out what they lost, then
 * disconnects B — and a name-only sweep takes A out of the one copy that still
 * had it. `departing` is the config as it stood before this change, so the
 * values leaving the live config are exactly what gets matched.
 *
 * The pin may still spell a field with its legacy name, so the comparison
 * runs against a migrated view while the strip runs against the stored bytes.
 */
function sweepPinnedSnapshot(
  targets: readonly ProtectedTarget[],
  departing: Config,
  reason: string
): boolean {
  if (describeConfigBackup("pinned") === null) return false;
  const pinned = readConfigBackup("pinned");
  if (pinned === null) {

    return retireSlot(`${reason}:unreadable_pin`, "pinned");
  }

  const migrated = migrateConfig(structuredClone(pinned));
  const matching = targets.filter((target) =>
    protectedValuesMatch(
      target,
      protectedTargetValue(departing, target),
      protectedTargetValue(migrated, target)
    )
  );
  if (matching.length === 0) return false;

  const sanitized = withoutProtectedTargets(pinned, matching);
  const changed = changedConfigPaths(pinned, sanitized);
  if (changed.length === 0) return false;

  writeConfigBackup(sanitized, "pinned");
  appendConfigAudit({
    ts: new Date().toISOString(),
    event: "backup_sanitized",
    reason,
    fields: changed,
    removed: matching,
    slot: "pinned",
    backup: describeConfigBackup() !== null,
    pid: process.pid,
  });
  return true;
}

function retireSlot(reason: string, slot: ConfigSnapshotSlot): boolean {
  if (!removeConfigBackup(slot)) return false;
  appendConfigAudit({
    ts: new Date().toISOString(),
    event: "backup_retired",
    reason,
    fields: [],
    slot,
    backup: describeConfigBackup() !== null,
    pid: process.pid,
  });
  return true;
}

function sanitizeSlot(
  targets: readonly ProtectedTarget[],
  reason: string,
  slot: ConfigSnapshotSlot
): boolean {
  if (describeConfigBackup(slot) === null) return false;
  const stored = readConfigBackup(slot);
  if (stored === null) return retireSlot(reason, slot);

  // Only the targets this copy actually held: an audit line naming a credential
  // that was never in the file overstates what left it.
  const matching = targets.filter(
    (target) => changedConfigPaths(stored, withoutProtectedTargets(stored, [target])).length > 0
  );
  if (matching.length === 0) return false;

  const sanitized = withoutProtectedTargets(stored, matching);
  const changed = changedConfigPaths(stored, sanitized);
  if (changed.length === 0) return false;

  writeConfigBackup(sanitized, slot);
  appendConfigAudit({
    ts: new Date().toISOString(),
    event: "backup_sanitized",
    reason,
    fields: changed,
    removed: matching,
    slot,
    backup: describeConfigBackup() !== null,
    pid: process.pid,
  });
  return true;
}
