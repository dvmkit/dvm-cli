import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Sandbox `config.json` to a fresh dir per test by redirecting
// `DVM_CONFIG_DIR` and re-importing the modules that resolve it at module-eval
// time. `DVM_CONFIG_DIR` rather than HOME: the whole run already has
// a `DVM_CONFIG_DIR` sandbox, and the more specific var wins over `homedir()` —
// so overriding HOME alone would silently land every test in the shared
// run-level dir, and the "no config exists" cases would see a neighbouring
// suite's leftovers.
describe("tempo-wallet", () => {
  let originalConfigDir: string | undefined;
  let tmpConfigDir: string;

  beforeEach(() => {
    originalConfigDir = process.env.DVM_CONFIG_DIR;
    tmpConfigDir = mkdtempSync(join(tmpdir(), "tempo-wallet-test-"));
    process.env.DVM_CONFIG_DIR = tmpConfigDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.DVM_CONFIG_DIR;
    else process.env.DVM_CONFIG_DIR = originalConfigDir;
    rmSync(tmpConfigDir, { recursive: true, force: true });
    vi.resetModules();
    // Unconditional, so a failed assertion in a gate case can't leak its
    // `tempo-lifecycle` stand-in into the tests after it. `resetModules` clears
    // the module registry but leaves `doMock` registrations standing.
    vi.doUnmock("../tempo-lifecycle");
  });

  it("connectedTempoAccount returns null when no config exists", async () => {
    const { connectedTempoAccount } = await Promise.all([import("@dvmkit/sdk/internal"), import("../tempo-wallet")]).then(([shared, caller]) => ({ ...shared, ...caller }));
    expect(await connectedTempoAccount()).toBeNull();
  });

  it("connectedTempoAccount returns null when tempo method is not tempo", async () => {
    const { ensureConfig } = await import("../../identity");
    await ensureConfig({ tempo: { method: "stripe", accountId: "pm_abc" } });
    const { connectedTempoAccount } = await Promise.all([import("@dvmkit/sdk/internal"), import("../tempo-wallet")]).then(([shared, caller]) => ({ ...shared, ...caller }));
    expect(await connectedTempoAccount()).toBeNull();
  });

  it("treats an out-of-range stored scalar as no usable Tempo account", async () => {
    const { ensureConfig } = await import("../../identity");
    await ensureConfig({
      tempo: { method: "tempo", apiKey: `0x${"0".repeat(64)}` },
    });
    const { connectedTempoAccount } = await Promise.all([import("@dvmkit/sdk/internal"), import("../tempo-wallet")]).then(([shared, caller]) => ({ ...shared, ...caller }));

    expect(await connectedTempoAccount()).toBeNull();
  });

  it("defaults a pre-network Tempo config to mainnet", async () => {
    const { ensureConfig } = await import("../../identity");
    await ensureConfig({
      tempo: { method: "tempo", apiKey: `0x${"a".repeat(64)}` },
    });
    const { connectedTempoAccount } = await Promise.all([import("@dvmkit/sdk/internal"), import("../tempo-wallet")]).then(([shared, caller]) => ({ ...shared, ...caller }));
    expect((await connectedTempoAccount())?.network).toBe("mainnet");
  });

  it("generateTempoKey produces a fresh keypair, persists it, derives the address", async () => {
    const { ensureConfig } = await import("../../identity");
    await ensureConfig({});
    const { generateTempoKey, connectedTempoAccount } = await Promise.all([import("@dvmkit/sdk/internal"), import("../tempo-wallet")]).then(([shared, caller]) => ({ ...shared, ...caller }));
    const acct = await generateTempoKey();
    expect(acct.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(acct.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(acct.network).toBe("mainnet");

    const reloaded = await connectedTempoAccount();
    expect(reloaded?.privateKey).toBe(acct.privateKey);
    expect(reloaded?.address).toBe(acct.address);
    expect(reloaded?.network).toBe("mainnet");
  });

  it("persists Moderato and resolves its chain, RPC, and default token", async () => {
    const { ensureConfig, loadConfig } = await import("../../identity");
    await ensureConfig({});
    const { generateTempoKey, connectedTempoAccount, resolveTempoNetwork } = await Promise.all([import("@dvmkit/sdk/internal"), import("../tempo-wallet")]).then(([shared, caller]) => ({ ...shared, ...caller }));
    const generated = await generateTempoKey({ network: "moderato" });
    expect(generated.network).toBe("moderato");
    expect(loadConfig()?.tempo?.network).toBe("moderato");
    expect((await connectedTempoAccount())?.network).toBe("moderato");
    expect(resolveTempoNetwork("moderato")).toEqual({
      network: "moderato",
      chainId: 42431,
      rpcUrl: "https://rpc.moderato.tempo.xyz",
      defaultToken: "0x20c0000000000000000000000000000000000000",
    });
  });

  it("generateTempoKey refuses to overwrite an existing Tempo key without --force", async () => {
    const { ensureConfig } = await import("../../identity");
    await ensureConfig({});
    const { generateTempoKey, connectedTempoAccount } = await Promise.all([import("@dvmkit/sdk/internal"), import("../tempo-wallet")]).then(([shared, caller]) => ({ ...shared, ...caller }));
    const first = await generateTempoKey();
    await expect(generateTempoKey()).rejects.toMatchObject({ code: "tempo_wallet_exists" });
    expect((await connectedTempoAccount())?.privateKey).toBe(first.privateKey);
  });

  it("generateTempoKey overwrites with --force once the escrow says the key is idle", async () => {
    const assertTempoWalletIdle = vi.fn(async () => {});
    vi.doMock("../tempo-lifecycle", () => ({ assertTempoWalletIdle }));
    const { ensureConfig } = await import("../../identity");
    await ensureConfig({});
    const { generateTempoKey } = await Promise.all([import("@dvmkit/sdk/internal"), import("../tempo-wallet")]).then(([shared, caller]) => ({ ...shared, ...caller }));
    const first = await generateTempoKey();
    // No key to strand yet, so the first generate never reaches the gate.
    expect(assertTempoWalletIdle).not.toHaveBeenCalled();
    const second = await generateTempoKey({ force: true });
    expect(second.privateKey).not.toBe(first.privateKey);
    expect(assertTempoWalletIdle).toHaveBeenCalledWith("replace");
  });

  // The replacement is the moment the old key stops being reachable, so a
  // channel the escrow still funds has to stop it before the config is written.
  it("generateTempoKey --force keeps the existing key when a channel still holds collateral", async () => {
    const { DvmError } = await import("@dvmkit/sdk/internal");
    vi.doMock("../tempo-lifecycle", () => ({
      assertTempoWalletIdle: vi.fn(() => {
        throw new DvmError("tempo_channels_active", "still holds $2.50 of collateral");
      }),
    }));
    const { ensureConfig } = await import("../../identity");
    await ensureConfig({});
    const { generateTempoKey, connectedTempoAccount } = await Promise.all([import("@dvmkit/sdk/internal"), import("../tempo-wallet")]).then(([shared, caller]) => ({ ...shared, ...caller }));
    const first = await generateTempoKey();

    await expect(generateTempoKey({ force: true })).rejects.toMatchObject({
      code: "tempo_channels_active",
    });

    expect((await connectedTempoAccount())?.privateKey).toBe(first.privateKey);
  });

  it("runs fallible handoff work before persisting the generated key", async () => {
    const { ensureConfig, loadConfig } = await import("../../identity");
    await ensureConfig({});
    const { generateTempoKey } = await Promise.all([import("@dvmkit/sdk/internal"), import("../tempo-wallet")]).then(([shared, caller]) => ({ ...shared, ...caller }));

    await expect(
      generateTempoKey({
        beforePersist: async () => {
          throw new Error("QR destination is not writable");
        },
      })
    ).rejects.toThrow("QR destination is not writable");

    expect(loadConfig()?.tempo).toBeUndefined();
  });

});

// every surface that names the Tempo settlement asset resolves it
// here, so a caller running with DVM_TEMPO_CURRENCY set never reads copy
// that contradicts the contract their wallet is pointed at.
describe("resolveTempoAsset", () => {

  // the server's DVMKIT_TEMPO_CURRENCY is a different audience's
  // variable and was cut over with no alias, so it must not be read here — a
  // re-introduced fallback would silently point a caller at a DVM's asset.

  it("wrong-asset hint names what the rail accepts and the swap remedy", async () => {
    const { resolveTempoAsset, tempoWrongAssetHint } = await Promise.all([import("@dvmkit/sdk/internal"), import("../tempo-wallet")]).then(([shared, caller]) => ({ ...shared, ...caller }));
    const hint = tempoWrongAssetHint(resolveTempoAsset({}));
    expect(hint).toContain("USDC.e");
    expect(hint).toContain("0x20C000000000000000000000b9537d11c60E8b50");
    expect(hint).toContain("USDT0");
    expect(hint).toMatch(/swap/i);
  });

  it("wrong-asset hint tracks an override rather than printing a stale USDC.e", async () => {
    const { resolveTempoAsset, tempoWrongAssetHint } = await Promise.all([import("@dvmkit/sdk/internal"), import("../tempo-wallet")]).then(([shared, caller]) => ({ ...shared, ...caller }));
    const other = "0x" + "2".repeat(40);
    const hint = tempoWrongAssetHint(resolveTempoAsset({ DVM_TEMPO_CURRENCY: other }));
    expect(hint).toContain(other);
    expect(hint).not.toContain("USDC.e");
  });
});
