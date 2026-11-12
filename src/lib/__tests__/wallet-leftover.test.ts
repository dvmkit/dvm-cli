import { attestedDvm } from "./fixtures/receipt-fixture";
import { writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Wallet } from "@cashu/cashu-ts";
import { JOBS_FILE, loadAgentWallet, getLastKnownBtcRate, getX402Balance, getTempoUsdcBalance } from "@dvmkit/sdk/internal";
import { loadConfig } from "../identity";
import { loadMessages } from "../messages";
import { type JobRecord } from "../job-store";
import { terminalSettlementReport } from "../job-settlement";
import { receiptJsonFields, renderReceiptHuman, observedSettlementFields, renderSettlementHuman } from "../receipt-capture";
import { rememberKeysetFees } from "../wallet-keyset-fees";
import { info } from "../output";

vi.mock("@dvmkit/sdk/internal", async (original) => ({
  ...await original<typeof import("@dvmkit/sdk/internal")>(),
  loadAgentWallet: vi.fn(), getLastKnownBtcRate: vi.fn(),
  ensureAddress: vi.fn(async (wallet) => wallet), getX402Balance: vi.fn(), getTempoUsdcBalance: vi.fn(),
}));
vi.mock("../identity", () => ({ loadConfig: vi.fn() }));
vi.mock("../messages", () => ({ loadMessages: vi.fn(() => []) }));
vi.mock("../x402/wallet", () => ({ loadX402Wallet: vi.fn(() => ({ address: "0x123", network: "eip155:8453" })) }));
vi.mock("../payment-rails/tempo-wallet", () => ({ connectedTempoAccount: vi.fn(async () => ({ address: "0x123" })) }));
vi.mock("../output", async (original) => ({ ...await original<typeof import("../output")>(), info: vi.fn() }));

const job: JobRecord = { id: "leftover-job", endpoint: "https://service.example", status: "completed", submittedAt: 1,
  paymentMethod: "cashu", costMsats: 550_000 };
function storeJob(record: JobRecord) { writeFileSync(JOBS_FILE, JSON.stringify([record])); }
function balance(sats: number) {
  vi.mocked(loadAgentWallet).mockReturnValue({ lock_pubkey: "key", proofs: sats === 0 ? [] : [
    { mint: "https://mint.example", id: "01", amount: sats - 1, status: "valid", locked_to_pubkey: "key" },
    { mint: "https://mint.example", id: "01", amount: 1, status: "valid", locked_to_pubkey: null },
  ] } as ReturnType<typeof loadAgentWallet>);
}

beforeEach(() => {
  vi.mocked(loadMessages).mockReturnValue([]);
  vi.mocked(loadConfig).mockReturnValue(null);
  vi.mocked(getLastKnownBtcRate).mockReturnValue({ rate: 50_000, cachedAt: Date.now() });
  balance(900);
  storeJob(job);
  rememberKeysetFees("https://mint.example", { keyChain: { getKeysets: () => [{ id: "01", fee: 1000 }] } } as unknown as Wallet);
});

