import { describe, expect, it } from "vitest";

import { CREDIT_FUND_RAILS } from "@dvmkit/sdk/internal";
import {
  fundingRailLabel,
  isPaymentRailKey,
  paymentRailLabel,
  probeRailLabel,
  railLabelAtSentenceStart,
} from "../src/lib/rail-labels";
const CALLER_RAIL_NOUN = { cashu: "ecash", lightning: "Lightning", x402: "x402 stablecoin", tempo: "Tempo stablecoin" };
const PROBE_LIGHTNING_NOUN = "Lightning float";

describe("rail-labels", () => {
  it("glosses every funding rail as its caller-facing noun", () => {
    for (const rail of CREDIT_FUND_RAILS) {
      expect(fundingRailLabel(rail)).toBe(CALLER_RAIL_NOUN[rail]);
    }
  });


  it("glosses every per-call payment rail as the same noun", () => {
    // `cashu_p2pk` is how a completed spend names itself — the caller holds
    // ecash either way, so it must not read as a second thing.
    expect(paymentRailLabel("cashu")).toBe(CALLER_RAIL_NOUN.cashu);
    expect(paymentRailLabel("cashu_p2pk")).toBe(CALLER_RAIL_NOUN.cashu);
    expect(paymentRailLabel("x402")).toBe(CALLER_RAIL_NOUN.x402);
    expect(paymentRailLabel("tempo")).toBe(CALLER_RAIL_NOUN.tempo);
  });

  it("keeps the probe register identical except for the Lightning float", () => {
    for (const rail of CREDIT_FUND_RAILS) {
      if (rail === "lightning") {
        expect(probeRailLabel(rail)).toBe(PROBE_LIGHTNING_NOUN);
        continue;
      }
      expect(probeRailLabel(rail)).toBe(CALLER_RAIL_NOUN[rail]);
    }
  });

  it("capitalizes a gloss that opens a sentence, bar the one styled lowercase", () => {
    const sentenceNouns = { cashu: "Ecash", lightning: "Lightning float", x402: "x402 stablecoin", tempo: "Tempo stablecoin" };
    for (const rail of CREDIT_FUND_RAILS) {
      expect(railLabelAtSentenceStart(probeRailLabel(rail))).toBe(sentenceNouns[rail]);
    }
  });

  it("recognises exactly the payment rail keys, so a wire key can't be printed raw", () => {
    for (const key of ["cashu", "cashu_p2pk", "x402", "tempo"]) {
      expect(isPaymentRailKey(key)).toBe(true);
    }
    // A provider advertising a rail this build doesn't carry: the guard is what
    // stops the raw key reaching prose in place of a gloss (the `default` arm
    // `quote.ts` used to have).
    expect(isPaymentRailKey("lightning")).toBe(false);
    expect(isPaymentRailKey("mpp")).toBe(false);
    expect(isPaymentRailKey(undefined)).toBe(false);
  });
});
