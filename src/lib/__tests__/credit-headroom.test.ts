import { describe, expect, it } from "vitest";
import type { CreditMenu } from "@dvmkit/sdk/internal";

import { computeHeadroom, headroomJson } from "../credit-headroom";
import type { CreditRouteAvailability } from "../credit-headroom";

const ENDPOINT = "https://card.example.test";

function headroom(overrides: {
  menu?: Partial<CreditMenu>;
  amountMicro?: number;
  routeAvailability?: CreditRouteAvailability[];
  boundRail?: string;
} = {}) {
  return headroomJson(computeHeadroom({
    endpoint: ENDPOINT,
    receipts: [],
    signingPubkey: undefined,
    menu: {
      currency: "usd",
      min_micro: 100_000,
      max_micro: 5_000_000,
      ttl_ms: 86_400_000,
      funding: ["cashu", "stripe"],
      ...overrides.menu,
    },
    routeAmountMicro: overrides.amountMicro ?? 500_000,
    routeAvailability: overrides.routeAvailability ?? [
      { rail: "cashu", available: false },
      { rail: "stripe", available: false },
    ],
    ...(overrides.boundRail ? { boundRail: overrides.boundRail } : {}),
  }));
}

describe("card funding headroom", () => {
  it("reports the card floor separately from the menu floor and preserves Lightning's floor", () => {
    const result = headroom({ menu: {
      funding: ["cashu", "lightning", "stripe"],
      lightning_min_micro: 2_000_000,
    } });

    expect(result.menu_min_micro).toBe(100_000);
    expect(result.rail_minimums).toEqual([
      { rail: "lightning", min_micro: 2_000_000 },
      { rail: "stripe", min_micro: 500_000 },
    ]);
    expect(result.route_compatibility).toContainEqual({
      rail: "stripe", status: "unavailable_locally", min_micro: 500_000,
      available_locally: false,
    });
    expect(result.display).toContain("$0.50");
  });

  it.each([
    [499_999, "blocked_by_rail_minimum"],
    [500_000, "unavailable_locally"],
  ])("diagnoses a card top-up of %i micro-units as %s", (amountMicro, status) => {
    expect(headroom({ amountMicro }).route_compatibility).toContainEqual({
      rail: "stripe", status, min_micro: 500_000, available_locally: false,
    });
  });

  it("honors a menu floor above the card floor", () => {
    expect(headroom({ menu: { min_micro: 1_000_000 } }).route_compatibility).toContainEqual({
      rail: "stripe", status: "blocked_by_rail_minimum", min_micro: 1_000_000,
      available_locally: false,
    });
  });

  it("offers a human-approved card command when no automatic route is available", () => {
    const result = headroom();

    expect(result.effective_route).toBeNull();
    expect(result.human_funding_required).toBe(true);
    expect(result.display).toContain(`dvm credit fund ${ENDPOINT} --rail stripe --amount '$X'`);
    expect(result.display).toContain("Stripe Link");
  });

  it("offers a separate card credit when the held credit is bound to another rail", () => {
    const result = headroom({ boundRail: "cashu" });

    expect(result.bound_rail).toBe("cashu");
    expect(result.display).toContain(`dvm credit fund ${ENDPOINT} --rail stripe --credit-id <new id> --amount '$X'`);
  });

  it("does not offer card funding when the menu does not accept it", () => {
    const result = headroom({
      menu: { funding: ["cashu"] },
      routeAvailability: [{ rail: "cashu", available: false }],
    });

    expect(result.rail_minimums).toEqual([]);
    expect(result.display).not.toContain("--rail stripe");
  });

  it("keeps a locally available automatic route instead of offering a card top-up", () => {
    const result = headroom({ routeAvailability: [
      { rail: "cashu", available: true, source: "cashu_balance" },
      { rail: "stripe", available: false },
    ] });

    expect(result.effective_route).toBe("cashu");
    expect(result.human_funding_required).toBe(false);
    expect(result.display).not.toContain("--rail stripe");
  });
});
