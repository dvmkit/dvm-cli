vi.mock("@dvmkit/sdk/internal", async () => {
 const actual = await vi.importActual<typeof import("@dvmkit/sdk/internal")>("@dvmkit/sdk/internal");
 return { ...actual, fetchBtcUsdRate: vi.fn(),
getTempoUsdcBalance: vi.fn(),
resolveTempoNetwork: vi.fn((network: "mainnet" | "moderato") => ({ chainId: network === "moderato" ? 42431 : 4217 })),
getBalanceByMint: vi.fn(),
ensureAddress: vi.fn((w: unknown) => Promise.resolve(w)),
getX402Balance: vi.fn(),
usdcContractByCaip2: vi.fn(() => "0xusdc") };
});
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../identity", () => ({ loadConfig: vi.fn() }));
vi.mock("../x402/wallet", () => ({ loadX402Wallet: vi.fn() }));
vi.mock("../funding", () => ({ detectWalletType: vi.fn() }));

vi.mock("../float", () => ({ loadFloat: vi.fn(), probeFloat: vi.fn(), toFloatError: vi.fn() }));
vi.mock("../wallet-agent/mint-inventory", () => ({ loadConfiguredMints: vi.fn() }));
vi.mock("../payment-rails/tempo-wallet", () => ({ connectedTempoAccount: vi.fn() }));

import { getBalanceByMint } from "@dvmkit/sdk/internal";
import { fetchBtcUsdRate } from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";
import { loadFloat, probeFloat, toFloatError } from "../float";
import { detectWalletType } from "../funding";
import { loadConfig } from "../identity";
import { connectedTempoAccount } from "../payment-rails/tempo-wallet";
import { getTempoUsdcBalance } from "@dvmkit/sdk/internal";
import { loadConfiguredMints } from "../wallet-agent/mint-inventory";
import { probeWallets, type RailProbe } from "../wallet-probe";
import { getX402Balance } from "@dvmkit/sdk/internal";
import { loadX402Wallet } from "../x402/wallet";

const ACCOUNT = { address: "0xabc" as `0x${string}` };

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(loadConfig).mockReturnValue({ tempo: { method: "tempo" } } as never);
  vi.mocked(loadConfiguredMints).mockResolvedValue([]);
  vi.mocked(fetchBtcUsdRate).mockResolvedValue(null as never);
  vi.mocked(detectWalletType).mockReturnValue(null as never);
  vi.mocked(getBalanceByMint).mockReturnValue(new Map());
  vi.mocked(loadFloat).mockReturnValue(null);
  vi.mocked(connectedTempoAccount).mockResolvedValue(ACCOUNT as never);
});

async function tempoRow(): Promise<RailProbe | undefined> {
  const { rails } = await probeWallets({ timeoutMs: 50 });
  return rails.find((r) => r.rail === "tempo");
}

