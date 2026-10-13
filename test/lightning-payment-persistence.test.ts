import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUDGET_FILE, CREDITS_FILE, loadPendingFunding, recordPendingFunding, type PendingFunding, type Transport } from "@dvmkit/sdk/internal";
import { loadLedger } from "../src/lib/budget-ledger";
import { fundCredit } from "../src/lib/credit-fund";
import { floatPaymentDisplay, floatPaymentJson, recordFloatSpend } from "../src/lib/float";

beforeEach(() => {
  vi.stubGlobal("fetch", () => { throw new Error("Network access is forbidden in payment accounting fixtures"); });
});
afterEach(() => vi.unstubAllGlobals());

const ENDPOINT = "https://dvm.test";
const CALLER_PUBKEY = "ab".repeat(32);
const CREDIT_ID = "11111111-1111-4111-8111-111111111111";
const FUND_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  writeFileSync(BUDGET_FILE, '{"caps":{},"entries":[]}\n');
  writeFileSync(
    CREDITS_FILE,
    '{"credits":[],"implicitCredits":[],"pendingFundings":[],"fundingMenuSnapshots":[]}\n'
  );
});

describe("persisted float payment accounting", () => {
  it("records and serializes the complete wallet fee breakdown", () => {
    recordFloatSpend({
      principalMsats: 1_223_000,
      routingFeeMsats: 4_000,
      totalWalletFeeMsats: 5_000,
      unitemizedWalletFeeMsats: 1_000,
      walletDebitMsats: 1_228_000,
      btcRate: 100_000,
      reference: "quote-1",
      counterparty: "https://mint.test",
    });

    expect(loadLedger().entries).toHaveLength(1);
    expect(loadLedger().entries[0]).toMatchObject({
      msats: 1_228_000,
      principalMsats: 1_223_000,
      routingFeeMsats: 4_000,
      totalWalletFeeMsats: 5_000,
      unitemizedWalletFeeMsats: 1_000,
      walletDebitMsats: 1_228_000,
    });
    expect(
      floatPaymentJson({
        outcome: "paid",
        principalMsats: 1_223_000,
        routingFeeMsats: 4_000,
        totalWalletFeeMsats: 5_000,
        unitemizedWalletFeeMsats: 1_000,
        walletDebitMsats: 1_228_000,
      })
    ).toEqual({
      outcome: "paid",
      principal_sats: 1_223,
      routing_fee_sats: 4,
      total_wallet_fee_sats: 5,
      unitemized_wallet_fee_sats: 1,
      wallet_debit_sats: 1_228,
    });
  });

  it("persists explicit unknown totals without synthesizing principal plus routing fee", () => {
    recordFloatSpend({
      principalMsats: 1_223_000,
      routingFeeMsats: 4_000,
      totalWalletFeeMsats: null,
      unitemizedWalletFeeMsats: null,
      walletDebitMsats: null,
      btcRate: 100_000,
      reference: "quote-ambiguous",
      counterparty: "https://mint.test",
    });

    expect(loadLedger().entries[0]).toMatchObject({
      msats: 1_223_000,
      principalMsats: 1_223_000,
      routingFeeMsats: 4_000,
      totalWalletFeeMsats: null,
      unitemizedWalletFeeMsats: null,
      walletDebitMsats: null,
    });
  });

  it("keeps proven totals when the routing and residual split is unknown", () => {
    recordFloatSpend({
      principalMsats: 1_223_000,
      routingFeeMsats: null,
      totalWalletFeeMsats: 5_000,
      unitemizedWalletFeeMsats: null,
      walletDebitMsats: 1_228_000,
      btcRate: 100_000,
      reference: "quote-unitemized",
      counterparty: "https://mint.test",
    });

    expect(loadLedger().entries[0]).toMatchObject({
      routingFeeMsats: null,
      totalWalletFeeMsats: 5_000,
      unitemizedWalletFeeMsats: null,
      walletDebitMsats: 1_228_000,
    });
    expect(
      floatPaymentDisplay({
        outcome: "paid",
        principalMsats: 1_223_000,
        routingFeeMsats: null,
        totalWalletFeeMsats: 5_000,
        unitemizedWalletFeeMsats: null,
        walletDebitMsats: 1_228_000,
      })
    ).toContain("total wallet fee 5 sats");
  });

  it("reads legacy ledger entries with the additive fields absent", () => {
    writeFileSync(
      BUDGET_FILE,
      JSON.stringify({
        caps: {},
        entries: [
          {
            timestamp: Date.now(),
            kind: "float_fund",
            jobId: "legacy",
            providerEndpoint: "https://mint.test",
            msats: 1_227_000,
            principalMsats: 1_223_000,
            routingFeeMsats: 4_000,
            walletDebitMsats: 1_227_000,
            btcRate: 100_000,
            usd: 0.001227,
          },
        ],
      }) + "\n"
    );

    const [legacy] = loadLedger().entries;
    expect(legacy).toMatchObject({
      principalMsats: 1_223_000,
      routingFeeMsats: 4_000,
      walletDebitMsats: 1_227_000,
    });
    expect(legacy.totalWalletFeeMsats).toBeUndefined();
    expect(legacy.unitemizedWalletFeeMsats).toBeUndefined();
  });
});

