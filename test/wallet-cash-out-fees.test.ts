import { beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  json: vi.fn(),
  info: vi.fn(),
  cashOutFromMint: vi.fn(),
}));

vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
  loadAgentWallet: vi.fn(() => ({
    mints: ["https://mint.invalid"],
    proofs: [
      {
        mint: "https://mint.invalid",
        secret: "s",
        C: "c",
        amount: 400,
        id: "k",
        locked_to_pubkey: "p",
        status: "valid",
      },
    ],
  })),
  validateLnAddress: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/output", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/output")>()),
  json: seams.json,
  info: seams.info,
}));
vi.mock("../src/lib/wallet-agent/cash-out", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/wallet-agent/cash-out")>()),
  cashOutFromMint: seams.cashOutFromMint,
}));
vi.mock("../src/lib/wallet-agent/mint-inventory", () => ({ loadConfiguredMints: vi.fn(async () => undefined) }));
vi.mock("../src/lib/wallet-agent/recovery-melt", () => ({ sweepPendingMelts: vi.fn(async () => undefined) }));
vi.mock("../src/lib/wallet-agent/recovery", () => ({ sweepPendingMints: vi.fn(async () => undefined) }));

import { walletCashOut } from "../src/commands/wallet-cash-out";

const MINT = "https://mint.invalid";

function quote(amount: number, reserve: number, inputFee: number, debit: number) {
  return {
    mint: MINT,
    quote_id: "q1",
    amount_sats: amount,
    fee_reserve_sats: reserve,
    input_fee_sats: inputFee,
    debit_sats: debit,
    expires_at: null,
  };
}

function lastJson(status: string): Record<string, any> {
  const call = seams.json.mock.calls.map((c) => c[0]).filter((v) => v.status === status).at(-1);
  if (!call) throw new Error(`no ${status} output`);
  return call;
}

beforeEach(() => {
  seams.json.mockReset();
  seams.info.mockReset();
  seams.cashOutFromMint.mockReset();
});

describe("cash-out fee itemisation", () => {
  it("splits a settled 308-sat payout's 14 sats of fees into routing and mint input fee, about 4.5%", async () => {
    const q = quote(308, 4, 10, 322);
    seams.cashOutFromMint.mockImplementation(async (opts) => {
      opts.onQuote?.(q);
      return { kind: "sent", mint: MINT, quote: q, preimage: "pre", change_sats: 0 };
    });

    await walletCashOut("lnurl1testdestination", { all: true });

    const summary = lastJson("cashed_out");
    expect(summary).toMatchObject({
      sats_sent: 308,
      fee_sats: 14,
      input_fee_sats: 10,
      routing_fee_sats: 4,
      routing_reserve_returned_sats: 0,
      fee_share_pct: 4.5,
    });
    expect(summary.mints[0]).toMatchObject({
      fee_sats: 14,
      routing_fee_sats: 4,
      input_fee_sats: 10,
      fee_share_pct: 4.5,
    });
    // The same 4.5% share trips the pre-commit warning, which names both flags.
    const preCommit = lastJson("cash_out_quote");
    expect(preCommit).toMatchObject({ fee_sats: 14, fee_warning: true });
    expect(preCommit.display).toContain("--max-fee");
    expect(preCommit.display).toContain("--dry-run");
  });

  it("reports routing reserve that came back when routing cost less than reserved", async () => {
    // 300 sent, 10 reserved for routing, 1 input fee, 311 committed; 6 sats came back.
    const q = quote(300, 10, 1, 311);
    seams.cashOutFromMint.mockResolvedValue({ kind: "sent", mint: MINT, quote: q, preimage: null, change_sats: 6 });

    await walletCashOut("lnurl1testdestination", { all: true });

    const summary = lastJson("cashed_out");
    expect(summary).toMatchObject({
      fee_sats: 5,
      routing_fee_sats: 4,
      routing_reserve_returned_sats: 6,
    });
  });

  it.each([
    { fees: 20, warns: false }, // exactly 2% of the payout is not "large"
    { fees: 21, warns: true },
  ])("dry run with $fees sats of fees on 1000 sats: warning is $warns", async ({ fees, warns }) => {
    const q = quote(1000, fees - 1, 1, 1000 + fees);
    seams.cashOutFromMint.mockImplementation(async (opts) => {
      opts.onQuote?.(q);
      return { kind: "quoted", mint: MINT, quote: q };
    });

    await walletCashOut("lnurl1testdestination", { all: true, dryRun: true });

    const summary = lastJson("quoted");
    expect(summary.quoted_fee_sats).toBe(fees);
    expect(summary.fee_warning).toBe(warns);
    expect(summary.mints[0].fee_warning).toBe(warns);
    expect(lastJson("cash_out_quote").fee_warning).toBe(warns);
    expect(summary.display.includes("--max-fee")).toBe(warns);
    expect(summary.display.includes("--dry-run")).toBe(warns);
  });
});