describe("terminal wallet report", () => {
  it("reports local change and subtracts input fees and a routing reserve for an invoice", async () => {
    const fields = await terminalSettlementReport(job.id);
    expect(fields.wallet_remaining).toEqual({ rail: "cashu", amount_sats: 900, usd: "$0.45", can_send_back: true,
      invoice_amount_sats: 880,
      hint: "Run dvm wallet cash-out <lightning-address> --all or dvm wallet cash-out <invoice>.",
      display: "$0.45 of what you paid is left over from this job. I can keep it for your next job, or send it back to you; for that I need your Lightning address or an invoice for $0.44.",
    });
    expect(getX402Balance).not.toHaveBeenCalled();
    const receipt = { status: "absent", display: "No receipt" } as const;
    expect((await receiptJsonFields(receipt, job.id)).wallet_remaining).toEqual(fields.wallet_remaining);
    await renderReceiptHuman(receipt, job.id);
    expect(info).toHaveBeenCalledWith(fields.wallet_remaining!.display);
    const observed = await observedSettlementFields(job.id, { status: "completed" });
    expect(observed.wallet_remaining).toEqual(fields.wallet_remaining);
    renderSettlementHuman(observed);
    expect(info).toHaveBeenLastCalledWith(fields.wallet_remaining!.display);
  });

  it("floors the invoice to cents without consuming its routing allowance", async () => {
    balance(905);
    const remaining = (await terminalSettlementReport(job.id)).wallet_remaining!;
    expect(remaining.invoice_amount_sats).toBe(880);
    expect(remaining.display).toContain("an invoice for $0.44.");
  });

  it("covers the cents quote when it converts to a fractional sat", async () => {
    vi.mocked(getLastKnownBtcRate).mockReturnValue({ rate: 60_000, cachedAt: Date.now() });
    const remaining = (await terminalSettlementReport(job.id)).wallet_remaining!;
    expect(remaining.invoice_amount_sats).toBe(884);
    expect(remaining.display).toContain("an invoice for $0.53.");
  });

  it("omits an invoice offer when the fee-adjusted value is less than a cent", async () => {
    vi.mocked(getLastKnownBtcRate).mockReturnValue({ rate: 100, cachedAt: Date.now() });
    const remaining = (await terminalSettlementReport(job.id)).wallet_remaining!;
    expect(remaining).not.toHaveProperty("invoice_amount_sats");
    expect(remaining.display).not.toContain("invoice");
  });

  it("uses sats when the saved exchange rate is older than 24 hours", async () => {
    vi.mocked(getLastKnownBtcRate).mockReturnValue({ rate: 50_000, cachedAt: Date.now() - 24 * 60 * 60 * 1000 - 1 });
    const remaining = (await terminalSettlementReport(job.id)).wallet_remaining!;
    expect(remaining).not.toHaveProperty("usd");
    expect(remaining.display).toContain("900 sats of what you paid");
    expect(remaining.display).toContain("an invoice for 889 sats.");
    expect(remaining.display).not.toContain("$");
  });

  it("omits a cashu pocket refilled from a connected NWC float", async () => {
    vi.mocked(loadConfig).mockReturnValue({ nwcUri: `nostr+walletconnect://${"aa".repeat(32)}?relay=wss://relay.invalid&secret=${"bb".repeat(32)}` });
    expect(await terminalSettlementReport(job.id)).not.toHaveProperty("wallet_remaining");
  });

  it("reports a generated x402 wallet even when an NWC float is connected", async () => {
    storeJob({ ...job, paymentMethod: "x402" });
    vi.mocked(loadConfig).mockReturnValue({
      nwcUri: `nostr+walletconnect://${"aa".repeat(32)}?relay=wss://relay.invalid&secret=${"bb".repeat(32)}`,
      x402: { privateKey: "key", generated: true },
    } as ReturnType<typeof loadConfig>);
    vi.mocked(getX402Balance).mockResolvedValue({ usdc: 0.45 } as Awaited<ReturnType<typeof getX402Balance>>);
    expect((await terminalSettlementReport(job.id)).wallet_remaining).toEqual({
      rail: "x402", amount_usdc: 0.45, usd: "$0.45", can_send_back: false,
      display: "$0.45 of what you paid is left over from this job. I'll keep it for your next job.",
    });
  });

  it("does not let a malformed float prevent a per-call wallet report", async () => {
    vi.mocked(loadConfig).mockReturnValue({ nwcUri: "invalid" });
    expect((await terminalSettlementReport(job.id)).wallet_remaining?.rail).toBe("cashu");
  });

  it.each(["cashu", "x402"] as const)("reports per-call %s with the SDK's implicit credit receipt and upfront record", async (rail) => {
    const credit = { credit_id: `imp:${rail}:payment-1`, draw_id: "payment-1", amount: 550_000, balance_after: 0, ledger_seq: 1 };
    const receipt = attestedDvm("wordcount").sign({ job_id: job.id, credit,
      paid: { msats: 550_000, rail, native_amount: null, native_asset: null, tx_hash: null, mint: null } });
    if (rail === "x402") {
      vi.mocked(loadConfig).mockReturnValue({ x402: { privateKey: "key", generated: true } } as ReturnType<typeof loadConfig>);
      vi.mocked(getX402Balance).mockResolvedValue({ usdc: 0.45 } as Awaited<ReturnType<typeof getX402Balance>>);
    }
    storeJob({ ...job, paymentMethod: rail, upfrontPayment: { amount_msats: 550_000, rail, credit_id: credit.credit_id, draw_id: credit.draw_id } });
    const captured = { status: "verified", display: "Verified receipt", receipt } as const;
    expect((await terminalSettlementReport(job.id, { receipt })).wallet_remaining?.rail).toBe(rail);
    expect((await receiptJsonFields(captured, job.id)).wallet_remaining).toMatchObject({ rail });
  });

  it("does not attribute a caller-supplied token to the agent wallet", async () => {
    storeJob({ ...job, paymentMethod: undefined, upfrontRailPayment: "free" });
    vi.mocked(loadMessages).mockReturnValue([{ type: "payment", from: "requester", seq: 2, timestamp: 1,
      content: { cashu_token: "external-token" } }]);
    const receipt = attestedDvm("wordcount").sign({ job_id: job.id });
    expect(await terminalSettlementReport(job.id, { receipt })).not.toHaveProperty("wallet_remaining");
  });

  it.each([100, 99])("keeps %i sats without a send-back hint", async (sats) => {
    balance(sats);
    const remaining = (await terminalSettlementReport(job.id)).wallet_remaining;
    expect(remaining).toMatchObject({ amount_sats: sats, can_send_back: false,
      display: "$0.05 of what you paid is left over from this job. I'll keep it for your next job." });
    expect(remaining).not.toHaveProperty("hint");
    expect(remaining).not.toHaveProperty("invoice_amount_sats");
  });

  it("omits zero balances, active jobs and caller-held credit payments", async () => {
    balance(0);
    expect(await terminalSettlementReport(job.id)).not.toHaveProperty("wallet_remaining");
    balance(900);
    for (const patch of [ { status: "processing" }, { paymentMethod: "credit" } ] as Partial<JobRecord>[]) {
      storeJob({ ...job, ...patch });
      expect(await terminalSettlementReport(job.id)).not.toHaveProperty("wallet_remaining");
    }
    storeJob(job);
    expect(await terminalSettlementReport(job.id, { persistLocalState: false, status: "completed" }))
      .not.toHaveProperty("wallet_remaining");
  });

  it("uses receipt payment evidence for older jobs but excludes prepaid draws", async () => {
    storeJob({ ...job, paymentMethod: undefined });
    const receipt = attestedDvm("wordcount").sign({ job_id: job.id });
    expect((await terminalSettlementReport(job.id, { receipt })).wallet_remaining?.rail).toBe("cashu");
    storeJob({ ...job, paymentMethod: "credit" });
    expect(await terminalSettlementReport(job.id, { receipt })).not.toHaveProperty("wallet_remaining");
  });

  it("uses recorded conversation payments for a job that started free", async () => {
    storeJob({ ...job, paymentMethod: undefined, upfrontRailPayment: "free" });
    vi.mocked(loadMessages).mockReturnValue([{ type: "payment", from: "requester", seq: 2, timestamp: 1,
      content: { amount_msats: 550_000, cashu_token: "token", cashu_request_id: "payment-1" } }]);
    expect((await terminalSettlementReport(job.id)).wallet_remaining?.rail).toBe("cashu");
  });

  it("omits failed or timed-out stablecoin reads without losing settlement", async () => {
    storeJob({ ...job, paymentMethod: "x402" });
    vi.mocked(loadConfig).mockReturnValue({ x402: { privateKey: "key", generated: true } } as ReturnType<typeof loadConfig>);
    vi.mocked(getX402Balance).mockRejectedValueOnce(new Error("RPC offline"));
    const failed = await terminalSettlementReport(job.id);
    expect(failed).toHaveProperty("settlement");
    expect(failed).not.toHaveProperty("wallet_remaining");
    vi.useFakeTimers();
    try {
      vi.mocked(getX402Balance).mockImplementationOnce(() => new Promise(() => {}));
      const pending = terminalSettlementReport(job.id);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await pending).not.toHaveProperty("wallet_remaining");
    } finally { vi.useRealTimers(); }
  });

  it("reuses one stablecoin read for human receipt and error JSON output", async () => {
    storeJob({ ...job, paymentMethod: "x402", status: "failed" });
    vi.mocked(loadConfig).mockReturnValue({ x402: { privateKey: "key", generated: true } } as ReturnType<typeof loadConfig>);
    vi.mocked(getX402Balance).mockResolvedValue({ usdc: 0.45 } as Awaited<ReturnType<typeof getX402Balance>>);
    const captured = { status: "absent", display: "No receipt" } as const;
    const report = await terminalSettlementReport(job.id);
    await renderReceiptHuman(captured, job.id, report);
    expect((await receiptJsonFields(captured, job.id, report)).wallet_remaining).toMatchObject({ rail: "x402" });
    expect(getX402Balance).toHaveBeenCalledTimes(1);
  });

  it("keeps the generated Tempo wallet balance without offering cash-out", async () => {
    storeJob({ ...job, paymentMethod: "tempo" });
    vi.mocked(loadConfig).mockReturnValue({ tempo: { method: "tempo", apiKey: "key", generated: true } } as ReturnType<typeof loadConfig>);
    vi.mocked(getTempoUsdcBalance).mockResolvedValue({ usdc: 0.25 } as Awaited<ReturnType<typeof getTempoUsdcBalance>>);
    expect((await terminalSettlementReport(job.id)).wallet_remaining).toEqual({ rail: "tempo", amount_usdc: 0.25,
      usd: "$0.25", can_send_back: false,
      display: "$0.25 of what you paid is left over from this job. I'll keep it for your next job." });
  });

  it("does not quote an invoice when the proofs' mint fees are unknown", async () => {
    const wallet = loadAgentWallet()!;
    vi.mocked(loadAgentWallet).mockReturnValue({ ...wallet, proofs: wallet.proofs.map((proof) => ({ ...proof, id: "unknown" })) });
    const remaining = (await terminalSettlementReport(job.id)).wallet_remaining!;
    expect(remaining).toMatchObject({ amount_sats: 900, can_send_back: true });
    expect(remaining).not.toHaveProperty("invoice_amount_sats");
    expect(remaining.display).toBe("$0.45 of what you paid is left over from this job. I can keep it for your next job, or send it back to you; for that I need your Lightning address.");
  });

  it("keeps generated stablecoin balances and omits imported or unclassified keys", async () => {
    storeJob({ ...job, paymentMethod: "x402" });
    vi.mocked(getX402Balance).mockResolvedValue({ usdc: 0.45 } as Awaited<ReturnType<typeof getX402Balance>>);
    vi.mocked(loadConfig).mockReturnValue({ x402: { privateKey: "key", generated: true } } as ReturnType<typeof loadConfig>);
    expect((await terminalSettlementReport(job.id)).wallet_remaining).toEqual({ rail: "x402", amount_usdc: 0.45,
      usd: "$0.45", can_send_back: false,
      display: "$0.45 of what you paid is left over from this job. I'll keep it for your next job." });
    vi.mocked(loadConfig).mockReturnValue({ x402: { privateKey: "key" } } as ReturnType<typeof loadConfig>);
    expect(await terminalSettlementReport(job.id)).not.toHaveProperty("wallet_remaining");
  });
});
