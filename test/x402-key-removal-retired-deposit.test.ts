import { mkdirSync, rmSync } from "node:fs";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { isBatchSettlementDepositPayload } from "@x402/evm";
import { computeChannelId } from "@x402/evm/batch-settlement/client";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createX402BatchPayment,
  DvmX402ChannelStorage,
  recordPendingX402Funding,
  recordX402ChannelMetadata,
  retirePendingX402Funding,
} from "@dvmkit/sdk/internal";

const chain = vi.hoisted(() => ({
  getBlock: vi.fn(), getChainId: vi.fn(), readContract: vi.fn(),
}));
vi.mock("viem", async (original) => ({
  ...await original<typeof import("viem")>(),
  createPublicClient: () => ({
    getBlock: chain.getBlock, getChainId: chain.getChainId, readContract: chain.readContract,
  }),
}));
vi.mock("../src/lib/x402/wallet", async (original) => ({
  ...await original<typeof import("../src/lib/x402/wallet")>(),
  loadX402Wallet: vi.fn(),
}));
vi.mock("../src/lib/output", async (original) => ({
  ...await original<typeof import("../src/lib/output")>(),
  json: vi.fn(),
}));

import { configRollback } from "../src/commands/config";
import { walletX402Disconnect } from "../src/commands/wallet-x402";
import { ensureConfig, loadConfig, updateConfig } from "../src/lib/identity";
import { loadX402Wallet } from "../src/lib/x402/wallet";

const root = process.env.DVM_CONFIG_DIR!;
const endpoint = "https://provider.example";
const key = `0x${"11".repeat(32)}` as const;
const account = privateKeyToAccount(key);
const network = "eip155:84532";
const wallet = { privateKey: key, address: account.address, network };
const config = {
  payer: account.address,
  payerAuthorizer: account.address,
  receiver: `0x${"22".repeat(20)}` as const,
  receiverAuthorizer: `0x${"33".repeat(20)}` as const,
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const,
  withdrawDelay: 86_400,
  salt: keccak256(toBytes(`dvmkit:x402-batch:${network}:${account.address.toLowerCase()}`)),
};
const channelId = computeChannelId(config, network);
const finalizedHash = `0x${"ab".repeat(32)}`;
const terms: PaymentRequired & { x402Version: 2 } = {
  x402Version: 2,
  resource: { url: `${endpoint}/v1/credit` },
  accepts: [{
    scheme: "batch-settlement", network, asset: config.token, amount: "200000",
    payTo: config.receiver, maxTimeoutSeconds: 60,
    extra: {
      receiverAuthorizer: config.receiverAuthorizer, withdrawDelay: config.withdrawDelay,
      name: "x402 Batch Settlement", version: "1", assetTransferMethod: "eip3009",
    },
  }],
};

/** Journal a refused deposit and put the local clock past its signed deadline. */
async function retiredDeposit() {
  const scope = { endpoint, callerPubkey: "66".repeat(32), creditId: "credit-1" };
  mockChain(0n);
  const payment = await createX402BatchPayment({
    wallet, paymentRequired: terms, ...scope, depositMicro: 200_000,
  });
  const pending = {
    ...scope, channelId: payment.channelId, paymentHeader: payment.paymentHeader,
    fundId: "fund-1", amountMicro: 200_000, targetMicro: 200_000, requestedAt: Date.now(),
    maxClaimableMicro: payment.maxClaimableMicro,
    depositMicro: payment.depositMicro,
    authorizationValidBefore: payment.authorizationValidBefore,
  };
  recordPendingX402Funding(pending);
  retirePendingX402Funding(pending);
  const { payload } = decodePaymentSignatureHeader(payment.paymentHeader);
  if (!isBatchSettlementDepositPayload(payload)) throw new Error("Expected a signed deposit");
  const deadline = BigInt(payload.deposit.authorization.erc3009Authorization!.validBefore);
  vi.spyOn(Date, "now").mockReturnValue(Number(deadline + 2n) * 1000);
  return deadline;
}

