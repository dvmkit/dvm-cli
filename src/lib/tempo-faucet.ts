import {
  DvmError,
  getTempoUsdcBalance,
  resolveTempoAsset,
  resolveTempoNetwork,
  TEMPO_MODERATO_RPC,
  type TempoAccount,
} from "@dvmkit/sdk/internal";

import { dvmFetch } from "./http";
import { tempoAccountNetwork, tempoNetworkLabel } from "./tempo-network";
import { assertTempoRpcUrlNetwork, getVerifiedTempoBalance } from "./tempo-rpc";

type TempoBalance = Awaited<ReturnType<typeof getTempoUsdcBalance>>;

const FAUCET_REQUEST_ID = 2;

interface TempoFaucetContext {
  network: "moderato";
  chainId: number;
  token: string;
  assetLabel: string;
}

export interface TempoFaucetResult {
  before: TempoBalance;
  after: TempoBalance;
  grantedBaseUnits: bigint;
  granted: number;
  attempts: number;
}

export interface TempoFaucetOptions {
  fetchImpl?: typeof fetch;
  readBalance?: (account: TempoAccount) => Promise<TempoBalance>;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  intervalMs?: number;
}

export async function fundTempoFromFaucet(
  account: TempoAccount,
  opts: TempoFaucetOptions = {}
): Promise<TempoFaucetResult> {
  const network = tempoAccountNetwork(account);
  if (network !== "moderato") {
    throw new DvmError(
      "tempo_faucet_mainnet_refused",
      "Tempo's public faucet is available only on the Moderato testnet.",
      "Keep this wallet on mainnet and use the emitted live-funding handoff, or connect a disposable test wallet with `dvm wallet tempo-connect --network moderato`."
    );
  }

  const readBalance = () =>
    getVerifiedTempoBalance(account, {
      fetchImpl: opts.fetchImpl,
      readBalance: opts.readBalance,
    });
  const before = await readBalance();
  const chain = resolveTempoNetwork(network);
  const fetchImpl = opts.fetchImpl ?? dvmFetch;
  await assertTempoRpcUrlNetwork(network, TEMPO_MODERATO_RPC, {
    fetchImpl,
    mismatchHint:
      "No faucet request was sent. Tempo's official Moderato endpoint did not serve Moderato; retry after the service recovers.",
  });
  const asset = resolveTempoAsset(process.env, network);
  await faucetCall(fetchImpl, account.address.toLowerCase(), {
    network,
    chainId: chain.chainId,
    token: asset.address,
    assetLabel: asset.label,
  });

  const attempts = opts.attempts ?? 12;
  const intervalMs = opts.intervalMs ?? 1_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last = before;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      last = await readBalance();
      const grantedBaseUnits = last.rawBaseUnits - before.rawBaseUnits;
      if (grantedBaseUnits > 0n) {
        return {
          before,
          after: last,
          grantedBaseUnits,
          granted: Number(grantedBaseUnits) / 1e6,
          attempts: attempt,
        };
      }
      lastError = undefined;
    } catch (err) {
      lastError = err;
    }
    if (attempt < attempts) await sleep(intervalMs);
  }

  throw new DvmError(
    "tempo_faucet_balance_unconfirmed",
    `The Moderato faucet accepted the request, but ${asset.label} did not increase after ${String(attempts)} balance checks.`,
    `Do not request again blindly. Run 'dvm wallet balance' to check ${asset.label} (${asset.address}) on ${tempoNetworkLabel(network)}; the faucet also grants other test assets that this rail does not read.`,
    {
      network,
      chain_id: chain.chainId,
      token: asset.address,
      balance_before_atomic: before.rawBaseUnits.toString(),
      balance_last_atomic: last.rawBaseUnits.toString(),
      ...(lastError
        ? { last_error: lastError instanceof Error ? lastError.message : String(lastError) }
        : {}),
    }
  );
}

async function faucetCall(
  fetchImpl: typeof fetch,
  address: string,
  context: TempoFaucetContext
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(TEMPO_MODERATO_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: FAUCET_REQUEST_ID,
        method: "tempo_fundAddress",
        params: [address],
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new DvmError(
      "tempo_faucet_unavailable",
      `Tempo faucet RPC request failed: ${err instanceof Error ? err.message : String(err)}`,
      "The Moderato faucet may be temporarily unavailable. No mainnet funds are involved; retry later."
    );
  }
  if (!response.ok) {
    throw new DvmError(
      "tempo_faucet_unavailable",
      `Tempo faucet RPC returned HTTP ${String(response.status)}.`,
      "The Moderato faucet may be temporarily unavailable or rate limited. No mainnet funds are involved; retry after the service recovers."
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw invalidFaucetResponse("malformed_json", context);
  }
  if (!isRecord(payload)) throw invalidFaucetResponse("response_not_object", context);
  if (payload.jsonrpc !== "2.0") {
    throw invalidFaucetResponse("invalid_jsonrpc_version", context);
  }
  if (payload.id !== FAUCET_REQUEST_ID) {
    throw invalidFaucetResponse("mismatched_id", context);
  }

  const hasResult = Object.hasOwn(payload, "result");
  const hasError = Object.hasOwn(payload, "error");
  if (hasResult === hasError) {
    throw invalidFaucetResponse(
      hasResult ? "result_and_error" : "missing_result_or_error",
      context
    );
  }
  if (hasResult) return;

  const error = payload.error;
  if (
    !isRecord(error) ||
    typeof error.code !== "number" ||
    !Number.isFinite(error.code) ||
    typeof error.message !== "string"
  ) {
    throw invalidFaucetResponse("invalid_error_object", context);
  }
  throw new DvmError(
    "tempo_faucet_refused",
    `Tempo faucet RPC refused the request (${String(error.code)}): ${error.message}.`,
    "The Moderato faucet may be rate limited. No mainnet funds are involved; wait before retrying."
  );
}

function invalidFaucetResponse(reason: string, context: TempoFaucetContext): DvmError {
  return new DvmError(
    "tempo_faucet_outcome_unknown",
    "The Tempo faucet returned an invalid JSON-RPC response, so the funding outcome is unknown.",
    `Do not request again blindly. Run 'dvm wallet balance' to check ${context.assetLabel} (${context.token}) on ${tempoNetworkLabel(context.network)}; the request may already have reached the faucet.`,
    {
      status: "unknown",
      reason,
      network: context.network,
      chain_id: context.chainId,
      token: context.token,
    }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
