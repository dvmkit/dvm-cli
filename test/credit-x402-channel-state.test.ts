import { mkdirSync, rmSync } from "node:fs";
import { decodePaymentSignatureHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { computeChannelId } from "@x402/evm/batch-settlement/client";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createX402BatchPayment,
  deriveIdentityFromPrivkey,
  DvmError,
  DvmX402ChannelStorage,
  listPendingX402FundingsForChannel,
  loadCredit,
  recordFundResponse,
  recordPendingX402Funding,
  recordX402ChannelMetadata,
  type CreditMenu,
  type CreditOpResult,
  type ProviderInfo,
  type Transport,
} from "@dvmkit/sdk/internal";

const external = vi.hoisted(() => ({
  credit: vi.fn(), describe: vi.fn(), close: vi.fn(), readContract: vi.fn(),
}));
vi.mock("viem", async (original) => ({
  ...await original<typeof import("viem")>(),
  createPublicClient: () => ({ readContract: external.readContract }),
}));
vi.mock("../src/lib/transport", () => ({ createDvmTransport: () => external }));
vi.mock("../src/lib/x402/wallet", async (original) => ({
  ...await original<typeof import("../src/lib/x402/wallet")>(),
  loadX402Wallet: vi.fn(),
}));
vi.mock("../src/lib/btc-rate", () => ({
  tryResolveBtcUsdRate: () => Promise.resolve({ rate: 100_000, stale: false }),
}));
vi.mock("../src/lib/budget-ledger", () => ({
  enforceGlobalBudget: () => Promise.resolve(100_000),
  recordSpendOnce: vi.fn(),
}));
vi.mock("../src/commands/credit/render", async (original) => ({
  ...await original<typeof import("../src/commands/credit/render")>(),
  renderCreditDrain: vi.fn(),
}));

import { renderCreditDrain } from "../src/commands/credit/render";
import { fundCredit } from "../src/lib/credit-fund";
import { runCreditDrain } from "../src/lib/credit/drain";
import { loadX402Wallet } from "../src/lib/x402/wallet";

const endpoint = "https://provider.example";
const signer = deriveIdentityFromPrivkey("bb".repeat(32));
const key = `0x${"11".repeat(32)}` as const;
const account = privateKeyToAccount(key);
const network = "eip155:84532";
const wallet = { privateKey: key, address: account.address, network };
const creditId = "credit-1";
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
const otherChannelId = computeChannelId({ ...config, receiver: `0x${"44".repeat(20)}` }, network);
const storage = new DvmX402ChannelStorage();
const root = process.env.DVM_CONFIG_DIR!;
const menu: CreditMenu = {
  min_micro: 10_000, max_micro: 5_000_000, ttl_ms: 60_000, currency: "usd",
  funding: ["x402"], x402: { schemes: [{ scheme: "batch-settlement", network }] },
};
const provider = {
  name: "Test provider",
  capabilities: {},
  auth: ["secp256k1-schnorr-v2"],
  authAudience: { dvm_id: "test-provider", builder_pubkey: "03".repeat(32) },
  credit: menu,
} as ProviderInfo;

function required(amount: string): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: `${endpoint}/v1/credit` },
    accepts: [{
      scheme: "batch-settlement", network, asset: config.token, amount,
      payTo: config.receiver, maxTimeoutSeconds: 60,
      extra: {
        receiverAuthorizer: config.receiverAuthorizer, withdrawDelay: config.withdrawDelay,
        name: "x402 Batch Settlement", version: "1", assetTransferMethod: "eip3009",
      },
    }],
  };
}

function challenge(amount: string): DvmError {
  return new DvmError("payment_required", "Channel approval required.", undefined, {
    x402_payment_required: required(amount),
  });
}

function credit(remaining: number): NonNullable<CreditOpResult["credit"]> {
  return {
    credit_id: creditId, currency: "usd", balance_micro: remaining, remaining_micro: remaining,
    expiry_ms: Date.now() + 60_000, expired: false, drainable: true, ledger_seq: 7,
  };
}

function response(state: Record<string, string>): string {
  return encodePaymentResponseHeader({
    success: true, transaction: "0xsettled", network, payer: account.address,
    extra: { channelState: state },
  });
}