describe("probeWallets — Tempo failures carry the rail's own diagnosis", () => {
  it("reports tempo_rpc_error with the thrower's remedy, not tempo_unreachable", async () => {
    vi.mocked(getTempoUsdcBalance).mockRejectedValue(
      new DvmError(
        "tempo_rpc_error",
        "Tempo USDC balance lookup failed: fetch failed",
        "Verify connectivity to Tempo's bundled endpoint (https://rpc.tempo.xyz), or send the read somewhere else with DVM_TEMPO_RPC_URL."
      )
    );

    const row = await tempoRow();

    expect(row?.reachable).toBe(false);
    expect(row?.error).toEqual({
      code: "tempo_rpc_error",
      message: "Tempo USDC balance lookup failed: fetch failed",
      hint: "Verify connectivity to Tempo's bundled endpoint (https://rpc.tempo.xyz), or send the read somewhere else with DVM_TEMPO_RPC_URL.",
    });

    expect(row?.details).toMatchObject({ address: "0xabc", chain_id: 4217, balance_unknown: true });
    expect(row?.balanceUsdc).toBeUndefined();
  });

  it("reports tempo_config_invalid for a malformed settlement-asset override", async () => {

    vi.mocked(getTempoUsdcBalance).mockRejectedValue(
      new DvmError(
        "tempo_config_invalid",
        "DVM_TEMPO_CURRENCY must be a 0x-prefixed 40-char hex address; got 'usdc'.",
        "Unset DVM_TEMPO_CURRENCY to fall back to the bundled USDC.e mainnet default."
      )
    );

    const row = await tempoRow();

    expect(row?.error?.code).toBe("tempo_config_invalid");
    expect(row?.error?.hint).toContain("Unset DVM_TEMPO_CURRENCY");
  });

  it("reports tempo_config_invalid when the failure precedes the account lookup", async () => {
    vi.mocked(connectedTempoAccount).mockRejectedValue(
      new DvmError("tempo_config_invalid", "bad currency override", "Unset the env var.")
    );

    const row = await tempoRow();

    expect(row?.error).toEqual({
      code: "tempo_config_invalid",
      message: "bad currency override",
      hint: "Unset the env var.",
    });
  });

  it("names the reconnect for a config with no usable key", async () => {
    vi.mocked(connectedTempoAccount).mockResolvedValue(null);

    const row = await tempoRow();

    expect(row?.reachable).toBe(false);
    expect(row?.error?.code).toBe("tempo_key_missing");
    expect(row?.error?.hint).toContain("dvm wallet tempo-connect'");

    expect(row?.error?.hint).toContain("--key-file <path>");
    expect(row?.error?.hint).not.toContain("--api-key");
    expect(row?.error?.hint).not.toMatch(/tempo-connect\s+</);
  });

  it("keeps the generic fallback code for a throw that diagnosed nothing", async () => {
    vi.mocked(getTempoUsdcBalance).mockRejectedValue(new Error("socket hang up"));

    const row = await tempoRow();

    expect(row?.error).toEqual({ code: "tempo_unreachable", message: "socket hang up" });

    expect(row?.error?.hint).toBeUndefined();
  });

  it("labels Moderato success and failure rows with chain 42431", async () => {
    vi.mocked(connectedTempoAccount).mockResolvedValue({
      ...ACCOUNT,
      network: "moderato",
    } as never);
    vi.mocked(getTempoUsdcBalance).mockResolvedValue({
      usdc: 2,
      chainId: 42431,
      tokenAddress: "0x20c0000000000000000000000000000000000000",
      rpcUrlRedacted: "https://rpc.moderato.tempo.xyz",
      rpcSource: "bundled",
    } as never);

    expect((await tempoRow())?.details).toMatchObject({ chain_id: 42431 });

    vi.mocked(getTempoUsdcBalance).mockRejectedValue(new Error("offline"));
    expect((await tempoRow())?.details).toMatchObject({
      chain_id: 42431,
      balance_unknown: true,
    });
  });
});

describe("probeWallets — a failed x402 read still names the account", () => {
  beforeEach(() => {
    vi.mocked(loadConfig).mockReturnValue({ x402: { privateKey: "0xkey" } } as never);
    vi.mocked(loadX402Wallet).mockReturnValue({
      privateKey: "0xkey",
      address: "0xcafe",
      network: "eip155:8453",
    } as never);
  });

  it("carries the address and the chain through the failure", async () => {
    vi.mocked(getX402Balance).mockRejectedValue(new Error("RPC timeout"));

    const { rails } = await probeWallets({ timeoutMs: 50 });
    const row = rails.find((r) => r.rail === "x402");

    expect(row?.reachable).toBe(false);
    expect(row?.details).toEqual({ address: "0xcafe", network: "eip155:8453" });
    expect(row?.balanceUsdc).toBeUndefined();
  });

  it("keeps x402_rpc_error and its remedy instead of the generic unreachable code", async () => {
    vi.mocked(getX402Balance).mockRejectedValue(
      new DvmError(
        "x402_rpc_error",
        "x402 USDC balance lookup on Base failed: HTTP request failed: 429",
        "Verify connectivity to Base's bundled endpoint (https://mainnet.base.org), or send the read somewhere else with DVM_X402_RPC_URL."
      )
    );

    const { rails } = await probeWallets({ timeoutMs: 50 });
    const row = rails.find((r) => r.rail === "x402");

    expect(row?.error).toEqual({
      code: "x402_rpc_error",
      message: "x402 USDC balance lookup on Base failed: HTTP request failed: 429",
      hint: "Verify connectivity to Base's bundled endpoint (https://mainnet.base.org), or send the read somewhere else with DVM_X402_RPC_URL.",
    });
  });
});

