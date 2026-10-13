import * as fs from "fs";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), renameSync: vi.fn(actual.renameSync) };
});

import { BUDGET_FILE, CONFIG_DIR } from "@dvmkit/sdk/internal";
import {
  type BudgetLedger,
  loadLedger,
  recordSpend,
  recordSpendOnce,
  saveLedger,
  setCaps,
} from "../budget-ledger";

const historicalEntry = {
  timestamp: new Date("2020-01-01T00:00:00Z").getTime(),
  jobId: "legacy-payment", providerEndpoint: "https://example.com", msats: 1_000_000,
  btcRate: 100_000, usd: 1,
  principalMsats: 900_000, routingFeeMsats: null, totalWalletFeeMsats: 100_000,
  unitemizedWalletFeeMsats: null, walletDebitMsats: 1_000_000,
  label: "processing", labelSource: "provider" as const,
};
const legacyLedger: BudgetLedger = { caps: { monthlyUsd: 10 }, entries: [historicalEntry] };

beforeEach(() => {
  fs.writeFileSync(BUDGET_FILE, JSON.stringify(legacyLedger));
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => fs.rmSync(CONFIG_DIR, { recursive: true, force: true }));

describe("durable spending history", () => {
  it("retains legacy spending and its fee evidence across cap changes, appends and repeated saves", () => {
    setCaps({ dailyUsd: 5 });
    recordSpend({ msats: 1_000_000, btcRate: 100_000, jobId: "new-payment", providerEndpoint: "https://example.com", now: new Date("2026-04-17T12:00:00Z") });
    for (const clock of ["2027-01-01", "2030-01-01"]) saveLedger(loadLedger(), new Date(clock));
    const stored = loadLedger();
    expect(stored.caps).toEqual({ dailyUsd: 5 });
    expect(stored.entries).toEqual([
      historicalEntry,
      { timestamp: new Date("2026-04-17T12:00:00Z").getTime(), jobId: "new-payment", providerEndpoint: "https://example.com", msats: 1_000_000, btcRate: 100_000, usd: 1 },
    ]);
    expect(recordSpendOnce({ msats: 1_000_000, btcRate: 100_000, jobId: historicalEntry.jobId, providerEndpoint: historicalEntry.providerEndpoint })).toBe(false);
    expect(loadLedger().entries).toEqual(stored.entries);
  });

  it.each(["write", "rename"] as const)("preserves the last durable history when the %s fails", (stage) => {
    if (stage === "write") {
      vi.mocked(fs.writeFileSync).mockImplementationOnce((path) => {
        fs.appendFileSync(path, '{"caps":');
        throw new Error("interrupted write");
      });
    } else {
      vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error("interrupted rename"); });
    }
    expect(() => saveLedger({ caps: {}, entries: [] })).toThrow(`interrupted ${stage}`);
    expect(loadLedger()).toEqual(legacyLedger);
    vi.restoreAllMocks();
    saveLedger(loadLedger());
    expect(loadLedger()).toEqual(legacyLedger);
  });

  it("does not invent history removed by an older writer", () => {
    fs.writeFileSync(BUDGET_FILE, JSON.stringify({ caps: { dailyUsd: 5 } }));
    saveLedger(loadLedger());
    expect(loadLedger()).toEqual({ caps: { dailyUsd: 5 }, entries: [] });
  });
});
