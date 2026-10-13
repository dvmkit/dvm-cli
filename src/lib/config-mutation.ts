import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";

import { CONFIG_AUDIT_FILE, CONFIG_BACKUP_FILE, CONFIG_FILE, CONFIG_PINNED_FILE } from "@dvmkit/sdk/internal";
import { ensureConfigDir } from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";
// Type-only: `identity` owns the `Config` shape and imports this module back at
// runtime to compose the public contract, so this edge must stay erasable.
import type { Config } from "./identity";

export type ConfigField = keyof Config;

/**
 * One declared, field-scoped change to `config.json`.
 *
 * `set` replaces each named field wholesale — it is not a deep merge, so a
 * mutation touching one key of a nested field (`credit.posture`) builds the new
 * object from the config it was handed inside the lock rather than from a
 * snapshot it read earlier. Everything not named here survives untouched.
 */
export interface ConfigPatch {
  /** Fields to write. An `undefined` value is refused — use {@link unset}. */
  set?: Partial<Config>;
  /** Fields to remove. Removing a protected field needs an authorization. */
  unset?: readonly ConfigField[];
}

/**
 * Fields whose removal is a protected operation: the three rails' credentials
 * and the pointer at the default signing identity.
 *
 * Nothing else on the machine records any of them, so losing one is not a
 * setting to redo but a wallet to reconnect or a key to re-import. Generic
 * mutations are refused; an explicit lifecycle command names what it is
 * entitled to remove through {@link authorizeProtectedRemoval}.
 */
export const PROTECTED_CONFIG_FIELDS = ["nwcUri", "defaultIdentity", "tempo", "x402"] as const;

export type ProtectedConfigField = (typeof PROTECTED_CONFIG_FIELDS)[number];

/**
 * The credential leaves inside those fields, nameable on their own so a command
 * can be entitled to drop a key without being entitled to drop the block it
 * sits in.
 */
export const PROTECTED_CREDENTIAL_PATHS = ["tempo.apiKey", "x402.privateKey"] as const;

export type ProtectedCredentialPath = (typeof PROTECTED_CREDENTIAL_PATHS)[number];

export type ProtectedTarget = ProtectedConfigField | ProtectedCredentialPath;

export class ProtectedFieldAuthorization {
  /** Targets this authorization covers. A field also covers its own leaves. */
  readonly targets: readonly ProtectedTarget[];

  constructor(targets: readonly ProtectedTarget[]) {
    this.targets = [...targets];
  }

  /**
   * True when `target` is one this authorization names. Naming a field covers
   * the leaves under it; naming a leaf covers only that leaf, so a command
   * entitled to clear `tempo.apiKey` still cannot take the whole `tempo` block.
   */
  covers(target: string): boolean {
    if ((this.targets as readonly string[]).includes(target)) return true;
    const field = target.split(".")[0];
    return target !== field && (this.targets as readonly string[]).includes(field);
  }
}

/**
 * Authorize a mutation to remove the named protected targets.
 *
 * Read it as the command stating what it is entitled to destroy: `dvm wallet
 * disconnect` names `nwcUri` and nothing else, so the same call cannot also
 * take the x402 key with it by accident.
 */
export function authorizeProtectedRemoval(
  ...targets: [ProtectedTarget, ...ProtectedTarget[]]
): ProtectedFieldAuthorization {
  return new ProtectedFieldAuthorization(targets);
}

export interface ConfigResetPlan {
  /** Fields present on disk that the reset clears, in schema order. */
  clear: ConfigField[];
  /** Fields present on disk the reset leaves alone, in the order they sit in the file. */
  preserved: string[];
}

/**
 * Work out what a reset would take, against the configuration in front of it.
 *
 * Two kinds of field survive. The four protected ones leave only through their
 * own lifecycle commands — a disconnect, an identity selection — so a reset
 * never names them. And a field this build has no *type* for is left alone and
 * reported: a newer dvm may be keeping a credential there, and this build
 * cannot tell a setting from a secret it has never heard of. Everything else is
 * a setting, and a setting is what a reset is for.
 */
