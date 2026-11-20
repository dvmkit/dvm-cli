import { mkdirSync, rmSync } from "node:fs";
import { decodePaymentSignatureHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { isBatchSettlementDepositPayload, PERMIT2_ADDRESS } from "@x402/evm";
import { computeChannelId } from "@x402/evm/batch-settlement/client";
import { concatHex, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createX402BatchPayment,
  deriveIdentityFromPrivkey,
  DvmError,
  DvmX402ChannelStorage,
  encodePaymentRequiredHeader,
  listPendingX402FundingsForChannel,
  loadCredit,
  loadResumableX402Funding,
  recordFundResponse,
  recordPendingX402Funding,
  recordX402ChannelMetadata,
  retirePendingX402Funding,
  type CreditMenu,
  type CreditOpResult,
  type ProviderInfo,
  type Transport,
} from "@dvmkit/sdk/internal";

const external = vi.hoisted(() => ({
  credit: vi.fn(), describe: vi.fn(), close: vi.fn(),
  getBlock: vi.fn(), getChainId: vi.fn(), readContract: vi.fn(),
}));
vi.mock("viem", async (original) => ({
  ...await original<typeof import("viem")>(),
  createPublicClient: () => ({
    getBlock: external.getBlock, getChainId: external.getChainId, readContract: external.readContract,
  }),
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
import { HttpsTransport } from "../src/lib/transport/https";
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
const unexpectedFetch = vi.fn(() => Promise.reject(new Error("Unexpected live request")));
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

function required(amount: string): PaymentRequired & { x402Version: 2 } {
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

function response(state: Record<string, string>, chargedAmount = "0"): string {
  return encodePaymentResponseHeader({
    success: true, transaction: "0xsettled", network, payer: account.address,
    extra: { channelState: state, chargedAmount },
  });
}

beforeEach(async () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  vi.mocked(loadX402Wallet).mockReturnValue(wallet);
  external.credit.mockReset();
  external.describe.mockResolvedValue(provider);
  external.getBlock.mockReset();
  external.getChainId.mockReset();
  external.readContract.mockReset();
  external.readContract.mockResolvedValue([200_000n, 10_000n]);
  vi.stubEnv("DVM_IDENTITY_KEY", signer.privkey);
  vi.stubGlobal("fetch", unexpectedFetch);
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
  expect(unexpectedFetch).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("x402 funding recovery", () => {
  const scope = { endpoint, callerPubkey: signer.pubkey, creditId };
  const finalizedBlockHash = `0x${"ab".repeat(32)}`;
  const expiryCode = "invalid_batch_settlement_evm_payload_authorization_valid_before";
  const previous = required("200000");
  const fresh = {
    ...previous,
    accepts: previous.accepts.map((terms) => ({ ...terms, maxTimeoutSeconds: 90 })),
  };
  const permit2Terms = {
    ...previous,
    accepts: previous.accepts.map((terms) => ({
      ...terms, extra: { ...terms.extra, assetTransferMethod: "permit2" },
    })),
  };
  const mismatch = encodePaymentRequiredHeader({ ...fresh, error: "requirements_mismatch" });

  function fund(providerEndpoint = endpoint, requestedCreditId = creditId) {
    return fundCredit({
      transport: new HttpsTransport(), ref: { endpoint: providerEndpoint }, signing: signer,
      creditId: requestedCreditId, fundId: "fund-new", amountMicro: 200_000, targetMicro: 200_000,
      menu, providerInfo: provider, rail: "x402", float: null, tempoAccount: null,
      signBody: (_key, body) => body,
    });
  }

  async function journalFunding(legacy = false, terms = previous) {
    const { scheme: _scheme, ...payment } = await createX402BatchPayment({
      wallet, paymentRequired: terms, ...scope, depositMicro: 200_000,
    });
    const pending = {
      ...scope, channelId: payment.channelId, paymentHeader: payment.paymentHeader,
      fundId: "fund-original", amountMicro: 200_000, targetMicro: 200_000, requestedAt: Date.now(),
      ...(legacy ? {} : {
        maxClaimableMicro: payment.maxClaimableMicro,
        depositMicro: payment.depositMicro,
        authorizationValidBefore: payment.authorizationValidBefore,
      }),
    };
    recordPendingX402Funding(pending);
    return pending;
  }

  async function journalDeposit(
    expired: boolean,
    finalizedOffset = expired ? 1n : -1n,
    legacy = false,
    terms = previous
  ) {
    const pending = await journalFunding(legacy, terms);
    const authorization = signedDeposit(pending.paymentHeader);
    const deadline = BigInt(authorization.permit2Authorization?.deadline ?? authorization.erc3009Authorization!.validBefore);
    external.getChainId.mockResolvedValue(84532);
    external.getBlock.mockResolvedValue({
      hash: finalizedBlockHash, number: 123n, timestamp: deadline + finalizedOffset,
    });
    if (expired) {
      vi.spyOn(Date, "now").mockReturnValue(Number(deadline + 2n) * 1000);
    }
    return pending;
  }

  function refusal(status = 402, settlementHeader?: string) {
    return Response.json({ error: "payment_invalid", message: "Payment requirements changed." }, {
      status,
      headers: {
        "PAYMENT-REQUIRED": mismatch,
        ...(settlementHeader ? { [settlementHeader]: "settlement evidence" } : {}),
      },
    });
  }

  function expiryRefusal(requirementError = expiryCode, message = `x402 channel payment refused: ${expiryCode}`) {
    return Response.json({ error: "payment_invalid", message }, {
      status: 402,
      headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ ...previous, error: requirementError }) },
    });
  }

  function challengeResponse(terms = previous) {
    return Response.json({ error: "payment_required" }, {
      status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(terms) },
    });
  }

  function fundedDeposit(fundedCreditId = creditId) {
    return Response.json({
      op: "fund", funded_micro: 200_000, credit: { ...credit(200_000), credit_id: fundedCreditId },
    }, {
      headers: { "PAYMENT-RESPONSE": response({
        channelId, balance: "200000", totalClaimed: "0", chargedCumulativeAmount: "200000",
      }, "200000") },
    });
  }

  function submittedFunding(init?: RequestInit) {
    const body = JSON.parse(String(init?.body)) as { fund: { fund_id: string } };
    return {
      paymentHeader: new Headers(init?.headers).get("PAYMENT-SIGNATURE"),
      fundId: body.fund.fund_id,
    };
  }

  function signedDeposit(paymentHeader: string) {
    const { payload } = decodePaymentSignatureHeader(paymentHeader);
    if (!isBatchSettlementDepositPayload(payload)) throw new Error("Expected a signed deposit");
    return payload.deposit.authorization;
  }

  function expectFinalizedNonceRead(paymentHeader: string) {
    const authorization = signedDeposit(paymentHeader);
    expect(external.getBlock).toHaveBeenCalledExactlyOnceWith({ blockTag: "finalized" });
    if (authorization.permit2Authorization) {
      expect(external.readContract).toHaveBeenCalledWith(expect.objectContaining({
        address: PERMIT2_ADDRESS, functionName: "nonceBitmap",
        args: [account.address, BigInt(authorization.permit2Authorization.nonce) / 256n],
        blockHash: finalizedBlockHash, requireCanonical: true,
      }));
      return;
    }
    const { salt } = authorization.erc3009Authorization;
    expect(external.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: config.token, functionName: "authorizationState",
      args: [account.address, keccak256(concatHex([channelId, salt]))],
      blockHash: finalizedBlockHash, requireCanonical: true,
    }));
  }

  it.each([
    { name: "the chain is behind the deadline", finalizedOffset: -1n },
    { name: "the chain is exactly at the deadline", finalizedOffset: 0n },
    { name: "the finalized block is unavailable", blockUnavailable: true },
    { name: "the nonce cannot be read", nonceUnavailable: true },
    { name: "the RPC is on another chain", wrongChain: true },
    { name: "a legacy deposit has no deadline in journal metadata", finalizedOffset: -1n, legacy: true },
  ])("keeps a retired deposit's signing hold when $name", async ({
    finalizedOffset, blockUnavailable, nonceUnavailable, wrongChain, legacy,
  }) => {
    const pending = await journalDeposit(true, finalizedOffset, legacy);
    retirePendingX402Funding(pending);
    if (blockUnavailable) external.getBlock.mockRejectedValue(new Error("Finalized block unavailable"));
    if (wrongChain) external.getChainId.mockResolvedValue(8453);
    external.readContract.mockImplementation(async ({ functionName }) => {
      if (functionName !== "authorizationState") return [0n, 0n];
      if (nonceUnavailable) throw new Error("Nonce unavailable");
      return false;
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (_request, init) =>
      submittedFunding(init).paymentHeader ? fundedDeposit() : challengeResponse()
    );
    vi.stubGlobal("fetch", fetch);

    const outcome = await fund();

    expect(fetch.mock.calls).toHaveLength(1);
    expect(submittedFunding(fetch.mock.calls[0][1]).paymentHeader).toBeNull();
    expect(outcome).toMatchObject({ status: "unavailable", error: { code: "x402_voucher_pending" } });
    expect(listPendingX402FundingsForChannel(channelId)).toEqual([
      { ...pending, refusedAt: expect.any(Number) },
    ]);
  });

  it.each([
    { name: "a pre-metadata ERC-3009 deposit", legacy: true, terms: previous },
    { name: "a Permit2 deposit", legacy: false, terms: permit2Terms },
  ])("signs again after finalized unused proof for $name within the first day", async ({ legacy, terms }) => {
    const pending = await journalDeposit(true, 1n, legacy, terms);
    retirePendingX402Funding(pending);
    const permit = signedDeposit(pending.paymentHeader).permit2Authorization;
    const nonceBit = permit ? BigInt(permit.nonce) % 256n : undefined;
    external.readContract.mockImplementation(async ({ functionName }) => {
      if (functionName === "nonceBitmap") return nonceBit === 0n ? 2n : 1n;
      if (functionName === "authorizationState") return false;
      return [0n, 0n];
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (_request, init) =>
      submittedFunding(init).paymentHeader ? fundedDeposit() : challengeResponse(terms)
    );
    vi.stubGlobal("fetch", fetch);

    await expect(fund()).resolves.toMatchObject({ status: "funded", fundId: "fund-new" });

    expectFinalizedNonceRead(pending.paymentHeader);
    expect(fetch.mock.calls.map(([, init]) => submittedFunding(init))).toEqual([
      { paymentHeader: null, fundId: "fund-new" },
      { paymentHeader: expect.any(String), fundId: "fund-new" },
    ]);
    expect(submittedFunding(fetch.mock.calls[1][1]).paymentHeader).not.toBe(pending.paymentHeader);
    expect(listPendingX402FundingsForChannel(channelId)).toEqual([
      { ...pending, refusedAt: expect.any(Number) },
    ]);
  });

  it("holds a shared channel after a permanent refusal until the finalized nonce is unused past expiry", async () => {
    const pending = await journalDeposit(true, -1n);
    const secondCredit = "credit-2";
    const otherEndpoint = "https://shared.example";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_request, init) => {
      const { paymentHeader } = submittedFunding(init);
      if (paymentHeader === pending.paymentHeader) {
        return Response.json({ error: "credit_over_max", message: "Credit exceeds maximum." }, { status: 400 });
      }
      return paymentHeader ? fundedDeposit(secondCredit) : challengeResponse();
    });
    vi.stubGlobal("fetch", fetch);
    external.readContract.mockImplementation(async ({ functionName }) =>
      functionName === "authorizationState" ? false : [0n, 0n]
    );
    await expect(fund(otherEndpoint, secondCredit)).resolves.toMatchObject({
      status: "unavailable", error: { code: "x402_voucher_pending" },
    });
    expect(external.getBlock).not.toHaveBeenCalled();
    await expect(fund()).resolves.toMatchObject({ status: "refused", fundId: pending.fundId });

    await expect(fund(otherEndpoint, secondCredit)).resolves.toMatchObject({
      status: "unavailable", error: { code: "x402_voucher_pending" },
    });
    expect(fetch.mock.calls.map(([, init]) => submittedFunding(init).paymentHeader)).toEqual([
      null, pending.paymentHeader, null,
    ]);

    external.getBlock.mockClear();
    external.getBlock.mockResolvedValue({
      hash: finalizedBlockHash, number: 124n, timestamp: BigInt(pending.authorizationValidBefore!) + 1n,
    });
    await expect(fund(otherEndpoint, secondCredit)).resolves.toMatchObject({
      status: "funded", creditId: secondCredit, fundId: "fund-new",
    });
    expectFinalizedNonceRead(pending.paymentHeader);
    expect(fetch.mock.calls.slice(3).map(([, init]) => submittedFunding(init))).toEqual([
      { paymentHeader: null, fundId: "fund-new" },
      { paymentHeader: expect.any(String), fundId: "fund-new" },
    ]);
    expect(listPendingX402FundingsForChannel(channelId)).toEqual([
      { ...pending, refusedAt: expect.any(Number) },
    ]);
  });

  it.each([
    { name: "ERC-3009", terms: previous },
    { name: "Permit2", terms: permit2Terms },
  ])("uses refreshed escrow after $name nonce consumption and preserves the refused voucher", async ({ terms }) => {
    const pending = await journalDeposit(true, 1n, false, terms);
    retirePendingX402Funding(pending);
    const permit = signedDeposit(pending.paymentHeader).permit2Authorization;
    const bitmap = permit ? 2n ** (BigInt(permit.nonce) % 256n) : 0n;
    await storage.set(channelId, { balance: "0", totalClaimed: "0", chargedCumulativeAmount: "25000" });
    external.readContract.mockImplementation(async ({ functionName }) => {
      if (functionName === "authorizationState") return true;
      if (functionName === "nonceBitmap") return bitmap;
      throw new Error("Escrow unavailable");
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (_request, init) => {
      const { paymentHeader } = submittedFunding(init);
      if (!paymentHeader) return challengeResponse(terms);
      await expect(storage.get(channelId)).resolves.toMatchObject({
        balance: "450000", totalClaimed: "12500", chargedCumulativeAmount: "25000",
      });
      expect(decodePaymentSignatureHeader(paymentHeader).payload).toMatchObject({
        type: "voucher", voucher: { channelId, maxClaimableAmount: "225000" },
      });
      return fundedDeposit();
    });
    vi.stubGlobal("fetch", fetch);

    const held = await fund();
    expect(fetch.mock.calls).toHaveLength(1);
    expect(submittedFunding(fetch.mock.calls[0][1]).paymentHeader).toBeNull();
    expect(held).toMatchObject({ status: "unavailable", error: { code: "x402_voucher_pending" } });
    expectFinalizedNonceRead(pending.paymentHeader);
    expect(external.readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: "channels", args: [channelId],
    }));

    external.readContract.mockImplementation(async ({ functionName }) => {
      if (functionName === "authorizationState") return true;
      if (functionName === "nonceBitmap") return bitmap;
      return [450_000n, 12_500n];
    });
    await expect(fund()).resolves.toMatchObject({ status: "funded", fundId: "fund-new" });
    expect(listPendingX402FundingsForChannel(channelId)).toEqual([
      { ...pending, refusedAt: expect.any(Number) },
    ]);
  });

  it("keeps the local waiting period for a retired voucher-only funding", async () => {
    await storage.set(channelId, { balance: "450000", totalClaimed: "0", chargedCumulativeAmount: "0" });
    const pending = await journalFunding();
    expect(decodePaymentSignatureHeader(pending.paymentHeader).payload).toMatchObject({ type: "voucher" });
    const fetch = vi.fn<typeof globalThis.fetch>(async (_request, init) => {
      const { paymentHeader, fundId } = submittedFunding(init);
      if (fundId === pending.fundId) {
        return Response.json({ error: "credit_over_max", message: "Credit exceeds maximum." }, { status: 400 });
      }
      return paymentHeader ? fundedDeposit() : challengeResponse();
    });
    vi.stubGlobal("fetch", fetch);
    await expect(fund()).resolves.toMatchObject({
      status: "refused", hint: expect.stringContaining("voucher-only"),
    });

    const now = vi.spyOn(Date, "now").mockReturnValue(pending.requestedAt + 86_400_000);
    await expect(fund()).resolves.toMatchObject({
      status: "unavailable", error: { code: "x402_voucher_pending" },
    });
    expect(fetch.mock.calls).toHaveLength(1);

    now.mockReturnValue(pending.requestedAt + 86_400_001);
    await expect(fund()).resolves.toMatchObject({ status: "funded", fundId: "fund-new" });
    expect(external.getBlock).not.toHaveBeenCalled();
    expect(listPendingX402FundingsForChannel(channelId)).toEqual([
      { ...pending, refusedAt: expect.any(Number) },
    ]);
  });

  it("retires an expired unused deposit and signs the current requirements on the next funding", async () => {
    const pending = await journalDeposit(true);
    external.readContract.mockImplementation(async ({ functionName }) =>
      functionName === "authorizationState" ? false : [0n, 0n]
    );
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(refusal())
      .mockResolvedValueOnce(challengeResponse(fresh))
      .mockResolvedValueOnce(fundedDeposit());
    vi.stubGlobal("fetch", fetch);

    await expect(fund()).resolves.toMatchObject({ status: "refused", fundId: pending.fundId });

    expectFinalizedNonceRead(pending.paymentHeader);
    expect(external.readContract).toHaveBeenCalledTimes(1);
    expect(loadResumableX402Funding(scope)).toBeUndefined();
    expect(listPendingX402FundingsForChannel(channelId)).toEqual([
      { ...pending, refusedAt: expect.any(Number) },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("PAYMENT-SIGNATURE")).toBe(pending.paymentHeader);

    await expect(fund()).resolves.toMatchObject({ status: "funded", fundId: "fund-new" });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(new Headers(fetch.mock.calls[1][1]?.headers).has("PAYMENT-SIGNATURE")).toBe(false);
    const replacement = new Headers(fetch.mock.calls[2][1]?.headers).get("PAYMENT-SIGNATURE");
    expect(replacement).toBeTruthy();
    expect(decodePaymentSignatureHeader(replacement!).accepted).toEqual(fresh.accepts[0]);
    expect(listPendingX402FundingsForChannel(channelId)).toEqual([
      { ...pending, refusedAt: expect.any(Number) },
    ]);
  });

  it.each([
    { name: "an unexpired deposit", expired: false },
    { name: "a chain still before the deadline despite the CLI clock", expired: true, finalizedOffset: -1n },
    { name: "a finalized block at the deadline", expired: true, finalizedOffset: 0n },
    { name: "a consumed nonce", expired: true, consumed: true },
    { name: "an unavailable chain", expired: true, chainUnavailable: true },
    { name: "an RPC on the wrong chain", expired: true, wrongChain: true },
    { name: "a settlement response", expired: true, settlementHeader: "PAYMENT-RESPONSE" },
    { name: "a legacy settlement response", expired: true, settlementHeader: "X-PAYMENT-RESPONSE" },
    { name: "a server failure", expired: true, status: 503 },
    { name: "a transport failure", expired: true, transportFailure: true },
  ])("keeps the journal for $name", async ({ expired, finalizedOffset, consumed, chainUnavailable, wrongChain, settlementHeader, status, transportFailure }) => {
    const pending = await journalDeposit(expired, finalizedOffset);
    if (wrongChain) external.getChainId.mockResolvedValue(8453);
    if (chainUnavailable) external.readContract.mockRejectedValue(new Error("Chain unavailable"));
    else external.readContract.mockResolvedValue(consumed ?? false);
    const fetch = vi.fn<typeof globalThis.fetch>();
    if (transportFailure) fetch.mockRejectedValue(new TypeError("Connection closed"));
    else fetch.mockImplementation(async () => refusal(status, settlementHeader));
    vi.stubGlobal("fetch", fetch);

    await expect(fund()).resolves.toMatchObject({ status: "refused", fundId: pending.fundId });
    expect(loadResumableX402Funding(scope)).toEqual(pending);
    await expect(fund()).resolves.toMatchObject({ status: "refused", fundId: pending.fundId });
    expect(loadResumableX402Funding(scope)).toEqual(pending);
    expect(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("PAYMENT-SIGNATURE")))
      .toEqual([pending.paymentHeader, pending.paymentHeader]);
  });

  it.each([
    { name: "the CLI clock is ahead of the chain", finalizedOffset: -1n },
    {
      name: "the expiry refusal carries a cumulative correction", finalizedOffset: -1n, consumed: true,
      requirementError: "invalid_batch_settlement_evm_cumulative_amount_mismatch",
    },
    { name: "the finalized block is at the signed deadline", finalizedOffset: 0n },
    { name: "the finalized nonce is consumed", consumed: true },
    { name: "the finalized block is unavailable", blockUnavailable: true },
  ])("replays the original funding after an expiry refusal when $name", async ({ finalizedOffset, requirementError, consumed, blockUnavailable }) => {
    const pending = await journalDeposit(true, finalizedOffset);
    if (blockUnavailable) external.getBlock.mockRejectedValue(new Error("Finalized block unavailable"));
    external.readContract.mockImplementation(async ({ functionName }) =>
      functionName === "authorizationState" ? consumed ?? false : [0n, 0n]
    );
    const fetch = vi.fn<typeof globalThis.fetch>(async (_request, init) => {
      const { paymentHeader } = submittedFunding(init);
      if (paymentHeader === pending.paymentHeader) return expiryRefusal(requirementError);
      return paymentHeader ? fundedDeposit() : challengeResponse();
    });
    vi.stubGlobal("fetch", fetch);

    await expect(fund()).resolves.toMatchObject({ status: "refused", fundId: pending.fundId });
    expect(loadResumableX402Funding(scope)).toEqual(pending);
    await expect(fund()).resolves.toMatchObject({ status: "refused", fundId: pending.fundId });
    expect(loadResumableX402Funding(scope)).toEqual(pending);
    expect(fetch.mock.calls.map(([, init]) => submittedFunding(init))).toEqual([
      { paymentHeader: pending.paymentHeader, fundId: pending.fundId },
      { paymentHeader: pending.paymentHeader, fundId: pending.fundId },
    ]);
  });

  it("submits a replacement under the original funding ID after finalized proof", async () => {
    const pending = await journalDeposit(true);
    external.readContract.mockImplementation(async ({ functionName }) =>
      functionName === "authorizationState" ? false : [0n, 0n]
    );
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(expiryRefusal(expiryCode, "The deposit authorization expired."))
      .mockResolvedValueOnce(challengeResponse())
      .mockResolvedValueOnce(fundedDeposit());
    vi.stubGlobal("fetch", fetch);

    await expect(fund()).resolves.toMatchObject({ status: "funded", creditId, fundId: pending.fundId });

    expectFinalizedNonceRead(pending.paymentHeader);
    const submissions = fetch.mock.calls.map(([, init]) => submittedFunding(init));
    expect(submissions).toEqual([
      { paymentHeader: pending.paymentHeader, fundId: pending.fundId },
      { paymentHeader: null, fundId: pending.fundId },
      { paymentHeader: expect.any(String), fundId: pending.fundId },
    ]);
    expect(submissions[2].paymentHeader).not.toBe(pending.paymentHeader);
    expect(listPendingX402FundingsForChannel(channelId)).toEqual([]);
  });

  it("keeps the original intent after a failed replacement probe until the provider confirms funding", async () => {
    const pending = await journalDeposit(true);
    external.readContract.mockResolvedValue(false);
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(expiryRefusal())
      .mockRejectedValueOnce(new TypeError("Connection closed"))
      .mockResolvedValueOnce(expiryRefusal())
      .mockResolvedValueOnce(Response.json({
        op: "fund", funded_micro: 200_000, credit: credit(200_000), replayed: true,
      }));
    vi.stubGlobal("fetch", fetch);

    await expect(fund()).resolves.toMatchObject({ status: "refused", fundId: pending.fundId });

    expectFinalizedNonceRead(pending.paymentHeader);
    expect(loadResumableX402Funding(scope)).toEqual(pending);

    await expect(fund()).resolves.toMatchObject({ status: "funded", fundId: pending.fundId });

    expect(listPendingX402FundingsForChannel(channelId)).toEqual([]);
    expect(fetch.mock.calls.map(([, init]) => submittedFunding(init))).toEqual([
      { paymentHeader: pending.paymentHeader, fundId: pending.fundId },
      { paymentHeader: null, fundId: pending.fundId },
      { paymentHeader: pending.paymentHeader, fundId: pending.fundId },
      { paymentHeader: null, fundId: pending.fundId },
    ]);
  });
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
      x402PaymentResponse: response(state, "200000"),
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

  it("advances the signed charge and deposit while retaining chain-observed claims", async () => {
    await storage.set(channelId, { balance: "0", totalClaimed: "10000", chargedCumulativeAmount: "0" });
    await fund({ channelId, balance: "190000", totalClaimed: "7000", chargedCumulativeAmount: "200000" });
    await expect(storage.get(channelId)).resolves.toMatchObject({
      balance: "200000", totalClaimed: "10000", chargedCumulativeAmount: "200000",
    });
  });

  it("accepts uint256 balances and the uint128 voucher maximum", async () => {
    const maximum = (2n ** 256n - 1n).toString();
    // The signed cumulative voucher is uint128, even though channel balance fields are uint256.
    const voucherMaximum = (2n ** 128n - 1n).toString();
    const prior = (2n ** 128n - 1n - 200_000n).toString();
    await storage.set(channelId, { balance: maximum, totalClaimed: maximum, chargedCumulativeAmount: prior });
    await fund({ channelId, balance: (2n ** 256n - 2n).toString(), totalClaimed: (2n ** 256n - 3n).toString(), chargedCumulativeAmount: voucherMaximum });
    await expect(storage.get(channelId)).resolves.toMatchObject({
      balance: maximum, totalClaimed: maximum, chargedCumulativeAmount: voucherMaximum,
    });
  });

  it.each(["balance", "totalClaimed", "chargedCumulativeAmount"])("drops %s past uint256 without failing accepted funding", async (field) => {
    await fund({
      channelId, balance: "200000", totalClaimed: "10000", chargedCumulativeAmount: "200000",
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

  // The SDK currently drops malformed refund records; reopening re-derives the channel from the wallet’s deterministic salt. Restore retention assertions when the SDK keeps the record.
  it.each(["balance", "totalClaimed", "chargedCumulativeAmount"])("drops refund %s past uint256 without failing the drain", async (field) => {
    const before = await storage.get(otherChannelId);
    await drain({
      channelId, balance: "123", totalClaimed: "10", chargedCumulativeAmount: "20",
      [field]: (2n ** 256n).toString(),
    });
    await expect(storage.get(channelId)).resolves.toBeUndefined();
    const output = vi.mocked(renderCreditDrain).mock.calls.at(-1)![0].json;
    expect(output).toMatchObject({ receipts_verified: "absent", receipts_total: 0,
      display: expect.stringContaining("The DVM reports") });
    await expect(storage.get(otherChannelId)).resolves.toEqual(before);
  });
});
