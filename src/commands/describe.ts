import { providerFields } from "../lib/provider-output";
import { formatFiat } from "@dvmkit/sdk";
import {
  asProviderText,
  asProviderTextOpt,
  type ProviderInfo,
} from "@dvmkit/sdk/internal";
import {
  info,
  json,
} from "../lib/output";

import { capabilityQuoteCommand, resolveCapability, resolveDvmReference } from "../lib/dvm-identifier";
import { resolveEndpoint } from "../lib/favorites";
import { progressNotice } from "../lib/progress-notice";
import { createDvmTransport } from "../lib/transport";
import { resolveProviderEndpoint } from "../lib/resolve-provider-endpoint";

export interface DescribeOptions {
  human?: boolean;
}

export async function describe(input: string, opts: DescribeOptions): Promise<void> {
  // Resolve the same set of input forms `dvm quote`/`dvm request` accept:
  //   - `@alias` → favourite lookup
  //   - `http(s)://…` → URL as-is
  //   - a local favorite name → its saved endpoint
  //   - `<handle>--<slug>[/<cap>]` → its wildcard endpoint
  let endpoint: string;
  let qualifiedDvmId: string | undefined;
  if (input.startsWith("@")) {
    endpoint = resolveEndpoint(input);
  } else if (/^https?:\/\//.test(input)) {
    endpoint = input;
  } else {
    const resolved = resolveDvmReference(input);
    endpoint = resolved.endpoint;
    qualifiedDvmId = resolved.qualified?.dvmId;
  }
  const transport = createDvmTransport();

  progressNotice("Fetching provider info...", opts.human);
  const resolved = await resolveProviderEndpoint(transport, endpoint, {
    capabilityPath: input.startsWith("@") || /^https?:\/\//.test(input),
    maxAttempts: 1,
  });
  endpoint = resolved.endpoint;
  const providerInfo = resolved.info;
  if (resolved.capability !== undefined) {
    resolveCapability(providerInfo, resolved.capability, qualifiedDvmId, endpoint);
  }

  if (opts.human) {
    info(providerInfo.name ?? "(unnamed)");
    if (providerInfo.about) info(`  ${providerInfo.about}`);
    if (providerInfo.tags?.length) info(`  Tags: ${providerInfo.tags.join(", ")}`);
    if (providerInfo.mints?.length) info(`  Mints: ${providerInfo.mints.join(", ")}`);
    if (providerInfo.sdkSha) info(`  SDK SHA: ${providerInfo.sdkSha}`);
    renderCapabilitiesHuman(providerInfo, endpoint, qualifiedDvmId);
  } else {
    // The descriptor is provider-owned; endpoint remains a CLI-owned sibling.
    const wrapped: Record<string, unknown> = { ...providerInfo };
    if (providerInfo.name !== undefined) wrapped.name = asProviderTextOpt(providerInfo.name);
    if (providerInfo.about !== undefined) wrapped.about = asProviderTextOpt(providerInfo.about);
    if (providerInfo.tags) wrapped.tags = providerInfo.tags.map((t) => asProviderText(t));
    if (providerInfo.capabilities) {
      wrapped.capabilities = Object.fromEntries(Object.entries(providerInfo.capabilities).map(([name, capability]) => [
        name,
        { ...capability, ...(capability.description !== undefined ? { description: asProviderText(capability.description) } : {}) },
      ]));
    }
    json({ endpoint, ...providerFields(wrapped) });
  }

  transport.close();
}

/**
 * Render the `Capabilities:` block for `--human` output. Each cap
 * shows its description, the required / defaulted / optional input fields, and
 * a minimal valid `dvm quote` example with required-field placeholders. Skips
 * silently when the provider advertises no capabilities.
 */
