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

import { sweepPendingMints } from "../recovery";
import type { AgentWallet, PendingMint, PersistedOutputData } from "@dvmkit/sdk/internal";
import { loadAgentWallet, saveAgentWallet } from "@dvmkit/sdk/internal";

const baseWallet: AgentWallet = {
  version: 9,
  lock_privkey: "ab".repeat(32),
  lock_pubkey: "02" + "cd".repeat(32),
  mnemonic_fingerprint: null,
  mints: ["https://mint.example"],
  proofs: [],
  nut13_counters: {},
  pending_mints: [],
  pending_melts: [],
  pending_submissions: [],
  recent_spends: [],
  created_at: "2026-05-09T00:00:00.000Z",
};

const NOW = Date.parse("2026-05-09T12:00:00.000Z");
const FRESH = new Date(NOW - 60_000).toISOString();
const STALE = new Date(NOW - 30 * 60 * 1000).toISOString();

function pending(quote_id: string, requested_at: string): PendingMint {
  return {
    mint: "https://mint.example",
    quote_id,
    amount_sats: 100,
    requested_at,
  };
}

function persistedOutputs(): PersistedOutputData[] {
  return [
    {
      blinded_message: { amount: 64, B_: "02BB64", id: "k1" },
      blinding_factor: "01",
      secret: bytesHex("s64"),
    },
    {
      blinded_message: { amount: 32, B_: "02BB32", id: "k1" },
      blinding_factor: "02",
      secret: bytesHex("s32"),
    },
    {
      blinded_message: { amount: 4, B_: "02BB04", id: "k1" },
      blinding_factor: "03",
      secret: bytesHex("s4"),
    },
  ];
}

function bytesHex(s: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(s)) out += b.toString(16).padStart(2, "0");
  return out;
}

