vi.mock("../payment-rails/tempo-credential", () => ({ buildTempoCredential: vi.fn() }));
vi.mock("../x402/wallet", async () => ({ ...(await vi.importActual<typeof import("../x402/wallet")>("../x402/wallet")), loadX402Wallet: vi.fn(() => null) }));
vi.mock("../x402/client", async () => ({ ...(await vi.importActual<typeof import("../x402/client")>("../x402/client")), tryX402Payment: vi.fn() }));
vi.mock("../payment-rails/tempo-wallet", async () => ({ ...(await vi.importActual<typeof import("../payment-rails/tempo-wallet")>("../payment-rails/tempo-wallet")), connectedTempoAccount: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
clearPendingFunding: vi.fn(),
listPendingFundings: vi.fn(() => []),
loadCreditX402Binding: vi.fn(() => ({})),
loadPendingFunding: vi.fn(() => undefined),
normalizeCreditEndpoint: (endpoint: string) => new URL(endpoint).origin,
recordCreditX402Instrument: vi.fn(),
recordFundResponse: vi.fn(),
recordPendingFunding: vi.fn(),
loadAgentWallet: vi.fn(() => ({ lock_pubkey: "02" + "cd".repeat(32) })),
connectedTempoAccount: vi.fn(() => Promise.resolve(null)),
clearPendingTempoChargeFunding: vi.fn(),
listResumableTempoChargeFundings: vi.fn(() => []),
loadResumableTempoChargeFunding: vi.fn(() => undefined),
recordPendingTempoChargeFunding: vi.fn(),
acknowledgeX402ChannelOwner: vi.fn(),
clearPendingX402ExactFunding: vi.fn(),
clearPendingX402Funding: vi.fn(),
findX402Channel: vi.fn(() => undefined),
listPendingX402Fundings: vi.fn(() => []),
listPendingX402FundingsForChannel: vi.fn(() => []),
listResumableX402ExactFundings: vi.fn(() => []),
listResumableX402Fundings: vi.fn(() => []),
loadResumableX402ExactFunding: vi.fn(() => undefined),
loadResumableX402Funding: vi.fn(() => undefined),
recordPendingX402ExactFunding: vi.fn(),
recordPendingX402Funding: vi.fn(),
retirePendingX402Funding: vi.fn(),
withX402ChannelLock: vi.fn((operation: () => Promise<unknown>) => operation()),
acknowledgeReplayedX402Payment: vi.fn(() => Promise.resolve()),
assertX402RequirementDescribesChannel: vi.fn(),
canReplaceExpiredX402Deposit: vi.fn(() => Promise.resolve(false)),
createX402BatchPayment: vi.fn(),
processX402BatchCorrection: vi.fn(),
processX402BatchResponse: vi.fn(() => Promise.resolve()),
processX402BatchResponseForWallet: vi.fn(() => Promise.resolve()),
x402RequiredFromError: vi.fn((err: DvmError) => err.data?.x402_payment_required),
tryX402Payment: vi.fn(),
loadX402Wallet: vi.fn(() => null) }));
vi.mock("../output", async () => ({ ...(await vi.importActual<typeof import("../output")>("../output")), info: vi.fn() }));
vi.mock("../wallet-agent/spend", async (importOriginal) => ({ ...(await importOriginal<typeof import("../wallet-agent/spend")>()), prepareAgentSpend: vi.fn(),
commitAgentSpend: vi.fn(() => Promise.resolve()),
abandonPendingSubmission: vi.fn(() => Promise.resolve()) }));

import { Credential } from "mppx";
import { Session as TempoSession } from "mppx/tempo";
import { privateKeyToAccount } from "viem/accounts";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  stubTempoSessionClient,
} from "../payment-rails/__tests__/__helpers__/tempo-session-client";

vi.mock("../budget-ledger", () => ({
  enforceGlobalBudget: vi.fn(() => Promise.resolve(100_000)),
  recordSpend: vi.fn(),
  recordSpendOnce: vi.fn(),
}));
vi.mock("../btc-rate", () => ({
  tryResolveBtcUsdRate: vi.fn(() => Promise.resolve({ rate: 100_000, stale: false })),
}));

vi.mock("../float", () => ({
  loadFloat: vi.fn(() => ({ conn: {}, connectedAt: "" })),
  assertFloatBudget: vi.fn(() => Promise.resolve(100_000)),
  emitFloatBudgetWarning: vi.fn(),
  floatPaymentDisplay: vi.fn(
    (payment: { principalMsats: number; routingFeeMsats: number | null }) =>
      payment.routingFeeMsats === null
        ? `Invoice principal ${String(payment.principalMsats / 1000)} sats; routing fee unknown.`
        : `${String((payment.principalMsats + payment.routingFeeMsats) / 1000)} sats went out: invoice principal ${String(payment.principalMsats / 1000)} sats plus ${String(payment.routingFeeMsats / 1000)} sats routing fee.`
  ),
  fundViaFloat: vi.fn((params: { amountMsats: number }) =>
    Promise.resolve({
      outcome: "paid",
      principalMsats: params.amountMsats,
      routingFeeMsats: 0,
      walletDebitMsats: params.amountMsats,
      totalWalletFeeMsats: 0,
      unitemizedWalletFeeMsats: 0,
      btcRate: 100_000,
    })
  ),
}));

// Only the connected-account read, so the sweep's "no wallet ⇒ present
// nothing" branch is reachable without a configured Tempo key on the box.

// The charge journal only. Spread so the session leg's channel store, its lock
// and the pure liveness predicates stay the ones the code ships with — and
// stubbed at all because the CLI state sandbox is one root per `vitest` run, so
// a real entry left on disk would resume inside a later test.

// Spread the real module so the pure predicates — retirement, the deposit's
// expiry, staleness — are the ones the code ships with; only the reads, the
// writes and the file lock are stubbed.

// Only the signer is stubbed: `isSignableExactRequirement` is the predicate the
// funding leg pre-narrows a challenge with, and a fake of it would test nothing.

import { tryResolveBtcUsdRate } from "../btc-rate";
import { enforceGlobalBudget, recordSpend, recordSpendOnce } from "../budget-ledger";
import {
  availableRails,
  CREDIT_FUND_RAILS,
  type CreditFundOutcome,
  type CreditFundRail,
  fundCredit,
  isCreditFundRail,
  pickCreditFundRail,
  pollPendingCreditFundings,
  preferLightningFirst,
} from "../credit-fund";
import {
  clearPendingFunding,
  listPendingFundings,
  loadCreditX402Binding,
  loadPendingFunding,
  type PendingFunding,
  recordCreditX402Instrument,
  recordFundResponse,
  recordPendingFunding,
} from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";
import {
  assertFloatBudget,
  emitFloatBudgetWarning,
  fundViaFloat,
  loadFloat,
} from "../float";
import {
  clearPendingTempoChargeFunding,
  createTempoChannelStore,
  listResumableTempoChargeFundings,
  listTempoChannelAssociations,
  loadResumableTempoChargeFunding,
  loadTempoChannelAssociation,
  type PendingTempoChargeFunding,
  recordPendingTempoChargeFunding,
  retireTempoChannelScope,
  TEMPO_CHARGE_PENDING_STALE_MS,
} from "@dvmkit/sdk/internal";
import { buildTempoCredential } from "../payment-rails/tempo-credential";
import { createTempoCreditSession } from "@dvmkit/sdk/internal";
import { connectedTempoAccount } from "../payment-rails/tempo-wallet";
import { TEMPO_SESSION_UPDATED_REASON } from "@dvmkit/sdk/internal";
import type { CreditMenu, ProviderInfo, Transport } from "@dvmkit/sdk/internal";
import { loadAgentWallet } from "@dvmkit/sdk/internal";
import { abandonPendingSubmission, prepareAgentSpend } from "../wallet-agent/spend";

import {
  acknowledgeReplayedX402Payment,
  assertX402RequirementDescribesChannel,
  canReplaceExpiredX402Deposit,
  createX402BatchPayment,
  processX402BatchResponse,
  processX402BatchResponseForWallet,
} from "@dvmkit/sdk/internal";
import {
  acknowledgeX402ChannelOwner,
  clearPendingX402ExactFunding,
  clearPendingX402Funding,
  findX402Channel,
  listPendingX402Fundings,
  listResumableX402ExactFundings,
  listResumableX402Fundings,
  loadResumableX402ExactFunding,
  loadResumableX402Funding,
  type PendingX402ExactFunding,
  type PendingX402Funding,
  recordPendingX402ExactFunding,
  recordPendingX402Funding,
  retirePendingX402Funding,
} from "@dvmkit/sdk/internal";
import { tryX402Payment } from "../x402/client";
import { loadX402Wallet } from "../x402/wallet";

const ENDPOINT = "https://wordcount.example";
const ALIAS_ENDPOINT = "https://wordcount-alt.example";
const SIGNING = { privkey: "aa".repeat(32), pubkey: "bb".repeat(32) };

const MENU: CreditMenu = {
  min_micro: 10_000,
  max_micro: 5_000_000,
  ttl_ms: 1,
  currency: "usd",
  funding: ["cashu", "lightning"],
};

const X402_MENU: CreditMenu = {
  ...MENU,
  funding: ["x402"],
  x402: {
    schemes: [
      { scheme: "exact", network: "eip155:84532" },
      { scheme: "batch-settlement", network: "eip155:84532" },
    ],
  },
};

const X402_EXACT_MENU: CreditMenu = {
  ...MENU,
  funding: ["x402"],
  x402: { schemes: [{ scheme: "exact", network: "eip155:84532" }] },
};

const PROVIDER_INFO: ProviderInfo = {
  cashu: {
    mints: ["https://mint.example"],
    lock_pubkeys: ["02" + "cd".repeat(32)],
    min_locktime: 604800,
    canonical_id: null,
  },
};

function pendingInvoice(bolt11 = "lnbcrt1000n1stub"): DvmError {
  return new DvmError("lightning_settlement_pending", "Pay the invoice.", undefined, {
    lightning: {
      invoice: bolt11,
      payment_hash: "ab".repeat(32),
      amount_msats: 100_000,
      expires_at_ms: Date.now() + 600_000,
    },
  });
}

function fundedResponse(remainingMicro = 100_000): Record<string, unknown> {
  return {
    op: "fund",
    funded_micro: 100_000,
    replayed: false,
    credit: {
      credit_id: "credit-1",
      currency: "usd",
      balance_micro: remainingMicro,
      remaining_micro: remainingMicro,
      expiry_ms: 1,
      expired: false,
      drainable: true,
      ledger_seq: 7,
    },
  };
}

function pendingFunding(overrides: Partial<PendingFunding> = {}): PendingFunding {
  return {
    endpoint: ENDPOINT,
    callerPubkey: SIGNING.pubkey,
    creditId: "credit-1",
    fundId: "fund-original",
    amountMicro: 100_000,
    rail: "lightning",
    targetMicro: 400_000,
    menu: MENU,
    requestedAt: Date.now() - 1_000,
    bolt11: "lnbcrt1000n1original",
    paymentHash: "ab".repeat(32),
    amountMsats: 100_000,
    expiresAtMs: Date.now() + 600_000,
    ...overrides,
  };
}

const mockCreditOp = vi.fn();
const transport = { credit: mockCreditOp } as unknown as Transport;

function args(overrides: Record<string, unknown> = {}) {
  return {
    transport,
    ref: { endpoint: ENDPOINT },
    signing: SIGNING,
    creditId: "credit-1",
    fundId: "fund-1",
    amountMicro: 100_000,
    menu: MENU,
    providerInfo: PROVIDER_INFO,
    signBody: (_privkey: string, body: Record<string, unknown>) => ({ ...body, signature: "sig" }),
    ...overrides,
  } as Parameters<typeof fundCredit>[0];
}

type TempoFetchArgs = Parameters<NonNullable<Parameters<typeof fundCredit>[0]["tempoFetch"]>>[0];

function preparedSpend() {
  return async (a: Parameters<typeof prepareAgentSpend>[0]) => {
    void a;
    return {
      cashuToken: "cashu:token",
      requestId: "44444444-4444-4444-8444-444444444444",
      mint: "https://mint.example",
      totalSats: 100,
      endpoint: ENDPOINT,
      intendedLockPubkey: "02" + "cd".repeat(32),
    };
  };
}

beforeEach(async () => {
  for (const association of listTempoChannelAssociations()) {
    await retireTempoChannelScope(association);
  }
  vi.clearAllMocks();
  // `clearAllMocks` empties the call log but not the queued `…Once` values, so
  // a test that leaves one unconsumed would answer the next test's first POST.
  mockCreditOp.mockReset();
  vi.mocked(canReplaceExpiredX402Deposit).mockResolvedValue(false);
  vi.mocked(assertX402RequirementDescribesChannel).mockImplementation(() => undefined);
  vi.mocked(loadAgentWallet).mockReturnValue({ lock_pubkey: `02${"cd".repeat(32)}` } as never);
  vi.mocked(loadPendingFunding).mockReturnValue(undefined);
  vi.mocked(listPendingFundings).mockReturnValue([]);
  vi.mocked(loadFloat).mockReturnValue({ conn: {}, connectedAt: "" } as never);
  vi.mocked(assertFloatBudget).mockResolvedValue(100_000);
  vi.mocked(fundViaFloat).mockImplementation((params) =>
    Promise.resolve({
      outcome: "paid",
      principalMsats: params.amountMsats,
      routingFeeMsats: 0,
      walletDebitMsats: params.amountMsats,
      totalWalletFeeMsats: 0,
      unitemizedWalletFeeMsats: 0,
      btcRate: 100_000,
    })
  );
  vi.mocked(loadResumableX402Funding).mockReturnValue(undefined);
  vi.mocked(loadResumableX402ExactFunding).mockReturnValue(undefined);
  vi.mocked(loadResumableTempoChargeFunding).mockReturnValue(undefined);
  vi.mocked(listResumableTempoChargeFundings).mockReturnValue([]);
  vi.mocked(listPendingX402Fundings).mockReturnValue([]);
  vi.mocked(listResumableX402Fundings).mockReturnValue([]);
  vi.mocked(listResumableX402ExactFundings).mockReturnValue([]);
  vi.mocked(loadX402Wallet).mockReturnValue(null);

  vi.mocked(loadCreditX402Binding).mockReturnValue({});
  vi.mocked(findX402Channel).mockReturnValue(undefined);
  vi.mocked(enforceGlobalBudget).mockResolvedValue(100_000);
  vi.mocked(buildTempoCredential).mockReset();
});

describe("availableRails", () => {
  it("prefers cashu — held ecash costs a round trip, not a wallet interaction", () => {
    expect(availableRails({ menu: MENU, providerInfo: PROVIDER_INFO })).toEqual([
      "cashu",
      "lightning",
    ]);
  });

  it("drops cashu when the DVM offers no mint to lock proofs to", () => {
    expect(availableRails({ menu: MENU, providerInfo: {} })).toEqual(["lightning"]);
  });

  it("drops lightning when no float is connected", () => {
    expect(availableRails({ menu: MENU, providerInfo: PROVIDER_INFO, float: null })).toEqual([
      "cashu",
    ]);
  });

  it("honours the advertised menu — an unlisted rail is not offered", () => {
    const cashuOnly = { ...MENU, funding: ["cashu"] };
    expect(availableRails({ menu: cashuOnly, providerInfo: PROVIDER_INFO })).toEqual(["cashu"]);
  });

  it("admits an advertised x402 channel only when its signer is connected", () => {
    expect(availableRails({ menu: X402_MENU })).toEqual([]);
    vi.mocked(loadX402Wallet).mockReturnValue({
      privateKey: `0x${"11".repeat(32)}`,
      address: "",
      network: "eip155:84532",
    });
    expect(availableRails({ menu: X402_MENU })).toEqual(["x402"]);
  });

  it("admits an exact-only x402 menu — one authorization per top-up still funds", () => {
    vi.mocked(loadX402Wallet).mockReturnValue({
      privateKey: `0x${"11".repeat(32)}`,
      address: "",
      network: "eip155:84532",
    });
    expect(availableRails({ menu: X402_EXACT_MENU })).toEqual(["x402"]);
  });

  it("drops an x402 menu that names no scheme — the funding could only dead-end", () => {
    vi.mocked(loadX402Wallet).mockReturnValue({
      privateKey: `0x${"11".repeat(32)}`,
      address: "",
      network: "eip155:84532",
    });
    const noScheme = { ...MENU, funding: ["cashu", "x402"] };
    expect(availableRails({ menu: noScheme, providerInfo: PROVIDER_INFO, float: null })).toEqual([
      "cashu",
    ]);
  });

  it.each([
    ["a channel", X402_MENU],
    ["exact", X402_EXACT_MENU],
  ])("drops %s this wallet's chain can't sign against", (_label, menu) => {
    vi.mocked(loadX402Wallet).mockReturnValue({
      privateKey: `0x${"11".repeat(32)}`,
      address: "",
      network: "eip155:8453",
    });
    expect(availableRails({ menu })).toEqual([]);
  });

  it.each(["charge", "session"] as const)(
    "admits a connected Tempo wallet when the menu offers %s funding",
    (intent) => {
      expect(
        availableRails({
          menu: {
            ...MENU,
            funding: ["tempo"],
            tempo: { methods: [{ method: "tempo", intent }] },
          },
          tempoAccount: {
            privateKey: `0x${"11".repeat(32)}`,
            address: `0x${"22".repeat(20)}`,
          },
        })
      ).toEqual(["tempo"]);
    }
  );
});

