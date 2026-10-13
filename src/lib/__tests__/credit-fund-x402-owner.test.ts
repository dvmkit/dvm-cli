vi.mock("../x402/wallet", async () => ({ ...(await vi.importActual<typeof import("../x402/wallet")>("../x402/wallet")), loadX402Wallet: vi.fn(() => ({
    privateKey: `0x${"11".repeat(32)}`,
    address: "",
    network: "eip155:84532",
  })) }));
vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
  loadX402Wallet: vi.fn(() => ({
    privateKey: `0x${"11".repeat(32)}`,
    address: "",
    network: "eip155:84532",
  })),
}));
import type { PaymentRequired } from "@dvmkit/sdk/internal";
import { computeChannelId } from "@x402/evm/batch-settlement/client";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, it, vi } from "vitest";

vi.mock("../btc-rate", () => ({
  tryResolveBtcUsdRate: vi.fn(() => Promise.resolve({ rate: 100_000, stale: false })),
}));
vi.mock("../budget-ledger", () => ({
  enforceGlobalBudget: vi.fn(() => Promise.resolve(100_000)),
  recordSpend: vi.fn(),
  recordSpendOnce: vi.fn(),
}));

import { fundCredit } from "../credit-fund";
import { DvmError } from "@dvmkit/sdk/internal";
import type { CreditMenu, Transport } from "@dvmkit/sdk/internal";
import {
  DvmX402ChannelStorage,
  findX402Channel,
  listPendingX402FundingsForChannel,
  listX402Channels,
  recordX402ChannelMetadata,
  x402PendingRetired,
} from "@dvmkit/sdk/internal";

it("keeps the acknowledged channel association after a submitted cross-credit refusal", async () => {
  const key = `0x${"11".repeat(32)}` as `0x${string}`;
  const account = privateKeyToAccount(key);
  const network = "eip155:84532";
  const token = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
  const receiver = `0x${"22".repeat(20)}` as `0x${string}`;
  const receiverAuthorizer = `0x${"33".repeat(20)}` as `0x${string}`;
  const config = {
    payer: account.address,
    payerAuthorizer: account.address,
    receiver,
    receiverAuthorizer,
    token,
    withdrawDelay: 86_400,
    salt: keccak256(toBytes(`dvmkit:x402-batch:${network}:${account.address.toLowerCase()}`)),
  };
  const channelId = computeChannelId(config, network);
  const owner = {
    channelId,
    endpoint: "https://owner.example",
    callerPubkey: "aa".repeat(32),
    creditId: "credit-a",
    network,
    config,
    updatedAt: 1,
  };
  recordX402ChannelMetadata(owner);
  await new DvmX402ChannelStorage().set(channelId, {
    balance: "0",
    totalClaimed: "0",
    chargedCumulativeAmount: "0",
  });

  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: { url: "https://attempt.example/v1/credit" },
    accepts: [
      {
        scheme: "batch-settlement",
        network,
        asset: token,
        amount: "200000",
        payTo: receiver,
        maxTimeoutSeconds: 60,
        extra: {
          receiverAuthorizer,
          withdrawDelay: 86_400,
          name: "x402 Batch Settlement",
          version: "1",
          assetTransferMethod: "eip3009",
        },
      },
    ],
  };
  const credit = vi
    .fn()
    .mockRejectedValueOnce(
      new DvmError("payment_required", "Channel payment required.", undefined, {
        x402_payment_required: paymentRequired,
      })
    )
    .mockRejectedValueOnce(
      new DvmError(
        "payment_invalid",
        `x402 channel ${channelId} is already bound to credit credit-a; it cannot fund credit-b.`,
        undefined,
        {
          credit_rail: "x402",
          credit_instrument: "x402_channel",
          credit_channel_id: channelId,
          bound_credit_id: "credit-a",
          retryable: false,
        }
      )
    );
  const menu: CreditMenu = {
    min_micro: 10_000,
    max_micro: 5_000_000,
    ttl_ms: 60_000,
    currency: "usd",
    funding: ["x402"],
    x402: { schemes: [{ scheme: "batch-settlement", network }] },
  };

  const outcome = await fundCredit({
    transport: { credit } as unknown as Transport,
    ref: { endpoint: "https://attempt.example" },
    signing: { privkey: "bb".repeat(32), pubkey: "cc".repeat(32) },
    creditId: "credit-b",
    fundId: "fund-b",
    amountMicro: 200_000,
    targetMicro: 200_000,
    maxDepositMicro: 200_000,
    menu,
    providerInfo: {},
    rail: "x402",
    float: null,
    tempoAccount: null,
    signBody: (_privkey, body) => body,
  });

  expect(outcome).toMatchObject({ status: "refused", error: { code: "payment_invalid" } });
  expect(credit).toHaveBeenCalledTimes(2);
  expect(credit.mock.calls[1]?.[2]).toMatchObject({
    x402Payment: expect.any(String),
    x402Version: 2,
  });
  expect(findX402Channel({ channelId })).toEqual(owner);
  expect(
    findX402Channel({
      endpoint: "https://owner.example",
      callerPubkey: owner.callerPubkey,
      creditId: owner.creditId,
    })
  ).toEqual(owner);
  expect(
    findX402Channel({ endpoint: "https://attempt.example", creditId: "credit-b" })
  ).toBeUndefined();
  expect(listX402Channels()[0]).toEqual(owner);

  const journal = listPendingX402FundingsForChannel(channelId);
  expect(journal).toHaveLength(1);
  expect(journal[0]).toMatchObject({
    endpoint: "https://attempt.example",
    callerPubkey: "cc".repeat(32),
    creditId: "credit-b",
    fundId: "fund-b",
    maxClaimableMicro: "200000",
    depositMicro: "200000",
    authorizationValidBefore: expect.any(String),
    refusedAt: expect.any(Number),
  });
  expect(x402PendingRetired(journal[0])).toBe(true);
});
