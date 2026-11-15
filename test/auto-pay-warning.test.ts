import { describe, expect, it } from "vitest";
import type { Quote } from "@dvmkit/sdk/internal";
import { autoPayWarnings } from "../src/lib/auto-pay-warning";

const metered = (amount = 0.09, units: number | undefined = 10): Quote => ({
  upfront: { amount: 0, currency: "usd" }, description: "Metered", priceMsats: 0,
  shape: "rate", rate: { per_unit: { amount, currency: "usd" }, unit: "block", max_units: units },
});

describe("auto-pay quote warnings", () => {
  it("excludes only the credit-covered upfront amount", () => {
    const quote = { ...metered(0.05, 1), upfront: { amount: 0.55, currency: "usd" }, priceMsats: 550_000 };
    const limits = { budget: "$0.60" };
    const covered = { upfrontCoveredByCredit: true };
    expect(autoPayWarnings([quote], limits, undefined, 100_000, covered)).toEqual([]);
    expect(autoPayWarnings([quote], limits, undefined, 100_000)[0])
      .toMatchObject({ maximum: "$0.55 USD (550000 msats)", auto_pay_below: "550000" });
    expect(autoPayWarnings([{ ...quote, rate: metered(0.15, 1).rate }], limits, undefined, 100_000, covered)[0])
      .toMatchObject({ maximum: "$0.15 USD (150000 msats)", auto_pay_below: "150000" });
  });

  it("does not replace an excluded upfront charge with the advertised ceiling", () => {
    const quote = { ...metered(), rate: undefined, upfront: { amount: 0.55, currency: "usd" }, priceMsats: 550_000 };
    expect(autoPayWarnings([quote], { budget: "$0.60" }, { amount: 0.55, currency: "usd" },
      100_000, { upfrontCoveredByCredit: true })).toEqual([]);
  });

  it("computes the rate cap against the unchanged 20% default", () => {
    expect(autoPayWarnings([metered()], { budget: "$1.50" }, undefined, 100_000)).toMatchObject([
      { bound: "300000 msats", maximum: "$0.9 USD (900000 msats)", auto_pay_below: "900000", source: "quote" },
    ]);
  });

  it.each([0.02, 0.03])("omits a maximum at or below the bound (%s per unit)", (amount) => {
    expect(autoPayWarnings([metered(amount)], { budget: "$1.50" }, undefined, 100_000)).toEqual([]);
  });

  it("uses an explicit threshold rather than deriving another bound", () => {
    expect(autoPayWarnings([metered()], { budget: "$1.50", autoPayBelow: "$0.90" }, undefined, 100_000)).toEqual([]);
  });

  it("falls back to an advertised ceiling only without usable quote amounts", () => {
    const ceiling = { amount: 1.25, currency: "usd" };
    const warnings = autoPayWarnings([metered(0.09, 0)], { budget: "$1.50" }, ceiling, 100_000);
    expect(warnings[0]).toMatchObject({ source: "provider_ceiling", auto_pay_below: "1250000" });
    expect(warnings[0].display).toContain("this provider's advertised job ceiling");
    expect(autoPayWarnings([metered()], { budget: "$1.50" }, ceiling, 100_000)[0].auto_pay_below).toBe("900000");
    expect(autoPayWarnings([{ ...metered(), rate: undefined, upfront: { amount: 0.1, currency: "usd" } }],
      { budget: "$1.50" }, ceiling, 100_000)).toEqual([]);
  });

  it("keeps an exact sub-cent recommendation and avoids floating point overstatement", () => {
    expect(autoPayWarnings([metered(0.00015, 3)], { budget: "$0.001" }, undefined, 100_000)[0])
      .toMatchObject({ maximum: "$0.00045 USD (450 msats)", auto_pay_below: "450" });
    expect(autoPayWarnings([metered(0.1, 3)], { budget: "$1" }, undefined, 100_000)[0].auto_pay_below).toBe("300000");
  });

  it.each([NaN, Infinity, -1, 0])("ignores invalid or absent caps (%s)", (units) => {
    expect(autoPayWarnings([metered(0.09, units)], { budget: "$1.50" }, undefined, 100_000)).toEqual([]);
  });

  it("does not treat an unconvertible currency as USD", () => {
    const quote = metered();
    quote.rate!.per_unit.currency = "eur";
    expect(autoPayWarnings([quote], { budget: "$1.50" }, undefined, 100_000)).toEqual([]);
  });
});
