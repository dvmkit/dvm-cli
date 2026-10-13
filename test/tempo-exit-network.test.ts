vi.mock("../src/lib/output", async () => ({ ...(await vi.importActual<typeof import("../src/lib/output")>("../src/lib/output")), json: seams.json }));
import { beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  advanceTempoChannelExit: vi.fn(),
  connectedTempoAccount: vi.fn(),
  json: vi.fn(),
  loadConfig: vi.fn(),
  loadTempoChannelAssociation: vi.fn(),
  resolveSigningIdentity: vi.fn(),
}));

vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
  ...seams,
}));

vi.mock("../src/lib/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/identity")>()),
  loadConfig: seams.loadConfig,
}));
vi.mock("../src/lib/cli-identity-resolve", () => ({ resolveSigningIdentity: seams.resolveSigningIdentity }));
vi.mock("../src/lib/payment-rails/tempo-wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/payment-rails/tempo-wallet")>()),
  connectedTempoAccount: seams.connectedTempoAccount,
}));

import { walletMppExit } from "../src/commands/wallet-mpp";

describe("Tempo channel exit network authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seams.loadConfig.mockReturnValue({});
    seams.resolveSigningIdentity.mockReturnValue({ pubkey: "caller-pubkey" });
    seams.advanceTempoChannelExit.mockResolvedValue({
      status: "closed",
      channelId: `0x${"66".repeat(32)}`,
      channelToken: "0x7777777777777777777777777777777777777777",
      depositMicro: 0,
      settledMicro: 0,
      guaranteedMicro: 0,
      likelyMicro: 0,
    });
  });

  it.each([
    [4217, "moderato"],
    [42431, "mainnet"],
  ] as const)(
    "refuses stored chain %i through a %s wallet before any exit operation",
    async (channelChainId, walletNetwork) => {
      seams.loadTempoChannelAssociation.mockReturnValue(association(channelChainId));
      seams.connectedTempoAccount.mockResolvedValue(account(walletNetwork));

      await expect(
        walletMppExit("https://target.example", { creditId: "credit-1" })
      ).rejects.toMatchObject({
        code: "tempo_channel_network_mismatch",
        data: {
          channel_chain_id: channelChainId,
          wallet_network: walletNetwork,
          transaction_broadcast: false,
        },
      });

      expect(seams.advanceTempoChannelExit).not.toHaveBeenCalled();
    }
  );

  it.each([
    [4217, "mainnet"],
    [42431, "moderato"],
  ] as const)("allows stored chain %i through its matching %s wallet", async (chainId, network) => {
    seams.loadTempoChannelAssociation.mockReturnValue(association(chainId));
    seams.connectedTempoAccount.mockResolvedValue(account(network));

    await walletMppExit("https://target.example", { creditId: "credit-1" });

    expect(seams.advanceTempoChannelExit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ association: expect.objectContaining({ chainId }) })
    );
  });
});

function association(chainId: number) {
  return {
    endpoint: "https://target.example",
    callerPubkey: "caller-pubkey",
    creditId: "credit-1",
    channelKey: "channel-key",
    operator: "0x8888888888888888888888888888888888888888",
    channelId: `0x${"66".repeat(32)}`,
    cumulativeAmount: "0",
    deposit: "0",
    chainId,
    opened: true,
    updatedAt: 1,
  };
}

function account(network: "mainnet" | "moderato") {
  return {
    method: "tempo",
    privateKey: `0x${"99".repeat(32)}`,
    address: "0x9999999999999999999999999999999999999999",
    network,
  };
}