describe("fundCredit over x402 batch settlement", () => {
  const wallet = {
    privateKey: `0x${"11".repeat(32)}`,
    address: "",
    network: "eip155:84532",
  };
  const required = {
    x402Version: 2,
    resource: { url: `${ENDPOINT}/v1/credit` },
    accepts: [
      {
        scheme: "batch-settlement",
        network: "eip155:84532",
        asset: `0x${"22".repeat(20)}`,
        amount: "100000",
        payTo: `0x${"33".repeat(20)}`,
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
  };

  function journalled(overrides: Partial<PendingX402Funding> = {}): PendingX402Funding {
    return {
      endpoint: ENDPOINT,
      callerPubkey: SIGNING.pubkey,
      creditId: "credit-1",
      fundId: "fund-original",
      amountMicro: 100_000,
      targetMicro: 400_000,
      paymentHeader: "same-header-after-crash",
      channelId: `0x${"44".repeat(32)}` as `0x${string}`,
      requestedAt: Date.now(),
      maxClaimableMicro: "400000",
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.mocked(loadX402Wallet).mockReturnValue(wallet);
    vi.mocked(createX402BatchPayment).mockResolvedValue({
      paymentHeader: "verbatim-signed-header",
      channelId: `0x${"44".repeat(32)}`,
      scheme: {} as never,
      maxClaimableMicro: "400000",
      depositMicro: "400000",
      authorizationValidBefore: "1900000000",
    });
  });

  it("journals the verbatim header before POST and advances only after acknowledgement", async () => {
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Channel payment required.", undefined, {
          x402_payment_required: required,
        })
      )
      .mockResolvedValueOnce({
        ...fundedResponse(),
        x402PaymentResponse: "settled-response",
      });

    const outcome = await fundCredit(
      args({
        rail: "x402",
        menu: X402_MENU,
        providerInfo: {},
        targetMicro: 400_000,
      })
    );

    expect(outcome).toMatchObject({ status: "funded", rail: "x402" });
    expect(createX402BatchPayment).toHaveBeenCalledWith(
      expect.objectContaining({ depositMicro: 100_000 })
    );
    expect(recordPendingX402Funding).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentHeader: "verbatim-signed-header",
        amountMicro: 100_000,
        maxClaimableMicro: "400000",
        depositMicro: "400000",
        authorizationValidBefore: "1900000000",
      })
    );
    expect(vi.mocked(recordPendingX402Funding).mock.invocationCallOrder[0]).toBeLessThan(
      mockCreditOp.mock.invocationCallOrder[1]
    );
    expect(mockCreditOp.mock.calls[1][2]).toMatchObject({
      x402Payment: "verbatim-signed-header",
      x402Version: 2,
    });
    expect(mockCreditOp.mock.calls[1][1]).toMatchObject({
      fund: {
        commitment: "345ea049de6dd25b06ff6c802b4ae4748d243995937cf503fa5a2ba87f451459",
      },
    });
    expect(processX402BatchResponse).toHaveBeenCalledWith(expect.anything(), "settled-response");
    expect(acknowledgeX402ChannelOwner).toHaveBeenCalledWith({
      channelId: `0x${"44".repeat(32)}`,
      endpoint: ENDPOINT,
      callerPubkey: SIGNING.pubkey,
      creditId: "credit-1",
    });
    expect(vi.mocked(acknowledgeX402ChannelOwner).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(clearPendingX402Funding).mock.invocationCallOrder[0]
    );
    expect(clearPendingX402Funding).toHaveBeenCalledTimes(1);
  });

  it("retries the exact stored voucher after a lost response", async () => {
    const pending = journalled({ endpoint: ALIAS_ENDPOINT });
    vi.mocked(loadResumableX402Funding).mockReturnValue(pending);
    mockCreditOp.mockResolvedValueOnce({ ...fundedResponse(), replayed: true });

    const outcome = await fundCredit(
      args({ creditId: "credit-1", fundId: "new-id", amountMicro: 999_000 })
    );

    expect(outcome).toMatchObject({ rail: "x402", fundId: "fund-original" });
    expect(createX402BatchPayment).not.toHaveBeenCalled();
    expect(mockCreditOp.mock.calls[0][0]).toEqual({ endpoint: ALIAS_ENDPOINT });
    expect(mockCreditOp.mock.calls[0][2]).toMatchObject({
      x402Payment: "same-header-after-crash",
    });
    expect(mockCreditOp.mock.calls[0][1]).toMatchObject({
      credit_id: "credit-1",
      fund: { amount_micro: 100_000, fund_id: "fund-original" },
    });
    expect(recordFundResponse).toHaveBeenCalledWith(expect.objectContaining({ sequenced: false }));
    expect(acknowledgeReplayedX402Payment).toHaveBeenCalledWith("same-header-after-crash");
    expect(processX402BatchResponseForWallet).not.toHaveBeenCalled();
    expect(clearPendingX402Funding).toHaveBeenCalledWith(pending);
  });

  it("leaves a forced rail for a different credit alone", async () => {
    vi.mocked(listPendingX402Fundings).mockReturnValue([journalled()]);
    vi.mocked(prepareAgentSpend).mockImplementation(preparedSpend());
    mockCreditOp.mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(
      args({ creditId: "credit-2", rail: "cashu", fundId: "new-id", amountMicro: 999_000 })
    );

    expect(outcome).toMatchObject({ status: "funded", rail: "cashu", creditId: "credit-2" });
    expect(mockCreditOp.mock.calls[0][2]).not.toMatchObject({
      x402Payment: "same-header-after-crash",
    });
    expect(acknowledgeReplayedX402Payment).not.toHaveBeenCalled();
  });

  it("refuses an exact Cashu funding above its native principal cap before proof preparation", async () => {
    const outcome = await fundCredit(
      args({
        rail: "cashu",
        cashuMint: "https://mint.example",
        maxCashuPrincipalSats: 99,
        maxCashuFeeSats: 1,
      })
    );

    expect(outcome).toMatchObject({ status: "refused", rail: "cashu" });
    expect(outcome.error?.code).toBe("cashu_principal_cap_exceeded");
    expect(prepareAgentSpend).not.toHaveBeenCalled();
    expect(mockCreditOp).not.toHaveBeenCalled();
  });

  it("refuses a pinned Cashu funding mint no longer accepted by the DVM before proof preparation", async () => {
    const outcome = await fundCredit(
      args({ rail: "cashu", cashuMint: "https://other-mint.example" })
    );

    expect(outcome).toMatchObject({ status: "refused", rail: "cashu" });
    expect(outcome.error?.code).toBe("cashu_mint_not_accepted");
    expect(prepareAgentSpend).not.toHaveBeenCalled();
    expect(mockCreditOp).not.toHaveBeenCalled();
  });

  it("refuses to sign a second voucher while another credit's is unacknowledged", async () => {
    vi.mocked(listPendingX402Fundings).mockReturnValue([journalled()]);

    const outcome = await fundCredit(args({ creditId: "credit-2", rail: "x402", menu: X402_MENU }));

    expect(outcome).toMatchObject({ status: "unavailable" });
    expect(outcome.error?.code).toBe("x402_voucher_pending");
    expect(outcome.hint).toContain("x402-clear-pending");
    expect(createX402BatchPayment).not.toHaveBeenCalled();
    expect(mockCreditOp).not.toHaveBeenCalled();
  });

  it("reaches x402 after ecash and reports the block without ending the cascade", async () => {
    vi.mocked(listPendingX402Fundings).mockReturnValue([journalled()]);
    vi.mocked(loadAgentWallet).mockReturnValue(null);

    const outcome = await fundCredit(
      args({ creditId: "credit-2", menu: { ...X402_MENU, funding: ["cashu", "x402"] } })
    );

    expect(outcome).toMatchObject({ status: "unavailable", rail: "x402" });
    expect(outcome.error?.code).toBe("x402_voucher_pending");
  });

  it("refuses a non-x402 rail forced onto a credit that already signed one", async () => {
    vi.mocked(loadResumableX402Funding).mockReturnValue(journalled());

    const outcome = await fundCredit(args({ creditId: "credit-1", rail: "cashu" }));

    expect(outcome).toMatchObject({ status: "unavailable", rail: "cashu" });
    expect(outcome.error?.code).toBe("x402_voucher_pending");
    expect(mockCreditOp).not.toHaveBeenCalled();
  });

  it("retires and re-signs an expired unconsumed deposit authorization", async () => {
    const pending = journalled({ creditId: "credit-original", paymentHeader: "expired-header" });
    vi.mocked(loadResumableX402Funding).mockReturnValue(pending);
    vi.mocked(canReplaceExpiredX402Deposit).mockResolvedValue(true);
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError(
          "payment_invalid",
          "invalid_batch_settlement_evm_payload_authorization_valid_before"
        )
      )
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Channel payment required.", undefined, {
          x402_payment_required: required,
        })
      )
      .mockResolvedValueOnce({ ...fundedResponse(), x402PaymentResponse: "replacement-response" });

    const outcome = await fundCredit(args({ creditId: "credit-original", rail: "x402" }));

    expect(outcome).toMatchObject({ status: "funded", creditId: "credit-original" });
    expect(canReplaceExpiredX402Deposit).toHaveBeenCalledWith(
      expect.objectContaining({ paymentHeader: "expired-header" })
    );
    expect(clearPendingX402Funding).toHaveBeenCalledWith(pending);
    expect(createX402BatchPayment).toHaveBeenCalledTimes(1);
  });

  it("retires the journal on a refusal that can never be answered", async () => {
    const pending = journalled({ authorizationValidBefore: "1900000000" });
    vi.mocked(loadResumableX402Funding).mockReturnValue(pending);
    mockCreditOp.mockRejectedValueOnce(
      new DvmError("credit_over_max", "Credit exceeds the per-caller maximum.")
    );

    const outcome = await fundCredit(args({ creditId: "credit-1", rail: "x402" }));

    expect(outcome).toMatchObject({ status: "refused" });
    expect(retirePendingX402Funding).toHaveBeenCalledWith(pending);
    expect(clearPendingX402Funding).not.toHaveBeenCalled();
    expect(outcome.display).not.toContain("remains journalled");
    expect(outcome.hint).toContain("The deposit it signed can still be submitted until");
    expect(outcome.hint).toContain("2030-03-17T17:46:40.000Z");
    expect(outcome.hint).toContain("x402-clear-pending --credit-id credit-1 --force");
  });

  it("does not describe a deposit deadline a voucher-only funding never signed", async () => {
    vi.mocked(loadResumableX402Funding).mockReturnValue(journalled());
    mockCreditOp.mockRejectedValueOnce(
      new DvmError("credit_over_max", "Credit exceeds the per-caller maximum.")
    );

    const outcome = await fundCredit(args({ creditId: "credit-1", rail: "x402" }));

    expect(outcome).toMatchObject({ status: "refused" });
    expect(outcome.hint).not.toContain("The deposit it signed can still be submitted");
    expect(outcome.hint).toContain("no deposit authorization with a deadline of its own");
    expect(outcome.hint).toContain("x402-clear-pending --credit-id credit-1 --force");
  });

  it("keeps the journal for a paid funding the ledger will never carry", async () => {
    vi.mocked(loadResumableX402Funding).mockReturnValue(journalled());
    mockCreditOp.mockRejectedValueOnce(
      new DvmError("credit_funding_unrecorded", "Paid, never recorded.", undefined, {
        retryable: false,
      })
    );

    const outcome = await fundCredit(args({ creditId: "credit-1", rail: "x402" }));

    expect(outcome).toMatchObject({ status: "refused" });
    expect(clearPendingX402Funding).not.toHaveBeenCalled();
    expect(retirePendingX402Funding).not.toHaveBeenCalled();
  });

  it("retires the journal on a terminal instrument-binding refusal", async () => {
    const pending = journalled({ authorizationValidBefore: "1900000000" });
    vi.mocked(loadResumableX402Funding).mockReturnValue(pending);
    mockCreditOp.mockRejectedValueOnce(
      new DvmError(
        "payment_invalid",
        "Credit credit-1 was opened by an exact x402 payment; a reusable x402 channel cannot fund it.",
        "Request a fresh quote and pay again — the previous payment can't be reused.",
        { credit_rail: "x402", credit_instrument: "x402_exact", retryable: false }
      )
    );

    const outcome = await fundCredit(args({ creditId: "credit-1", rail: "x402" }));

    expect(outcome).toMatchObject({ status: "refused", rail: "x402" });

    expect(outcome.requiredRail).toBeUndefined();
    expect(retirePendingX402Funding).toHaveBeenCalledWith(pending);
    expect(clearPendingX402Funding).not.toHaveBeenCalled();

    expect(recordCreditX402Instrument).toHaveBeenCalledWith(
      ENDPOINT,
      SIGNING.pubkey,
      "credit-1",
      "x402_exact",
      undefined
    );
    expect(outcome.display).toContain("opened by a one-off x402 payment");
    expect(outcome.display).not.toContain("remains journalled");

    expect(outcome.hint).not.toContain("pay again");
    expect(outcome.hint).not.toContain("Re-run this funding after the DVM is reachable");
    expect(outcome.hint).toContain("without --credit-id");

    expect(outcome.hint).toContain("one-off binding is now recorded");
    expect(outcome.hint).toContain("x402-clear-pending --credit-id credit-1 --force");

    expect(outcome.hint).toMatch(/^The deposit it signed can still be submitted until/);

    expect(outcome.hint).toContain("no funding over this DVM's reusable x402 channel");
    expect(outcome.hint).toContain("Funding over another rail is unaffected");
  });

  it("names the credit an already-bound settlement channel backs", async () => {
    const pending = journalled();
    vi.mocked(loadResumableX402Funding).mockReturnValue(pending);
    mockCreditOp.mockRejectedValueOnce(
      new DvmError(
        "payment_invalid",
        `x402 channel 0x${"44".repeat(32)} is already bound to credit credit-9; it cannot fund credit-1.`,
        undefined,
        {
          credit_rail: "x402",
          credit_instrument: "x402_channel",
          credit_channel_id: `0x${"44".repeat(32)}`,
          bound_credit_id: "credit-9",
          retryable: false,
        }
      )
    );

    const outcome = await fundCredit(args({ creditId: "credit-1", rail: "x402" }));

    expect(outcome).toMatchObject({ status: "refused", rail: "x402" });
    expect(retirePendingX402Funding).toHaveBeenCalledWith(pending);
    expect(acknowledgeX402ChannelOwner).not.toHaveBeenCalled();

    expect(recordCreditX402Instrument).not.toHaveBeenCalled();
    expect(outcome.display).toContain("already funds credit credit-9");
    expect(outcome.hint).toContain("Top credit-9 up instead");

    const hint = outcome.hint ?? "";
    expect(hint.indexOf("can be signed until then")).toBeLessThan(
      hint.indexOf("Top credit-9 up instead")
    );
  });

  it("does not route a presented voucher onto the rail a cross-rail refusal names", async () => {
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Channel payment required.", undefined, {
          x402_payment_required: required,
        })
      )
      .mockRejectedValueOnce(
        new DvmError(
          "payment_invalid",
          "Credit credit-1 was funded on the cashu rail; an x402 top-up cannot be added to it.",
          undefined,
          { credit_rail: "cashu", retryable: false }
        )
      );

    const outcome = await fundCredit(args({ menu: X402_MENU, providerInfo: {} }));

    expect(outcome).toMatchObject({ status: "refused", rail: "x402" });
    expect(outcome.requiredRail).toBeUndefined();
    expect(retirePendingX402Funding).toHaveBeenCalledWith(
      expect.objectContaining({ paymentHeader: "verbatim-signed-header" })
    );
    expect(outcome.display).toContain("opened over cashu");
  });

  it("frees the channel for a different credit once the refused deposit expires", async () => {
    const journal = [journalled({ authorizationValidBefore: "1000" })];
    vi.mocked(loadResumableX402Funding).mockReturnValue(journal[0]);
    vi.mocked(listPendingX402Fundings).mockImplementation(() => journal);
    // `Once`, so the write-through doesn't outlive this test — `clearAllMocks`
    // empties the call log but leaves a standing implementation in place.
    vi.mocked(retirePendingX402Funding).mockImplementationOnce((entry) => {
      journal[0] = { ...entry, refusedAt: Date.now() };
    });
    mockCreditOp.mockRejectedValueOnce(
      new DvmError("payment_invalid", "Bound elsewhere.", undefined, {
        credit_rail: "x402",
        credit_instrument: "x402_exact",
        retryable: false,
      })
    );

    const refusal = await fundCredit(args({ creditId: "credit-1", rail: "x402" }));
    expect(refusal).toMatchObject({ status: "refused" });

    vi.mocked(loadResumableX402Funding).mockReturnValue(undefined);
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Channel payment required.", undefined, {
          x402_payment_required: required,
        })
      )
      .mockResolvedValueOnce({ ...fundedResponse(), x402PaymentResponse: "settled-response" });

    const second = await fundCredit(
      args({ creditId: "credit-2", rail: "x402", menu: X402_MENU, providerInfo: {} })
    );

    expect(second).toMatchObject({ status: "funded", rail: "x402" });
    expect(createX402BatchPayment).toHaveBeenCalledTimes(1);
  });

  it("treats a binding refusal on the discovery probe as terminal", async () => {
    mockCreditOp.mockRejectedValueOnce(
      new DvmError("payment_invalid", "Bound to another channel.", undefined, {
        credit_rail: "x402",
        credit_instrument: "x402_channel",
        credit_channel_id: `0x${"77".repeat(32)}`,
        retryable: false,
      })
    );

    const outcome = await fundCredit(args({ rail: "x402", menu: X402_MENU, providerInfo: {} }));

    expect(outcome).toMatchObject({ status: "refused", rail: "x402" });
    expect(outcome.requiredRail).toBeUndefined();
    expect(outcome.display).toContain(`channel 0x${"77".repeat(32)}`);
    expect(createX402BatchPayment).not.toHaveBeenCalled();
    expect(recordPendingX402Funding).not.toHaveBeenCalled();
  });

  it("keeps the named rail when a cross-rail refusal also names its instrument", async () => {
    mockCreditOp.mockRejectedValueOnce(
      new DvmError(
        "payment_invalid",
        "Credit credit-1 was funded on the tempo rail; an x402 top-up cannot be added to it.",
        undefined,
        {
          credit_rail: "tempo",
          credit_instrument: "tempo_session",
          credit_channel_id: `0x${"88".repeat(20)}`,
          retryable: false,
        }
      )
    );

    const outcome = await fundCredit(args({ rail: "x402", menu: X402_MENU, providerInfo: {} }));

    expect(outcome).toMatchObject({ status: "unavailable", requiredRail: "tempo" });
    expect(createX402BatchPayment).not.toHaveBeenCalled();
    expect(recordPendingX402Funding).not.toHaveBeenCalled();
  });

  it("refuses a same-credit re-fund while the refused deposit is still submittable", async () => {
    const refused = {
      ...journalled(),
      authorizationValidBefore: String(Math.floor(Date.now() / 1000) + 600),
      refusedAt: Date.now(),
    };
    vi.mocked(listPendingX402Fundings).mockReturnValue([refused]);

    const outcome = await fundCredit(args({ creditId: "credit-1", rail: "x402", menu: X402_MENU }));

    expect(outcome).toMatchObject({ status: "unavailable" });
    expect(outcome.error?.code).toBe("x402_voucher_pending");
    expect(outcome.display).toContain("refused by the DVM but can still be submitted");
    expect(outcome.hint).toContain("Fund again after");
    expect(createX402BatchPayment).not.toHaveBeenCalled();
    expect(mockCreditOp).not.toHaveBeenCalled();
  });

  it("lets the same credit fund again once the refused deposit has expired", async () => {
    vi.mocked(listPendingX402Fundings).mockReturnValue([
      { ...journalled(), authorizationValidBefore: "1000", refusedAt: 1 },
    ]);
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Channel payment required.", undefined, {
          x402_payment_required: required,
        })
      )
      .mockResolvedValueOnce({ ...fundedResponse(), x402PaymentResponse: "settled-response" });

    const outcome = await fundCredit(
      args({ creditId: "credit-1", rail: "x402", menu: X402_MENU, providerInfo: {} })
    );

    expect(outcome).toMatchObject({ status: "funded", rail: "x402" });
    expect(createX402BatchPayment).toHaveBeenCalledTimes(1);
  });

  it("treats a DVM with no batch channel on this chain as a rail miss, not a refusal", async () => {
    mockCreditOp.mockRejectedValueOnce(
      new DvmError("payment_required", "Channel payment required.", undefined, {
        x402_payment_required: required,
      })
    );
    vi.mocked(createX402BatchPayment).mockRejectedValueOnce(
      new DvmError("x402_batch_not_offered", "No batch-settlement channel on eip155:84532.")
    );

    const outcome = await fundCredit(args({ rail: "x402", menu: X402_MENU, providerInfo: {} }));

    expect(outcome).toMatchObject({ status: "unavailable", rail: "x402" });
    expect(outcome.error?.code).toBe("x402_batch_not_offered");
  });

  it("treats an unreadable x402 payload as a rail miss, not a refusal", async () => {
    mockCreditOp.mockRejectedValueOnce(
      new DvmError("payment_required", "Channel payment required.", undefined, {
        x402_payment_required: required,
      })
    );
    vi.mocked(createX402BatchPayment).mockRejectedValueOnce(
      new DvmError("x402_voucher_unreadable", "The signed x402 payload could not be read.")
    );

    const outcome = await fundCredit(args({ rail: "x402", menu: X402_MENU, providerInfo: {} }));

    expect(outcome).toMatchObject({ status: "unavailable", rail: "x402" });
    expect(outcome.error?.code).toBe("x402_voucher_unreadable");
    expect(clearPendingX402Funding).not.toHaveBeenCalled();
  });

  it("does not re-check the spending cap when replaying a signed voucher", async () => {
    vi.mocked(loadResumableX402Funding).mockReturnValue(journalled());
    vi.mocked(enforceGlobalBudget).mockRejectedValue(
      new DvmError("budget_exceeded", "Daily cap reached.")
    );
    mockCreditOp.mockResolvedValueOnce({ ...fundedResponse(), replayed: true });

    const outcome = await fundCredit(args({ creditId: "credit-1", rail: "x402" }));

    expect(outcome).toMatchObject({ status: "funded" });
    expect(enforceGlobalBudget).not.toHaveBeenCalled();
  });

  it("adopts the credit before retiring its journal entry", async () => {
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Channel payment required.", undefined, {
          x402_payment_required: required,
        })
      )
      .mockResolvedValueOnce({ ...fundedResponse(), x402PaymentResponse: "settled-response" });

    await fundCredit(args({ rail: "x402", menu: X402_MENU, providerInfo: {} }));

    expect(vi.mocked(recordFundResponse).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(clearPendingX402Funding).mock.invocationCallOrder[0]
    );
    expect(recordSpendOnce).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "fund:fund-1", kind: "credit_fund" })
    );
    expect(recordSpend).not.toHaveBeenCalled();
  });
});

describe("fundCredit over exact x402", () => {
  const wallet = {
    privateKey: `0x${"11".repeat(32)}`,
    address: "",
    network: "eip155:84532",
  };

  const exactRequired = {
    x402Version: 2,
    resource: { url: `${ENDPOINT}/v1/credit` },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532",
        asset: `0x${"22".repeat(20)}`,
        amount: "100000",
        payTo: `0x${"33".repeat(20)}`,
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
    extensions: {},
  };

  function challenge(required: unknown = exactRequired): DvmError {
    return new DvmError("payment_required", "Payment required.", undefined, {
      x402_payment_required: required,
    });
  }

  function exactHeader(validBefore: string): string {
    return Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: "exact",
        network: "base-sepolia",
        payload: {
          signature: `0x${"ab".repeat(32)}`,
          authorization: {
            from: `0x${"11".repeat(20)}`,
            to: `0x${"22".repeat(20)}`,
            value: "100000",
            validAfter: "0",
            validBefore,
            nonce: `0x${"33".repeat(32)}`,
          },
        },
      })
    ).toString("base64");
  }

  beforeEach(() => {
    vi.mocked(loadX402Wallet).mockReturnValue(wallet);
    vi.mocked(tryX402Payment).mockResolvedValue({
      paymentHeader: "exact-signed-header",
      x402Version: 2,
      amountUsdcMicro: "100000",
      amountMsats: 1_000_000,
      btcRate: 100_000,
    });
  });

  it("signs the DVM's exact requirement and binds it as the fund commitment", async () => {
    mockCreditOp.mockRejectedValueOnce(challenge()).mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(
      args({ rail: "x402", menu: X402_EXACT_MENU, providerInfo: {} })
    );

    expect(outcome).toMatchObject({ status: "funded", rail: "x402" });
    expect(recordFundResponse).toHaveBeenCalledWith(
      expect.objectContaining({ rail: "x402", x402Instrument: "x402_exact" })
    );
    expect(createX402BatchPayment).not.toHaveBeenCalled();

    expect(vi.mocked(tryX402Payment).mock.calls[0][0]).toMatchObject({
      payTo: `0x${"33".repeat(20)}`,
      network: "eip155:84532",
      paymentRequired: { accepts: [exactRequired.accepts[0]] },
    });
    // sha256("exact-signed-header") — the artifact binding of the signed credit contract
    // condition 3, the same construction every other attach rail uses.
    expect(mockCreditOp.mock.calls[1][1]).toMatchObject({
      op: "fund",
      credit_id: "credit-1",
      fund: {
        fund_id: "fund-1",
        amount_micro: 100_000,
        commitment: "780c25d5e6f382be0b121d1eb0ee87920380d96e78ee9e74dc802cded62c6e83",
      },
    });
    expect(mockCreditOp.mock.calls[1][2]).toMatchObject({
      x402Payment: "exact-signed-header",
      x402Version: 2,
    });

    expect(recordPendingX402Funding).not.toHaveBeenCalled();
    expect(recordPendingX402ExactFunding).toHaveBeenCalledWith(
      expect.objectContaining({
        creditId: "credit-1",
        fundId: "fund-1",
        paymentHeader: "exact-signed-header",
        x402Version: 2,
        amountMsats: 1_000_000,
      })
    );
    expect(vi.mocked(recordPendingX402ExactFunding).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(mockCreditOp).mock.invocationCallOrder[1]
    );
    expect(clearPendingX402ExactFunding).toHaveBeenCalledWith(
      expect.objectContaining({ fundId: "fund-1" })
    );
    expect(recordSpendOnce).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "credit_fund", jobId: "fund:fund-1" })
    );
  });

  it("keeps a signable requirement that an unsupported sibling is listed ahead of", async () => {

    mockCreditOp
      .mockRejectedValueOnce(
        challenge({
          ...exactRequired,
          accepts: [
            { ...exactRequired.accepts[0], extra: { assetTransferMethod: "permit2" } },
            { ...exactRequired.accepts[0], payTo: `0x${"55".repeat(20)}` },
          ],
        })
      )
      .mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(
      args({ rail: "x402", menu: X402_EXACT_MENU, providerInfo: {} })
    );

    expect(outcome).toMatchObject({ status: "funded", rail: "x402" });
    expect(vi.mocked(tryX402Payment).mock.calls[0][0]).toMatchObject({
      payTo: `0x${"55".repeat(20)}`,
      paymentRequired: { accepts: [{ payTo: `0x${"55".repeat(20)}` }] },
    });
  });

  it("treats a chain-matched requirement this build can't sign as a rail miss", async () => {
    mockCreditOp.mockRejectedValueOnce(
      challenge({
        ...exactRequired,
        accepts: [{ ...exactRequired.accepts[0], extra: { assetTransferMethod: "permit2" } }],
      })
    );

    const outcome = await fundCredit(
      args({ rail: "x402", menu: X402_EXACT_MENU, providerInfo: {} })
    );

    expect(outcome).toMatchObject({ status: "unavailable", rail: "x402" });
    expect(outcome.error?.code).toBe("x402_exact_not_offered");
    expect(outcome.display).toContain("Base Sepolia (eip155:84532)");
    expect(outcome.hint).toContain("Base Sepolia (eip155:84532)");
    expect(tryX402Payment).not.toHaveBeenCalled();
  });

  it("books what was signed, not what was asked for", async () => {
    // The DVM's advertised figure is what gets authorized, and the signer
    // accepts one up to 10% above the caller's local conversion — so the ledger
    // has to take the proof's own numbers or it under-books the spend.
    vi.mocked(tryX402Payment).mockResolvedValue({
      paymentHeader: "exact-signed-header",
      x402Version: 2,
      amountUsdcMicro: "108000",
      amountMsats: 108_000,
      btcRate: 95_000,
    });
    mockCreditOp.mockRejectedValueOnce(challenge()).mockResolvedValueOnce(fundedResponse());

    await fundCredit(args({ rail: "x402", menu: X402_EXACT_MENU, providerInfo: {} }));

    expect(recordSpendOnce).toHaveBeenCalledWith(
      expect.objectContaining({ msats: 108_000, btcRate: 95_000, jobId: "fund:fund-1" })
    );
  });

  it("reports a terminal binding refusal instead of an ambiguous settlement", async () => {

    vi.mocked(tryX402Payment).mockResolvedValue({
      paymentHeader: exactHeader("1900000000"),
      x402Version: 1,
      amountUsdcMicro: "100000",
      amountMsats: 1_000_000,
      btcRate: 100_000,
    });
    mockCreditOp.mockRejectedValueOnce(challenge()).mockRejectedValueOnce(
      new DvmError(
        "payment_invalid",
        `Credit credit-1 is bound to x402 settlement channel 0x${"66".repeat(32)}; an x402_exact top-up cannot be added to it.`,
        "Request a fresh quote and pay again — the previous payment can't be reused.",
        {
          credit_rail: "x402",
          credit_instrument: "x402_channel",
          credit_channel_id: `0x${"66".repeat(32)}`,
          retryable: false,
        }
      )
    );

    const outcome = await fundCredit(
      args({ rail: "x402", menu: X402_EXACT_MENU, providerInfo: {} })
    );

    expect(outcome).toMatchObject({ status: "refused", rail: "x402" });
    expect(outcome.requiredRail).toBeUndefined();
    expect(outcome.display).toContain(`channel 0x${"66".repeat(32)}`);
    expect(outcome.hint).not.toContain("may still have settled");
    expect(outcome.hint).not.toContain("pay again");

    expect(clearPendingX402ExactFunding).toHaveBeenCalledWith(
      expect.objectContaining({ fundId: "fund-1" })
    );
    expect(retirePendingX402Funding).not.toHaveBeenCalled();
    expect(outcome.hint).toMatch(/^Nothing was settled/);
    expect(outcome.hint).toContain("stays submittable until 2030-03-17T17:46:40.000Z");
    expect(outcome.hint).toContain("check 'dvm credit balance' before signing another");
    const hint = outcome.hint ?? "";
    expect(hint.indexOf("submittable until")).toBeLessThan(hint.indexOf("without --credit-id"));
  });

  it("does not date the presented authorization it could not read", async () => {
    mockCreditOp.mockRejectedValueOnce(challenge()).mockRejectedValueOnce(
      new DvmError("payment_invalid", "Bound to a channel.", undefined, {
        credit_rail: "x402",
        credit_instrument: "x402_channel",
        retryable: false,
      })
    );

    const outcome = await fundCredit(
      args({ rail: "x402", menu: X402_EXACT_MENU, providerInfo: {} })
    );

    expect(outcome).toMatchObject({ status: "refused" });
    expect(outcome.hint).toContain("stays submittable until its own deadline lapses");
    expect(outcome.hint).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("names the exact route where the channel is on some other chain", async () => {

    mockCreditOp.mockRejectedValueOnce(challenge()).mockResolvedValueOnce(fundedResponse());
    const split: CreditMenu = {
      ...X402_EXACT_MENU,
      x402: {
        schemes: [
          { scheme: "batch-settlement", network: "eip155:8453" },
          { scheme: "exact", network: "eip155:84532" },
        ],
      },
    };

    const outcome = await fundCredit(args({ menu: split, providerInfo: {} }));

    expect(outcome).toMatchObject({ status: "funded", railReason: "x402_exact" });
  });

  it("answers the discovery probe's replay without signing anything", async () => {

    mockCreditOp.mockResolvedValueOnce({ ...fundedResponse(), replayed: true });

    const outcome = await fundCredit(
      args({ rail: "x402", menu: X402_EXACT_MENU, providerInfo: {} })
    );

    expect(outcome).toMatchObject({ status: "funded", rail: "x402" });
    expect(tryX402Payment).not.toHaveBeenCalled();
    expect(mockCreditOp).toHaveBeenCalledTimes(1);
  });

  it("prefers the channel wherever both flavours are advertised", async () => {
    vi.mocked(createX402BatchPayment).mockResolvedValue({
      paymentHeader: "verbatim-signed-header",
      channelId: `0x${"44".repeat(32)}`,
      scheme: {} as never,
      maxClaimableMicro: "400000",
      depositMicro: "400000",
      authorizationValidBefore: "1900000000",
    });
    mockCreditOp
      .mockRejectedValueOnce(challenge())
      .mockResolvedValueOnce({ ...fundedResponse(), x402PaymentResponse: "settled-response" });

    const outcome = await fundCredit(args({ rail: "x402", menu: X402_MENU, providerInfo: {} }));

    expect(outcome).toMatchObject({ status: "funded", x402Flavour: "batch-settlement" });
    expect(createX402BatchPayment).toHaveBeenCalledTimes(1);
    expect(tryX402Payment).not.toHaveBeenCalled();
  });

  it("treats an exact requirement on another chain as a rail miss, not a refusal", async () => {
    mockCreditOp.mockRejectedValueOnce(
      challenge({
        ...exactRequired,
        accepts: [{ ...exactRequired.accepts[0], network: "eip155:8453" }],
      })
    );

    const outcome = await fundCredit(
      args({ rail: "x402", menu: X402_EXACT_MENU, providerInfo: {} })
    );

    expect(outcome).toMatchObject({ status: "unavailable", rail: "x402" });
    expect(outcome.error?.code).toBe("x402_exact_not_offered");
    expect(tryX402Payment).not.toHaveBeenCalled();
  });

  it("falls through to ecash when the DVM's chain isn't this wallet's", async () => {

    vi.mocked(prepareAgentSpend).mockImplementation(preparedSpend() as never);
    mockCreditOp.mockResolvedValueOnce(fundedResponse());
    const otherChain: CreditMenu = {
      ...X402_EXACT_MENU,
      funding: ["x402", "cashu"],
      x402: { schemes: [{ scheme: "exact", network: "eip155:8453" }] },
    };

    const outcome = await fundCredit(args({ menu: otherChain }));

    expect(outcome).toMatchObject({ status: "funded", rail: "cashu" });
    expect(tryX402Payment).not.toHaveBeenCalled();
  });

  it("re-presents the same authorization under the same fund id after a lost response", async () => {
    mockCreditOp
      .mockRejectedValueOnce(challenge())
      .mockRejectedValueOnce(new DvmError("provider_unreachable", "Connection reset."));

    const lost = await fundCredit(
      args({ rail: "x402", targetMicro: 400_000, menu: X402_EXACT_MENU, providerInfo: {} })
    );
    expect(lost).toMatchObject({ status: "refused", rail: "x402", fundId: "fund-1" });
    expect(lost.hint).toContain("dvm credit balance");
    expect(clearPendingX402ExactFunding).not.toHaveBeenCalled();

    const journalled = vi.mocked(recordPendingX402ExactFunding).mock
      .calls[0][0] as PendingX402ExactFunding;
    const resumed = { ...journalled, endpoint: ALIAS_ENDPOINT };
    vi.mocked(loadResumableX402ExactFunding).mockReturnValue(resumed);
    vi.mocked(tryX402Payment).mockClear();
    mockCreditOp.mockReset();
    mockCreditOp.mockResolvedValueOnce(fundedResponse());

    const retried = await fundCredit(
      args({ fundId: undefined, menu: X402_EXACT_MENU, providerInfo: {} })
    );

    expect(retried).toMatchObject({ status: "funded", fundId: "fund-1" });

    expect(tryX402Payment).not.toHaveBeenCalled();
    expect(mockCreditOp).toHaveBeenCalledTimes(1);
    expect(mockCreditOp.mock.calls[0][0]).toEqual({ endpoint: ALIAS_ENDPOINT });
    expect(mockCreditOp.mock.calls[0][1]).toMatchObject({
      credit_id: "credit-1",
      fund: { fund_id: "fund-1" },
    });
    expect(mockCreditOp.mock.calls[0][2]).toMatchObject({
      x402Payment: "exact-signed-header",
      x402Version: 2,
    });
    expect(clearPendingX402ExactFunding).toHaveBeenCalledWith(resumed);

    expect(journalled.targetMicro).toBe(400_000);
    expect(recordFundResponse).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetMicro: 400_000 })
    );
  });

  it("books an unconfirmed authorization once, and the retry books nothing further", async () => {
    mockCreditOp
      .mockRejectedValueOnce(challenge())
      .mockRejectedValueOnce(new DvmError("provider_unreachable", "Connection reset."));

    await fundCredit(args({ rail: "x402", menu: X402_EXACT_MENU, providerInfo: {} }));

    expect(recordSpendOnce).toHaveBeenCalledTimes(1);
    expect(recordSpendOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "credit_fund",
        jobId: "fund:fund-1",
        msats: 1_000_000,
        btcRate: 100_000,
      })
    );

    const journalled = vi.mocked(recordPendingX402ExactFunding).mock
      .calls[0][0] as PendingX402ExactFunding;
    vi.mocked(loadResumableX402ExactFunding).mockReturnValue(journalled);
    mockCreditOp.mockReset();
    mockCreditOp.mockResolvedValueOnce(fundedResponse());

    await fundCredit(args({ fundId: undefined, menu: X402_EXACT_MENU, providerInfo: {} }));

    expect(vi.mocked(recordSpendOnce).mock.calls.map((call) => call[0].jobId)).toEqual([
      "fund:fund-1",
      "fund:fund-1",
    ]);
  });

  it("refuses another rail while this credit's authorization is still submittable", async () => {
    vi.mocked(loadResumableX402ExactFunding).mockReturnValue({
      endpoint: ENDPOINT,
      callerPubkey: SIGNING.pubkey,
      creditId: "credit-1",
      fundId: "fund-1",
      amountMicro: 100_000,
      targetMicro: 100_000,
      paymentHeader: exactHeader("1900000000"),
      x402Version: 1,
      amountMsats: 1_000_000,
      btcRate: 100_000,
      requestedAt: Date.now(),
      authorizationValidBefore: "1900000000",
    });

    const outcome = await fundCredit(
      args({ rail: "cashu", menu: X402_EXACT_MENU, providerInfo: {} })
    );

    expect(outcome).toMatchObject({ status: "unavailable", creditId: "credit-1" });
    expect(outcome.display).toContain("second payment for the same top-up");
    expect(outcome.hint).toContain("re-presents what was already signed");
    expect(outcome.hint).toContain("2030-03-17T17:46:40.000Z");
    expect(mockCreditOp).not.toHaveBeenCalled();
  });

  it("names the exact route in the funding's reason", async () => {
    mockCreditOp.mockRejectedValueOnce(challenge()).mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(args({ menu: X402_EXACT_MENU, providerInfo: {} }));

    expect(outcome).toMatchObject({
      status: "funded",
      railReason: "x402_exact",
      x402Flavour: "exact",
    });
  });

  it("carries exact independently when an existing credit forces the x402 rail", async () => {
    mockCreditOp.mockRejectedValueOnce(challenge()).mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(
      args({
        rail: "x402",
        railSource: "credit_bound",
        menu: X402_EXACT_MENU,
        providerInfo: {},
      })
    );

    expect(outcome).toMatchObject({
      status: "funded",
      rail: "x402",
      railReason: "forced",
      railSource: "credit_bound",
      x402Flavour: "exact",
    });
  });

  it("carries exact when x402 succeeds after another rail misses", async () => {
    vi.mocked(prepareAgentSpend).mockResolvedValue({
      error: { code: "insufficient_balance", message: "Not enough sats.", hint: "Fund it." },
    });
    mockCreditOp.mockRejectedValueOnce(challenge()).mockResolvedValueOnce(fundedResponse());
    const fallbackMenu: CreditMenu = {
      ...X402_EXACT_MENU,
      funding: ["cashu", "x402"],
    };

    const outcome = await fundCredit(args({ menu: fallbackMenu, providerInfo: PROVIDER_INFO }));

    expect(outcome).toMatchObject({
      status: "funded",
      rail: "x402",

      railReason: "lightning_not_offered",

      x402Flavour: "exact",
    });
  });
});

