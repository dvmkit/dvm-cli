/**
 * `dvm credit trust` — manage caller-owned prepaid-credit trust pre-grants.
 *
 * The persisted key is the builder identity rather than the endpoint: one
 * grant covers every DVM that authenticates that builder, while an arbitrary
 * URL cannot inherit it. Provider references are resolved only to discover
 * that identity; raw pubkeys remain available for offline set/remove and
 * recovery after an endpoint changes identity.
 */

import {
  authenticatedBuilderPubkey,
  DvmError,
} from "@dvmkit/sdk/internal";
import {
  info,
  json,
} from "../lib/output";
import {
  loadConfig,
  updateConfig,
} from "../lib/identity";

import { resolveDvmReference } from "../lib/dvm-identifier";
import { resolveEndpoint } from "../lib/favorites";
import { createDvmTransport } from "../lib/transport";

const BUILDER_PUBKEY_RE = /^[0-9a-f]{64}$/i;

export interface CreditTrustOptions {
  list?: boolean;
  /** Remove the grant belonging to this provider reference or raw builder pubkey. */
  remove?: string;
  human?: boolean;
}

export async function creditTrust(
  provider: string | undefined,
  rawCap: string | undefined,
  opts: CreditTrustOptions
): Promise<void> {
  const hasSetArgs = provider !== undefined || rawCap !== undefined;
  if (opts.list) {
    if (hasSetArgs || opts.remove !== undefined) {
      throw invalidOperation(
        "--list cannot be combined with a provider, cap, or --remove.",
        "Run 'dvm credit trust --list' on its own."
      );
    }
    emitList(opts.human ?? false);
    return;
  }

  if (opts.remove !== undefined) {
    if (hasSetArgs) {
      throw invalidOperation(
        "--remove cannot be combined with set arguments.",
        "Remove one pre-grant with 'dvm credit trust --remove <provider>'."
      );
    }
    const identity = await resolveBuilderIdentity(opts.remove);
    const removedCap = await removeGrant(identity.pubkey);
    emitMutation("removed", opts.remove, identity, removedCap, opts.human ?? false);
    return;
  }

  if (!provider || !rawCap) {
    throw invalidOperation(
      "A provider and trust cap are required when setting a pre-grant.",
      "Run 'dvm credit trust <provider> <builder-max|$amount>', 'dvm credit trust --list', or 'dvm credit trust --remove <provider>'."
    );
  }

  const cap = normalizeTrustCap(rawCap);
  const identity = await resolveBuilderIdentity(provider);
  await setGrant(identity.pubkey, cap);
  emitMutation("set", provider, identity, cap, opts.human ?? false);
}

interface ResolvedBuilderIdentity {
  pubkey: string;
  endpoint?: string;
}

function emitList(human: boolean): void {
  const entries = Object.entries(loadConfig()?.credit?.trustOverrides ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([builderPubkey, cap]) => ({ builder_pubkey: builderPubkey, cap }));
  const display =
    entries.length === 0
      ? "No prepaid-credit trust pre-grants are configured."
      : `${String(entries.length)} prepaid-credit trust pre-grant${entries.length === 1 ? " is" : "s are"} configured.`;
  const hint =
    "Set one with 'dvm credit trust <provider> <builder-max|$amount>', or remove one with 'dvm credit trust --remove <provider>'.";

  if (human) {
    info(display);
    for (const entry of entries) info(`  ${entry.builder_pubkey}  ${entry.cap}`);
    info(hint);
    return;
  }
  json({ trust_overrides: entries, count: entries.length, display, hint });
}

function emitMutation(
  status: "set" | "removed",
  provider: string,
  identity: ResolvedBuilderIdentity,
  cap: string,
  human: boolean
): void {
  const capDisplay = cap === "builder-max" ? "up to the DVM's advertised maximum" : `up to ${cap}`;
  const builderLabel = identity.endpoint
    ? `${provider}'s builder identity`
    : `builder ${identity.pubkey}`;
  const display =
    status === "set"
      ? `Prepaid-credit trust pre-granted to every DVM signed by ${builderLabel}, ${capDisplay}.`
      : `Prepaid-credit trust pre-grant removed from every DVM signed by ${builderLabel} (${cap}).`;
  const hint =
    status === "set"
      ? `This is builder-wide, not limited to ${provider}: every DVM whose live /v1/info authenticates this builder identity receives the cap. Inspect it with 'dvm credit trust --list'; that list includes the raw pubkey needed if the provider changes identity.`
      : "Future funding at every DVM signed by this builder returns to the receipt-earned trust ladder. Inspect the remaining grants with 'dvm credit trust --list'.";
  const output = {
    status,
    provider,
    ...(identity.endpoint ? { endpoint: identity.endpoint } : {}),
    builder_pubkey: identity.pubkey,
    cap,
    display,
    hint,
  };

  if (human) {
    info(display);
    info(hint);
    return;
  }
  json(output);
}

