import {
  DvmError,
  getTempoUsdcBalance,
  redactUrl,
  resolveRpcHttpTransportOptions,
  resolveRpcOverride,
  resolveTempoNetwork,
  type TempoAccount,
  type TempoNetwork,
} from "@dvmkit/sdk/internal";

import { dvmFetch } from "./http";
import { tempoAccountNetwork, tempoNetworkLabel } from "./tempo-network";

type TempoBalance = Awaited<ReturnType<typeof getTempoUsdcBalance>>;

export interface TempoRpcProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  readBalance?: (account: TempoAccount) => Promise<TempoBalance>;
}

/** Resolve and verify the RPC used by Tempo balance reads before trusting its result. */
export async function assertTempoBalanceRpcNetwork(
  account: Pick<TempoAccount, "network">,
  opts: TempoRpcProbeOptions = {}
): Promise<void> {
  const network = tempoAccountNetwork(account);
  const chain = resolveTempoNetwork(network);
  const rpc = resolveRpcOverride(process.env.DVM_TEMPO_RPC_URL, chain.rpcUrl);
  const headers =
    resolveRpcHttpTransportOptions(rpc.source, process.env.DVM_TEMPO_RPC_HEADERS_JSON)?.fetchOptions
      .headers;
  await assertTempoRpcUrlNetwork(network, rpc.url, {
    ...opts,
    headers,
    mismatchHint: `Correct DVM_TEMPO_RPC_URL (${redactUrl(rpc.url)}), or unset it to use Tempo's bundled ${tempoNetworkLabel(network)} endpoint.`,
  });
}

export async function getVerifiedTempoBalance(
  account: TempoAccount,
  opts: TempoRpcProbeOptions = {}
): Promise<TempoBalance> {
  await assertTempoBalanceRpcNetwork(account, opts);
  return (opts.readBalance ?? getTempoUsdcBalance)(account);
}

export async function assertTempoRpcUrlNetwork(
  network: TempoNetwork,
  rpcUrl: string,
  opts: TempoRpcProbeOptions & {
    headers?: Record<string, string>;
    mismatchHint?: string;
  } = {}
): Promise<void> {
  const expected = resolveTempoNetwork(network);
  const actual = await tempoRpcChainId(rpcUrl, opts);
  if (actual === expected.chainId) return;
  throw new DvmError(
    "tempo_rpc_network_mismatch",
    `The Tempo RPC answered for chain ${String(actual)}, not ${tempoNetworkLabel(network)} (chain ${String(expected.chainId)}).`,
    opts.mismatchHint ?? "Do not trust this RPC for a Tempo balance or transaction until it serves the expected chain.",
    { expected_chain_id: expected.chainId, actual_chain_id: actual }
  );
}

async function tempoRpcChainId(
  rpcUrl: string,
  opts: TempoRpcProbeOptions & { headers?: Record<string, string> }
): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? dvmFetch;
  let response: Response;
  try {
    response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch (err) {
    throw new DvmError(
      "tempo_rpc_unavailable",
      `Tempo RPC chain check failed: ${err instanceof Error ? err.message : String(err)}`,
      "The balance was not read. Check the Tempo RPC endpoint and retry."
    );
  }
  if (!response.ok) {
    throw new DvmError(
      "tempo_rpc_unavailable",
      `Tempo RPC chain check returned HTTP ${String(response.status)}.`,
      "The balance was not read. Check the Tempo RPC endpoint and retry."
    );
  }
  let payload: { result?: unknown; error?: { message?: unknown } };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    throw invalidChainResponse();
  }
  if (payload.error) {
    throw new DvmError(
      "tempo_rpc_unavailable",
      `Tempo RPC chain check was refused: ${typeof payload.error.message === "string" ? payload.error.message : "unknown error"}.`,
      "The balance was not read. Check the Tempo RPC endpoint and retry."
    );
  }
  const parsed =
    typeof payload.result === "string" && /^0x[0-9a-f]+$/i.test(payload.result)
      ? Number.parseInt(payload.result, 16)
      : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw invalidChainResponse();
  return parsed;
}

function invalidChainResponse(): DvmError {
  return new DvmError(
    "tempo_rpc_invalid_response",
    "The Tempo RPC returned an invalid eth_chainId result.",
    "The balance was not read. Correct DVM_TEMPO_RPC_URL, or unset it to use the bundled endpoint."
  );
}
