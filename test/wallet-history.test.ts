vi.mock("../src/lib/output", async () => ({ ...(await vi.importActual<typeof import("../src/lib/output")>("../src/lib/output")), json: output.json, info: output.info }));
vi.mock("../src/lib/budget-ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/budget-ledger")>()),
  loadLedger: output.loadLedger,
}));
import { beforeEach, expect, it, vi } from "vitest";
const output = vi.hoisted(() => ({
  json: vi.fn(),
  info: vi.fn(),
  loadLedger: vi.fn(),
  loadReceipts: vi.fn(),
  listCredits: vi.fn(),
  readCompletedCreditHistory: vi.fn(),
}));
vi.mock("@dvmkit/sdk/internal", async () => ({
  ...(await vi.importActual<typeof import("@dvmkit/sdk/internal")>(
    "@dvmkit/sdk/internal",
  )),
  ...output,
}));
import { walletHistory } from "../src/commands/wallet-history";
const endpoint = "https://example.com";
const timestamp = 1_700_000_000_000;
const refund = {
  v: 1,
  kind: "completed_refund",
  outcome: "refunded",
  id: "refund:1",
  occurredAt: timestamp,
  endpoint,
  endpointAliases: ["https://alias.example"],
  callerPubkey: "caller",
  creditId: "credit",
  drainId: "drain",
  dvmId: null,
  rail: "tempo",
  currency: "eur",
  amountMicro: 2_000_000,
  feeMicro: null,
  settledAt: timestamp,
  collectedAt: null,
  receipts: [],
  provenance: {
    settlement: "local_observation",
    receipts: "unverified_observations",
    advertisement: "absent",
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  output.loadLedger.mockReturnValue({ entries: [] });
  output.loadReceipts.mockReturnValue([]);
  output.listCredits.mockReturnValue([]);
  output.readCompletedCreditHistory.mockReturnValue({ records: [] });
});
it("reads every bounded archive page, filters alias origins, and keeps tied rows in deterministic pages", () => {
  output.readCompletedCreditHistory.mockImplementation(({ cursor }) =>
    cursor
      ? { records: [{ ...refund, id: "refund:a", drainId: "a" }] }
      : {
          records: [{ ...refund, id: "refund:z", drainId: "z" }],
          nextCursor: "page2",
        },
  );
  walletHistory({ endpoint: "https://alias.example/path", limit: "1" });
  expect(output.json.mock.lastCall?.[0]).toMatchObject({
    count: 1,
    matched_count: 2,
    next_offset: 1,
    entries: [
      {
        id: "refund:z",
        currency: "eur",
        amount_micro: 2_000_000,
        fee_micro: null,
        collected_at: null,
      },
    ],
    total_usd: 0,
  });
  expect(output.readCompletedCreditHistory.mock.calls[1]?.[0]).toEqual({
    order: "desc",
    limit: 100,
    cursor: "page2",
  });
  walletHistory({
    endpoint: "https://alias.example/path",
    offset: "1",
    limit: "1",
  });
  expect(output.json.mock.lastCall?.[0]).toMatchObject({
    entries: [{ id: "refund:a" }],
    next_offset: null,
  });
});
it("separates active recovery and completed outcomes from funding and draw totals", () => {
  output.loadLedger.mockReturnValue({
    entries: [
      {
        timestamp,
        kind: "credit_fund",
        jobId: "fund",
        providerEndpoint: endpoint,
        usd: 3,
        btcRate: 100_000,
        msats: 3_000_000,
      },
    ],
  });
  output.loadReceipts.mockReturnValue([
    {
      endpoint,
      receipt: {
        issued_at: timestamp / 1000,
        outcome: "completed",
        job_id: "job",
        capability: "work",
        credit: { credit_id: "credit", draw_id: "draw", amount: 1_000_000 },
      },
    },
  ]);
  output.readCompletedCreditHistory.mockReturnValue({
    records: [
      refund,
      {
        ...refund,
        id: "loss",
        kind: "expired_credit_loss",
        outcome: "lost",
        reason: "expired",
        releasedAt: timestamp,
        expiryMs: timestamp,
        releasedByJobId: "old",
      },
    ],
  });
  output.listCredits.mockReturnValue([
    {
      endpoint,
      callerPubkey: "caller",
      pendingDrains: [
        {
          creditId: "credit",
          drainId: "drain",
          requestedAt: timestamp,
          method: "tempo",
        },
        {
          creditId: "other",
          drainId: "owed",
          requestedAt: timestamp,
          method: "x402",
          payout: { credential: "must-not-appear" },
        },
      ],
    },
  ]);
  walletHistory({});
  const result = output.json.mock.lastCall?.[0];
  expect(result).toMatchObject({ total_usd: 3, count: 5 });
  expect(
    result.entries.filter(
      (row: { kind: string }) => row.kind === "active_recovery",
    ),
  ).toEqual([
    expect.objectContaining({
      drain_id: "owed",
      outcome: "pending",
      amount_micro: null,
    }),
  ]);
  expect(
    result.entries.find((row: { kind: string }) => row.kind === "credit_draw"),
  ).toMatchObject({ usd: null, currency: null, amount_micro: 1_000_000 });
  expect(JSON.stringify(result)).not.toContain("must-not-appear");
  expect(
    result.entries.find((row: { kind: string }) => row.kind === "credit_fund"),
  ).toMatchObject({
    rail: null,
    currency: null,
    settlement: "unknown",
    valuation_unit: "btc_equivalent",
  });
  walletHistory({
    kind: "completed_refund",
    since: new Date(timestamp).toISOString(),
    human: true,
  });
  expect(output.info.mock.calls.flat().join("\n")).toContain(
    "refund completed: 2 eur · refunded · rail tempo · fee unknown",
  );
});
it("rejects invalid offsets and keeps unknown valuations out of totals", () => {
  expect(() => walletHistory({ offset: "-1" })).toThrow(
    "Invalid history offset",
  );
  expect(() => walletHistory({ cursor: "" })).toThrow("History changed");
  expect(() => walletHistory({ kind: "typo" })).toThrow(
    "Unknown wallet history kind",
  );
  output.loadLedger.mockReturnValue({
    entries: [
      {
        timestamp,
        jobId: "legacy",
        providerEndpoint: endpoint,
        usd: 0,
        btcRate: 0,
        msats: 1000,
      },
    ],
  });
  walletHistory({});
  expect(output.json.mock.lastCall?.[0]).toMatchObject({
    entries: [{ usd: null, rail: null, currency: null }],
    total_usd: 0,
  });
});