describe("x402 instrument binding", () => {
  const wallet = { privateKey: `0x${"11".repeat(32)}`, address: "", network: "eip155:84532" };

  const X402_CHANNEL_MENU: CreditMenu = {
    ...MENU,
    funding: ["x402"],
    x402: { schemes: [{ scheme: "batch-settlement", network: "eip155:84532" }] },
  };

  const exactRequired = {
    x402Version: 2,
    resource: { url: `${ENDPOINT}/v1/credit` },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532",
        asset: `0x${"22".repeat(20)}`,
        amount: "100000",
        payTo: `0x${"33".repeat(20)}`,
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
    extensions: {},
  };

  function challenge(): DvmError {
    return new DvmError("payment_required", "Payment required.", undefined, {
      x402_payment_required: exactRequired,
    });
  }

  function bindingRefusal(data: Record<string, unknown>): DvmError {
    return new DvmError(
      "payment_invalid",
      "The payment could not be verified.",
      "Request a fresh quote and pay again.",
      { credit_rail: "x402", retryable: false, ...data }
    );
  }

  beforeEach(() => {
    vi.mocked(loadX402Wallet).mockReturnValue(wallet);
    vi.mocked(tryX402Payment).mockResolvedValue({
      paymentHeader: "exact-signed-header",
      x402Version: 2,
      amountUsdcMicro: "100000",
      amountMsats: 1_000_000,
      btcRate: 100_000,
    });
    vi.mocked(createX402BatchPayment).mockResolvedValue({
      paymentHeader: "verbatim-signed-header",
      channelId: `0x${"44".repeat(32)}`,
      scheme: {} as never,
      maxClaimableMicro: "400000",
      depositMicro: "400000",
      authorizationValidBefore: "1900000000",
    });
  });

  it("funds an exact-bound credit over exact where the menu prefers the channel", async () => {
    vi.mocked(loadCreditX402Binding).mockReturnValue({ instrument: "x402_exact" });
    mockCreditOp.mockRejectedValueOnce(challenge()).mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(args({ rail: "x402", menu: X402_MENU, providerInfo: {} }));

    expect(outcome).toMatchObject({ status: "funded", x402Flavour: "exact" });
    expect(tryX402Payment).toHaveBeenCalledTimes(1);
    expect(createX402BatchPayment).not.toHaveBeenCalled();
  });

  it("leaves a channel-bound credit on the channel", async () => {
    vi.mocked(loadCreditX402Binding).mockReturnValue({ instrument: "x402_channel" });
    mockCreditOp
      .mockRejectedValueOnce(challenge())
      .mockResolvedValueOnce({ ...fundedResponse(), x402PaymentResponse: "settled-response" });

    const outcome = await fundCredit(args({ rail: "x402", menu: X402_MENU, providerInfo: {} }));

    expect(outcome).toMatchObject({ status: "funded", x402Flavour: "batch-settlement" });
    expect(createX402BatchPayment).toHaveBeenCalledTimes(1);
    expect(tryX402Payment).not.toHaveBeenCalled();
  });

  it("refuses locally when the DVM no longer offers the bound flavour", async () => {
    vi.mocked(loadCreditX402Binding).mockReturnValue({ instrument: "x402_exact" });

    const outcome = await fundCredit(
      args({ rail: "x402", menu: X402_CHANNEL_MENU, providerInfo: {} })
    );

    expect(outcome).toMatchObject({ status: "refused", rail: "x402" });
    expect(outcome.error?.code).toBe("x402_instrument_unavailable");

    expect(tryX402Payment).not.toHaveBeenCalled();
    expect(createX402BatchPayment).not.toHaveBeenCalled();
    expect(recordPendingX402Funding).not.toHaveBeenCalled();
    expect(mockCreditOp).not.toHaveBeenCalled();
    expect(outcome.display).toContain("opened by a one-off x402 payment");
    expect(outcome.display).toContain("Nothing was signed");
    expect(outcome.hint).toContain(`dvm credit drain ${ENDPOINT}`);

    expect(outcome.hint).toContain("opens settlement channels on Base Sepolia (eip155:84532)");
  });

  it("refuses a channel-bound credit at a DVM that has stopped opening channels", async () => {
    vi.mocked(loadCreditX402Binding).mockReturnValue({ instrument: "x402_channel" });

    const outcome = await fundCredit(
      args({ rail: "x402", menu: X402_EXACT_MENU, providerInfo: {} })
    );

    expect(outcome).toMatchObject({ status: "refused", rail: "x402" });
    expect(outcome.display).toContain("belongs to an x402 settlement channel");
    expect(outcome.hint).toContain("Fund without --credit-id");
    expect(outcome.hint).toContain("takes one-off x402 payments on Base Sepolia (eip155:84532)");
    expect(createX402BatchPayment).not.toHaveBeenCalled();
    expect(tryX402Payment).not.toHaveBeenCalled();
  });

  it("blames the wallet's chain, not the DVM, where the bound flavour lives elsewhere", async () => {

    vi.mocked(loadCreditX402Binding).mockReturnValue({ instrument: "x402_exact" });
    const splitMenu: CreditMenu = {
      ...MENU,
      funding: ["x402"],
      x402: {
        schemes: [
          { scheme: "batch-settlement", network: "eip155:84532" },
          { scheme: "exact", network: "eip155:8453" },
        ],
      },
    };

    const outcome = await fundCredit(args({ rail: "x402", menu: splitMenu, providerInfo: {} }));

    expect(outcome).toMatchObject({ status: "refused", rail: "x402" });
    expect(outcome.error?.code).toBe("x402_instrument_unavailable");
    expect(outcome.display).toContain("takes those on Base (eip155:8453)");
    expect(outcome.display).toContain("pinned to Base Sepolia (eip155:84532)");
    expect(outcome.display).not.toContain("now takes x402 top-ups only");
    expect(outcome.hint).toContain("dvm wallet x402-network eip155:8453");
    expect(tryX402Payment).not.toHaveBeenCalled();
    expect(createX402BatchPayment).not.toHaveBeenCalled();
    expect(mockCreditOp).not.toHaveBeenCalled();
  });

  it("names both causes for a channel-bound credit with no recorded chain", async () => {

    vi.mocked(loadCreditX402Binding).mockReturnValue({ instrument: "x402_channel" });
    const splitMenu: CreditMenu = {
      ...MENU,
      funding: ["x402"],
      x402: {
        schemes: [
          { scheme: "exact", network: "eip155:84532" },
          { scheme: "batch-settlement", network: "eip155:8453" },
        ],
      },
    };

    const outcome = await fundCredit(args({ rail: "x402", menu: splitMenu, providerInfo: {} }));

    expect(outcome).toMatchObject({ status: "refused", rail: "x402" });
    expect(outcome.error?.code).toBe("x402_instrument_unavailable");

    expect(outcome.display).toContain("opens channels only on Base (eip155:8453)");
    expect(outcome.display).toContain("tied to the chain it was opened on");
    expect(outcome.display).toContain("wallet is pinned to Base Sepolia (eip155:84532)");

    expect(outcome.hint).toContain("If the channel was opened on Base (eip155:8453)");
    expect(outcome.hint).toContain("dvm wallet x402-network eip155:8453");
    expect(outcome.hint).toContain("fund without --credit-id");
    expect(outcome.hint).toContain(`dvm credit drain ${ENDPOINT}`);
    expect(createX402BatchPayment).not.toHaveBeenCalled();
    expect(tryX402Payment).not.toHaveBeenCalled();
    expect(mockCreditOp).not.toHaveBeenCalled();
  });

  describe("the channel's own chain", () => {

    const splitMenu: CreditMenu = {
      ...MENU,
      funding: ["x402"],
      x402: {
        schemes: [
          { scheme: "exact", network: "eip155:84532" },
          { scheme: "batch-settlement", network: "eip155:8453" },
        ],
      },
    };

    const dualChannelMenu: CreditMenu = {
      ...MENU,
      funding: ["x402"],
      x402: {
        schemes: [
          { scheme: "batch-settlement", network: "eip155:84532" },
          { scheme: "batch-settlement", network: "eip155:8453" },
        ],
      },
    };

    it("records the chain a channel funding rode", async () => {

      vi.mocked(findX402Channel).mockReturnValue({
        channelId: `0x${"44".repeat(32)}`,
        endpoint: ENDPOINT,
        callerPubkey: "caller",
        creditId: "credit-1",
        network: "eip155:8453",
        config: {} as never,
        updatedAt: 1,
      });
      mockCreditOp
        .mockRejectedValueOnce(challenge())
        .mockResolvedValueOnce({ ...fundedResponse(), x402PaymentResponse: "settled-response" });

      await fundCredit(args({ rail: "x402", menu: X402_CHANNEL_MENU, providerInfo: {} }));

      expect(vi.mocked(recordFundResponse).mock.calls[0][0]).toMatchObject({
        rail: "x402",
        x402Instrument: "x402_channel",
        x402ChannelNetwork: "eip155:8453",
      });
    });

    it("offers the re-pin alone where the DVM still opens channels on that chain", async () => {
      vi.mocked(loadCreditX402Binding).mockReturnValue({
        instrument: "x402_channel",
        channelNetwork: "eip155:8453",
      });

      const outcome = await fundCredit(args({ rail: "x402", menu: splitMenu, providerInfo: {} }));

      expect(outcome).toMatchObject({ status: "refused", rail: "x402" });
      expect(outcome.error?.code).toBe("x402_instrument_unavailable");
      expect(outcome.error?.data).toMatchObject({ channel_network: "eip155:8453" });

      expect(outcome.display).toContain("settlement channel on Base (eip155:8453)");
      expect(outcome.display).toContain("still opens channels there");
      expect(outcome.display).toContain("pinned to Base Sepolia (eip155:84532)");
      expect(outcome.hint).toContain("dvm wallet x402-network eip155:8453");

      expect(outcome.hint).not.toContain("--credit-id");
      expect(outcome.hint).not.toContain("If the channel was opened on");
      expect(createX402BatchPayment).not.toHaveBeenCalled();
      expect(mockCreditOp).not.toHaveBeenCalled();
    });

    it("refuses before signing when the wallet moved off the recorded channel chain", async () => {
      vi.mocked(loadCreditX402Binding).mockReturnValue({
        instrument: "x402_channel",
        channelNetwork: "eip155:8453",
      });

      const outcome = await fundCredit(
        args({ rail: "x402", menu: dualChannelMenu, providerInfo: {} })
      );

      expect(outcome).toMatchObject({ status: "refused", rail: "x402" });
      expect(outcome.error?.code).toBe("x402_instrument_unavailable");
      expect(outcome.error?.data).toMatchObject({ channel_network: "eip155:8453" });
      expect(outcome.display).toContain("settlement channel on Base (eip155:8453)");
      expect(outcome.display).toContain("still opens channels there");
      expect(outcome.display).toContain("pinned to Base Sepolia (eip155:84532)");
      expect(outcome.hint).toContain("dvm wallet x402-network eip155:8453");
      expect(outcome.hint).not.toContain("--credit-id");
      expect(createX402BatchPayment).not.toHaveBeenCalled();
      expect(recordPendingX402Funding).not.toHaveBeenCalled();
      expect(mockCreditOp).not.toHaveBeenCalled();
    });

    it("learns a missing chain from the channel store before signing", async () => {
      vi.mocked(loadCreditX402Binding).mockReturnValue({ instrument: "x402_channel" });
      const recorded = {
        channelId: `0x${"44".repeat(32)}` as `0x${string}`,
        endpoint: ENDPOINT,
        callerPubkey: SIGNING.pubkey,
        // An older CLI rewrote this field before a cross-credit refusal, so
        // the credit-scoped lookup misses and the payer-checked fallback
        // supplies the channel that still backs credit-1.
        creditId: "credit-9",
        network: "eip155:8453",
        config: {
          payer: privateKeyToAccount(wallet.privateKey as `0x${string}`).address,
        } as never,
        updatedAt: 1,
      };
      vi.mocked(findX402Channel).mockReturnValueOnce(undefined).mockReturnValueOnce(recorded);
      mockCreditOp.mockRejectedValueOnce(challenge());

      const outcome = await fundCredit(
        args({ rail: "x402", menu: dualChannelMenu, providerInfo: {} })
      );

      expect(outcome).toMatchObject({ status: "refused", rail: "x402" });
      expect(outcome.error?.data).toMatchObject({ channel_network: "eip155:8453" });
      expect(outcome.display).toContain("settlement channel on Base (eip155:8453)");
      expect(outcome.hint).toContain("dvm wallet x402-network eip155:8453");
      expect(assertX402RequirementDescribesChannel).toHaveBeenCalledWith(
        expect.objectContaining({ recorded })
      );
      expect(createX402BatchPayment).not.toHaveBeenCalled();
      expect(recordPendingX402Funding).not.toHaveBeenCalled();
      expect(mockCreditOp).toHaveBeenCalledTimes(1);
    });

    it("ignores a fallback whose channel id the DVM challenge does not derive", async () => {
      vi.mocked(loadCreditX402Binding).mockReturnValue({ instrument: "x402_channel" });
      const unrelated = {
        channelId: `0x${"55".repeat(32)}` as `0x${string}`,
        endpoint: ENDPOINT,
        callerPubkey: SIGNING.pubkey,
        creditId: "credit-9",
        network: "eip155:8453",
        config: {
          payer: privateKeyToAccount(wallet.privateKey as `0x${string}`).address,
        } as never,
        updatedAt: 2,
      };
      vi.mocked(findX402Channel).mockReturnValueOnce(undefined).mockReturnValueOnce(unrelated);
      vi.mocked(assertX402RequirementDescribesChannel).mockImplementation(() => {
        throw new DvmError("x402_channel_mismatch", "Different channel.");
      });
      mockCreditOp
        .mockRejectedValueOnce(challenge())
        .mockResolvedValueOnce({ ...fundedResponse(), x402PaymentResponse: "settled-response" });

      const outcome = await fundCredit(
        args({ rail: "x402", menu: dualChannelMenu, providerInfo: {} })
      );

      expect(outcome).toMatchObject({ status: "funded", x402Flavour: "batch-settlement" });
      expect(assertX402RequirementDescribesChannel).toHaveBeenCalledWith(
        expect.objectContaining({ recorded: unrelated })
      );
      expect(createX402BatchPayment).toHaveBeenCalledTimes(1);
      expect(recordPendingX402Funding).toHaveBeenCalledTimes(1);
    });

    it("refuses changed terms for an exact credit-scoped channel before signing", async () => {
      vi.mocked(loadCreditX402Binding).mockReturnValue({ instrument: "x402_channel" });
      const recorded = {
        channelId: `0x${"44".repeat(32)}` as `0x${string}`,
        endpoint: ENDPOINT,
        callerPubkey: SIGNING.pubkey,
        creditId: "credit-1",
        network: "eip155:8453",
        config: {
          payer: privateKeyToAccount(wallet.privateKey as `0x${string}`).address,
        } as never,
        updatedAt: 1,
      };
      vi.mocked(findX402Channel).mockReturnValue(recorded);
      vi.mocked(assertX402RequirementDescribesChannel).mockImplementation(() => {
        throw new DvmError("x402_channel_mismatch", "The DVM's terms derive another channel.");
      });
      mockCreditOp.mockRejectedValueOnce(challenge());

      const outcome = await fundCredit(
        args({ rail: "x402", menu: dualChannelMenu, providerInfo: {} })
      );

      expect(outcome).toMatchObject({ status: "refused", rail: "x402" });
      expect(outcome.error?.code).toBe("x402_channel_mismatch");
      expect(createX402BatchPayment).not.toHaveBeenCalled();
      expect(recordPendingX402Funding).not.toHaveBeenCalled();
      expect(mockCreditOp).toHaveBeenCalledTimes(1);
    });

    it("refuses a retired chain for an exact credit-scoped channel before signing", async () => {
      vi.mocked(loadCreditX402Binding).mockReturnValue({ instrument: "x402_channel" });
      vi.mocked(findX402Channel).mockReturnValue({
        channelId: `0x${"44".repeat(32)}`,
        endpoint: ENDPOINT,
        callerPubkey: SIGNING.pubkey,
        creditId: "credit-1",
        network: "eip155:8453",
        config: {
          payer: privateKeyToAccount(wallet.privateKey as `0x${string}`).address,
        } as never,
        updatedAt: 1,
      });
      vi.mocked(assertX402RequirementDescribesChannel).mockImplementation(() => {
        throw new DvmError("x402_batch_not_offered", "The recorded chain was retired.");
      });
      mockCreditOp.mockRejectedValueOnce(challenge());

      const outcome = await fundCredit(
        args({ rail: "x402", menu: X402_EXACT_MENU, providerInfo: {} })
      );

      expect(outcome).toMatchObject({ status: "refused", rail: "x402" });
      expect(outcome.error?.code).toBe("x402_instrument_unavailable");
      expect(outcome.error?.data).toMatchObject({ channel_network: "eip155:8453" });
      expect(createX402BatchPayment).not.toHaveBeenCalled();
      expect(recordPendingX402Funding).not.toHaveBeenCalled();
      expect(mockCreditOp).toHaveBeenCalledTimes(1);
    });

    it("does not trust a channel-store chain controlled by another wallet", async () => {
      vi.mocked(loadCreditX402Binding).mockReturnValue({ instrument: "x402_channel" });
      vi.mocked(findX402Channel).mockReturnValue({
        channelId: `0x${"44".repeat(32)}`,
        endpoint: ENDPOINT,
        callerPubkey: SIGNING.pubkey,
        creditId: "credit-1",
        network: "eip155:8453",
        config: { payer: `0x${"77".repeat(20)}` } as never,
        updatedAt: 1,
      });

      const outcome = await fundCredit(
        args({ rail: "x402", menu: dualChannelMenu, providerInfo: {} })
      );

      expect(outcome).toMatchObject({ status: "refused", rail: "x402" });
      expect(outcome.error?.code).toBe("x402_wallet_mismatch");
      expect(createX402BatchPayment).not.toHaveBeenCalled();
      expect(recordPendingX402Funding).not.toHaveBeenCalled();
      expect(mockCreditOp).not.toHaveBeenCalled();
    });

    it("still funds on the wallet's chain when the channel chain is unknown", async () => {
      vi.mocked(loadCreditX402Binding).mockReturnValue({ instrument: "x402_channel" });
      mockCreditOp
        .mockRejectedValueOnce(challenge())
        .mockResolvedValueOnce({ ...fundedResponse(), x402PaymentResponse: "settled-response" });

      const outcome = await fundCredit(
        args({ rail: "x402", menu: dualChannelMenu, providerInfo: {} })
      );

      expect(outcome).toMatchObject({ status: "funded", x402Flavour: "batch-settlement" });
      expect(createX402BatchPayment).toHaveBeenCalledTimes(1);
      expect(recordPendingX402Funding).toHaveBeenCalledTimes(1);
    });

    it("offers drain or a separate credit alone where the DVM has left that chain", async () => {

      vi.mocked(loadCreditX402Binding).mockReturnValue({
        instrument: "x402_channel",
        channelNetwork: "eip155:137",
      });

      const outcome = await fundCredit(args({ rail: "x402", menu: splitMenu, providerInfo: {} }));

      expect(outcome).toMatchObject({ status: "refused", rail: "x402" });
      expect(outcome.error?.code).toBe("x402_instrument_unavailable");
      expect(outcome.display).toContain("settlement channel on Polygon (eip155:137)");
      expect(outcome.display).toContain("no longer opens channels there");
      expect(outcome.display).toContain("only on Base (eip155:8453)");
      expect(outcome.hint).toContain("Fund without --credit-id");
      expect(outcome.hint).toContain(`dvm credit drain ${ENDPOINT}`);

      expect(outcome.hint).toContain("takes one-off x402 payments on Base Sepolia (eip155:84532)");
      expect(outcome.hint).not.toContain("x402-network");
      expect(createX402BatchPayment).not.toHaveBeenCalled();
      expect(mockCreditOp).not.toHaveBeenCalled();
    });

    it("names the chain at a DVM that has dropped channels everywhere", async () => {
      vi.mocked(loadCreditX402Binding).mockReturnValue({
        instrument: "x402_channel",
        channelNetwork: "eip155:8453",
      });

      const outcome = await fundCredit(
        args({ rail: "x402", menu: X402_EXACT_MENU, providerInfo: {} })
      );

      expect(outcome).toMatchObject({ status: "refused", rail: "x402" });
      expect(outcome.display).toContain("settlement channel on Base (eip155:8453)");
      expect(outcome.display).toContain("only as one-off payments");
      expect(outcome.hint).toContain("Fund without --credit-id");
      expect(outcome.hint).not.toContain("x402-network");
    });
  });

  it("adopts the binding a discovery-probe refusal names, before anything is signed", async () => {

    const channelId = `0x${"44".repeat(32)}` as const;
    vi.mocked(findX402Channel).mockReturnValue({
      channelId,
      endpoint: ENDPOINT,
      callerPubkey: SIGNING.pubkey,
      creditId: "credit-9",
      network: "eip155:8453",
      config: {
        payer: privateKeyToAccount(wallet.privateKey as `0x${string}`).address,
      } as never,
      updatedAt: 1,
    });
    mockCreditOp.mockRejectedValueOnce(
      bindingRefusal({ credit_instrument: "x402_channel", credit_channel_id: channelId })
    );

    const outcome = await fundCredit(
      args({ rail: "x402", menu: X402_EXACT_MENU, providerInfo: {} })
    );

    expect(outcome).toMatchObject({ status: "refused" });
    expect(tryX402Payment).not.toHaveBeenCalled();
    expect(recordCreditX402Instrument).toHaveBeenCalledWith(
      ENDPOINT,
      SIGNING.pubkey,
      "credit-1",
      "x402_channel",
      undefined,
      "eip155:8453"
    );
  });

  it("adopts the binding a post-payment refusal names on the exact leg", async () => {
    mockCreditOp
      .mockRejectedValueOnce(challenge())
      .mockRejectedValueOnce(bindingRefusal({ credit_instrument: "x402_channel" }));

    await fundCredit(args({ rail: "x402", menu: X402_EXACT_MENU, providerInfo: {} }));

    expect(recordCreditX402Instrument).toHaveBeenCalledWith(
      ENDPOINT,
      SIGNING.pubkey,
      "credit-1",
      "x402_channel",
      undefined
    );
  });

  it.each([
    ["another DVM", { endpoint: "https://other.example", callerPubkey: SIGNING.pubkey }],
    ["another caller", { endpoint: ENDPOINT, callerPubkey: "cc".repeat(32) }],
  ])("does not learn a refusal channel's chain from %s", async (_label, location) => {
    const channelId = `0x${"44".repeat(32)}` as const;
    vi.mocked(findX402Channel).mockReturnValue({
      channelId,
      ...location,
      creditId: "credit-9",
      network: "eip155:8453",
      config: {
        payer: privateKeyToAccount(wallet.privateKey as `0x${string}`).address,
      } as never,
      updatedAt: 1,
    });
    mockCreditOp.mockRejectedValueOnce(
      bindingRefusal({ credit_instrument: "x402_channel", credit_channel_id: channelId })
    );

    await fundCredit(args({ rail: "x402", menu: X402_EXACT_MENU, providerInfo: {} }));

    expect(recordCreditX402Instrument).toHaveBeenCalledWith(
      ENDPOINT,
      SIGNING.pubkey,
      "credit-1",
      "x402_channel",
      undefined
    );
    expect(vi.mocked(recordCreditX402Instrument).mock.calls[0]).toHaveLength(5);
  });

  it("does not adopt the instrument of a channel another credit owns", async () => {

    mockCreditOp.mockRejectedValueOnce(
      bindingRefusal({
        credit_instrument: "x402_channel",
        credit_channel_id: `0x${"44".repeat(32)}`,
        bound_credit_id: "credit-9",
      })
    );

    await fundCredit(args({ rail: "x402", menu: X402_EXACT_MENU, providerInfo: {} }));

    expect(recordCreditX402Instrument).not.toHaveBeenCalled();
  });

  it("does not adopt an instrument from another rail's binding", async () => {
    mockCreditOp.mockRejectedValueOnce(
      bindingRefusal({ credit_rail: "tempo", credit_instrument: "tempo_session" })
    );

    await fundCredit(args({ rail: "x402", menu: X402_EXACT_MENU, providerInfo: {} }));

    expect(recordCreditX402Instrument).not.toHaveBeenCalled();
  });
});

