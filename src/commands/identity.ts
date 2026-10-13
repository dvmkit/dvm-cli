import {
  type CliIdentityEntry,
  deriveIdentityFromPrivkey,
  DvmError,
  cliIdentityStoreGenerateIdentity as generateIdentity,
  IDENTITIES_FILE,
  IDENTITIES_VERSION,
  type IdentitiesFile,
  identitiesFileExists,
  loadIdentities,
  saveIdentities,
  withIdentitiesLock,
} from "@dvmkit/sdk/internal";
import {
  authorizeProtectedRemoval,
} from "../lib/config-mutation";
import {
  info,
  json,
} from "../lib/output";
import {
  loadConfig,
  updateConfig,
} from "../lib/identity";

export interface IdentityCommonOptions {
  human?: boolean;
}

export interface IdentityCreateOptions extends IdentityCommonOptions {
  /** Overwrite an existing identity of the same name. */
  force?: boolean;
}

export interface IdentityShowOptions extends IdentityCommonOptions {
  /** Also print the private key. Off by default. */
  reveal?: boolean;
}

/**
 * JSON shape emitted by `dvm identity show`. `privkey` is present **only**
 * when `--reveal` is passed — the secret is gated out of the default output so
 * a bare `dvm identity show` can't leak it into logs or an agent's transcript.
 */
export interface IdentityShowResult {
  name: string;
  /** 32-byte BIP-340 x-only public key, lowercase hex (64 chars). */
  pubkey: string;
  /** Epoch millis when the entry was generated or imported. */
  createdAt: number;
  default: boolean;
  /** 32-byte secp256k1 secret key, lowercase hex (64 chars). Only set under `--reveal`. */
  privkey?: string;
}

export type IdentityListOptions = IdentityCommonOptions;

export interface IdentityDeleteOptions extends IdentityCommonOptions {
  /** Required when deleting the currently-configured default identity. */
  force?: boolean;
}

export interface IdentityImportOptions extends IdentityCommonOptions {
  /** 64-char lowercase hex secp256k1 private key. */
  privkey?: string;
}

export interface IdentityUseOptions extends IdentityCommonOptions {
  /** Select no identity at all, clearing the pointer rather than moving it. */
  clear?: boolean;
}

/**
 * Provision a `default` identity into `~/.dvm/identities.json` if the file
 * does not already exist. Called from `dvm init` so a fresh install can sign
 * descriptor-auth submissions with zero ceremony.
 *
 * Returns the generated entry (or `null` if the file already existed and the
 * call was a no-op) so callers can surface the new pubkey to the user. The
 * existence check + write are performed inside {@link withIdentitiesLock} so
 * two concurrent `dvm init` invocations can't both provision a `default`.
 */
export async function ensureDefaultIdentity(): Promise<{
  name: string;
  entry: CliIdentityEntry;
} | null> {
  return withIdentitiesLock(() => {
    if (identitiesFileExists()) return null;
    const entry = generateIdentity();
    saveIdentities({
      version: IDENTITIES_VERSION,
      identities: { default: entry },
    });
    return { name: "default", entry };
  });
}

export async function identityCreate(name: string, opts: IdentityCreateOptions): Promise<void> {
  assertNameSyntax(name);
  const entry = await withIdentitiesLock(() => {
    const file = loadIdentities() ?? freshFile();
    if (Object.hasOwn(file.identities, name) && !opts.force) {
      throw new DvmError(
        "identity_exists",
        `An identity named '${name}' already exists.`,
        "Pass --force to overwrite, or pick a different name."
      );
    }
    const fresh = generateIdentity();
    file.identities[name] = fresh;
    saveIdentities(file);
    return fresh;
  });

  if (opts.human) {
    info(`Created identity '${name}'`);
    info(`  pubkey: ${entry.pubkey}`);
  } else {
    json({ status: "created", name, pubkey: entry.pubkey, createdAt: entry.createdAt });
  }
}

