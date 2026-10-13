import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256hex, type LightningBackend, type LightningTransactionSnapshot } from "@dvmkit/sdk/internal";
import { payViaLightningBackend, type FloatPayment } from "../src/lib/float";

beforeEach(() => {
  vi.stubGlobal("fetch", () => { throw new Error("Network access is forbidden in payment accounting fixtures"); });
});
afterEach(() => vi.unstubAllGlobals());

const INVOICE = "lnbc-authoritative-wallet-debit-fixture";
const PREIMAGE = "ab".repeat(32);

describe("authoritative float payment accounting", () => {
  it("separates a Coinos-shaped hidden wallet fee from the reported routing fee", async () => {
    const payment = await payViaLightningBackend({
      bolt11: INVOICE,
      amountMsats: 1_223_000,
      backend: evidenceBackend({
        beforeBalance: 2_000_000,
        afterBalance: 772_000,
        transaction: outgoingTransaction({
          amountMsats: 1_223_000,
          feesPaidMsats: 4_000,
        }),
        responseFeeMsats: 4_000,
      }),
      now: () => 1_000_000,
    });

    expect(payment).toEqual({
      outcome: "paid",
      principalMsats: 1_223_000,
      routingFeeMsats: 4_000,
      totalWalletFeeMsats: 5_000,
      unitemizedWalletFeeMsats: 1_000,
      walletDebitMsats: 1_228_000,
    });
  });

  it.each(["paid", "reconciled", "republished"] satisfies FloatPayment["outcome"][])(
    "keeps exact ordinary-fee accounting for a %s outcome",
    async (outcome) => {
      const payment = await payViaLightningBackend({
        bolt11: INVOICE,
        amountMsats: 8_000,
        backend: evidenceBackend({
          beforeBalance: 20_000,
          afterBalance: 11_000,
          transaction: outgoingTransaction({ amountMsats: 8_000, feesPaidMsats: 1_000 }),
          responseFeeMsats: 1_000,
          outcome,
        }),
      });

      expect(payment).toMatchObject({
        outcome,
        routingFeeMsats: 1_000,
        totalWalletFeeMsats: 1_000,
        unitemizedWalletFeeMsats: 0,
        walletDebitMsats: 9_000,
      });
    }
  );

  it("keeps an exact total when the wallet omits the routing component", async () => {
    const payment = await payViaLightningBackend({
      bolt11: INVOICE,
      amountMsats: 8_000,
      backend: evidenceBackend({
        beforeBalance: 20_000,
        afterBalance: 11_000,
        transaction: outgoingTransaction({ amountMsats: 8_000 }),
      }),
    });

    expect(payment).toMatchObject({
      routingFeeMsats: null,
      totalWalletFeeMsats: 1_000,
      unitemizedWalletFeeMsats: null,
      walletDebitMsats: 9_000,
    });
  });

  it("preserves the payment and reported routing fee when history is unavailable", async () => {
    let payments = 0;
    const backend = paymentOnlyBackend(async () => {
      payments += 1;
      return { preimage: PREIMAGE, feesPaidMsats: 1_000, outcome: "paid" };
    });

    await expect(
      payViaLightningBackend({ bolt11: INVOICE, amountMsats: 8_000, backend })
    ).resolves.toEqual({
      outcome: "paid",
      principalMsats: 8_000,
      routingFeeMsats: 1_000,
      totalWalletFeeMsats: null,
      unitemizedWalletFeeMsats: null,
      walletDebitMsats: null,
    });
    expect(payments).toBe(1);
  });

  it("leaves the total unknown when another transaction is appended concurrently", async () => {
    const payment = await payViaLightningBackend({
      bolt11: INVOICE,
      amountMsats: 8_000,
      backend: evidenceBackend({
        beforeBalance: 20_000,
        afterBalance: 15_000,
        transaction: outgoingTransaction({ amountMsats: 8_000, feesPaidMsats: 1_000 }),
        responseFeeMsats: 1_000,
        extraAfter: [
          {
            fingerprint: "concurrent-incoming",
            invoiceHash: "unrelated",
            type: "incoming",
            amountMsats: 4_000,
            createdAt: 100,
            settledAt: 101,
          },
        ],
      }),
    });

    expect(payment).toMatchObject({
      routingFeeMsats: 1_000,
      totalWalletFeeMsats: null,
      unitemizedWalletFeeMsats: null,
      walletDebitMsats: null,
    });
  });

  it("leaves the total unknown when a repeated snapshot straddles activity", async () => {
    let stateRead = 0;
    let payments = 0;
    const target = outgoingTransaction({ amountMsats: 8_000, feesPaidMsats: 1_000 });
    const backend = paymentOnlyBackend(async () => {
      payments += 1;
      return { preimage: PREIMAGE, feesPaidMsats: 1_000, outcome: "paid" };
    });
    backend.getBalance = async () => (stateRead === 0 ? 20_000 : 19_000);
    backend.listTransactions = async () => {
      stateRead += 1;
      return stateRead === 1 ? [] : [target];
    };

    const payment = await payViaLightningBackend({
      bolt11: INVOICE,
      amountMsats: 8_000,
      backend,
    });

    expect(payment.walletDebitMsats).toBeNull();
    expect(payments).toBe(1);
  });
});

function outgoingTransaction(options: {
  amountMsats: number;
  feesPaidMsats?: number;
}): LightningTransactionSnapshot {
  return {
    fingerprint: `target-${String(options.amountMsats)}-${String(options.feesPaidMsats ?? "none")}`,
    invoiceHash: sha256hex(INVOICE),
    type: "outgoing",
    amountMsats: options.amountMsats,
    ...(options.feesPaidMsats !== undefined
      ? { feesPaidMsats: options.feesPaidMsats }
      : {}),
    createdAt: 100,
    settledAt: 101,
  };
}

function evidenceBackend(options: {
  beforeBalance: number;
  afterBalance: number;
  transaction: LightningTransactionSnapshot;
  responseFeeMsats?: number;
  outcome?: FloatPayment["outcome"];
  extraAfter?: LightningTransactionSnapshot[];
}): LightningBackend {
  const states = [
    { balance: options.beforeBalance, transactions: [] },
    { balance: options.beforeBalance, transactions: [] },
    {
      balance: options.afterBalance,
      transactions: [options.transaction, ...(options.extraAfter ?? [])],
    },
    {
      balance: options.afterBalance,
      transactions: [options.transaction, ...(options.extraAfter ?? [])],
    },
  ];
  let stateIndex = 0;
  const backend = paymentOnlyBackend(async () => ({
    preimage: PREIMAGE,
    ...(options.responseFeeMsats !== undefined
      ? { feesPaidMsats: options.responseFeeMsats }
      : {}),
    outcome: options.outcome ?? "paid",
  }));
  backend.getBalance = async () => states[stateIndex]?.balance ?? options.afterBalance;
  backend.listTransactions = async () => {
    const state = states[stateIndex];
    stateIndex += 1;
    return state?.transactions ?? [];
  };
  return backend;
}

function paymentOnlyBackend(
  payInvoice: LightningBackend["payInvoice"]
): LightningBackend {
  return {
    payInvoice,
    getBalance: async () => 0,
    getInfo: async () => ({ methods: [] }),
    createInvoice: async () => {
      throw new Error("not used");
    },
    lookupInvoice: async () => {
      throw new Error("not used");
    },
  };
}
