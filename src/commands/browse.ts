import { providerFields } from "../lib/provider-output";
import { type NextAction } from "../lib/next-action";
import {
  asProviderText,
  DvmError,
  providerTextToString,
} from "@dvmkit/sdk/internal";
import {
  info,
  json,
} from "../lib/output";

import {
  buildDiscoveryRows,
  discoveryCapabilityJson,
  type DiscoveryCapability,
  type DiscoveryDisplay,
  type DiscoveryOwner,
  type DiscoveryRowFields,
  type DiscoveryTrust,
  renderDiscoveryDisplay,
} from "../lib/discovery-rows";
import { runDiscoveryLifecycle } from "../lib/discovery-lifecycle";
import { loadFavorites, resolveEndpoint } from "../lib/favorites";
import { parseDiscoveryInteger, parseDiscoveryTimeout } from "../lib/discovery-options";
import { progressNotice } from "../lib/progress-notice";
import { createDvmTransport } from "../lib/transport";

export interface BrowseOptions {
  tag?: string[];
  /** Owner handle filter — case-insensitive equality on the owner handle. */
  builder?: string;
  /** `all` (default) or `platform` — hides externally-registered DVMs when `platform`. */
  source?: string;
  /** `reputation` (default, quality-weighted), `name` (alphabetical), or `recency` (newest first). */
  sort?: string;
  /** Page size — default 10, max 50. */
  limit?: string;
  /** Pagination offset — default 0. */
  offset?: string;
  endpoint?: string;
  human?: boolean;
  /** Timeout in seconds. */
  timeout?: string;
}

/** A single browse result as the discover DVM returns it. Mirrors `BrowseResult` from the DVM types but kept local so this command has no compile-time dependency on the DVM package. */
interface BrowseResultEntry {
  dvm_id: string | null;
  owner_handle: string | null;
  identifier: string | null;
  slug: string;
  name: string;
  description: string;
  tags: string[];
  endpoint: string;
  pricing: { max: { amount: number; currency: string } } | null;
  price_raw?: string | number;
  auth?: string[];
  input_schema?: Record<string, unknown>;
  reputation?: {
    totalRequests: number;
    successRate: number;
    avgLatencyMs: number | null;
  } | null;
  owner?: DiscoveryOwner | null;
  createdAt?: number;
  capabilities?: DiscoveryCapability[];
  trust?: DiscoveryTrust;
  display?: DiscoveryDisplay;
}

interface BrowseResponse {
  entries: BrowseResultEntry[];
  total: number;
  offset: number;
  limit: number;
  query: null;
}

/**
 * One rendered row in the browse output. Browse returns one entry per DVM;
 * `buildDiscoveryRows` expands the advertised capabilities to one row per
 * `(dvm, capability)` pair so callers can pipe the slash-form `identifier`
 * straight into `dvm request -d <identifier>` without an extra `dvm describe`
 * round-trip.
 */
interface ExpandedBrowseEntry extends BrowseResultEntry, DiscoveryRowFields {}

/**
 * Default discover endpoint — the first-party `discover` DVM hosted on the
 * dvmkit platform. Overridable via `--endpoint` or `DVM_DISCOVER_ENDPOINT`.
 */
const DEFAULT_DISCOVER_ENDPOINT = "https://discover.dvmkit.ai";

function firstNonEmpty(...candidates: (string | undefined)[]): string | undefined {
  for (const c of candidates) {
    if (c && c.length > 0) return c;
  }
  return undefined;
}

export async function browse(opts: BrowseOptions): Promise<void> {
  const rawEndpoint =
    firstNonEmpty(opts.endpoint, process.env.DVM_DISCOVER_ENDPOINT) ?? DEFAULT_DISCOVER_ENDPOINT;
  const endpoint = resolveEndpoint(rawEndpoint);

  const tags = opts.tag?.length ? opts.tag : undefined;
  const builder = opts.builder?.length ? opts.builder : undefined;

  const source = opts.source ?? "all";
  if (source !== "all" && source !== "platform") {
    throw new DvmError(
      "invalid_source",
      `Invalid source: "${source}".`,
      "Use 'all' or 'platform'."
    );
  }

  const sort = opts.sort ?? "reputation";
  if (sort !== "reputation" && sort !== "name" && sort !== "recency") {
    throw new DvmError(
      "invalid_sort",
      `Invalid sort: "${sort}".`,
      "Use 'reputation', 'name', or 'recency'."
    );
  }

  const limit = parseDiscoveryInteger(opts.limit, {
    code: "invalid_limit",
    name: "limit",
    defaultValue: 10,
    min: 1,
    max: 50,
    hint: "Use an integer from 1–50.",
  });
  const offset = parseDiscoveryInteger(opts.offset, {
    code: "invalid_offset",
    name: "offset",
    defaultValue: 0,
    min: 0,
    hint: "Use a non-negative integer.",
  });
  const timeout = parseDiscoveryTimeout(opts.timeout);

  const input = JSON.stringify({ tags, builder, source, sort, limit, offset });

  const transport = createDvmTransport();
  const ref = { endpoint };

  progressNotice("Browsing catalog...", opts.human);

  try {
    const result = await runDiscoveryLifecycle({
      transport,
      provider: ref,
      capability: "browse",
      input,
      timeoutMs: timeout,
    });
    if (result.summary) {
      outputResults(result.summary, opts.human, result.nextAction);
      return;
    }

    // Provider-side `ctx.fail("<code>: <message>")` surfaces as a cancel —
    // lift the code prefix straight into a DvmError so agents can branch on
    // it instead of guessing from a generic timeout.
    const cancelMsg = result.messages.find((m) => m.type === "cancel");
    if (cancelMsg) {
      throw cancelMessageToError(cancelMsg.content as { reason?: string });
    }

    if (result.nextAction) {
      if (result.nextAction.type === "poll") {
        throw new DvmError(
          "timeout",
          "Browse is still processing.",
          providerTextToString(result.nextAction.hint)
        );
      }
    }

    throw new DvmError(
      "timeout",
      "Browse did not complete in time.",
      "Try again or increase --timeout."
    );
  } finally {
    transport.close();
  }
}

