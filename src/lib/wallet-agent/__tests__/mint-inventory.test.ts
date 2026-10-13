vi.mock("../../identity", async () => ({ ...(await vi.importActual<typeof import("../../identity")>("../../identity")), loadConfig: vi.fn(),
updateConfig: vi.fn() }));
vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
  loadConfig: vi.fn(),
  updateConfig: vi.fn(),
  loadAgentWallet: vi.fn(),
  loadWalletConfiguredMints: vi.fn(),
  saveAgentWallet: vi.fn(),
  withWalletLock: vi.fn(async <T>(fn: () => Promise<T> | T) => fn()),
}));
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig, updateConfig } from "../../identity";
import { buildDisplayMintInventory, loadConfiguredMints } from "../mint-inventory";
import {
  type AgentWallet,
  DEFAULT_AGENT_MINT_URL,
  loadAgentWallet,
  loadWalletConfiguredMints,
  saveAgentWallet,
  WALLET_VERSION,
  withWalletLock,
} from "@dvmkit/sdk/internal";

const baseWallet: AgentWallet = {
  version: WALLET_VERSION,
  lock_privkey: "ab".repeat(32),
  lock_pubkey: "02" + "cd".repeat(32),
  mnemonic_fingerprint: null,
  mints: [],
  proofs: [],
  nut13_counters: {},
  pending_mints: [],
  pending_melts: [],
  pending_submissions: [],
  recent_spends: [],
  created_at: "2026-05-09T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadConfig).mockReturnValue(null);
  vi.mocked(loadWalletConfiguredMints).mockImplementation(() => loadAgentWallet()?.mints ?? []);
  vi.mocked(updateConfig).mockResolvedValue({} as never);
});

describe("loadConfiguredMints", () => {
  it("returns [] when no wallet exists", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(null);
    expect(await loadConfiguredMints()).toEqual([]);
  });

  it("returns wallet.mints unchanged when populated", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue({
      ...baseWallet,
      mints: ["https://a.mint", "https://b.mint"],
    });
    expect(await loadConfiguredMints()).toEqual(["https://a.mint", "https://b.mint"]);
    expect(saveAgentWallet).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("returns wallet.mints when no legacy config.cashuMints is present", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue({ ...baseWallet });
    vi.mocked(loadConfig).mockReturnValue({ defaultBudget: "5000" });
    expect(await loadConfiguredMints()).toEqual([]);
    expect(saveAgentWallet).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("migrates legacy config.cashuMints into empty wallet.mints, deduping in order", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue({ ...baseWallet });
    vi.mocked(loadConfig).mockReturnValue({
      cashuMints: ["https://a.mint", "https://b.mint", "https://a.mint"],
      defaultBudget: "5000",
    });

    let lockHeld = false;
    vi.mocked(withWalletLock).mockImplementation(async (fn) => {
      lockHeld = true;
      try { return await fn(); } finally { lockHeld = false; }
    });
    vi.mocked(updateConfig).mockImplementation(async () => {
      expect(lockHeld).toBe(true);
      return {} as never;
    });
    expect(await loadConfiguredMints()).toEqual(["https://a.mint", "https://b.mint"]);
    expect(saveAgentWallet).toHaveBeenCalledWith(
      expect.objectContaining({ mints: ["https://a.mint", "https://b.mint"] })
    );
    expect(vi.mocked(withWalletLock)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveAgentWallet).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(updateConfig).mock.invocationCallOrder[0]
    );
    const update = vi.mocked(updateConfig).mock.calls[0][0];
    expect(await update.patch({ cashuMints: ["https://a.mint"], defaultBudget: "5000" })).toEqual({ unset: ["cashuMints"] });
    expect(update.reason).toBe("cashu_mints_migration");
  });

  it("does not clobber wallet.mints set by another writer between the read and the lock", async () => {
    vi.mocked(loadAgentWallet)
      .mockReturnValueOnce({ ...baseWallet })
      .mockReturnValueOnce({ ...baseWallet, mints: ["https://winner.mint"] });
    vi.mocked(loadConfig).mockReturnValue({ cashuMints: ["https://loser.mint"] });

    expect(await loadConfiguredMints()).toEqual(["https://winner.mint"]);
    expect(saveAgentWallet).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });
});

describe("buildDisplayMintInventory", () => {
  it("emits the implicit default when the wallet is empty", () => {
    expect(buildDisplayMintInventory(baseWallet)).toEqual([
      { url: DEFAULT_AGENT_MINT_URL, source: "default" },
    ]);
  });

  it("classifies configured mints first, in wallet order", () => {
    const inventory = buildDisplayMintInventory({
      ...baseWallet,
      mints: ["https://a.mint", "https://b.mint"],
    });
    expect(inventory).toEqual([
      { url: "https://a.mint", source: "configured" },
      { url: "https://b.mint", source: "configured" },
    ]);
  });

  it("adds proof-bearing mints not in mints[] as 'proofs'", () => {
    const inventory = buildDisplayMintInventory({
      ...baseWallet,
      mints: ["https://configured.mint"],
      proofs: [
        {
          mint: "https://historical.mint",
          secret: "s",
          C: "02C",
          amount: 10,
          id: "k1",
          locked_to_pubkey: null,
          status: "valid",
        },
      ],
    });
    expect(inventory).toEqual([
      { url: "https://configured.mint", source: "configured" },
      { url: "https://historical.mint", source: "proofs" },
    ]);
  });

  it("adds pending-mint mints not in mints[] as 'pending'", () => {
    const inventory = buildDisplayMintInventory({
      ...baseWallet,
      mints: [],
      pending_mints: [
        {
          mint: "https://pending.mint",
          quote_id: "q1",
          amount_sats: 100,
          requested_at: "2026-05-09T00:00:00.000Z",
        },
      ],
    });
    expect(inventory).toEqual([{ url: "https://pending.mint", source: "pending" }]);
  });

  it("does not surface the default when any configured/proof/pending mint exists", () => {
    const inventory = buildDisplayMintInventory({
      ...baseWallet,
      mints: ["https://a.mint"],
    });
    expect(inventory.find((e) => e.source === "default")).toBeUndefined();
  });

  it("dedupes when the same URL appears as both configured and proof-bearing", () => {
    const inventory = buildDisplayMintInventory({
      ...baseWallet,
      mints: ["https://both.mint"],
      proofs: [
        {
          mint: "https://both.mint",
          secret: "s",
          C: "02C",
          amount: 10,
          id: "k1",
          locked_to_pubkey: null,
          status: "valid",
        },
      ],
    });
    expect(inventory).toEqual([{ url: "https://both.mint", source: "configured" }]);
  });
});
