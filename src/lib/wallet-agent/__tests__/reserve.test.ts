vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
 ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
 loadAgentWallet: vi.fn(),
saveAgentWallet: vi.fn(),
withWalletLock: vi.fn(<T>(fn: () => Promise<T> | T) => Promise.resolve(fn()))
}));
import { beforeEach, describe, expect, it, vi } from "vitest";

const { FakeOutputData } = vi.hoisted(() => {
  class FakeOutputData {
    constructor(
      public blindedMessage: { amount: { toNumber: () => number }; B_: string; id: string },
      public blindingFactor: bigint,
      public secret: Uint8Array,
      public ephemeralE?: string
    ) {}
    toProof(
      sig: { id: string; amount: number; C_: string },
      _keyset: { id: string; keys: Record<number, string> }
    ): { id: string; amount: number; secret: string; C: string } {
      return {
        id: this.blindedMessage.id,
        amount: this.blindedMessage.amount.toNumber(),
        secret: new TextDecoder().decode(this.secret),
        C: sig.C_,
      };
    }
  }
  return { FakeOutputData };
});

vi.mock("@cashu/cashu-ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("@cashu/cashu-ts")>()), ...(() => ({
  Amount: {
    from: (x: unknown) => ({
      toNumber: () =>
        typeof x === "object" && x !== null && "toNumber" in x
          ? (x as { toNumber: () => number }).toNumber()
          : Number(x),
    }),
  },
  MintQuoteState: { UNPAID: "UNPAID", PAID: "PAID", ISSUED: "ISSUED" } as const,
  OutputData: FakeOutputData,
}))() }));

import type { ProviderInfo } from "@dvmkit/sdk/internal";
import { reserveAgentWallet } from "../reserve";
import type { AgentWallet } from "@dvmkit/sdk/internal";
import { loadAgentWallet, saveAgentWallet } from "@dvmkit/sdk/internal";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

const baseWallet: AgentWallet = {
  version: 9,
  lock_privkey: "ab".repeat(32),
  lock_pubkey: "02" + "cd".repeat(32),
  mnemonic_fingerprint: "ff".repeat(32),
  mints: ["https://mint.example"],
  proofs: [],
  nut13_counters: {},
  pending_mints: [],
  pending_melts: [],
  pending_submissions: [],
  recent_spends: [],
  created_at: "2026-05-09T00:00:00.000Z",
};

function info(overrides: Partial<NonNullable<ProviderInfo["cashu"]>> = {}): ProviderInfo {
  return {
    cashu: {
      mints: ["https://mint.example"],
      lock_pubkeys: ["02" + "ee".repeat(32)],
      min_locktime: 7 * 86400,
      canonical_id: "42",
      ...overrides,
    },
  } as ProviderInfo;
}

function makeMockWallet() {
  const defaultPreview = {
    payload: { outputs: [], quote: "quote-r1" },
    outputData: [
      new FakeOutputData(
        { amount: { toNumber: () => 4 }, B_: "02BB04", id: "k1" },
        7n,
        new TextEncoder().encode("s4")
      ),
      new FakeOutputData(
        { amount: { toNumber: () => 1 }, B_: "02BB01", id: "k1" },
        9n,
        new TextEncoder().encode("s1")
      ),
    ],
    keysetId: "k1",
    quote: { quote: "quote-r1", request: "lnbc1...", state: "PAID" },
  };
  return {
    createLockedMintQuote: vi.fn().mockResolvedValue({
      quote: "quote-r1",
      request: "lnbc1...",
      state: "UNPAID",
      amount: 1000,
      unit: "sat",
      expiry: 1_800_000_000,
    }),
    checkMintQuoteBolt11: vi.fn().mockResolvedValue({
      quote: "quote-r1",
      request: "lnbc1...",
      state: "PAID",
      amount: 1000,
      unit: "sat",
      expiry: null,
    }),
    prepareMint: vi.fn().mockResolvedValue(defaultPreview),
    completeMint: vi.fn().mockResolvedValue([
      { id: "k1", amount: 4, secret: "s4", C: "02C4" },
      { id: "k1", amount: 1, secret: "s1", C: "02C1" },
    ]),
    keyChain: { getKeysets: vi.fn().mockReturnValue([]) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadAgentWallet).mockReturnValue({ ...baseWallet, pending_mints: [], proofs: [] });
});

