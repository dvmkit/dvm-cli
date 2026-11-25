vi.mock("viem", async (original) => ({
  ...await original<typeof import("viem")>(),
  createPublicClient: () => ({ readContract: vi.fn().mockResolvedValue([0n, 0n]) }),
}));
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
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { decodePaymentSignatureHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const balanceTransport = vi.hoisted(() => ({ describe: vi.fn(), credit: vi.fn(), close: vi.fn() }));
vi.mock("../transport", () => ({ createDvmTransport: () => balanceTransport }));
vi.mock("../output", async (original) => ({
  ...await original<typeof import("../output")>(), json: vi.fn(),
}));

vi.mock("../btc-rate", () => ({
  tryResolveBtcUsdRate: vi.fn(() => Promise.resolve({ rate: 100_000, stale: false })),
}));
vi.mock("../budget-ledger", () => ({
  enforceGlobalBudget: vi.fn(() => Promise.resolve(100_000)),
  recordSpend: vi.fn(),
  recordSpendOnce: vi.fn(),
}));

import { creditBalance } from "../../commands/credit";
import { fundCredit } from "../credit-fund";
import * as batchClient from "../x402/batch-client";
import { DvmError } from "@dvmkit/sdk/internal";
import type { CreditMenu, ProviderInfo, Transport } from "@dvmkit/sdk/internal";
import {
  attestedDvmIdentity,
  buildAttestation,
  deriveIdentityFromPrivkey,
  deriveLegacyX402ChannelSalt,
  deriveX402ChannelSalt,
  DvmX402ChannelStorage,
  ensureProvisionalCredit,
  findX402Channel,
  listPendingX402Fundings,
  listPendingX402FundingsForChannel,
  listX402Channels,
  loadCredit,
  receiptPubkeyFromSecret,
  recordFundResponse,
  recordX402ChannelMetadata,
  signAttestation,
} from "@dvmkit/sdk/internal";

beforeEach(() => {
  const root = process.env.DVM_CONFIG_DIR!;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
});

afterEach(() => vi.unstubAllEnvs());

function fixture() {
  const key = `0x${"11".repeat(32)}` as `0x${string}`;
  const account = privateKeyToAccount(key);
  const network = "eip155:84532" as const;
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
  };
  const endpoint = "https://provider.example";
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: { url: "https://provider.example/v1/credit" },
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
  const menu: CreditMenu = {
    min_micro: 10_000,
    max_micro: 5_000_000,
    ttl_ms: 60_000,
    currency: "usd",
    funding: ["x402"],
    x402: { schemes: [{ scheme: "batch-settlement", network }] },
  };

  const challenge = new DvmError("payment_required", "Channel payment required.", undefined, {
    x402_payment_required: paymentRequired,
  });
  return { account, config, endpoint, network, menu, challenge };
}

function fund(
  credit: ReturnType<typeof vi.fn>,
  creditId: string,
  providerInfo: ProviderInfo = {},
  endpoint = fixture().endpoint,
  signing = { privkey: "bb".repeat(32), pubkey: "cc".repeat(32) }
) {
  const { menu } = fixture();
  return fundCredit({
    transport: { credit } as unknown as Transport,
    ref: { endpoint },
    signing,
    creditId,
    fundId: `fund-${creditId}`,
    amountMicro: 200_000,
    targetMicro: 200_000,
    maxDepositMicro: 200_000,
    menu,
    providerInfo,
    rail: "x402",
    float: null,
    tempoAccount: null,
    signBody: (_privkey, body) => body,
  });
}

it("refuses to share a channel recorded for another caller", async () => {
  const { account, config, endpoint, network, challenge } = fixture();
  const channelConfig = { ...config, salt: deriveX402ChannelSalt({ network, payer: account.address, endpoint }) };
  const channelId = computeChannelId(channelConfig, network);
  const owner = {
    channelId, endpoint, callerPubkey: "aa".repeat(32), creditId: "credit-a",
    network, config: channelConfig, updatedAt: 1,
  };
  recordX402ChannelMetadata(owner);
  const credit = vi.fn().mockRejectedValueOnce(challenge);
  await expect(fund(credit, "credit-b")).resolves.toMatchObject({
    status: "refused", error: { code: "x402_channel_mismatch" },
  });
  expect(credit).toHaveBeenCalledTimes(1);
  expect(credit.mock.calls[0]?.[2]).toBeUndefined();
  expect(listX402Channels()).toEqual([owner]);
  expect(listPendingX402FundingsForChannel(channelId)).toEqual([]);
});

