vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
CONFIG_DIR: "/mock/.dvm",
BUDGET_FILE: "/mock/.dvm/budget.json",
BTC_RATE_FILE: "/mock/.dvm/btc-rate.json",
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

vi.mock("fs");

// Keeps the resolver's stale-rate warning off this suite's stderr.

import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";

import {
  type BudgetLedger,
  checkBudget,
  enforceGlobalBudget,
  loadLedger,
  recordSpend,
  recordSpendOnce,
  saveLedger,
  setCaps,
  statusSnapshot,
} from "../budget-ledger";
import { fetchBtcUsdRate, getLastKnownBtcRate } from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";

beforeEach(() => {
  vi.clearAllMocks();
});

function setStoredLedger(ledger: BudgetLedger): void {
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify(ledger));
}

describe("loadLedger", () => {
  it("returns empty ledger when file missing", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(loadLedger()).toEqual({ caps: {}, entries: [] });
  });

  it("returns empty ledger when file corrupt", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("not-json");
    expect(loadLedger()).toEqual({ caps: {}, entries: [] });
  });

  it("loads existing ledger", () => {
    setStoredLedger({ caps: { dailyUsd: 5 }, entries: [] });
    expect(loadLedger().caps.dailyUsd).toBe(5);
  });
});

describe("setCaps", () => {
  it("replaces caps and writes ledger atomically (temp + rename)", () => {
    const entry = {
      timestamp: Date.now(),
      jobId: "retained",
      providerEndpoint: "https://p.example",
      msats: 1000,
      btcRate: 100_000,
      usd: 0.001,
    };
    setStoredLedger({ caps: { weeklyUsd: 10 }, entries: [entry] });
    setCaps({ dailyUsd: 5 });
    expect(writeFileSync).toHaveBeenCalledWith(
      "/mock/.dvm/budget.json.tmp",
      expect.stringContaining('"dailyUsd": 5')
    );
    expect(renameSync).toHaveBeenCalledWith("/mock/.dvm/budget.json.tmp", "/mock/.dvm/budget.json");
    const written = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
    expect(written).toEqual({ caps: { dailyUsd: 5 }, entries: [entry] });
  });
});

describe("recordSpend", () => {
  it("appends an entry with correct USD conversion", () => {
    setStoredLedger({ caps: {}, entries: [] });
    recordSpend({
      msats: 100_000,
      btcRate: 100_000, // $100k/BTC
      jobId: "j1",
      providerEndpoint: "https://p.example",
      label: "processing fee",
      labelSource: "provider",
      now: new Date("2026-04-17T12:00:00Z"),
    });
    const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    const parsed = JSON.parse(written) as BudgetLedger;
    expect(parsed.entries).toHaveLength(1);
    // 100_000 msats * 100_000 USD/BTC / 100_000_000_000 msats/BTC = $0.1
    expect(parsed.entries[0].usd).toBeCloseTo(0.1, 4);
    expect(parsed.entries[0].providerEndpoint).toBe("https://p.example");
    expect(parsed.entries[0].label).toBe("processing fee");
    expect(parsed.entries[0].labelSource).toBe("provider");
  });

  it("omits label fields when not provided (old entries stay clean)", () => {
    setStoredLedger({ caps: {}, entries: [] });
    recordSpend({
      msats: 100_000,
      btcRate: 100_000,
      jobId: "j1",
      providerEndpoint: "https://p.example",
      now: new Date("2026-04-17T12:00:00Z"),
    });
    const parsed = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string) as BudgetLedger;
    expect("label" in parsed.entries[0]).toBe(false);
    expect("labelSource" in parsed.entries[0]).toBe(false);
  });
});

