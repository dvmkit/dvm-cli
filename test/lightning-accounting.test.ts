vi.mock("../src/lib/budget-ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/budget-ledger")>()),
  loadLedger: output.loadLedger,
}));
import { beforeEach, describe, expect, it, vi } from "vitest";

const output = vi.hoisted(() => ({
  info: vi.fn(),
  json: vi.fn(),
  loadLedger: vi.fn(),
  loadReceipts: vi.fn(),
  listCredits: vi.fn(() => []),
  readCompletedCreditHistory: vi.fn(() => ({ records: [] })),
}));

vi.mock("@dvmkit/sdk/internal", async () => {
  const actual = await vi.importActual<typeof import("@dvmkit/sdk/internal")>(
    "@dvmkit/sdk/internal"
  );
  return { ...actual,
loadLedger: output.loadLedger,
loadReceipts: output.loadReceipts,
listCredits: output.listCredits,
readCompletedCreditHistory: output.readCompletedCreditHistory };
});
vi.mock("../src/lib/output", async () => ({ ...(await vi.importActual<typeof import("../src/lib/output")>("../src/lib/output")), info: output.info,
json: output.json }));

import type { CreditFundOutcome } from "../src/lib/credit-fund";

import { walletHistory } from "../src/commands/wallet-history";
import {
  buildCreditFundingIncomplete,
  buildCreditFundingReport,
} from "../src/lib/credit-notice";

const timestamp = Date.parse("2026-09-10T04:00:00.000Z");