function signedChannel(credit: ReturnType<typeof vi.fn>) {
  const submitted = credit.mock.calls[1]?.[2]?.x402Payment;
  expect(submitted).toEqual(expect.any(String));
  const { payload } = decodePaymentSignatureHeader(submitted);
  return (payload.voucher as { channelId: string }).channelId;
}

function providerInfo(dvmId: string): ProviderInfo {
  const secret = "44".repeat(32);
  const pubkey = receiptPubkeyFromSecret(secret);
  const attestation = buildAttestation({
    dvmId, slug: dvmId, capabilities: [], builderPubkey: pubkey,
    receiptPubkey: pubkey, deployedAt: 1_700_000_000,
  });
  return { builder: { pubkey, attestation: { ...attestation }, signature: signAttestation(attestation, secret) } };
}

function fundedCredit(creditId: string) {
  return {
    credit_id: creditId, currency: "usd", balance_micro: 200_000, remaining_micro: 200_000,
    expiry_ms: Date.now() + 60_000, expired: false, drainable: true, ledger_seq: 1,
  };
}

function batchFunding(creditId: string) {
  const { account, challenge, network } = fixture();
  return vi.fn().mockRejectedValueOnce(challenge).mockResolvedValueOnce({
    op: "fund",
    funded_micro: 200_000,
    credit: fundedCredit(creditId),
    x402PaymentResponse: encodePaymentResponseHeader({
      success: true, transaction: "0xsettled", network, payer: account.address,
      extra: { chargedAmount: "200000" },
    }),
  });
}

it("signs per-DVM v2 channels for provisional credits sharing an origin and payout terms", async () => {
  const { endpoint } = fixture();
  // Channel IDs computed from the v2 domain, attested DVM IDs and fixture payout terms.
  const cases = [
    ["first", "0xf98bae6bd996cf9efa8ff65705fc011aabe7db3cabc56edf68ecc39a315162d0"],
    ["second", "0x3bd0b702c16ae7bfa96f4c3ee214bc75b00fd77cc6c82ff12cd63eb77a619107"],
  ];
  for (const [creditId, channelId] of cases) {
    const provider = providerInfo(`dvm-${creditId}`);
    const identity = attestedDvmIdentity(provider.builder)!;
    ensureProvisionalCredit({
      endpoint, identity, callerPubkey: "cc".repeat(32), creditId, targetMicro: 200_000, currency: "usd",
    });

    const credit = batchFunding(creditId);
    await expect(fund(credit, creditId, provider)).resolves.toMatchObject({ status: "funded" });
    expect(signedChannel(credit)).toBe(channelId);
  }
});

it.each(["unset", "provisional"] as const)(
  "refuses a top-up after a signed balance adopts an unbound legacy credit (prior local selection: %s)",
  async (selection) => {
    const { endpoint, menu } = fixture();
    const signer = deriveIdentityFromPrivkey("01".repeat(32));
    vi.stubEnv("DVM_IDENTITY_KEY", signer.privkey);

    const creditId = "adopted";
    const provider = providerInfo("dvm-adopted");
    const identity = attestedDvmIdentity(provider.builder)!;
    if (selection === "provisional") {
      ensureProvisionalCredit({
        endpoint, identity, callerPubkey: signer.pubkey, creditId, targetMicro: 200_000, currency: "usd",
      });
    }
    balanceTransport.describe.mockResolvedValue({
      ...provider,
      auth: ["secp256k1-schnorr-v2"],
      authAudience: { dvm_id: identity.dvmId, builder_pubkey: identity.builderPubkey },
    });
    // The legacy credit's balance predates rail and instrument reporting.
    const row = fundedCredit(creditId);
    balanceTransport.credit.mockResolvedValue({ op: "balance", credit: row, credits: [row], menu });

    await creditBalance(endpoint, {});

    const adopted = loadCredit(endpoint, signer.pubkey, identity);
    expect(adopted).toMatchObject({ creditId, status: "active", remainingMicro: row.remaining_micro });
    expect(adopted?.provisional).toBeUndefined();
    expect(adopted?.rail).toBeUndefined();
    expect(adopted?.x402Instrument).toBeUndefined();
    expect(listX402Channels()).toEqual([]);
    const journal = listPendingX402Fundings();

    const signVoucher = vi.spyOn(batchClient, "createX402BatchPayment");
    const credit = batchFunding(creditId);
    const result = await fund(credit, creditId, provider, endpoint, signer);

    expect(credit.mock.calls.length > 1 ? [signedChannel(credit)] : []).toEqual([]);
    expect(signVoucher).not.toHaveBeenCalled();
    expect(credit).toHaveBeenCalledTimes(1);
    expect(credit.mock.calls[0]?.[2]).toBeUndefined();
    expect(result).toMatchObject({
      status: "refused",
      error: { code: "x402_channel_mismatch" },
      hint: "Use the credit's original local channel record to retry, or use its channel ID for a timed on-chain withdrawal.",
    });
    expect(listX402Channels()).toEqual([]);
    expect(listPendingX402Fundings()).toEqual(journal);
  }
);

