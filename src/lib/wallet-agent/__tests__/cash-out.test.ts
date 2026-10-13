vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
 ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
 loadAgentWallet: vi.fn(),
saveAgentWallet: vi.fn(),
withWalletLock: vi.fn(<T>(fn: () => Promise<T> | T) => Promise.resolve(fn())),
fetchMeltQuote: vi.fn(),
getInputFeesForProofs: vi.fn(),
getWallet: vi.fn(),
serializeOutputData: (data: unknown[]) => data
}));
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cashu/cashu-ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("@cashu/cashu-ts")>()), ...(() => ({
  Amount: {
    from: (x: unknown) => ({
      toNumber: () =>
        typeof x === "object" && x !== null && "toNumber" in x
          ? (x as { toNumber: () => number }).toNumber()
          : Number(x),
    }),
  },
}))() }));

import { fetchMeltQuote, getInputFeesForProofs } from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";
import { cashOutFromMint } from "../cash-out";
import type { AgentProof, AgentWallet } from "@dvmkit/sdk/internal";
import { loadAgentWallet, saveAgentWallet } from "@dvmkit/sdk/internal";

const MINT = "https://mint.example";
const OTHER_MINT = "https://other.example";
const LOCK_PUBKEY = "02" + "cd".repeat(32);
const LOCK_PRIVKEY = "ab".repeat(32);
const DEST = "recipient@example.com";

function proof(secret: string, amount: number, partial: Partial<AgentProof> = {}): AgentProof {
  return {
    mint: MINT,
    secret,
    C: `02${secret}C`,
    amount,
    id: "k1",
    locked_to_pubkey: LOCK_PUBKEY,
    status: "valid",
    ...partial,
  };
}

function walletWith(proofs: AgentProof[]): AgentWallet {
  return {
    version: 9,
    lock_privkey: LOCK_PRIVKEY,
    lock_pubkey: LOCK_PUBKEY,
    mnemonic_fingerprint: null,
    mints: [MINT],
    proofs,
    nut13_counters: {},
    pending_mints: [],
    pending_melts: [],
    pending_submissions: [],
    recent_spends: [],
    created_at: "2026-07-30T00:00:00.000Z",
  };
}

interface FakeWalletOpts {
  change?: { id: string; amount: number; secret: string; C: string }[];
  meltError?: Error;
  quoteState?: "UNPAID" | "PENDING" | "PAID";
  onCall?: (name: string) => void;
  meltBounds?: { min_amount?: number; max_amount?: number };
}

function makeCashuWallet(opts: FakeWalletOpts = {}) {
  const builder = {
    asP2PK: vi.fn().mockReturnThis(),
    privkey: vi.fn().mockReturnThis(),
    prepare: vi.fn().mockResolvedValue({
      method: "bolt11",
      inputs: [],
      outputData: [{ blank: true }],
      keysetId: "k1",
      quote: { quote: "q1" },
    }),
  };
  return {
    getMintInfo: () => ({
      cache: {
        nuts: {
          "5": { methods: [{ method: "bolt11", unit: "sat", ...(opts.meltBounds ?? {}) }] },
        },
      },
    }),
    ops: { meltBolt11: vi.fn().mockReturnValue(builder) },
    completeMelt: vi.fn(async () => {
      opts.onCall?.("completeMelt");
      if (opts.meltError) throw opts.meltError;
      return {
        quote: { quote: "q1", payment_preimage: "deadbeef" },
        change: opts.change ?? [],
      };
    }),
    checkMeltQuoteBolt11: vi.fn(async () => ({ state: opts.quoteState ?? "UNPAID" })),
    _builder: builder,
  };
}

