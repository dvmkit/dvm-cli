import { describe, expect, it, vi } from "vitest";

const fund = vi.hoisted(() => vi.fn(() => { throw new Error("funding reached the payment boundary"); }));
vi.mock("@dvmkit/sdk/internal", async (original) => ({
  ...(await original<typeof import("@dvmkit/sdk/internal")>()),
  loadCredit: vi.fn(() => ({
    creditId: "existing-tempo-credit", status: "active", rail: "tempo",
    remainingMicro: 0, menu: { min_micro: 100000, max_micro: 5000000, ttl_ms: 7776000000, currency: "usd", funding: ["cashu", "tempo"] },
  })),
  loadPendingFunding: vi.fn(() => undefined),
  listResumableTempoChargeFundings: vi.fn(() => []),
  listResumableX402ExactFundings: vi.fn(() => []),
  listResumableX402Fundings: vi.fn(() => []),
  loadReceipts: vi.fn(() => []),
}));
vi.mock("../identity", async (original) => ({ ...(await original<typeof import("../identity")>()), loadConfig: () => ({}) }));
vi.mock("../cli-identity-resolve", () => ({ resolveSigningIdentity: () => ({ pubkey: "a".repeat(64), privkey: "1".repeat(64) }) }));
vi.mock("../credit-fund", async (original) => ({ ...(await original<typeof import("../credit-fund")>()), fundCredit: fund }));
vi.mock("../credit-per-dvm", async (original) => ({ ...(await original<typeof import("../credit-per-dvm")>()), reconcilePerDvmIdentity: vi.fn() }));
vi.mock("../credit/shared", async (original) => ({
  ...(await original<typeof import("../credit/shared")>()),
  resolveCreditEndpoint: () => "https://provider.example",
  describeCreditProvider: () => Promise.resolve({}),
}));

import { runCreditFund } from "../credit/funding";

describe("credit funding rail preflight", () => {
  it("refuses a conflicting rail before preparing any payment", async () => {
    await expect(runCreditFund("https://provider.example", { amount: "$0.10", rail: "cashu", overTrust: true }))
      .rejects.toMatchObject({ code: "credit_rail_conflict" });
    expect(fund).not.toHaveBeenCalled();
  });
});