describe("probeWallets — a successful read names the endpoint it used", () => {
  it("carries the Tempo endpoint and where it came from", async () => {
    vi.mocked(getTempoUsdcBalance).mockResolvedValue({
      address: "0xabc",
      rawBaseUnits: 2_000_000n,
      usdc: 2,
      tokenAddress: "0xtoken",
      chainId: 4217,
      rpcUrlRedacted: "https://rpc.tempo.xyz/",
      rpcSource: "bundled",
      fetchedAtMs: 0,
    } as never);

    const row = await tempoRow();

    expect(row?.reachable).toBe(true);
    expect(row?.details).toEqual({
      address: "0xabc",
      chain_id: 4217,
      token: "0xtoken",
      rpc_url: "https://rpc.tempo.xyz/",
      rpc_source: "bundled",
    });
  });

  it("carries a Tempo override's masked endpoint through untouched", async () => {
    vi.mocked(getTempoUsdcBalance).mockResolvedValue({
      address: "0xabc",
      rawBaseUnits: 0n,
      usdc: 0,
      tokenAddress: "0xtoken",
      chainId: 4217,
      rpcUrlRedacted: "https://tempo-rpc.example/v1/:hex",
      rpcSource: "override",
      fetchedAtMs: 0,
    } as never);

    const row = await tempoRow();

    expect(row?.details?.rpc_url).toBe("https://tempo-rpc.example/v1/:hex");

    expect(row?.details?.rpc_source).toBe("override");
  });

  describe("x402", () => {
    beforeEach(() => {
      vi.mocked(loadConfig).mockReturnValue({ x402: { privateKey: "0xkey" } } as never);
      vi.mocked(loadX402Wallet).mockReturnValue({
        privateKey: "0xkey",
        address: "0xcafe",
        network: "eip155:8453",
      } as never);
    });

    async function x402Row(rpcUrlRedacted: string, rpcSource: "override" | "bundled") {
      vi.mocked(getX402Balance).mockResolvedValue({
        address: "0xcafe",
        usdc: 4.5,
        network: "eip155:8453",
        tokenAddress: "0xusdc",
        rpcUrlRedacted,
        rpcSource,
      } as never);
      const { rails } = await probeWallets({ timeoutMs: 50 });
      return rails.find((r) => r.rail === "x402");
    }

    it("carries the endpoint and where it came from", async () => {
      const row = await x402Row("https://mainnet.base.org/", "bundled");

      expect(row?.balanceUsdc).toBe(4.5);
      expect(row?.details).toEqual({
        address: "0xcafe",
        network: "eip155:8453",
        token: "0xusdc",
        rpc_url: "https://mainnet.base.org/",
        rpc_source: "bundled",
      });
    });

    it("carries an override's masked endpoint through untouched", async () => {
      const row = await x402Row("https://base-mainnet.g.alchemy.com/v2/:hex", "override");

      expect(row?.details?.rpc_url).toBe("https://base-mainnet.g.alchemy.com/v2/:hex");
      expect(row?.details?.rpc_source).toBe("override");
    });
  });
});

// `config.json` is `JSON.parse(...)` with no runtime
// schema validation, so a hand-edited or partially-written file can carry no
// key or one outside the curve range. `loadX402Wallet()` returns null for both;
// the probe still has the raw config needed to distinguish their remedies.
describe("probeWallets — x402 configured with no usable privateKey", () => {
  it("reports x402_key_missing with a hint naming x402-connect, and carries the configured network", async () => {
    vi.mocked(loadConfig).mockReturnValue({ x402: { network: "eip155:8453" } } as never);
    vi.mocked(loadX402Wallet).mockReturnValue(null);

    const { rails } = await probeWallets({ timeoutMs: 50 });
    const row = rails.find((r) => r.rail === "x402");

    expect(row).toEqual({
      rail: "x402",
      configured: true,
      reachable: false,
      details: { network: "eip155:8453" },
      error: {
        code: "x402_key_missing",
        message: "x402 config is present but privateKey is missing or empty.",
        hint: "Run 'dvm wallet x402-connect' to create a wallet, or add --key-file <path> to import a key you already hold.",
      },
    });
  });

  it("omits details when the config has no network either", async () => {
    vi.mocked(loadConfig).mockReturnValue({ x402: {} } as never);
    vi.mocked(loadX402Wallet).mockReturnValue(null);

    const { rails } = await probeWallets({ timeoutMs: 50 });
    const row = rails.find((r) => r.rail === "x402");

    expect(row).toEqual({
      rail: "x402",
      configured: true,
      reachable: false,
      error: {
        code: "x402_key_missing",
        message: "x402 config is present but privateKey is missing or empty.",
        hint: "Run 'dvm wallet x402-connect' to create a wallet, or add --key-file <path> to import a key you already hold.",
      },
    });
  });

  it("reports a present out-of-range scalar as invalid without echoing it", async () => {
    const privateKey = `0x${"0".repeat(64)}`;
    vi.mocked(loadConfig).mockReturnValue({
      x402: { privateKey, network: "eip155:8453" },
    });
    vi.mocked(loadX402Wallet).mockReturnValue(null);

    const { rails } = await probeWallets({ timeoutMs: 50 });
    const row = rails.find((rail) => rail.rail === "x402");

    expect(row).toEqual({
      rail: "x402",
      configured: true,
      reachable: false,
      details: { network: "eip155:8453" },
      error: {
        code: "x402_key_invalid",
        message: "x402 config contains a privateKey that is not a valid secp256k1 scalar.",
        hint: "Run 'dvm wallet x402-connect' to create a replacement wallet, or add --key-file <path> to import a valid key you already hold.",
      },
    });
    const payload = JSON.stringify(row);
    for (const start of [0, 8, 24, privateKey.length - 16]) {
      expect(payload).not.toContain(privateKey.slice(start, start + 16));
    }
  });
});