export function planConfigReset(config: Config): ConfigResetPlan {
  const present = Object.keys(config as Record<string, unknown>);
  const resettable = resettableConfigFields();
  const clearable = new Set<string>(resettable);
  return {
    clear: resettable.filter((field) => present.includes(field)),
    preserved: present.filter((field) => !clearable.has(field)),
  };
}

/**
 * Merge a declared change onto `base`, preserving every field it did not name.
 *
 * Refuses two shapes that read as valid but are how fields get silently lost: a
 * `set` entry whose value is `undefined`, and a field declared in `set` and
 * `unset` at once.
 */
export function applyConfigPatch(base: Config, patch: ConfigPatch): Config {

  if (!isPlainObject(patch))
    throw patchShapeError("A change must be an object with `set` and/or `unset`.");
  if (patch.set !== undefined && !isPlainObject(patch.set)) {
    throw patchShapeError("A change's `set` must be an object of fields to write.");
  }
  if (patch.unset !== undefined && !Array.isArray(patch.unset)) {
    throw patchShapeError("A change's `unset` must be an array of field names.");
  }

  const set = patch.set ?? {};
  const unset = patch.unset ?? [];

  for (const [field, value] of Object.entries(set)) {
    if (value !== undefined) continue;
    throw new DvmError(
      "config_patch_invalid",
      `Config field '${field}' was declared with no value.`,
      "Give the field a value, or name it in the change's `unset` list to remove it. An undefined value is how a field gets dropped without anyone deciding to drop it."
    );
  }
  for (const field of unset) {
    if (typeof field !== "string" || field.length === 0) {
      throw patchShapeError("Every entry in a change's `unset` must be a field name.");
    }
    if (!Object.hasOwn(set, field)) continue;
    throw new DvmError(
      "config_patch_invalid",
      `Config field '${field}' is both written and removed by the same change.`,
      "Declare each field once: in `set` with its new value, or in `unset` to remove it."
    );
  }

  const merged = { ...base, ...set } as Record<string, unknown>;
  const removing = new Set<string>(unset);
  return Object.fromEntries(
    Object.entries(merged).filter(([field]) => !removing.has(field))
  ) as Config;
}

/**
 * Recursively freeze `config`, so a patch function that edits the object it was
 * handed fails loudly instead of corrupting the very snapshot the protected
 * gate is about to compare against.
 */
export function deepFreezeConfig(config: Config): Config {
  freezeDeep(config);
  return config;
}

/**
 * Protected targets this change removes, whether by naming them, by rebuilding
 * their object without the credential inside, or by overwriting one with an
 * empty string.
 *
 * The second case is the one a declaration-only check misses: `set: { x402: {
 * network } }` keeps the field and destroys the key. The third is the one a
 * presence check misses: `""` is a value, and it is not a credential.
 *
 * **Both arguments must be the migrated view.** A caller whose Tempo key still
 * sits under the legacy `mpp` name has no `tempo` field in the raw bytes,
 * so a gate run against those bytes sees nothing to protect and lets the key
 * through into the rollback copy.
 */
export function protectedRemovals(before: Config, after: Config): ProtectedTarget[] {
  const previous = before as Record<string, unknown>;
  const next = after as Record<string, unknown>;
  const removed: ProtectedTarget[] = [];

  for (const field of PROTECTED_CONFIG_FIELDS) {
    const held = previous[field];
    if (!isPresentValue(held)) continue;
    const kept = next[field];
    if (!isPresentValue(kept)) {
      removed.push(field);
      continue;
    }

    const spec = PROTECTED_FIELDS[field];
    if (spec.credentialLeaves.length === 0) continue;
    if (!isPlainObject(held)) continue;
    if (!isPlainObject(kept)) {
      removed.push(field);
      continue;
    }
    for (const leaf of spec.credentialLeaves) {
      if (!isPresentValue(held[leaf]) || isPresentValue(kept[leaf])) continue;
      removed.push(`${field}.${leaf}` as ProtectedTarget);
    }
  }

  return removed;
}

