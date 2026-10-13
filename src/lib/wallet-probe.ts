/**
 * Shared rail-probe layer for the caller wallet stack. Encapsulates the
 * "for each configured rail, what's the balance and is it reachable" sweep
 * so `dvm wallet balance` and `dvm doctor` share one code path.
 *
 * Read-only: never mutates config or wallet state. Each rail probe is wrapped
 * in `try/catch` so a single broken rail (e.g. viem missing for x402)
 * surfaces as a failed `RailProbe` row instead of blanking the whole sweep.
 * Each probe is also wrapped against `timeoutMs` so a hung NWC relay or RPC
 * endpoint can't stall the report.
 */

import { getBalanceByMint } from "@dvmkit/sdk/internal";
import { fetchBtcUsdRate } from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";
import { type Float, type FloatProbe, loadFloat, probeFloat, toFloatError } from "./float";
import { detectWalletType, type WalletType } from "./funding";
import { loadConfig } from "./identity";
import type { RpcSource } from "@dvmkit/sdk/internal";
import { loadConfiguredMints } from "./wallet-agent/mint-inventory";

export type ProbeRail = "lightning" | "cashu" | "x402" | "tempo";

export interface RailProbe {
  rail: ProbeRail;
  /** True when the rail is set up in `config.json` (or its sidecar files). */
  configured: boolean;

  reachable: boolean;
  /**
   * Lightning + Cashu balances are in millisats. Absent means *unknown* — the
   * rail may be perfectly healthy and simply not have answered a balance
   * request — so never render a missing value as zero.
   */
  balanceMsats?: number;
  /** x402 + Tempo balances are in human-readable USDC. */
  balanceUsdc?: number;

  details?: Record<string, unknown>;
  /**
   * Populated when {@link reachable} is false. `hint` carries a rail-specific
   * remedy when the probe knew one — a `DvmError` thrown by the rail's own
   * code — so a status surface can print why this particular rail failed
   * instead of the one generic hint for the rail.
   */
  error?: {
    code: string;
    message: string;
    hint?: string;
    /**
     * The NIP-47 method a wallet refused, when the failure was a refusal rather
     * than a rail being down. Carried as a field, not just named in prose, so
     * an agent reading `dvm doctor --json` branches on the same key
     * `dvm wallet connect` hands it.
     */
    method?: string;
    /** `"permission"` or `"budget"` — which of the two things a refusal wants done about it. */
    restriction?: string;
    /** The wallet's own words for the refusal, so a reader can second-guess {@link restriction}. */
    wallet_message?: string;
  };
}

export interface ProbeWalletsResult {
  /** Primary rail per {@link detectWalletType}, or null when nothing is configured. */
  walletType: WalletType | null;
  /** Last successful BTC/USD spot rate, or null if the fetch failed. */
  rate: number | null;

  rails: RailProbe[];
  /**
   * Sum of the Lightning + Cashu balances we could actually read, in msats
   * (drives funding-guidance prompts). A rail whose balance is unknown
   * contributes nothing rather than blocking the sum.
   */
  totalLnAndCashuMsats: number;
  /**
   * Canonical Cashu mint inventory from `wallet.mints`. Surfaced
   * here so consumers (`wallet balance`, `dvm doctor`) don't have to re-load
   * the wallet store to fill {@link getFundingGuidance}'s `cashuMints` field.
   */
  cashuMints: string[];
}

export interface ProbeWalletsOptions {
  /** Per-rail timeout in ms. Default 5000. */
  timeoutMs?: number;
}

/** Run configured rail probes in parallel; rail failures become failed rows. */
export async function probeWallets(opts: ProbeWalletsOptions = {}): Promise<ProbeWalletsResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;

  const config = loadConfig();

  const cashuMints = await loadConfiguredMints();
  const walletType = detectWalletType(config, cashuMints);
  const rate = await fetchBtcUsdRate().catch(() => null);

  const probes = await Promise.allSettled([
    probeLightning(timeoutMs),
    probeX402(config?.x402, timeoutMs),
    probeMpp(config?.tempo, timeoutMs),
  ]);

  const rails: RailProbe[] = [];
  const cashuRow = probeCashu(cashuMints);
  if (cashuRow) rails.push(cashuRow);
  for (const result of probes) {
    if (result.status === "fulfilled" && result.value !== null) {
      rails.push(result.value);
    }
  }

  const totalLnAndCashuMsats = rails
    .filter((r) => r.rail === "lightning" || r.rail === "cashu")
    .reduce((sum, r) => sum + (r.balanceMsats ?? 0), 0);

  return { walletType, rate, rails, totalLnAndCashuMsats, cashuMints };
}

