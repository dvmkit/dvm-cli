import { describe, expect, it, vi } from "vitest";

// A DVM this caller has no completed jobs with: trust tier 0, cap about $0.50.
const fund = vi.hoisted(() =>
  vi.fn<typeof import("../credit-fund").fundCredit>(() => {
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
  loadConfig: vi.fn(() => ({})),
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
import { DvmError, loadCredit } from "@dvmkit/sdk/internal";
import { loadConfig } from "../identity";

function lightningMenu(minimum?: number): void {
  const stored = loadCredit("https://provider.example", "a".repeat(64));
  vi.mocked(loadCredit).mockReturnValueOnce({
    ...stored!,
    menu: {
      ...stored!.menu!,
      funding: ["cashu", "lightning", "stripe"],
      ...(minimum !== undefined ? { lightning_min_micro: minimum } : {}),
    },
  });
}

async function refusal(opts: Parameters<typeof runCreditFund>[1]): Promise<DvmError> {
  try {
    await runCreditFund("https://provider.example", opts);
  } catch (err) {
    expect(err).toBeInstanceOf(DvmError);
    return err as DvmError;
  }
  throw new Error("Expected funding to be refused");
}

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

  it("explains an unreachable Lightning minimum and offers the wallet invoice before over-trust", async () => {
    lightningMenu(850_000);
    const err = await refusal({ amount: "$1.234567", rail: "lightning" });
    const command = "dvm wallet fund '$1.234567' --no-float";

    expect(err.code).toBe("amount_exceeds_trust_tier");
    expect(err.data).toMatchObject({ wallet_fund_command: command, cap_micro: 500_000 });
    for (const prose of [err.hint ?? "", err.data?.display as string]) {
      expect(prose).toContain("Lightning top-ups here start at $0.85");
      expect(prose).toContain("$0.50");
      expect(prose).toContain("No money moved");
      expect(prose).toContain(command);
      expect(prose).toContain("--over-trust");
      expect(prose.indexOf(command)).toBeLessThan(prose.indexOf("--over-trust"));
    }
    expect(fund).not.toHaveBeenCalled();
  });

  it.each(["pin", "binding"])("uses the resolved Lightning %s when explaining the trust refusal", async (source) => {
    if (source === "pin") {
      vi.mocked(loadConfig).mockReturnValueOnce({ credit: { fundingRail: "lightning" } });
      lightningMenu(850_000);
    } else {
      const stored = loadCredit("https://provider.example", "a".repeat(64));
      vi.mocked(loadCredit).mockReturnValueOnce({
        ...stored!,
        status: "active",
        rail: "lightning",
        menu: { ...stored!.menu!, funding: ["lightning"], lightning_min_micro: 850_000 },
      });
    }
    const err = await refusal({ amount: "$1" });

    expect(err.code).toBe("amount_exceeds_trust_tier");
    expect(err.data?.wallet_fund_command).toBe("dvm wallet fund '$1.00' --no-float");
    expect(err.hint).toContain("Lightning top-ups here start at $0.85");
    expect(fund).not.toHaveBeenCalled();
  });

  it.each([
    ["lightning", undefined],
    ["lightning", 500_000],
    ["lightning", 250_000],
    ["cashu", 850_000],
    [undefined, 850_000],
  ])("preserves the ordinary trust refusal for rail %s and minimum %s", async (rail, minimum) => {
    lightningMenu(minimum);
    const err = await refusal({ amount: "$1", rail });

    expect(err.code).toBe("amount_exceeds_trust_tier");
    expect(err.data).not.toHaveProperty("wallet_fund_command");
    expect(err.hint).toBe("Nothing moved. Re-run with --over-trust to fund it anyway, or pre-grant every DVM signed by this builder with 'dvm credit trust https://provider.example <builder-max|$amount>'. Or fund $0.50 or less.");
    expect(err.data?.display).toBe("This agent has only earned $0.50 of credit at https://provider.example so far, and $1.00 was asked for. No money moved. Loading more than the earned amount is allowed, but it has to be asked for explicitly — re-run with --over-trust, or pre-grant every DVM signed by this builder with 'dvm credit trust https://provider.example <builder-max|$amount>'.");
    expect(fund).not.toHaveBeenCalled();
  });

  it("relays the invoice command in the missing-Lightning-wallet command error", async () => {
    const actual = await vi.importActual<typeof import("../credit-fund")>("../credit-fund");
    fund.mockImplementationOnce((args) => actual.fundCredit({ ...args, float: null }));
    lightningMenu(850_000);
    const err = await refusal({ amount: "$1.00", rail: "lightning", overTrust: true });

    expect(err.code).toBe("credit_funding_unavailable");
    expect(err.data?.wallet_fund_command).toBe("dvm wallet fund '$1.00' --no-float");
    expect(err.hint).toContain(err.data?.wallet_fund_command);
    expect(err.data?.display).toContain(err.data?.wallet_fund_command);
  });
});
