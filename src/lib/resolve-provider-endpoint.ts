import { DvmError, type ProviderInfo, type Transport } from "@dvmkit/sdk/internal";

import { normalizeProviderEndpoint } from "./provider-endpoint";
import { warmupProvider, type WarmupProviderOptions } from "./warmup-provider";

interface EndpointResolution {
  endpoint: string;
  info: ProviderInfo;
  capability?: string;
}

/** A working base path wins over interpreting its final segment as a capability. */
export async function resolveProviderEndpoint(
  transport: Transport,
  input: string,
  options: WarmupProviderOptions & { capabilityPath?: boolean } = {}
): Promise<EndpointResolution> {
  const endpoint = normalizeProviderEndpoint(input);
  const budgetMs = options.budgetMs ?? 30_000;
  const start = Date.now();
  try {
    return { endpoint, info: await warmupProvider(transport, { endpoint }, { ...options, budgetMs }) };
  } catch (error) {
    if (!options.capabilityPath || !(error instanceof DvmError) || error.code !== "not_a_dvm_endpoint") {
      throw error;
    }
    const url = new URL(endpoint);
    const slash = url.pathname.lastIndexOf("/");
    const segment = url.pathname.slice(slash + 1);
    if (!segment) throw error;
    let capability: string;
    try {
      capability = decodeURIComponent(segment);
    } catch {
      throw error;
    }
    const parent = `${url.origin}${url.pathname.slice(0, slash)}`;
    const remaining = budgetMs - (Date.now() - start);
    if (remaining <= 0) throw error;
    const info = await warmupProvider(transport, { endpoint: parent }, { ...options, budgetMs: remaining });
    // A parent with a descriptor but no capability menu cannot establish that
    // the supplied URL was a capability link.
    if (!info.capabilities || Object.keys(info.capabilities).length === 0) throw error;
    return { endpoint: parent, info, capability };
  }
}
