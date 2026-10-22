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

import { waitForJob } from "../src/lib/wait-for-job";
import { DvmError, type Message } from "@dvmkit/sdk/internal";
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


  // A refused or never-dispatched payment must not prevent paying the same ask later.
  it.each([
    ["payment_invalid", () => new DvmError("payment_invalid", "Invalid payment", undefined, { http_status: 402 })],
    ["payment_insufficient", () => new DvmError("payment_insufficient", "Insufficient payment", undefined, { http_status: 402 })],
    ["structured refusal", () => new DvmError("invalid_request", "Invalid request", undefined, { http_status: 400 })],
    ["connection refused", () => new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) })],
    ["DNS failure", () => new TypeError("fetch failed", { cause: Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" }) })],
  ])("releases the in-flight request after %s", async (label, makeError) => {
    const { store, jobId, ask, transport } = await setup(label);
    transport.sendMessage.mockRejectedValueOnce(makeError());
    await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 })).rejects.toBeTruthy();
    expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toBeUndefined();
    await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 }))
      .resolves.toMatchObject({ status: "paid" });
    expect(transport.sendMessage).toHaveBeenCalledTimes(2);
    expect(store.loadJob(jobId)?.paidPaymentRequestSeqs).toEqual([5]);
  });

  it("records replay_rejected as paid without sending another payment", async () => {
    const { store, jobId, ask, transport } = await setup("replay");
    transport.sendMessage.mockRejectedValueOnce(new DvmError("replay_rejected", "Already accepted", undefined, { http_status: 409 }));
    await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 }))
      .resolves.toMatchObject({ status: "paid" });
    expect(store.loadJob(jobId)?.paidPaymentRequestSeqs).toEqual([5]);
    expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toBeUndefined();
    await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 }))
      .rejects.toMatchObject({ code: "payment_already_sent" });
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["timeout", () => new DvmError("timeout", "Reply lost")],
    ["connection reset", () => new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) })],
    ["unstructured server failure", () => new DvmError("provider_error", "Server failed", undefined, { http_status: 500 })],
    ["unparseable reply", () => new SyntaxError("Invalid JSON")],
  ])("retains %s until history can resolve it", async (label, makeError) => {
    const { store, jobId, ask, transport } = await setup(label);
    transport.sendMessage.mockRejectedValueOnce(makeError());
    await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 })).rejects.toBeTruthy();
    expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toEqual([5]);
    transport.getMessages.mockRejectedValueOnce(new DvmError("provider_unreachable", "History unavailable"));
    await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 }))
      .rejects.toMatchObject({ code: "provider_unreachable" });
    expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toEqual([5]);
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("explicit pay resolves an unknown send from history (paid=%s)", async (paid) => {
    const { store, jobId, ask, transport, history } = await setup(`manual-${paid}`);
    transport.sendMessage.mockRejectedValueOnce(new DvmError("timeout", "Reply lost"));
    await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 })).rejects.toMatchObject({ code: "timeout" });
    transport.getMessages.mockResolvedValue(history(paid));
    transport.sendMessage.mockImplementation(async () => {
      expect(transport.getMessages).toHaveBeenCalledWith(jobId, 0, provider, { jobToken: "job-token" });
    });
    const retry = handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 });
    if (paid) await expect(retry).rejects.toMatchObject({ code: "payment_already_sent" });
    else await expect(retry).resolves.toMatchObject({ status: "paid" });
    expect(transport.sendMessage).toHaveBeenCalledTimes(paid ? 1 : 2);
    expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toBeUndefined();
    expect(store.loadJob(jobId)?.paidPaymentRequestSeqs).toEqual([5]);
  });

  it.each([false, true])("wait resolves an unknown send from history (paid=%s)", async (paid) => {
    vi.useFakeTimers();
    try {
      const { store, jobId, ask, transport, history } = await setup(`wait-${paid}`);
      transport.sendMessage.mockRejectedValueOnce(new DvmError("timeout", "Reply lost"));
      await expect(handlePaymentRequest(jobId, ask, policy, transport, provider, { rail: "x402", requestSeq: 5 })).rejects.toMatchObject({ code: "timeout" });
      transport.getMessages.mockResolvedValue(history(paid));
      const stream = vi.fn().mockResolvedValueOnce({ messages: history(false) })
        .mockResolvedValue({ messages: [{ seq: 7, from: "provider", timestamp: 0, type: "prompt", content: { id: "continue", text: "Continue?" } }] });
      const pending = waitForJob({ jobId, policy, provider, transport: { ...transport, stream }, afterSeq: 4, jobToken: "job-token" }, 60_000);
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.nextAction).toMatchObject({ type: "respond", prompt_id: "continue" });
      expect(result.autoPayments).toHaveLength(paid ? 0 : 1);
      expect(transport.sendMessage).toHaveBeenCalledTimes(paid ? 1 : 2);
      expect(transport.getMessages).toHaveBeenCalledWith(jobId, 0, provider, { jobToken: "job-token", timeoutMs: expect.any(Number) });
      expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toBeUndefined();
      expect(store.loadJob(jobId)?.paidPaymentRequestSeqs).toEqual([5]);
    } finally { vi.useRealTimers(); }
  });
  it("retries an uncertain-payment history timeout before automatic spending", async () => {
    vi.useFakeTimers();
    try {
      const { store, jobId, transport, history } = await setup("history-timeout");
      store.markPaymentRequestInFlight(jobId, 5);
      transport.getMessages.mockRejectedValueOnce(new DvmError("timeout", "History timed out"))
        .mockResolvedValue(history(true));
      const stream = vi.fn().mockResolvedValue({ messages: [{ seq: 7, from: "provider", timestamp: 0, type: "prompt", content: { id: "continue", text: "Continue?" } }] });
      const start = Date.now();
      const pending = waitForJob({ jobId, policy, provider, transport: { ...transport, stream }, afterSeq: 5, jobToken: "job-token" }, 60_000);
      await vi.runAllTimersAsync();
      expect((await pending).nextAction).toMatchObject({ type: "respond" });
      expect(Date.now() - start).toBe(1000);
      expect(transport.getMessages).toHaveBeenCalledTimes(2);
      expect(transport.sendMessage).not.toHaveBeenCalled();
      expect(store.loadJob(jobId)?.paidPaymentRequestSeqs).toEqual([5]);
      expect(store.loadJob(jobId)?.inFlightPaymentRequestSeqs).toBeUndefined();
    } finally { vi.useRealTimers(); }
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

async function setup(label: string) {
  const store = await vi.importActual<typeof import("../src/lib/job-store")>("../src/lib/job-store");
  const jobId = `payment-${label}`;
  store.saveJob({ id: jobId, endpoint: provider.endpoint, status: "processing", submittedAt: 0, jobToken: "job-token" });
  sdk.loadJob.mockImplementation(store.loadJob);
  sdk.tryX402Payment.mockResolvedValue({ paymentHeader: "x402-proof", amountMsats: 12_000, amountUsdcMicro: "10000", btcRate: 100_000 });
  const ask = request({ x402: x402Offer });
  const transport = { ...fakeTransport(), getMessages: vi.fn().mockResolvedValue([]), status: vi.fn().mockResolvedValue({ status: "processing" }) };
  const history = (paid: boolean): Message[] => [
    { seq: 5, from: "provider", timestamp: 0, type: "payment-request", content: ask },
    ...(paid ? [{ seq: 6, from: "requester", timestamp: 0, type: "payment", content: { amount_msats: 12_000 } } as Message] : []),
  ];
  return { store, jobId, ask, transport, history };
}
