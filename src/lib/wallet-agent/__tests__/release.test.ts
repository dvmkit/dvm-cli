vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
 ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
 loadAgentWallet: vi.fn(),
saveAgentWallet: vi.fn(),
withWalletLock: vi.fn(<T>(fn: () => Promise<T> | T) => Promise.resolve(fn()))
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

import { Amount } from "@cashu/cashu-ts";

import type { ProviderInfo } from "@dvmkit/sdk/internal";
import { releaseAgentReserve } from "../release";
import type { AgentProof, AgentWallet } from "@dvmkit/sdk/internal";
import { loadAgentWallet, saveAgentWallet } from "@dvmkit/sdk/internal";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

function proof(secret: string, amount: number, partial: Partial<AgentProof> = {}): AgentProof {
  return {
    mint: "https://mint.example",
    secret,
    C: `02${secret}C`,
    amount,
    id: "k1",
    locked_to_pubkey: "02" + "ee".repeat(32),
    status: "valid",
    ...partial,
  };
}

function walletWith(proofs: AgentProof[]): AgentWallet {
  return {
    version: 9,
    lock_privkey: "ab".repeat(32),
    lock_pubkey: "02" + "cd".repeat(32),
    mnemonic_fingerprint: "ff".repeat(32),
    mints: ["https://mint.example"],
    proofs,
    nut13_counters: {},
    pending_mints: [],
    pending_melts: [],
    pending_submissions: [],
    recent_spends: [],
    created_at: "2026-05-09T00:00:00.000Z",
  };
}

function info(): ProviderInfo {
  return {
    cashu: {
      mints: ["https://mint.example"],
      lock_pubkeys: ["02" + "ee".repeat(32)],
      min_locktime: 7 * 86400,
      canonical_id: "42",
    },
  } as ProviderInfo;
}

interface GroupedProofs {
  unspent: { secret: string }[];
  pending: { secret: string }[];
  spent: { secret: string }[];
}

