import {
  asProviderText,
} from "@dvmkit/sdk/internal";
import {
  info,
} from "./output";

export interface DiscoveryCapability {
  name: string;
  description: string | null;
  price: { amount: number; currency: string } | null;
  quote_required: boolean;
  speed: { p50_ms: number; p95_ms: number; jobs: number } | null;
  display: { price: string; speed: string | null };
}

export interface DiscoveryTrust {
  status: "live" | "new" | "unreachable";
  basis: string | null;
  window_days: number | null;
  delivery: { delivered: number; paid_jobs: number; rate: number } | null;
  feedback: { callers: number; positive_share: number; window_days: number | null } | null;
  unreachable_since_ms: number | null;
  listed_at_ms: number;
}

export interface DiscoveryDisplay {
  price?: string | null;
  endpoint_hint?: string;
  owner?: string | null;
  credit?: string | null;
  warning?: string | null;
  status?: string | null;
  delivered?: string | null;
  feedback?: string | null;
  speed?: string | null;
}

export interface DiscoveryEntry {
  endpoint: string;
  identifier: string | null;
  price_raw?: string | number | null;
  capabilities?: DiscoveryCapability[];
  display?: DiscoveryDisplay;
}

export interface DiscoveryRowFields {
  capability?: string;
  capability_description?: string | null;
  price?: DiscoveryCapability["price"];
  quote_required?: boolean;
  speed?: DiscoveryCapability["speed"];
}

export function buildDiscoveryRows<T extends DiscoveryEntry>(entries: T[]): (T & DiscoveryRowFields)[] {
  return entries.flatMap((entry) => {
    if (entry.identifier === null || !entry.capabilities?.length) return [{ ...entry }];
    return entry.capabilities.map((capability) => {
      const identifier = `${entry.identifier}/${capability.name}`;
      const endpointHint = entry.display?.endpoint_hint?.replace(
        `dvm request -d ${entry.identifier}`,
        `dvm request -d ${identifier}`
      );
      const row = {
        ...entry,
        identifier,
        capability: capability.name,
        capability_description: capability.description,
        price: capability.price,
        pricing: capability.price ? { max: { ...capability.price } } : null,
        quote_required: capability.quote_required,
        speed: capability.speed,
        display: {
          ...entry.display,
          ...capability.display,
          ...(endpointHint !== undefined ? { endpoint_hint: endpointHint } : {}),
        },
      };
      // The producer's legacy raw price describes the DVM, not this capability.
      delete row.price_raw;
      return row;
    });
  });
}

export function discoveryCapabilityJson(row: DiscoveryEntry & DiscoveryRowFields): Record<string, unknown> {
  return {
    ...(row.capabilities ? {
      capabilities: row.capabilities.map((capability) => ({
        ...capability,
        description: capability.description === null ? null : asProviderText(capability.description),
      })),
    } : {}),
    ...(row.capability_description !== undefined ? {
      capability_description: row.capability_description === null ? null : asProviderText(row.capability_description),
    } : {}),
  };
}

export function renderDiscoveryDisplay(row: DiscoveryEntry, indent: string): void {
  for (const [label, field] of [["Price", "price"], ["Delivered", "delivered"], ["Feedback", "feedback"]] as const) {
    const text = row.display?.[field];
    if (text != null) info(`${indent}${label}: ${text}`);
  }
  if (row.identifier === null) {
    for (const capability of row.capabilities ?? []) {
      if (capability.display.speed != null) {
        info(`${indent}Speed: ${capability.name}: ${capability.display.speed}`);
      }
    }
  } else if (row.display?.speed != null) {
    info(`${indent}Speed: ${row.display.speed}`);
  }
  for (const [label, field] of [["Status", "status"], ["Owner", "owner"], ["Warning", "warning"], ["Credit", "credit"]] as const) {
    const text = row.display?.[field];
    if (text != null) info(`${indent}${label}: ${text}`);
  }
}