describe("recordSpendOnce", () => {
  it("does not append the same logical operation twice", () => {
    setStoredLedger({
      caps: {},
      entries: [
        {
          timestamp: Date.now(),
          kind: "credit_fund",
          jobId: "fund:credit-1:fund-1",
          providerEndpoint: "https://p.example",
          msats: 100_000,
          btcRate: 100_000,
          usd: 0.1,
        },
      ],
    });

    expect(
      recordSpendOnce({
        msats: 100_000,
        btcRate: 100_000,
        kind: "credit_fund",
        jobId: "fund:credit-1:fund-1",
        providerEndpoint: "https://p.example",
      })
    ).toBe(false);
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});

describe("checkBudget", () => {
  const now = new Date("2026-04-17T12:00:00Z");

  it("returns ok when no caps configured", () => {
    setStoredLedger({ caps: {}, entries: [] });
    expect(checkBudget({ plannedMsats: 1_000_000, btcRate: 100_000, now })).toEqual({ ok: true });
  });

  it("returns ok when planned spend stays under daily cap", () => {
    setStoredLedger({
      caps: { dailyUsd: 5 },
      entries: [
        {
          timestamp: now.getTime() - 1000,
          jobId: "j1",
          providerEndpoint: "p",
          msats: 1_000_000,
          btcRate: 100_000,
          usd: 1,
        },
      ],
    });
    const result = checkBudget({ plannedMsats: 1_000_000, btcRate: 100_000, now });
    expect(result.ok).toBe(true);
  });

  it("returns budget_exceeded when planned + spent > daily cap", () => {
    setStoredLedger({
      caps: { dailyUsd: 5 },
      entries: [
        {
          timestamp: now.getTime() - 1000,
          jobId: "j1",
          providerEndpoint: "p",
          msats: 4_500_000,
          btcRate: 100_000,
          usd: 4.5,
        },
      ],
    });
    const result = checkBudget({ plannedMsats: 1_000_000, btcRate: 100_000, now });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.window).toBe("daily");
      expect(result.spentUsd).toBeCloseTo(4.5, 2);
      expect(result.limitUsd).toBe(5);
    }
  });

  it("excludes entries from prior windows", () => {
    setStoredLedger({
      caps: { dailyUsd: 5 },
      entries: [
        {
          // Yesterday at 10am UTC — outside today's window
          timestamp: new Date("2026-04-16T10:00:00Z").getTime(),
          jobId: "old",
          providerEndpoint: "p",
          msats: 4_500_000,
          btcRate: 100_000,
          usd: 4.5,
        },
      ],
    });
    const result = checkBudget({ plannedMsats: 1_000_000, btcRate: 100_000, now });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["daily", "2026-04-17T00:00:00Z", "2026-04-18T00:00:00Z"],
    ["weekly", "2026-04-13T00:00:00Z", "2026-04-20T00:00:00Z"],
    ["monthly", "2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z"],
  ] as const)("keeps %s cap decisions at the UTC boundary with retained history", (window, start, end) => {
    const entry = {
      jobId: "boundary", providerEndpoint: "https://example.com", msats: 1_000_000,
      btcRate: 100_000, usd: 1,
    };
    setStoredLedger({
      caps: { [`${window}Usd`]: 2 },
      entries: [
        { ...entry, timestamp: new Date("2020-01-01T00:00:00Z").getTime(), usd: 10_000 },
        { ...entry, timestamp: new Date(start).getTime() - 1, usd: 100 },
        { ...entry, timestamp: new Date(start).getTime() },
      ],
    });
    expect(checkBudget({ plannedMsats: 1_000_000, btcRate: 100_000, now })).toEqual({ ok: true });
    expect(checkBudget({ plannedMsats: 1_000_001, btcRate: 100_000, now })).toMatchObject({
      ok: false, window, spentUsd: 1, limitUsd: 2, resetsAt: new Date(end).getTime(),
    });
    expect(statusSnapshot(now).windows.find((item) => item.window === window)?.spentUsd).toBe(1);
    expect(checkBudget({ plannedMsats: 2_000_000, btcRate: 100_000, now: new Date(end) })).toEqual({ ok: true });
  });

  it("reports daily before weekly when both are exceeded", () => {
    setStoredLedger({
      caps: { dailyUsd: 5, weeklyUsd: 10 },
      entries: [
        {
          timestamp: now.getTime() - 1000,
          jobId: "j1",
          providerEndpoint: "p",
          msats: 9_000_000,
          btcRate: 100_000,
          usd: 9,
        },
      ],
    });
    const result = checkBudget({ plannedMsats: 1_000_000, btcRate: 100_000, now });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.window).toBe("daily");
  });
});