it("refuses to open a channel from a stored attestation alone", async () => {
  const { endpoint, challenge } = fixture();
  const creditId = "stored-identity";
  const identity = attestedDvmIdentity(providerInfo("dvm-stored").builder)!;
  ensureProvisionalCredit({
    endpoint, callerPubkey: "cc".repeat(32), identity, targetMicro: 200_000, creditId, currency: "usd",
  });
  const credit = vi.fn().mockRejectedValueOnce(challenge);
  await expect(fund(credit, creditId)).resolves.toMatchObject({
    status: "refused", error: { code: "x402_channel_mismatch" },
  });
  expect(credit).toHaveBeenCalledTimes(1);
  expect(listX402Channels()).toEqual([]);
});

it("signs a top-up for the recorded legacy channel even with a live attestation", async () => {
  const { account, config, endpoint, network, challenge } = fixture();
  const legacyConfig = { ...config, salt: deriveLegacyX402ChannelSalt({ network, payer: account.address }) };
  const channelId = computeChannelId(legacyConfig, network);
  const record = {
    channelId, endpoint, callerPubkey: "cc".repeat(32), creditId: "legacy",
    network, config: legacyConfig, updatedAt: 1,
  };
  const provider = providerInfo("dvm-legacy");
  const identity = attestedDvmIdentity(provider.builder)!;
  recordFundResponse({
    endpoint, callerPubkey: record.callerPubkey, identity, targetMicro: 200_000, rail: "x402",
    credit: fundedCredit(record.creditId), x402Instrument: "x402_channel",
  });
  recordX402ChannelMetadata(record);
  await new DvmX402ChannelStorage().set(channelId, {
    balance: "0", totalClaimed: "0", chargedCumulativeAmount: "0",
  });
  const credit = vi.fn().mockRejectedValueOnce(challenge).mockRejectedValueOnce(new Error("Stop after submission."));
  await fund(credit, record.creditId, provider);
  expect(signedChannel(credit)).toBe(channelId);
  expect(findX402Channel({ channelId })).toEqual(record);
});

function legacyRecord(creditId: string, origin = fixture().endpoint) {
  const { account, config, network } = fixture();
  const legacyConfig = { ...config, salt: deriveLegacyX402ChannelSalt({ network, payer: account.address }) };
  return {
    channelId: computeChannelId(legacyConfig, network), endpoint: origin, callerPubkey: "cc".repeat(32),
    creditId, network, config: legacyConfig, updatedAt: 1,
  };
}

it.each(["x402_channel", undefined] as const)(
  "refuses a relabelled v1 credit with stored instrument %s",
  async (instrument) => {
    const { endpoint, challenge } = fixture();
    const relabelled = legacyRecord("refused-credit");
    recordX402ChannelMetadata(relabelled);
    recordFundResponse({
      endpoint, callerPubkey: relabelled.callerPubkey, targetMicro: 200_000, rail: "x402",
      credit: fundedCredit("original-credit"), ...(instrument ? { x402Instrument: instrument } : {}),
    });
    const credit = vi.fn().mockRejectedValueOnce(challenge);
    await expect(fund(credit, "original-credit")).resolves.toMatchObject({
      status: "refused", error: { code: "x402_channel_mismatch" },
    });
    expect(credit).toHaveBeenCalledTimes(1);
    expect(credit.mock.calls[0]?.[2]).toBeUndefined();
    expect(listX402Channels()).toEqual([relabelled]);
  }
);

