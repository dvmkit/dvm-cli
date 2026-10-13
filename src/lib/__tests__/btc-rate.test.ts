vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
fetchBtcUsdRate: vi.fn(),
getLastKnownBtcRate: vi.fn() }));
vi.mock("../output", async () => ({ ...(await vi.importActual<typeof import("../output")>("../output")), info: vi.fn() }));
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { fetchBtcUsdRate, getLastKnownBtcRate } from "@dvmkit/sdk/internal";

import type { BtcRatePurpose, ResolvedBtcRate, StaleRateNotice } from "../btc-rate";
import type { DvmError } from "@dvmkit/sdk/internal";
import { info } from "../output";

// Rate fetching and cache validation stay SDK-owned; these cases exercise
// the caller's fallback, refusal and relayable copy with independent rate inputs.
async function loadResolver(): Promise<{
  resolveBtcUsdRate: (purpose: BtcRatePurpose) => Promise<ResolvedBtcRate>;
  tryResolveBtcUsdRate: () => Promise<ResolvedBtcRate | null>;
  staleRateNotice: (resolved: ResolvedBtcRate | null) => StaleRateNotice | undefined;
  DvmErrorClass: typeof DvmError;
}> {
  vi.resetModules();
  const mod = await import("../btc-rate");
  const errors = await import("@dvmkit/sdk/internal");
  return {
    resolveBtcUsdRate: mod.resolveBtcUsdRate,
    tryResolveBtcUsdRate: mod.tryResolveBtcUsdRate,
    staleRateNotice: mod.staleRateNotice,
    DvmErrorClass: errors.DvmError,
  };
}

function diskCache(rate: number, cachedAt: number): void {
  vi.mocked(getLastKnownBtcRate).mockReturnValue({ rate, cachedAt });
}

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

describe("resolveBtcUsdRate", () => {
  beforeEach(() => {
    vi.mocked(fetchBtcUsdRate).mockRejectedValue(new Error("rate provider unavailable"));
    vi.mocked(getLastKnownBtcRate).mockReturnValue(null);
    vi.mocked(info).mockClear();
  });

  it("returns the live rate, not stale, when the provider answers", async () => {
    vi.mocked(fetchBtcUsdRate).mockResolvedValue(68_000);
    const { resolveBtcUsdRate } = await loadResolver();

    await expect(resolveBtcUsdRate("payment")).resolves.toEqual({ rate: 68_000, stale: false });
    expect(info).not.toHaveBeenCalled();
  });

  it("degrades to the last-known cached rate when the provider 429s", async () => {
    const cachedAt = Date.now() - THREE_HOURS_MS;
    diskCache(70_000, cachedAt);
    const { resolveBtcUsdRate } = await loadResolver();

    await expect(resolveBtcUsdRate("payment")).resolves.toEqual({
      rate: 70_000,
      stale: true,
      cachedAt,
    });

    expect(info).toHaveBeenCalledWith(expect.stringContaining("3 hours ago"));
  });

  it("warns about a stale rate once per process, however many rails resolve one", async () => {
    diskCache(70_000, Date.now() - THREE_HOURS_MS);
    const { resolveBtcUsdRate } = await loadResolver();

    await resolveBtcUsdRate("payment");
    await resolveBtcUsdRate("payment");

    expect(info).toHaveBeenCalledTimes(1);
  });

  it("throws a typed, relayable rate_unavailable when there is no rate at all", async () => {
    const { resolveBtcUsdRate, DvmErrorClass } = await loadResolver();

    try {
      await resolveBtcUsdRate("payment");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DvmErrorClass);
      const err = e as DvmError;

      expect(err.code).toBe("rate_unavailable");
      expect(err.hint).toContain("Nothing was paid");
      expect(err.data).toMatchObject({
        display: expect.stringContaining("nothing was paid") as string,
        anchor: "rate_unavailable",
        purpose: "payment",
        retryable: true,
      });
    }
  });

  it("never claims money was at stake when the caller was only converting", async () => {
    const { resolveBtcUsdRate } = await loadResolver();

    const err = (await resolveBtcUsdRate("conversion").catch((e: unknown) => e)) as DvmError;

    expect(err.code).toBe("rate_unavailable");
    expect(err.data?.display).toBe("BTC/USD rate unavailable — no conversion was performed.");
    expect(err.hint).not.toContain("paid");
  });

  it("blocks when the shared cache reader rejects a poisoned rate", async () => {
    vi.mocked(getLastKnownBtcRate).mockReturnValue(null);
    const { resolveBtcUsdRate, DvmErrorClass } = await loadResolver();

    await expect(resolveBtcUsdRate("payment")).rejects.toBeInstanceOf(DvmErrorClass);
  });
});

describe("tryResolveBtcUsdRate", () => {
  beforeEach(() => {
    vi.mocked(fetchBtcUsdRate).mockRejectedValue(new Error("rate provider unavailable"));
    vi.mocked(getLastKnownBtcRate).mockReturnValue(null);
  });

  it("returns null instead of throwing when no rate can be resolved", async () => {
    const { tryResolveBtcUsdRate } = await loadResolver();

    await expect(tryResolveBtcUsdRate()).resolves.toBeNull();
  });

  it("still serves a stale rate when one is cached", async () => {
    const cachedAt = Date.now() - THREE_HOURS_MS;
    diskCache(70_000, cachedAt);
    const { tryResolveBtcUsdRate } = await loadResolver();

    await expect(tryResolveBtcUsdRate()).resolves.toEqual({ rate: 70_000, stale: true, cachedAt });
  });
});

describe("staleRateNotice", () => {
  it("tags a stale rate with its age and a relayable sentence", async () => {
    const cachedAt = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const { staleRateNotice } = await loadResolver();

    expect(staleRateNotice({ rate: 70_000, stale: true, cachedAt })).toEqual({
      cached_at: new Date(cachedAt).toISOString(),
      age: "3 days ago",
      display: expect.stringContaining("cached 3 days ago") as string,
    });
  });

  it("is undefined for a live rate and for no rate at all", async () => {
    const { staleRateNotice } = await loadResolver();

    expect(staleRateNotice({ rate: 70_000, stale: false })).toBeUndefined();
    expect(staleRateNotice(null)).toBeUndefined();
  });
});