/**
 * Secret values replaced in place, for removal from recovery copies. Rotation
 * leaves a working rail, so it is separate from protectedRemovals.
 * defaultIdentity is excluded because it points to a key rather than holding one.
 */
export function supersededProtectedSecrets(before: Config, after: Config): ProtectedTarget[] {
  const previous = before as Record<string, unknown>;
  const next = after as Record<string, unknown>;
  const superseded: ProtectedTarget[] = [];

  for (const field of PROTECTED_CONFIG_FIELDS) {
    const spec = PROTECTED_FIELDS[field];
    if (!spec.secret) continue;
    const held = previous[field];
    const kept = next[field];

    if (spec.credentialLeaves.length === 0) {
      if (isPresentValue(held) && isPresentValue(kept) && held !== kept) superseded.push(field);
      continue;
    }
    if (!isPlainObject(held) || !isPlainObject(kept)) continue;
    for (const leaf of spec.credentialLeaves) {
      const was = held[leaf];
      const now = kept[leaf];
      if (!isPresentValue(was) || !isPresentValue(now) || was === now) continue;
      superseded.push(`${field}.${leaf}` as ProtectedTarget);
    }
  }

  return superseded;
}

/**
 * Field paths whose value differs between two configs, sorted and deduplicated.
 *
 * Struct keys are schema and are named; the keys of record-shaped fields are
 * *data* and collapse to `*`, so a trail records `credit.perDvm.*.posture`
 * rather than which DVM the caller changed its posture for. Unknown fields —
 * anything a newer dvm wrote — are reported by name and never descended into,
 * since this build cannot know which of their keys are data.
 */
export function changedConfigPaths(before: Config, after: Config): string[] {
  const found = new Set<string>();
  collectChangedPaths(
    before as Record<string, unknown>,
    after as Record<string, unknown>,
    CONFIG_PATH_SHAPE,
    "",
    found
  );
  return [...found].sort();
}

/**
 * Refuse a config whose declared fields do not have the shape the CLI reads
 * them with.
 *
 * `fields` narrows the sweep to the top-level fields this change actually
 * moved. A config that was already wrong in some *other* field stays writable —
 * a caller who hand-edited `defaultMaxPayments` into a string must still be
 * able to connect a wallet, and `dvm doctor` is where that field gets reported.
 */
export function assertValidConfig(config: Config, fields?: readonly string[]): void {
  if (!isPlainObject(config)) {
    throw new DvmError(
      "config_invalid",
      "The caller configuration is not a JSON object.",
      `Expected an object at ${CONFIG_FILE}.${rollbackSuffix()}`
    );
  }
  const record = config;
  const scope = fields ? new Set(fields) : null;

  for (const [field, kind] of Object.entries(CONFIG_FIELD_TYPES)) {
    if (scope && !scope.has(field)) continue;
    const value = record[field];
    if (value === undefined) continue;
    if (!matchesKind(value, kind)) throw invalidFieldError(field, kind);
  }

  for (const [path, kind] of Object.entries(CONFIG_LEAF_TYPES)) {
    const [field, leaf] = path.split(".");
    if (scope && !scope.has(field)) continue;
    const owner = record[field];
    if (!isPlainObject(owner)) continue;
    const value = owner[leaf];
    if (value === undefined || !matchesKind(value, kind)) throw invalidFieldError(path, kind);
  }
  if (
    (!scope || scope.has("tempo")) &&
    isPlainObject(record.tempo) &&
    record.tempo.network !== undefined &&
    record.tempo.network !== "mainnet" &&
    record.tempo.network !== "moderato"
  ) {
    throw new DvmError(
      "config_invalid",
      `The caller configuration field 'tempo.network' must be 'mainnet' or 'moderato'.`,
      `Correct tempo.network in ${CONFIG_FILE}.${rollbackSuffix()}`
    );
  }
}