/** What the RPC says; `escrow` is the channel's current balance. */
function mockChain(finalizedTimestamp: bigint, state: { consumed?: boolean; escrow?: bigint } = {}) {
  chain.getChainId.mockResolvedValue(84532);
  chain.getBlock.mockResolvedValue({ hash: finalizedHash, number: 123n, timestamp: finalizedTimestamp });
  chain.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "authorizationState") return state.consumed ?? false;
    if (functionName === "channels") return [state.escrow ?? 0n, 0n];
    if (functionName === "pendingWithdrawals") return [0n, 0n];
    throw new Error(`Unexpected contract read: ${functionName}`);
  });
}

beforeEach(async () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  vi.mocked(loadX402Wallet).mockReturnValue(wallet);
  chain.getBlock.mockReset();
  chain.getChainId.mockReset();
  chain.readContract.mockReset();
  recordX402ChannelMetadata({
    channelId, endpoint, callerPubkey: "66".repeat(32), creditId: "credit-1", network, config,
    updatedAt: 1,
  });
  await new DvmX402ChannelStorage().set(channelId, {
    balance: "0", totalClaimed: "0", chargedCumulativeAmount: "0",
  });
  await ensureConfig({ defaultBudget: "$1" });
  await updateConfig({
    reason: "key_removal_test",
    patch: () => ({ set: { x402: { privateKey: key, network } } }),
  });
});

describe("removing the x402 key with a retired deposit", () => {
  it.each([
    { name: "the finalized chain is still before the deadline", block: (deadline: bigint) => deadline - 1n },
    { name: "the finalized chain is exactly at the deadline", block: (deadline: bigint) => deadline },
  ])("disconnect keeps the key when the local clock is past the deadline but $name", async ({ block }) => {
    mockChain(block(await retiredDeposit()));

    await expect(walletX402Disconnect({})).rejects.toMatchObject({ code: "x402_pending_fundings" });

    expect(loadConfig()?.x402?.privateKey).toBe(key);
  });

  it.each([
    { name: "the finalized block is unavailable", setup: () => chain.getBlock.mockRejectedValue(new Error("rpc down")) },
    { name: "the nonce cannot be read", setup: () => chain.readContract.mockRejectedValue(new Error("rpc down")) },
    { name: "the RPC is on another chain", setup: () => chain.getChainId.mockResolvedValue(1) },
  ])("disconnect keeps the key when $name", async ({ setup }) => {
    mockChain((await retiredDeposit()) + 1n);
    setup();

    await expect(walletX402Disconnect({})).rejects.toMatchObject({ code: "x402_pending_fundings" });

    expect(loadConfig()?.x402?.privateKey).toBe(key);
  });

  it("config restore keeps the key under the same unproven deposit", async () => {
    mockChain((await retiredDeposit()) - 1n);

    await expect(configRollback({ slot: "backup", yes: true })).rejects.toMatchObject({
      code: "x402_pending_fundings",
    });

    expect(loadConfig()?.x402?.privateKey).toBe(key);
  });

  it("removes the key once a finalized block past the deadline shows the deposit unused", async () => {
    mockChain((await retiredDeposit()) + 1n);

    await walletX402Disconnect({});

    expect(loadConfig()?.x402).toBeUndefined();
  });

  it("config restore removes the key once the deposit is proven unused", async () => {
    mockChain((await retiredDeposit()) + 1n);

    await configRollback({ slot: "backup", yes: true });

    expect(loadConfig()?.x402).toBeUndefined();
  });

  it("sends a consumed deposit to the escrow check instead of the pending hold", async () => {
    mockChain((await retiredDeposit()) + 1n, { consumed: true, escrow: 200_000n });

    await expect(walletX402Disconnect({})).rejects.toMatchObject({ code: "x402_wallet_in_use" });

    expect(loadConfig()?.x402?.privateKey).toBe(key);
  });

  it("lets --with-pending proceed past an unproven deposit", async () => {
    mockChain((await retiredDeposit()) - 1n);

    await walletX402Disconnect({ withPending: true });

    expect(loadConfig()?.x402).toBeUndefined();
  });
});
