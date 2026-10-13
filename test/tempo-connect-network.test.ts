import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({ json: vi.fn() }));

vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()) }));
vi.mock("../src/lib/output", async () => ({ ...(await vi.importActual<typeof import("../src/lib/output")>("../src/lib/output")), json: seams.json }));

vi.mock("../src/lib/funding-handoff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/funding-handoff")>()),
  prepareStablecoinFundingHandoff: vi.fn(async ({ address }: { address: string }) => ({
    address,
    qrPayload: address,
    qrImagePath: "/tmp/tempo-test-qr.png",
    relay: { copy_text: address, standalone: true as const },
  })),
}));

let configRoot: string;
let originalConfigRoot: string | undefined;
let ensureConfig: typeof import("../src/lib/identity")["ensureConfig"];
let connectedTempoAccount: typeof import("../src/lib/payment-rails/tempo-wallet")["connectedTempoAccount"];
let walletMppConnect: (typeof import("../src/commands/wallet-mpp"))["walletMppConnect"];

describe("dvm wallet tempo-connect network persistence", () => {
  beforeAll(async () => {
    configRoot = mkdtempSync(join(tmpdir(), "dvm-cli-tempo-network-"));
    originalConfigRoot = process.env.DVM_CONFIG_DIR;
    process.env.DVM_CONFIG_DIR = configRoot;
    delete process.env.DVM_TEMPO_NETWORK;
    vi.resetModules();
    ({ ensureConfig } = await import("../src/lib/identity"));
    ({ connectedTempoAccount } = await import("../src/lib/payment-rails/tempo-wallet"));
    ({ walletMppConnect } = await import("../src/commands/wallet-mpp"));
  });

  beforeEach(async () => {
    rmSync(configRoot, { recursive: true, force: true });
    mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    await ensureConfig({}, "tempo_network_test");
    seams.json.mockClear();
    delete process.env.DVM_TEMPO_NETWORK;
  });

  afterAll(() => {
    rmSync(configRoot, { recursive: true, force: true });
    if (originalConfigRoot === undefined) delete process.env.DVM_CONFIG_DIR;
    else process.env.DVM_CONFIG_DIR = originalConfigRoot;
  });

  it("persists Moderato and reports its exact network fields", async () => {
    await walletMppConnect("tempo", { network: "moderato" });

    expect(await connectedTempoAccount()).toMatchObject({ network: "moderato" });
    expect(readConfig()).toMatchObject({ tempo: { method: "tempo", network: "moderato" } });
    expect(seams.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "connected",
        network: "moderato",
        network_label: "Tempo Testnet (Moderato)",
        chain_id: 42431,
        hint: expect.stringContaining("faucet reports the test amount actually observed"),
      })
    );
  });

  it("defaults a newly generated wallet to mainnet", async () => {
    await walletMppConnect("tempo", {});

    expect(await connectedTempoAccount()).toMatchObject({ network: "mainnet" });
    expect(readConfig()).toMatchObject({ tempo: { method: "tempo", network: "mainnet" } });
    expect(seams.json).toHaveBeenCalledWith(
      expect.objectContaining({ network: "mainnet", chain_id: 4217 })
    );
  });
});

function readConfig(): unknown {
  return JSON.parse(readFileSync(join(configRoot, "config.json"), "utf8"));
}
