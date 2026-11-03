import { describe, expect, it, vi } from "vitest";

// A DVM this caller has no completed jobs with: trust tier 0, cap about $0.50.
const fund = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("funding reached the payment boundary");
  })
);
vi.mock("@dvmkit/sdk/internal", async (original) => ({
  ...(await original<typeof import("@dvmkit/sdk/internal")>()),
  loadCredit: vi.fn(() => ({
    creditId: "closed-credit",
    status: "closed",
    rail: "cashu",
    remainingMicro: 0,
    menu: {
      min_micro: 100000,
      max_micro: 50000000,
      ttl_ms: 7776000000,
      currency: "usd",
      funding: ["cashu", "stripe"],
    },
  })),
  loadPendingFunding: vi.fn(() => undefined),
  listResumableTempoChargeFundings: vi.fn(() => []),
  listResumableX402ExactFundings: vi.fn(() => []),
  listResumableX402Fundings: vi.fn(() => []),
  loadReceipts: vi.fn(() => []),
}));
vi.mock("../identity", async (original) => ({
  ...(await original<typeof import("../identity")>()),
  loadConfig: () => ({}),
}));
vi.mock("../cli-identity-resolve", () => ({
  resolveSigningIdentity: () => ({ pubkey: "a".repeat(64), privkey: "1".repeat(64) }),
}));
vi.mock("../credit-fund", async (original) => ({
  ...(await original<typeof import("../credit-fund")>()),
  fundCredit: fund,
}));
vi.mock("../credit-per-dvm", async (original) => ({
  ...(await original<typeof import("../credit-per-dvm")>()),
  reconcilePerDvmIdentity: vi.fn(),
}));
vi.mock("../credit/shared", async (original) => ({
  ...(await original<typeof import("../credit/shared")>()),
  resolveCreditEndpoint: () => "https://provider.example",
  describeCreditProvider: () => Promise.resolve({}),
}));

import { runCreditFund } from "../credit/funding";

describe("first-contact trust cap by rail", () => {
  it("lets a card top-up above the cap reach the Link approval step without --over-trust", async () => {
    await expect(
      runCreditFund("https://provider.example", { amount: "$5", rail: "stripe" })
    ).rejects.toThrow("funding reached the payment boundary");
    expect(fund).toHaveBeenCalledTimes(1);
  });

  it("still refuses the same amount on another rail without --over-trust", async () => {
    fund.mockClear();
    await expect(
      runCreditFund("https://provider.example", { amount: "$5", rail: "cashu" })
    ).rejects.toMatchObject({ code: "amount_exceeds_trust_tier" });
    expect(fund).not.toHaveBeenCalled();
  });
});
