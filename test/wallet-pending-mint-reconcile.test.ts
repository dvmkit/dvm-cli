import type { Wallet } from "@cashu/cashu-ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const MINT = "https://mint.invalid";
/** What the mint says for itself. It must never reach the CLI's output. */
const MINT_PROSE = "429 Too Many Requests — slow down, you are hammering this mint";

const seams = vi.hoisted(() => ({
  info: vi.fn(),
  json: vi.fn(),
  getWallet: vi.fn(),
}));

// Output and the mint are the only seams: the sweep, the classification and the
// wallet file all run the shipped SDK against an isolated config dir.
vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
getWallet: seams.getWallet }));
vi.mock("../src/lib/output", async () => ({ ...(await vi.importActual<typeof import("../src/lib/output")>("../src/lib/output")), info: seams.info,
json: seams.json }));

function httpError(name: string, status: number, retryAfterMs?: number): Error {
  return Object.assign(new Error(MINT_PROSE), { name, status, retryAfterMs });
}

function fakeMint(pollError: () => Error) {
  const state = { paid: false };
  const quote = { quote: "quote-1", request: "lnbc10n1fake", expiry: null };
  const wallet = {
    checkMintQuoteBolt11: vi.fn(async () => {
      if (!state.paid) throw pollError();
      return { ...quote, state: "PAID" };
    }),
    prepareMint: vi.fn(async () => ({ keysetId: "01ab", outputData: [] })),
    completeMint: vi.fn(async () => [
      { amount: 1000, secret: "s", C: `02${"c".repeat(64)}`, id: "01ab" },
    ]),
    keyChain: { getKeysets: () => [] },
  };
  return { state, wallet: wallet as unknown as Wallet };
}

function fakeClock() {
  const clock = { now: 0, sleeps: [] as number[] };
  return {
    clock,
    now: () => clock.now,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.now += ms;
    },
  };
}

let configRoot: string;
let originalConfigRoot: string | undefined;
let sdk: typeof import("@dvmkit/sdk/internal");
let walletShow: (typeof import("../src/commands/wallet-agent-fund"))["walletShow"];
let reconcilePendingMints: (typeof import("../src/lib/wallet-agent/mint-sweep"))["reconcilePendingMints"];

function pendingMint(quoteId: string, minting?: Record<string, unknown>) {
  return {
    mint: MINT,
    quote_id: quoteId,
    amount_sats: 1000,
    requested_at: new Date().toISOString(),
    ...(minting ? { minting } : {}),
  };
}

function writeWalletWithPendingMints(pending: Record<string, unknown>[]): void {
  rmSync(configRoot, { recursive: true, force: true });
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(
    join(configRoot, "wallet.json"),
    JSON.stringify({
      version: sdk.WALLET_VERSION,
      lock_privkey: `${"0".repeat(63)}1`,
      lock_pubkey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      mnemonic_fingerprint: null,
      mints: [MINT],
      proofs: [],
      nut13_counters: {},
      pending_mints: pending,
      pending_melts: [],
      pending_submissions: [],
      recent_spends: [],
      created_at: new Date().toISOString(),
    })
  );
}

function writeWalletWithPendingMint(minting?: Record<string, unknown>): void {
  writeWalletWithPendingMints([pendingMint("quote-1", minting)]);
}