it("refuses an alias-only channel when the shared alias stops attesting", async () => {
  const { endpoint, challenge } = fixture();
  const record = legacyRecord("requested", "https://requested.example");
  const neighbour = attestedDvmIdentity(providerInfo("neighbour").builder)!;
  const requested = attestedDvmIdentity(providerInfo("requested").builder)!;
  for (const [origin, identity, creditId] of [
    ["https://neighbour.example", neighbour, "neighbour"],
    [record.endpoint, requested, record.creditId],
  ] as const) {
    recordFundResponse({
      endpoint: origin, identity, callerPubkey: record.callerPubkey, targetMicro: 200_000, rail: "x402",
      credit: fundedCredit(creditId), x402Instrument: "x402_channel",
    });
    loadCredit(endpoint, record.callerPubkey, identity);
  }
  expect(loadCredit(endpoint, record.callerPubkey)?.creditId).toBe("neighbour");
  recordX402ChannelMetadata(record);
  await new DvmX402ChannelStorage().set(record.channelId, {
    balance: "0", totalClaimed: "0", chargedCumulativeAmount: "0",
  });
  const credit = vi.fn().mockRejectedValueOnce(challenge);
  await expect(fund(credit, record.creditId)).resolves.toMatchObject({
    status: "refused", error: { code: "x402_channel_mismatch" },
  });
  expect(credit).not.toHaveBeenCalled();
});

it("uses the live attestation when two DVMs share an alias and credit ID", async () => {
  const { endpoint, challenge, network } = fixture();
  const creditId = "shared-credit";
  const requested = legacyRecord(creditId, "https://requested.example");
  const config = { ...requested.config, receiver: `0x${"77".repeat(20)}` as const };
  const neighbour = {
    ...requested, endpoint: "https://neighbour.example", config, channelId: computeChannelId(config, network),
  };
  const verifiedProvider = providerInfo("requested");
  for (const [record, info] of [[neighbour, providerInfo("neighbour")], [requested, verifiedProvider]] as const) {
    const identity = attestedDvmIdentity(info.builder)!;
    recordFundResponse({
      endpoint: record.endpoint, identity, callerPubkey: record.callerPubkey, targetMicro: 200_000, rail: "x402",
      credit: fundedCredit(creditId), x402Instrument: "x402_channel",
    });
    loadCredit(endpoint, record.callerPubkey, identity);
    recordX402ChannelMetadata(record);
    await new DvmX402ChannelStorage().set(record.channelId, {
      balance: "0", totalClaimed: "0", chargedCumulativeAmount: "0",
    });
  }
  const credit = vi.fn().mockRejectedValueOnce(challenge).mockRejectedValueOnce(new Error("Stop after submission."));
  await fund(credit, creditId, verifiedProvider);
  expect(signedChannel(credit)).toBe(requested.channelId);
  expect(findX402Channel({ channelId: neighbour.channelId })).toEqual(neighbour);
});