describe("complete Lightning accounting", () => {
  beforeEach(() => {
    output.info.mockReset();
    output.json.mockReset();
    output.loadLedger.mockReset();
    output.loadReceipts.mockReset();
    output.loadReceipts.mockReturnValue([]);
  });

  it("renders and relays a Coinos-shaped hidden wallet fee", () => {
    const payload = renderHistory([
      lightningEntry({
        msats: 1_228_000,
        principalMsats: 1_223_000,
        routingFeeMsats: 4_000,
        totalWalletFeeMsats: 5_000,
        unitemizedWalletFeeMsats: 1_000,
        walletDebitMsats: 1_228_000,
      }),
    ]);

    expect(payload.entries).toEqual([
      expect.objectContaining({
        principal_sats: 1223,
        routing_fee_sats: 4,
        total_wallet_fee_sats: 5,
        unitemized_wallet_fee_sats: 1,
        wallet_debit_sats: 1228,
      }),
    ]);
    expect(payload.routing_fee_unknown_count).toBe(0);
    expect(payload.wallet_debit_unknown_count).toBe(0);

    const human = renderHistoryHuman([
      lightningEntry({
        msats: 1_228_000,
        principalMsats: 1_223_000,
        routingFeeMsats: 4_000,
        totalWalletFeeMsats: 5_000,
        unitemizedWalletFeeMsats: 1_000,
        walletDebitMsats: 1_228_000,
      }),
    ]);
    expect(human).toContain("total wallet debit 1228 sats");
    expect(human).toContain("total wallet fee 5 sats");
    expect(human).toContain(
      "4 sats wallet-reported routing fee + 1 sat unitemized wallet fee"
    );
  });

  it("keeps a known routing component separate from an unknown total debit", () => {
    const entry = lightningEntry({
      msats: 1_223_000,
      principalMsats: 1_223_000,
      routingFeeMsats: 4_000,
      totalWalletFeeMsats: null,
      unitemizedWalletFeeMsats: null,
      walletDebitMsats: null,
    });
    const payload = renderHistory([entry]);

    expect(payload.entries).toEqual([
      expect.objectContaining({
        principal_sats: 1223,
        routing_fee_sats: 4,
        total_wallet_fee_sats: null,
        unitemized_wallet_fee_sats: null,
        wallet_debit_sats: null,
      }),
    ]);
    expect(payload.routing_fee_unknown_count).toBe(0);
    expect(payload.wallet_debit_unknown_count).toBe(1);
    expect(payload.display).toContain("exact wallet debit is unknown");

    const human = renderHistoryHuman([entry]);
    expect(human).toContain("total wallet debit unknown");
    expect(human).toContain("wallet-reported routing fee 4 sats");
    expect(human).not.toContain("routing fee and total debit unknown");
  });

  it("keeps a proven total when the wallet omits its routing fee", () => {
    const entry = lightningEntry({
      msats: 1_228_000,
      principalMsats: 1_223_000,
      routingFeeMsats: null,
      totalWalletFeeMsats: 5_000,
      unitemizedWalletFeeMsats: null,
      walletDebitMsats: 1_228_000,
    });
    const payload = renderHistory([entry]);

    expect(payload.entries).toEqual([
      expect.objectContaining({
        routing_fee_sats: null,
        total_wallet_fee_sats: 5,
        unitemized_wallet_fee_sats: null,
        wallet_debit_sats: 1228,
      }),
    ]);
    expect(payload.routing_fee_unknown_count).toBe(1);
    expect(payload.wallet_debit_unknown_count).toBe(0);
    expect(renderHistoryHuman([entry])).toContain("routing and unitemized fee split unknown");
  });

  it("continues to read ledger rows written before the new fee fields", () => {
    const payload = renderHistory([
      lightningEntry({
        msats: 1_227_000,
        principalMsats: 1_223_000,
        routingFeeMsats: 4_000,
        walletDebitMsats: 1_227_000,
      }),
    ]);
    const [entry] = payload.entries as Array<Record<string, unknown>>;

    expect(entry).toEqual(
      expect.objectContaining({
        principal_sats: 1223,
        routing_fee_sats: 4,
        wallet_debit_sats: 1227,
      })
    );
    expect(entry).not.toHaveProperty("total_wallet_fee_sats");
    expect(entry).not.toHaveProperty("unitemized_wallet_fee_sats");
  });

  it("adds the complete breakdown to automatic credit reports", () => {
    const report = buildCreditFundingReport({
      dvm: "scribe",
      endpoint: "https://scribe.example",
      reason: "below_refill_target",
      amountMicro: 100_000,
      currency: "USD",
      route: "lightning",
      outcome: {
        spentSats: 1228,
        principalSats: 1223,
        routingFeeSats: 4,
        totalWalletFeeSats: 5,
        unitemizedWalletFeeSats: 1,
        walletDebitSats: 1228,
        paymentOutcome: "paid",
      },
    });

    expect(report).toEqual(
      expect.objectContaining({
        principal_sats: 1223,
        routing_fee_sats: 4,
        total_wallet_fee_sats: 5,
        unitemized_wallet_fee_sats: 1,
        wallet_debit_sats: 1228,
      })
    );
    expect(report.display).toContain("1 sat unitemized wallet fee");
  });

  it("preserves null totals on incomplete credit funding reports", () => {
    const outcome: CreditFundOutcome = {
      status: "settlement_pending",
      rail: "lightning",
      creditId: "credit-1",
      fundId: "fund-1",
      principalSats: 1223,
      routingFeeSats: 4,
      totalWalletFeeSats: null,
      unitemizedWalletFeeSats: null,
      walletDebitSats: null,
      paymentOutcome: "reconciled",
      display: "Payment sent; settlement is pending.",
    };

    const report = buildCreditFundingIncomplete({
      code: "credit_funding_settlement_pending",
      dvm: "scribe",
      endpoint: "https://scribe.example",
      reason: "below_refill_target",
      amountMicro: 100_000,
      currency: "USD",
      outcome,
    });

    expect(report).toEqual(
      expect.objectContaining({
        routing_fee_sats: 4,
        total_wallet_fee_sats: null,
        unitemized_wallet_fee_sats: null,
        wallet_debit_sats: null,
      })
    );
  });
});

function renderHistory(entries: Array<Record<string, unknown>>): Record<string, unknown> {
  output.loadLedger.mockReturnValue({ entries });
  walletHistory({}, new Date("2026-09-10T05:00:00.000Z"));
  return output.json.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

function renderHistoryHuman(entries: Array<Record<string, unknown>>): string {
  output.loadLedger.mockReturnValue({ entries });
  walletHistory({ human: true }, new Date("2026-09-10T05:00:00.000Z"));
  return output.info.mock.calls.map(([line]) => String(line)).join("\n");
}

function lightningEntry(accounting: Record<string, unknown>): Record<string, unknown> {
  return {
    timestamp,
    kind: "float_fund",
    jobId: "quote-1",
    providerEndpoint: "https://mint.example",
    btcRate: 100_000,
    usd: 0.001,
    label: "pocket refill · https://mint.example",
    ...accounting,
  };
}
