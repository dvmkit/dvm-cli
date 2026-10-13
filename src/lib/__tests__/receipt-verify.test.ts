import { describe, expect, it } from "vitest";

import { drainReceiptsDisplay, epochMsToIso, receiptDisplay, receiptIssuedAtIso } from "../receipt-verify";
import { attestedDvm } from "./fixtures/receipt-fixture";

describe("receiptDisplay", () => {
  it("leads with dollars an agent can relay to a non-Bitcoiner", () => {
    const dvm = attestedDvm("scrape");
    const line = receiptDisplay(dvm.sign({ capability: "fetch" }), "verified", 100_000);

    expect(line).toContain("Verified receipt");
    expect(line).toContain("$");
    expect(line).toContain("scrape/fetch");
    expect(line).toContain("completed");
  });

  it("degrades to sats rather than inventing a dollar figure without an fx rate", () => {
    const dvm = attestedDvm();
    const line = receiptDisplay(dvm.sign(), "verified", 0);
    expect(line).toContain("19 sats");
    expect(line).not.toContain("$");
  });

  it("says a free job cost nothing rather than rendering $0.00", () => {
    const dvm = attestedDvm();
    const receipt = dvm.sign({
      paid: {
        msats: 0,
        rail: null,
        native_amount: null,
        native_asset: null,
        tx_hash: null,
        mint: null,
      },
    });
    expect(receiptDisplay(receipt, "verified_unattested", 100_000)).toContain("free job");
  });

  it("names an unverified receipt as such", () => {
    const dvm = attestedDvm();
    expect(receiptDisplay(dvm.sign(), "invalid", 100_000)).toContain("UNVERIFIED");
  });

  it("survives a timestamp no calendar can hold", () => {
    const signed = attestedDvm().sign();
    for (const issued_at of [1e300, -1e300, Number.NaN, Number.POSITIVE_INFINITY]) {
      const receipt = { ...signed, issued_at };
      expect(receiptIssuedAtIso(receipt)).toBeNull();
      const line = receiptDisplay(receipt, "verified", 100_000);
      expect(line).toContain("wordcount/count");
      expect(line).toContain("completed.");
    }
  });

  it("renders a sane timestamp as a date", () => {
    const receipt = attestedDvm().sign({ issued_at: 1789300000 });
    expect(receiptIssuedAtIso(receipt)).toBe("2026-09-13T11:46:40.000Z");
    expect(receiptDisplay(receipt, "verified", 0)).toContain("completed 2026-09-13.");
  });
});

describe("epochMsToIso", () => {
  it("renders a representable instant", () => {
    expect(epochMsToIso(1789300000000)).toBe("2026-09-13T11:46:40.000Z");
    expect(epochMsToIso(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("answers null for anything a Date can't hold", () => {
    for (const bad of [1e300, -1e300, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(epochMsToIso(bad)).toBeNull();
    }
    for (const bad of [undefined, null, "2026-09-13", {}, []]) {
      expect(epochMsToIso(bad)).toBeNull();
    }
  });
});


describe("drainReceiptsDisplay", () => {
  it("renders each verdict for relay, quoting the tally", () => {
    expect(drainReceiptsDisplay("verified", 3, 3)).toContain("3 of 3");
    expect(drainReceiptsDisplay("verified_unattested", 2, 2)).toContain("unattested");
    expect(drainReceiptsDisplay("invalid", 2, 3)).toContain("still owed");
    expect(drainReceiptsDisplay("absent", 0, 0)).toContain("No reclaim receipts");
  });
});