describe("pending-mint reconcile against a mint that won't answer", () => {
  beforeAll(async () => {
    configRoot = mkdtempSync(join(tmpdir(), "dvm-cli-mint-reconcile-"));
    originalConfigRoot = process.env.DVM_CONFIG_DIR;
    process.env.DVM_CONFIG_DIR = configRoot;
    vi.resetModules();
    sdk = await import("@dvmkit/sdk/internal");
    ({ walletShow } = await import("../src/commands/wallet-agent-fund"));
    ({ reconcilePendingMints } = await import("../src/lib/wallet-agent/mint-sweep"));
  });

  beforeEach(() => {
    writeWalletWithPendingMint();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    rmSync(configRoot, { recursive: true, force: true });
    if (originalConfigRoot === undefined) delete process.env.DVM_CONFIG_DIR;
    else process.env.DVM_CONFIG_DIR = originalConfigRoot;
  });

  it("mints the invoice on the next reconcile once the mint answers again", async () => {
    const mint = fakeMint(() => httpError("RateLimitError", 429, 5_000));
    const getWalletForMint = async () => mint.wallet;

    const { clock, now, sleep } = fakeClock();
    const sweep = await reconcilePendingMints({ getWalletForMint, now, sleep });

    expect(clock.sleeps).toEqual([5_000, 5_000]);
    expect(mint.wallet.checkMintQuoteBolt11).toHaveBeenCalledTimes(2);
    expect(sweep.unchecked).toHaveLength(1);
    expect(sweep.unchecked[0]).toMatchObject({
      quote_id: "quote-1",
      mint: MINT,
      amount_sats: 1000,
      cause: "rate_limited",
      retryable: true,
      pending: true,
      retry_after_ms: 5_000,
      // The real class, not the minified constructor name: cashu-ts sets
      // `name` on its error classes and the fingerprint prefers it.
      error_name: "RateLimitError",
      next_action: {
        type: "run_command",
        command: "dvm wallet show",
        retry_after_ms: 5_000,
      },
    });
    // Nothing the mint wrote is republished — only the bounded fingerprint.
    expect(JSON.stringify(sweep.unchecked)).not.toContain(MINT_PROSE);
    expect(sweep.recovered_proofs).toEqual([]);
    expect(sdk.loadAgentWallet()?.pending_mints.map((p) => p.quote_id)).toEqual(["quote-1"]);

    mint.state.paid = true;
    const after = await reconcilePendingMints({ getWalletForMint });

    expect(after.unchecked).toEqual([]);
    expect(after.recovered_proofs.map((p) => p.amount)).toEqual([1000]);
    const wallet = sdk.loadAgentWallet();
    expect(wallet?.pending_mints).toEqual([]);
    expect(wallet?.proofs.map((p) => p.amount)).toEqual([1000]);
  });

  it("names a mint failure and an unreachable mint as retryable, and a refusal as neither", async () => {
    const cases = [
      { err: httpError("HttpResponseError", 503), cause: "mint_server_error", retryable: true },
      {
        err: Object.assign(new Error(MINT_PROSE), { name: "NetworkError" }),
        cause: "mint_unreachable",
        retryable: true,
      },
      { err: httpError("MintOperationError", 400), cause: "unexpected", retryable: false },
    ];

    for (const { err, cause, retryable } of cases) {
      writeWalletWithPendingMint();
      const mint = fakeMint(() => err);
      const sweep = await reconcilePendingMints({
        getWalletForMint: async () => mint.wallet,
        quoteRetryTimeoutMs: 0,
      });

      expect(sweep.unchecked[0]).toMatchObject({ cause, retryable, pending: true });
      // A refusal is not going to resolve itself, so no wait is suggested; a
      // transient failure that named none gets this CLI's default.
      expect(sweep.unchecked[0].retry_after_ms).toBe(retryable ? 30_000 : undefined);
      expect(JSON.stringify(sweep.unchecked)).not.toContain(MINT_PROSE);
      expect(sdk.loadAgentWallet()?.pending_mints).toHaveLength(1);
    }
  });

  it("reports a mint that never loaded as unreachable, not as an unexpected error", async () => {
    // A mint that doesn't answer at all fails before cashu-ts's own error
    // classes are in play — the SDK's `getWallet` refuses with its own code.
    const unreachable = new sdk.DvmError(
      "cashu_mint_unreachable",
      `Cannot connect to mint: ${MINT}`,
      "The mint is not responding. Try again later."
    );

    const sweep = await reconcilePendingMints({
      getWalletForMint: () => Promise.reject(unreachable),
      quoteRetryTimeoutMs: 0,
    });

    expect(sweep.unchecked[0]).toMatchObject({
      cause: "mint_unreachable",
      retryable: true,
      retry_after_ms: 30_000,
    });
    expect(sdk.loadAgentWallet()?.pending_mints).toHaveLength(1);
  });

  it("keeps wallet lookup failures attached to each same-mint quote", async () => {
    writeWalletWithPendingMints([pendingMint("quote-1"), pendingMint("quote-2")]);
    const { clock, now, sleep } = fakeClock();
    const getWalletForMint = vi.fn(async () => {
      if (clock.now < 4_000) throw httpError("HttpResponseError", 503);
      throw httpError("RateLimitError", 429, 5_000);
    });

    const sweep = await reconcilePendingMints({
      getWalletForMint,
      quoteRetryTimeoutMs: 4_000,
      now,
      sleep,
    });

    expect(clock.sleeps).toEqual([2_000, 2_000, 4_000]);
    expect(getWalletForMint).toHaveBeenCalledTimes(3);
    expect(sweep.unchecked).toMatchObject([
      { quote_id: "quote-1", cause: "mint_server_error", pending: true },
      { quote_id: "quote-2", cause: "rate_limited", retry_after_ms: 5_000, pending: true },
    ]);
    expect(JSON.stringify(sweep.unchecked)).not.toContain(MINT_PROSE);
    expect(sdk.loadAgentWallet()?.pending_mints.map((entry) => entry.quote_id)).toEqual([
      "quote-1",
      "quote-2",
    ]);
  });

  it("clamps a mint-supplied wait that would park an agent for a day", async () => {
    const mint = fakeMint(() => httpError("RateLimitError", 429, 86_400_000));

    const sweep = await reconcilePendingMints({
      getWalletForMint: async () => mint.wallet,
      quoteRetryTimeoutMs: 0,
    });

    expect(sweep.unchecked[0].retry_after_ms).toBe(300_000);
  });

  it("classifies a failure the mint throws from a nested member, not just from the wallet", async () => {
    // The ISSUED + minting recovery path reaches the mint through
    // `wallet.mint.restore`, which a flat proxy over the wallet would miss —
    // it would land as `unexpected` with no wait.
    writeWalletWithPendingMint({ keyset_id: "01ab", outputs: [] });
    const wallet = {
      checkMintQuoteBolt11: vi.fn(async () => ({ quote: "quote-1", state: "ISSUED" })),
      keyChain: { getKeyset: () => ({ id: "01ab", unit: "sat", keys: {} }) },
      mint: { restore: vi.fn(() => Promise.reject(httpError("RateLimitError", 429, 7_000))) },
    } as unknown as Wallet;

    const sweep = await reconcilePendingMints({
      getWalletForMint: async () => wallet,
      quoteRetryTimeoutMs: 0,
    });

    expect(sweep.unchecked[0]).toMatchObject({
      cause: "rate_limited",
      retryable: true,
      retry_after_ms: 7_000,
      error_name: "RateLimitError",
    });
    expect(sdk.loadAgentWallet()?.pending_mints).toHaveLength(1);
  });

  it("keeps one entry's failure from being reported as another's", async () => {
    // Not every failure the sweep reports came from the mint: the PAID branch
    // also fails on its own work, here on a proof this CLI can't record. That
    // throw never crosses the wallet, so the entry has no observed error — and
    // a single queue per mint would hand it the *next* entry's 429 and leave
    // that entry with no cause and no wait at all.
    writeWalletWithPendingMints([pendingMint("quote-1"), pendingMint("quote-2")]);
    let firstQuoteAttempts = 0;
    const wallet = {
      checkMintQuoteBolt11: vi.fn(async (quoteId: string) => {
        if (quoteId !== "quote-1") throw httpError("RateLimitError", 429, 5_000);
        if (firstQuoteAttempts++ === 0) throw httpError("HttpResponseError", 503);
        return { quote: quoteId, request: "lnbc10n1fake", expiry: null, state: "PAID" };
      }),
      prepareMint: vi.fn(async () => ({ keysetId: "01ab", outputData: [] })),
      // A fractional amount is not a Cashu denomination, so the SDK throws
      // while converting the proof for disk — after the mint answered.
      completeMint: vi.fn(async () => [
        { amount: 1.5, secret: "s", C: `02${"c".repeat(64)}`, id: "01ab" },
      ]),
      keyChain: { getKeysets: () => [] },
    } as unknown as Wallet;
    const { clock, now, sleep } = fakeClock();

    const sweep = await reconcilePendingMints({
      getWalletForMint: async () => wallet,
      now,
      sleep,
    });

    expect(clock.sleeps).toEqual([2_000, 5_000, 5_000]);
    const byQuote = new Map(sweep.unchecked.map((u) => [u.quote_id, u]));
    expect([...byQuote.keys()].sort()).toEqual(["quote-1", "quote-2"]);
    expect(byQuote.get("quote-1")).toMatchObject({ cause: "unexpected", retryable: false });
    expect(byQuote.get("quote-1")?.retry_after_ms).toBeUndefined();
    expect(byQuote.get("quote-2")).toMatchObject({
      cause: "rate_limited",
      retryable: true,
      retry_after_ms: 5_000,
      error_name: "RateLimitError",
    });
    expect(JSON.stringify(sweep.unchecked)).not.toContain(MINT_PROSE);
  });

  it("publishes the classified block from `dvm wallet show`, and no mint prose", async () => {
    const mint = fakeMint(() => httpError("RateLimitError", 429, 5_000));
    seams.getWallet.mockResolvedValue(mint.wallet);
    seams.json.mockClear();
    vi.useFakeTimers();

    const show = walletShow({});
    await vi.runAllTimersAsync();
    await show;

    const [event] = seams.json.mock.calls.at(-1) as [Record<string, unknown>];
    expect(event).toMatchObject({
      status: "ok",
      sweep: {
        unchecked: [
          {
            quote_id: "quote-1",
            cause: "rate_limited",
            retryable: true,
            pending: true,
            retry_after_ms: 5_000,
          },
        ],
      },
      hint: expect.stringContaining("sweep.unchecked") as unknown as string,
    });
    expect(event.sweep).not.toHaveProperty("errors");
    expect(JSON.stringify(event)).not.toContain(MINT_PROSE);
    expect(event.pending_mints).toMatchObject([{ quote_id: "quote-1" }]);
  });

  it("separates expired quotes from already-issued quotes in wallet show JSON", async () => {
    prepareExpiredQuotes();
    seams.json.mockClear();

    await walletShow({});

    const [event] = seams.json.mock.calls.at(-1) as [Record<string, unknown>];
    expect(event).toMatchObject({
      status: "ok",
      pending_mints: [],
      sweep: {
        expired: [{ quote_id: "expired-quote", mint: MINT, amount_sats: 1_200 }],
        dropped: ["expired-quote", "issued-quote"],
      },
    });
  });

  it("reports each expired unpaid quote and its removed recovery entry in human mode", async () => {
    prepareExpiredQuotes();
    seams.info.mockClear();

    await walletShow({ human: true });

    const lines = seams.info.mock.calls.map(([line]) => String(line));
    const expired = lines.find((line) => line.includes("Unpaid mint quote expired"));
    expect(expired).toContain("1200 sats");
    expect(expired).toContain(MINT);
    expect(expired).toContain("quote ID expired-quote");
    expect(expired).toContain("local recovery entry removed");
    expect(lines.join("\n")).not.toContain("issued-quote");
  });

  it("says why a pending mint could not be checked in human mode", async () => {
    const mint = fakeMint(() => httpError("RateLimitError", 429, 5_000));
    seams.getWallet.mockResolvedValue(mint.wallet);
    seams.info.mockClear();
    vi.useFakeTimers();

    const show = walletShow({ human: true });
    await vi.runAllTimersAsync();
    await show;

    const lines = seams.info.mock.calls.map(([line]) => String(line));
    expect(lines.some((l) => l.includes("could not be checked") && l.includes("too frequent"))).toBe(
      true
    );
    expect(lines.some((l) => l.includes("Wait 5s and try again"))).toBe(true);
    // And the pending row must not claim the invoice is awaiting payment —
    // that is exactly what the mint declined to confirm.
    const row = lines.find((l) => l.includes("quote quote-1"));
    expect(row).toContain("not checked on this call");
    expect(row).not.toContain("awaiting payment");
    expect(lines.join("\n")).not.toContain(MINT_PROSE);
  });
});

function prepareExpiredQuotes(): void {
  writeWalletWithPendingMints([
    {
      ...pendingMint("expired-quote"),
      amount_sats: 1_200,
      requested_at: new Date(0).toISOString(),
    },
    { ...pendingMint("issued-quote"), amount_sats: 300 },
  ]);
  const wallet = {
    checkMintQuoteBolt11: vi.fn(async (quoteId: string) => ({
      quote: quoteId,
      request: "lnbc10n1fake",
      expiry: null,
      state: quoteId === "issued-quote" ? "ISSUED" : "UNPAID",
    })),
    keyChain: { getKeysets: () => [] },
  } as unknown as Wallet;
  seams.getWallet.mockResolvedValue(wallet);
}
