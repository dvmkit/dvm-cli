import { type NextAction } from "../lib/next-action";
import {
  asProviderText,
  type CreditTerms,
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
  type DiscoveryRowFields,
  type DiscoveryTrust,
  renderDiscoveryDisplay,
} from "../lib/discovery-rows";
import { runDiscoveryLifecycle } from "../lib/discovery-lifecycle";
import { loadFavorites, resolveEndpoint } from "../lib/favorites";
import { parseDiscoveryInteger, parseDiscoveryTimeout } from "../lib/discovery-options";
import { progressNotice } from "../lib/progress-notice";
import { createDvmTransport } from "../lib/transport";

export interface SearchOptions {
  query?: string;
  tag?: string[];
  /** Filter to providers that advertise prepaid credit. */
  credit?: boolean;
  /** Search mode: keyword (free) or natural_language (priced) */
  mode?: string;
  limit?: string;
  endpoint?: string;
  human?: boolean;
  /** Timeout in seconds */
  timeout?: string;
}

interface DiscoverResultEntry {
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
  credit: CreditTerms | null;
  score: number;
  match_reason: string;
  capabilities?: DiscoveryCapability[];
  trust?: DiscoveryTrust;
  display?: DiscoveryDisplay;
}

interface DiscoverOutput {
  results: DiscoverResultEntry[];
  query: string;
  mode: "keyword" | "natural_language";
  total: number;
}

/**
 * One rendered row in the search output. The discover response
 * carries one entry per DVM; `buildDiscoveryRows` expands the advertised capabilities
 * to one row per `(dvm, capability)` pair so callers can pipe the slash-form
 * `identifier` straight into `dvm request -d ...`.
 */
interface ExpandedResult extends DiscoverResultEntry, DiscoveryRowFields {}

/**
 * Default discover endpoint — the first-party `discover` DVM hosted on the
 * dvmkit platform. Overridable via `--endpoint` or `DVM_DISCOVER_ENDPOINT`
 * (e.g. when pointing at a self-hosted discover deploy or a local stack).
 */
const DEFAULT_DISCOVER_ENDPOINT = "https://discover.dvmkit.ai";

function firstNonEmpty(...candidates: (string | undefined)[]): string | undefined {
  for (const c of candidates) {
    if (c && c.length > 0) return c;
  }
  return undefined;
}

