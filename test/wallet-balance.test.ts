vi.mock("../src/lib/wallet-probe", async () => ({ ...(await vi.importActual<typeof import("../src/lib/wallet-probe")>("../src/lib/wallet-probe")), probeWallets: seams.probeWallets }));
vi.mock("../src/lib/payment-rails/tempo-wallet", async () => ({ ...(await vi.importActual<typeof import("../src/lib/payment-rails/tempo-wallet")>("../src/lib/payment-rails/tempo-wallet")), connectedTempoAccount: seams.connectedTempoAccount }));
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  assertTempoBalanceRpcNetwork: vi.fn(),
  connectedTempoAccount: vi.fn(),
  info: vi.fn(),
  json: vi.fn(),
  probeWallets: vi.fn(),
}));

vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
connectedTempoAccount: seams.connectedTempoAccount,
probeWallets: seams.probeWallets }));
vi.mock("../src/lib/output", async () => ({ ...(await vi.importActual<typeof import("../src/lib/output")>("../src/lib/output")), info: seams.info,
json: seams.json }));

vi.mock("../src/lib/tempo-rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/tempo-rpc")>()),
  assertTempoBalanceRpcNetwork: seams.assertTempoBalanceRpcNetwork,
}));

let configRoot: string;
let originalConfigRoot: string | undefined;
let walletInit: (typeof import("../src/commands/wallet-agent"))["walletInit"];
let walletBalance: (typeof import("../src/commands/wallet"))["walletBalance"];

describe("dvm wallet balance with an initialized Cashu wallet", () => {
  beforeAll(async () => {
    configRoot = mkdtempSync(join(tmpdir(), "dvm-cli-wallet-balance-"));
    originalConfigRoot = process.env.DVM_CONFIG_DIR;
    process.env.DVM_CONFIG_DIR = configRoot;
    vi.resetModules();
    ({ walletInit } = await import("../src/commands/wallet-agent"));
    ({ walletBalance } = await import("../src/commands/wallet"));
  });

  beforeEach(() => {
    rmSync(configRoot, { recursive: true, force: true });
    mkdirSync(configRoot, { recursive: true });
    vi.clearAllMocks();
    seams.connectedTempoAccount.mockResolvedValue(null);
    seams.assertTempoBalanceRpcNetwork.mockResolvedValue(undefined);
    seams.probeWallets.mockResolvedValue({
      walletType: null,
      rate: null,
      rails: [],
      totalLnAndCashuMsats: 0,
      cashuMints: [],
    });
  });

  afterAll(() => {
    rmSync(configRoot, { recursive: true, force: true });
    if (originalConfigRoot === undefined) delete process.env.DVM_CONFIG_DIR;
    else process.env.DVM_CONFIG_DIR = originalConfigRoot;
  });

  it("reports zero balance and the first-mint action after wallet init", async () => {
    await walletInit({});
    seams.json.mockClear();

    await walletBalance({});

    expect(seams.json).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        walletType: "cashu",
        cashu: {
          totalMsats: 0,
          byMint: {},
          hint: "Add one with: dvm wallet mint-add <url>",
        },
        fundingOptions: expect.arrayContaining([
          expect.objectContaining({
            method: "cashu-add-mint",
            command: "dvm wallet mint-add <url>",
          }),
        ]),
      })
    );
  });

  it("prints the zero balance and mint-add hint in human mode", async () => {
    await walletInit({});
    seams.info.mockClear();

    await walletBalance({ human: true });

    const lines = seams.info.mock.calls.flat();
    expect(lines).toContain("  ↳ Add one with: dvm wallet mint-add <url>");
    expect(lines.some((line) => typeof line === "string" && line.includes("0 sats"))).toBe(true);
  });

  it("reserves wallet_missing for an absent agent wallet", async () => {
    await expect(walletBalance({})).rejects.toMatchObject({
      code: "wallet_missing",
      message: "No agent wallet found.",
      hint: "Run `dvm wallet init` first to generate a lock keypair.",
    });
  });

  it("refuses a wrong-chain Tempo RPC before any wallet balance probe", async () => {
    seams.connectedTempoAccount.mockResolvedValue({
      method: "tempo",
      privateKey: `0x${"44".repeat(32)}`,
      address: "0x4444444444444444444444444444444444444444",
      network: "moderato",
    });
    seams.assertTempoBalanceRpcNetwork.mockRejectedValue(
      Object.assign(new Error("wrong Tempo chain"), { code: "tempo_rpc_network_mismatch" })
    );

    await expect(walletBalance({})).rejects.toMatchObject({ code: "tempo_rpc_network_mismatch" });
    expect(seams.probeWallets).not.toHaveBeenCalled();
  });
});