describe("probeWallets — the Lightning row carries the float's own diagnosis", () => {
  const FLOAT = { uri: "nostr+walletconnect://abc", statedBudget: null } as never;

  beforeEach(() => {
    vi.mocked(loadConfig).mockReturnValue({} as never);
    vi.mocked(loadFloat).mockReturnValue(FLOAT);
  });

  async function lightningRow(): Promise<RailProbe | undefined> {
    const { rails } = await probeWallets({ timeoutMs: 50 });
    return rails.find((r) => r.rail === "lightning");
  }

  it("carries a refusal's remedy and its structured fields, not the generic reconnect", async () => {
    vi.mocked(probeFloat).mockResolvedValue({
      reachable: false,
      methods: [],
      canPay: false,
      canInvoice: false,
      canReconcile: false,
      error: {
        code: "float_connection_restricted",
        message:
          "The Lightning wallet recognises this connection but will not let it call pay_invoice.",
        display:
          "Your Lightning wallet knows this connection but has not allowed it to send payments.",
        hint: "In your wallet app, edit this connection to allow pay_invoice.",
        data: {
          display:
            "Your Lightning wallet knows this connection but has not allowed it to send payments.",
          next_step:
            "In your wallet app, open this connection's permissions and allow it to send payments.",
          restriction: "permission",
          method: "pay_invoice",
          wallet_message: "This app is not allowed to pay invoices",
        },
      },
    } as never);

    const row = await lightningRow();

    expect(row?.error).toEqual({
      code: "float_connection_restricted",
      message:
        "The Lightning wallet recognises this connection but will not let it call pay_invoice.",
      hint: "In your wallet app, edit this connection to allow pay_invoice.",
      method: "pay_invoice",
      restriction: "permission",
      wallet_message: "This app is not allowed to pay invoices",
    });

    expect(row?.error).not.toHaveProperty("display");
    expect(row?.error).not.toHaveProperty("next_step");
  });

  it("carries an offline float's own remedy in place of the generic one", async () => {
    vi.mocked(probeFloat).mockResolvedValue({
      reachable: false,
      methods: [],
      canPay: false,
      canInvoice: false,
      canReconcile: false,
      error: {
        code: "float_wallet_offline",
        message: "The wallet did not answer in time.",
        display: "Your Lightning wallet didn't answer in time.",
        hint: "Phone wallets sleep with the phone — open the wallet app and retry.",
      },
    } as never);

    const row = await lightningRow();

    expect(row?.error?.hint).toBe(
      "Phone wallets sleep with the phone — open the wallet app and retry."
    );
    expect(row?.error).not.toHaveProperty("method");
    expect(row?.error).not.toHaveProperty("restriction");
  });

  it("carries the remedy for a saved connection string that will not parse", async () => {
    vi.mocked(loadFloat).mockImplementation(() => {
      throw new Error("bad uri");
    });
    vi.mocked(toFloatError).mockReturnValue(
      new DvmError(
        "float_invalid_uri",
        "That NWC connection string is not valid.",
        "Copy the whole string from your wallet app and run 'dvm wallet connect <nwc-uri>' again."
      )
    );

    const row = await lightningRow();

    expect(row?.error).toEqual({
      code: "float_invalid_uri",
      message: "That NWC connection string is not valid.",
      hint: "Copy the whole string from your wallet app and run 'dvm wallet connect <nwc-uri>' again.",
    });
  });
});
