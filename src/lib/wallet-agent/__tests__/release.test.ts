vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
 ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
 loadAgentWallet: vi.fn(),
saveAgentWallet: vi.fn(),
withWalletLock: vi.fn(<T>(fn: () => Promise<T> | T) => Promise.resolve(fn()))
}));
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cashu/cashu-ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("@cashu/cashu-ts")>()), ...(() => ({
  OutputData: class {
    constructor(
      public blindedMessage: { amount: { toNumber: () => number }; B_: string; id: string },
      public blindingFactor: bigint,
      public secret: Uint8Array
    ) {}

    toProof(signature: { id: string; C_: string }) {
      return {
        id: signature.id,
        amount: this.blindedMessage.amount,
        secret: new TextDecoder().decode(this.secret),
        C: signature.C_,
      };
    }
  },
  Amount: {
    from: (x: unknown) => ({
      toNumber: () =>
        typeof x === "object" && x !== null && "toNumber" in x
          ? (x as { toNumber: () => number }).toNumber()
          : Number(x),
    }),
  },
}))() }));

import { Amount, MintOperationError } from "@cashu/cashu-ts";

import type { ProviderInfo } from "@dvmkit/sdk/internal";
import { releaseAgentReserve } from "../release";
import type { AgentProof, AgentWallet } from "@dvmkit/sdk/internal";
import { loadAgentWallet, saveAgentWallet } from "@dvmkit/sdk/internal";