describe("pending Lightning credit accounting", () => {
  it("persists and returns the complete breakdown after recovery", async () => {
    const pending = lightningPending({
      routingFeeMsats: 4_000,
      totalWalletFeeMsats: 5_000,
      unitemizedWalletFeeMsats: 1_000,
      walletDebitMsats: 1_228_000,
    });
    recordPendingFunding(pending);

    expect(loadPendingFunding(ENDPOINT, CALLER_PUBKEY, CREDIT_ID)).toMatchObject({
      totalWalletFeeMsats: 5_000,
      unitemizedWalletFeeMsats: 1_000,
    });

    const outcome = await settleRecordedFunding();
    expect(outcome).toMatchObject({
      status: "funded",
      spentSats: 1_228,
      principalSats: 1_223,
      routingFeeSats: 4,
      totalWalletFeeSats: 5,
      unitemizedWalletFeeSats: 1,
      walletDebitSats: 1_228,
      paymentOutcome: "paid",
    });
    expect(outcome.display).toContain("1 sats unitemized wallet fee");
  });

  it("returns known totals and a null split when the wallet omitted routing fee", async () => {
    recordPendingFunding(
      lightningPending({
        routingFeeMsats: null,
        totalWalletFeeMsats: 5_000,
        unitemizedWalletFeeMsats: null,
        walletDebitMsats: 1_228_000,
      })
    );

    const outcome = await settleRecordedFunding();
    expect(outcome).toMatchObject({
      principalSats: 1_223,
      routingFeeSats: null,
      totalWalletFeeSats: 5,
      unitemizedWalletFeeSats: null,
      walletDebitSats: 1_228,
    });
    expect(outcome.display).toContain("fee split is unknown");
  });

  it("maps legacy and ambiguous pending records to explicit null totals", async () => {
    const legacy = lightningPending({ routingFeeMsats: 4_000, walletDebitMsats: null });
    recordPendingFunding(legacy);

    const storedJson = JSON.parse(readFileSync(CREDITS_FILE, "utf8")) as {
      pendingFundings: Record<string, unknown>[];
    };
    expect(storedJson.pendingFundings[0]).not.toHaveProperty("totalWalletFeeMsats");
    expect(storedJson.pendingFundings[0]).not.toHaveProperty("unitemizedWalletFeeMsats");

    const outcome = await settleRecordedFunding();
    expect(outcome).toMatchObject({
      principalSats: 1_223,
      routingFeeSats: 4,
      totalWalletFeeSats: null,
      unitemizedWalletFeeSats: null,
      walletDebitSats: null,
    });
    expect(outcome.spentSats).toBeUndefined();
    expect(outcome.display).toContain("total wallet debit and total wallet fee are unknown");
  });
});

function lightningPending(
  accounting: Pick<PendingFunding, "routingFeeMsats" | "walletDebitMsats"> &
    Partial<Pick<PendingFunding, "totalWalletFeeMsats" | "unitemizedWalletFeeMsats">>
): PendingFunding {
  return {
    endpoint: ENDPOINT,
    callerPubkey: CALLER_PUBKEY,
    creditId: CREDIT_ID,
    fundId: FUND_ID,
    amountMicro: 1_000_000,
    rail: "lightning",
    targetMicro: 1_000_000,
    requestedAt: Date.now(),
    bolt11: "lnbc-persisted-accounting-fixture",
    paymentHash: "cd".repeat(32),
    amountMsats: 1_223_000,
    principalMsats: 1_223_000,
    paymentOutcome: "paid",
    ...accounting,
  };
}

async function settleRecordedFunding() {
  const transport = {
    credit: async () => ({ op: "fund" as const, funded_micro: 1_000_000 }),
  } as unknown as Transport;
  return fundCredit({
    transport,
    ref: { endpoint: ENDPOINT },
    signing: { privkey: "11".repeat(32), pubkey: CALLER_PUBKEY },
    creditId: CREDIT_ID,
    amountMicro: 1_000_000,
    signBody: (_privkey, body) => body,
  });
}
