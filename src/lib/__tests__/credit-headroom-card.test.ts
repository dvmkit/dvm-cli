import { describe, expect, it } from "vitest";

import { computeHeadroom } from "../credit-headroom";
import type { CreditMenu } from "@dvmkit/sdk/internal";

const menu: CreditMenu = {
  min_micro: 100_000,
  max_micro: 50_000_000,
  ttl_ms: 30 * 24 * 60 * 60 * 1000,
  currency: "usd",
  funding: ["cashu", "stripe"],
};

function statusOf(h: ReturnType<typeof computeHeadroom>, rail: string): string | undefined {
  return h.routeCompatibility.find((route) => route.rail === rail)?.status;
}

describe("headroom trust cap by rail", () => {
  const base = {
    endpoint: "https://provider.example",
    receipts: [],
    signingPubkey: "a".repeat(64),
    menu,
    routeAmountMicro: 5_000_000,
  };

  it("never reports the card route as blocked by the trust cap, while another rail is", () => {
    const h = computeHeadroom(base);
    expect(statusOf(h, "cashu")).toBe("blocked_by_trust_cap");
    expect(statusOf(h, "stripe")).not.toBe("blocked_by_trust_cap");
  });

  it("counts a held card balance against the cap for the other rails", () => {
    const empty = computeHeadroom({ ...base, routeAmountMicro: 100_000 });
    const held = computeHeadroom({ ...base, routeAmountMicro: 100_000, balanceMicro: 450_000 });
    expect(statusOf(empty, "cashu")).toBe("compatible");
    expect(statusOf(held, "cashu")).toBe("blocked_by_trust_cap");
    expect(statusOf(held, "stripe")).not.toBe("blocked_by_trust_cap");
  });
});
