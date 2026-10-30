import type { StoredCredit, StoredReceipt } from "@dvmkit/sdk/internal";
import { afterEach, describe, expect, it, vi } from "vitest";

import { planProbeDraw } from "../src/lib/credit-policy";
import { HttpsTransport } from "../src/lib/transport/https";
import { attestedDvm, CALLER_A } from "../src/lib/__tests__/fixtures/receipt-fixture";

const endpoint = "https://provider.example";
const dvm = attestedDvm();
const stored: StoredCredit = {
  endpoint, callerPubkey: CALLER_A, creditId: "held-credit", currency: "usd",
  balanceMicro: 4_170_000, remainingMicro: 4_170_000, targetMicro: 5_000_000,
  ledgerSeq: 1, status: "active", expiryMs: Date.now() + 86_400_000,
  openedAt: 0, updatedAt: 0, lastPriceMicro: 830_000,
};
const history: StoredReceipt[] = [{
  receipt: dvm.sign({ requester_pubkey: CALLER_A, capability: "count",
    credit: { credit_id: "held-credit", draw_id: "previous-draw", amount: 830_000,
      balance_after: 4_170_000, ledger_seq: 1 } }),
  endpoint, builder: dvm.anchor, verification: "verified", verified_at: 0,
}];
const policy = { stored, capability: "count", receipts: history, btcRate: 100_000,
  drawCeilingMsats: 60_000, drawCeilingSource: "budget" as const };

afterEach(() => vi.unstubAllGlobals());

async function quoteFromWire(body: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })));
  const [quote] = await new HttpsTransport().quote({ endpoint }, {
    capability: "count", input: "Run",
  }, { btcRate: 100_000 });
  return quote;
}

describe("transport quote prices in the credit draw gate", () => {
  it.each([
    ["legacy sats", { price_msats: 830_000 }],
    ["legacy zero sats", { price_msats: 0 }],
    ["legacy fixed shape", { price_msats: 830_000, shape: "fixed" }],
    ["missing price", {}],
  ])("uses capability history for a %s quote", async (_label, body) => {
    const quote = await quoteFromWire(body);
    expect(planProbeDraw({ ...policy, quote })).toMatchObject({
      mode: "none", drawSkipped: { reason: "price_above_ceiling",
        lastPriceMicro: 830_000, ceilingMicro: 60_000 },
    });
    expect(JSON.parse(JSON.stringify(quote.upfront))).toEqual({ amount: 0, currency: "usd" });
    expect(planProbeDraw({ ...policy, quote, receipts: [] }).mode).toBe("draw");
  });

  it.each([undefined, "fixed"])("honors an explicit free upfront with shape %s", async (shape) => {
    const quote = await quoteFromWire({ upfront: { amount: 0, currency: "usd" }, shape });
    expect(planProbeDraw({ ...policy, quote }).mode).toBe("draw");
    expect(JSON.parse(JSON.stringify(quote.upfront))).toEqual({ amount: 0, currency: "usd" });
  });
});
