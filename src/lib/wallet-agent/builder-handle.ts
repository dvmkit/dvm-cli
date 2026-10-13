import { DvmError } from "@dvmkit/sdk/internal";

export const BUILDER_RESERVE_PREFIX = "builder/";

/**
 * Extract the canonical builder handle from a DVM endpoint URL. Used in
 * lockstep across `dvm wallet reserve` (persists `reserved_for`),
 * `dvm wallet release` (matches stored proofs), and the spend-time auto-
 * select path in `prepareAgentSpend`.
 *
 * The handle is the URL's hostname (lowercased), e.g. `"scrape.dvmkit.ai"`
 * from `"https://scrape.dvmkit.ai/v1/info"`. We deliberately ignore path /
 * port / scheme so the marker is stable across reachability quirks (extra
 * trailing slash, alternate port during local testing, etc.).
 *
 * Throws `DvmError("invalid_endpoint", …)` on a malformed URL — the
 * reserve/release CLI commands surface this directly so the user can
 * correct their `--builder` argument.
 */
export function extractBuilderHandle(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new DvmError(
      "invalid_endpoint",
      `Could not parse "${endpoint}" as a URL.`,
      "Pass a full HTTPS URL like `https://scrape.dvmkit.ai`, or a favorite alias like `@scrape`."
    );
  }
  return url.hostname.toLowerCase();
}

/**
 * Compose the `reserved_for` marker for a given builder handle. The
 * `builder/` prefix is kept so future scopes such as `subscription/` can
 * coexist on the same wallet without collision.
 */
export function reservedForMarker(builderHandle: string): string {
  return `${BUILDER_RESERVE_PREFIX}${builderHandle}`;
}