describe("reserveAgentWallet", () => {
  it("refuses when /v1/info has no cashu section", async () => {
    await expect(
      reserveAgentWallet(100, {
        mintUrl: "https://mint.example",
        builderHandle: "scrape.dvmkit.ai",
        providerInfo: {} as ProviderInfo,
        readMnemonic: () => MNEMONIC,
      })
    ).rejects.toMatchObject({ code: "missing_cashu_info" });
  });

  it("refuses when the chosen mint isn't in the builder's allowlist", async () => {
    await expect(
      reserveAgentWallet(100, {
        mintUrl: "https://other-mint.example",
        builderHandle: "scrape.dvmkit.ai",
        providerInfo: info(),
        readMnemonic: () => MNEMONIC,
      })
    ).rejects.toMatchObject({ code: "mint_not_accepted" });
  });

  it("refuses when locktime is below the builder's minimum", async () => {
    await expect(
      reserveAgentWallet(100, {
        mintUrl: "https://mint.example",
        builderHandle: "scrape.dvmkit.ai",
        locktimeSeconds: 86400,
        providerInfo: info(),
        readMnemonic: () => MNEMONIC,
      })
    ).rejects.toMatchObject({ code: "locktime_too_short" });
  });

  it("refuses when canonical_id is missing (no refund-subkey derivation possible)", async () => {
    await expect(
      reserveAgentWallet(100, {
        mintUrl: "https://mint.example",
        builderHandle: "scrape.dvmkit.ai",
        providerInfo: info({ canonical_id: null }),
        readMnemonic: () => MNEMONIC,
      })
    ).rejects.toMatchObject({ code: "missing_canonical_id" });
  });

  it("refuses when the mnemonic is missing (NUT-13 inactive)", async () => {
    await expect(
      reserveAgentWallet(100, {
        mintUrl: "https://mint.example",
        builderHandle: "scrape.dvmkit.ai",
        providerInfo: info(),
        readMnemonic: () => null,
      })
    ).rejects.toMatchObject({ code: "mnemonic_required" });
  });

  it("mints reserve proofs with reserved_for + t_expire when validation passes", async () => {
    const cashu = makeMockWallet();
    const nowMs = 1_700_000_000_000;
    const locktimeSeconds = 30 * 86400;

    const result = await reserveAgentWallet(5, {
      mintUrl: "https://mint.example",
      builderHandle: "scrape.dvmkit.ai",
      locktimeSeconds,
      providerInfo: info(),
      readMnemonic: () => MNEMONIC,
      getWalletForMint: () => Promise.resolve(cashu as never),
      now: () => nowMs,
    });

    expect(result.builder_handle).toBe("scrape.dvmkit.ai");
    expect(result.lock_pubkey).toBe("02" + "ee".repeat(32));
    expect(result.refund_pubkey).toBe("02a3e7f5e3a1ef088c5c0b8d23c0ccfeaa5efd0dd6031907bcae4bdce520d5b8b5");
    expect(result.t_expire_ms).toBe((Math.floor(nowMs / 1000) + locktimeSeconds) * 1000);
    for (const p of result.proofs) {
      expect(p.reserved_for).toBe("builder/scrape.dvmkit.ai");
      expect(p.t_expire).toBe(result.t_expire_ms);
      expect(p.locked_to_pubkey).toBe(result.lock_pubkey);
      expect(p.status).toBe("valid");
    }
    const prepareCalls = cashu.prepareMint.mock.calls[0];
    expect(prepareCalls[4]).toMatchObject({
      type: "p2pk",
      options: {
        pubkey: result.lock_pubkey,
        locktime: Math.floor(nowMs / 1000) + locktimeSeconds,
        refundKeys: [result.refund_pubkey],
      },
    });
    const savedPending = vi.mocked(saveAgentWallet).mock.calls[0]?.[0];
    expect(savedPending?.pending_mints[0]?.expires_at).toBe(1_800_000_000);
    const savedFinal = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(savedFinal?.proofs).toHaveLength(2);
    expect(savedFinal?.pending_mints).toHaveLength(0);
  });

  it("inherits transient quote-poll retry from the shared wait", async () => {
    const cashu = makeMockWallet();
    cashu.checkMintQuoteBolt11
      .mockRejectedValueOnce(
        Object.assign(new Error("offline"), {
          name: "NetworkError",
        })
      )
      .mockResolvedValueOnce({ quote: "quote-r1", state: "PAID" });
    const sleeps: number[] = [];
    let now = 0;

    await reserveAgentWallet(5, {
      mintUrl: "https://mint.example",
      builderHandle: "scrape.dvmkit.ai",
      providerInfo: info(),
      readMnemonic: () => MNEMONIC,
      getWalletForMint: () => Promise.resolve(cashu as never),
      timeoutMs: 10_000,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    expect(sleeps).toEqual([2_000]);
    expect(cashu.checkMintQuoteBolt11).toHaveBeenCalledTimes(2);
    expect(cashu.completeMint).toHaveBeenCalledTimes(1);
  });
});
