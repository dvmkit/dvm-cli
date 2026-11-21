import { recordX402ChannelMetadata } from "@dvmkit/sdk/internal";
import { computeChannelId } from "@x402/evm/batch-settlement/client";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { walletX402WithdrawFinalize } from "../src/commands/wallet-x402";
import { catchErrors } from "../src/lib/error-handler";
import { json } from "../src/lib/output";
import { loadX402Wallet } from "../src/lib/x402/wallet";

const rpc = vi.hoisted(() => ({
  getBalance: vi.fn(),
  getBlock: vi.fn(),
  readContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  writeContract: vi.fn(),
}));

vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => ({
    getBalance: rpc.getBalance,
    getBlock: rpc.getBlock,
    readContract: rpc.readContract,
    waitForTransactionReceipt: rpc.waitForTransactionReceipt,
  }),
  createWalletClient: ({ chain }: { chain: unknown }) => ({ chain, writeContract: rpc.writeContract }),
}));

vi.mock("../src/lib/output", async (original) => ({
  ...(await original<typeof import("../src/lib/output")>()),
  json: vi.fn(),
}));

vi.mock("../src/lib/x402/wallet", async (original) => ({
  ...(await original<typeof import("../src/lib/x402/wallet")>()),
  loadX402Wallet: vi.fn(),
}));

const privateKey = `0x${"11".repeat(32)}` as const;
const { address } = privateKeyToAccount(privateKey);
const network = "eip155:84532";
const config = {
  payer: address,
  payerAuthorizer: address,
  receiver: `0x${"22".repeat(20)}` as const,
  receiverAuthorizer: `0x${"33".repeat(20)}` as const,
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const,
  withdrawDelay: 86_400,
  salt: `0x${"44".repeat(32)}` as const,
};
const channelId = computeChannelId(config, network);
const pendingAt = Date.parse("2025-01-01T00:00:00.000Z") / 1000;
const readyAtIso = "2025-01-02T00:00:00.000Z";
const readyAt = Date.parse(readyAtIso) / 1000;
const hash = `0x${"55".repeat(32)}`;

describe("x402 timed withdrawal finalization", () => {
  beforeEach(() => {
    vi.mocked(loadX402Wallet).mockReturnValue({ privateKey, address, network });
    recordX402ChannelMetadata({
      channelId, network, config, endpoint: "https://provider.example",
      callerPubkey: "66".repeat(32), creditId: "credit-1", updatedAt: pendingAt * 1000,
    });
    rpc.getBlock.mockReset();
    rpc.getBalance.mockResolvedValue(1n);
    rpc.readContract.mockImplementation(async ({ functionName }) => {
      if (functionName === "pendingWithdrawals") return [1_000_000n, pendingAt];
      if (functionName === "channels") return [1_000_000n, 0n];
      throw new Error(`Unexpected contract read: ${functionName}`);
    });
    rpc.writeContract.mockResolvedValue(hash);
    rpc.waitForTransactionReceipt.mockResolvedValue({ status: "success", logs: [] });
  });

  it("refuses before the chain deadline even when the local clock is ahead", async () => {
    vi.spyOn(Date, "now").mockReturnValue((readyAt + 1) * 1000);
    rpc.getBlock.mockResolvedValue({ timestamp: BigInt(readyAt - 1) });
    vi.spyOn(process, "exit").mockImplementation((code) => { throw new Error(`Exit ${code}`); });

    await expect(catchErrors(() => walletX402WithdrawFinalize({ channelId }))).rejects.toThrow("Exit 1");

    expect(json).toHaveBeenCalledExactlyOnceWith({
      error: expect.objectContaining({
        code: "x402_withdrawal_not_ready",
        channel_id: channelId,
        ready_at: readyAtIso,
      }),
    });
    expect(rpc.writeContract).not.toHaveBeenCalled();
  });

  it.each([["at", 0], ["after", 1]] as const)(
    "finalizes %s the chain deadline even when the local clock is behind",
    async (_when, offset) => {
      vi.spyOn(Date, "now").mockReturnValue((readyAt - 1) * 1000);
      rpc.getBlock.mockResolvedValue({ timestamp: BigInt(readyAt + offset) });

      await walletX402WithdrawFinalize({ channelId });

      expect(rpc.getBlock).toHaveBeenCalledExactlyOnceWith({ blockTag: "latest" });
      expect(rpc.writeContract).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        functionName: "finalizeWithdraw",
        args: [config],
      }));
      expect(json).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        status: "finalized",
        transaction: hash,
      }));
    }
  );

  it.each(["the RPC rejects", "the timestamp is absent"])(
    "returns a chain-read error without submitting when %s",
    async (failure) => {
      vi.spyOn(Date, "now").mockReturnValue((readyAt + 1) * 1000);
      if (failure === "the RPC rejects") rpc.getBlock.mockRejectedValue(new Error("RPC unavailable"));
      else rpc.getBlock.mockResolvedValue({});

      await expect(walletX402WithdrawFinalize({ channelId })).rejects.toMatchObject({
        code: "x402_rpc_error",
        data: { channel_id: channelId },
      });
      expect(rpc.writeContract).not.toHaveBeenCalled();
    }
  );
});