function cancelMessageToError(content: { reason?: string }): DvmError {
  const reason = content.reason ?? "Browse was cancelled by the provider.";
  const match = /^([a-z][a-z0-9_]*):\s*(.+)$/.exec(reason);
  const code = match?.[1] ?? "browse_failed";
  const message = match?.[2] ?? reason;
  return new DvmError(code, message);
}

function outputResults(
  resultJson: string,
  human: boolean | undefined,
  nextAction: NextAction
): void {
  let output: BrowseResponse;
  try {
    output = JSON.parse(resultJson) as BrowseResponse;
  } catch {
    if (human) {
      info(resultJson);
    } else {
      json(providerFields({ result: resultJson }));
    }
    return;
  }

  const expanded: ExpandedBrowseEntry[] = buildDiscoveryRows(output.entries);

  const favs = loadFavorites();
  const endpointToAlias: Record<string, string> = {};
  for (const [alias, fav] of Object.entries(favs)) {
    endpointToAlias[fav.endpoint] = alias;
  }

  if (human) {
    renderHuman(expanded, output, endpointToAlias);
    return;
  }

  const entries = expanded.map((r) => {
    const alias = endpointToAlias[r.endpoint];
    // Wrap provider-supplied free-text fields so an agent's framework can audit provenance.
    const wrapped: Record<string, unknown> = {
      ...r,
      name: asProviderText(r.name),
      description: asProviderText(r.description),
      tags: r.tags.map((t) => asProviderText(t)),
      ...discoveryCapabilityJson(r),
    };
    delete wrapped._provider_fields;
    if (alias) delete wrapped.favorite;
    const marked = providerFields(wrapped);
    return alias ? { ...marked, favorite: alias } : marked;
  });

  // `total` stays as the discover-side filtered DVM count (drives pagination
  // math); `provider_count` is the in-page DVM count pre-expansion. Mirrors
  // search.ts so agents can reason about pagination without conflating one
  // DVM with its capability rows.
  // Mark rows individually so their CLI-added siblings stay outside producer metadata.
  const producerOutput: Record<string, unknown> = { ...output };
  for (const field of ["entries", "provider_count", "next_action", "_provider_fields"]) delete producerOutput[field];
  const payload: Record<string, unknown> = {
    ...providerFields(producerOutput),
    entries,
    total: output.total,
    offset: output.offset,
    limit: output.limit,
    query: output.query,
    provider_count: output.entries.length,
  };
  if (nextAction) {
    payload.next_action = nextAction;
  }
  json(payload);
}

function renderHuman(
  expanded: ExpandedBrowseEntry[],
  output: BrowseResponse,
  endpointToAlias: Record<string, string>
): void {
  const { total, offset, limit } = output;
  const inPageDvmCount = output.entries.length;

  if (expanded.length === 0) {
    info(
      total === 0
        ? "No DVMs found."
        : `No DVMs at offset ${offset.toString()} (total: ${total.toString()}).`
    );
    return;
  }

  for (let i = 0; i < expanded.length; i++) {
    const r = expanded[i];
    const title = r.identifier ?? `--endpoint ${r.endpoint}`;
    const alias = endpointToAlias[r.endpoint];
    const aliasMark = alias ? ` [* @${alias}]` : "";
    info(`${title}${aliasMark}`);

    const desc = r.capability === undefined ? r.description : r.capability_description;
    if (desc) info(`  ${desc}`);
    if (r.display?.endpoint_hint) info(`  ${r.display.endpoint_hint}`);
    renderDiscoveryDisplay(r, "  ");
    if (r.display?.price == null) info(`  Price: ${formatRawPrice(r)}`);

    if (i < expanded.length - 1) info("");
  }

  info("");
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  const nextOffset = offset + inPageDvmCount;
  if (nextOffset < total) {
    info(
      `Page ${page.toString()} of ${pages.toString()} — \`dvm browse --offset ${nextOffset.toString()}\` for next.`
    );
  } else {
    info(`Page ${page.toString()} of ${pages.toString()}.`);
  }
}

function formatRawPrice(r: BrowseResultEntry): string {
  if (r.pricing) {
    const { amount, currency } = r.pricing.max;
    if (currency === "usd") {
      if (amount === 0) return "Free";
      return amount >= 0.01 ? `$${amount.toFixed(2)}` : `$${amount.toFixed(4)}`;
    }
    return `${amount.toString()} ${currency}`;
  }
  return "Price unknown";
}