async function setGrant(builderPubkey: string, cap: string): Promise<void> {
  await updateConfig({
    reason: "credit_trust_set",
    patch: (current) => {
      const credit = { ...(current?.credit ?? {}) };
      const overrides = withoutBuilder(credit.trustOverrides ?? {}, builderPubkey);
      credit.trustOverrides = { ...overrides, [builderPubkey]: cap };
      return { set: { credit } };
    },
  });
}

async function removeGrant(builderPubkey: string): Promise<string> {
  let removedCap = "";
  await updateConfig({
    reason: "credit_trust_remove",
    patch: (current) => {
      const credit = { ...(current?.credit ?? {}) };
      const entries = Object.entries(credit.trustOverrides ?? {});
      const matches = entries.filter(([key]) => sameBuilder(key, builderPubkey));
      if (matches.length === 0) {
        throw new DvmError(
          "trust_override_not_found",
          `No prepaid-credit trust pre-grant exists for builder ${builderPubkey}.`,
          "Run 'dvm credit trust --list' to see the configured builder identities. If the provider changed identity, remove the old raw pubkey shown there."
        );
      }
      removedCap = matches[0][1];

      const overrides = withoutBuilder(Object.fromEntries(entries), builderPubkey);
      if (Object.keys(overrides).length === 0) delete credit.trustOverrides;
      else credit.trustOverrides = overrides;
      return { set: { credit } };
    },
  });
  return removedCap;
}

function withoutBuilder(
  overrides: Record<string, string>,
  builderPubkey: string
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(overrides).filter(([key]) => !sameBuilder(key, builderPubkey))
  );
}

function sameBuilder(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

async function resolveBuilderIdentity(provider: string): Promise<ResolvedBuilderIdentity> {
  const input = provider.trim();
  if (BUILDER_PUBKEY_RE.test(input)) return { pubkey: input.toLowerCase() };

  const endpoint = resolveProviderEndpoint(input);
  const transport = createDvmTransport();
  try {
    const providerInfo = await transport.describe({ endpoint });
    const builder = providerInfo.builder;
    if (!builder) {
      throw new DvmError(
        "builder_identity_unavailable",
        `${endpoint} does not publish a builder identity on /v1/info.`,
        "A trust pre-grant must follow a builder identity rather than a URL. Ask the provider for its 64-hex builder pubkey, or use --over-trust for one funding."
      );
    }
    const pubkey = authenticatedBuilderPubkey(builder);
    if (!pubkey) {
      throw new DvmError(
        "builder_identity_invalid",
        `${endpoint} publishes an invalid builder identity attestation.`,
        "No trust pre-grant was written. Ask the provider to repair its /v1/info builder identity, or verify and pass the raw builder pubkey yourself."
      );
    }
    return { pubkey, endpoint };
  } finally {
    transport.close();
  }
}

function resolveProviderEndpoint(provider: string): string {
  if (/^https?:\/\//.test(provider)) return provider.replace(/\/+$/, "");
  if (provider.startsWith("@")) return resolveEndpoint(provider).replace(/\/+$/, "");
  return resolveDvmReference(provider).endpoint.replace(/\/+$/, "");
}

function normalizeTrustCap(raw: string): string {
  const value = raw.trim();
  if (value.toLowerCase() === "builder-max") return "builder-max";
  const match = /^\$?(\d+(?:\.\d{1,6})?)$/.exec(value);
  if (!match) throw invalidTrustCap(raw);
  const amount = Number(match[1]);
  const micro = Math.round(amount * 1_000_000);
  if (!Number.isSafeInteger(micro) || micro <= 0) throw invalidTrustCap(raw);
  return `$${match[1]}`;
}

function invalidTrustCap(raw: string): DvmError {
  return new DvmError(
    "invalid_trust_cap",
    `Invalid prepaid-credit trust cap '${raw}'.`,
    "Pass 'builder-max' to accept the DVM's advertised maximum, or a positive USD figure with at most six decimal places, such as '$50'."
  );
}

function invalidOperation(message: string, hint: string): DvmError {
  return new DvmError("invalid_argument", message, hint);
}
