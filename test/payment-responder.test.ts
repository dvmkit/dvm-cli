vi.mock("../src/lib/payment-rails/tempo-credential", () => ({ buildTempoCredential: sdk.buildTempoCredential }));
vi.mock("../src/lib/x402/client", async () => ({ ...(await vi.importActual<typeof import("../src/lib/x402/client")>("../src/lib/x402/client")), tryX402Payment: sdk.tryX402Payment }));
vi.mock("../src/lib/x402/wallet", async () => ({ ...(await vi.importActual<typeof import("../src/lib/x402/wallet")>("../src/lib/x402/wallet")), loadX402Wallet: sdk.loadX402Wallet }));
vi.mock("../src/lib/identity", async () => ({ ...(await vi.importActual<typeof import("../src/lib/identity")>("../src/lib/identity")), loadConfig: sdk.loadConfig }));
vi.mock("../src/lib/job-store", async () => ({ ...(await vi.importActual<typeof import("../src/lib/job-store")>("../src/lib/job-store")), addPayment: sdk.addPayment,
loadJob: sdk.loadJob }));
import type {
  JobPolicy,
  PaymentRequestContent,
  ProviderRef,
  Transport,
} from "@dvmkit/sdk/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  addPayment: vi.fn(),
  buildTempoCredential: vi.fn(),
  enforceGlobalBudget: vi.fn(),
  loadAgentWallet: vi.fn(),
  loadConfig: vi.fn(),
  loadJob: vi.fn(),
  loadX402Wallet: vi.fn(),
  recordSpend: vi.fn(),
  tempoCredentialAmountMicro: vi.fn(),
  tryX402Payment: vi.fn(),
  usdcToMsats: vi.fn(),
}));

vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
  addPayment: sdk.addPayment,
  buildTempoCredential: sdk.buildTempoCredential,
  loadAgentWallet: sdk.loadAgentWallet,
  loadConfig: sdk.loadConfig,
  loadJob: sdk.loadJob,
  loadX402Wallet: sdk.loadX402Wallet,
  tempoCredentialAmountMicro: sdk.tempoCredentialAmountMicro,
  tryX402Payment: sdk.tryX402Payment,
  usdcToMsats: sdk.usdcToMsats,
}));

vi.mock("../src/lib/budget-ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/budget-ledger")>()),
  enforceGlobalBudget: sdk.enforceGlobalBudget,
  recordSpend: sdk.recordSpend,
}));

import { handlePaymentRequest } from "../src/lib/payment-responder";

const policy: JobPolicy = {
  maxTotalMsats: 100_000,
  autoPayBelowMsats: 100_000,
  maxIncrementMsats: 100_000,
  maxPayments: 1,
};
const provider = { endpoint: "https://dvm.example" } as ProviderRef;
const x402Offer = {
  required_usdc_micro: "10000",
  pay_to: "0x0000000000000000000000000000000000000001",
  network: "eip155:8453",
  asset: "0x0000000000000000000000000000000000000002",
  payment_required: "challenge",
} as unknown as NonNullable<PaymentRequestContent["x402"]>;
const tempoOffer = {
  challenges: [{ method: "tempo" }],
} as unknown as NonNullable<PaymentRequestContent["tempo"]>;

afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("mid-job payment rail selection", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("Network disabled for this unit test");
    }));
    sdk.loadJob.mockReturnValue({
      endpoint: provider.endpoint,
      totalPaidMsats: 0,
      paymentsHonoured: 0,
      jobToken: "job-token",
    });
    sdk.enforceGlobalBudget.mockResolvedValue(100_000);
    sdk.loadAgentWallet.mockReturnValue({ proofs: [{}] });
    sdk.loadConfig.mockReturnValue({ tempo: { method: "tempo", apiKey: "0xkey" } });
    sdk.loadX402Wallet.mockReturnValue({ privateKey: "0xkey" });
    sdk.tempoCredentialAmountMicro.mockReturnValue(10_000n);
    sdk.usdcToMsats.mockReturnValue(12_000);
  });

  it.each(["auto", "explicit"] as const)("records %s approval on a successful forced x402 payment", async (approval) => {
    sdk.tryX402Payment.mockResolvedValue({
      paymentHeader: "x402-proof",
      amountMsats: 12_000,
      amountUsdcMicro: "10000",
      btcRate: 100_000,
    });
    const transport = fakeTransport();

    const result = await handlePaymentRequest(
      "job-1",
      request({
        x402: x402Offer,
      }),
      policy,
      transport,
      provider,
      { rail: "x402", requestSeq: 3, approval }
    );

    expect(result).toMatchObject({ status: "paid", rail: "x402" });
    expect(sdk.addPayment).toHaveBeenCalledWith("job-1", 12_000, { requestSeq: 3, approval });
    expect(sdk.loadAgentWallet).not.toHaveBeenCalled();
    expect(sdk.buildTempoCredential).not.toHaveBeenCalled();
    expect(transport.sendMessage).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({
        content: expect.objectContaining({ x402_payment: "x402-proof" }),
      }),
      provider,
      { jobToken: "job-token" }
    );
  });

  it("forces Tempo without inspecting or falling through to Cashu or x402", async () => {
    sdk.buildTempoCredential.mockReturnValue({ credential: "tempo-proof" });
    const transport = fakeTransport();

    const result = await handlePaymentRequest(
      "job-1",
      request({ tempo: tempoOffer }),
      policy,
      transport,
      provider,
      { rail: "tempo" }
    );

    expect(result).toMatchObject({ status: "paid", rail: "tempo" });
    expect(sdk.loadAgentWallet).not.toHaveBeenCalled();
    expect(sdk.loadX402Wallet).not.toHaveBeenCalled();
    expect(transport.sendMessage).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({
        content: expect.objectContaining({ tempo_credential: { credential: "tempo-proof" } }),
      }),
      provider,
      { jobToken: "job-token" }
    );
  });

  it("refuses a mid-job Tempo challenge for the other network before signing", async () => {
    sdk.loadConfig.mockReturnValue({
      tempo: { method: "tempo", apiKey: "0xkey", network: "moderato" },
    });
    const transport = fakeTransport();
    const mismatched = {
      challenges: [
        {
          method: "tempo",
          intent: "charge",
          request: { methodDetails: { chainId: 4217 } },
        },
      ],
    } as unknown as NonNullable<PaymentRequestContent["tempo"]>;

    await expect(
      handlePaymentRequest(
        "job-1",
        request({ tempo: mismatched }),
        policy,
        transport,
        provider,
        { rail: "tempo" }
      )
    ).rejects.toMatchObject({ code: "tempo_network_mismatch" });

    expect(sdk.buildTempoCredential).not.toHaveBeenCalled();
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it("does not fall through when forced Cashu is unavailable", async () => {
    sdk.loadAgentWallet.mockReturnValue(null);
    const transport = fakeTransport();

    const result = await handlePaymentRequest(
      "job-1",
      request({
        x402: x402Offer,
        tempo: tempoOffer,
      }),
      policy,
      transport,
      provider,
      { rail: "cashu" }
    );

    expect(result).toBe("needs-approval");
    expect(sdk.loadX402Wallet).not.toHaveBeenCalled();
    expect(sdk.loadConfig).not.toHaveBeenCalled();
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects an over-ceiling Cashu principal before inspecting the wallet", async () => {
    const transport = fakeTransport();

    await expect(
      handlePaymentRequest("job-1", request({ amount_msats: 40_001 }), policy, transport, provider, {
        rail: "cashu",
        maxCashuPrincipalSats: 40,
      })
    ).rejects.toMatchObject({ code: "cashu_principal_ceiling_exceeded" });

    expect(sdk.loadAgentWallet).not.toHaveBeenCalled();
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });
});

function request(
  overrides: Partial<PaymentRequestContent> = {}
): PaymentRequestContent {
  return {
    amount_msats: 10_000,
    reason: "Continue the job",
    ...overrides,
  } as PaymentRequestContent;
}

function fakeTransport(): Transport & { sendMessage: ReturnType<typeof vi.fn> } {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  } as unknown as Transport & { sendMessage: ReturnType<typeof vi.fn> };
}
