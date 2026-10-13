vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
 ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
 loadAgentWallet: vi.fn(),
saveAgentWallet: vi.fn(),
withWalletLock: vi.fn(<T>(fn: () => Promise<T> | T) => Promise.resolve(fn())),
getWallet: vi.fn(),
rehydrateOutputData: (persisted: { blinded_message: { B_: string } }[]) =>
    persisted.map((p) => ({
      blindedMessage: { B_: p.blinded_message.B_ },
      toProof: (_sig: unknown, _keyset: unknown) => ({
        id: "k1",
        amount: 3,
        secret: `chg-${p.blinded_message.B_}`,
        C: "02chg",
      }),
    }))
}));
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cashu/cashu-ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("@cashu/cashu-ts")>()), ...(() => ({
  Amount: {
    from: (x: unknown) => ({
      toNumber: () =>
        typeof x === "object" && x !== null && "toNumber" in x
          ? (x as { toNumber: () => number }).toNumber()
          : Number(x),
    }),
  },
}))() }));

import { sweepPendingMelts } from "../recovery-melt";
import type { AgentProof, AgentWallet, PendingMelt } from "@dvmkit/sdk/internal";
import { loadAgentWallet, saveAgentWallet } from "@dvmkit/sdk/internal";

const MINT = "https://mint.example";
const LOCK_PUBKEY = "02" + "cd".repeat(32);
const NOW = Date.parse("2026-07-31T12:00:00.000Z");

function proof(secret: string, amount: number, partial: Partial<AgentProof> = {}): AgentProof {
  return {
    mint: MINT,
    secret,
    C: `02${secret}C`,
    amount,
    id: "k1",
    locked_to_pubkey: LOCK_PUBKEY,
    status: "in_flight",
    in_flight_until_ms: NOW + 60_000,
    ...partial,
  };
}

function entry(partial: Partial<PendingMelt> = {}): PendingMelt {
  return {
    mint: MINT,
    quote_id: "q1",
    bolt11: "lnbc60",
    destination: "recipient@example.com",
    amount_sats: 60,
    fee_reserve_sats: 2,
    input_fee_sats: 2,
    input_proofs: [proof("a", 64)],
    melting: { keyset_id: "k1", outputs: [{ blinded_message: { B_: "B1" } } as never] },
    created_at: "2026-07-31T11:59:00.000Z",
    ...partial,
  };
}

function walletWith(melts: PendingMelt[], proofs?: AgentProof[]): AgentWallet {
  return {
    version: 9,
    lock_privkey: "ab".repeat(32),
    lock_pubkey: LOCK_PUBKEY,
    mnemonic_fingerprint: null,
    mints: [MINT],
    proofs: proofs ?? melts.flatMap((m) => m.input_proofs),
    nut13_counters: {},
    pending_mints: [],
    pending_melts: melts,
    pending_submissions: [],
    recent_spends: [],
    created_at: "2026-07-30T00:00:00.000Z",
  };
}