describe("statusSnapshot", () => {

  // a credit funding is money the agent moves and must both count
  // toward the cap total and be named in its own breakdown bucket.
  it("splits credit fundings into their own breakdown bucket", () => {
    const now = new Date("2026-04-17T12:00:00Z");
    const base = {
      timestamp: now.getTime() - 1000,
      providerEndpoint: "p",
      msats: 1_000_000,
      btcRate: 100_000,
      usd: 1,
    };
    setStoredLedger({
      caps: { dailyUsd: 5 },
      entries: [
        { ...base, jobId: "j1" },
        { ...base, jobId: "f1", kind: "float_fund" },
        { ...base, jobId: "c1", kind: "credit_fund" },
      ],
    });
    const snap = statusSnapshot(now);
    expect(snap.caps.dailyUsd).toBe(5);
    const daily = snap.windows.find((w) => w.window === "daily");
    expect(daily?.spentUsd).toBe(3);
    expect(daily?.limitUsd).toBe(5);
    expect(daily?.breakdown).toEqual({
      totalUsd: 3,
      jobsUsd: 1,
      floatFundingsUsd: 1,
      creditFundingsUsd: 1,
    });
  });
});

describe("enforceGlobalBudget", () => {
  it("returns the rate without fetching when caps unset and a rate is provided", async () => {
    setStoredLedger({ caps: {}, entries: [] });
    const result = await enforceGlobalBudget({ plannedMsats: 1_000_000, btcRate: 100_000 });
    expect(result).toBe(100_000);
    expect(fetchBtcUsdRate).not.toHaveBeenCalled();
  });

  it("falls back to the last-known cached rate when caps unset and rate fetch fails", async () => {
    setStoredLedger({ caps: {}, entries: [] });
    vi.mocked(fetchBtcUsdRate).mockRejectedValueOnce(new Error("offline"));
    vi.mocked(getLastKnownBtcRate).mockReturnValueOnce({ rate: 99_000, cachedAt: Date.now() });
    const result = await enforceGlobalBudget({ plannedMsats: 1_000_000 });
    expect(result).toBe(99_000);
  });

  it("returns 0 when caps unset, fetch fails, and no cached rate exists", async () => {
    setStoredLedger({ caps: {}, entries: [] });
    vi.mocked(fetchBtcUsdRate).mockRejectedValueOnce(new Error("offline"));
    vi.mocked(getLastKnownBtcRate).mockReturnValueOnce(null);
    const result = await enforceGlobalBudget({ plannedMsats: 1_000_000 });
    expect(result).toBe(0);
  });

  it("enforces caps against the last-known cached rate when the fetch fails", async () => {
    setStoredLedger({ caps: { dailyUsd: 5 }, entries: [] });
    vi.mocked(fetchBtcUsdRate).mockRejectedValueOnce(new Error("coingecko returned HTTP 429"));
    vi.mocked(getLastKnownBtcRate).mockReturnValueOnce({ rate: 99_000, cachedAt: Date.now() });

    // Returned so `recordSpend` debits the ledger at the rate the check used.
    const result = await enforceGlobalBudget({ plannedMsats: 1_000_000 });
    expect(result).toBe(99_000);
  });

  it("still blocks an over-cap spend when priced off a stale rate", async () => {
    setStoredLedger({
      caps: { dailyUsd: 1 },
      entries: [
        {
          timestamp: Date.now(),
          jobId: "j1",
          providerEndpoint: "p",
          msats: 900_000,
          btcRate: 100_000,
          usd: 0.9,
        },
      ],
    });
    vi.mocked(fetchBtcUsdRate).mockRejectedValueOnce(new Error("coingecko returned HTTP 429"));
    vi.mocked(getLastKnownBtcRate).mockReturnValueOnce({ rate: 100_000, cachedAt: Date.now() });

    await expect(enforceGlobalBudget({ plannedMsats: 200_000 })).rejects.toThrow(
      expect.objectContaining({ code: "budget_exceeded" }) as Error
    );
  });

  it("blocks with a typed rate_unavailable when caps are set and no rate exists at all", async () => {
    setStoredLedger({ caps: { dailyUsd: 5 }, entries: [] });
    vi.mocked(fetchBtcUsdRate).mockRejectedValueOnce(new Error("coingecko returned HTTP 429"));
    vi.mocked(getLastKnownBtcRate).mockReturnValueOnce(null);

    try {
      await enforceGlobalBudget({ plannedMsats: 1_000_000 });
      expect.unreachable("should have thrown — an unpriceable spend can't be cap-enforced");
    } catch (e) {
      expect(e).toBeInstanceOf(DvmError);
      const err = e as DvmError;
      expect(err.code).toBe("rate_unavailable");
      expect(err.hint).toBeTruthy();
      expect(err.data).toMatchObject({ display: expect.any(String) as string });
    }
  });

  it("throws DvmError(budget_exceeded) with a fully-populated data shape", async () => {
    setStoredLedger({
      caps: { dailyUsd: 1 },
      entries: [
        {
          timestamp: Date.now(),
          jobId: "j1",
          providerEndpoint: "p",
          msats: 900_000,
          btcRate: 100_000,
          usd: 0.9,
        },
      ],
    });
    vi.mocked(fetchBtcUsdRate).mockResolvedValueOnce(100_000);
    try {
      await enforceGlobalBudget({ plannedMsats: 200_000 });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DvmError);
      const err = e as DvmError;
      expect(err.code).toBe("budget_exceeded");
      // The data field is the agent-facing UX contract — assert all relayable fields.
      expect(err.data).toMatchObject({
        window: "daily",
        spent: { display: expect.stringContaining("$0.9") },
        limit: { display: "$1.00/day" },
        resets_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      // Hint should suggest a concrete amount, not "$N".
      expect(err.hint).toContain("dvm budget set --daily");
      expect(err.hint).not.toContain("$N");
    }
  });
});

describe("enforceGlobalBudget + recordSpend round-trip", () => {
  it("a recorded spend contributes to a subsequent enforceGlobalBudget check", async () => {
    setStoredLedger({ caps: { dailyUsd: 1 }, entries: [] });
    recordSpend({
      msats: 900_000,
      btcRate: 100_000,
      jobId: "j1",
      providerEndpoint: "p",
    });
    const written = vi.mocked(writeFileSync).mock.calls.at(-1)?.[1] as string;
    setStoredLedger(JSON.parse(written) as BudgetLedger);

    vi.mocked(fetchBtcUsdRate).mockResolvedValueOnce(100_000);
    try {
      await enforceGlobalBudget({ plannedMsats: 200_000 });
      expect.unreachable("should have thrown — prior recorded spend should count");
    } catch (e) {
      expect((e as DvmError).code).toBe("budget_exceeded");
    }
  });
});

describe("saveLedger", () => {

  it("preserves entries older than 32 days", () => {
    const now = new Date("2026-04-17T12:00:00Z");
    const recent = now.getTime() - 1_000;
    const stale = now.getTime() - 33 * 24 * 60 * 60 * 1000;
    saveLedger(
      {
        caps: { dailyUsd: 5 },
        entries: [
          {
            timestamp: recent,
            jobId: "fresh",
            providerEndpoint: "p",
            msats: 1,
            btcRate: 100_000,
            usd: 0.001,
          },
          {
            timestamp: stale,
            jobId: "old",
            providerEndpoint: "p",
            msats: 1,
            btcRate: 100_000,
            usd: 0.001,
          },
        ],
      },
      now
    );
    const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    const parsed = JSON.parse(written) as BudgetLedger;
    expect(parsed.entries.map((entry) => entry.jobId)).toEqual(["fresh", "old"]);
    expect(parsed.caps.dailyUsd).toBe(5);
  });
});
