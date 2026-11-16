import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveIdentityFromPrivkey, DvmError, listPendingFundings, recordPendingFunding } from "@dvmkit/sdk/internal";
import { creditBalance } from "../src/commands/credit";
import { resetCreditNotices } from "../src/lib/credit-notice";
import { handleError } from "../src/lib/error-handler";
import { fundViaFloat } from "../src/lib/float";
import { attestedDvm } from "../src/lib/__tests__/fixtures/receipt-fixture";

const seams = vi.hoisted(() => ({ json: vi.fn(), info: vi.fn(), describe: vi.fn(), credit: vi.fn(), close: vi.fn() }));
vi.mock("../src/lib/output", async (original) => ({
  ...await original<typeof import("../src/lib/output")>(), json: seams.json, info: seams.info,
}));
vi.mock("../src/lib/transport", () => ({ createDvmTransport: () => seams }));
vi.mock("../src/lib/float", async (original) => ({
  ...await original<typeof import("../src/lib/float")>(), fundViaFloat: vi.fn(),
}));

const root = process.env.DVM_CONFIG_DIR!;
const endpoint = "https://provider.example";
const signer = deriveIdentityFromPrivkey("01".repeat(32));
const dvm = attestedDvm();
const provider = { name: "Provider", capabilities: {}, auth: ["secp256k1-schnorr-v2"],
  builder: dvm.anchor,
  authAudience: { dvm_id: dvm.attestation.dvm_id, builder_pubkey: dvm.identity.pubkey } };

function saveFunding(paid = true, fundId = "fund-original", overrides = {}) {
  recordPendingFunding({
    endpoint, callerPubkey: signer.pubkey, creditId: "credit-original", fundId,
    rail: "lightning", amountMicro: 100_000, targetMicro: 100_000, requestedAt: Date.now() - 1_000,
    bolt11: "lnbcrt1000n1original", amountMsats: 100_000,
    expiresAtMs: Date.now() - 1,
    ...(paid ? {
      principalMsats: 100_000, routingFeeMsats: 2_000, totalWalletFeeMsats: 5_000,
      unitemizedWalletFeeMsats: 3_000, walletDebitMsats: 105_000, paymentOutcome: "paid" as const,
    } : {}),
    ...overrides,
  });
}

function refusal() {
  return new DvmError("credit_funding_unrecorded", "Payment could not be credited.", undefined, {
    retryable: false, display: "Nothing was charged.",
  });
}

function output() { return seams.json.mock.calls.at(-1)![0]; }

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  resetCreditNotices();
  vi.stubEnv("DVM_IDENTITY_KEY", signer.privkey);
  seams.describe.mockResolvedValue(provider);
  seams.credit.mockImplementation(async (_ref, body) => {
    if (body.op === "fund") throw refusal();
    return { credits: [] };
  });
});
afterEach(() => {
  resetCreditNotices();
  vi.unstubAllEnvs();
});

