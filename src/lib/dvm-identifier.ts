import { CAPABILITY_NAME_RE, DvmError, shellQuoteArg, type ProviderInfo } from "@dvmkit/sdk/internal";

import { loadFavorites } from "./favorites";

/**
 * Tag-shape regex shared with the SDK's capability validator
 * (`CAPABILITY_NAME_RE`) so the wire shape and the CLI
 * parser stay in lockstep. DVM names obey the same tag shape — there's only
 * one alphabet for slash-form identifiers like `cast/add-episode`.
 */
const TAG_NAME_RE = CAPABILITY_NAME_RE;

export interface ParsedDvmIdentifier {
  ownerHandle: string;
  /** DVM slug (e.g. `cast`) — the portion after `--` before the optional `/`. */
  slug: string;
  dvmId: string;
  /** Capability name (e.g. `add-episode`) — present when the user typed the slash form. */
  capability?: string;
}

export interface ResolvedDvmReference {
  dvmId: string;
  capability?: string;
  endpoint: string;
  /** Qualified identifier details when the input itself was owner-qualified. */
  qualified?: ParsedDvmIdentifier;
}

/** Existing platform handle grammar: 2–20 lowercase alphanumeric characters or single hyphens. */
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Parse an owner-qualified `-d` identifier into its owner, slug, and optional
 * capability. Bare names are deliberately rejected here: callers may only use
 * one when a local favorite resolved it before this parser runs.
 */
export function parseDvmIdentifier(raw: string): ParsedDvmIdentifier {
  if (raw.length === 0 || raw.includes(" ")) {
    throw new DvmError(
      "invalid_dvm_identifier",
      `Invalid DVM identifier: "${raw}".`,
      "Use `<handle>--<slug>` (for example `dvmkit--narrate`) or add `/capability` (for example `dvmkit--cast/add-episode`).",
      undefined,
      `Invalid DVM identifier: "${raw}".`
    );
  }
  const parts = raw.split("/");
  if (parts.length > 2) {
    throw new DvmError(
      "invalid_dvm_identifier",
      `Invalid DVM identifier "${raw}" — too many slashes.`,
      "Use `<handle>--<slug>` or `<handle>--<slug>/<capability>`.",
      undefined,
      `Invalid DVM identifier "${raw}".`
    );
  }
  const [dvmId, capability] = parts;
  const separator = dvmId.indexOf("--");
  if (separator === -1) {
    throw new DvmError(
      "unqualified_dvm_identifier",
      `"${dvmId}" is not an owner-qualified DVM identifier.`,
      "Run `dvm search` to find a provider, use `<handle>--<slug>`, pass --endpoint <url>, or save the endpoint as a favorite.",
      undefined,
      `DVM identifier "${dvmId}" needs an owner handle.`
    );
  }
  const ownerHandle = dvmId.slice(0, separator);
  const slug = dvmId.slice(separator + 2);
  if (!isValidHandle(ownerHandle)) {
    throw new DvmError(
      "invalid_dvm_identifier",
      `Invalid owner handle "${ownerHandle}" in "${raw}".`,
      "Owner handles must be 2–20 lowercase letters/digits with single hyphens, and cannot start or end with a hyphen.",
      undefined,
      `Invalid owner handle "${ownerHandle}".`
    );
  }
  if (!TAG_NAME_RE.test(slug)) {
    throw new DvmError(
      "invalid_dvm_identifier",
      `Invalid DVM slug "${slug}" in "${raw}".`,
      "DVM slugs must be lowercase letters/digits/hyphens and start with a letter or digit.",
      undefined,
      `Invalid DVM slug "${slug}".`
    );
  }
  if (parts.length === 2) {
    if (!TAG_NAME_RE.test(capability)) {
      throw new DvmError(
        "invalid_dvm_identifier",
        `Invalid capability name "${capability}".`,
        "Capability names must be lowercase letters/digits/hyphens and start with a letter or digit.",
        undefined,
        `Invalid capability name "${capability}".`
      );
    }
    return { ownerHandle, slug, dvmId, capability };
  }
  return { ownerHandle, slug, dvmId };
}

export function formatIdentifier(dvmId: string, capability?: string): string {
  return capability ? `${dvmId}/${capability}` : dvmId;
}

/**
 * Resolve a caller-provided identifier without ever performing network I/O.
 * A local favorite wins first, including the historical bare-name shorthand;
 * every other value must be owner-qualified and maps to the wildcard endpoint.
 */