import lockfile from "proper-lockfile";
import { allReleaseIntents, clearReleaseIntent } from "../release-intents";

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
  const blinded = (p: { id: string; amount: number; secret: string }) => ({
    id: p.id, amount: p.amount, B_: `blind-${p.secret}`,
  });
  const send = vi.fn();
  const sendBuilder = {
    asP2PK: vi.fn().mockReturnThis(),
    asRandom: vi.fn().mockReturnThis(),
    keepAsP2PK: vi.fn().mockReturnThis(),
    keepAsRandom: vi.fn().mockReturnThis(),
    privkey: vi.fn().mockReturnThis(),
    includeFees: vi.fn().mockReturnThis(),
    prepare: vi.fn(() => Promise.resolve({
      keysetId: "k1",
      inputs: send.mock.calls.at(-1)?.[1] ?? [],
      sendOutputs: outputs.map((p) => ({
        blindedMessage: blinded(p),
        blindingFactor: 1n,
        secret: new TextEncoder().encode(p.secret),
      })),
      keepOutputs: [],
    })),
  };
  return {
    groupProofsByState: vi.fn().mockResolvedValue(grouped),
    ops: { send: send.mockReturnValue(sendBuilder) },
    completeSwap: vi.fn().mockResolvedValue({ send: outputs, keep: [] }),
    keyChain: { getKeyset: vi.fn(() => ({})) },
    mint: {
      restore: vi.fn((request: { outputs: { B_: string }[] }) => {
        const known = request.outputs.map((o) => outputs.find((p) => blinded(p).B_ === o.B_)).filter((p) => p !== undefined);
        return Promise.resolve({
          outputs: known.map(blinded),
          signatures: known.map((p) => ({ id: p.id, amount: p.amount, C_: p.C })),
        });
      }),
    },
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
  vi.mocked(saveAgentWallet).mockReset();
  for (const intent of allReleaseIntents()) clearReleaseIntent(intent);
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


describe("release durability", () => {
  const NOW = 2_000_000_000_000;
  const INPUT = proof("reserve", 6, { reserved_for: "builder/scrape.dvmkit.ai", t_expire: NOW - 1_000 });
  const OUTPUT = { id: "k1", amount: 6, secret: "released", C: "02OUT" };
  const UNSPENT = { unspent: [INPUT], spent: [], pending: [] };
  const SPENT = { unspent: [], spent: [INPUT], pending: [] };

  function persistentWallet(proofs: AgentProof[] = [INPUT]) {
    let held = walletWith(proofs);
    vi.mocked(loadAgentWallet).mockImplementation(() => held);
    vi.mocked(saveAgentWallet).mockImplementation((next) => { held = next; });
  }

  function release(cashu: ReturnType<typeof makeCashuWallet>, options: { now?: () => number; outputMode?: "locked" | "unlocked" } = {}) {
    return releaseAgentReserve({
      builderHandle: "scrape.dvmkit.ai", providerInfo: info(), readMnemonic: () => MNEMONIC,
      getWalletForMint: () => Promise.resolve(cashu as never), now: () => NOW,
      ...options,
    });
  }

  function failCleanup() {
    vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    const original = lockfile.lockSync;
    let writes = 0;
    return vi.spyOn(lockfile, "lockSync").mockImplementation((file, options) => {
      if (String(file).endsWith("release-intents.json") && ++writes > 1) throw new Error("journal unavailable");
      return original(file, options);
    });
  }

  it.each(["locked", "unlocked"] as const)("recovers a failed wallet save without another swap (%s outputs)", async (outputMode) => {
    const unrelated = proof("unrelated", 2);
    persistentWallet([INPUT, unrelated]);
    vi.mocked(saveAgentWallet).mockImplementationOnce(() => { throw new Error("disk full"); });
    const firstMint = makeCashuWallet(UNSPENT, [OUTPUT]);
    firstMint.completeSwap.mockImplementationOnce(async () => {
      expect(allReleaseIntents()).toMatchObject([{ inputs: [INPUT], outputs: [{ secret: Buffer.from("released").toString("hex") }] }]);
      return { send: [OUTPUT], keep: [] };
    });

    const first = await release(firstMint, { outputMode });

    expect(first.mints[0]).toMatchObject({ reclaimedInputs: [], reclaimedOutputs: [], error: expect.stringContaining("disk full") });
    expect(loadAgentWallet()?.proofs).toEqual([INPUT, unrelated]);
    expect(allReleaseIntents()).toHaveLength(1);

    const nextMint = makeCashuWallet(SPENT, [OUTPUT]);
    const recovered = await release(nextMint);

    expect(recovered.mints[0]).toMatchObject({ error: null, alreadySpent: [], reclaimedInputs: [INPUT] });
    expect(nextMint.mint.restore).toHaveBeenCalledTimes(1);
    expect(nextMint.completeSwap).not.toHaveBeenCalled();
    expect(nextMint._sendBuilder.prepare).not.toHaveBeenCalled();
    expect(firstMint.completeSwap).toHaveBeenCalledTimes(1);
    expect(loadAgentWallet()?.proofs).toEqual([
      unrelated,
      expect.objectContaining({ secret: "released", amount: 6, status: "valid", locked_to_pubkey: outputMode === "locked" ? walletWith([]).lock_pubkey : null }),
    ]);
    expect(loadAgentWallet()?.proofs[1].reserved_for).toBeUndefined();
    expect(allReleaseIntents()).toEqual([]);
  });

  it("starts over with one swap after an interruption before reaching the mint", async () => {
    persistentWallet();
    const interrupted = makeCashuWallet(UNSPENT, [OUTPUT]);
    interrupted.completeSwap.mockRejectedValueOnce(new Error("interrupted before sending"));
    await release(interrupted);
    expect(allReleaseIntents()).toHaveLength(1);

    const nextMint = makeCashuWallet(UNSPENT, [OUTPUT]);
    nextMint.mint.restore.mockResolvedValueOnce({ outputs: [], signatures: [] });
    const result = await release(nextMint, { now: () => NOW + 3 * 60_000 });

    expect(result.mints[0].error).toBeNull();
    expect(nextMint.mint.restore).toHaveBeenCalledTimes(1);
    expect(nextMint.completeSwap).toHaveBeenCalledTimes(1);
    expect(loadAgentWallet()?.proofs.map((p) => p.secret)).toEqual(["released"]);
    expect(allReleaseIntents()).toEqual([]);
  });

  it("recovers a lost response after the mint committed", async () => {
    persistentWallet();
    const interrupted = makeCashuWallet(UNSPENT, [OUTPUT]);
    interrupted.completeSwap.mockRejectedValueOnce(new Error("response lost"));
    const first = await release(interrupted);
    expect(first.mints[0].error).toContain("response lost");

    const nextMint = makeCashuWallet(SPENT, [OUTPUT]);
    await release(nextMint);

    expect(nextMint.completeSwap).not.toHaveBeenCalled();
    expect(loadAgentWallet()?.proofs.map((p) => p.secret)).toEqual(["released"]);
    expect(allReleaseIntents()).toEqual([]);
  });

  it("never sends a swap if the recovery journal cannot be written", async () => {
    persistentWallet();
    vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    const original = lockfile.lockSync;
    const busy = vi.spyOn(lockfile, "lockSync").mockImplementation((file, options) => {
      if (String(file).endsWith("release-intents.json")) throw new Error("journal unavailable");
      return original(file, options);
    });
    const cashu = makeCashuWallet(UNSPENT, [OUTPUT]);

    const result = await release(cashu);
    busy.mockRestore();

    expect(result.mints[0].error).toContain("nothing was swapped");
    expect(cashu.completeSwap).not.toHaveBeenCalled();
    expect(loadAgentWallet()?.proofs).toEqual([INPUT]);
    expect(allReleaseIntents()).toEqual([]);
  });

  it.each(["partial", "unavailable", "pending"])("keeps the intent and reserve while recovery is %s", async (condition) => {
    persistentWallet();
    const outputs = [ { ...OUTPUT, amount: 4 }, { ...OUTPUT, secret: "released-2", amount: 2 } ];
    const first = makeCashuWallet(UNSPENT, outputs);
    vi.mocked(saveAgentWallet).mockImplementationOnce(() => { throw new Error("disk full"); });
    await release(first);
    const held = allReleaseIntents();
    const nextMint = makeCashuWallet(condition === "pending" ? { unspent: [], spent: [], pending: [INPUT] } : SPENT, condition === "partial" ? outputs.slice(0, 1) : []);
    if (condition === "unavailable") nextMint.mint.restore.mockRejectedValue(new Error("NUT-09 unavailable"));

    const result = await release(nextMint, { now: () => NOW + 3 * 60_000 });

    expect(result.mints[0].error).not.toBeNull();
    expect(result.mints[0].alreadySpent).toEqual([]);
    expect(nextMint.completeSwap).not.toHaveBeenCalled();
    expect(loadAgentWallet()?.proofs).toEqual([INPUT]);
    expect(allReleaseIntents()).toEqual(held);
  });

  it("leaves a fresh intent alone while another command may be submitting it", async () => {
    persistentWallet();
    const first = makeCashuWallet(UNSPENT, [OUTPUT]);
    first.completeSwap.mockRejectedValueOnce(new Error("connection lost"));
    await release(first);
    const held = allReleaseIntents();
    const nextMint = makeCashuWallet(UNSPENT, []);

    const result = await release(nextMint);

    expect(result.mints[0].error).toContain("in flight");
    expect(nextMint.completeSwap).not.toHaveBeenCalled();
    expect(allReleaseIntents()).toEqual(held);
  });

  it("cleans up a landed release without re-adding outputs already spent again", async () => {
    persistentWallet();
    const busy = failCleanup();
    const first = await release(makeCashuWallet(UNSPENT, [OUTPUT]));
    busy.mockRestore();
    expect(first.mints[0]).toMatchObject({ reclaimedOutputs: [expect.objectContaining({ secret: "released" })], error: expect.stringContaining("cleanup failed") });
    expect(allReleaseIntents()).toHaveLength(1);
    // The new proofs were saved and then used by a later payment.
    saveAgentWallet(walletWith([]));
    const nextMint = makeCashuWallet(SPENT, [OUTPUT]);

    const result = await release(nextMint);

    expect(result.mints[0]).toMatchObject({ error: null, reclaimedOutputs: [], alreadySpent: [] });
    expect(nextMint.mint.restore).not.toHaveBeenCalled();
    expect(nextMint.completeSwap).not.toHaveBeenCalled();
    expect(loadAgentWallet()?.proofs).toEqual([]);
    expect(allReleaseIntents()).toEqual([]);
  });

  it("saves restored outputs once when two recoveries overlap", async () => {
    persistentWallet();
    vi.mocked(saveAgentWallet).mockImplementationOnce(() => { throw new Error("disk full"); });
    await release(makeCashuWallet(UNSPENT, [OUTPUT]));
    const inner = makeCashuWallet(SPENT, [OUTPUT]);
    const outer = makeCashuWallet(SPENT, [OUTPUT]);
    const restore = outer.mint.restore.getMockImplementation()!;
    outer.mint.restore.mockImplementationOnce(async (request) => {
      const overlapping = await release(inner);
      expect(overlapping.mints[0].error).toContain("release lock");
      return restore(request);
    });
    vi.mocked(saveAgentWallet).mockClear();

    await release(outer);

    expect(saveAgentWallet).toHaveBeenCalledTimes(1);
    expect(loadAgentWallet()?.proofs.map((p) => p.secret)).toEqual(["released"]);
    expect(inner.completeSwap).not.toHaveBeenCalled();
    expect(outer.completeSwap).not.toHaveBeenCalled();
    expect(allReleaseIntents()).toEqual([]);
  });

  it("keeps an active release's journal even after the retry guard expires", async () => {
    persistentWallet();
    const active = makeCashuWallet(UNSPENT, [OUTPUT]);
    const overlapping = makeCashuWallet(SPENT, []);
    active.completeSwap.mockImplementationOnce(async () => {
      const held = allReleaseIntents();
      const result = await release(overlapping, { now: () => NOW + 3 * 60_000 });
      expect(result.mints[0].error).toContain("release lock");
      expect(result.mints[0].alreadySpent).toEqual([]);
      expect(allReleaseIntents()).toEqual(held);
      expect(loadAgentWallet()?.proofs).toEqual([INPUT]);
      return { send: [OUTPUT], keep: [] };
    });

    const result = await release(active);

    expect(result.mints[0].error).toBeNull();
    expect(overlapping.groupProofsByState).not.toHaveBeenCalled();
    expect(overlapping.completeSwap).not.toHaveBeenCalled();
    expect(loadAgentWallet()?.proofs.map((p) => p.secret)).toEqual(["released"]);
    expect(allReleaseIntents()).toEqual([]);
  });

  it("blocks an overlapping release while the first command is still preparing", async () => {
    persistentWallet();
    const active = makeCashuWallet(UNSPENT, [OUTPUT]);
    const overlapping = makeCashuWallet(UNSPENT, [OUTPUT]);
    const prepare = active._sendBuilder.prepare.getMockImplementation()!;
    active._sendBuilder.prepare.mockImplementationOnce(async () => {
      const result = await release(overlapping);
      expect(result.mints[0].error).toContain("release lock");
      return prepare();
    });

    await release(active);

    expect(active.completeSwap).toHaveBeenCalledTimes(1);
    expect(overlapping.completeSwap).not.toHaveBeenCalled();
    expect(overlapping._sendBuilder.prepare).not.toHaveBeenCalled();
    expect(loadAgentWallet()?.proofs.map((p) => p.secret)).toEqual(["released"]);
    expect(allReleaseIntents()).toEqual([]);
  });

  it("isolates mint outcomes when one wallet save fails", async () => {
    const secondInput = { ...INPUT, mint: "https://other-mint.example" };
    persistentWallet([INPUT, secondInput]);
    vi.mocked(saveAgentWallet).mockImplementationOnce(() => { throw new Error("disk full"); });
    const firstMint = makeCashuWallet(UNSPENT, [OUTPUT]);
    const secondMint = makeCashuWallet(UNSPENT, [OUTPUT]);
    const result = await releaseAgentReserve({
      builderHandle: "scrape.dvmkit.ai", providerInfo: info(), readMnemonic: () => MNEMONIC,
      now: () => NOW,
      getWalletForMint: (mint) => Promise.resolve((mint === INPUT.mint ? firstMint : secondMint) as never),
    });

    expect(result.mints.map((m) => m.error)).toEqual([expect.stringContaining("disk full"), null]);
    expect(loadAgentWallet()?.proofs).toEqual([
      INPUT,
      expect.objectContaining({ mint: secondInput.mint, secret: "released", amount: 6 }),
    ]);
    expect(allReleaseIntents().map((intent) => intent.mint)).toEqual([INPUT.mint]);

    const recovered = await release(makeCashuWallet(SPENT, [OUTPUT]));
    expect(recovered.mints[0].error).toBeNull();
    expect(loadAgentWallet()?.proofs.map((p) => p.mint).sort()).toEqual([INPUT.mint, secondInput.mint].sort());
    expect(allReleaseIntents()).toEqual([]);
  });

  it("drops builder-redeemed inputs only after NUT-09 confirms no release outputs", async () => {
    persistentWallet();
    const interrupted = makeCashuWallet(UNSPENT, [OUTPUT]);
    interrupted.completeSwap.mockRejectedValueOnce(new Error("request not sent"));
    await release(interrupted);
    const redeemed = makeCashuWallet(SPENT, []);

    const result = await release(redeemed, { now: () => NOW + 3 * 60_000 });

    expect(result.mints[0]).toMatchObject({ error: null, alreadySpent: [INPUT], reclaimedOutputs: [] });
    expect(redeemed.mint.restore).toHaveBeenCalledTimes(1);
    expect(redeemed.completeSwap).not.toHaveBeenCalled();
    expect(loadAgentWallet()?.proofs).toEqual([]);
    expect(allReleaseIntents()).toEqual([]);
  });

  it("keeps mint-pending reserve proofs without attempting a swap", async () => {
    persistentWallet();
    const cashu = makeCashuWallet({ unspent: [], spent: [], pending: [INPUT] }, []);

    const result = await release(cashu);

    expect(result.mints[0]).toMatchObject({ error: null, pending: [INPUT], alreadySpent: [], reclaimedOutputs: [] });
    expect(cashu.completeSwap).not.toHaveBeenCalled();
    expect(saveAgentWallet).not.toHaveBeenCalled();
    expect(loadAgentWallet()?.proofs).toEqual([INPUT]);
  });

  it("discards a definitively refused swap's intent", async () => {
    persistentWallet();
    const cashu = makeCashuWallet(UNSPENT, [OUTPUT]);
    cashu.completeSwap.mockRejectedValueOnce(new MintOperationError(11001, "token already spent"));

    const result = await release(cashu);

    expect(result.mints[0].error).toContain("token already spent");
    expect(allReleaseIntents()).toEqual([]);
    expect(loadAgentWallet()?.proofs).toEqual([INPUT]);
  });
});