function makeCashuWallet(
  grouped: GroupedProofs,
  outputs: { id: string; amount: number; secret: string; C: string }[],
  ppk = 0
) {
  const sendBuilder = {
    asP2PK: vi.fn().mockReturnThis(),
    asRandom: vi.fn().mockReturnThis(),
    privkey: vi.fn().mockReturnThis(),
    includeFees: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ send: outputs, keep: [] }),
  };
  return {
    groupProofsByState: vi.fn().mockResolvedValue(grouped),
    ops: { send: vi.fn().mockReturnValue(sendBuilder) },
    getKeyset: vi.fn().mockReturnValue({ id: "k1", fee: ppk, keys: {} }),
    getFeesForKeyset: vi.fn((n: number) =>
      Amount.from(Math.floor(Math.max((n * ppk + 999) / 1000, 0)))
    ),
    getFeesForProofs: vi.fn((proofs: { id: string }[]) =>
      Amount.from(Math.ceil((proofs.length * ppk) / 1000))
    ),
    _sendBuilder: sendBuilder,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("releaseAgentReserve", () => {
  const RESERVED_FOR = "builder/scrape.dvmkit.ai";

  it("returns an empty result when no reserve matches the builder", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([]));
    const result = await releaseAgentReserve({
      builderHandle: "scrape.dvmkit.ai",
      providerInfo: info(),
      readMnemonic: () => MNEMONIC,
      getWalletForMint: () => Promise.reject(new Error("must not be called")),
    });
    expect(result.mints).toEqual([]);
  });

  it("refunds expired reserve proofs via the NUT-11 refund path (master-locked outputs by default)", async () => {
    const nowMs = 2_000_000_000_000;
    const expiredA = proof("rA", 4, {
      reserved_for: RESERVED_FOR,
      t_expire: nowMs - 1_000,
    });
    const expiredB = proof("rB", 2, {
      reserved_for: RESERVED_FOR,
      t_expire: nowMs - 500,
    });
    const wallet = walletWith([expiredA, expiredB]);
    vi.mocked(loadAgentWallet).mockReturnValue(wallet);

    const cashu = makeCashuWallet(
      { unspent: [{ secret: "rA" }, { secret: "rB" }], pending: [], spent: [] },
      [{ id: "k1", amount: 6, secret: "out", C: "02OUT" }]
    );

    const result = await releaseAgentReserve({
      builderHandle: "scrape.dvmkit.ai",
      providerInfo: info(),
      readMnemonic: () => MNEMONIC,
      getWalletForMint: () => Promise.resolve(cashu as never),
      now: () => nowMs,
    });

    expect(result.output_mode).toBe("locked");
    expect(result.mints).toHaveLength(1);
    expect(result.mints[0].reclaimedInputs.map((p) => p.secret).sort()).toEqual(["rA", "rB"]);
    expect(result.mints[0].reclaimedOutputs).toHaveLength(1);
    expect(result.mints[0].reclaimedOutputs[0].amount).toBe(6);
    expect(result.mints[0].reclaimedOutputs[0].locked_to_pubkey).toBe(wallet.lock_pubkey);
    expect(cashu._sendBuilder.privkey).toHaveBeenCalledWith("0ee99cc873c4781d700a7867a9321a59562c9ab2cf707092a94082683e4f84c9");
    expect(cashu._sendBuilder.asP2PK).toHaveBeenCalledWith({ pubkey: wallet.lock_pubkey });
    const saved = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(saved?.proofs.some((p) => p.secret === "rA")).toBe(false);
    expect(saved?.proofs.some((p) => p.secret === "rB")).toBe(false);
    expect(saved?.proofs.some((p) => p.secret === "out")).toBe(true);
  });

  it("drops already-spent reserves via NUT-7 checkstate without touching the swap", async () => {
    const nowMs = 2_000_000_000_000;
    const expired = proof("rSpent", 5, {
      reserved_for: RESERVED_FOR,
      t_expire: nowMs - 1_000,
    });
    const wallet = walletWith([expired]);
    vi.mocked(loadAgentWallet).mockReturnValue(wallet);

    const cashu = makeCashuWallet({ unspent: [], pending: [], spent: [{ secret: "rSpent" }] }, []);

    const result = await releaseAgentReserve({
      builderHandle: "scrape.dvmkit.ai",
      providerInfo: info(),
      readMnemonic: () => MNEMONIC,
      getWalletForMint: () => Promise.resolve(cashu as never),
      now: () => nowMs,
    });

    expect(result.mints[0].alreadySpent.map((p) => p.secret)).toEqual(["rSpent"]);
    expect(result.mints[0].reclaimedInputs).toEqual([]);
    expect(cashu.ops.send).not.toHaveBeenCalled();
    const saved = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(saved?.proofs.some((p) => p.secret === "rSpent")).toBe(false);
  });

  it("emits unlocked outputs when --output unlocked is requested", async () => {
    const nowMs = 2_000_000_000_000;
    const expired = proof("rU", 3, {
      reserved_for: RESERVED_FOR,
      t_expire: nowMs - 100,
    });
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([expired]));

    const cashu = makeCashuWallet({ unspent: [{ secret: "rU" }], pending: [], spent: [] }, [
      { id: "k1", amount: 3, secret: "outU", C: "02UU" },
    ]);

    const result = await releaseAgentReserve({
      builderHandle: "scrape.dvmkit.ai",
      providerInfo: info(),
      outputMode: "unlocked",
      readMnemonic: () => MNEMONIC,
      getWalletForMint: () => Promise.resolve(cashu as never),
      now: () => nowMs,
    });
    expect(result.output_mode).toBe("unlocked");
    expect(cashu._sendBuilder.asRandom).toHaveBeenCalled();
    expect(cashu._sendBuilder.asP2PK).not.toHaveBeenCalled();
  });

  it("sweeps net of the mint's swap fee at a fee-charging mint", async () => {
    const nowMs = 2_000_000_000_000;
    const expiredA = proof("rA", 4, { reserved_for: RESERVED_FOR, t_expire: nowMs - 1_000 });
    const expiredB = proof("rB", 2, { reserved_for: RESERVED_FOR, t_expire: nowMs - 500 });
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([expiredA, expiredB]));

    const cashu = makeCashuWallet(
      { unspent: [{ secret: "rA" }, { secret: "rB" }], pending: [], spent: [] },
      [{ id: "k1", amount: 5, secret: "out", C: "02OUT" }],
      100
    );

    const result = await releaseAgentReserve({
      builderHandle: "scrape.dvmkit.ai",
      providerInfo: info(),
      readMnemonic: () => MNEMONIC,
      getWalletForMint: () => Promise.resolve(cashu as never),
      now: () => nowMs,
    });

    expect(result.mints[0].error).toBeNull();
    expect(cashu.ops.send).toHaveBeenCalledWith(5, expect.any(Array));
    expect(cashu._sendBuilder.includeFees).not.toHaveBeenCalled();
  });

  it("leaves a reserve too small to pay its own swap fee on disk", async () => {
    const nowMs = 2_000_000_000_000;
    const dust = proof("rDust", 1, { reserved_for: RESERVED_FOR, t_expire: nowMs - 100 });
    const initial = walletWith([dust]);
    const initialBytes = JSON.stringify(initial);
    vi.mocked(loadAgentWallet).mockReturnValue(initial);

    const cashu = makeCashuWallet(
      { unspent: [{ secret: "rDust" }], pending: [], spent: [] },
      [],
      1000
    );

    const result = await releaseAgentReserve({
      builderHandle: "scrape.dvmkit.ai",
      providerInfo: info(),
      readMnemonic: () => MNEMONIC,
      getWalletForMint: () => Promise.resolve(cashu as never),
      now: () => nowMs,
    });

    expect(cashu.ops.send).not.toHaveBeenCalled();
    expect(result.mints[0].error).toBe(
      "Reserve at https://mint.example is 1 sats, which does not cover the mint's 1-sat swap fee."
    );
    expect(result.mints[0].reclaimedInputs).toEqual([]);
    expect(saveAgentWallet).not.toHaveBeenCalled();
    expect(JSON.stringify(initial)).toBe(initialBytes);
  });

  it("skips proofs that haven't expired yet", async () => {
    const nowMs = 2_000_000_000_000;
    const unexpired = proof("rLive", 4, {
      reserved_for: RESERVED_FOR,
      t_expire: nowMs + 1_000_000,
    });
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([unexpired]));

    const result = await releaseAgentReserve({
      builderHandle: "scrape.dvmkit.ai",
      providerInfo: info(),
      readMnemonic: () => MNEMONIC,
      getWalletForMint: () => Promise.reject(new Error("should not be called")),
      now: () => nowMs,
    });
    expect(result.mints).toEqual([]);
  });
});