describe("pollPendingCreditFundings over x402", () => {
  const wallet = {
    privateKey: `0x${"11".repeat(32)}`,
    address: "",
    network: "eip155:84532",
  };

  beforeEach(() => {
    vi.mocked(loadX402Wallet).mockReturnValue(wallet);
  });

  function entry(creditId: string): PendingX402Funding {
    return {
      endpoint: ENDPOINT,
      callerPubkey: SIGNING.pubkey,
      creditId,
      fundId: `fund-${creditId}`,
      amountMicro: 100_000,
      targetMicro: 100_000,
      paymentHeader: `header-${creditId}`,
      channelId: `0x${"44".repeat(32)}` as `0x${string}`,
      requestedAt: Date.now(),
      maxClaimableMicro: "100000",
    };
  }

  it("keeps sweeping after one entry throws", async () => {
    const [first, second] = [entry("credit-a"), entry("credit-b")];
    vi.mocked(listResumableX402Fundings).mockReturnValue([first, second]);
    vi.mocked(loadResumableX402Funding).mockImplementation((a: { creditId: string }) =>
      a.creditId === "credit-a" ? first : second
    );
    mockCreditOp
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({ ...fundedResponse(), replayed: true });

    await pollPendingCreditFundings({
      transport,
      ref: { endpoint: ENDPOINT },
      signing: SIGNING,
      signBody: (_privkey, body) => ({ ...body, signature: "sig" }),
    });

    expect(mockCreditOp).toHaveBeenCalledTimes(2);
    expect(acknowledgeReplayedX402Payment).toHaveBeenCalledWith("header-credit-b");
  });

  it("never signs a fresh payment for an entry a sibling already retired", async () => {
    vi.mocked(listResumableX402Fundings).mockReturnValue([entry("credit-a")]);
    vi.mocked(loadResumableX402Funding).mockReturnValue(undefined);

    await pollPendingCreditFundings({
      transport,
      ref: { endpoint: ENDPOINT },
      signing: SIGNING,
      signBody: (_privkey, body) => ({ ...body, signature: "sig" }),
    });

    expect(mockCreditOp).not.toHaveBeenCalled();
    expect(createX402BatchPayment).not.toHaveBeenCalled();
  });

  it("leaves a refused entry out of the sweep entirely", async () => {
    vi.mocked(listResumableX402Fundings).mockReturnValue([]);
    vi.mocked(listPendingX402Fundings).mockReturnValue([
      { ...entry("credit-refused"), refusedAt: Date.now() },
    ]);

    await pollPendingCreditFundings({
      transport,
      ref: { endpoint: ENDPOINT },
      signing: SIGNING,
      signBody: (_privkey, body) => ({ ...body, signature: "sig" }),
    });

    expect(mockCreditOp).not.toHaveBeenCalled();
    expect(createX402BatchPayment).not.toHaveBeenCalled();
  });
});

describe("pollPendingCreditFundings over exact x402", () => {
  const wallet = {
    privateKey: `0x${"11".repeat(32)}`,
    address: "",
    network: "eip155:84532",
  };

  beforeEach(() => {
    vi.mocked(loadX402Wallet).mockReturnValue(wallet);
  });

  function exactEntry(creditId: string): PendingX402ExactFunding {
    return {
      endpoint: ENDPOINT,
      callerPubkey: SIGNING.pubkey,
      creditId,
      fundId: `fund-${creditId}`,
      amountMicro: 100_000,
      targetMicro: 400_000,
      paymentHeader: `header-${creditId}`,
      x402Version: 2,
      amountMsats: 1_000_000,
      btcRate: 100_000,
      requestedAt: Date.now(),
      authorizationValidBefore: "1900000000",
    };
  }

  it("keeps sweeping after one entry throws", async () => {
    const [first, second] = [exactEntry("credit-a"), exactEntry("credit-b")];
    vi.mocked(listResumableX402ExactFundings).mockReturnValue([first, second]);
    vi.mocked(loadResumableX402ExactFunding).mockImplementation((a: { creditId: string }) =>
      a.creditId === "credit-a" ? first : second
    );
    mockCreditOp
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({ ...fundedResponse(), replayed: true });

    await pollPendingCreditFundings({
      transport,
      ref: { endpoint: ENDPOINT },
      signing: SIGNING,
      signBody: (_privkey, body) => ({ ...body, signature: "sig" }),
    });

    expect(mockCreditOp).toHaveBeenCalledTimes(2);
    expect(mockCreditOp.mock.calls[1][2]).toMatchObject({ x402Payment: "header-credit-b" });

    expect(clearPendingX402ExactFunding).toHaveBeenCalledTimes(1);
    expect(clearPendingX402ExactFunding).toHaveBeenCalledWith(
      expect.objectContaining({ fundId: "fund-credit-b" })
    );

    expect(recordFundResponse).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetMicro: 400_000 })
    );
  });

  it("never signs a fresh authorization for an entry a sibling already retired", async () => {
    vi.mocked(listResumableX402ExactFundings).mockReturnValue([exactEntry("credit-a")]);

    vi.mocked(loadResumableX402ExactFunding).mockReturnValue(undefined);
    vi.mocked(loadResumableTempoChargeFunding).mockReturnValue(undefined);
    vi.mocked(listResumableTempoChargeFundings).mockReturnValue([]);

    await pollPendingCreditFundings({
      transport,
      ref: { endpoint: ENDPOINT },
      signing: SIGNING,
      signBody: (_privkey, body) => ({ ...body, signature: "sig" }),
    });

    expect(mockCreditOp).not.toHaveBeenCalled();
    expect(tryX402Payment).not.toHaveBeenCalled();
    expect(recordPendingX402ExactFunding).not.toHaveBeenCalled();
  });

  it("presents nothing while no x402 wallet is connected", async () => {
    vi.mocked(loadX402Wallet).mockReturnValue(null);
    vi.mocked(listResumableX402ExactFundings).mockReturnValue([exactEntry("credit-a")]);
    vi.mocked(loadResumableX402ExactFunding).mockReturnValue(exactEntry("credit-a"));

    await pollPendingCreditFundings({
      transport,
      ref: { endpoint: ENDPOINT },
      signing: SIGNING,
      signBody: (_privkey, body) => ({ ...body, signature: "sig" }),
    });

    expect(mockCreditOp).not.toHaveBeenCalled();
    expect(clearPendingX402ExactFunding).not.toHaveBeenCalled();
  });
});

/** Skip only settlement delays with fake timers; keep the polling order and outcomes real. */
async function fundExhaustingSettlementPoll(
  run: () => Promise<CreditFundOutcome>
): Promise<CreditFundOutcome> {
  vi.useFakeTimers();
  try {
    const pending = run();
    await vi.runAllTimersAsync();
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

describe("fundCredit over Lightning", () => {
  it("pays the DVM's invoice through fundViaFloat and re-posts to settle it", async () => {
    vi.mocked(fundViaFloat).mockResolvedValueOnce({
      outcome: "paid",
      principalMsats: 100_000,
      routingFeeMsats: 5_000,
      walletDebitMsats: 105_000,
      totalWalletFeeMsats: 5_000,
      unitemizedWalletFeeMsats: 0,
      btcRate: 100_000,
    });
    mockCreditOp.mockRejectedValueOnce(pendingInvoice()).mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(args({ rail: "lightning" }));

    expect(outcome.status).toBe("funded");
    expect(outcome.rail).toBe("lightning");
    expect(outcome.reconciled).toBeUndefined();
    expect(outcome.creditId).toBe("credit-1");
    expect(outcome.display).toContain("of prepaid credit at");
    expect(outcome.paymentOutcome).toBe("paid");
    expect(outcome).toMatchObject({
      spentSats: 105,
      principalSats: 100,
      routingFeeSats: 5,
      walletDebitSats: 105,
    });

    expect(fundViaFloat).toHaveBeenCalledTimes(1);
    expect(emitFloatBudgetWarning).toHaveBeenCalledWith({
      float: expect.anything(),
      operation: "credit_funding",
      principalMsats: 100_000,
      human: undefined,
    });
    expect(vi.mocked(emitFloatBudgetWarning).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(fundViaFloat).mock.invocationCallOrder[0]
    );
    expect(vi.mocked(fundViaFloat).mock.calls[0][0]).toMatchObject({
      bolt11: "lnbcrt1000n1stub",
      amountMsats: 100_000,

      reference: "credit:credit-1",
      counterparty: ENDPOINT,
      label: "credit funding · fund-1",
    });

    const [, body] = mockCreditOp.mock.calls[0];
    expect(body).toMatchObject({
      op: "fund",
      credit_id: "credit-1",
      fund: { amount_micro: 100_000, fund_id: "fund-1", method: "lightning" },
    });
    expect((body as { fund: Record<string, unknown> }).fund.commitment).toBeUndefined();

    expect(recordPendingFunding).toHaveBeenCalledTimes(3);
    expect(vi.mocked(recordPendingFunding).mock.calls[0][0]).toMatchObject({
      creditId: "credit-1",
      fundId: "fund-1",
      amountMicro: 100_000,
      rail: "lightning",
    });
    expect(vi.mocked(recordPendingFunding).mock.calls[0][0].bolt11).toBeUndefined();
    expect(vi.mocked(recordPendingFunding).mock.calls[1][0]).toMatchObject({
      bolt11: "lnbcrt1000n1stub",
      paymentHash: "ab".repeat(32),
      amountMsats: 100_000,
    });
    expect(vi.mocked(recordPendingFunding).mock.calls[2][0]).toMatchObject({
      principalMsats: 100_000,
      routingFeeMsats: 5_000,
      walletDebitMsats: 105_000,
      paymentOutcome: "paid",
    });
    expect(vi.mocked(recordPendingFunding).mock.invocationCallOrder[0]).toBeLessThan(
      mockCreditOp.mock.invocationCallOrder[0]
    );
    expect(clearPendingFunding).toHaveBeenCalledWith(
      ENDPOINT,
      SIGNING.pubkey,
      "credit-1",
      "fund-1"
    );

    expect(mockCreditOp.mock.calls[1][1]).toMatchObject({
      credit_id: "credit-1",
      fund: { fund_id: "fund-1" },
    });
    expect(recordFundResponse).toHaveBeenCalledWith(
      expect.objectContaining({ rail: "lightning", targetMicro: expect.any(Number) })
    );
  });

  it("checks the local cap before an invoice exists — a refusal strands nothing", async () => {
    vi.mocked(assertFloatBudget).mockRejectedValueOnce(
      new DvmError("budget_exceeded", "Daily budget would be exceeded.", undefined, {
        display: "That would go over the daily cap you set.",
      })
    );

    const outcome = await fundCredit(args({ rail: "lightning" }));

    expect(outcome.status).toBe("refused");

    expect(mockCreditOp).not.toHaveBeenCalled();
    expect(fundViaFloat).not.toHaveBeenCalled();
    expect(outcome.display).toContain("daily cap");
  });

  it("reports a wallet refusal with its relayable prose, and funds nothing", async () => {
    mockCreditOp.mockRejectedValueOnce(pendingInvoice());
    vi.mocked(fundViaFloat).mockRejectedValueOnce(
      new DvmError("float_quota_exceeded", "Budget exhausted.", undefined, {
        display: "Your Lightning wallet has hit the spending limit you set.",
      })
    );

    const outcome = await fundCredit(args({ rail: "lightning" }));

    expect(outcome.status).toBe("refused");
    expect(outcome.error?.code).toBe("float_quota_exceeded");
    expect(outcome.display).toContain("spending limit");

    expect(mockCreditOp).toHaveBeenCalledTimes(1);
  });

  it("reports paid-but-unobserved rather than failing — crediting is pull-based", async () => {
    mockCreditOp.mockRejectedValue(pendingInvoice());

    const outcome = await fundExhaustingSettlementPoll(() =>
      fundCredit(args({ rail: "lightning" }))
    );

    expect(outcome.status).toBe("settlement_pending");
    expect(outcome.spentSats).toBe(100);
    expect(outcome.display).toContain("next call");

    expect(fundViaFloat).toHaveBeenCalledTimes(1);
    expect(recordPendingFunding).toHaveBeenLastCalledWith(
      expect.objectContaining({
        creditId: "credit-1",
        fundId: "fund-1",
        bolt11: "lnbcrt1000n1stub",
      })
    );
    expect(clearPendingFunding).not.toHaveBeenCalled();
  });

  it("answers a replayed funding from the 200, without paying again", async () => {
    mockCreditOp.mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(args({ rail: "lightning" }));

    expect(outcome.status).toBe("funded");
    expect(fundViaFloat).not.toHaveBeenCalled();
  });

  it("resumes the durable ids and amount before considering fresh flags or another payment", async () => {
    const pending = pendingFunding({ endpoint: ALIAS_ENDPOINT });
    vi.mocked(loadPendingFunding).mockReturnValue(pending);
    mockCreditOp.mockResolvedValueOnce(fundedResponse(200_000));

    const outcome = await fundCredit(
      args({
        fundId: "fund-fresh",
        amountMicro: 999_000,
        rail: "cashu",
      })
    );

    expect(outcome).toMatchObject({
      status: "funded",
      rail: "lightning",
      creditId: "credit-1",
      fundId: "fund-original",
    });
    expect(mockCreditOp).toHaveBeenCalledTimes(1);
    expect(mockCreditOp.mock.calls[0][0]).toEqual({ endpoint: ALIAS_ENDPOINT });
    expect(mockCreditOp.mock.calls[0][1]).toMatchObject({
      credit_id: "credit-1",
      fund: {
        amount_micro: 100_000,
        fund_id: "fund-original",
        method: "lightning",
      },
    });
    expect(fundViaFloat).not.toHaveBeenCalled();
    expect(clearPendingFunding).toHaveBeenCalledWith(
      ALIAS_ENDPOINT,
      SIGNING.pubkey,
      "credit-1",
      "fund-original"
    );
  });

  it("clears an expired pending invoice without putting its funding ids back on the wire", async () => {
    const expired = pendingFunding({ expiresAtMs: Date.now() - 1 });
    vi.mocked(listPendingFundings).mockReturnValue([expired]);

    await pollPendingCreditFundings({
      transport,
      ref: { endpoint: ENDPOINT },
      signing: SIGNING,
      signBody: (_privkey, body) => body,
    });

    expect(mockCreditOp).not.toHaveBeenCalled();
    expect(fundViaFloat).not.toHaveBeenCalled();
    expect(clearPendingFunding).toHaveBeenCalledWith(
      ENDPOINT,
      SIGNING.pubkey,
      "credit-1",
      "fund-original"
    );
  });

  it("keeps a post-payment timeout pending — the money moved, only the news didn't", async () => {
    mockCreditOp
      .mockRejectedValueOnce(pendingInvoice())
      .mockRejectedValue(new DvmError("timeout", "The DVM did not answer in time."));

    const outcome = await fundExhaustingSettlementPoll(() =>
      fundCredit(args({ rail: "lightning" }))
    );

    expect(outcome.status).toBe("settlement_pending");
    expect(outcome.spentSats).toBe(100);
    expect(outcome.paymentOutcome).toBe("paid");
    expect(outcome.error?.code).toBe("timeout");
    expect(outcome.display).toContain("couldn't be reached");
    expect(fundViaFloat).toHaveBeenCalledTimes(1);
  });

  it("carries the spend on a post-payment refusal, and never pays a second rail", async () => {
    vi.mocked(prepareAgentSpend).mockImplementation(preparedSpend() as never);
    mockCreditOp.mockRejectedValueOnce(pendingInvoice()).mockRejectedValue(

      new DvmError("payment_invalid", "Bound to cashu.", undefined, { credit_rail: "cashu" })
    );

    const outcome = await fundCredit(args({ rail: "lightning" }));

    expect(outcome.status).toBe("refused");
    expect(outcome.spentSats).toBe(100);
    expect(outcome.paymentOutcome).toBe("paid");
    expect(outcome.display).toContain("100 sats");
    expect(outcome.requiredRail).toBeUndefined();
    expect(prepareAgentSpend).not.toHaveBeenCalled();
    expect(fundViaFloat).toHaveBeenCalledTimes(1);
  });

  it("relays paid-and-never-creditable as refused, not as pending", async () => {
    mockCreditOp.mockRejectedValueOnce(pendingInvoice()).mockRejectedValue(

      new DvmError(
        "credit_funding_unrecorded",
        "The payment was accepted but no funding was recorded against the credit.",
        "Do not retry: the payment already settled.",
        { retryable: false }
      )
    );

    const outcome = await fundCredit(args({ rail: "lightning" }));

    expect(outcome.status).toBe("refused");
    expect(outcome.spentSats).toBe(100);
    expect(outcome.display).toContain("100 sats");
    expect(outcome.display).not.toContain("nothing is lost");
    expect(outcome.hint).toContain("Don't fund again");

    expect(mockCreditOp).toHaveBeenCalledTimes(2);
  });

  it("never relays 'nothing was charged' once the float has paid", async () => {
    mockCreditOp.mockRejectedValueOnce(pendingInvoice()).mockRejectedValue(

      new DvmError(
        "lightning_invoice_expired",
        "The invoice expired without being paid.",
        undefined,
        {
          retryable: false,
          display:
            "The Lightning invoice for this top-up expired before it was paid. Nothing was charged.",
        }
      )
    );

    const outcome = await fundCredit(args({ rail: "lightning" }));

    expect(outcome.status).toBe("refused");
    expect(outcome.display).toContain("100 sats went out");
    expect(outcome.display).not.toContain("Nothing was charged");
  });

  it("follows an operator's repair to the credit the balance actually landed on", async () => {

    mockCreditOp.mockRejectedValueOnce(pendingInvoice()).mockResolvedValueOnce({
      ...fundedResponse(),
      reconciled: true,
      credit: { ...(fundedResponse().credit as object), credit_id: "rescued-credit" },
      display: "The provider's operator credited it to rescued-credit instead.",
      hint: "Your balance is on credit_id rescued-credit, not credit-1.",
    });

    const outcome = await fundCredit(args({ rail: "lightning" }));

    expect(outcome.status).toBe("funded");
    expect(outcome.reconciled).toBe(true);
    expect(outcome.creditId).toBe("rescued-credit");

    expect(outcome.display).toContain("on credit rescued-credit rather than the one this funding");
    expect(outcome.display).not.toContain("The provider's operator credited it");
    expect(outcome.display).toContain("invoice principal 100 sats");
    expect(outcome.hint).toContain("rescued-credit");
    expect(outcome.hint).not.toContain("Your balance is on credit_id");
    expect(outcome.providerDisplay).toBe(
      "The provider's operator credited it to rescued-credit instead."
    );
    expect(outcome.providerHint).toBe("Your balance is on credit_id rescued-credit, not credit-1.");

    expect(outcome.fundId).toBe("fund-1");
  });
});

describe("fundCredit rail selection", () => {
  it("spends held ecash before reaching for the Lightning wallet", async () => {
    vi.mocked(prepareAgentSpend).mockImplementation(preparedSpend() as never);
    mockCreditOp.mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(args());

    expect(outcome.rail).toBe("cashu");
    expect(fundViaFloat).not.toHaveBeenCalled();
    expect(recordSpend).toHaveBeenCalledWith(expect.objectContaining({ kind: "credit_fund" }));
  });

  it("falls through to Lightning when the wallet can't cover the funding", async () => {
    vi.mocked(prepareAgentSpend).mockResolvedValue({
      error: { code: "insufficient_balance", message: "Not enough sats.", hint: "Fund it." },
    });
    mockCreditOp.mockRejectedValueOnce(pendingInvoice()).mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(args());

    expect(outcome.status).toBe("funded");
    expect(outcome.rail).toBe("lightning");
    expect(fundViaFloat).toHaveBeenCalledTimes(1);
  });

  it("funds over ecash when the menu advertises x402 with no channel behind it", async () => {

    vi.mocked(loadX402Wallet).mockReturnValue({
      privateKey: `0x${"11".repeat(32)}`,
      address: "",
      network: "eip155:84532",
    });
    vi.mocked(prepareAgentSpend).mockImplementation(preparedSpend() as never);
    mockCreditOp.mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(args({ menu: { ...MENU, funding: ["x402", "cashu"] } }));

    expect(outcome).toMatchObject({ status: "funded", rail: "cashu" });
    expect(createX402BatchPayment).not.toHaveBeenCalled();
  });

  it("stands down when no rail can be used, without touching the wire", async () => {
    const outcome = await fundCredit(args({ providerInfo: {}, float: null }));

    expect(outcome.status).toBe("unavailable");
    expect(mockCreditOp).not.toHaveBeenCalled();
    expect(fundViaFloat).not.toHaveBeenCalled();
  });

  it("retries on the rail a credit is bound to, and drops the doomed spend", async () => {
    vi.mocked(prepareAgentSpend).mockImplementation(preparedSpend() as never);

    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_invalid", "Bound to lightning.", undefined, {
          credit_rail: "lightning",
        })
      )
      .mockRejectedValueOnce(pendingInvoice())
      .mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(args());

    expect(outcome.status).toBe("funded");
    expect(outcome.rail).toBe("lightning");

    expect(abandonPendingSubmission).toHaveBeenCalledWith({
      requestId: "44444444-4444-4444-8444-444444444444",
    });
  });

  it("blames the local wallet, not the DVM, when a forced rail has nothing to pay with", async () => {

    const outcome = await fundCredit(args({ rail: "lightning", menu: undefined, float: null }));

    expect(outcome.status).toBe("unavailable");
    expect(outcome.hint).toContain("dvm wallet connect");
    expect(outcome.hint).not.toContain("advertises");
  });

  it("points a forced Tempo rail with no wallet at tempo-connect, not Cashu", async () => {
    const outcome = await fundCredit(
      args({
        rail: "tempo",
        menu: {
          ...MENU,
          funding: ["tempo"],
          tempo: { methods: [{ method: "tempo", intent: "charge" }] },
        },
        providerInfo: {},
        float: null,
        tempoAccount: null,
      })
    );

    expect(outcome.status).toBe("unavailable");
    expect(outcome.hint).toContain("dvm wallet tempo-connect");
    expect(outcome.hint).not.toMatch(/cashu|ecash/i);
  });

  it("names the missing Tempo intent when the wallet is already connected", async () => {
    const outcome = await fundCredit(
      args({
        rail: "tempo",
        menu: { ...MENU, funding: ["tempo"], tempo: { methods: [] } },
        providerInfo: {},
        float: null,
        tempoAccount: {
          privateKey: `0x${"11".repeat(32)}`,
          address: `0x${"22".repeat(20)}`,
        },
      })
    );

    expect(outcome.status).toBe("unavailable");
    expect(outcome.hint).toContain("names no supported Tempo charge or session intent");
    expect(outcome.hint).not.toContain("tempo-connect");
    expect(outcome.hint).not.toMatch(/cashu|ecash/i);
  });

  it("names the menu when the DVM is the one that doesn't take the forced rail", async () => {
    const outcome = await fundCredit(
      args({ rail: "lightning", menu: { ...MENU, funding: ["cashu"] } })
    );

    expect(outcome.status).toBe("unavailable");
    expect(outcome.hint).toContain("advertises credit funding over cashu");
  });

  it("points a forced x402 wallet on the wrong chain at the keyless re-pin verb", async () => {
    vi.mocked(loadX402Wallet).mockReturnValue({
      privateKey: `0x${"11".repeat(32)}`,
      address: "",
      network: "eip155:8453",
    });

    const outcome = await fundCredit(
      args({ rail: "x402", menu: X402_MENU, providerInfo: {}, float: null })
    );

    expect(outcome.status).toBe("unavailable");
    expect(outcome.hint).toContain("Base Sepolia (eip155:84532)");
    expect(outcome.hint).toContain("Base (eip155:8453)");
    expect(outcome.hint).toContain("dvm wallet x402-network eip155:84532");
    expect(outcome.hint).not.toContain("--key-file");
    expect(outcome.hint).not.toContain("--force");
  });

  it("keeps an unknown menu-sourced x402 chain relayable as its raw id", async () => {
    vi.mocked(loadX402Wallet).mockReturnValue({
      privateKey: `0x${"11".repeat(32)}`,
      address: "",
      network: "eip155:8453",
    });
    const menu: CreditMenu = {
      ...MENU,
      funding: ["x402"],
      x402: { schemes: [{ scheme: "exact", network: "eip155:999999" }] },
    };

    const outcome = await fundCredit(args({ rail: "x402", menu, providerInfo: {}, float: null }));

    expect(outcome.status).toBe("unavailable");
    expect(outcome.hint).toContain("on eip155:999999");
    expect(outcome.hint).toContain("dvm wallet x402-network eip155:999999");
    expect(outcome.hint).not.toContain("undefined");
  });

  it("treats an unreachable receive wallet as this-rail-only, not a refusal", async () => {
    mockCreditOp.mockRejectedValueOnce(
      new DvmError("lightning_unavailable", "No invoice right now.")
    );

    const outcome = await fundCredit(args({ rail: "lightning" }));

    expect(outcome.status).toBe("unavailable");
    expect(fundViaFloat).not.toHaveBeenCalled();
  });
});