it("refuses the neighbour's v2 row at a shared alias when the requested v1 row was relabelled", async () => {
  const { endpoint: alias, account, challenge, network } = fixture();
  const creditId = "shared-credit";
  const requested = legacyRecord("relabelled-credit", "https://requested.example");
  const requestedProvider = providerInfo("requested");
  const neighbourIdentity = attestedDvmIdentity(providerInfo("neighbour").builder)!;
  const requestedIdentity = attestedDvmIdentity(requestedProvider.builder)!;
  const config = {
    ...requested.config,
    salt: deriveX402ChannelSalt({ network, payer: account.address, endpoint: alias, identity: neighbourIdentity }),
  };
  const neighbour = { ...requested, channelId: computeChannelId(config, network), endpoint: alias, creditId, config };
  for (const [endpoint, identity] of [
    ["https://neighbour.example", neighbourIdentity], [requested.endpoint, requestedIdentity],
  ] as const) {
    recordFundResponse({
      endpoint, identity, callerPubkey: requested.callerPubkey, targetMicro: 200_000, rail: "x402",
      credit: fundedCredit(creditId), x402Instrument: "x402_channel",
    });
    loadCredit(alias, requested.callerPubkey, identity);
  }
  recordX402ChannelMetadata(requested);
  recordX402ChannelMetadata(neighbour);
  await new DvmX402ChannelStorage().set(neighbour.channelId, {
    balance: "0", totalClaimed: "0", chargedCumulativeAmount: "0",
  });
  const credit = vi.fn().mockRejectedValueOnce(challenge);
  await expect(fund(credit, creditId, requestedProvider)).resolves.toMatchObject({
    status: "refused", error: { code: "x402_channel_mismatch" },
  });
  expect(credit.mock.calls.every((call) => !call[2]?.x402Payment)).toBe(true);
  expect(listPendingX402FundingsForChannel(neighbour.channelId)).toEqual([]);
  expect(findX402Channel({ channelId: neighbour.channelId })).toEqual(neighbour);
});

it("signs for the DVM's already recorded channel when opening a second credit under the same terms", async () => {
  const { account, config, endpoint, network, challenge } = fixture();
  const provider = providerInfo("shared-dvm");
  const identity = attestedDvmIdentity(provider.builder)!;
  const channelConfig = { ...config, salt: deriveX402ChannelSalt({ network, payer: account.address, endpoint, identity }) };
  const channelId = computeChannelId(channelConfig, network);
  const owner = {
    channelId, endpoint, callerPubkey: "cc".repeat(32), creditId: "first-credit",
    network, config: channelConfig, updatedAt: 1,
  };
  recordX402ChannelMetadata(owner);
  recordFundResponse({
    endpoint, identity, callerPubkey: owner.callerPubkey, targetMicro: 200_000, rail: "x402",
    credit: fundedCredit(owner.creditId), x402Instrument: "x402_channel",
  });
  await new DvmX402ChannelStorage().set(channelId, {
    balance: "0", totalClaimed: "0", chargedCumulativeAmount: "0",
  });
  const credit = vi.fn().mockRejectedValueOnce(challenge).mockRejectedValueOnce(new Error("Stop after submission."));
  await fund(credit, "second-credit", provider);
  expect(signedChannel(credit)).toBe(channelId);
  expect(listX402Channels()).toEqual([owner]);
});

it("refuses a credit with two local channel bindings", async () => {
  const { challenge, network } = fixture();
  const first = legacyRecord("ambiguous");
  const config = { ...first.config, receiver: `0x${"77".repeat(20)}` as const };
  recordX402ChannelMetadata(first);
  recordX402ChannelMetadata({ ...first, config, channelId: computeChannelId(config, network) });
  const credit = vi.fn().mockRejectedValueOnce(challenge);
  await expect(fund(credit, first.creditId)).resolves.toMatchObject({
    status: "refused", error: { code: "x402_channel_ambiguous" },
  });
  expect(credit).not.toHaveBeenCalled();
});

it("signs for a second attested DVM at the same origin while the first voucher is outstanding", async () => {
  const { challenge } = fixture();
  const first = vi.fn().mockRejectedValueOnce(challenge).mockRejectedValueOnce(new Error("Lost acknowledgement."));
  await fund(first, "first", providerInfo("dvm-first"));
  const firstChannel = signedChannel(first);
  const journal = listPendingX402FundingsForChannel(firstChannel);
  expect(journal).toHaveLength(1);

  const second = vi.fn().mockRejectedValueOnce(challenge).mockRejectedValueOnce(new Error("Stop after submission."));
  await fund(second, "second", providerInfo("dvm-second"));
  expect(signedChannel(second)).not.toBe(firstChannel);
  expect(listPendingX402FundingsForChannel(firstChannel)).toEqual(journal);
});

it("keeps the legacy salt formula out of src", () => {
  const source = fileURLToPath(new URL("../../", import.meta.url));
  const legacyPrefix = ["x402-batch", ":"].join("");
  const matches = readdirSync(source, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && readFileSync(resolve(entry.parentPath, entry.name), "utf8").includes(legacyPrefix))
    .map((entry) => entry.name);
  expect(matches).toEqual([]);
});