describe("paid Lightning refusals in credit balance", () => {
  it("reports every refused funding once, preserving IDs and fee accounting", async () => {
    saveFunding();
    saveFunding(true, "fund-second");

    await creditBalance(undefined, {});

    const reports = output().refused_fundings;
    expect(reports).toHaveLength(2);
    expect(reports.map((report: { fund_id: string }) => report.fund_id)).toEqual(["fund-original", "fund-second"]);
    expect(reports[0]).toMatchObject({
      endpoint, status: "refused", rail: "lightning", credit_id: "credit-original", fund_id: "fund-original",
      principal_sats: 100, routing_fee_sats: 2, total_wallet_fee_sats: 5,
      unitemized_wallet_fee_sats: 3, wallet_debit_sats: 105, spent_sats: 105, payment_outcome: "paid",
      error_code: "credit_funding_unrecorded",
      display: expect.stringContaining("The Lightning payment went out"),
      hint: expect.stringContaining("Don't fund again"),
    });
    expect(reports[0].display).not.toContain("Nothing was charged");
    expect(reports[0].hint).toContain("quote funding id fund-original");
    expect(listPendingFundings()).toEqual([]);
    expect(fundViaFloat).not.toHaveBeenCalled();
    expect(seams.credit.mock.calls.filter(([, body]) => body.op === "fund")).toHaveLength(2);

    await creditBalance(endpoint, {});
    expect(output()).not.toHaveProperty("refused_fundings");
    expect(seams.credit.mock.calls.filter(([, body]) => body.op === "fund")).toHaveLength(2);
  });

  it("relays the refusal and recovery hint in human output before retiring the entry", async () => {
    saveFunding();
    seams.info.mockImplementation((line: string) => {
      if (line.includes("The Lightning payment went out")) expect(listPendingFundings()).toHaveLength(1);
    });

    await creditBalance(endpoint, { human: true });

    const human = seams.info.mock.calls.flat().join("\n");
    expect(human).toContain("The Lightning payment went out");
    expect(human).toContain("105 sats went out");
    expect(human).toContain("Don't fund again");
    expect(human).toContain("quote funding id fund-original");
    expect(human).not.toContain("Nothing was charged");
    expect(listPendingFundings()).toEqual([]);
    expect(seams.json).not.toHaveBeenCalled();
  });

  it("preserves unknown wallet fees as null instead of claiming zero spend", async () => {
    saveFunding(true, "fund-original", {
      routingFeeMsats: null, totalWalletFeeMsats: null, unitemizedWalletFeeMsats: null, walletDebitMsats: null,
    });
    await creditBalance(endpoint, {});
    expect(output().refused_fundings[0]).toMatchObject({
      principal_sats: 100, routing_fee_sats: null, total_wallet_fee_sats: null,
      unitemized_wallet_fee_sats: null, wallet_debit_sats: null,
    });
    expect(output().refused_fundings[0]).not.toHaveProperty("spent_sats");
  });

  it("retires unpaid refusals silently and leaves ordinary balance JSON unchanged", async () => {
    await creditBalance(endpoint, {});
    const ordinary = output();
    saveFunding(false);
    await creditBalance(endpoint, {});
    expect(output()).toEqual(ordinary);
    expect(output()).not.toHaveProperty("refused_fundings");
    expect(listPendingFundings()).toEqual([]);
  });

  it.each(["timeout", "lightning_unavailable"])("keeps a paid entry pending after %s", async (code) => {
    saveFunding();
    seams.credit.mockRejectedValueOnce(new DvmError(code, "Temporarily unavailable."));
    await creditBalance(endpoint, {});
    expect(output()).not.toHaveProperty("refused_fundings");
    expect(listPendingFundings()).toHaveLength(1);
    expect(fundViaFloat).not.toHaveBeenCalled();
  });

  it.each([{ observeOnly: true }, { selectionOnly: true, creditId: "credit-original" }])(
    "does not reconcile or retire entries in observation or selection mode (%j)", async (options) => {
      saveFunding();
      await creditBalance(endpoint, options);
      expect(output()).not.toHaveProperty("refused_fundings");
      expect(listPendingFundings()).toHaveLength(1);
      expect(seams.credit.mock.calls.every(([, body]) => body.op === "balance")).toBe(true);
    }
  );

  it.each([false, true])("retains the notice when the subsequent balance read fails (all DVMs: %s)", async (all) => {
    saveFunding();
    seams.describe.mockResolvedValueOnce(provider).mockRejectedValueOnce(new Error("Offline"));
    if (all) {
      await creditBalance(undefined, {});
      expect(output().credits[0]).toMatchObject({ error: "provider_unavailable" });
    } else {
      const error = await creditBalance(endpoint, {}).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(DvmError);
      vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
      expect(() => handleError(error)).toThrow("exit");
      expect(output().error.code).toBe("provider_unavailable");
    }
    expect(output().refused_fundings[0]).toMatchObject({ fund_id: "fund-original", spent_sats: 105 });
    expect(listPendingFundings()).toEqual([]);
    expect(seams.close).toHaveBeenCalledTimes(1);
  });
});