function makeCashuWallet(state: string, restore?: { fail?: boolean }) {
  return {
    checkMeltQuoteBolt11: vi.fn(async () => ({ state })),
    keyChain: { getKeyset: vi.fn(() => ({ id: "k1" })) },
    mint: {
      restore: vi.fn(async () => {
        if (restore?.fail) throw new Error("restore unavailable");
        return { outputs: [{ B_: "B1" }], signatures: [{ C_: "02sig" }] };
      }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sweepPendingMelts", () => {
  it("is a no-op with nothing in flight", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([]));
    const result = await sweepPendingMelts({ now: () => NOW });
    expect(result.outcomes).toEqual([]);
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("settles a PAID melt: inputs dropped, change restored via NUT-09", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([entry()]));
    const cashuWallet = makeCashuWallet("PAID");

    const result = await sweepPendingMelts({
      now: () => NOW,
      getWalletForMint: async () => cashuWallet as never,
    });

    expect(result.settled_sats).toBe(60);
    const saved = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(saved?.pending_melts).toEqual([]);
    expect(saved?.proofs.map((p) => p.secret)).toEqual(["chg-B1"]);
    expect(saved?.proofs[0].locked_to_pubkey).toBe(LOCK_PUBKEY);
  });

  it("still settles a PAID melt when the change restore fails", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([entry()]));
    const cashuWallet = makeCashuWallet("PAID", { fail: true });

    const result = await sweepPendingMelts({
      now: () => NOW,
      getWalletForMint: async () => cashuWallet as never,
    });

    expect(result.settled_sats).toBe(60);
    const saved = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(saved?.proofs).toEqual([]);
    expect(saved?.pending_melts).toEqual([]);
  });

  it("leaves a PENDING melt alone — the mint is still routing", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([entry()]));
    const result = await sweepPendingMelts({
      now: () => NOW,
      getWalletForMint: async () => makeCashuWallet("PENDING") as never,
    });
    expect(result.still_pending).toHaveLength(1);
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("holds an UNPAID melt inside the melt window, so a second run can't yank proofs mid-submit", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([entry()]));
    const result = await sweepPendingMelts({
      now: () => NOW,
      abandonAfterMs: 900_000,
      getWalletForMint: async () => makeCashuWallet("UNPAID") as never,
    });
    expect(result.still_pending).toHaveLength(1);
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("returns an aged-out UNPAID melt's proofs to spendable", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([entry()]));
    const result = await sweepPendingMelts({
      now: () => NOW,
      abandonAfterMs: 30_000,
      getWalletForMint: async () => makeCashuWallet("UNPAID") as never,
    });

    expect(result.returned_sats).toBe(64);
    const saved = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(saved?.pending_melts).toEqual([]);
    expect(saved?.proofs.map((p) => p.status)).toEqual(["valid"]);
    expect(saved?.proofs[0].in_flight_until_ms).toBeUndefined();
  });

  it("keeps the entry when the mint can't be reached — silence is not a verdict", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([entry()]));
    const result = await sweepPendingMelts({
      now: () => NOW,
      getWalletForMint: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    expect(result.errors).toEqual([{ quote_id: "q1", error: "ECONNREFUSED" }]);
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("retries a transient quote failure before settling a paid melt", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([entry()]));
    const cashuWallet = makeCashuWallet("PAID");
    cashuWallet.checkMeltQuoteBolt11
      .mockRejectedValueOnce(
        Object.assign(new Error("offline"), {
          name: "NetworkError",
        })
      )
      .mockResolvedValueOnce({ state: "PAID" });
    const sleeps: number[] = [];
    let now = NOW;

    const result = await sweepPendingMelts({
      now: () => now,
      getWalletForMint: async () => cashuWallet as never,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    expect(sleeps).toEqual([2_000]);
    expect(cashuWallet.checkMeltQuoteBolt11).toHaveBeenCalledTimes(2);
    expect(result.settled_sats).toBe(60);
  });

  it("stops transient quote retries at the sweep cap and keeps the melt pending", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([entry()]));
    const cashuWallet = makeCashuWallet("PENDING");
    cashuWallet.checkMeltQuoteBolt11.mockRejectedValue(
      Object.assign(new Error("mint failed"), {
        name: "HttpResponseError",
        status: 503,
      })
    );
    const sleeps: number[] = [];
    let now = NOW;

    const result = await sweepPendingMelts({
      now: () => now,
      getWalletForMint: async () => cashuWallet as never,
      quoteRetryTimeoutMs: 10_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    expect(now).toBe(NOW + 10_000);
    expect(sleeps).toEqual([2_000, 4_000, 4_000]);
    expect(result.errors).toEqual([
      {
        quote_id: "q1",
        error: "The mint did not answer status checks for quote q1 before the wait ended.",
      },
    ]);
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("resolves entries across mints independently", async () => {
    const other = entry({ quote_id: "q2", mint: "https://other.example", amount_sats: 10 });
    other.input_proofs = [proof("z", 16, { mint: "https://other.example" })];
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([entry(), other]));

    const result = await sweepPendingMelts({
      now: () => NOW,
      abandonAfterMs: 30_000,
      getWalletForMint: async (url) =>
        (url === MINT ? makeCashuWallet("PAID") : makeCashuWallet("UNPAID")) as never,
    });

    expect(result.settled_sats).toBe(60);
    expect(result.returned_sats).toBe(16);
    expect(vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0].pending_melts).toEqual([]);
  });
});