beforeEach(async () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  vi.mocked(loadX402Wallet).mockReturnValue(wallet);
  external.credit.mockReset();
  external.describe.mockResolvedValue(provider);
  external.readContract.mockResolvedValue([200_000n, 10_000n]);
  vi.stubEnv("DVM_IDENTITY_KEY", signer.privkey);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected live request"))));
  recordX402ChannelMetadata({
    channelId, endpoint, callerPubkey: signer.pubkey, creditId, network, config, updatedAt: 1,
  });
  recordX402ChannelMetadata({
    channelId: otherChannelId, endpoint: "https://other.example", callerPubkey: signer.pubkey,
    creditId: "other-credit", network, config: { ...config, receiver: `0x${"44".repeat(20)}` },
    updatedAt: 1,
  });
  await storage.set(channelId, { balance: "0", totalClaimed: "0", chargedCumulativeAmount: "0" });
  await storage.set(otherChannelId, {
    balance: "900000", totalClaimed: "30000", chargedCumulativeAmount: "50000",
  });
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe.each(["fresh", "resumed"] as const)("%s x402 credit funding", (path) => {
  async function fund(state: Record<string, string>) {
    if (path === "resumed") {
      // Persist a real signed payment, then let fundCredit recreate its response scheme.
      const payment = await createX402BatchPayment({
        wallet, paymentRequired: required("200000"), endpoint, callerPubkey: signer.pubkey,
        creditId, depositMicro: 200_000,
      });
      recordPendingX402Funding({
        endpoint, callerPubkey: signer.pubkey, creditId, fundId: "fund-original",
        amountMicro: 200_000, targetMicro: 200_000, paymentHeader: payment.paymentHeader,
        channelId: payment.channelId, maxClaimableMicro: payment.maxClaimableMicro,
        depositMicro: payment.depositMicro, authorizationValidBefore: payment.authorizationValidBefore,
        requestedAt: Date.now(),
      });
    } else {
      external.credit.mockRejectedValueOnce(challenge("200000"));
    }
    external.credit.mockResolvedValueOnce({
      op: "fund", funded_micro: 200_000, credit: credit(200_000),
      x402PaymentResponse: response(state),
    });
    const outcome = await fundCredit({
      transport: external as unknown as Transport, ref: { endpoint }, signing: signer,
      creditId, fundId: "fund-new", amountMicro: 200_000, targetMicro: 200_000,
      maxDepositMicro: 200_000, menu, providerInfo: provider, rail: "x402",
      float: null, tempoAccount: null, signBody: (_key, body) => body,
    });
    expect(outcome).toMatchObject({ status: "funded", fundedMicro: 200_000 });
    expect(loadCredit(endpoint, signer.pubkey)).toMatchObject({ remainingMicro: 200_000 });
    expect(listPendingX402FundingsForChannel(channelId)).toEqual([]);
    const submitted = external.credit.mock.calls.at(-1)?.[2]?.x402Payment;
    expect(decodePaymentSignatureHeader(submitted).payload).toMatchObject({
      voucher: { channelId },
    });
    expect(external.credit).toHaveBeenCalledTimes(path === "fresh" ? 2 : 1);
  }

  it("leaves another stored channel unchanged when the answer names it", async () => {
    const before = await storage.get(otherChannelId);
    await fund({
      channelId: otherChannelId, balance: "123", totalClaimed: "10", chargedCumulativeAmount: "20",
    });
    await expect(storage.get(otherChannelId)).resolves.toEqual(before);
  });

  it("advances the paid channel when the answer matches", async () => {
    await fund({ channelId, balance: "200000", totalClaimed: "10000", chargedCumulativeAmount: "20000" });
    await expect(storage.get(channelId)).resolves.toMatchObject({
      balance: "200000", totalClaimed: "10000", chargedCumulativeAmount: "20000",
    });
  });

  it("accepts uint256's inclusive maximum for channel amounts", async () => {
    const maximum = (2n ** 256n - 1n).toString();
    await fund({ channelId, balance: maximum, totalClaimed: maximum, chargedCumulativeAmount: maximum });
    await expect(storage.get(channelId)).resolves.toMatchObject({
      balance: maximum, totalClaimed: maximum, chargedCumulativeAmount: maximum,
    });
  });

  it.each(["balance", "totalClaimed", "chargedCumulativeAmount"])("drops %s past uint256 without failing accepted funding", async (field) => {
    await fund({
      channelId, balance: "200000", totalClaimed: "10000", chargedCumulativeAmount: "20000",
      [field]: (2n ** 256n).toString(),
    });
    await expect(storage.get(channelId)).resolves.toMatchObject({
      balance: "0", totalClaimed: "0", chargedCumulativeAmount: "0",
    });
  });
});

describe("cooperative x402 credit refund", () => {
  async function drain(state: Record<string, string>) {
    recordFundResponse({
      endpoint, callerPubkey: signer.pubkey, credit: credit(190_000), targetMicro: 200_000,
      rail: "x402", x402Instrument: "x402_channel",
    });
    external.credit.mockRejectedValueOnce(challenge("0")).mockResolvedValueOnce({
      op: "drain", credit: credit(0),
      drain: {
        drain_id: "drain-1", credit_id: creditId, method: "x402", status: "sent",
        amount_micro: 190_000, currency: "usd", ledger_seq: 8, created_at: 1, receipts: [],
      },
      x402PaymentResponse: response(state),
    });
    await runCreditDrain(endpoint, { creditId, drainId: "drain-1", method: "x402" });
    expect(renderCreditDrain).toHaveBeenCalledWith(expect.objectContaining({
      json: expect.objectContaining({ drain: expect.objectContaining({ status: "sent" }) }),
    }));
    expect(external.credit).toHaveBeenCalledTimes(2);
    expect(decodePaymentSignatureHeader(external.credit.mock.calls[1][2].x402Payment).payload).toMatchObject({
      type: "refund", voucher: { channelId },
    });
  }

  it("preserves another channel when a zero-balance answer would delete it", async () => {
    const before = await storage.get(otherChannelId);
    await drain({ channelId: otherChannelId, balance: "0", totalClaimed: "0", chargedCumulativeAmount: "0" });
    await expect(storage.get(otherChannelId)).resolves.toEqual(before);
  });

  it("retires only the paid channel when the refund answer matches", async () => {
    const before = await storage.get(otherChannelId);
    await drain({ channelId, balance: "0", totalClaimed: "0", chargedCumulativeAmount: "0" });
    await expect(storage.get(channelId)).resolves.toBeUndefined();
    await expect(storage.get(otherChannelId)).resolves.toEqual(before);
  });

  it.each(["balance", "totalClaimed", "chargedCumulativeAmount"])("drops refund %s past uint256 without failing the drain", async (field) => {
    const before = await storage.get(otherChannelId);
    await drain({
      channelId, balance: "123", totalClaimed: "10", chargedCumulativeAmount: "20",
      [field]: (2n ** 256n).toString(),
    });
    await expect(storage.get(channelId)).resolves.toMatchObject({
      balance: "200000", totalClaimed: "10000", chargedCumulativeAmount: "10000",
    });
    await expect(storage.get(otherChannelId)).resolves.toEqual(before);
  });
});