/**
 * Parse `config.json` exactly as it sits on disk, with no migration applied.
 *
 * The unmigrated bytes are what a change is diffed against, so a migration a
 * read applied in memory still shows up as a real change and still lands on
 * disk with the next ordinary write.
 */
export function readRawConfig(): Config | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Config;
  } catch {
    throw new DvmError(
      "config_corrupt",
      "Config file is corrupt.",
      // Not "delete it": those bytes are the only copy on this machine of the
      // NWC connection string and both private keys, however badly they parse.
      `Run 'dvm config rollback' to restore a stored copy, or move ${CONFIG_FILE} aside yourself and run 'dvm init'.${rollbackSuffix()}`
    );
  }
}

/** Atomically write `config.json` at mode 0600. */
export function writeConfigFile(config: Config): void {
  writeJsonAtomic(CONFIG_FILE, config);
}

/**
 * The two copies of the configuration this contract keeps, and no others.
 *
 * - `backup` — the rolling one-generation rollback, replaced before every
 * ordinary field change.
 * - `pinned` — the non-rolling snapshot a deliberate whole-config replacement
 * takes, which no ordinary change ever overwrites.
 */
export type ConfigSnapshotSlot = "backup" | "pinned";

/** Both slots, in the order every sweep visits them. */
export const CONFIG_SNAPSHOT_SLOTS: readonly ConfigSnapshotSlot[] = ["backup", "pinned"];

export function configSnapshotPath(slot: ConfigSnapshotSlot): string {
  return slot === "pinned" ? CONFIG_PINNED_FILE : CONFIG_BACKUP_FILE;
}

export interface ConfigBackupInfo {

  path: string;

  slot: ConfigSnapshotSlot;
  /** Size on disk, in bytes. */
  bytes: number;
  /** Last-modified time, ISO-8601 — i.e. when the change it undoes was made. */
  modifiedAt: string;
  /** POSIX mode in octal (e.g. `"0600"`). Null off-POSIX or when the stat failed. */
  modeOctal: string | null;

  ownerOnly: boolean;
}

/**
 * Describe a stored copy, or null when that slot is empty.
 *
 * Deliberately stat-only: the file holds the same plaintext credentials the
 * config does, and a diagnostic surface must be able to say a copy exists
 * without any path by which its contents reach output. Never throws.
 */
export function describeConfigBackup(slot: ConfigSnapshotSlot = "backup"): ConfigBackupInfo | null {
  const path = configSnapshotPath(slot);
  try {
    if (!existsSync(path)) return null;
    const stat = statSync(path);
    const posix = process.platform !== "win32";
    const mode = stat.mode & 0o777;
    return {
      path,
      slot,
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      modeOctal: posix ? toOctal(mode) : null,
      ownerOnly: !posix || (mode & 0o077) === 0,
    };
  } catch {
    return null;
  }
}