function stubQuotes(inputFee: number, quotes: { amount: number; feeReserve: number }[]) {
  vi.mocked(getInputFeesForProofs).mockResolvedValue(inputFee);
  let i = 0;
  vi.mocked(fetchMeltQuote).mockImplementation(async () => {
    const q = quotes[Math.min(i, quotes.length - 1)];
    i += 1;
    return {
      amountSats: q.amount,
      feeReserveSats: q.feeReserve,
      rawQuote: { quote: `q${i}`, expiry: 1_800_000_000 } as never,
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cashOutFromMint", () => {
  it("skips a mint with no spendable proofs instead of failing the caller", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([proof("a", 64, { mint: OTHER_MINT })]));
    const outcome = await cashOutFromMint({
      mintUrl: MINT,
      target: { kind: "all" },
      destination: DEST,
      getWalletForMint: () => Promise.reject(new Error("must not be reached")),
    });
    expect(outcome).toMatchObject({ kind: "skipped", reason: "no_balance" });
  });

  it("excludes reserve proofs and in-flight proofs from the candidate pool", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(
      walletWith([
        proof("res", 64, { reserved_for: "builder/scrape.dvmkit.ai", t_expire: 1 }),
        proof("busy", 32, { status: "in_flight", in_flight_until_ms: 9e15 }),
      ])
    );
    const outcome = await cashOutFromMint({
      mintUrl: MINT,
      target: { kind: "all" },
      destination: DEST,
      getWalletForMint: () => Promise.reject(new Error("must not be reached")),
    });
    expect(outcome).toMatchObject({ kind: "skipped", reason: "no_balance" });
  });

  it("drains a mint: invoice sized down by fees, change re-locked, inputs removed", async () => {
    const proofs = [proof("a", 64), proof("b", 32)];
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith(proofs));
    stubQuotes(2, [
      { amount: 94, feeReserve: 4 },
      { amount: 90, feeReserve: 4 },
    ]);
    const cashuWallet = makeCashuWallet({
      change: [{ id: "k1", amount: 3, secret: "chg", C: "02chg" }],
    });

    const outcome = await cashOutFromMint({
      mintUrl: MINT,
      target: { kind: "all" },
      destination: DEST,
      fetchInvoice: vi.fn().mockResolvedValue("lnbc"),
      getWalletForMint: async () => cashuWallet as never,
    });

    expect(outcome).toMatchObject({
      kind: "sent",
      preimage: "deadbeef",
      change_sats: 3,
      quote: { amount_sats: 90, fee_reserve_sats: 4, input_fee_sats: 2, debit_sats: 96 },
    });
    expect(cashuWallet._builder.asP2PK).toHaveBeenCalledWith({ pubkey: LOCK_PUBKEY });
    expect(cashuWallet._builder.privkey).toHaveBeenCalledWith(LOCK_PRIVKEY);
    expect(cashuWallet.completeMelt).toHaveBeenCalledWith(expect.anything(), LOCK_PRIVKEY);

    const final = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(final?.proofs.map((p) => p.secret)).toEqual(["chg"]);
    expect(final?.proofs[0].locked_to_pubkey).toBe(LOCK_PUBKEY);
    expect(final?.pending_melts).toEqual([]);
  });

  it("puts fees on top of a stated amount rather than shaving the payout", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([proof("a", 64), proof("b", 64)]));
    stubQuotes(2, [{ amount: 50, feeReserve: 4 }]);
    const fetchInvoice = vi.fn().mockResolvedValue("lnbc50");

    const outcome = await cashOutFromMint({
      mintUrl: MINT,
      target: { kind: "exact", sats: 50 },
      destination: DEST,
      fetchInvoice,
      getWalletForMint: async () => makeCashuWallet() as never,
    });

    expect(fetchInvoice).toHaveBeenCalledWith(DEST, 50_000);
    expect(outcome).toMatchObject({ kind: "sent", quote: { amount_sats: 50, debit_sats: 64 } });
  });

  it("widens before quoting when the input fee alone would shrink a stated payout", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([proof("a", 64), proof("b", 64)]));
    stubQuotes(2, [{ amount: 64, feeReserve: 2 }]);
    const fetchInvoice = vi.fn().mockResolvedValue("lnbc64");

    const outcome = await cashOutFromMint({
      mintUrl: MINT,
      target: { kind: "exact", sats: 64 },
      destination: DEST,
      fetchInvoice,
      getWalletForMint: async () => makeCashuWallet() as never,
    });

    expect(fetchInvoice).toHaveBeenCalledWith(DEST, 64_000);
    expect(outcome).toMatchObject({ kind: "sent", quote: { amount_sats: 64, debit_sats: 128 } });
  });

  it("widens the input set when the quoted routing reserve doesn't fit, keeping the payout intact", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([proof("a", 64), proof("b", 64)]));
    stubQuotes(2, [{ amount: 50, feeReserve: 14 }]);
    const fetchInvoice = vi.fn().mockResolvedValue("lnbc50");

    const outcome = await cashOutFromMint({
      mintUrl: MINT,
      target: { kind: "exact", sats: 50 },
      destination: DEST,
      fetchInvoice,
      getWalletForMint: async () => makeCashuWallet() as never,
    });

    expect(fetchInvoice).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ kind: "sent", quote: { amount_sats: 50, debit_sats: 128 } });
  });

  it("re-invoices at a smaller amount when the mint has nothing left to widen with", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([proof("a", 64)]));
    stubQuotes(2, [
      { amount: 62, feeReserve: 10 },
      { amount: 52, feeReserve: 10 },
    ]);
    const fetchInvoice = vi.fn().mockResolvedValue("lnbc");

    const outcome = await cashOutFromMint({
      mintUrl: MINT,
      target: { kind: "all" },
      destination: DEST,
      fetchInvoice,
      getWalletForMint: async () => makeCashuWallet() as never,
    });

    expect(fetchInvoice.mock.calls.map((c) => c[1])).toEqual([62_000, 52_000]);
    expect(outcome).toMatchObject({ kind: "sent", quote: { amount_sats: 52 } });
  });

  it("persists the pending melt — with the blank change outputs — before calling the mint", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([proof("a", 64)]));
    stubQuotes(2, [{ amount: 60, feeReserve: 2 }]);
    const order: string[] = [];
    vi.mocked(saveAgentWallet).mockImplementation(() => {
      order.push("save");
    });
    const cashuWallet = makeCashuWallet({ onCall: (n) => order.push(n) });

    await cashOutFromMint({
      mintUrl: MINT,
      target: { kind: "all" },
      destination: DEST,
      fetchInvoice: vi.fn().mockResolvedValue("lnbc60"),
      getWalletForMint: async () => cashuWallet as never,
    });

    expect(order[0]).toBe("save");
    expect(order[1]).toBe("completeMelt");

    const committed = vi.mocked(saveAgentWallet).mock.calls[0][0];
    expect(committed.pending_melts).toHaveLength(1);
    expect(committed.pending_melts[0]).toMatchObject({
      mint: MINT,
      destination: DEST,
      amount_sats: 60,
      bolt11: "lnbc60",
      melting: { keyset_id: "k1", outputs: [{ blank: true }] },
    });
    expect(committed.pending_melts[0].input_proofs.map((p) => p.secret)).toEqual(["a"]);
    expect(committed.proofs).toEqual([expect.objectContaining({ secret: "a", amount: 64, status: "in_flight" })]);
  });

  it("returns the proofs to spendable when the mint confirms the invoice is unpaid", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([proof("a", 64)]));
    stubQuotes(2, [{ amount: 60, feeReserve: 2 }]);
    const cashuWallet = makeCashuWallet({
      meltError: new Error("mint said no"),
      quoteState: "UNPAID",
    });

    const outcome = await cashOutFromMint({
      mintUrl: MINT,
      target: { kind: "all" },
      destination: DEST,
      fetchInvoice: vi.fn().mockResolvedValue("lnbc60"),
      getWalletForMint: async () => cashuWallet as never,
    });

    expect(outcome).toMatchObject({ kind: "failed", settlement: "reverted" });
    const final = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(final?.proofs).toEqual([{ ...proof("a", 64), in_flight_until_ms: undefined }]);
    expect(final?.pending_melts).toEqual([]);
  });

  it("leaves the entry standing when the melt's fate is unknown", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([proof("a", 64)]));
    stubQuotes(2, [{ amount: 60, feeReserve: 2 }]);
    const cashuWallet = makeCashuWallet({
      meltError: new Error("socket hang up"),
      quoteState: "PENDING",
    });

    const outcome = await cashOutFromMint({
      mintUrl: MINT,
      target: { kind: "all" },
      destination: DEST,
      fetchInvoice: vi.fn().mockResolvedValue("lnbc60"),
      getWalletForMint: async () => cashuWallet as never,
    });

    expect(outcome).toMatchObject({ kind: "failed", settlement: "unresolved" });
    expect(saveAgentWallet).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveAgentWallet).mock.calls[0][0].pending_melts).toHaveLength(1);
  });

  it("refuses a mint over --max-fee before anything is committed", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([proof("a", 64)]));
    stubQuotes(2, [{ amount: 50, feeReserve: 12 }]);
    const cashuWallet = makeCashuWallet();

    const outcome = await cashOutFromMint({
      mintUrl: MINT,
      target: { kind: "exact", sats: 50 },
      destination: DEST,
      maxFeeSats: 5,
      fetchInvoice: vi.fn().mockResolvedValue("lnbc50"),
      getWalletForMint: async () => cashuWallet as never,
    });

    expect(outcome).toMatchObject({ kind: "skipped", reason: "fee_cap_exceeded" });
    expect(cashuWallet.completeMelt).not.toHaveBeenCalled();
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("doesn't ask the payee for an invoice when the input fee alone breaks --max-fee", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([proof("a", 64)]));
    stubQuotes(8, [{ amount: 50, feeReserve: 1 }]);
    const cashuWallet = makeCashuWallet();
    const fetchInvoice = vi.fn().mockResolvedValue("lnbc50");

    const outcome = await cashOutFromMint({
      mintUrl: MINT,
      target: { kind: "exact", sats: 50 },
      destination: DEST,
      maxFeeSats: 5,
      fetchInvoice,
      getWalletForMint: async () => cashuWallet as never,
    });

    expect(outcome).toMatchObject({ kind: "skipped", reason: "fee_cap_exceeded" });
    expect(fetchInvoice).not.toHaveBeenCalled();
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("quotes and stops under --dry-run", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([proof("a", 64)]));
    stubQuotes(2, [{ amount: 60, feeReserve: 2 }]);
    const cashuWallet = makeCashuWallet();
    const onQuote = vi.fn();

    const outcome = await cashOutFromMint({
      mintUrl: MINT,
      target: { kind: "all" },
      destination: DEST,
      dryRun: true,
      onQuote,
      fetchInvoice: vi.fn().mockResolvedValue("lnbc60"),
      getWalletForMint: async () => cashuWallet as never,
    });

    expect(outcome).toMatchObject({ kind: "quoted", quote: { amount_sats: 60 } });
    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ fee_reserve_sats: 2 }));
    expect(cashuWallet.completeMelt).not.toHaveBeenCalled();
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("skips rather than fails when the payee's LNURL range excludes the amount", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([proof("a", 4)]));
    vi.mocked(getInputFeesForProofs).mockResolvedValue(0);

    const outcome = await cashOutFromMint({
      mintUrl: MINT,
      target: { kind: "all" },
      destination: DEST,
      fetchInvoice: vi
        .fn()
        .mockRejectedValue(new DvmError("lnurl_amount_out_of_range", "below minimum", "top up")),
      getWalletForMint: async () => makeCashuWallet() as never,
    });

    expect(outcome).toMatchObject({ kind: "skipped", reason: "amount_out_of_range" });
  });

  it("skips when the mint's input fee alone meets the balance", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([proof("a", 2)]));
    vi.mocked(getInputFeesForProofs).mockResolvedValue(2);

    const outcome = await cashOutFromMint({
      mintUrl: MINT,
      target: { kind: "all" },
      destination: DEST,
      fetchInvoice: vi.fn(),
      getWalletForMint: async () => makeCashuWallet() as never,
    });

    expect(outcome).toMatchObject({ kind: "skipped", reason: "fees_exceed_balance" });
    expect(fetchMeltQuote).not.toHaveBeenCalled();
  });

  it("bails before the mint call when another run moved the proofs first", async () => {
    const proofs = [proof("a", 64)];
    vi.mocked(loadAgentWallet)
      .mockReturnValueOnce(walletWith(proofs))
      .mockReturnValue(walletWith([]));
    stubQuotes(2, [{ amount: 60, feeReserve: 2 }]);
    const cashuWallet = makeCashuWallet();

    const outcome = await cashOutFromMint({
      mintUrl: MINT,
      target: { kind: "all" },
      destination: DEST,
      fetchInvoice: vi.fn().mockResolvedValue("lnbc60"),
      getWalletForMint: async () => cashuWallet as never,
    });

    expect(outcome).toMatchObject({ kind: "failed", settlement: "reverted" });
    expect(cashuWallet.completeMelt).not.toHaveBeenCalled();
  });
});