function makeMockWallet(state: "UNPAID" | "PAID" | "ISSUED") {
  return {
    checkMintQuoteBolt11: vi.fn().mockResolvedValue({ quote: "q", state, request: "lnbc1" }),
    prepareMint: vi.fn().mockResolvedValue({
      payload: { outputs: [], quote: "q" },
      outputData: [
        new FakeOutputData(
          { amount: { toNumber: () => 64 }, B_: "02BB64", id: "k1" },
          1n,
          new TextEncoder().encode("s64")
        ),
        new FakeOutputData(
          { amount: { toNumber: () => 32 }, B_: "02BB32", id: "k1" },
          2n,
          new TextEncoder().encode("s32")
        ),
        new FakeOutputData(
          { amount: { toNumber: () => 4 }, B_: "02BB04", id: "k1" },
          3n,
          new TextEncoder().encode("s4")
        ),
      ],
      keysetId: "k1",
      quote: { quote: "q", request: "lnbc1", state: "PAID" },
    }),
    completeMint: vi.fn().mockResolvedValue([
      { id: "k1", amount: 64, secret: "s64", C: "02C64" },
      { id: "k1", amount: 32, secret: "s32", C: "02C32" },
      { id: "k1", amount: 4, secret: "s4", C: "02C4" },
    ]),
    mint: { restore: vi.fn() },
    keyChain: {
      getKeysets: vi.fn().mockReturnValue([]),
      getKeyset: vi.fn().mockReturnValue({ id: "k1", keys: { 64: "x", 32: "x", 4: "x" } }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sweepPendingMints", () => {
  it("is a no-op when no wallet exists", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(null);
    const result = await sweepPendingMints();
    expect(result.outcomes).toEqual([]);
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("is a no-op when pending_mints is empty", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue({ ...baseWallet, pending_mints: [] });
    const result = await sweepPendingMints();
    expect(result.outcomes).toEqual([]);
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("PAID → mints proofs and clears entry", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue({
      ...baseWallet,
      pending_mints: [pending("q1", FRESH)],
    });
    const cashu = makeMockWallet("PAID");
    const complete = cashu.completeMint.getMockImplementation();
    cashu.completeMint.mockImplementation(async () => {
      const durable = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
      expect(durable?.pending_mints[0].minting).toEqual({ keyset_id: "k1", outputs: persistedOutputs() });
      return complete!();
    });
    const result = await sweepPendingMints({
      now: () => NOW,
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
    });

    expect(result.outcomes[0].kind).toBe("minted");
    expect(result.recovered_proofs.map((p) => ({ amount: p.amount, locked_to_pubkey: p.locked_to_pubkey }))).toEqual([
      { amount: 64, locked_to_pubkey: baseWallet.lock_pubkey },
      { amount: 32, locked_to_pubkey: baseWallet.lock_pubkey },
      { amount: 4, locked_to_pubkey: baseWallet.lock_pubkey },
    ]);
    expect(cashu.prepareMint).toHaveBeenCalledTimes(1);
    expect(cashu.completeMint).toHaveBeenCalledTimes(1);

    const calls = vi.mocked(saveAgentWallet).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const intermediate = calls[0][0];
    expect(intermediate.pending_mints[0].minting?.outputs.length).toBeGreaterThan(0);
    const final = calls[calls.length - 1][0];
    expect(final.pending_mints).toHaveLength(0);
    expect(final.proofs).toHaveLength(3);
    expect(final.proofs[0].locked_to_pubkey).toBe(baseWallet.lock_pubkey);
    expect(final.proofs[0].mint).toBe("https://mint.example");
  });

  it("ISSUED with no minting sub-state → drops entry without re-minting (legacy fallback)", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue({
      ...baseWallet,
      pending_mints: [pending("q2", FRESH)],
    });
    const cashu = makeMockWallet("ISSUED");
    const result = await sweepPendingMints({
      now: () => NOW,
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
    });

    expect(result.outcomes[0].kind).toBe("already_issued");
    expect(cashu.prepareMint).not.toHaveBeenCalled();
    expect(cashu.completeMint).not.toHaveBeenCalled();
    expect(cashu.mint.restore).not.toHaveBeenCalled();

    const saved = vi.mocked(saveAgentWallet).mock.calls[0][0];
    expect(saved.pending_mints).toHaveLength(0);
    expect(saved.proofs).toHaveLength(0);
  });

  it("ISSUED with minting sub-state → NUT-09 restore recovers proofs", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue({
      ...baseWallet,
      pending_mints: [
        {
          ...pending("crash-quote", FRESH),
          minting: { keyset_id: "k1", outputs: persistedOutputs() },
        },
      ],
    });
    const cashu = makeMockWallet("ISSUED");
    cashu.mint.restore.mockResolvedValue({
      outputs: [
        { amount: 64, B_: "02BB64", id: "k1" },
        { amount: 32, B_: "02BB32", id: "k1" },
        { amount: 4, B_: "02BB04", id: "k1" },
      ],
      signatures: [
        { id: "k1", amount: 64, C_: "02CC64" },
        { id: "k1", amount: 32, C_: "02CC32" },
        { id: "k1", amount: 4, C_: "02CC04" },
      ],
    });

    const result = await sweepPendingMints({
      now: () => NOW,
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
    });

    expect(result.outcomes[0].kind).toBe("restored");
    expect(result.recovered_proofs).toHaveLength(3);
    expect(cashu.mint.restore).toHaveBeenCalledTimes(1);
    expect(cashu.prepareMint).not.toHaveBeenCalled();
    expect(cashu.completeMint).not.toHaveBeenCalled();

    const saved = vi.mocked(saveAgentWallet).mock.calls[0][0];
    expect(saved.pending_mints).toHaveLength(0);
    expect(saved.proofs).toHaveLength(3);
    expect(saved.proofs.map((p) => p.amount).sort((a, b) => a - b)).toEqual([4, 32, 64]);
    expect(saved.proofs[0].locked_to_pubkey).toBe(baseWallet.lock_pubkey);
  });

  it("ISSUED with minting sub-state but mint returns 0 sigs → falls back to drop", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue({
      ...baseWallet,
      pending_mints: [
        {
          ...pending("dedup-quote", FRESH),
          minting: { keyset_id: "k1", outputs: persistedOutputs() },
        },
      ],
    });
    const cashu = makeMockWallet("ISSUED");
    cashu.mint.restore.mockResolvedValue({ outputs: [], signatures: [] });

    const result = await sweepPendingMints({
      now: () => NOW,
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
    });

    expect(result.outcomes[0].kind).toBe("already_issued");
    expect(result.recovered_proofs).toHaveLength(0);
    const saved = vi.mocked(saveAgentWallet).mock.calls[0][0];
    expect(saved.pending_mints).toHaveLength(0);
    expect(saved.proofs).toHaveLength(0);
  });

  it("ISSUED with minting sub-state but mint returns mismatched outputs/sigs → kind: error", async () => {
    // NUT-09 specifies parallel arrays; a buggy mint that violates this
    // should surface a clean error instead of an undefined.B_ TypeError.
    vi.mocked(loadAgentWallet).mockReturnValue({
      ...baseWallet,
      pending_mints: [
        {
          ...pending("buggy-mint", FRESH),
          minting: { keyset_id: "k1", outputs: persistedOutputs() },
        },
      ],
    });
    const cashu = makeMockWallet("ISSUED");
    cashu.mint.restore.mockResolvedValue({
      outputs: [{ amount: 64, B_: "02BB64", id: "k1" }],
      signatures: [
        { id: "k1", amount: 64, C_: "02CC64" },
        { id: "k1", amount: 32, C_: "02CC32" },
      ],
    });

    const result = await sweepPendingMints({
      now: () => NOW,
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
    });

    expect(result.outcomes[0].kind).toBe("error");
    expect(result.errors[0].error).toMatch(/mismatched outputs.*signatures.*parallel/);
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("ISSUED with minting sub-state but mint.restore throws → kind: error, entry kept", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue({
      ...baseWallet,
      pending_mints: [
        {
          ...pending("net-fail", FRESH),
          minting: { keyset_id: "k1", outputs: persistedOutputs() },
        },
      ],
    });
    const cashu = makeMockWallet("ISSUED");
    cashu.mint.restore.mockRejectedValue(new Error("ECONNRESET"));

    const result = await sweepPendingMints({
      now: () => NOW,
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
    });

    expect(result.outcomes[0].kind).toBe("error");
    expect(result.errors).toEqual([{ quote_id: "net-fail", error: "ECONNRESET" }]);
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("UNPAID + live quote expiry → survives past the fund-timeout fallback", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue({
      ...baseWallet,
      pending_mints: [
        {
          ...pending("live-quote", STALE),
          expires_at: Math.floor(NOW / 1000) + 60,
        },
      ],
    });
    const cashu = makeMockWallet("UNPAID");
    const result = await sweepPendingMints({
      now: () => NOW,
      expirationMs: 10 * 60 * 1000,
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
    });

    expect(result.outcomes[0].kind).toBe("still_pending");
    expect(result.still_pending.map((entry) => entry.quote_id)).toEqual(["live-quote"]);
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("UNPAID + elapsed quote expiry → drops entry even within the fund timeout", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue({
      ...baseWallet,
      pending_mints: [
        {
          ...pending("elapsed-quote", FRESH),
          expires_at: Math.floor(NOW / 1000) - 1,
        },
      ],
    });
    const cashu = makeMockWallet("UNPAID");
    const result = await sweepPendingMints({
      now: () => NOW,
      expirationMs: 10 * 60 * 1000,
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
    });

    expect(result.outcomes[0].kind).toBe("expired");
    const saved = vi.mocked(saveAgentWallet).mock.calls[0][0];
    expect(saved.pending_mints).toHaveLength(0);
  });

  it("UNPAID legacy entry past the fallback → drops entry", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue({
      ...baseWallet,
      pending_mints: [pending("q3", STALE)],
    });
    const cashu = makeMockWallet("UNPAID");
    const result = await sweepPendingMints({
      now: () => NOW,
      expirationMs: 10 * 60 * 1000,
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
    });

    expect(result.outcomes[0].kind).toBe("expired");
    const saved = vi.mocked(saveAgentWallet).mock.calls[0][0];
    expect(saved.pending_mints).toHaveLength(0);
  });

  it("UNPAID legacy entry within the fallback → leaves entry pending", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue({
      ...baseWallet,
      pending_mints: [pending("q4", FRESH)],
    });
    const cashu = makeMockWallet("UNPAID");
    const result = await sweepPendingMints({
      now: () => NOW,
      expirationMs: 10 * 60 * 1000,
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
    });

    expect(result.outcomes[0].kind).toBe("still_pending");
    expect(result.still_pending).toHaveLength(1);
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("network error → keeps entry, surfaces error in result", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue({
      ...baseWallet,
      pending_mints: [pending("q5", FRESH)],
    });
    const result = await sweepPendingMints({
      now: () => NOW,
      getWalletForMint: vi.fn().mockRejectedValue(new Error("ECONNRESET")),
    });

    expect(result.outcomes[0].kind).toBe("error");
    expect(result.errors).toEqual([{ quote_id: "q5", error: "ECONNRESET" }]);
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("retries a transient quote failure before recovering a paid mint", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue({
      ...baseWallet,
      pending_mints: [pending("retry-paid", FRESH)],
    });
    const cashu = makeMockWallet("PAID");
    cashu.checkMintQuoteBolt11
      .mockRejectedValueOnce(
        Object.assign(new Error("too many requests"), {
          name: "RateLimitError",
          status: 429,
          retryAfterMs: 3_000,
        })
      )
      .mockResolvedValueOnce({ quote: "retry-paid", state: "PAID", request: "lnbc1" });
    const sleeps: number[] = [];
    let now = NOW;

    const result = await sweepPendingMints({
      now: () => now,
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    expect(sleeps).toEqual([3_000]);
    expect(cashu.checkMintQuoteBolt11).toHaveBeenCalledTimes(2);
    expect(result.outcomes[0].kind).toBe("minted");
  });

  it("stops transient quote retries at the sweep cap and keeps the mint pending", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue({
      ...baseWallet,
      pending_mints: [pending("retry-later", FRESH)],
    });
    const cashu = makeMockWallet("UNPAID");
    cashu.checkMintQuoteBolt11.mockRejectedValue(
      Object.assign(new Error("mint failed"), {
        name: "HttpResponseError",
        status: 503,
      })
    );
    const sleeps: number[] = [];
    let now = NOW;

    const result = await sweepPendingMints({
      now: () => now,
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
      quoteRetryTimeoutMs: 10_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    expect(now).toBe(NOW + 10_000);
    expect(sleeps).toEqual([2_000, 4_000, 4_000]);
    expect(result.outcomes[0].kind).toBe("error");
    expect(result.errors).toEqual([
      {
        quote_id: "retry-later",
        error: "The mint did not answer status checks for quote retry-later before the wait ended.",
      },
    ]);
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

});