describe("the receive floor", () => {

  const FLOOR_MENU: CreditMenu = { ...MENU, lightning_min_micro: 57_500 };

  describe("preferLightningFirst", () => {
    it("keys on the advertised floor: at/above prefers lightning, below does not", () => {
      expect(preferLightningFirst(FLOOR_MENU, 57_500)).toBe(true);
      expect(preferLightningFirst(FLOOR_MENU, 100_000)).toBe(true);
      expect(preferLightningFirst(FLOOR_MENU, 57_499)).toBe(false);
    });

    it("never invents a floor the DVM didn't state", () => {
      expect(preferLightningFirst(MENU, 5_000_000)).toBe(false);
      expect(preferLightningFirst(undefined, 5_000_000)).toBe(false);
    });
  });

  it("sends a floor-clearing funding to the float first — large goes direct", async () => {
    mockCreditOp.mockRejectedValueOnce(pendingInvoice()).mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(args({ menu: FLOOR_MENU, amountMicro: 100_000 }));

    expect(outcome.status).toBe("funded");
    expect(outcome.rail).toBe("lightning");

    expect(prepareAgentSpend).not.toHaveBeenCalled();
    expect(fundViaFloat).toHaveBeenCalledTimes(1);
  });

  it("keeps cashu first below the floor — small stays with the pocket", async () => {
    vi.mocked(prepareAgentSpend).mockImplementation(preparedSpend() as never);
    mockCreditOp.mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(args({ menu: FLOOR_MENU, amountMicro: 30_000 }));

    expect(outcome.status).toBe("funded");
    expect(outcome.rail).toBe("cashu");
    expect(fundViaFloat).not.toHaveBeenCalled();
  });

  it("stays cashu-only with no float, whatever the amount — privacy personas unchanged", async () => {
    vi.mocked(prepareAgentSpend).mockImplementation(preparedSpend() as never);
    mockCreditOp.mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(args({ menu: FLOOR_MENU, amountMicro: 100_000, float: null }));

    expect(outcome.status).toBe("funded");
    expect(outcome.rail).toBe("cashu");
    expect(fundViaFloat).not.toHaveBeenCalled();
  });

  it("avoids a dead end when the pocket is short and the amount is below the receive floor", async () => {

    vi.mocked(prepareAgentSpend).mockResolvedValue({
      error: { code: "insufficient_balance", message: "Not enough sats.", hint: "Fund it." },
    });

    const outcome = await fundCredit(args({ menu: FLOOR_MENU, amountMicro: 30_000 }));

    expect(outcome.status).toBe("unavailable");
    expect(outcome.error?.code).toBe("below_rail_minimum");
    expect(outcome.hint).toContain("dvm wallet fund");

    expect(mockCreditOp).not.toHaveBeenCalled();
    expect(recordPendingFunding).not.toHaveBeenCalled();
    expect(fundViaFloat).not.toHaveBeenCalled();
  });

  it("refuses a forced sub-floor --rail lightning honestly, naming the escape hatches", async () => {
    const outcome = await fundCredit(
      args({ rail: "lightning", menu: FLOOR_MENU, amountMicro: 30_000 })
    );

    expect(outcome.status).toBe("unavailable");
    expect(outcome.error?.code).toBe("below_rail_minimum");
    expect(outcome.hint).toContain("dvm wallet fund");
    expect(outcome.hint).toContain("Drop --rail");
    expect(mockCreditOp).not.toHaveBeenCalled();
  });

  it("maps a server below_rail_minimum to this-rail-only, so cashu is still tried", async () => {

    vi.mocked(prepareAgentSpend).mockImplementation(preparedSpend() as never);
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("below_rail_minimum", "Below the receive floor.", undefined, {
          retryable: false,
          rail: "lightning",
          min_micro: 2_300_000,
        })
      )
      .mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(args({ menu: FLOOR_MENU, amountMicro: 100_000 }));

    expect(outcome.status).toBe("funded");
    expect(outcome.rail).toBe("cashu");
  });

  it("never re-gates a resumed pending invoice — it may already be paid", async () => {
    const pending = pendingFunding({ amountMicro: 30_000, menu: FLOOR_MENU });
    vi.mocked(loadPendingFunding).mockReturnValue(pending);
    mockCreditOp.mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(args({ menu: FLOOR_MENU, amountMicro: 30_000 }));

    expect(outcome.status).toBe("funded");
    expect(outcome.fundId).toBe("fund-original");
  });

  it("names ecash, never 'retry', when a payment below a known floor fails", async () => {

    const pending = pendingFunding({ amountMicro: 30_000, menu: FLOOR_MENU });
    vi.mocked(loadPendingFunding).mockReturnValue(pending);
    mockCreditOp.mockRejectedValueOnce(pendingInvoice());
    vi.mocked(fundViaFloat).mockRejectedValueOnce(
      new DvmError(
        "float_payment_failed",
        "The Lightning wallet tried to pay and failed: no route found.",
        "Transient routing failures can succeed on a retry.",
        { wallet_message: "no route found" }
      )
    );

    const outcome = await fundCredit(args({ menu: FLOOR_MENU, amountMicro: 30_000 }));

    expect(outcome.status).toBe("refused");
    expect(outcome.hint).toContain("dvm wallet fund");
    expect(outcome.hint).toContain("no retry can pay it");
  });
});

describe("fundCredit over a one-shot Tempo charge", () => {
  const chargeMenu: CreditMenu = {
    ...MENU,
    funding: ["tempo"],
    tempo: { methods: [{ method: "tempo", intent: "charge" }] },
  };
  const tempoAccount = {
    privateKey: `0x${"11".repeat(32)}` as `0x${string}`,
    address: `0x${"22".repeat(20)}` as `0x${string}`,
  };
  const challenge = {
    id: "charge-1",
    realm: "wordcount.example",
    method: "tempo",
    intent: "charge",
    request: {
      amount: "100000",
      currency: `0x${"33".repeat(20)}`,
      recipient: `0x${"44".repeat(20)}`,
    },
  };
  const credential = {
    challenge,
    payload: { signature: `0x${"55".repeat(65)}` },
  } as never;

  it("funds durable credit without opening or journalling a channel", async () => {
    vi.mocked(buildTempoCredential).mockResolvedValueOnce(credential);
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Pay once.", undefined, {
          tempo_challenges: [challenge],
        })
      )
      .mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(
      args({
        menu: chargeMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        tempoAccount,
      })
    );

    expect(outcome).toMatchObject({
      status: "funded",
      rail: "tempo",
      spentMicro: 100_000,
      railReason: "forced",
      tempoIntent: "charge",
    });
    expect(buildTempoCredential).toHaveBeenCalledWith({
      challenges: [challenge],
      privateKey: tempoAccount.privateKey,
      basisMicro: 100_000,
      onError: "throw",
    });

    expect(recordPendingFunding).not.toHaveBeenCalled();
    expect(recordPendingTempoChargeFunding).toHaveBeenCalledWith(
      expect.objectContaining({
        creditId: "credit-1",
        fundId: "fund-1",
        amountMicro: 100_000,
        targetMicro: 100_000,
        signedMicro: 100_000,
        credential: expect.stringMatching(/^Payment /),
      })
    );
    expect(vi.mocked(recordPendingTempoChargeFunding).mock.invocationCallOrder[0]).toBeLessThan(
      mockCreditOp.mock.invocationCallOrder[1]
    );
    expect(clearPendingTempoChargeFunding).toHaveBeenCalledTimes(1);
    const payment = mockCreditOp.mock.calls[1][2] as { mppCredentialRaw?: string };
    expect(payment.mppCredentialRaw).toMatch(/^Payment /);
    expect(mockCreditOp.mock.calls[1][1]).toMatchObject({
      fund: {
        amount_micro: 100_000,
        fund_id: "fund-1",
        commitment: expect.stringMatching(/^[0-9a-f]{64}$/),
        method: "tempo",
        intent: "charge",
      },
    });
    expect(recordSpendOnce).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "fund:fund-1", label: "Tempo charge credit top-up" })
    );
  });

  it("does not fall through to another rail after presenting the charge", async () => {
    vi.mocked(buildTempoCredential).mockResolvedValueOnce(credential);
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Pay once.", undefined, {
          tempo_challenges: [challenge],
        })
      )
      .mockRejectedValueOnce(new DvmError("endpoint_unreachable", "Response was lost."));

    const outcome = await fundCredit(
      args({
        menu: chargeMenu,
        providerInfo: {},
        float: null,
        tempoAccount,
      })
    );

    expect(outcome).toMatchObject({ status: "refused", rail: "tempo" });
    expect(outcome.hint).toContain("credit balance");
    expect(mockCreditOp).toHaveBeenCalledTimes(2);

    expect(recordSpendOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "fund:fund-1",
        label: "Tempo charge credit top-up (unconfirmed)",
      })
    );
    expect(clearPendingTempoChargeFunding).not.toHaveBeenCalled();
  });

  it("relays a late binding refusal without claiming the presented charge was free", async () => {
    vi.mocked(buildTempoCredential).mockResolvedValueOnce(credential);
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Pay once.", undefined, {
          tempo_challenges: [challenge],
        })
      )
      .mockRejectedValueOnce(
        new DvmError(
          "payment_invalid",
          "credit belongs to a Tempo session",
          "Do not pay again; contact the service operator.",
          { credit_instrument: "tempo_session" },
          "Your payment went through, but the service could not add it to the requested prepaid balance."
        )
      );

    const outcome = await fundCredit(
      args({
        menu: chargeMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        tempoAccount,
      })
    );

    expect(outcome.status).toBe("refused");
    expect(outcome.display).toContain("payment went through");
    expect(outcome.display).not.toContain("No charge was made");
    expect(outcome.hint).toContain("Do not pay again");
  });

  it("relays a late cross-rail refusal after presenting the charge", async () => {
    vi.mocked(buildTempoCredential).mockResolvedValueOnce(credential);
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Pay once.", undefined, {
          tempo_challenges: [challenge],
        })
      )
      .mockRejectedValueOnce(
        new DvmError(
          "payment_invalid",
          "credit belongs to x402",
          "Do not pay again; contact the service operator.",
          { credit_rail: "x402" },
          "Your payment went through, but the service could not add it to the requested prepaid balance."
        )
      );

    const outcome = await fundCredit(
      args({
        menu: chargeMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        tempoAccount,
      })
    );

    expect(outcome.status).toBe("refused");
    expect(outcome.display).toContain("payment went through");
    expect(outcome.display).not.toContain("opened over x402");
    expect(outcome.hint).toContain("Do not pay again");
    expect(outcome.requiredRail).toBeUndefined();
  });

  it("books what the charge authorizes, not what the funding asked for", async () => {

    const overCharge = { ...challenge, request: { ...challenge.request, amount: "110000" } };
    vi.mocked(buildTempoCredential).mockResolvedValueOnce({
      challenge: overCharge,
      payload: { signature: `0x${"55".repeat(65)}` },
    } as never);
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Pay once.", undefined, {
          tempo_challenges: [overCharge],
        })
      )
      .mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(
      args({
        menu: chargeMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        tempoAccount,
      })
    );

    expect(outcome).toMatchObject({ status: "funded", spentMicro: 110_000 });
    expect(recordSpendOnce).toHaveBeenCalledWith(
      expect.objectContaining({ msats: 110_000, jobId: "fund:fund-1" })
    );
  });

  it("refuses an over-charge unsigned and does not reach for another rail", async () => {
    vi.mocked(buildTempoCredential).mockRejectedValueOnce(
      new DvmError(
        "tempo_amount_exceeds_limit",
        "The DVM's Tempo charge ($50.00) is more than 10% above the caller's local price ($0.10).",
        "Nothing was signed. Refresh the quote or ask the DVM operator to check its BTC/USD rate.",
        { display: "Payment refused: $50.00 exceeds the 10% safety margin." }
      )
    );
    mockCreditOp.mockRejectedValueOnce(
      new DvmError("payment_required", "Pay once.", undefined, {
        tempo_challenges: [{ ...challenge, request: { ...challenge.request, amount: "50000000" } }],
      })
    );

    const outcome = await fundCredit(
      args({
        menu: { ...chargeMenu, funding: ["tempo", "cashu"] },
        providerInfo: {},
        float: null,
        tempoAccount,
      })
    );

    expect(outcome).toMatchObject({ status: "refused", rail: "tempo" });
    expect(outcome.display).toContain("safety margin");

    expect(mockCreditOp).toHaveBeenCalledTimes(1);
    expect(recordSpendOnce).not.toHaveBeenCalled();
  });

  it("says nothing settled when the DVM refuses the funding outright", async () => {
    vi.mocked(buildTempoCredential).mockResolvedValueOnce(credential);
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Pay once.", undefined, {
          tempo_challenges: [challenge],
        })
      )
      .mockRejectedValueOnce(new DvmError("credit_over_max", "That is above this DVM's maximum."));

    const outcome = await fundCredit(
      args({
        menu: chargeMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        tempoAccount,
      })
    );

    expect(outcome.status).toBe("refused");
    expect(outcome.display).toContain("credit_over_max");
    expect(outcome.hint).toContain("never settled");
    expect(outcome.hint).not.toContain("may still have settled");
  });

  it("refuses instead of switching a session-bound credit to charge on a stale menu", async () => {
    const creditId = "credit-observer-stale";
    const payer = privateKeyToAccount(tempoAccount.privateKey);
    await createTempoChannelStore({
      endpoint: ENDPOINT,
      callerPubkey: SIGNING.pubkey,
      creditId,
    }).set({
      channelId: `0x${"77".repeat(32)}`,
      cumulativeAmount: 100_000n,
      deposit: 500_000n,
      descriptor: {
        payer: payer.address,
        payee: `0x${"33".repeat(20)}`,
        operator: `0x${"00".repeat(20)}`,
        token: `0x${"44".repeat(20)}`,
        salt: `0x${"55".repeat(32)}`,
        authorizedSigner: payer.address,
        expiringNonceHash: `0x${"66".repeat(32)}`,
      },
      escrow: TempoSession.Precompile.Constants.tip20ChannelEscrow,
      chainId: 42431,
      opened: true,
    });

    const outcome = await fundCredit(
      args({
        creditId,
        menu: chargeMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        tempoAccount,
      })
    );

    expect(outcome).toMatchObject({
      status: "refused",
      rail: "tempo",
      tempoIntent: "session",
    });
    expect(outcome.display).toContain("existing reusable Tempo channel");
    expect(outcome.hint).toContain("close observer");
    expect(mockCreditOp).not.toHaveBeenCalled();
    expect(buildTempoCredential).not.toHaveBeenCalled();
  });

  it("tops the existing channel up anyway when the menu says the session is withheld", async () => {

    const creditId = "credit-observer-withheld";
    const payer = privateKeyToAccount(tempoAccount.privateKey);
    await createTempoChannelStore({
      endpoint: ENDPOINT,
      callerPubkey: SIGNING.pubkey,
      creditId,
    }).set({
      channelId: `0x${"78".repeat(32)}`,
      cumulativeAmount: 100_000n,
      deposit: 500_000n,
      descriptor: {
        payer: payer.address,
        payee: `0x${"33".repeat(20)}`,
        operator: `0x${"00".repeat(20)}`,
        token: `0x${"44".repeat(20)}`,
        salt: `0x${"55".repeat(32)}`,
        authorizedSigner: payer.address,
        expiringNonceHash: `0x${"66".repeat(32)}`,
      },
      escrow: TempoSession.Precompile.Constants.tip20ChannelEscrow,
      chainId: 42431,
      opened: true,
    });

    const outcome = await fundCredit(
      args({
        creditId,
        menu: {
          ...chargeMenu,
          tempo: {
            methods: [{ method: "tempo", intent: "charge" }],
            withheld: [{ method: "tempo", intent: "session", reason: "observer_unhealthy" }],
          },
        },
        providerInfo: {},
        float: null,
        tempoAccount,

        tempoFetch: () => Promise.reject(new Error("transport stopped")),
      })
    );

    expect(outcome.railReason).toBe("tempo_session_available");
    expect(outcome.display).not.toContain("existing reusable Tempo channel");

    expect(recordPendingFunding).toHaveBeenCalledWith(
      expect.objectContaining({ creditId, rail: "tempo" })
    );
  });
});