describe("cashOutFromMint melt amount bounds", () => {
  it("sizes --all down to the mint's per-melt maximum instead of failing at the melt", async () => {
    const proofs = [proof("a", 512), proof("b", 256), proof("c", 128), proof("d", 104)];
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith(proofs));
    stubQuotes(2, [{ amount: 500, feeReserve: 4 }]);

    const outcome = await cashOutFromMint({
      mintUrl: MINT,
      target: { kind: "all" },
      destination: DEST,
      fetchInvoice: vi.fn().mockResolvedValue("lnbc"),
      getWalletForMint: async () => makeCashuWallet({ meltBounds: { max_amount: 500 } }) as never,
    });

    expect(outcome).toMatchObject({ kind: "sent", mint_max_sats: 500 });
    expect((outcome as { quote: { amount_sats: number } }).quote.amount_sats).toBe(500);
    expect((outcome as { quote: { debit_sats: number } }).quote.debit_sats).toBeLessThan(1000);
  });

  it("sizes a stated --amount down to the cap, leaving the rest for the next mint", async () => {
    const proofs = [proof("a", 512), proof("b", 512)];
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith(proofs));
    stubQuotes(2, [{ amount: 500, feeReserve: 4 }]);

    const outcome = await cashOutFromMint({
      mintUrl: MINT,
      target: { kind: "exact", sats: 900 },
      destination: DEST,
      fetchInvoice: vi.fn().mockResolvedValue("lnbc"),
      getWalletForMint: async () => makeCashuWallet({ meltBounds: { max_amount: 500 } }) as never,
    });

    expect(outcome).toMatchObject({ kind: "sent", mint_max_sats: 500 });
    expect((outcome as { quote: { amount_sats: number } }).quote.amount_sats).toBe(500);
  });

  it("skips a mint holding less than its own minimum payout, without asking for an invoice", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith([proof("a", 64)]));
    stubQuotes(2, [{ amount: 62, feeReserve: 4 }]);
    const fetchInvoice = vi.fn().mockResolvedValue("lnbc");

    const outcome = await cashOutFromMint({
      mintUrl: MINT,
      target: { kind: "all" },
      destination: DEST,
      fetchInvoice,
      getWalletForMint: async () => makeCashuWallet({ meltBounds: { min_amount: 100 } }) as never,
    });

    expect(outcome).toMatchObject({ kind: "skipped", reason: "amount_out_of_range" });
    expect((outcome as { message: string }).message).toContain("100");
    expect(fetchInvoice).not.toHaveBeenCalled();
  });

  it("leaves a leg inside the bounds untouched, and reports no cap", async () => {
    const proofs = [proof("a", 64), proof("b", 32)];
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith(proofs));
    stubQuotes(2, [
      { amount: 94, feeReserve: 4 },
      { amount: 90, feeReserve: 4 },
    ]);

    const outcome = await cashOutFromMint({
      mintUrl: MINT,
      target: { kind: "all" },
      destination: DEST,
      fetchInvoice: vi.fn().mockResolvedValue("lnbc"),
      getWalletForMint: async () =>
        makeCashuWallet({ meltBounds: { min_amount: 1, max_amount: 1_000_000 } }) as never,
    });

    expect(outcome).toMatchObject({ kind: "sent", quote: { amount_sats: 90 } });
    expect(outcome).not.toHaveProperty("mint_max_sats");
  });

  it("stays unbounded when the wallet can't tell us — no refusal on a shape we don't recognise", async () => {
    const proofs = [proof("a", 64), proof("b", 32)];
    vi.mocked(loadAgentWallet).mockReturnValue(walletWith(proofs));
    stubQuotes(2, [
      { amount: 94, feeReserve: 4 },
      { amount: 90, feeReserve: 4 },
    ]);
    const noInfo = { ...makeCashuWallet(), getMintInfo: undefined };

    const outcome = await cashOutFromMint({
      mintUrl: MINT,
      target: { kind: "all" },
      destination: DEST,
      fetchInvoice: vi.fn().mockResolvedValue("lnbc"),
      getWalletForMint: async () => noInfo as never,
    });

    expect(outcome).toMatchObject({ kind: "sent" });
  });
});