export async function search(opts: SearchOptions): Promise<void> {
  // `firstNonEmpty` (not `??`) so an empty-string override (`DVM_DISCOVER_ENDPOINT=`
  // in a shellrc / CI env) falls through to the next candidate rather than
  // hitting `resolveEndpoint("")`.
  const rawEndpoint =
    firstNonEmpty(opts.endpoint, process.env.DVM_DISCOVER_ENDPOINT) ?? DEFAULT_DISCOVER_ENDPOINT;
  const endpoint = resolveEndpoint(rawEndpoint);

  const queryText = opts.query ?? "";
  const tags = opts.tag?.length ? opts.tag : undefined;

  if (!queryText && !tags && !opts.credit) {
    throw new DvmError(
      "no_query",
      "No search query provided.",
      "Provide a query, use --tag, or filter with --credit."
    );
  }

  const mode = opts.mode ?? "keyword";
  if (mode !== "keyword" && mode !== "natural_language") {
    throw new DvmError(
      "invalid_mode",
      `Invalid mode: "${mode}".`,
      "Use 'keyword' or 'natural_language'."
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
  const timeout = parseDiscoveryTimeout(opts.timeout);

  const input = JSON.stringify({ query: queryText, mode, limit, tags, credit: opts.credit });

  const transport = createDvmTransport();
  const ref = { endpoint };

  progressNotice("Searching for providers...", opts.human);

  try {
    const result = await runDiscoveryLifecycle({
      transport,
      provider: ref,
      capability: "search",
      input,
      timeoutMs: timeout,
    });
    if (result.summary) {
      outputResults(result.summary, opts.human, result.nextAction);
      return;
    }

    // Surface a provider cancel (`ctx.fail`) as a precise error rather than
    // the fall-through "timeout" below — the discover handler uses
    // `ctx.fail("<code>: <message>")` so we can lift the code straight through.
    const cancelMsg = result.messages.find((m) => m.type === "cancel");
    if (cancelMsg) {
      throw cancelMessageToError(cancelMsg.content as { reason?: string });
    }

    if (result.nextAction) {
      if (result.nextAction.type === "pay") {
        throw new DvmError(
          "payment_required",
          `Natural language search requires payment: ${result.nextAction.display}.`,
          result.nextAction.hint
        );
      }
      if (result.nextAction.type === "poll") {
        throw new DvmError(
          "timeout",
          "Search is still processing.",
          providerTextToString(result.nextAction.hint)
        );
      }
    }

    throw new DvmError(
      "timeout",
      "Search did not complete in time.",
      "Try again or increase --timeout."
    );
  } finally {
    transport.close();
  }
}

/**
 * Map a provider `cancel` message reason into a typed CLI error. The discover
 * handler emits `ctx.fail("<code>: <message>")` (e.g. `nl_unavailable: …`),
 * so we lift the leading code into the `DvmError` code and pass the message
 * through. Reasons that don't match the convention fall back to a generic
 * `search_failed` code with the verbatim reason as the message.
 */
function cancelMessageToError(content: { reason?: string }): DvmError {
  const reason = content.reason ?? "Search was cancelled by the provider.";
  const match = /^([a-z][a-z0-9_]*):\s*(.+)$/.exec(reason);
  const code = match?.[1] ?? "search_failed";
  const message = match?.[2] ?? reason;
  const hint =
    code === "nl_unavailable"
      ? "This discover instance has no LLM key. Re-run without --mode natural_language to use keyword search."
      : undefined;
  return new DvmError(code, message, hint);
}

function outputResults(
  resultJson: string,
  human: boolean | undefined,
  nextAction: NextAction
): void {
  let output: DiscoverOutput;
  try {
    output = JSON.parse(resultJson) as DiscoverOutput;
  } catch {
    if (human) {
      info(resultJson);
    } else {
      json({ result: resultJson });
    }
    return;
  }

  const expanded: ExpandedResult[] = buildDiscoveryRows(output.results);

  const favs = loadFavorites();
  const endpointToAlias: Record<string, string> = {};
  for (const [alias, fav] of Object.entries(favs)) {
    endpointToAlias[fav.endpoint] = alias;
  }

  if (human) {
    if (expanded.length === 0) {
      info("No providers found.");
      return;
    }

    info(`Found ${expanded.length} capability(ies):\n`);
    for (let i = 0; i < expanded.length; i++) {
      const r = expanded[i];
      const alias = endpointToAlias[r.endpoint];
      const label = alias ? ` [* @${alias}]` : "";
      info(`  ${i + 1}. ${r.identifier ?? `--endpoint ${r.endpoint}`}${label}`);
      const desc = r.capability === undefined ? r.description : r.capability_description;
      if (desc) info(`     ${desc}`);
      if (r.tags.length) info(`     Tags: ${r.tags.join(", ")}`);
      info(`     Endpoint: ${r.endpoint}`);
      renderDiscoveryDisplay(r, "     ");
      if (r.display?.price == null && r.pricing) {
        const { amount, currency } = r.pricing.max;
        info(
          `     Price: ${currency === "usd" ? `$${amount.toFixed(amount >= 0.01 ? 2 : 4)}` : `${amount.toString()} ${currency}`}`
        );
      }
      if (i < expanded.length - 1) info("");
    }
  } else {
    const results = expanded.map((r) => {
      const alias = endpointToAlias[r.endpoint];
      // Wrap provider-supplied free-text fields so an agent's framework can audit provenance.
      const wrapped: Record<string, unknown> = {
        ...r,
        name: asProviderText(r.name),
        description: asProviderText(r.description),
        match_reason: asProviderText(r.match_reason),
        tags: r.tags.map((t) => asProviderText(t)),
        ...discoveryCapabilityJson(r),
      };
      return alias ? { ...wrapped, favorite: alias } : wrapped;
    });
    // `total` continues to mean "rows in this response" (post-expansion);
    // `provider_count` carries the discover service's own DVM count so an
    // agent can reason about pagination without conflating one DVM with its
    // capability rows. With `--limit 10`, `provider_count` is bounded by 10
    // while `total` may be larger when multi-capability DVMs are in the mix.
    const payload: Record<string, unknown> = {
      ...output,
      results,
      total: results.length,
      provider_count: output.results.length,
    };
    if (nextAction) {
      payload.next_action = nextAction;
    }
    json(payload);
  }
}
