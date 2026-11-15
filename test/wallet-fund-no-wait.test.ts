import type { Wallet } from "@cashu/cashu-ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const MINT = "https://mint.invalid";
const PRIVATE_KEY = `${"0".repeat(63)}1`;
const PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const NWC_SECRET = "bb".repeat(32);
const NWC_URI = `nostr+walletconnect://${"aa".repeat(32)}?relay=wss://relay.invalid&secret=${NWC_SECRET}`;
const seams = vi.hoisted(() => ({ getWallet: vi.fn(), json: vi.fn(), info: vi.fn() }));

vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
  getWallet: seams.getWallet,
  checkMintHealth: vi.fn(async () => ({ ok: true, mintUrl: MINT, latencyMs: 0 })),
  fetchCoinGeckoSpot: vi.fn(async () => ({ btc_usd: 100_000, usdc_usd: 1, as_of: new Date().toISOString() })),
}));
vi.mock("../src/lib/output", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/output")>()),
  json: seams.json,
  info: seams.info,
}));

let root: string;
let sdk: typeof import("@dvmkit/sdk/internal");
let walletFund: typeof import("../src/commands/wallet-agent-fund")["walletFund"];
let walletShow: typeof import("../src/commands/wallet-agent-fund")["walletShow"];
let walletForgetQuote: typeof import("../src/commands/wallet-forget-quote")["walletForgetQuote"];
let buildProgram: typeof import("../src/cli/dvm")["buildProgram"];
let originalConfigRoot: string | undefined;

function mint(expiry: number | null = Math.floor(Date.now() / 1000) + 3600) {
  const states = new Map<string, "UNPAID" | "PAID">();
  const wallet = {
    createLockedMintQuote: vi.fn(async () => {
      const quote = `quote-${states.size + 1}`;
      states.set(quote, "UNPAID");
      return { quote, request: states.size === 1 ? "lnbc10u1fakea" : "lnbc10u1fakeb", expiry, pubkey: PUBLIC_KEY, state: "UNPAID" };
    }),
    checkMintQuoteBolt11: vi.fn(async (quote: string) => ({
      quote, request: "lnbc10u1fake", expiry, state: states.get(quote) ?? "UNPAID",
    })),
    prepareMint: vi.fn(async () => ({ keysetId: "01ab", outputData: [] })),
    completeMint: vi.fn(async () => [{ amount: 1000, secret: "proof-secret", C: `02${"c".repeat(64)}`, id: "01ab" }]),
    keyChain: { getKeysets: () => [] },
  };
  seams.getWallet.mockResolvedValue(wallet as unknown as Wallet);
  return { states, wallet, expiry };
}

class ExitSignal extends Error {
  constructor(readonly code: string | number | null | undefined) {
    super("process.exit");
  }
}

async function runFund(args = fundArgs()) {
  await expect(buildProgram().parseAsync(args, { from: "user" })).rejects.toMatchObject({ code: 0 });
}