describe("resuming a Tempo charge after a lost response", () => {
  const tempoAccount = {
    privateKey: `0x${"11".repeat(32)}` as `0x${string}`,
    address: `0x${"22".repeat(20)}` as `0x${string}`,
  };
  const chargeMenu: CreditMenu = {
    ...MENU,
    funding: ["tempo"],
    tempo: { methods: [{ method: "tempo", intent: "charge" }] },
  };
  const challenge = {
    id: "charge-resumed",
    realm: "wordcount.example",
    method: "tempo",
    intent: "charge",
    request: {
      amount: "100000",
      currency: `0x${"33".repeat(20)}`,
      recipient: `0x${"44".repeat(20)}`,
    },
  };
  const credential = { challenge, payload: { signature: `0x${"55".repeat(65)}` } } as never;
  const challenge402 = () =>
    new DvmError("payment_required", "Pay once.", undefined, { tempo_challenges: [challenge] });

  function journalled(over: Partial<PendingTempoChargeFunding> = {}): PendingTempoChargeFunding {
    return {
      endpoint: ENDPOINT,
      callerPubkey: SIGNING.pubkey,
      creditId: "credit-1",
      fundId: "lost-fund",
      amountMicro: 100_000,
      targetMicro: 100_000,
      credential: "Payment already-signed",
      signedMicro: 100_000,
      amountMsats: 100_000,
      btcRate: 100_000,
      requestedAt: Date.now(),
      credentialValidBefore: Math.floor(Date.now() / 1000) + 20,
      ...over,
    };
  }

  it("asks under the journalled fund id and takes the DVM's recorded answer", async () => {
    vi.mocked(loadResumableTempoChargeFunding).mockReturnValue(
      journalled({ endpoint: ALIAS_ENDPOINT })
    );
    mockCreditOp.mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(
      args({ fundId: undefined, menu: chargeMenu, float: null, tempoAccount })
    );

    expect(outcome).toMatchObject({ status: "funded", rail: "tempo", fundId: "lost-fund" });

    expect(mockCreditOp).toHaveBeenCalledTimes(1);
    expect(mockCreditOp.mock.calls[0][0]).toEqual({ endpoint: ALIAS_ENDPOINT });
    expect(buildTempoCredential).not.toHaveBeenCalled();

    expect(recordSpendOnce).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "fund:lost-fund" })
    );
    expect(enforceGlobalBudget).not.toHaveBeenCalled();
    expect(clearPendingTempoChargeFunding).toHaveBeenCalledTimes(1);
  });

  it("books the replayed charge before retiring it, so a crash before the first booking cannot lose it", async () => {

    vi.mocked(loadResumableTempoChargeFunding).mockReturnValue(

      journalled({ signedMicro: 104_000, amountMsats: 104_000 })
    );
    mockCreditOp.mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(
      args({ fundId: undefined, menu: chargeMenu, float: null, tempoAccount })
    );

    expect(outcome).toMatchObject({ status: "funded", fundId: "lost-fund", spentMicro: 104_000 });
    expect(recordSpendOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "credit_fund",
        jobId: "fund:lost-fund",
        providerEndpoint: ENDPOINT,
        msats: 104_000,
        btcRate: 100_000,
      })
    );

    expect(vi.mocked(recordSpendOnce).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(clearPendingTempoChargeFunding).mock.invocationCallOrder[0]
    );
  });

  it("re-presents the same credential when the DVM has no record of the funding", async () => {
    vi.mocked(loadResumableTempoChargeFunding).mockReturnValue(journalled());
    mockCreditOp.mockRejectedValueOnce(challenge402()).mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(
      args({ fundId: undefined, menu: chargeMenu, float: null, tempoAccount })
    );

    expect(outcome).toMatchObject({ status: "funded", fundId: "lost-fund", spentMicro: 100_000 });
    expect(buildTempoCredential).not.toHaveBeenCalled();
    expect(mockCreditOp.mock.calls[1][2]).toMatchObject({
      mppCredentialRaw: "Payment already-signed",
    });
    expect(mockCreditOp.mock.calls[1][1]).toMatchObject({
      fund: { fund_id: "lost-fund", amount_micro: 100_000 },
    });

    expect(tryResolveBtcUsdRate).not.toHaveBeenCalled();
    expect(recordSpendOnce).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "fund:lost-fund", btcRate: 100_000, msats: 100_000 })
    );
  });

  it("signs a fresh charge under the same fund id once the credential can no longer settle", async () => {

    vi.mocked(loadResumableTempoChargeFunding).mockReturnValue(
      journalled({ credentialValidBefore: Math.floor(Date.now() / 1000) - 1 })
    );
    vi.mocked(buildTempoCredential).mockResolvedValueOnce(credential);
    mockCreditOp.mockRejectedValueOnce(challenge402()).mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(
      args({ fundId: undefined, menu: chargeMenu, float: null, tempoAccount })
    );

    expect(outcome).toMatchObject({ status: "funded", fundId: "lost-fund" });
    expect(buildTempoCredential).toHaveBeenCalledWith(
      expect.objectContaining({ basisMicro: 100_000 })
    );

    expect(mockCreditOp.mock.calls[1][1]).toMatchObject({ fund: { fund_id: "lost-fund" } });

    expect(enforceGlobalBudget).not.toHaveBeenCalled();
    expect(recordSpendOnce).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "fund:lost-fund" })
    );
  });

  it("resumes even when the DVM's menu no longer advertises the charge", async () => {

    vi.mocked(loadResumableTempoChargeFunding).mockReturnValue(journalled());
    mockCreditOp.mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(
      args({ fundId: undefined, menu: undefined, float: null, tempoAccount })
    );

    expect(outcome).toMatchObject({ status: "funded", fundId: "lost-fund" });
  });

  it("refuses another rail while the charge is unanswered, and signs nothing", async () => {
    const requestedAt = Date.now();
    vi.mocked(loadResumableTempoChargeFunding).mockReturnValue(journalled({ requestedAt }));

    const outcome = await fundCredit(
      args({ fundId: undefined, rail: "cashu", float: null, tempoAccount })
    );

    expect(outcome).toMatchObject({
      status: "unavailable",
      rail: "cashu",
      creditId: "credit-1",
      fundId: "lost-fund",
    });
    expect(outcome.error?.code).toBe("tempo_charge_pending");
    expect(outcome.display).toContain("second payment for the same top-up");

    expect(outcome.hint).toContain(
      new Date(requestedAt + TEMPO_CHARGE_PENDING_STALE_MS).toISOString()
    );
    expect(mockCreditOp).not.toHaveBeenCalled();
    expect(prepareAgentSpend).not.toHaveBeenCalled();
  });

  it("names the disconnected wallet rather than the rail when no Tempo account is configured", async () => {
    vi.mocked(loadResumableTempoChargeFunding).mockReturnValue(journalled());

    const outcome = await fundCredit(
      args({ fundId: undefined, menu: chargeMenu, float: null, tempoAccount: null })
    );

    expect(outcome.error?.code).toBe("tempo_charge_pending");
    expect(outcome.hint).toContain("tempo-connect");
    expect(mockCreditOp).not.toHaveBeenCalled();
  });

  it("retires the entry on a definite refusal, so it cannot hold the credit shut", async () => {
    vi.mocked(loadResumableTempoChargeFunding).mockReturnValue(journalled());
    mockCreditOp
      .mockRejectedValueOnce(challenge402())
      .mockRejectedValueOnce(new DvmError("credit_over_max", "Too much."));

    const outcome = await fundCredit(
      args({ fundId: undefined, menu: chargeMenu, float: null, tempoAccount })
    );

    expect(outcome).toMatchObject({ status: "refused", rail: "tempo" });
    expect(clearPendingTempoChargeFunding).toHaveBeenCalledTimes(1);
  });

  it("keeps the entry and books once when a resume's own answer is lost again", async () => {
    vi.mocked(loadResumableTempoChargeFunding).mockReturnValue(journalled());
    mockCreditOp
      .mockRejectedValueOnce(challenge402())
      .mockRejectedValueOnce(new DvmError("endpoint_unreachable", "Response was lost."));

    const outcome = await fundCredit(
      args({ fundId: undefined, menu: chargeMenu, float: null, tempoAccount })
    );

    expect(outcome).toMatchObject({ status: "refused", rail: "tempo", fundId: "lost-fund" });
    expect(outcome.hint).toContain("asks under the fund id already used");
    expect(clearPendingTempoChargeFunding).not.toHaveBeenCalled();

    expect(vi.mocked(recordSpendOnce).mock.calls.map((call) => call[0].jobId)).toEqual([
      "fund:lost-fund",
    ]);
  });
});

describe("pollPendingCreditFundings over a Tempo charge", () => {
  const entry = (over: Record<string, unknown> = {}): PendingTempoChargeFunding => ({
    endpoint: ENDPOINT,
    callerPubkey: SIGNING.pubkey,
    creditId: "credit-1",
    fundId: "lost-fund",
    amountMicro: 100_000,
    targetMicro: 100_000,
    credential: "Payment already-signed",
    signedMicro: 100_000,
    amountMsats: 100_000,
    btcRate: 100_000,
    requestedAt: Date.now(),
    credentialValidBefore: Math.floor(Date.now() / 1000) + 20,
    ...over,
  });

  beforeEach(() => {
    vi.mocked(connectedTempoAccount).mockResolvedValue({
      privateKey: `0x${"11".repeat(32)}`,
      address: `0x${"22".repeat(20)}`,
    } as never);
  });

  it("keeps sweeping after one entry throws", async () => {
    vi.mocked(listResumableTempoChargeFundings).mockReturnValue([
      entry({ creditId: "credit-a", fundId: "fund-a" }),
      entry({ creditId: "credit-b", fundId: "fund-b" }),
    ]);

    vi.mocked(loadResumableTempoChargeFunding).mockImplementation((a) => {
      if (a.creditId === "credit-a") throw new Error("journal read failed");
      return entry({ creditId: "credit-b", fundId: "fund-b" });
    });
    mockCreditOp.mockResolvedValueOnce(fundedResponse());

    await pollPendingCreditFundings({
      transport,
      ref: { endpoint: ENDPOINT },
      signing: SIGNING,
      signBody: (_privkey, body) => ({ ...body, signature: "sig" }),
    });

    expect(mockCreditOp).toHaveBeenCalledTimes(1);
    expect(mockCreditOp.mock.calls[0][1]).toMatchObject({ fund: { fund_id: "fund-b" } });
  });

  it("presents nothing for an entry a sibling process already retired", async () => {

    vi.mocked(listResumableTempoChargeFundings).mockReturnValue([entry()]);
    vi.mocked(loadResumableTempoChargeFunding).mockReturnValue(undefined);

    await pollPendingCreditFundings({
      transport,
      ref: { endpoint: ENDPOINT },
      signing: SIGNING,
      signBody: (_privkey, body) => ({ ...body, signature: "sig" }),
    });

    expect(mockCreditOp).not.toHaveBeenCalled();
    expect(buildTempoCredential).not.toHaveBeenCalled();
  });

  it("presents nothing while no Tempo wallet is connected", async () => {
    vi.mocked(connectedTempoAccount).mockResolvedValue(null);
    vi.mocked(listResumableTempoChargeFundings).mockReturnValue([entry()]);

    await pollPendingCreditFundings({
      transport,
      ref: { endpoint: ENDPOINT },
      signing: SIGNING,
      signBody: (_privkey, body) => ({ ...body, signature: "sig" }),
    });

    expect(mockCreditOp).not.toHaveBeenCalled();
  });
});