/**
 * Probe the Lightning float.
 *
 * One round trip covers both questions worth asking: `get_info` says whether
 * this connection can still *do* the job (a wallet that can't `pay_invoice`
 * can't fund anything, however healthy its balance looks), and `get_balance`
 * says how much is behind it. Both land in `details` so `dvm doctor` and
 * `dvm wallet balance` render without re-querying.
 */
async function probeLightning(timeoutMs: number): Promise<RailProbe | null> {
  let float: Float | null;
  try {
    float = loadFloat();
  } catch (err) {
    // A malformed connection string is "configured but broken" — surface it as
    // an unreachable row rather than blanking the whole sweep.
    const mapped = toFloatError(err);
    return {
      rail: "lightning",
      configured: true,
      reachable: false,
      error: {
        code: mapped.code,
        message: mapped.message,

        ...(mapped.hint ? { hint: mapped.hint } : {}),
        ...refusalFields(mapped.data),
      },
    };
  }
  if (!float) return null;

  const probe = await withTimeout(probeFloat({ float, timeoutMs }), timeoutMs, "lightning").catch(
    (err: unknown): FloatProbe => ({
      reachable: false,
      methods: [],
      canPay: false,
      canInvoice: false,
      canReconcile: false,
      error: {
        code: "float_wallet_offline",
        message: err instanceof Error ? err.message : String(err),
        display: "Your Lightning wallet didn't answer in time.",
      },
    })
  );

  const details: Record<string, unknown> = {
    alias: probe.alias ?? null,
    methods: probe.methods,
    can_pay: probe.canPay,
    can_reconcile: probe.canReconcile,
    stated_budget: float.statedBudget ?? null,
  };
  if (probe.walletReportedBudget) details.wallet_reported_budget = probe.walletReportedBudget;

  if (probe.reachable && probe.balanceMsats === undefined) details.balance_unknown = true;

  if (!probe.reachable) {
    return {
      rail: "lightning",
      configured: true,
      reachable: false,
      details,
      error: {
        code: probe.error?.code ?? "float_wallet_offline",
        message: probe.error?.message ?? "The Lightning wallet did not respond.",

        ...(probe.error?.hint ? { hint: probe.error.hint } : {}),
        ...refusalFields(probe.error?.data),
      },
    };
  }

  return {
    rail: "lightning",
    configured: true,
    reachable: true,

    ...(probe.balanceMsats === undefined ? {} : { balanceMsats: probe.balanceMsats }),
    details,
  };
}

/**
 * The structured half of a float error's payload, for the rail row.
 *
 * A row that carries only prose forces an agent to string-match the hint for
 * what `dvm wallet connect` already hands it as fields. `display` and
 * `next_step` stay behind: each surface writes its own copy for its own
 * context, and a float's "Nothing was charged" answers a question `dvm doctor`
 * never asked.
 */
function refusalFields(data: Record<string, unknown> | undefined): {
  method?: string;
  restriction?: string;
  wallet_message?: string;
} {
  const text = (key: string): string | undefined => {
    const value = data?.[key];
    return typeof value === "string" ? value : undefined;
  };
  const method = text("method");
  const restriction = text("restriction");
  const walletMessage = text("wallet_message");
  return {
    ...(method ? { method } : {}),
    ...(restriction ? { restriction } : {}),
    ...(walletMessage ? { wallet_message: walletMessage } : {}),
  };
}

function probeCashu(cashuMints?: string[]): RailProbe | null {
  const configured = (cashuMints?.length ?? 0) > 0;
  const byMint = getBalanceByMint();
  const balanceMsats = [...byMint.values()].reduce((sum, amount) => sum + amount, 0);
  if (!configured && balanceMsats === 0) return null;

  const byMintObj: Record<string, number> = {};
  for (const url of cashuMints ?? []) {
    byMintObj[url] = byMint.get(url) ?? 0;
  }
  for (const [url, msats] of byMint) {
    if (!(url in byMintObj)) byMintObj[url] = msats;
  }

  return {
    rail: "cashu",
    configured,
    reachable: true,
    balanceMsats,
    details: { byMint: byMintObj },
  };
}