function lastEvent() {
  return seams.json.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

const HOUR_SEC = 3600;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** Rewrite the stored quote, as time passing since the handoff would have. */
function agePendingQuote(patch: Record<string, unknown>) {
  const path = join(root, "wallet.json");
  const disk = JSON.parse(readFileSync(path, "utf8")) as { pending_mints: Record<string, unknown>[] };
  disk.pending_mints = disk.pending_mints.map((entry) => ({ ...entry, ...patch }));
  writeFileSync(path, JSON.stringify(disk));
}

function mintError(detail: string, code: number) {
  return Object.assign(new Error(detail), { name: "MintOperationError", status: 400, code });
}

function fundArgs(...extra: string[]) {
  return ["wallet", "fund", "1000", "--sats", "--no-float", "--no-wait", "--qr-image", join(root, "invoice.png"), ...extra];
}

describe("human-paid funding without waiting", () => {
  beforeAll(async () => {
    originalConfigRoot = process.env.DVM_CONFIG_DIR;
    root = mkdtempSync(join(tmpdir(), "dvm-fund-no-wait-"));
    process.env.DVM_CONFIG_DIR = root;
    vi.resetModules();
    sdk = await import("@dvmkit/sdk/internal");
    ({ walletFund, walletShow } = await import("../src/commands/wallet-agent-fund"));
    ({ walletForgetQuote } = await import("../src/commands/wallet-forget-quote"));
    ({ buildProgram } = await import("../src/cli/dvm"));
  });

  beforeEach(() => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "wallet.json"), JSON.stringify({
      version: sdk.WALLET_VERSION,
      lock_privkey: PRIVATE_KEY,
      lock_pubkey: PUBLIC_KEY,
      mnemonic_fingerprint: null,
      mints: [MINT],
      proofs: [],
      nut13_counters: {},
      pending_mints: [],
      pending_melts: [],
      pending_submissions: [],
      recent_spends: [],
      created_at: new Date().toISOString(),
    }));
    seams.json.mockReset();
    seams.info.mockReset();
    vi.spyOn(process, "exit").mockImplementation((code) => { throw new ExitSignal(code); });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    if (originalConfigRoot === undefined) delete process.env.DVM_CONFIG_DIR;
    else process.env.DVM_CONFIG_DIR = originalConfigRoot;
  });

  it.each([false, true])("persists before output and never polls in human=%s mode", async (human) => {
    const fixture = mint();
    let persistedWhenEmitted = false;
    const output = human ? seams.info : seams.json;
    output.mockImplementation((event: unknown) => {
      if (human ? event === "lnbc10u1fakea" : (event as { status?: string }).status === "awaiting_payment") {
        const disk = JSON.parse(readFileSync(join(root, "wallet.json"), "utf8")) as { pending_mints: unknown[] };
        persistedWhenEmitted = disk.pending_mints.length === 1;
      }
    });
    writeFileSync(join(root, "config.json"), JSON.stringify({ nwcUri: NWC_URI }));

    await runFund(fundArgs(...(human ? ["--human"] : [])));

    expect(persistedWhenEmitted).toBe(true);
    expect(fixture.wallet.checkMintQuoteBolt11).not.toHaveBeenCalled();
    expect(fixture.wallet.prepareMint).not.toHaveBeenCalled();
    expect(sdk.loadAgentWallet()).toMatchObject({
      proofs: [],
      pending_mints: [{ quote_id: "quote-1", mint: MINT, amount_sats: 1000, expires_at: fixture.expiry }],
    });
    expect(existsSync(join(root, "invoice.png"))).toBe(true);
    if (human) {
      const text = seams.info.mock.calls.flat().join("\n");
      expect(text).toContain("Quote ID: quote-1");
      expect(text).toContain("dvm wallet show");
      expect(text).toContain(`Collect before ${new Date(fixture.expiry! * 1000).toISOString()}`);
      expect(text).not.toContain("Polling");
    } else {
      expect(lastEvent()).toMatchObject({
        status: "awaiting_payment", invoice: "lnbc10u1fakea", quote_id: "quote-1", next_step: "dvm wallet show",
        expires_at: new Date(fixture.expiry! * 1000).toISOString(),
        collect_before: new Date(fixture.expiry! * 1000).toISOString(),
        hint: expect.stringContaining(`Collect before ${new Date(fixture.expiry! * 1000).toISOString()}`),
        relay: { copy_text: "lnbc10u1fakea", standalone: true },
      });
    }
    const allOutput = JSON.stringify([...seams.info.mock.calls, ...seams.json.mock.calls]);
    for (const secret of [PRIVATE_KEY, NWC_SECRET, NWC_URI]) expect(allOutput).not.toContain(secret);
  });

  it("emits null expiry for a mint that supplies none", async () => {
    mint(null);
    await runFund();
    expect(lastEvent()).toMatchObject({ expires_at: null, collect_before: null, quote_id: "quote-1" });
    expect(sdk.loadAgentWallet()?.pending_mints[0]).not.toHaveProperty("expires_at");
  });

  it.each([false, true])("creates a second quote and names the earlier unpaid one in human=%s output", async (human) => {
    const fixture = mint();
    await runFund();
    await runFund(fundArgs(...(human ? ["--human"] : [])));
    expect(sdk.loadAgentWallet()?.pending_mints.map((entry) => entry.quote_id)).toEqual(["quote-1", "quote-2"]);
    expect(fixture.wallet.createLockedMintQuote).toHaveBeenCalledTimes(2);
    expect(fixture.wallet.checkMintQuoteBolt11).toHaveBeenCalledExactlyOnceWith("quote-1");
    if (human) {
      expect(seams.info.mock.calls.flat().join("\n")).toContain("An unpaid quote already exists: quote-1");
    } else {
      expect(lastEvent()).toMatchObject({
        quote_id: "quote-2",
        warning: expect.stringContaining("An unpaid quote already exists: quote-1"),
        existing_unpaid_quotes: [{ quote_id: "quote-1", mint: MINT, amount_sats: 1000 }],
      });
    }
  });

  it("reports unpaid, collects paid funds once, and shows the new balance", async () => {
    const fixture = mint();
    await runFund();
    await walletShow({});
    expect(lastEvent()).toMatchObject({
      total_sats: 0,
      sweep: { pending: [{ quote_id: "quote-1", display: expect.stringContaining("not paid yet") }], collected: [] },
    });
    expect(fixture.wallet.completeMint).not.toHaveBeenCalled();
    expect(sdk.loadAgentWallet()?.pending_mints).toHaveLength(1);

    fixture.states.set("quote-1", "PAID");
    await walletShow({});
    expect(lastEvent()).toMatchObject({
      total_sats: 1000,
      pending_mints: [],
      sweep: { pending: [], collected: [{ quote_id: "quote-1", sats_collected: 1000, display: expect.stringContaining("paid and collected") }] },
    });
    expect(sdk.loadAgentWallet()?.proofs.map((proof) => proof.amount)).toEqual([1000]);
    await walletShow({});
    expect(lastEvent()).toMatchObject({ total_sats: 1000, sweep: { collected: [] } });
    expect(fixture.wallet.completeMint).toHaveBeenCalledTimes(1);
  });

  it("names unpaid and collected quotes alongside the balance in human mode", async () => {
    const fixture = mint();
    await runFund();
    await walletShow({ human: true });
    expect(seams.info.mock.calls.flat().join("\n")).toMatch(/quote quote-1.*not paid yet/);

    fixture.states.set("quote-1", "PAID");
    seams.info.mockClear();
    await walletShow({ human: true });
    const text = seams.info.mock.calls.flat().join("\n");
    expect(text).toContain("Mint quote quote-1 was paid and collected.");
    expect(text).toMatch(/Cashu agent wallet:.*1000 sats/);
  });

  it("keeps an unpaid quote past its expiry, lists it, and collects a late payment", async () => {
    const fixture = mint(nowSec() - 1);
    await runFund();
    await walletShow({});
    const expiredAt = new Date(fixture.expiry! * 1000).toISOString();
    expect(lastEvent()).toMatchObject({
      total_sats: 0,
      pending_mints: [{ quote_id: "quote-1" }],
      sweep: {
        pending: [], collected: [], expired: [], dropped: [],
        kept_past_expiry: [{
          quote_id: "quote-1", mint: MINT, amount_sats: 1000, expired_at: expiredAt,
          drop_after: new Date((fixture.expiry! + 24 * HOUR_SEC) * 1000).toISOString(),
          hint: expect.stringContaining("dvm wallet forget-quote quote-1"),
        }],
      },
      hint: expect.stringContaining("sweep.kept_past_expiry"),
    });
    expect(sdk.loadAgentWallet()?.pending_mints).toHaveLength(1);

    fixture.states.set("quote-1", "PAID");
    await walletShow({});
    expect(lastEvent()).toMatchObject({
      total_sats: 1000, pending_mints: [],
      sweep: { kept_past_expiry: [], collected: [{ quote_id: "quote-1", sats_collected: 1000 }] },
    });
    expect(sdk.loadAgentWallet()?.proofs.map((proof) => proof.amount)).toEqual([1000]);
  });

  it("says in human mode that a quote past its expiry is still checked", async () => {
    mint(nowSec() - 1);
    await runFund();
    seams.info.mockClear();
    await walletShow({ human: true });
    const text = seams.info.mock.calls.flat().join("\n");
    expect(text).toMatch(/quote quote-1[^\n]*\n[^\n]*expired unpaid[^\n]*checked for a late payment/);
    expect(text).not.toContain("awaiting payment");
  });

  it("removes an unpaid quote the mint still reports unpaid a day after it expired", async () => {
    const fixture = mint();
    await runFund();
    agePendingQuote({ expires_at: nowSec() - 24 * HOUR_SEC - 60 });
    await walletShow({});
    expect(lastEvent()).toMatchObject({
      total_sats: 0, pending_mints: [],
      sweep: {
        pending: [], collected: [], kept_past_expiry: [], dropped: ["quote-1"],
        expired: [{ quote_id: "quote-1", amount_sats: 1000, mint: MINT, reason: "grace_elapsed" }],
      },
    });
    expect(sdk.loadAgentWallet()?.pending_mints).toEqual([]);
    expect(fixture.wallet.checkMintQuoteBolt11).toHaveBeenCalledExactlyOnceWith("quote-1");
    expect(fixture.wallet.completeMint).not.toHaveBeenCalled();
  });

  it("removes an unpaid quote the mint no longer knows", async () => {
    const fixture = mint();
    await runFund();
    fixture.wallet.checkMintQuoteBolt11.mockRejectedValue(mintError("quote not found", 0));
    await walletShow({});
    expect(lastEvent()).toMatchObject({
      pending_mints: [],
      sweep: { expired: [{ quote_id: "quote-1", reason: "mint_unknown" }], unchecked: [] },
    });
    expect(sdk.loadAgentWallet()?.pending_mints).toEqual([]);
  });

  it("collects a quote with no expiry that is paid 11 minutes after the request", async () => {
    const fixture = mint(null);
    await runFund();
    agePendingQuote({ requested_at: new Date(Date.now() - 11 * 60 * 1000).toISOString() });

    await walletShow({});
    const [pending] = (lastEvent().sweep as { pending: Record<string, unknown>[] }).pending;
    expect(pending).toMatchObject({
      quote_id: "quote-1", expires_at: null,
      display: expect.stringContaining("dvm wallet forget-quote quote-1"),
    });
    expect(pending.age_seconds).toBeGreaterThanOrEqual(660);
    expect(sdk.loadAgentWallet()?.pending_mints).toHaveLength(1);

    fixture.states.set("quote-1", "PAID");
    await walletShow({});
    expect(lastEvent()).toMatchObject({
      total_sats: 1000, pending_mints: [],
      sweep: { collected: [{ quote_id: "quote-1", sats_collected: 1000 }] },
    });
  });

  it("reports a paid quote the mint refuses to issue after expiry, and keeps it", async () => {
    const fixture = mint(nowSec() - 60);
    await runFund();
    fixture.states.set("quote-1", "PAID");
    fixture.wallet.completeMint.mockRejectedValue(mintError("quote is expired", 20007));

    await walletShow({});
    expect(lastEvent()).toMatchObject({
      total_sats: 0,
      pending_mints: [{ quote_id: "quote-1" }],
      sweep: {
        collected: [], expired: [], unchecked: [], kept_past_expiry: [],
        paid_uncollected: [{
          quote_id: "quote-1", mint: MINT, amount_sats: 1000, reason: "quote_expired",
          display: expect.stringContaining("was paid"),
        }],
      },
      hint: expect.stringContaining("sweep.paid_uncollected"),
    });
    expect(sdk.loadAgentWallet()?.pending_mints.map((entry) => entry.quote_id)).toEqual(["quote-1"]);
  });

  it("forgets an unpaid quote on request, and only then", async () => {
    mint(null);
    await runFund();

    await expect(walletForgetQuote("quote-1", {})).rejects.toMatchObject({ code: "confirmation_required" });
    await expect(walletForgetQuote("no-such-quote", { yes: true })).rejects.toMatchObject({ code: "mint_quote_not_found" });
    expect(sdk.loadAgentWallet()?.pending_mints).toHaveLength(1);

    await expect(
      buildProgram().parseAsync(["wallet", "forget-quote", "quote-1", "--yes"], { from: "user" })
    ).rejects.toMatchObject({ code: 0 });
    expect(lastEvent()).toMatchObject({ status: "forgotten", quote_id: "quote-1", mint_state: "unpaid", amount_sats: 1000 });
    expect(sdk.loadAgentWallet()?.pending_mints).toEqual([]);
  });

  it("refuses to forget a paid or unchecked quote without --force", async () => {
    const fixture = mint();
    await runFund();

    fixture.states.set("quote-1", "PAID");
    await expect(walletForgetQuote("quote-1", { yes: true })).rejects.toMatchObject({ code: "mint_quote_collectable" });

    fixture.wallet.checkMintQuoteBolt11.mockRejectedValue(
      Object.assign(new Error("mint failed"), { name: "HttpResponseError", status: 503 })
    );
    await expect(walletForgetQuote("quote-1", { yes: true })).rejects.toMatchObject({
      code: "mint_quote_unchecked", data: { cause: "mint_server_error", retryable: true },
    });
    expect(sdk.loadAgentWallet()?.pending_mints).toHaveLength(1);

    fixture.wallet.checkMintQuoteBolt11.mockResolvedValue({ quote: "quote-1", state: "SETTLING" as never });
    await expect(walletForgetQuote("quote-1", { yes: true })).rejects.toMatchObject({
      code: "mint_quote_unchecked", data: { cause: "unexpected", retryable: false },
    });
    expect(sdk.loadAgentWallet()?.pending_mints).toHaveLength(1);

    await walletForgetQuote("quote-1", { yes: true, force: true });
    expect(lastEvent()).toMatchObject({ status: "forgotten", mint_state: "unchecked" });
    expect(sdk.loadAgentWallet()?.pending_mints).toEqual([]);
  });

  it.each([
    { opts: { testSkipLightning: true }, connected: false, code: "invalid_fund_options" },
    { opts: {}, connected: true, code: "invalid_fund_options" },
    { opts: { rail: "tempo" }, connected: false, code: "invalid_flags_for_rail" },
    { opts: { rail: "x402" }, connected: false, code: "invalid_flags_for_rail" },
  ])("refuses incompatible options before a quote is created: $opts $connected", async ({ opts, connected, code }) => {
    const fixture = mint();
    if (connected) writeFileSync(join(root, "config.json"), JSON.stringify({ nwcUri: NWC_URI }));
    await expect(walletFund("1000", { wait: false, ...opts })).rejects.toMatchObject({ code });
    expect(fixture.wallet.createLockedMintQuote).not.toHaveBeenCalled();
    expect(sdk.loadAgentWallet()?.pending_mints).toEqual([]);
  });

  it("still waits and collects when --no-wait is omitted", async () => {
    const fixture = mint();
    fixture.wallet.checkMintQuoteBolt11.mockImplementation(async (quote) => ({
      quote, request: "lnbc10u1fake", expiry: fixture.expiry, state: "PAID",
    }));
    await runFund(fundArgs().filter((arg) => arg !== "--no-wait"));
    expect(lastEvent()).toMatchObject({ status: "minted", sats_minted: 1000 });
    expect(fixture.wallet.checkMintQuoteBolt11).toHaveBeenCalledExactlyOnceWith("quote-1");
    expect(sdk.loadAgentWallet()?.pending_mints).toEqual([]);
  });
});