function renderCapabilitiesHuman(
  providerInfo: ProviderInfo,
  endpoint: string,
  qualifiedDvmId: string | undefined
): void {
  const caps = providerInfo.capabilities;
  if (!caps) return;
  const capNames = Object.keys(caps);
  if (capNames.length === 0) return;

  info("Capabilities:");
  const multiCap = capNames.length > 1;
  capNames.forEach((capName, idx) => {
    if (idx > 0) info("");
    const cap = caps[capName];
    info(`  ${capName}`);
    if (cap.description) info(`    ${cap.description}`);

    const identifier = qualifiedDvmId
      ? multiCap
        ? `${qualifiedDvmId}/${capName}`
        : qualifiedDvmId
      : undefined;
    const quoteCommand = identifier
      ? `dvm quote -d ${identifier}`
      : capabilityQuoteCommand(endpoint, capName);

    const priceLine = formatCapabilityPrice(cap.pricing, quoteCommand);
    if (priceLine) info(`    ${priceLine}`);

    const schema = cap.input_schema;
    const { required, defaults, optional } = partitionFields(schema);

    if (required.length > 0) info(`    Required: ${required.join(", ")}`);
    if (defaults.length > 0) {
      const rendered = defaults
        .map(({ name, value }) => {
          const formatted = formatDefault(value);
          return formatted === undefined ? undefined : `${name}=${formatted}`;
        })
        .filter((s): s is string => s !== undefined);
      if (rendered.length > 0) info(`    Defaults: ${rendered.join(", ")}`);
    }
    if (optional.length > 0) info(`    Optional: ${optional.join(", ")}`);

    // prefer the builder-supplied example over schema-derived
    // placeholders. Falls back to placeholders for required-field schemas;
    // relabels as "Schema skeleton:" only when the schema has optional
    // fields and no required fields and no example — the narrate case
    // where the JSON Schema makes `'{}'` look runnable but a cross-field
    // refinement (e.g. text-XOR-dialogue) rejects it at runtime. Capabilities
    // with no input_schema at all keep the "Example:" label because `'{}'`
    // is genuinely the correct payload.
    if (cap.example) {
      info(`    Example: ${quoteCommand} --data '${JSON.stringify(cap.example)}'`);
    } else {
      const dataJson = buildExampleData(schema, required);
      const label = required.length === 0 && optional.length > 0 ? "Schema skeleton" : "Example";
      info(`    ${label}: ${quoteCommand} --data '${dataJson}'`);
    }
  });
}

/**
 * Render the per-capability price line for `--human`. Narrows the
 * untyped `pricing` block: `{ max: { amount, currency } }` → a formatted fiat
 * amount (or "Free" at amount 0); `{ quote }` (dynamic) → a pointer at
 * `dvm quote`, since the concrete price lands from `/v1/quote`. Returns
 * undefined for an absent or unrecognised block so nothing renders.
 */
function formatCapabilityPrice(pricing: unknown, quoteCommand: string): string | undefined {
  if (!pricing || typeof pricing !== "object") return undefined;
  const p = pricing as { max?: unknown; quote?: unknown };
  if (p.max && typeof p.max === "object") {
    const m = p.max as { amount?: unknown; currency?: unknown };
    if (typeof m.amount === "number" && typeof m.currency === "string") {
      return m.amount === 0 ? "Price: Free" : `Price: ${formatFiat(m.amount, m.currency)}`;
    }
    return undefined;
  }
  if (p.quote) {
    return `Price: dynamic — run \`${quoteCommand}\` for a quote`;
  }
  return undefined;
}

interface PropSchema {
  type?: string;
  default?: unknown;
}

interface PartitionedFields {
  required: string[];
  defaults: { name: string; value: unknown }[];
  optional: string[];
}

/**
 * Bucket each property of a JSON Schema into required / defaulted / optional.
 * Zod 4's `toJSONSchema` lands `.default(x)` fields in both `properties.default`
 * and the top-level `required` array (the schema requires them present after
 * defaults are applied). The presence of a `default` keyword is the
 * caller-facing discriminator for "must I supply this" vs "may I override the
 * default" — so it wins over `required` membership.
 */
function partitionFields(schema: Record<string, unknown> | undefined): PartitionedFields {
  const result: PartitionedFields = { required: [], defaults: [], optional: [] };
  if (!schema) return result;
  const properties = schema.properties;
  if (!properties || typeof properties !== "object") return result;
  const requiredList = Array.isArray(schema.required)
    ? (schema.required as unknown[]).filter((s): s is string => typeof s === "string")
    : [];

  for (const [name, prop] of Object.entries(properties as Record<string, unknown>)) {
    if (!prop || typeof prop !== "object") {
      result.optional.push(name);
      continue;
    }
    const p = prop as PropSchema;
    if (Object.prototype.hasOwnProperty.call(p, "default")) {
      result.defaults.push({ name, value: p.default });
    } else if (requiredList.includes(name)) {
      result.required.push(name);
    } else {
      result.optional.push(name);
    }
  }
  return result;
}

function formatDefault(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "[]" : "<array>";
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length === 0 ? "{}" : "<object>";
  }
  return undefined;
}

/**
 * Build the `--data` JSON for the Example line: an object containing only the
 * required-bucket fields with type-appropriate placeholders. `'{}'` when there
 * are no required fields, so every cap still gets a copy-pasteable starting
 * point.
 */
function buildExampleData(schema: Record<string, unknown> | undefined, required: string[]): string {
  if (required.length === 0) return "{}";
  const properties =
    schema && typeof schema.properties === "object" && schema.properties !== null
      ? (schema.properties as Record<string, unknown>)
      : {};
  const obj: Record<string, unknown> = {};
  for (const name of required) {
    const prop = properties[name];
    const propSchema = prop && typeof prop === "object" ? (prop as PropSchema) : ({} as PropSchema);
    obj[name] = placeholderFor(propSchema);
  }
  return JSON.stringify(obj);
}

function placeholderFor(prop: PropSchema): unknown {
  switch (prop.type) {
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "object":
      return {};
    case "array":
      return [];
    case "string":
    default:
      return "<value>";
  }
}