/** Parse a stored copy, or null when the slot is empty or its bytes will not parse. */
export function readConfigBackup(slot: ConfigSnapshotSlot = "backup"): Config | null {
  const path = configSnapshotPath(slot);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Config;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Copy the current `config.json` into a slot, byte for byte — a config too
 * corrupt to parse is exactly the one worth keeping. No-op when there is no
 * config yet.
 */
export function retainConfigBackup(slot: ConfigSnapshotSlot = "backup"): boolean {
  if (!existsSync(CONFIG_FILE)) return false;
  ensureConfigDir();
  const path = configSnapshotPath(slot);
  const tmp = `${path}.tmp`;
  // Written rather than `copyFileSync`'d: a copy inherits the *source's* mode,
  // which would leave the credential-bearing temp as loose as `config.json`
  // until a follow-up chmod caught up with it.
  writeFileSync(tmp, readFileSync(CONFIG_FILE), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  commitTmp(tmp, path);
  return true;
}

export function writeConfigBackup(config: Config, slot: ConfigSnapshotSlot = "backup"): void {
  writeJsonAtomic(configSnapshotPath(slot), config);
}

/** Empty a slot. Returns false when it was already empty. */
export function removeConfigBackup(slot: ConfigSnapshotSlot = "backup"): boolean {
  const path = configSnapshotPath(slot);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/**
 * The credential a target names inside `config`, or undefined when it holds
 * none.
 *
 * A field target resolves to the credential *inside* it — naming `tempo` reads
 * `tempo.apiKey` — because that is the value a sweep has to compare. Stripping
 * a stored copy by field name alone destroys a *different* credential that
 * happens to live under the same name, which is exactly what a pinned snapshot
 * exists to keep hold of.
 */
export function protectedTargetValue(config: Config, target: ProtectedTarget): unknown {
  const [field, named] = target.split(".") as [ProtectedConfigField, string | undefined];
  const held = (config as Record<string, unknown>)[field];
  const leaves = PROTECTED_FIELDS[field].credentialLeaves;
  const leaf = named ?? (leaves.length > 0 ? leaves[0] : undefined);
  if (leaf === undefined) return held;
  return isPlainObject(held) ? held[leaf] : undefined;
}

/**
 * Whether two stored spellings of a target are the same credential.
 *
 * A sweep that compares raw strings leaves a working key behind: hex is
 * case-insensitive, so a copy holding `0x2E2E…` survives a disconnect of
 * `0x2e2e…` and the caller is left with their private key in a plaintext file
 * they asked to be rid of. Surrounding whitespace is the same story, and
 * trimming here keeps the sweep agreeing with the presence rule.
 *
 * Absent, blank and non-string values never match anything, including each
 * other.
 */
export function protectedValuesMatch(
  target: ProtectedTarget,
  left: unknown,
  right: unknown
): boolean {
  const normalized = comparableProtectedValue(target, left);
  return normalized !== undefined && normalized === comparableProtectedValue(target, right);
}

/**
 * Whether a target names secret material. False for `defaultIdentity`, which
 * points at a key rather than being one — so its removal is gated, but it is
 * never stripped out of a stored copy.
 */
export function isSecretProtectedTarget(target: ProtectedTarget): boolean {
  return PROTECTED_FIELDS[target.split(".")[0] as ProtectedConfigField].secret;
}

/**
 * Return `config` without the fields the named targets sit in, plus the legacy
 * names those fields may still be spelled with on disk.
 *
 * Whole fields rather than individual leaves on purpose: a copy stripped to
 * `x402: { network }` no longer satisfies {@link assertValidConfig}, so it
 * would refuse to restore. Losing `tempo.accountId` from an undo is a small
 * price beside keeping a private key.
 */
export function withoutProtectedTargets(
  config: Config,
  targets: readonly ProtectedTarget[]
): Config {
  const dropping = new Set<string>();
  for (const target of targets) {
    const field = target.split(".")[0] as ProtectedConfigField;
    dropping.add(field);
    for (const alias of PROTECTED_FIELDS[field].aliases) dropping.add(alias);
  }
  return Object.fromEntries(
    Object.entries(config as Record<string, unknown>).filter(([field]) => !dropping.has(field))
  ) as Config;
}

/**
 * One line of `config-audit.jsonl`. Field paths and metadata only — never a
 * before/after value, and never anything a credential could be reconstructed
 * from.
 */
export interface ConfigAuditRecord {
  /** ISO-8601 timestamp of the commit. */
  ts: string;

  event: "create" | "update" | "rollback" | "pinned" | "backup_retired" | "backup_sanitized";
  /** Command or code path responsible, e.g. `wallet_disconnect`. */
  reason: string;

  fields: readonly string[];
  /** Protected targets this write was authorized to remove, when any. */
  removed?: readonly string[];
  /** Protected secrets this write replaced, and stripped from the copies. */
  superseded?: readonly string[];

  slot?: ConfigSnapshotSlot;

  sweptSlots?: readonly ConfigSnapshotSlot[];

  source?: ConfigSnapshotSlot;
  /** Whether a rolling rollback copy is available after this write. */
  backup: boolean;
  /** Writing process, so two interleaved CLIs stay separable in the trail. */
  pid: number;
}

/**
 * Append one record to the audit trail at mode 0600.
 *
 * Best-effort by design, and deliberately the last thing a mutation does: a
 * trail that cannot be written is worth a missing line, never a wallet
 * credential that failed to persist.
 */
export function appendConfigAudit(record: ConfigAuditRecord): void {
  try {
    ensureConfigDir();
    appendFileSync(CONFIG_AUDIT_FILE, JSON.stringify(record) + "\n", { mode: 0o600 });
    // `appendFileSync`'s mode applies only to a file it creates, so a trail
    // already sitting at a looser mode would stay there forever — the same trap
    // `writeJsonAtomic` guards against on the config itself.
    chmodSync(CONFIG_AUDIT_FILE, 0o600);
  } catch {
    // The commit already landed; the trail is evidence, not a gate.
  }
}

export function protectedRemovalError(
  targets: readonly ProtectedTarget[],
  reason: string
): DvmError {
  const named = targets.join(", ");
  const one = targets.length === 1;
  return new DvmError(
    "config_protected_field",
    `The '${reason}' change would remove ${named} from the local configuration.`,
    `Nothing was written. ${named} ${one ? "is a credential or identity pointer" : "are credentials or identity pointers"} nothing else on this machine records, so only a command that names ${one ? "it" : "them"} explicitly may remove ${one ? "it" : "them"} — 'dvm wallet disconnect', 'dvm wallet tempo-disconnect' and 'dvm wallet x402-disconnect' are those commands.`,
    { fields: targets }
  );
}

interface ProtectedFieldSpec {
  /** Legacy names the same value may still sit under. */
  aliases: readonly string[];
  /** Leaves carrying the credential. Empty when the field itself is the value. */
  credentialLeaves: readonly string[];

  secret: boolean;
  /**
   * Whether the credential is hex, and therefore the same key however it is
   * cased. `0x2E2E…` and `0x2e2e…` unlock the same wallet.
   */
  hexCredential: boolean;
}

const PROTECTED_FIELDS: Record<ProtectedConfigField, ProtectedFieldSpec> = {
  nwcUri: { aliases: [], credentialLeaves: [], secret: true, hexCredential: false },

  defaultIdentity: { aliases: [], credentialLeaves: [], secret: false, hexCredential: false },

  tempo: { aliases: ["mpp"], credentialLeaves: ["apiKey"], secret: true, hexCredential: true },
  x402: { aliases: [], credentialLeaves: ["privateKey"], secret: true, hexCredential: true },
};

/** Shape of a value at one point in the config tree. An empty node is a leaf. */
interface ShapeNode {
  readonly [key: string]: ShapeNode;
}

/**
 * Which keys are schema and which are data, for path emission.
 *
 * A `"*"` entry marks a record-shaped field: its keys are caller data — a DVM
 * origin, a builder pubkey — and collapse to `*` in every emitted path.
 */
const CONFIG_PATH_SHAPE: ShapeNode = {
  float: { statedBudget: {}, connectedAt: {}, alias: {}, methods: {} },
  x402: { privateKey: {}, network: {} },
  tempo: { method: {}, accountId: {}, apiKey: {}, network: {} },
  credit: {
    targetJobs: {},
    posture: {},
    tier0Cap: {},
    tier1Cap: {},
    pocketTarget: {},
    fundingRail: {},
    perDvm: { "*": { targetJobs: {}, posture: {}, fundingRail: {}, dvmId: {}, builderPubkey: {} } },
    trustOverrides: { "*": {} },
  },
  feedback: { posture: {} },
};

type FieldKind = "string" | "number" | "object" | "string[]";

const CONFIG_FIELD_TYPES: Record<string, FieldKind> = {
  nwcUri: "string",
  float: "object",
  defaultBudget: "string",
  autoPayThreshold: "string",
  defaultMaxPayments: "number",
  cashuMints: "string[]",
  x402: "object",
  tempo: "object",
  defaultRail: "string",
  defaultIdentity: "string",
  credit: "object",
  feedback: "object",
};

/** Leaves that must be present and well-typed whenever their parent field is. */
const CONFIG_LEAF_TYPES: Record<string, FieldKind> = {
  "float.connectedAt": "string",
  "x402.privateKey": "string",
  "tempo.method": "string",
};

function collectChangedPaths(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  shape: ShapeNode | undefined,
  prefix: string,
  found: Set<string>
): void {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const held = before[key];
    const kept = after[key];
    if (deepEqual(held, kept)) continue;

    const known = shape !== undefined && Object.hasOwn(shape, key);
    const wildcard = !known && shape !== undefined && Object.hasOwn(shape, "*");
    const child = known ? shape[key] : wildcard ? shape["*"] : undefined;
    const path = prefix ? `${prefix}.${wildcard ? "*" : key}` : key;

    const descendable =
      child !== undefined &&
      Object.keys(child).length > 0 &&
      (held === undefined || isPlainObject(held)) &&
      (kept === undefined || isPlainObject(kept));

    if (descendable) {
      collectChangedPaths(
        isPlainObject(held) ? held : {},
        isPlainObject(kept) ? kept : {},
        child,
        path,
        found
      );
    } else {
      found.add(path);
    }
  }
}

/**
 * Every top-level field a reset may clear: the fields this build knows the
 * shape of, minus {@link PROTECTED_CONFIG_FIELDS}.
 *
 * Computed rather than listed, so a field added to the schema is resettable the
 * day it lands instead of the day someone remembers a second list exists.
 */
function resettableConfigFields(): ConfigField[] {
  const guarded = new Set<string>(PROTECTED_CONFIG_FIELDS);
  return Object.keys(CONFIG_FIELD_TYPES).filter((field) => !guarded.has(field)) as ConfigField[];
}

function invalidFieldError(path: string, kind: FieldKind): DvmError {
  return new DvmError(
    "config_invalid",
    `Config field '${path}' must be ${describeKind(kind)}.`,
    `Nothing was written. Correct the field in ${CONFIG_FILE}, or run 'dvm doctor' for the full picture.${rollbackSuffix()}`
  );
}

function describeKind(kind: FieldKind): string {
  switch (kind) {
    case "string":
      return "a string";
    case "number":
      return "a number";
    case "object":
      return "an object";
    case "string[]":
      return "an array of strings";
  }
}

function matchesKind(value: unknown, kind: FieldKind): boolean {
  switch (kind) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isPlainObject(value);
    case "string[]":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
  }
}

function rollbackSuffix(): string {
  // Both slots, so a caller whose only surviving copy is the pinned snapshot is
  // still pointed at it — `dvm doctor`'s corrupt-config hint already falls back
  // this way and the two must agree.
  const stored = describeConfigBackup() ?? describeConfigBackup("pinned");
  return stored === null
    ? ""
    : ` A stored copy of the previous configuration is at ${stored.path}.`;
}

function writeJsonAtomic(path: string, value: unknown): void {
  ensureConfigDir();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  // `writeFileSync`'s mode only applies to a file it creates, so a temp left
  // behind by an earlier crash would otherwise carry its old mode across the
  // rename and onto the config.
  chmodSync(tmp, 0o600);
  commitTmp(tmp, path);
}

function commitTmp(tmp: string, path: string): void {
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

/** Empty and whitespace-only credentials count as removals, despite being strings. */
function isPresentValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim().length > 0;
}

function comparableProtectedValue(target: ProtectedTarget, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const field = target.split(".")[0] as ProtectedConfigField;
  return PROTECTED_FIELDS[field].hexCredential ? trimmed.toLowerCase() : trimmed;
}

function patchShapeError(message: string): DvmError {
  return new DvmError(
    "config_patch_invalid",
    message,
    "A change declares `set` (fields to write) and `unset` (field names to remove). Anything else cannot be applied, and nothing was written."
  );
}

function freezeDeep(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) freezeDeep(nested);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toOctal(mode: number): string {
  return "0" + mode.toString(8).padStart(3, "0");
}