describe("fundCredit over a Tempo session", () => {
  const mppMenu: CreditMenu = {
    ...MENU,
    funding: ["tempo"],
    tempo: { methods: [{ method: "tempo", intent: "session" }] },
  };
  const tempoAccount = {
    privateKey: `0x${"11".repeat(32)}` as `0x${string}`,
    address: `0x${"22".repeat(20)}` as `0x${string}`,
  };
  const challenge = {
    id: "challenge-1",
    realm: "wordcount.example",
    method: "tempo",
    intent: "session",
    request: { amount: "100000", methodDetails: {} },
  };
  const scopedChallenge = {
    ...challenge,
    request: {
      amount: "100000",
      currency: `0x${"44".repeat(20)}`,
      recipient: `0x${"33".repeat(20)}`,
      unitType: "request",
      methodDetails: {
        chainId: 42431,
        escrowContract: TempoSession.Precompile.Constants.tip20ChannelEscrow,
        sessionProtocol: "v2",
      },
    },
  };
  const rateDriftChallenge = {
    ...scopedChallenge,
    request: {
      ...scopedChallenge.request,
      amount: "100285",
      suggestedDeposit: "100285",
    },
  };
  const siblingOperatorA = `0x${"77".repeat(20)}`;
  const siblingOperatorB = `0x${"88".repeat(20)}`;
  const siblingChallenge = (operator: string) => ({
    ...scopedChallenge,
    request: {
      ...scopedChallenge.request,
      methodDetails: { ...scopedChallenge.request.methodDetails, operator },
    },
  });

  const topUpCredential = topUpCredentialFor("100000");

  function topUpCredentialFor(additionalDeposit: string): string {
    return Credential.serialize({
      challenge: { ...challenge, id: "top-up-1" },
      payload: {
        action: "topUp",
        type: "transaction",
        channelId: `0x${"aa".repeat(32)}`,
        transaction: `0x${"bb".repeat(32)}`,
        signature: `0x${"cc".repeat(65)}`,
        additionalDeposit,
      },
    } as never);
  }

  async function openCredentialFor(
    creditId: string,
    request: { amount?: string; suggestedDeposit?: string } = {}
  ): Promise<string> {
    return createTempoCreditSession({
      account: tempoAccount,
      endpoint: ENDPOINT,

      callerPubkey: `mint-${creditId}`,
      creditId,
      maxDepositMicro: 5_000_000,
      topUpAmountMicro: 100_000,
      getClient: (() =>
        stubTempoSessionClient({
          privateKey: tempoAccount.privateKey,
          chainId: 42431,
        })) as never,
    }).createCredential({
      context: undefined as never,
      challenge: {
        id: "open-1",
        realm: "wordcount.example",
        method: "tempo",
        intent: "session",
        request: {
          amount: request.amount ?? "100000",
          ...(request.suggestedDeposit ? { suggestedDeposit: request.suggestedDeposit } : {}),
          currency: `0x${"55".repeat(20)}`,
          recipient: `0x${"33".repeat(20)}`,
          unitType: "request",
          methodDetails: {
            chainId: 42431,
            escrowContract: TempoSession.Precompile.Constants.tip20ChannelEscrow,
          },
        },
      } as never,
    });
  }

  it("answers the accepted management top-up with the 204 mppx waits for", async () => {
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Open a session.", undefined, {
          tempo_challenges: [challenge],
        })
      )
      .mockRejectedValueOnce(
        new DvmError("payment_invalid", TEMPO_SESSION_UPDATED_REASON, undefined, {
          tempo_challenges: [challenge],
        })
      )
      .mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(
      args({
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        tempoAccount,
        tempoFetch: async ({ fetch, input, init }: TempoFetchArgs) => {
          expect((await fetch(input, init)).status).toBe(402);

          const management = await fetch(input, {
            ...init,
            headers: { Authorization: topUpCredential },
          });
          expect(management.status).toBe(204);

          return fetch(input, init);
        },
      })
    );

    expect(outcome).toMatchObject({ status: "funded", rail: "tempo", tempoIntent: "session" });
  });

  it("opens when accepted BTC/USD drift puts the Tempo challenge just above the credit ask", async () => {
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Open a session.", undefined, {
          tempo_challenges: [rateDriftChallenge],
        })
      )
      .mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(
      args({
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        amountMicro: 100_000,
        maxDepositMicro: 100_000,
        tempoAccount,
        tempoGetClient: (() =>
          stubTempoSessionClient({
            privateKey: tempoAccount.privateKey,
            chainId: 42431,
          })) as never,
      })
    );

    expect(outcome).toMatchObject({ status: "funded", spentMicro: 100_285 });
    const credential = mockCreditOp.mock.calls[1]?.[2] as { mppCredentialRaw?: string } | undefined;
    expect(credential?.mppCredentialRaw).toBeDefined();
    expect(
      (
        Credential.deserialize(credential?.mppCredentialRaw ?? "").payload as {
          cumulativeAmount?: string;
        }
      ).cumulativeAmount
    ).toBe("100285");
  });

  it("funds a second credit by topping up the channel its payment scope reuses", async () => {
    const firstCreditId = "credit-shared-a";
    const secondCreditId = "credit-shared-b";
    const secondEndpoint = "https://summarize.example";
    await seedOpenedChannel(firstCreditId, 100_000n, 100_000n);
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Top this session up.", undefined, {
          tempo_challenges: [scopedChallenge],
        })
      )
      .mockRejectedValueOnce(
        new DvmError("payment_invalid", TEMPO_SESSION_UPDATED_REASON, undefined, {
          tempo_challenges: [scopedChallenge],
        })
      )
      .mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(
      args({
        ref: { endpoint: secondEndpoint },
        creditId: secondCreditId,
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        tempoAccount,
        tempoGetClient: (() =>
          stubTempoSessionClient({
            privateKey: tempoAccount.privateKey,
            chainId: 42431,
            channelState: { settled: 0n, deposit: 100_000n, closeRequestedAt: 0 },
          })) as never,
      })
    );

    expect(outcome).toMatchObject({
      status: "funded",
      creditId: secondCreditId,
      spentMicro: 100_000,
    });
    expect(mockCreditOp).toHaveBeenCalledTimes(3);
    const credentials = mockCreditOp.mock.calls
      .map((call) => (call[2] as { mppCredentialRaw?: string } | undefined)?.mppCredentialRaw)
      .filter((credential): credential is string => credential !== undefined)
      .map((credential) => Credential.deserialize(credential).payload as { action?: string });
    expect(credentials.map((payload) => payload.action)).toEqual(["topUp", "voucher"]);
    const first = loadTempoChannelAssociation(ENDPOINT, SIGNING.pubkey, firstCreditId);
    const sibling = loadTempoChannelAssociation(secondEndpoint, SIGNING.pubkey, secondCreditId);
    expect(first).toMatchObject({ cumulativeAmount: "200000", deposit: "200000" });
    expect(sibling).toMatchObject({
      channelKey: first?.channelKey,
      cumulativeAmount: "200000",
      deposit: "200000",
      opened: true,
    });
  });

  it("surfaces an occupied channel scope with the exit hint intact", async () => {
    const occupiedCreditId = "credit-occupied";
    const refusedCreditId = "credit-collision";
    await seedOpenedChannel(
      occupiedCreditId,
      0n,
      5_000_000n,
      `0x${"00".repeat(20)}`,
      `0x${"55".repeat(20)}`
    );
    const openingCredential = await openCredentialFor(refusedCreditId);
    const openingChallenge = Credential.deserialize(openingCredential).challenge;
    mockCreditOp.mockRejectedValueOnce(
      new DvmError("payment_required", "Open a session.", undefined, {
        tempo_challenges: [openingChallenge],
      })
    );

    const outcome = await fundCredit(
      args({
        creditId: refusedCreditId,
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        tempoAccount,
        tempoFetch: async ({ fetch, input, init }: TempoFetchArgs) => {
          expect((await fetch(input, init)).status).toBe(402);
          return fetch(input, { ...init, headers: { Authorization: openingCredential } });
        },
      })
    );

    expect(outcome).toMatchObject({
      status: "refused",
      error: { code: "tempo_channel_scope_occupied" },
      hint: "Exit the existing Tempo channel before retrying this funding. Its local recovery descriptor was preserved.",
    });
    expect(loadTempoChannelAssociation(ENDPOINT, SIGNING.pubkey, occupiedCreditId)).toBeDefined();
    expect(loadTempoChannelAssociation(ENDPOINT, SIGNING.pubkey, refusedCreditId)).toBeUndefined();
    expect(mockCreditOp).toHaveBeenCalledTimes(1);
  });

  it("opens separate channels for sibling DVM operators sharing one recipient", async () => {
    const firstCreditId = "credit-operator-a";
    const secondCreditId = "credit-operator-b";
    const secondEndpoint = "https://summarize.example";
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Open the first session.", undefined, {
          tempo_challenges: [siblingChallenge(siblingOperatorA)],
        })
      )
      .mockResolvedValueOnce(fundedResponse())
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Open the sibling session.", undefined, {
          tempo_challenges: [siblingChallenge(siblingOperatorB)],
        })
      )
      .mockResolvedValueOnce(fundedResponse());
    const tempoGetClient = (() =>
      stubTempoSessionClient({
        privateKey: tempoAccount.privateKey,
        chainId: 42431,
      })) as never;

    const first = await fundCredit(
      args({
        creditId: firstCreditId,
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        tempoAccount,
        tempoGetClient,
      })
    );
    const second = await fundCredit(
      args({
        ref: { endpoint: secondEndpoint },
        creditId: secondCreditId,
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        tempoAccount,
        tempoGetClient,
      })
    );

    expect(first).toMatchObject({ status: "funded", creditId: firstCreditId });
    expect(second).toMatchObject({ status: "funded", creditId: secondCreditId });
    const opens = mockCreditOp.mock.calls
      .map((call) => (call[2] as { mppCredentialRaw?: string } | undefined)?.mppCredentialRaw)
      .filter((credential): credential is string => credential !== undefined)
      .map((credential) => Credential.deserialize(credential).payload as Record<string, unknown>);
    expect(opens).toHaveLength(2);
    expect(opens.map((payload) => payload.action)).toEqual(["open", "open"]);
    expect(
      opens.map((payload) => (payload.descriptor as { operator: string }).operator.toLowerCase())
    ).toEqual([siblingOperatorA, siblingOperatorB]);
    const firstAssociation = loadTempoChannelAssociation(ENDPOINT, SIGNING.pubkey, firstCreditId);
    const secondAssociation = loadTempoChannelAssociation(
      secondEndpoint,
      SIGNING.pubkey,
      secondCreditId
    );
    expect(firstAssociation).toMatchObject({ operator: siblingOperatorA, opened: true });
    expect(secondAssociation).toMatchObject({ operator: siblingOperatorB, opened: true });
    expect(firstAssociation?.channelKey).toBe(secondAssociation?.channelKey);
    expect(firstAssociation?.channelId).not.toBe(secondAssociation?.channelId);
  });

  it("counts shared collateral when checking a second credit's top-up", async () => {
    const firstCreditId = "credit-shared-cap-a";
    const secondCreditId = "credit-shared-cap-b";
    await seedOpenedChannel(firstCreditId, 100_000n, 100_000n);
    mockCreditOp.mockRejectedValueOnce(
      new DvmError("payment_required", "Top this session up.", undefined, {
        tempo_challenges: [scopedChallenge],
      })
    );

    const outcome = await fundCredit(
      args({
        creditId: secondCreditId,
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        tempoAccount,
        tempoFetch: async ({ fetch, input, init }: TempoFetchArgs) => {
          expect((await fetch(input, init)).status).toBe(402);
          return fetch(input, {
            ...init,
            headers: { Authorization: topUpCredentialFor("110001") },
          });
        },
      })
    );

    expect(outcome).toMatchObject({
      status: "refused",
      error: { code: "tempo_session_deposit_exceeds_limit" },
    });
    expect(loadTempoChannelAssociation(ENDPOINT, SIGNING.pubkey, secondCreditId)).toBeUndefined();
    expect(clearPendingFunding).toHaveBeenCalledWith(
      ENDPOINT,
      SIGNING.pubkey,
      secondCreditId,
      "fund-1"
    );
  });

  it("clears a credential-less session failure without promising an impossible replay", async () => {
    mockCreditOp.mockRejectedValueOnce(
      new DvmError("payment_required", "Top this session up.", undefined, {
        tempo_challenges: [challenge],
      })
    );

    const outcome = await fundCredit(
      args({
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        tempoAccount,
        tempoFetch: () => Promise.reject(new Error("mppx produced no payment plan")),
      })
    );

    expect(outcome).toMatchObject({
      status: "refused",
      error: { code: "tempo_session_credential_unavailable" },
    });
    expect(outcome.display).toContain("before a payment credential was created");
    expect(outcome.display).toContain("mppx produced no payment plan");
    expect(outcome.hint).toContain("Nothing was sent and no collateral moved");
    expect(outcome.hint).not.toContain("saved");
    expect(vi.mocked(recordPendingFunding).mock.calls.at(-1)?.[0].mppCredential).toBeUndefined();
    expect(clearPendingFunding).toHaveBeenCalledWith(
      ENDPOINT,
      SIGNING.pubkey,
      "credit-1",
      "fund-1"
    );
  });

  it("keeps a 402 when the DVM refused for some other reason", async () => {
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Open a session.", undefined, {
          tempo_challenges: [challenge],
        })
      )
      .mockRejectedValueOnce(
        new DvmError("payment_invalid", "That voucher is stale.", undefined, {
          tempo_challenges: [challenge],
        })
      );

    await fundCredit(
      args({
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        tempoAccount,
        tempoFetch: async ({ fetch, input, init }: TempoFetchArgs) => {
          await fetch(input, init);
          const management = await fetch(input, {
            ...init,
            headers: { Authorization: topUpCredential },
          });
          expect(management.status).toBe(402);
          return management;
        },
      })
    );
  });

  it("journals the exact credential before sending it and clears only after success", async () => {
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Open a session.", undefined, {
          tempo_challenges: [challenge],
        })
      )
      .mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(
      args({
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        tempoAccount,
        tempoFetch: async ({ fetch, input, init }: TempoFetchArgs) => {
          const discovery = await fetch(input, init);
          expect(discovery.status).toBe(402);
          return fetch(input, {
            ...init,
            headers: { Authorization: "Payment durable-credential" },
          });
        },
      })
    );

    expect(outcome).toMatchObject({
      status: "funded",
      rail: "tempo",
      spentMicro: 100_000,
      tempoIntent: "session",
    });
    expect(outcome.display).toContain("prepaid credit");
    expect(outcome.display).toContain("custody and settlement mechanism");
    expect(outcome.display).not.toContain("session credit");
    expect(recordPendingFunding).toHaveBeenCalledTimes(2);
    expect(vi.mocked(recordPendingFunding).mock.calls[1][0]).toMatchObject({
      rail: "tempo",
      mppCredential: "Payment durable-credential",
    });
    expect(vi.mocked(recordPendingFunding).mock.invocationCallOrder[1]).toBeLessThan(
      mockCreditOp.mock.invocationCallOrder[1]
    );
    expect(mockCreditOp.mock.calls[1][2]).toEqual({
      mppCredentialRaw: "Payment durable-credential",
    });
    expect(mockCreditOp.mock.calls[1][1]).toMatchObject({
      fund: { method: "tempo", intent: "session" },
    });
    expect(clearPendingFunding).toHaveBeenCalledWith(
      ENDPOINT,
      SIGNING.pubkey,
      "credit-1",
      "fund-1"
    );
  });

  it("relays a late binding refusal without claiming the presented session stayed unopened", async () => {
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Open a session.", undefined, {
          tempo_challenges: [challenge],
        })
      )
      .mockRejectedValueOnce(
        new DvmError(
          "payment_invalid",
          "credit belongs to a one-shot Tempo charge",
          "Do not pay again; contact the service operator.",
          { credit_instrument: "tempo_charge" },
          "Your payment went through, but the service could not add it to the requested prepaid balance."
        )
      );

    const outcome = await fundCredit(
      args({
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        tempoAccount,
        tempoFetch: async ({ fetch, input, init }: TempoFetchArgs) => {
          const discovery = await fetch(input, init);
          expect(discovery.status).toBe(402);
          return fetch(input, {
            ...init,
            headers: { Authorization: "Payment durable-credential" },
          });
        },
      })
    );

    expect(outcome.status).toBe("refused");
    expect(outcome.display).toContain("payment went through");
    expect(outcome.display).not.toContain("No channel was opened");
    expect(outcome.hint).toContain("Do not pay again");
  });

  it.each([
    ["another Tempo session channel", { credit_instrument: "tempo_session" }],
    ["another rail", { credit_rail: "x402" }],
  ])("relays a late %s refusal after presenting the session", async (_reason, binding) => {
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Open a session.", undefined, {
          tempo_challenges: [challenge],
        })
      )
      .mockRejectedValueOnce(
        new DvmError(
          "payment_invalid",
          "credit binding changed",
          "Do not pay again; contact the service operator.",
          binding,
          "Your payment went through, but the service could not add it to the requested prepaid balance."
        )
      );

    const outcome = await fundCredit(
      args({
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        tempoAccount,
        tempoFetch: async ({ fetch, input, init }: TempoFetchArgs) => {
          const discovery = await fetch(input, init);
          expect(discovery.status).toBe(402);
          return fetch(input, {
            ...init,
            headers: { Authorization: "Payment durable-credential" },
          });
        },
      })
    );

    expect(outcome.status).toBe("refused");
    expect(outcome.display).toContain("payment went through");
    expect(outcome.display).not.toContain("No channel was opened");
    expect(outcome.hint).toContain("Do not pay again");
    expect(outcome.requiredRail).toBeUndefined();
    expect(clearPendingFunding).toHaveBeenCalledWith(
      ENDPOINT,
      SIGNING.pubkey,
      "credit-1",
      "fund-1"
    );
  });

  it("replays a journaled cumulative credential without creating another", async () => {
    const pending = pendingFunding({
      rail: "tempo",
      menu: mppMenu,
      mppCredential: "Payment already-signed",
      bolt11: undefined,
      paymentHash: undefined,
      amountMsats: undefined,
      expiresAtMs: undefined,
    });
    vi.mocked(loadPendingFunding).mockReturnValue(pending);
    mockCreditOp.mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(
      args({
        menu: mppMenu,
        providerInfo: {},
        float: null,
        tempoAccount,
        tempoFetch: ({ fetch, input, init }: TempoFetchArgs) => fetch(input, init),
      })
    );

    expect(outcome.status).toBe("funded");
    expect(mockCreditOp.mock.calls[0][2]).toEqual({ mppCredentialRaw: "Payment already-signed" });
  });

  it("uses an idempotent budget debit before clearing a confirmed replay", async () => {
    const pending = pendingFunding({
      rail: "tempo",
      menu: mppMenu,
      mppCredential: "Payment already-signed",
      budgetBtcRate: 100_000,

      authorizedMicro: 105_000,
      bolt11: undefined,
      paymentHash: undefined,
      amountMsats: undefined,
      expiresAtMs: undefined,
    });
    vi.mocked(loadPendingFunding).mockReturnValue(pending);
    mockCreditOp.mockResolvedValueOnce(fundedResponse());

    await fundCredit(
      args({
        menu: mppMenu,
        providerInfo: {},
        float: null,
        tempoAccount,
        tempoFetch: ({ fetch, input, init }: TempoFetchArgs) => fetch(input, init),
      })
    );

    expect(recordSpendOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "credit_fund",
        jobId: "fund:credit-1:fund-original",
        msats: 105_000,
      })
    );
    expect(vi.mocked(recordSpendOnce).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(clearPendingFunding).mock.invocationCallOrder[0]
    );
  });

  it("recovers the same channel when an open commits before its response is observed", async () => {
    const creditId = "credit-lost-open-response";
    const openCredential = await openCredentialFor(creditId);
    const channelId = (Credential.deserialize(openCredential).payload as { channelId: string })
      .channelId;
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Open a session.", undefined, {
          tempo_challenges: [challenge],
        })
      )
      .mockImplementationOnce(() => {
        expect(loadTempoChannelAssociation(ENDPOINT, SIGNING.pubkey, creditId)).toMatchObject({
          channelId,
          opened: false,
        });
        throw new DvmError("endpoint_unreachable", "The committed response was lost.");
      });

    const first = await fundCredit(
      args({
        creditId,
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        tempoAccount,
        tempoFetch: ({ fetch, input, init }: TempoFetchArgs) =>
          fetch(input, { ...init, headers: { Authorization: openCredential } }),
      })
    );

    expect(first.status).toBe("refused");
    expect(loadTempoChannelAssociation(ENDPOINT, SIGNING.pubkey, creditId)).toMatchObject({
      channelId,
      opened: false,
    });
    const journaled = vi.mocked(recordPendingFunding).mock.calls.at(-1)?.[0];
    expect(journaled?.mppCredential).toBe(openCredential);
    if (!journaled) return;

    vi.mocked(loadPendingFunding).mockReturnValue(journaled);
    mockCreditOp.mockResolvedValueOnce(fundedResponse());
    const resumed = await fundCredit(
      args({
        creditId,
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        tempoAccount,
        tempoFetch: ({ fetch, input, init }: TempoFetchArgs) => fetch(input, init),
      })
    );

    expect(resumed.status).toBe("funded");
    expect(loadTempoChannelAssociation(ENDPOINT, SIGNING.pubkey, creditId)).toMatchObject({
      channelId,
      opened: true,
    });
  });

  it("records the collateral the opening credential committed, not the funding ask", async () => {
    const creditId = "credit-suggested-deposit";
    const openCredential = await openCredentialFor(creditId, { suggestedDeposit: "180000" });
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Open a session.", undefined, {
          tempo_challenges: [challenge],
        })
      )
      .mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(
      args({
        creditId,
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        maxDepositMicro: 250_000,
        tempoAccount,
        tempoFetch: async ({ fetch, input, init }: TempoFetchArgs) => {
          expect((await fetch(input, init)).status).toBe(402);
          return fetch(input, { ...init, headers: { Authorization: openCredential } });
        },
      })
    );

    expect(outcome.status).toBe("funded");
    expect(loadTempoChannelAssociation(ENDPOINT, SIGNING.pubkey, creditId)).toMatchObject({
      deposit: "180000",
      opened: true,
    });
  });

  it("refuses a credential that would lock more collateral than the funding authorized", async () => {
    const creditId = "credit-oversized-deposit";
    const openCredential = await openCredentialFor(creditId, { suggestedDeposit: "5000000" });
    mockCreditOp.mockRejectedValueOnce(
      new DvmError("payment_required", "Open a session.", undefined, {
        tempo_challenges: [challenge],
      })
    );

    const outcome = await fundCredit(
      args({
        creditId,
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        tempoAccount,
        tempoFetch: async ({ fetch, input, init }: TempoFetchArgs) => {
          expect((await fetch(input, init)).status).toBe(402);
          return fetch(input, { ...init, headers: { Authorization: openCredential } });
        },
      })
    );

    expect(outcome).toMatchObject({
      status: "refused",
      rail: "tempo",
      tempoIntent: "session",
    });
    expect(outcome.error?.code).toBe("tempo_session_deposit_exceeds_limit");
    expect(outcome.display).toContain("$5.00");

    expect(mockCreditOp).toHaveBeenCalledTimes(1);
    expect(loadTempoChannelAssociation(ENDPOINT, SIGNING.pubkey, creditId)).toBeUndefined();
    expect(recordSpendOnce).not.toHaveBeenCalled();
    expect(vi.mocked(recordPendingFunding).mock.calls.at(-1)?.[0].mppCredential).toBeUndefined();
    expect(clearPendingFunding).toHaveBeenCalledWith(ENDPOINT, SIGNING.pubkey, creditId, "fund-1");
  });

  it("refuses a top-up that would carry the channel's collateral past the cap", async () => {
    const creditId = "credit-oversized-topup";
    mockCreditOp.mockRejectedValueOnce(
      new DvmError("payment_required", "Open a session.", undefined, {
        tempo_challenges: [challenge],
      })
    );

    const outcome = await fundCredit(
      args({
        creditId,
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        tempoAccount,
        tempoFetch: async ({ fetch, input, init }: TempoFetchArgs) => {
          expect((await fetch(input, init)).status).toBe(402);
          return fetch(input, {
            ...init,
            headers: { Authorization: topUpCredentialFor("110001") },
          });
        },
      })
    );

    expect(outcome.status).toBe("refused");
    expect(outcome.error?.code).toBe("tempo_session_deposit_exceeds_limit");
    expect(mockCreditOp).toHaveBeenCalledTimes(1);
  });

  it("does not re-check the journaled credential a resume replays", async () => {
    const creditId = "credit-replayed-topup";
    const payer = privateKeyToAccount(tempoAccount.privateKey);
    await createTempoChannelStore({
      endpoint: ENDPOINT,
      callerPubkey: SIGNING.pubkey,
      creditId,
    }).set({
      channelId: `0x${"aa".repeat(32)}`,
      cumulativeAmount: 150_000n,

      deposit: 200_000n,
      descriptor: {
        payer: payer.address,
        payee: `0x${"33".repeat(20)}`,
        operator: `0x${"00".repeat(20)}`,
        token: `0x${"44".repeat(20)}`,
        salt: `0x${"55".repeat(32)}`,
        authorizedSigner: payer.address,
        expiringNonceHash: `0x${"66".repeat(32)}`,
      },
      escrow: TempoSession.Precompile.Constants.tip20ChannelEscrow,
      chainId: 42431,
      opened: true,
    });
    vi.mocked(loadPendingFunding).mockReturnValue(
      pendingFunding({
        creditId,
        rail: "tempo",
        menu: mppMenu,
        mppCredential: topUpCredentialFor("100000"),
        bolt11: undefined,
        paymentHash: undefined,
        amountMsats: undefined,
        expiresAtMs: undefined,
      })
    );
    mockCreditOp.mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(
      args({
        creditId,
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        tempoAccount,
        tempoFetch: ({ fetch, input, init }: TempoFetchArgs) => fetch(input, init),
      })
    );

    expect(outcome.status).toBe("funded");
    expect(clearPendingFunding).toHaveBeenCalledWith(
      ENDPOINT,
      SIGNING.pubkey,
      creditId,
      "fund-original"
    );
  });

  it("refuses a session challenge asking for more than this funding is buying", async () => {
    const creditId = "credit-oversized-challenge";
    mockCreditOp.mockRejectedValueOnce(
      new DvmError("payment_required", "Open a session.", undefined, {
        tempo_challenges: [{ ...challenge, request: { amount: "500000", methodDetails: {} } }],
      })
    );

    const outcome = await fundCredit(
      args({
        creditId,
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        maxDepositMicro: 5_000_000,
        tempoAccount,
        tempoFetch: ({ fetch, input, init }: TempoFetchArgs) => fetch(input, init),
      })
    );

    expect(outcome).toMatchObject({
      status: "refused",
      rail: "tempo",
      tempoIntent: "session",
    });
    expect(outcome.error?.code).toBe("tempo_session_amount_exceeds_limit");
    expect(outcome.display).toContain("$0.50");

    expect(mockCreditOp).toHaveBeenCalledTimes(1);
    expect(loadTempoChannelAssociation(ENDPOINT, SIGNING.pubkey, creditId)).toBeUndefined();
    expect(recordSpendOnce).not.toHaveBeenCalled();
    expect(vi.mocked(recordPendingFunding).mock.calls.at(-1)?.[0].mppCredential).toBeUndefined();
    expect(clearPendingFunding).toHaveBeenCalledWith(ENDPOINT, SIGNING.pubkey, creditId, "fund-1");
  });

  it("refuses a re-challenge after an accepted top-up without claiming nothing moved", async () => {
    const creditId = "credit-post-topup-challenge";
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Open a session.", undefined, {
          tempo_challenges: [challenge],
        })
      )
      .mockRejectedValueOnce(
        new DvmError("payment_invalid", TEMPO_SESSION_UPDATED_REASON, undefined, {
          tempo_challenges: [{ ...challenge, request: { amount: "500000", methodDetails: {} } }],
        })
      );

    const outcome = await fundCredit(
      args({
        creditId,
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        maxDepositMicro: 5_000_000,
        tempoAccount,
        tempoFetch: async ({ fetch, input, init }: TempoFetchArgs) => {
          expect((await fetch(input, init)).status).toBe(402);

          return fetch(input, { ...init, headers: { Authorization: topUpCredential } });
        },
      })
    );

    expect(outcome.status).toBe("refused");
    expect(outcome.error?.code).toBe("tempo_session_amount_exceeds_limit");
    expect(mockCreditOp).toHaveBeenCalledTimes(2);

    expect(recordSpendOnce).not.toHaveBeenCalled();
    expect(outcome.hint).toContain("No voucher was signed");
    expect(outcome.hint).toContain("dvm wallet tempo-exit");
    expect(clearPendingFunding).toHaveBeenCalledWith(ENDPOINT, SIGNING.pubkey, creditId, "fund-1");
  });

  it("books what the voucher authorizes, not what the funding asked for", async () => {
    const creditId = "credit-tolerated-voucher";
    // Inside the shared stablecoin tolerance, so it signs — and the ledger has
    // to book the 105_000 the DVM can capture rather than the 100_000 ask.
    const overChallenge = { ...challenge, request: { amount: "105000", methodDetails: {} } };
    const openCredential = await openCredentialFor(creditId, { amount: "105000" });
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Open a session.", undefined, {
          tempo_challenges: [overChallenge],
        })
      )
      .mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(
      args({
        creditId,
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        maxDepositMicro: 5_000_000,
        tempoAccount,
        tempoFetch: async ({ fetch, input, init }: TempoFetchArgs) => {
          expect((await fetch(input, init)).status).toBe(402);
          return fetch(input, { ...init, headers: { Authorization: openCredential } });
        },
      })
    );

    expect(outcome).toMatchObject({ status: "funded", spentMicro: 105_000 });
    expect(recordSpendOnce).toHaveBeenCalledWith(
      expect.objectContaining({ msats: 105_000, btcRate: 100_000, kind: "credit_fund" })
    );

    expect(vi.mocked(recordPendingFunding).mock.calls.at(-1)?.[0].authorizedMicro).toBe(105_000);
  });

  it("measures and books a reused channel's voucher on what this funding adds", async () => {
    const creditId = "credit-reused-voucher";
    await seedOpenedChannel(creditId, 100_000n);
    mockCreditOp
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Top this session up.", undefined, {
          tempo_challenges: [{ ...challenge, request: { amount: "105000", methodDetails: {} } }],
        })
      )
      .mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(
      args({
        creditId,
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        maxDepositMicro: 5_000_000,
        tempoAccount,
        tempoFetch: async ({ fetch, input, init }: TempoFetchArgs) => {
          expect((await fetch(input, init)).status).toBe(402);
          // mppx adds the challenge amount to the cumulative it already holds.
          return fetch(input, { ...init, headers: { Authorization: voucherFor("205000") } });
        },
      })
    );

    expect(outcome).toMatchObject({ status: "funded", spentMicro: 105_000 });
  });

  it("refuses a reused channel's voucher whose delta is over the ask", async () => {
    const creditId = "credit-reused-overvoucher";
    await seedOpenedChannel(creditId, 100_000n);
    mockCreditOp.mockRejectedValueOnce(
      new DvmError("payment_required", "Top this session up.", undefined, {
        tempo_challenges: [challenge],
      })
    );

    const outcome = await fundCredit(
      args({
        creditId,
        menu: mppMenu,
        providerInfo: {},
        float: null,
        rail: "tempo",
        // The allowance is wider than one funding on purpose, so mppx's own
        // ceiling signs this happily — 400_000 is well under 100_000 + 5_000_000.
        maxDepositMicro: 5_000_000,
        tempoAccount,
        tempoFetch: async ({ fetch, input, init }: TempoFetchArgs) => {
          expect((await fetch(input, init)).status).toBe(402);
          return fetch(input, { ...init, headers: { Authorization: voucherFor("400000") } });
        },
      })
    );

    expect(outcome.status).toBe("refused");
    expect(outcome.error?.code).toBe("tempo_session_amount_exceeds_limit");
    expect(outcome.display).toContain("$0.30");
    expect(mockCreditOp).toHaveBeenCalledTimes(1);
    expect(recordSpendOnce).not.toHaveBeenCalled();
    expect(clearPendingFunding).toHaveBeenCalledWith(ENDPOINT, SIGNING.pubkey, creditId, "fund-1");
  });

  /** A cumulative voucher: capture authority, and no collateral of its own. */
  function voucherFor(cumulativeAmount: string): string {
    return Credential.serialize({
      challenge: { ...challenge, id: "voucher-1" },
      payload: {
        action: "voucher",
        channelId: `0x${"aa".repeat(32)}`,
        descriptor: { payee: `0x${"33".repeat(20)}`, token: `0x${"44".repeat(20)}` },
        cumulativeAmount,
        signature: `0x${"cc".repeat(65)}`,
      },
    } as never);
  }

  async function seedOpenedChannel(
    creditId: string,
    cumulative: bigint,
    deposit = 5_000_000n,
    operator = `0x${"00".repeat(20)}` as `0x${string}`,
    token = `0x${"44".repeat(20)}` as `0x${string}`
  ): Promise<void> {
    const payer = privateKeyToAccount(tempoAccount.privateKey);
    const descriptor = {
      payer: payer.address,
      payee: `0x${"33".repeat(20)}` as `0x${string}`,
      operator,
      token,
      salt: `0x${"55".repeat(32)}` as `0x${string}`,
      authorizedSigner: payer.address,
      expiringNonceHash: `0x${"66".repeat(32)}` as `0x${string}`,
    };
    const escrow = TempoSession.Precompile.Constants.tip20ChannelEscrow;
    await createTempoChannelStore({
      endpoint: ENDPOINT,
      callerPubkey: SIGNING.pubkey,
      creditId,
    }).set({
      channelId: TempoSession.Precompile.Channel.computeId({
        ...descriptor,
        chainId: 42431,
        escrow,
      }),
      cumulativeAmount: cumulative,
      deposit,
      descriptor,
      escrow,
      chainId: 42431,
      opened: true,
    });
  }
});