async function probeX402(
  x402: { privateKey: string; network?: string } | undefined,
  timeoutMs: number
): Promise<RailProbe | null> {
  if (!x402) return null;

  let network: string | undefined;
  let address: string | undefined;
  try {
    const { loadX402Wallet } = await import("./x402/wallet");
    const { getX402Balance, ensureAddress, usdcContractByCaip2 } = await import("@dvmkit/sdk/internal");
    const wallet = loadX402Wallet();
    if (!wallet) {
      // Unvalidated config can omit the key or supply one outside the curve range.
      // loadX402Wallet returns null for both; raw config distinguishes remedies
      // without publishing the key.
      const storedKey = (x402 as { privateKey?: unknown }).privateKey;
      const missing = storedKey === undefined || storedKey === "";
      return {
        rail: "x402",
        configured: true,
        reachable: false,
        ...(x402.network ? { details: { network: x402.network } } : {}),
        error: missing
          ? {
              code: "x402_key_missing",
              message: "x402 config is present but privateKey is missing or empty.",
              hint: "Run 'dvm wallet x402-connect' to create a wallet, or add --key-file <path> to import a key you already hold.",
            }
          : {
              code: "x402_key_invalid",
              message: "x402 config contains a privateKey that is not a valid secp256k1 scalar.",
              hint: "Run 'dvm wallet x402-connect' to create a replacement wallet, or add --key-file <path> to import a valid key you already hold.",
            },
      };
    }
    network = wallet.network;
    const w = await withTimeout(ensureAddress(wallet), timeoutMs, "x402");
    address = w.address;
    const balance = await withTimeout(getX402Balance(w), timeoutMs, "x402");
    return {
      rail: "x402",
      configured: true,
      reachable: true,
      balanceUsdc: balance.usdc,

      details: {
        address: w.address,
        network: w.network,
        token: usdcContractByCaip2(w.network),

        ...rpcDetails(balance.rpcUrlRedacted, balance.rpcSource),
      },
    };
  } catch (err) {
    const details = { ...(address ? { address } : {}), ...(network ? { network } : {}) };
    return {
      rail: "x402",
      configured: true,
      reachable: false,
      ...(Object.keys(details).length > 0 ? { details } : {}),
      error: classifyError("x402_unreachable", err),
    };
  }
}

async function probeMpp(
  mpp: { method: string; accountId?: string; apiKey?: string } | undefined,
  timeoutMs: number
): Promise<RailProbe | null> {
  if (!mpp) return null;

  if (mpp.method === "tempo") {
    try {
      const { connectedTempoAccount } = await import("./payment-rails/tempo-wallet");
      const { getTempoUsdcBalance, resolveTempoNetwork } = await import("@dvmkit/sdk/internal");
      const account = await connectedTempoAccount();
      if (!account) {

        return {
          rail: "tempo",
          configured: true,
          reachable: false,
          error: {
            code: "tempo_key_missing",
            message: "Tempo config is present but apiKey is missing or not a private key.",
            hint: "Run 'dvm wallet tempo-connect' to generate a key, or add '--key-file <path>' to import one you already hold (DVM_TEMPO_KEY and piped stdin work too).",
          },
        };
      }
      try {
        const balance = await withTimeout(getTempoUsdcBalance(account), timeoutMs, "tempo");
        return {
          rail: "tempo",
          configured: true,
          reachable: true,
          balanceUsdc: balance.usdc,

          details: {
            address: account.address,
            chain_id: balance.chainId,
            token: balance.tokenAddress,

            ...rpcDetails(balance.rpcUrlRedacted, balance.rpcSource),
          },
        };
      } catch (err) {
        return {
          rail: "tempo",
          configured: true,
          reachable: false,
          balanceUsdc: undefined,
          details: {
            address: account.address,
            chain_id: resolveTempoNetwork(account.network ?? "mainnet").chainId,
            balance_unknown: true,
          },
          error: classifyError("tempo_unreachable", err),
        };
      }
    } catch (err) {
      return {
        rail: "tempo",
        configured: true,
        reachable: false,
        error: classifyError("tempo_unavailable", err),
      };
    }
  }

  return {
    rail: "tempo",
    configured: true,
    reachable: false,
    error: { code: "tempo_unknown_method", message: `unknown Tempo method: ${mpp.method}` },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, rail: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`${rail} probe timed out after ${ms}ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    );
  });
}

/**
 * The `rpc_url` / `rpc_source` facts an on-chain rail's balance read carries
 * back.
 *
 * The URL arrives already redacted — both readers redact before returning, so
 * no clear endpoint exists on this path to leak. `rpc_source` is
 * the actionable half: it says which knob put the read there, so an agent
 * relaying a surprising balance can name the caller's own override instead of
 * asking them to compare two URLs. Both keys are omitted rather than nulled
 * when the read resolved no endpoint of its own.
 */
function rpcDetails(
  rpcUrlRedacted: string | undefined,
  rpcSource: RpcSource
): Record<string, unknown> {
  if (!rpcUrlRedacted) return {};
  return { rpc_url: rpcUrlRedacted, rpc_source: rpcSource };
}

/** A rail's DvmError diagnosis and hint take precedence over generic fallback. */
function classifyError(
  code: string,
  err: unknown
): { code: string; message: string; hint?: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof DvmError) {
    return { code: err.code, message, ...(err.hint ? { hint: err.hint } : {}) };
  }
  return { code, message };
}
