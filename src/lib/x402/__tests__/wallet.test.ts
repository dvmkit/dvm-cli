import { privateKeyToAccount } from "viem/accounts";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Identity from "../../identity";

type IdentityModule = typeof Identity;

vi.mock("../../identity", async (importOriginal) => ({
  ...(await importOriginal<IdentityModule>()),
  loadConfig: vi.fn(),
  updateConfig: vi.fn(),
}));
vi.mock("@dvmkit/sdk/internal", async () => ({
  ...(await vi.importActual<typeof import("@dvmkit/sdk/internal")>("@dvmkit/sdk/internal")),
  withX402ChannelLock: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

import { applyConfigPatch } from "../../config-mutation";
import { DvmError, generateX402PrivateKey } from "@dvmkit/sdk/internal";
import type { Config, ConfigUpdate, ConfigUpdateResult } from "../../identity";
import { loadConfig, updateConfig } from "../../identity";

import { withX402ChannelLock } from "@dvmkit/sdk/internal";

import { loadX402Wallet, removeX402Wallet, repinX402WalletNetwork, saveX402Wallet } from "../wallet";

const GOOD_KEY = "0x" + "1".repeat(64);

/**
 * The caller's config, in memory. `loadConfig` reads it and `updateConfig`
 * merges into it exactly as the real field-scoped mutation merges into the file
 * so "writes nothing" is assertable as "this object did not move".
 */
let stored: Config | null = {};

beforeEach(() => {
  vi.clearAllMocks();
  stored = {};
  vi.mocked(loadConfig).mockImplementation(() => stored);
  vi.mocked(updateConfig).mockImplementation(commitToStored);
  vi.mocked(withX402ChannelLock).mockImplementation(async (operation) => operation());
});

async function commitToStored(update: ConfigUpdate): Promise<ConfigUpdateResult> {
  const previous = stored;
  const config = applyConfigPatch(previous ?? {}, await update.patch(previous));
  stored = config;
  return { config, previous, changed: [], written: true, backup: null };
}

describe("loadX402Wallet", () => {
  it("treats an out-of-range stored scalar as no usable x402 wallet", () => {
    stored = { x402: { privateKey: `0x${"0".repeat(64)}` } };

    expect(loadX402Wallet()).toBeNull();
  });
});

describe("repinX402WalletNetwork", () => {
  it("reads and commits the config inside the channel lock", async () => {
    // Channel lock outside, config lock inside — the tree-wide order since
    // which `updateConfig` completes by reloading under its own lock.
    stored = { x402: { privateKey: GOOD_KEY, network: "eip155:84532" } };
    let channelLocked = false;
    vi.mocked(withX402ChannelLock).mockImplementation(async (operation) => {
      channelLocked = true;
      try {
        return await operation();
      } finally {
        channelLocked = false;
      }
    });
    vi.mocked(updateConfig).mockImplementation(async (update) => {
      expect(channelLocked).toBe(true);
      return commitToStored(update);
    });

    await repinX402WalletNetwork("eip155:137");

    expect(withX402ChannelLock).toHaveBeenCalledTimes(1);
    expect(stored).toEqual({ x402: { privateKey: GOOD_KEY, network: "eip155:137" } });
  });

  it("does not restore a key removed by a disconnect that won the channel lock", async () => {
    stored = { x402: { privateKey: GOOD_KEY, network: "eip155:84532" } };
    vi.mocked(withX402ChannelLock).mockImplementation(async (operation) => {
      // The disconnect got there first; the repin's patch sees the file as it
      // now stands, not as it stood when the command started.
      stored = {};
      return operation();
    });

    await expect(repinX402WalletNetwork("eip155:137")).rejects.toMatchObject({
      code: "x402_wallet_missing",
    });
    expect(stored).toEqual({});
  });

  it("changes only the network and leaves balance reads on the new chain", async () => {
    stored = {
      defaultBudget: "$1",
      x402: { privateKey: GOOD_KEY, network: "eip155:84532" },
    };

    const updated = await repinX402WalletNetwork("eip155:137");

    expect(updated).toEqual({
      address: privateKeyToAccount(GOOD_KEY as `0x${string}`).address,
      previousNetwork: "eip155:84532",
      network: "eip155:137",
    });
    expect(stored).toEqual({
      defaultBudget: "$1",
      x402: { privateKey: GOOD_KEY, network: "eip155:137" },
    });
    expect(loadX402Wallet()).toMatchObject({ privateKey: GOOD_KEY, network: "eip155:137" });
  });

  it("reports Base as the previous read-side default for an unpinned wallet", async () => {
    stored = { x402: { privateKey: GOOD_KEY } };

    const updated = await repinX402WalletNetwork("eip155:137");

    expect(updated.previousNetwork).toBe("eip155:8453");
    expect(stored).toEqual({ x402: { privateKey: GOOD_KEY, network: "eip155:137" } });
  });

  it("uses the same unsupported-network refusal as connect and writes nothing", async () => {
    stored = { x402: { privateKey: GOOD_KEY } };

    await expect(repinX402WalletNetwork("eip155:1")).rejects.toMatchObject({
      code: "unsupported_network",
    });
    expect(updateConfig).not.toHaveBeenCalled();
    expect(stored).toEqual({ x402: { privateKey: GOOD_KEY } });
  });

  it("keeps the init remedy when config does not exist", async () => {
    stored = null;

    await expect(repinX402WalletNetwork("eip155:137")).rejects.toMatchObject({
      code: "no_config",
    });
    expect(stored).toBeNull();
  });
});

describe("saveX402Wallet", () => {

  it("persists an unpinned wallet, which the loader defaults to Base", async () => {
    const saved = await saveX402Wallet(GOOD_KEY);

    expect(stored).toEqual({ x402: { privateKey: GOOD_KEY } });
    // Unpinned on disk, but the caller is still told which chain it will pay on.
    expect(saved.network).toBe("eip155:8453");
  });

  // re-connecting is how a key gets rotated, and an omitted --network
  // used to write `undefined` over the pinned chain — moving the caller to Base
  // with no warning, on both the write and the reported side.
  it("keeps the configured chain when --network is omitted on a re-connect", async () => {
    stored = { x402: { privateKey: "0x" + "2".repeat(64), network: "eip155:137" } };

    const saved = await saveX402Wallet(GOOD_KEY);

    expect(stored).toEqual({ x402: { privateKey: GOOD_KEY, network: "eip155:137" } });
    expect(saved.network).toBe("eip155:137");
  });

  it("lets an explicit --network override the configured chain", async () => {
    stored = { x402: { privateKey: "0x" + "2".repeat(64), network: "eip155:137" } };

    const saved = await saveX402Wallet(GOOD_KEY, "eip155:8453");

    expect(stored).toEqual({ x402: { privateKey: GOOD_KEY, network: "eip155:8453" } });
    expect(saved.network).toBe("eip155:8453");
  });

  it.each(["eip155:1", "eip155:8543", "solana:mainnet", "base"])(
    "refuses %s and writes nothing",
    async (network) => {
      await expect(saveX402Wallet(GOOD_KEY, network)).rejects.toThrow(DvmError);
      expect(updateConfig).not.toHaveBeenCalled();
      expect(stored).toEqual({});
    }
  );

  it("refuses an out-of-range scalar before persisting it", async () => {
    await expect(saveX402Wallet(`0x${"0".repeat(64)}`)).rejects.toMatchObject({
      code: "invalid_key",
    });
    expect(updateConfig).not.toHaveBeenCalled();
    expect(stored).toEqual({});
  });
});

// The one path entitled to take the key off the machine, and the only one that
// names `x402` to the protected-field gate.
describe("removeX402Wallet", () => {
  it("removes the key and leaves unrelated configuration standing", async () => {
    stored = { defaultBudget: "$1", x402: { privateKey: GOOD_KEY, network: "eip155:8453" } };

    await removeX402Wallet();

    expect(stored).toEqual({ defaultBudget: "$1" });
  });
});

describe("generateX402PrivateKey", () => {
  it("mints a distinct 32-byte key that saveX402Wallet accepts", async () => {
    const [first, second] = [await generateX402PrivateKey(), await generateX402PrivateKey()];

    expect(first).toMatch(/^0x[0-9a-f]{64}$/);
    expect(second).not.toBe(first);

    const saved = await saveX402Wallet(first, "eip155:8453");
    expect(saved.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(stored).toEqual({ x402: { privateKey: first, network: "eip155:8453" } });
  });
});
