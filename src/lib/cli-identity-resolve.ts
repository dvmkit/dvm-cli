import { deriveIdentityFromPrivkey, loadIdentities } from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";
import type { Config } from "./identity";

export type SigningIdentitySource =
  | { kind: "flag"; name: string }
  | { kind: "env" }
  | { kind: "default"; name: string }
  | { kind: "sole"; name: string }
  /** Matched by pubkey — the resume path re-signing as whoever paid. */
  | { kind: "pubkey"; name: string };

export interface ResolvedSigningIdentity {
  /** 32-byte secp256k1 secret, lowercase hex. */
  privkey: string;
  /** 32-byte BIP-340 x-only pubkey, lowercase hex. */
  pubkey: string;

  source: SigningIdentitySource;
}

export interface ResolveSigningIdentityOpts {

  as?: string;

  config?: Config | null;
}

/**
 * Resolve which caller signing identity `dvm request` / `dvm quote` should
 * use to sign a descriptor-auth submission. Resolution chain (first match
 * wins):
 *
 * 1. `--as <name>` flag → look up named identity.
 * 2. `DVM_IDENTITY_KEY=<hex>` env → use as anonymous key (no name lookup).
 * 3. `config.defaultIdentity` → look up named identity.
 * 4. Identities file has exactly one entry → use it.
 * 5. Else → throw `auth_required` listing available identities.
 */
export function resolveSigningIdentity(opts: ResolveSigningIdentityOpts): ResolvedSigningIdentity {

  if (opts.as !== undefined) {
    const file = loadIdentities();
    const entry = file?.identities[opts.as];
    if (!entry) {
      throw new DvmError(
        "auth_required",
        `No identity named '${opts.as}' is configured.`,
        availableHint(file?.identities, "create one with 'dvm identity create <name>'.")
      );
    }
    return {
      privkey: entry.privkey,
      pubkey: entry.pubkey,
      source: { kind: "flag", name: opts.as },
    };
  }

  const envKey = process.env.DVM_IDENTITY_KEY;
  if (envKey) {
    const derived = deriveIdentityFromPrivkey(envKey.toLowerCase());
    return { privkey: derived.privkey, pubkey: derived.pubkey, source: { kind: "env" } };
  }

  const file = loadIdentities();
  const identities = file?.identities ?? {};
  const names = Object.keys(identities);

  const configuredDefault = opts.config?.defaultIdentity;
  if (configuredDefault !== undefined) {
    if (!Object.hasOwn(identities, configuredDefault)) {
      throw new DvmError(
        "auth_required",
        `Configured default identity '${configuredDefault}' no longer exists.`,
        availableHint(identities, "set a new default with 'dvm identity use <name>'.")
      );
    }
    const entry = identities[configuredDefault];
    return {
      privkey: entry.privkey,
      pubkey: entry.pubkey,
      source: { kind: "default", name: configuredDefault },
    };
  }

  if (names.length === 1) {
    const onlyName = names[0];
    const entry = identities[onlyName];
    return {
      privkey: entry.privkey,
      pubkey: entry.pubkey,
      source: { kind: "sole", name: onlyName },
    };
  }

  if (names.length === 0) {
    throw new DvmError(
      "auth_required",
      "This DVM requires a signed request but no caller identity is configured.",
      "Run 'dvm identity create <name>' (or 'dvm init') to generate one, or pass DVM_IDENTITY_KEY=<hex>."
    );
  }
  throw new DvmError(
    "auth_required",
    "Multiple identities are configured but none is selected.",
    `Pass --as <name>, set a default with 'dvm identity use <name>', or export DVM_IDENTITY_KEY=<hex>. Available: ${names.join(", ")}.`
  );
}

/**
 * Look an identity up by its pubkey rather than by name.
 *
 * The pending-submission resume has to re-sign the original call as the caller
 * who paid for it — signing as anyone else would file the job under the wrong
 * pubkey. It therefore can't go through {@link resolveSigningIdentity}, whose
 * answer depends on flags, env, and config that may have changed since. Returns
 * `null` when the key is no longer configured, which makes the submission
 * unresumable rather than mis-signed.
 */
export function findSigningIdentityByPubkey(pubkey: string): ResolvedSigningIdentity | null {
  const wanted = pubkey.toLowerCase();

  const envKey = process.env.DVM_IDENTITY_KEY;
  if (envKey) {
    try {
      const derived = deriveIdentityFromPrivkey(envKey.toLowerCase());
      if (derived.pubkey === wanted) {
        return { privkey: derived.privkey, pubkey: derived.pubkey, source: { kind: "env" } };
      }
    } catch {
      // A malformed DVM_IDENTITY_KEY is the fresh-call path's problem, not ours.
    }
  }

  const identities = loadIdentities()?.identities ?? {};
  for (const [name, entry] of Object.entries(identities)) {
    if (entry.pubkey.toLowerCase() === wanted) {
      return { privkey: entry.privkey, pubkey: entry.pubkey, source: { kind: "pubkey", name } };
    }
  }
  return null;
}

function availableHint(identities: Record<string, unknown> | undefined, suffix: string): string {
  const names = identities ? Object.keys(identities) : [];
  if (names.length === 0) return `No identities are configured — ${suffix}`;
  return `Available identities: ${names.join(", ")}. ${suffix}`;
}