export function resolveDvmReference(raw: string): ResolvedDvmReference {
  const parts = raw.split("/");
  if (parts.length > 2) {
    throw new DvmError(
      "invalid_dvm_identifier",
      `Invalid DVM identifier "${raw}" — too many slashes.`,
      "Use `<handle>--<slug>` or `<handle>--<slug>/<capability>`.",
      undefined,
      `Invalid DVM identifier "${raw}".`
    );
  }
  const [dvmId, capability] = parts;
  const favs = loadFavorites();
  if (Object.hasOwn(favs, dvmId)) {
    if (parts.length === 2 && !TAG_NAME_RE.test(capability)) {
      throw new DvmError(
        "invalid_dvm_identifier",
        `Invalid capability name "${capability}".`,
        "Capability names must be lowercase letters/digits/hyphens and start with a letter or digit.",
        undefined,
        `Invalid capability name "${capability}".`
      );
    }
    const qualified = dvmId.includes("--") ? parseDvmIdentifier(raw) : undefined;
    return { dvmId, capability, endpoint: favs[dvmId].endpoint, qualified };
  }
  const qualified = parseDvmIdentifier(raw);
  return {
    dvmId: qualified.dvmId,
    capability: qualified.capability,
    endpoint: `https://{domain}`.replace("{domain}", `${qualified.dvmId}.dvmkit.ai`),
    qualified,
  };
}

/** Validate a public owner handle without importing platform runtime code into the CLI. */
function isValidHandle(handle: string): boolean {
  return (
    handle.length >= 2 && handle.length <= 20 && HANDLE_RE.test(handle) && !handle.includes("--")
  );
}

/**
 * Pin a capability name against `/v1/info.capabilities`. Returns the canonical
 * name on success. Throws `capability_unavailable` when the DVM doesn't
 * advertise capabilities (pre- server), `unknown_capability` when the
 * caller typed a slash form that doesn't match, and `ambiguous_capability`
 * when the caller did not specify a capability against a multi-capability
 * DVM. Retry commands use caller addressing information and validated capability
 * tokens, never identifiers inferred from provider metadata.
 */
export function resolveCapability(
  info: ProviderInfo,
  requested: string | undefined,
  dvmId: string | undefined,
  endpoint?: string
): string {
  const caps = info.capabilities ? Object.keys(info.capabilities) : [];
  const reference = dvmId ?? "this endpoint";
  if (caps.length === 0) {
    throw new DvmError(
      "capability_unavailable",
      `${reference} doesn't advertise any capabilities on /v1/info.`,
      "The provider may be running an older SDK that predates capability dispatch — try `dvm describe <endpoint>` to inspect."
    );
  }
  if (requested !== undefined) {
    if (caps.includes(requested)) return requested;
    throw new DvmError(
      "unknown_capability",
      `"${requested}" is not a capability of ${reference}.`,
      capabilityRetryHint(caps, dvmId, endpoint),
      { available_capabilities: caps, _provider_fields: ["available_capabilities"] }
    );
  }
  if (caps.length === 1) return caps[0];
  throw new DvmError(
    "ambiguous_capability",
    `${reference} has multiple capabilities; specify one from available_capabilities.`,
    capabilityRetryHint(caps, dvmId, endpoint),
    { available_capabilities: caps, _provider_fields: ["available_capabilities"] }
  );
}

export function capabilityQuoteCommand(endpoint: string, capability: string, dvmId?: string): string {
  const target = dvmId
    ? `-d ${shellQuoteArg(formatIdentifier(dvmId, capability))}`
    : `--endpoint ${shellQuoteArg(`${endpoint.replace(/\/+$/, "")}/${encodeURIComponent(capability)}`)}`;
  return `dvm quote ${target}`;
}

function capabilityRetryHint(caps: string[], dvmId?: string, endpoint?: string): string {
  const capability = caps.find((name) => TAG_NAME_RE.test(name));
  if (!capability || (!dvmId && !endpoint)) {
    return endpoint
      ? `Inspect the available_capabilities with \`dvm describe ${shellQuoteArg(endpoint)}\`.`
      : "Choose a name from available_capabilities and append /<capability> to your DVM reference.";
  }
  const command = capabilityQuoteCommand(endpoint ?? "", capability, dvmId);
  let alternate = "";
  if (endpoint && !dvmId) {
    const url = new URL(endpoint);
    if (url.protocol === "https:" && !url.port && (url.pathname === "/" || url.pathname === "") && url.hostname.endsWith(".dvmkit.ai")) {
      const hostId = url.hostname.slice(0, -".dvmkit.ai".length);
      try {
        parseDvmIdentifier(hostId);
        alternate = ` Or \`${capabilityQuoteCommand(endpoint, capability, hostId)} --data '{}'\`.`;
      } catch {
        // Only a valid owner-qualified hostname supports the -d alternative.
      }
    }
  }
  return `Try \`${command} --data '{}'\` using a name from available_capabilities. Replace --data '{}' with the input for that capability.${alternate}`;
}