it("binds continuations to filters and refuses a changed merged history", () => {
  output.readCompletedCreditHistory.mockReturnValue({
    records: [refund, { ...refund, id: "refund:2", drainId: "drain2" }],
  });
  walletHistory({ limit: "1", kind: "completed_refund" });
  const cursor = output.json.mock.lastCall?.[0].next_cursor;
  walletHistory({ limit: "1", kind: "completed_refund", cursor });
  expect(output.json.mock.lastCall?.[0]).toMatchObject({
    entries: [{ id: "refund:1" }],
    next_cursor: null,
  });
  expect(() => walletHistory({ cursor })).toThrow("History changed");
  expect(() =>
    walletHistory({ cursor, kind: "completed_refund", offset: "1" }),
  ).toThrow("History changed");
  output.readCompletedCreditHistory.mockReturnValue({ records: [refund] });
  expect(() => walletHistory({ cursor, kind: "completed_refund" })).toThrow(
    "History changed",
  );
});

it("filters active recovery through stored aliases without suppressing another service's same IDs", () => {
  const pair = { dvmId: "service", attestedBuilderPubkey: "aa".repeat(32) };
  output.readCompletedCreditHistory.mockReturnValue({
    records: [{ ...refund, ...pair }],
  });
  const pending = {
    creditId: "credit",
    drainId: "drain",
    requestedAt: timestamp,
    method: "tempo",
  };
  output.listCredits.mockReturnValue([
    {
      endpoint: "https://relocated.example",
      endpointAliases: [endpoint],
      callerPubkey: "caller",
      ...pair,
      pendingDrains: [pending],
    },
    {
      endpoint,
      endpointAliases: ["https://active-alias.example"],
      callerPubkey: "caller",
      ...pair,
      attestedBuilderPubkey: "bb".repeat(32),
      pendingDrains: [pending],
    },
    {
      endpoint: "https://unrelated.example",
      callerPubkey: "caller",
      pendingDrains: [pending],
    },
  ]);
  walletHistory({ kind: "active_recovery" });
  expect(output.json.mock.lastCall?.[0]).toMatchObject({ count: 2 });
  expect(
    new Set(
      output.json.mock.lastCall?.[0].entries.map(
        (row: { id: string }) => row.id,
      ),
    ).size,
  ).toBe(2);
  walletHistory({
    kind: "active_recovery",
    endpoint: "https://active-alias.example",
  });
  expect(output.json.mock.lastCall?.[0]).toMatchObject({
    count: 1,
    entries: [{ endpoint, drain_id: "drain", outcome: "pending" }],
  });
  walletHistory({
    kind: "active_recovery",
    endpoint: "https://absent.example",
  });
  expect(output.json.mock.lastCall?.[0]).toMatchObject({ count: 0 });
});