export function identityShow(name: string, opts: IdentityShowOptions): void {
  const file = loadIdentities();
  if (!file || !Object.hasOwn(file.identities, name)) {
    throw new DvmError(
      "identity_not_found",
      `No identity named '${name}' is configured.`,
      file && Object.keys(file.identities).length > 0
        ? `Available: ${Object.keys(file.identities).join(", ")}.`
        : "Run 'dvm identity create <name>' to generate one."
    );
  }
  const entry = file.identities[name];
  const defaultIdentity = loadConfig()?.defaultIdentity ?? null;

  if (opts.human) {
    info(`Identity '${name}'${defaultIdentity === name ? " (default)" : ""}`);
    info(`  pubkey: ${entry.pubkey}`);
    if (opts.reveal) info(`  privkey: ${entry.privkey}`);
    info(`  createdAt: ${new Date(entry.createdAt).toISOString()}`);
  } else {
    const result: IdentityShowResult = {
      name,
      pubkey: entry.pubkey,
      createdAt: entry.createdAt,
      default: defaultIdentity === name,
      ...(opts.reveal ? { privkey: entry.privkey } : {}),
    };
    json(result);
  }
}

export function identityList(opts: IdentityListOptions): void {
  const file = loadIdentities();
  const defaultIdentity = loadConfig()?.defaultIdentity ?? null;
  const entries = Object.entries(file?.identities ?? {})
    .map(([name, entry]) => ({
      name,
      pubkey: entry.pubkey,
      createdAt: entry.createdAt,
      default: defaultIdentity === name,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (opts.human) {
    if (entries.length === 0) {
      info(`No identities configured at ${IDENTITIES_FILE}.`);
      info("Run 'dvm identity create <name>' to generate one.");
      return;
    }
    for (const e of entries) {
      const tag = e.default ? " (default)" : "";
      info(`${e.name}${tag}  ${e.pubkey}`);
    }
  } else {
    json({ identities: entries, defaultIdentity });
  }
}

/**
 * Remove a stored identity, and settle what happens to the default pointer.
 *
 * Deleting the identity `config.defaultIdentity` names would leave that pointer
 * dangling — every signed request then fails on a key that is not there — so
 * the removal is decided rather than discovered. Without `--force` it is
 * refused and the caller is sent to pick a different default; with `--force`
 * the pointer is cleared in the same call, through the one authorization
 * entitled to take it. Deleting any other identity leaves the
 * selection exactly where it was.
 */
export async function identityDelete(name: string, opts: IdentityDeleteOptions): Promise<void> {
  const wasDefault = await withIdentitiesLock(async () => {
    const file = loadIdentities();
    if (!file || !Object.hasOwn(file.identities, name)) {
      throw new DvmError("identity_not_found", `No identity named '${name}' is configured.`);
    }
    const config = loadConfig() ?? {};
    const isDefault = config.defaultIdentity === name;
    if (isDefault && !opts.force) {
      throw new DvmError(
        "identity_is_default",
        `Identity '${name}' is currently the configured default.`,
        "Pick a different default with 'dvm identity use <name>' first, clear the selection with 'dvm identity use --clear', or pass --force to delete it and clear the selection in one step."
      );
    }

    const { [name]: _removedEntry, ...rest } = file.identities;
    saveIdentities({ version: file.version, identities: rest });

    if (isDefault) {
      // Deleting the identity the CLI signs with is the one path entitled to
      // clear the pointer at it, so it says so.
      await updateConfig({
        reason: "identity_delete_default",
        authorize: authorizeProtectedRemoval("defaultIdentity"),
        patch: () => ({ unset: ["defaultIdentity"] }),
      });
    }
    return isDefault;
  });

  if (opts.human) {
    info(`Deleted identity '${name}'`);
    if (wasDefault) {
      info(
        "It was the default, so no identity is selected now. Pick one with 'dvm identity use <name>'."
      );
    }
  } else {
    json({
      status: "deleted",
      name,
      defaultCleared: wasDefault,
      ...(wasDefault
        ? {
            display: `Deleted '${name}', which was the identity this machine signs with. No identity is selected now.`,
            hint: "Select another with 'dvm identity use <name>', or create one with 'dvm identity create <name>'. Requests to DVMs that ask for a signature will fail until one is selected.",
          }
        : {}),
    });
  }
}

export async function identityImport(name: string, opts: IdentityImportOptions): Promise<void> {
  assertNameSyntax(name);
  if (!opts.privkey) {
    throw new DvmError(
      "invalid_argument",
      "--privkey <hex> is required for 'dvm identity import'.",
      "Pass a 64-char lowercase hex secp256k1 secret."
    );
  }
  const privkeyHex = opts.privkey.toLowerCase();
  const entry = await withIdentitiesLock(() => {
    const file = loadIdentities() ?? freshFile();
    if (Object.hasOwn(file.identities, name)) {
      throw new DvmError(
        "identity_exists",
        `An identity named '${name}' already exists.`,
        "Delete it first with 'dvm identity delete <name>', or pick a different name."
      );
    }
    const derived = deriveIdentityFromPrivkey(privkeyHex);
    file.identities[name] = derived;
    saveIdentities(file);
    return derived;
  });

  if (opts.human) {
    info(`Imported identity '${name}'`);
    info(`  pubkey: ${entry.pubkey}`);
  } else {
    json({ status: "imported", name, pubkey: entry.pubkey, createdAt: entry.createdAt });
  }
}

/**
 * Choose the identity `dvm request` / `dvm quote` sign with, or choose none.
 *
 * The only command that moves `config.defaultIdentity` deliberately, and with
 * `--clear` the only one that empties it without deleting the key it names.
 */
export async function identityUse(
  name: string | undefined,
  opts: IdentityUseOptions
): Promise<void> {
  if (opts.clear) {
    if (name !== undefined) {
      throw new DvmError(
        "invalid_argument",
        "'dvm identity use --clear' selects no identity, so it takes no name.",
        `Drop the name to clear the selection, or run 'dvm identity use ${name}' to select that identity.`
      );
    }
    const { previous } = await updateConfig({
      reason: "identity_clear_default",
      authorize: authorizeProtectedRemoval("defaultIdentity"),
      patch: () => ({ unset: ["defaultIdentity"] }),
    });
    const cleared = previous?.defaultIdentity ?? null;
    const display = cleared
      ? `No identity is selected now. '${cleared}' is still stored and can be selected again.`
      : "No identity was selected, and none is now.";
    if (opts.human) {
      info(display);
    } else {
      json({
        status: "default_cleared",
        previous: cleared,
        display,
        hint: "Requests to DVMs that ask for a signature will fail until an identity is selected with 'dvm identity use <name>'. No stored key was deleted; 'dvm identity delete <name>' does that.",
      });
    }
    return;
  }

  if (name === undefined) {
    throw new DvmError(
      "invalid_argument",
      "'dvm identity use' needs the name of a stored identity.",
      "Run 'dvm identity list' to see them, or pass --clear to select none at all."
    );
  }

  await withIdentitiesLock(async () => {
    const file = loadIdentities();
    if (!file || !Object.hasOwn(file.identities, name)) {
      throw new DvmError(
        "identity_not_found",
        `No identity named '${name}' is configured.`,
        file && Object.keys(file.identities).length > 0
          ? `Available: ${Object.keys(file.identities).join(", ")}.`
          : "Run 'dvm identity create <name>' to generate one first."
      );
    }
    await updateConfig({
      reason: "identity_use",
      patch: () => ({ set: { defaultIdentity: name } }),
    });
  });

  if (opts.human) {
    info(`Default identity set to '${name}'`);
  } else {
    json({ status: "default_set", name });
  }
}

function assertNameSyntax(name: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new DvmError(
      "invalid_identity_name",
      `Identity name '${name}' contains invalid characters.`,
      "Use letters, digits, and the characters '_', '.', '-'."
    );
  }
}

function freshFile(): IdentitiesFile {
  return { version: IDENTITIES_VERSION, identities: {} };
}