describe("funding mode", () => {
  const wallet = { privateKey: `0x${"11".repeat(32)}`, address: "", network: "eip155:84532" };
  const tempoAccount = {
    privateKey: `0x${"11".repeat(32)}` as `0x${string}`,
    address: `0x${"22".repeat(20)}` as `0x${string}`,
  };

  const BOTH_TEMPO_MENU: CreditMenu = {
    ...MENU,
    funding: ["tempo"],
    tempo: {
      methods: [
        { method: "tempo", intent: "charge" },
        { method: "tempo", intent: "session" },
      ],
    },
  };
  const SESSION_MENU: CreditMenu = {
    ...MENU,
    funding: ["tempo"],
    tempo: { methods: [{ method: "tempo", intent: "session" }] },
  };
  const CHARGE_ONLY_MENU: CreditMenu = {
    ...MENU,
    funding: ["tempo"],
    tempo: { methods: [{ method: "tempo", intent: "charge" }] },
  };
  const X402_CHANNEL_ONLY_MENU: CreditMenu = {
    ...MENU,
    funding: ["x402"],
    x402: { schemes: [{ scheme: "batch-settlement", network: "eip155:84532" }] },
  };

  const chargeChallenge = {
    id: "charge-1",
    realm: "wordcount.example",
    method: "tempo",
    intent: "charge",
    request: {
      amount: "100000",
      currency: `0x${"33".repeat(20)}`,
      recipient: `0x${"44".repeat(20)}`,
    },
  };
  const chargeCredential = {
    challenge: chargeChallenge,
    payload: { signature: `0x${"55".repeat(65)}` },
  } as never;

  function tempoChallengeError(): DvmError {
    return new DvmError("payment_required", "Pay once.", undefined, {
      tempo_challenges: [chargeChallenge],
    });
  }

  function x402ChallengeError(): DvmError {
    return new DvmError("payment_required", "Payment required.", undefined, {
      x402_payment_required: {
        x402Version: 2,
        resource: { url: `${ENDPOINT}/v1/credit` },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:84532",
            asset: `0x${"22".repeat(20)}`,
            amount: "100000",
            payTo: `0x${"33".repeat(20)}`,
            maxTimeoutSeconds: 60,
            extra: {},
          },
        ],
        extensions: {},
      },
    });
  }

  async function openChannelFor(creditId: string): Promise<void> {
    const payer = privateKeyToAccount(tempoAccount.privateKey);
    await createTempoChannelStore({
      endpoint: ENDPOINT,
      callerPubkey: SIGNING.pubkey,
      creditId,
    }).set({
      channelId: `0x${"77".repeat(32)}`,
      cumulativeAmount: 100_000n,
      deposit: 500_000n,
      descriptor: {
        payer: payer.address,
        payee: `0x${"33".repeat(20)}`,
        operator: `0x${"00".repeat(20)}`,
        token: `0x${"44".repeat(20)}`,
        salt: `0x${"55".repeat(32)}`,
        authorizedSigner: payer.address,
        expiringNonceHash: `0x${"66".repeat(32)}`,
      },
      escrow: TempoSession.Precompile.Constants.tip20ChannelEscrow,
      chainId: 42431,
      opened: true,
    });
  }

  describe("x402", () => {
    beforeEach(() => {
      vi.mocked(loadX402Wallet).mockReturnValue(wallet);
      vi.mocked(tryX402Payment).mockResolvedValue({
        paymentHeader: "exact-signed-header",
        x402Version: 2,
        amountUsdcMicro: "100000",
        amountMsats: 1_000_000,
        btcRate: 100_000,
      });
      vi.mocked(createX402BatchPayment).mockResolvedValue({
        paymentHeader: "verbatim-signed-header",
        channelId: `0x${"44".repeat(32)}`,
        scheme: {} as never,
        maxClaimableMicro: "400000",
        depositMicro: "400000",
        authorizationValidBefore: "1900000000",
      });
    });

    it("drives exact for one-shot where the menu prefers the channel", async () => {
      mockCreditOp
        .mockRejectedValueOnce(x402ChallengeError())
        .mockResolvedValueOnce(fundedResponse());

      const outcome = await fundCredit(
        args({ rail: "x402", menu: X402_MENU, providerInfo: {}, fundingMode: "one-shot" })
      );

      expect(outcome).toMatchObject({
        status: "funded",
        x402Flavour: "exact",
        fundingMode: "one-shot",
        railReason: "forced",
      });
      expect(tryX402Payment).toHaveBeenCalledTimes(1);
      expect(createX402BatchPayment).not.toHaveBeenCalled();
    });

    it("drives batch settlement for reusable", async () => {
      mockCreditOp
        .mockRejectedValueOnce(x402ChallengeError())
        .mockResolvedValueOnce({ ...fundedResponse(), x402PaymentResponse: "settled-response" });

      const outcome = await fundCredit(
        args({ rail: "x402", menu: X402_MENU, providerInfo: {}, fundingMode: "reusable" })
      );

      expect(outcome).toMatchObject({
        status: "funded",
        x402Flavour: "batch-settlement",
        fundingMode: "reusable",
      });
      expect(createX402BatchPayment).toHaveBeenCalledTimes(1);
      expect(tryX402Payment).not.toHaveBeenCalled();
    });

    it("keeps the channel-first preference when no mode is named", async () => {
      mockCreditOp
        .mockRejectedValueOnce(x402ChallengeError())
        .mockResolvedValueOnce({ ...fundedResponse(), x402PaymentResponse: "settled-response" });

      const outcome = await fundCredit(args({ rail: "x402", menu: X402_MENU, providerInfo: {} }));

      expect(outcome).toMatchObject({
        status: "funded",
        x402Flavour: "batch-settlement",
        fundingMode: "reusable",
      });
      expect(tryX402Payment).not.toHaveBeenCalled();
    });

    it("refuses one-shot at a channel-only DVM without signing anything", async () => {
      const outcome = await fundCredit(
        args({
          rail: "x402",
          menu: X402_CHANNEL_ONLY_MENU,
          providerInfo: {},
          fundingMode: "one-shot",
        })
      );

      expect(outcome).toMatchObject({ status: "refused", fundingMode: "one-shot" });
      expect(outcome.error?.code).toBe("funding_mode_unavailable");
      expect(outcome.error?.data).toMatchObject({
        requested_funding_mode: "one-shot",
        available_funding_modes: ["reusable"],
      });
      expect(outcome.display).toContain("Nothing was signed and no money moved.");
      expect(outcome.display).toContain("reusable funding");
      expect(outcome.hint).toContain("manual refund obligation");
      expect(outcome.hint).toContain("per-call payment");
      expect(mockCreditOp).not.toHaveBeenCalled();
      expect(tryX402Payment).not.toHaveBeenCalled();
      expect(createX402BatchPayment).not.toHaveBeenCalled();
    });

    it("keeps the mode-specific refusal when an exact-only provider is filtered from credit", async () => {
      const outcome = await fundCredit(
        args({
          rail: "x402",
          menu: { ...MENU, funding: [] },
          providerInfo: {
            paymentMethods: ["x402"],
            x402: {
              pay_to: `0x${"22".repeat(20)}`,
              network: wallet.network,
              asset: `0x${"33".repeat(20)}`,
            },
          },
          fundingMode: "one-shot",
        })
      );

      expect(outcome).toMatchObject({ status: "refused", fundingMode: "one-shot" });
      expect(outcome.error?.code).toBe("funding_mode_unavailable");
      expect(outcome.error?.data).toMatchObject({
        requested_funding_mode: "one-shot",
        available_funding_modes: [],
        rails: ["x402"],
      });
      expect(outcome.display).toContain("restricts stablecoin credit to reusable channels");
      expect(outcome.display).toContain("Nothing was signed and no money moved.");
      expect(outcome.hint).toContain("single call");
      expect(outcome.hint).toContain("manual refund obligation");
      expect(mockCreditOp).not.toHaveBeenCalled();
      expect(tryX402Payment).not.toHaveBeenCalled();
      expect(createX402BatchPayment).not.toHaveBeenCalled();
    });

    it("does not infer per-call x402 from a stale detail block", async () => {
      const outcome = await fundCredit(
        args({
          rail: "x402",
          menu: { ...MENU, funding: [] },
          providerInfo: {
            paymentMethods: ["cashu"],
            x402: {
              pay_to: `0x${"22".repeat(20)}`,
              network: wallet.network,
              asset: `0x${"33".repeat(20)}`,
            },
          },
          fundingMode: "one-shot",
        })
      );

      expect(outcome.status).toBe("unavailable");
      expect(outcome.error).toBeUndefined();
      expect(outcome.display).toContain("No way to fund a prepaid credit");
      expect(outcome.hint).not.toContain("single call");
      expect(mockCreditOp).not.toHaveBeenCalled();
      expect(tryX402Payment).not.toHaveBeenCalled();
      expect(createX402BatchPayment).not.toHaveBeenCalled();
    });

    it("refuses a mode that disagrees with the credit's own binding", async () => {
      vi.mocked(loadCreditX402Binding).mockReturnValue({ instrument: "x402_channel" });

      const outcome = await fundCredit(
        args({ rail: "x402", menu: X402_MENU, providerInfo: {}, fundingMode: "one-shot" })
      );

      expect(outcome).toMatchObject({ status: "refused", fundingMode: "one-shot" });
      expect(outcome.error?.code).toBe("funding_mode_conflict");
      expect(outcome.error?.data).toMatchObject({ credit_instrument: "x402_channel" });
      expect(outcome.hint).toContain("without --credit-id");
      expect(mockCreditOp).not.toHaveBeenCalled();
      expect(createX402BatchPayment).not.toHaveBeenCalled();
      expect(tryX402Payment).not.toHaveBeenCalled();
    });
  });

  describe("Tempo", () => {
    it("drives a one-shot charge where both intents are advertised", async () => {
      vi.mocked(buildTempoCredential).mockResolvedValueOnce(chargeCredential);
      mockCreditOp
        .mockRejectedValueOnce(tempoChallengeError())
        .mockResolvedValueOnce(fundedResponse());

      const outcome = await fundCredit(
        args({
          menu: BOTH_TEMPO_MENU,
          providerInfo: {},
          float: null,
          rail: "tempo",
          tempoAccount,
          fundingMode: "one-shot",
        })
      );

      expect(outcome).toMatchObject({
        status: "funded",
        rail: "tempo",
        tempoIntent: "charge",
        fundingMode: "one-shot",
      });
      expect(mockCreditOp.mock.calls[1][1]).toMatchObject({
        fund: { method: "tempo", intent: "charge" },
      });

      expect(recordPendingFunding).not.toHaveBeenCalled();
    });

    it("drives the reusable session where both intents are advertised", async () => {

      vi.mocked(tryResolveBtcUsdRate).mockResolvedValueOnce(undefined as never);

      const outcome = await fundCredit(
        args({
          menu: BOTH_TEMPO_MENU,
          providerInfo: {},
          float: null,
          rail: "tempo",
          tempoAccount,
          fundingMode: "reusable",
        })
      );

      expect(outcome).toMatchObject({
        rail: "tempo",
        tempoIntent: "session",
        fundingMode: "reusable",
      });
      expect(buildTempoCredential).not.toHaveBeenCalled();
      expect(recordPendingTempoChargeFunding).not.toHaveBeenCalled();
    });

    it("keeps session-first when no mode is named", async () => {
      vi.mocked(tryResolveBtcUsdRate).mockResolvedValueOnce(undefined as never);

      const outcome = await fundCredit(
        args({
          menu: BOTH_TEMPO_MENU,
          providerInfo: {},
          float: null,
          rail: "tempo",
          tempoAccount,
        })
      );

      expect(outcome).toMatchObject({ tempoIntent: "session", fundingMode: "reusable" });
      expect(buildTempoCredential).not.toHaveBeenCalled();
    });

    it("refuses reusable at a charge-only DVM without signing anything", async () => {
      const outcome = await fundCredit(
        args({
          menu: CHARGE_ONLY_MENU,
          providerInfo: {},
          float: null,
          rail: "tempo",
          tempoAccount,
          fundingMode: "reusable",
        })
      );

      expect(outcome).toMatchObject({ status: "refused", fundingMode: "reusable" });
      expect(outcome.error?.code).toBe("funding_mode_unavailable");
      expect(outcome.error?.data).toMatchObject({ available_funding_modes: ["one-shot"] });
      expect(outcome.display).toContain("Nothing was signed and no money moved.");
      expect(mockCreditOp).not.toHaveBeenCalled();
      expect(buildTempoCredential).not.toHaveBeenCalled();
    });

    it("keeps the mode-specific refusal when a charge-only provider is filtered from credit", async () => {
      const outcome = await fundCredit(
        args({
          rail: "tempo",
          menu: { ...MENU, funding: [] },
          providerInfo: {
            paymentMethods: ["tempo"],
            tempo: {
              methods: [{ method: "tempo", intent: "charge" }],
              realm: "wordcount.example",
            },
          },
          float: null,
          tempoAccount,
          fundingMode: "one-shot",
        })
      );

      expect(outcome).toMatchObject({ status: "refused", fundingMode: "one-shot" });
      expect(outcome.error?.code).toBe("funding_mode_unavailable");
      expect(outcome.error?.data).toMatchObject({
        requested_funding_mode: "one-shot",
        available_funding_modes: [],
        rails: ["tempo"],
      });
      expect(outcome.display).toContain("restricts stablecoin credit to reusable channels");
      expect(outcome.display).toContain("Nothing was signed and no money moved.");
      expect(outcome.hint).toContain("single call");
      expect(outcome.hint).toContain("manual refund obligation");
      expect(mockCreditOp).not.toHaveBeenCalled();
      expect(buildTempoCredential).not.toHaveBeenCalled();
    });

    it("does not infer per-call Tempo from a stale detail block", async () => {
      const outcome = await fundCredit(
        args({
          rail: "tempo",
          menu: { ...MENU, funding: [] },
          providerInfo: {
            paymentMethods: ["cashu"],
            tempo: {
              methods: [{ method: "tempo", intent: "charge" }],
              realm: "wordcount.example",
            },
          },
          float: null,
          tempoAccount,
          fundingMode: "one-shot",
        })
      );

      expect(outcome.status).toBe("unavailable");
      expect(outcome.error).toBeUndefined();
      expect(outcome.display).toContain("No way to fund a prepaid credit");
      expect(outcome.hint).not.toContain("single call");
      expect(mockCreditOp).not.toHaveBeenCalled();
      expect(buildTempoCredential).not.toHaveBeenCalled();
    });

    it("refuses one-shot against a credit that already holds an open channel", async () => {
      const creditId = "credit-mode-channel-bound";
      await openChannelFor(creditId);

      const outcome = await fundCredit(
        args({
          creditId,
          menu: BOTH_TEMPO_MENU,
          providerInfo: {},
          float: null,
          rail: "tempo",
          tempoAccount,
          fundingMode: "one-shot",
        })
      );

      expect(outcome).toMatchObject({ status: "refused", fundingMode: "one-shot" });
      expect(outcome.error?.code).toBe("funding_mode_conflict");
      expect(outcome.error?.data).toMatchObject({ credit_instrument: "tempo_session" });
      expect(mockCreditOp).not.toHaveBeenCalled();
      expect(buildTempoCredential).not.toHaveBeenCalled();
    });

    it("still refuses without a menu to read, on the binding alone", async () => {
      const creditId = "credit-mode-channel-bound-no-menu";
      await openChannelFor(creditId);

      const outcome = await fundCredit(
        args({
          creditId,
          menu: undefined,
          providerInfo: {},
          float: null,
          rail: "tempo",
          tempoAccount,
          fundingMode: "one-shot",
        })
      );

      expect(outcome.error?.code).toBe("funding_mode_conflict");
      expect(mockCreditOp).not.toHaveBeenCalled();
    });
  });

  describe("rails and resumes", () => {
    it("refuses a mode against a credit bound to a Bitcoin rail", async () => {
      const outcome = await fundCredit(
        args({ rail: "lightning", railSource: "credit_bound", fundingMode: "reusable" })
      );

      expect(outcome).toMatchObject({ status: "refused", fundingMode: "reusable" });
      expect(outcome.error?.code).toBe("funding_mode_unavailable");
      expect(outcome.error?.data).toMatchObject({ rail: "lightning" });
      expect(outcome.hint).toContain("bound to it");
      expect(mockCreditOp).not.toHaveBeenCalled();
      expect(fundViaFloat).not.toHaveBeenCalled();
    });

    it("refuses when no stablecoin rail is eligible at all", async () => {
      const outcome = await fundCredit(args({ fundingMode: "reusable" }));

      expect(outcome).toMatchObject({ status: "refused" });
      expect(outcome.error?.code).toBe("funding_mode_unavailable");
      expect(outcome.hint).toContain("tempo-connect");
      expect(mockCreditOp).not.toHaveBeenCalled();
      expect(prepareAgentSpend).not.toHaveBeenCalled();
    });

    it("checks the mode against the forced rail, not a sibling that also qualifies", async () => {

      vi.mocked(loadX402Wallet).mockReturnValue(wallet);

      const outcome = await fundCredit(
        args({
          rail: "x402",
          menu: {
            ...MENU,
            funding: ["x402", "tempo"],
            x402: { schemes: [{ scheme: "batch-settlement", network: "eip155:84532" }] },
            tempo: { methods: [{ method: "tempo", intent: "charge" }] },
          },
          providerInfo: {},
          float: null,
          tempoAccount,
          fundingMode: "one-shot",
        })
      );

      expect(outcome.error?.code).toBe("funding_mode_unavailable");
      expect(outcome.error?.data).toMatchObject({ rails: ["x402"] });
      expect(mockCreditOp).not.toHaveBeenCalled();
      expect(tryX402Payment).not.toHaveBeenCalled();
    });

    it("leaves a forced rail nothing can drive to the forced-rail refusal", async () => {

      const outcome = await fundCredit(
        args({
          rail: "tempo",
          menu: SESSION_MENU,
          providerInfo: {},
          float: null,
          tempoAccount: null,
          fundingMode: "reusable",
        })
      );

      expect(outcome.status).toBe("unavailable");
      expect(outcome.error?.code).toBeUndefined();
      expect(outcome.display).toContain("No way to fund a prepaid credit");
      expect(mockCreditOp).not.toHaveBeenCalled();
    });

    it("routes past a rail that only advertises the other instrument", async () => {

      vi.mocked(loadX402Wallet).mockReturnValue(wallet);
      vi.mocked(buildTempoCredential).mockResolvedValueOnce(chargeCredential);
      mockCreditOp
        .mockRejectedValueOnce(tempoChallengeError())
        .mockResolvedValueOnce(fundedResponse());

      const outcome = await fundCredit(
        args({
          menu: {
            ...MENU,
            funding: ["x402", "tempo"],
            x402: { schemes: [{ scheme: "batch-settlement", network: "eip155:84532" }] },
            tempo: { methods: [{ method: "tempo", intent: "charge" }] },
          },
          providerInfo: {},
          float: null,
          tempoAccount,
          fundingMode: "one-shot",
        })
      );

      expect(outcome).toMatchObject({
        status: "funded",
        rail: "tempo",
        tempoIntent: "charge",
        fundingMode: "one-shot",
      });
      expect(tryX402Payment).not.toHaveBeenCalled();
      expect(createX402BatchPayment).not.toHaveBeenCalled();

      expect(mockCreditOp).toHaveBeenCalledTimes(2);
    });

    it("never lets a mode reinterpret a journalled authorization", async () => {
      vi.mocked(loadX402Wallet).mockReturnValue(wallet);
      vi.mocked(loadResumableX402ExactFunding).mockReturnValue({
        endpoint: ENDPOINT,
        callerPubkey: SIGNING.pubkey,
        creditId: "credit-1",
        fundId: "fund-signed",
        amountMicro: 100_000,
        targetMicro: 100_000,
        paymentHeader: "already-signed-header",
        requestedAt: Date.now() - 1_000,
        authorizationValidBefore: String(Math.floor(Date.now() / 1000) + 600),
        x402Version: 2,
        amountMsats: 1_000_000,
        btcRate: 100_000,
      } satisfies PendingX402ExactFunding);
      mockCreditOp.mockResolvedValueOnce(fundedResponse());

      const outcome = await fundCredit(
        args({ rail: "x402", menu: X402_MENU, providerInfo: {}, fundingMode: "reusable" })
      );

      expect(outcome).toMatchObject({
        status: "funded",
        fundId: "fund-signed",
        x402Flavour: "exact",
        fundingMode: "one-shot",
      });
      expect(createX402BatchPayment).not.toHaveBeenCalled();
    });
  });
});

describe("pickCreditFundRail", () => {
  const FLOOR_MENU: CreditMenu = { ...MENU, lightning_min_micro: 57_500 };
  const BOTH: CreditFundRail[] = ["cashu", "lightning"];

  it("is the single declaration of which rails exist", () => {

    expect([...CREDIT_FUND_RAILS]).toEqual(["cashu", "lightning", "x402", "tempo"]);
    for (const rail of CREDIT_FUND_RAILS) expect(isCreditFundRail(rail)).toBe(true);
    for (const junk of ["bolt12", "", "CASHU", undefined, null, 1]) {
      expect(isCreditFundRail(junk)).toBe(false);
    }

    for (const rail of CREDIT_FUND_RAILS) {
      expect(
        pickCreditFundRail({ rails: CREDIT_FUND_RAILS, amountMicro: 100_000, forced: rail }).order
      ).toEqual([rail]);
    }
  });

  it("sends a floor-clearing amount to the float first, and says why", () => {
    const pick = pickCreditFundRail({ rails: BOTH, amountMicro: 100_000, menu: FLOOR_MENU });
    expect(pick.order).toEqual(["lightning", "cashu"]);
    expect(pick.reason).toBe("above_lightning_minimum");
  });

  it.each([
    [
      "below the floor",
      { rails: BOTH, amountMicro: 30_000, menu: FLOOR_MENU },
      "below_lightning_minimum",
    ],
    [
      "no float connected",
      { rails: ["cashu" as const], amountMicro: 100_000, menu: FLOOR_MENU },
      "no_float",
    ],
    [
      "DVM offers no lightning",
      { rails: ["cashu" as const], amountMicro: 100_000, menu: { ...MENU, funding: ["cashu"] } },
      "lightning_not_offered",
    ],
    [
      "no advertised floor",
      { rails: BOTH, amountMicro: 5_000_000, menu: MENU },
      "no_lightning_minimum",
    ],
  ])("keeps cashu first: %s", (_label, input, reason) => {
    const pick = pickCreditFundRail(input as Parameters<typeof pickCreditFundRail>[0]);
    expect(pick.order[0]).toBe("cashu");
    expect(pick.reason).toBe(reason);
  });

  it.each([
    ["the channel is on this wallet's chain", "eip155:8453", "x402_channel"],
    ["the channel is on some other chain", "eip155:84532", "x402_exact"],
    ["no wallet chain is known", undefined, "x402_channel"],
  ])("names the x402 flavour it will drive: %s", (_label, x402Network, reason) => {

    const split: CreditMenu = {
      ...MENU,
      funding: ["x402"],
      x402: {
        schemes: [
          { scheme: "batch-settlement", network: "eip155:8453" },
          { scheme: "exact", network: "eip155:84532" },
        ],
      },
    };
    const pick = pickCreditFundRail({
      rails: ["x402"],
      amountMicro: 100_000,
      menu: split,
      ...(x402Network ? { x402Network } : {}),
    });
    expect(pick.reason).toBe(reason);
  });

  it("forces past the floor rather than rerouting — refusal is the downstream's job", () => {
    const pick = pickCreditFundRail({
      rails: BOTH,
      amountMicro: 30_000,
      menu: FLOOR_MENU,
      forced: "lightning",
      forcedSource: "global",
    });
    expect(pick.order).toEqual(["lightning"]);
    expect(pick.reason).toBe("forced");
    expect(pick.source).toBe("global");
  });

  it.each([
    ["session", "tempo_session_available"],
    ["charge", "tempo_charge"],
  ] as const)("names the Tempo %s flavour it will drive", (intent, reason) => {
    const pick = pickCreditFundRail({
      rails: ["tempo"],
      amountMicro: 100_000,
      menu: {
        ...MENU,
        funding: ["tempo"],
        tempo: { methods: [{ method: "tempo", intent }] },
      },
    });
    expect(pick.reason).toBe(reason);
  });

  it.each([
    ["one-shot", "tempo", "tempo_charge"],
    ["reusable", "tempo", "tempo_session_available"],
    ["one-shot", "x402", "x402_exact"],
    ["reusable", "x402", "x402_channel"],
  ] as const)(
    "reports the %s instrument a forced mode drives on %s, not the menu's preference",
    (fundingMode, rail, reason) => {
      const pick = pickCreditFundRail({
        rails: [rail],
        amountMicro: 100_000,
        x402Network: "eip155:84532",
        menu: {
          ...MENU,
          funding: [rail],
          tempo: {
            methods: [
              { method: "tempo", intent: "charge" },
              { method: "tempo", intent: "session" },
            ],
          },
          x402: {
            schemes: [
              { scheme: "exact", network: "eip155:84532" },
              { scheme: "batch-settlement", network: "eip155:84532" },
            ],
          },
        },
        fundingMode,
      });
      expect(pick.reason).toBe(reason);
    }
  );

  it("reports a charge when a withheld session has no open association", () => {
    const pick = pickCreditFundRail({
      rails: ["tempo"],
      amountMicro: 100_000,
      menu: {
        ...MENU,
        funding: ["tempo"],
        tempo: {
          methods: [{ method: "tempo", intent: "charge" }],
          withheld: [{ method: "tempo", intent: "session", reason: "observer_unhealthy" }],
        },
      },
      tempoCredit: {
        endpoint: ENDPOINT,
        callerPubkey: SIGNING.pubkey,
        creditId: "credit-route-withheld-no-association",
      },
    });

    expect(pick.reason).toBe("tempo_charge");
  });

  it("yields an empty order for a forced rail nothing can drive", () => {
    const pick = pickCreditFundRail({
      rails: ["cashu"],
      amountMicro: 100_000,
      forced: "lightning",
    });
    expect(pick.order).toEqual([]);
  });

  it("rides every outcome, including the rail that answered second", async () => {

    vi.mocked(prepareAgentSpend).mockImplementation(preparedSpend() as never);
    mockCreditOp
      .mockRejectedValueOnce(new DvmError("lightning_unavailable", "No invoice right now."))
      .mockResolvedValueOnce(fundedResponse());

    const outcome = await fundCredit(args({ menu: FLOOR_MENU, amountMicro: 100_000 }));

    expect(outcome.status).toBe("funded");
    expect(outcome.rail).toBe("cashu");
    expect(outcome.railReason).toBe("above_lightning_minimum");
  });

  it.each([
    ["per_dvm", "dvm credit rail --clear --dvm"],
    ["global", "dvm credit rail --clear"],
    ["credit_bound", "drain it and open a new credit"],
  ])(
    "tells a %s force how to release it, not to drop a flag it never passed",
    async (source, copy) => {
      const outcome = await fundCredit(
        args({ rail: "lightning", railSource: source, float: null, amountMicro: 100_000 })
      );

      expect(outcome.status).toBe("unavailable");
      expect(outcome.railSource).toBe(source);
      expect(outcome.hint).toContain(copy);
      expect(outcome.hint).not.toContain("Drop --rail");
    }
  );

  it.each([
    ["per_dvm", "tempo-connect', or run 'dvm credit rail --clear --dvm"],
    ["credit_bound", "tempo-connect'. This credit is bound"],
  ])("composes a %s Tempo force with its own release sentence", async (source, copy) => {
    const outcome = await fundCredit(
      args({
        rail: "tempo",
        railSource: source,
        menu: {
          ...MENU,
          funding: ["tempo"],
          tempo: { methods: [{ method: "tempo", intent: "charge" }] },
        },
        providerInfo: {},
        float: null,
        tempoAccount: null,
      })
    );

    expect(outcome.status).toBe("unavailable");
    expect(outcome.hint).toContain(copy);
    expect(outcome.hint).not.toContain("Drop --rail");
  });

  it("still says 'drop --rail' when a flag was what forced it", async () => {
    const outcome = await fundCredit(args({ rail: "lightning", float: null }));
    expect(outcome.hint).toContain("drop --rail");
  });

  it("gives a binding its own sentence — it is a fact, not an alternative to offer", async () => {

    const outcome = await fundCredit(
      args({ rail: "lightning", railSource: "credit_bound", float: null, amountMicro: 100_000 })
    );

    expect(outcome.hint).toContain("piping the connection string in. This credit is bound");
    expect(outcome.hint).not.toContain("or this credit is bound");
  });

  it("doesn't offer ecash to a bound credit refused below the Lightning floor", async () => {

    const outcome = await fundCredit(
      args({
        rail: "lightning",
        railSource: "credit_bound",
        menu: FLOOR_MENU,
        amountMicro: 30_000,
      })
    );

    expect(outcome.error?.code).toBe("below_rail_minimum");
    expect(outcome.hint).not.toContain("ecash funds any amount here");
    expect(outcome.hint).toContain("drain it and open a new credit");
  });
});
