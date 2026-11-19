import { Amount, OutputData, type Wallet } from "@cashu/cashu-ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
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
vi.mock("node:readline", async (importOriginal) => {
  const readline = await importOriginal<typeof import("node:readline")>();
  return { ...readline, createInterface: vi.fn(readline.createInterface) };
});

let root: string;
let sdk: typeof import("@dvmkit/sdk/internal");
let walletFund: typeof import("../src/commands/wallet-agent-fund")["walletFund"];
let walletShow: typeof import("../src/commands/wallet-agent-fund")["walletShow"];
let walletForgetQuote: typeof import("../src/commands/wallet-forget-quote")["walletForgetQuote"];
let buildProgram: typeof import("../src/cli/dvm")["buildProgram"];
let originalConfigRoot: string | undefined;

function mint(expiry: number | null = Math.floor(Date.now() / 1000) + 3600) {
  const states = new Map<string, "UNPAID" | "PAID" | "ISSUED">();
  const wallet = {
    createLockedMintQuote: vi.fn(async () => {
      const quote = `quote-${states.size + 1}`;
      states.set(quote, "UNPAID");
      return { quote, request: states.size === 1 ? "lnbc10u1fakea" : "lnbc10u1fakeb", expiry, pubkey: PUBLIC_KEY, state: "UNPAID" };
    }),
    checkMintQuoteBolt11: vi.fn(async (quote: string) => ({
      quote, request: "lnbc10u1fake", expiry, state: states.get(quote) ?? "UNPAID",
    })),
    prepareMint: vi.fn(async (): Promise<{ keysetId: string; outputData: OutputData[] }> => ({ keysetId: "01ab", outputData: [] })),
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

  it("relays the invoice before polling and collects a payment observed on a later poll", async () => {
    const fixture = mint();
    const check = fixture.wallet.checkMintQuoteBolt11.getMockImplementation()!;
    fixture.wallet.checkMintQuoteBolt11.mockImplementationOnce(async (quote) => {
      expect(lastEvent()).toMatchObject({ status: "awaiting_payment", quote_id: quote, collection_state: "waiting" });
      expect(sdk.loadAgentWallet()?.pending_mints).toMatchObject([{ quote_id: quote }]);
      const unpaid = await check(quote);
      fixture.states.set(quote, "PAID");
      return unpaid;
    });

    await runFund(fundArgs("--collect-for", "10s"));

    expect(lastEvent()).toMatchObject({ status: "minted", quote_id: "quote-1", sats_minted: 1000 });
    expect(fixture.wallet.checkMintQuoteBolt11).toHaveBeenCalledTimes(2);
    expect(fixture.wallet.completeMint).toHaveBeenCalledTimes(1);
    expect(sdk.loadAgentWallet()).toMatchObject({ pending_mints: [], proofs: [{ amount: 1000 }] });
  });

  it("retries transient issuance with the original blinded outputs", async () => {
    const fixture = mint();
    const blindedMessage = { amount: Amount.from(1000), B_: `02${"a".repeat(64)}`, id: "01ab" };
    fixture.wallet.prepareMint.mockResolvedValueOnce({
      keysetId: "01ab", outputData: [new OutputData(blindedMessage, 5n, new TextEncoder().encode("saved-secret"))],
    });
    fixture.wallet.checkMintQuoteBolt11.mockImplementation(async (quote) => ({
      quote, request: "lnbc10u1fake", expiry: fixture.expiry, state: "PAID",
    }));
    fixture.wallet.completeMint.mockImplementationOnce(async () => {
      expect(sdk.loadAgentWallet()?.pending_mints[0].minting?.outputs[0].blinded_message.B_).toBe(blindedMessage.B_);
      throw Object.assign(new Error("Mint temporarily unavailable"), { name: "HttpResponseError", status: 503 });
    });

    await runFund(fundArgs("--collect-for", "10s"));

    expect(lastEvent()).toMatchObject({ status: "minted", quote_id: "quote-1", sats_minted: 1000 });
    expect(fixture.wallet.checkMintQuoteBolt11).toHaveBeenCalledTimes(2);
    expect(fixture.wallet.prepareMint).toHaveBeenNthCalledWith(2, "bolt11", 1000, expect.anything(),
      { privkey: PRIVATE_KEY, keysetId: "01ab" }, {
        type: "custom", data: [expect.objectContaining({ blindedMessage, blindingFactor: 5n })],
      });
    expect(fixture.wallet.completeMint).toHaveBeenCalledTimes(2);
    expect(sdk.loadAgentWallet()).toMatchObject({ pending_mints: [], proofs: [{ amount: 1000 }] });
  });

  it.each([
    { description: "before a strict mint expires", paymentLeadMs: 750, strictExpiry: true, expectedStates: ["UNPAID", "PAID"] },
    { description: "at expiry when the mint still issues", paymentLeadMs: 250, strictExpiry: false, expectedStates: ["UNPAID", "UNPAID", "PAID"] },
  ])("collects a payment from the last poll interval $description", async ({ paymentLeadMs, strictExpiry, expectedStates }) => {
    const realNow = Date.now;
    const expiry = Math.ceil(realNow() / 1000) + 1;
    const expiresAt = expiry * 1000;
    const initialPollAt = expiresAt - 1_500;
    const paidAt = expiresAt - paymentLeadMs;
    let firstPollStarted: number | undefined;
    vi.spyOn(Date, "now").mockImplementation(() => initialPollAt + (firstPollStarted === undefined ? 0 : realNow() - firstPollStarted));
    const fixture = mint(expiry);
    const observed: string[] = [];
    fixture.wallet.checkMintQuoteBolt11.mockImplementation(async (quote) => {
      firstPollStarted ??= realNow();
      const state = Date.now() < paidAt ? "UNPAID" : "PAID";
      observed.push(state);
      return { quote, request: "lnbc10u1fake", expiry, state };
    });
    const finish = fixture.wallet.completeMint.getMockImplementation()!;
    let issuanceAt: number | undefined;
    fixture.wallet.completeMint.mockImplementation(async () => {
      issuanceAt = Date.now();
      if (strictExpiry && issuanceAt >= expiresAt) throw mintError("quote is expired", 20007);
      return finish();
    });

    await runFund(fundArgs("--collect-for", "10s"));

    expect(lastEvent()).toMatchObject({ status: "minted", quote_id: "quote-1", sats_minted: 1000 });
    expect(observed).toEqual(expectedStates);
    if (!strictExpiry) expect(issuanceAt).toBeGreaterThanOrEqual(expiresAt);
    expect(sdk.loadAgentWallet()).toMatchObject({ pending_mints: [], proofs: [{ amount: 1000 }] });
  });

  it("keeps wallet show from replacing journaled outputs while issuance is in flight", async () => {
    const fixture = mint();
    const issuing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const complete = fixture.wallet.completeMint.getMockImplementation()!;
    fixture.wallet.checkMintQuoteBolt11.mockImplementation(async (quote) => ({
      quote, request: "lnbc10u1fake", expiry: fixture.expiry, state: "PAID",
    }));
    fixture.wallet.completeMint.mockImplementationOnce(async () => {
      issuing.resolve();
      await release.promise;
      return complete();
    });
    const collecting = runFund(fundArgs("--collect-for", "10s"));
    try {
      await Promise.race([issuing.promise, collecting.then(() => { throw new Error("Collection stopped before issuance"); })]);
      await walletShow({});
      expect(lastEvent()).toMatchObject({
        total_sats: 0,
        sweep: { unchecked: [{ quote_id: "quote-1" }] },
      });
      expect(fixture.wallet.prepareMint).toHaveBeenCalledTimes(1);
      expect(fixture.wallet.completeMint).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await collecting;
    }
    expect(sdk.loadAgentWallet()).toMatchObject({ pending_mints: [], proofs: [{ amount: 1000 }] });
  });

  it.each(["duration_elapsed", "quote_expired"])("hands back the original invoice after %s", async (reason) => {
    const fixture = mint(reason === "quote_expired" ? nowSec() - 1 : nowSec() + HOUR_SEC);

    await runFund(fundArgs("--collect-for", reason === "quote_expired" ? "1h" : "1s"));

    expect(lastEvent()).toMatchObject({
      status: "collection_stopped", collection_state: "needs_wallet_show", reason,
      quote_id: "quote-1", next_step: "dvm wallet show",
      collect_before: new Date(fixture.expiry! * 1000).toISOString(),
    });
    expect(fixture.wallet.checkMintQuoteBolt11).toHaveBeenCalledTimes(reason === "quote_expired" ? 0 : 1);
    expect(sdk.loadAgentWallet()).toMatchObject({ pending_mints: [{ quote_id: "quote-1" }], proofs: [] });
  });

  it.each([
    { opts: { collectFor: "5m" }, code: "invalid_fund_options" },
    { opts: { wait: false, collectFor: "0s" }, code: "invalid_arguments" },
    { opts: { wait: false, collectFor: "10" }, code: "invalid_arguments" },
    { opts: { wait: false, collectFor: "5m", rail: "x402" }, code: "invalid_flags_for_rail" },
  ])("rejects unsupported collection options before opening a quote: $opts", async ({ opts, code }) => {
    const fixture = mint();

    await expect(walletFund("1000", { float: false, ...opts })).rejects.toMatchObject({ code });

    expect(fixture.wallet.createLockedMintQuote).not.toHaveBeenCalled();
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

  it.each(["unpaid", "gone"] as const)("forgets a %s quote with no saved outputs on request", async (state) => {
    const fixture = mint(null);
    await runFund();
    if (state === "gone") {
      fixture.wallet.checkMintQuoteBolt11.mockRejectedValue(mintError("quote not found", 0));
    }

    await expect(walletForgetQuote("quote-1", {})).rejects.toMatchObject({ code: "confirmation_required" });
    await expect(walletForgetQuote("no-such-quote", { yes: true })).rejects.toMatchObject({ code: "mint_quote_not_found" });
    expect(sdk.loadAgentWallet()?.pending_mints).toHaveLength(1);

    await expect(
      buildProgram().parseAsync(["wallet", "forget-quote", "quote-1", "--yes"], { from: "user" })
    ).rejects.toMatchObject({ code: 0 });
    expect(lastEvent()).toMatchObject({ status: "forgotten", quote_id: "quote-1", mint_state: state, amount_sats: 1000 });
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

    fixture.wallet.checkMintQuoteBolt11.mockResolvedValue({ quote: "quote-1", request: "lnbc1", expiry: null, state: "SETTLING" as never });
    await expect(walletForgetQuote("quote-1", { yes: true })).rejects.toMatchObject({
      code: "mint_quote_unchecked", data: { cause: "unexpected", retryable: false },
    });
    expect(sdk.loadAgentWallet()?.pending_mints).toHaveLength(1);

    await walletForgetQuote("quote-1", { yes: true, force: true });
    expect(lastEvent()).toMatchObject({ status: "forgotten", mint_state: "unchecked" });
    expect(sdk.loadAgentWallet()?.pending_mints).toEqual([]);
  });

  it("keeps a quote paid during confirmation before issuance starts", async () => {
    const fixture = mint();
    const quoteId = "quote-1";
    await runFund();

    vi.spyOn(process, "stdin", "get").mockReturnValue(
      Object.create(process.stdin, { isTTY: { value: true } })
    );
    vi.mocked(createInterface).mockReturnValueOnce({
      close() {},
      question(_prompt: string, answer: (line: string) => void) {
        expect(fixture.wallet.checkMintQuoteBolt11).toHaveBeenCalledWith(quoteId);
        fixture.states.set(quoteId, "PAID");
        answer(quoteId);
      },
    } as Interface);

    await expect(walletForgetQuote(quoteId, { human: true })).rejects.toMatchObject({
      code: "mint_quote_collectable",
    });
    expect(sdk.loadAgentWallet()?.pending_mints).toMatchObject([{ quote_id: quoteId }]);
  });

  it.each([
    { situation: "issuance is in progress", replyLost: false, lookupError: undefined },
    { situation: "the mint reply was lost", replyLost: true, lookupError: undefined },
    { situation: "the quote expired after a lost reply", replyLost: true, lookupError: mintError("quote expired", 20007) },
    { situation: "the mint forgot the quote after a lost reply", replyLost: true, lookupError: mintError("quote not found", 0) },
  ])(
    "protects the paid quote after an unpaid forget prompt when $situation",
    async ({ replyLost, lookupError }) => {
      const fixture = mint();
      const quoteId = "quote-1";
      const polling = Promise.withResolvers<void>();
      const paid = Promise.withResolvers<void>();
      const prompted = Promise.withResolvers<(answer: string) => void>();
      const issuing = Promise.withResolvers<void>();
      const finishIssuance = Promise.withResolvers<void>();
      const blinded = { amount: Amount.from(1000), B_: `02${"a".repeat(64)}`, id: "01ab" };
      fixture.wallet.prepareMint.mockResolvedValueOnce({
        keysetId: "01ab",
        outputData: [new OutputData(blinded, 5n, new TextEncoder().encode("saved-secret"))],
      });
      const checkQuote = fixture.wallet.checkMintQuoteBolt11.getMockImplementation()!;
      fixture.wallet.checkMintQuoteBolt11.mockImplementationOnce(async (id) => {
        polling.resolve();
        await paid.promise;
        return checkQuote(id);
      });
      const finish = fixture.wallet.completeMint.getMockImplementation()!;
      fixture.wallet.completeMint.mockImplementationOnce(async () => {
        issuing.resolve();
        await finishIssuance.promise;
        if (replyLost) {
          fixture.states.set(quoteId, "ISSUED");
          throw Object.assign(new Error("Mint reply lost"), { name: "NetworkError" });
        }
        return finish();
      });
      vi.spyOn(process, "stdin", "get").mockReturnValue(
        Object.create(process.stdin, { isTTY: { value: true } })
      );
      vi.mocked(createInterface).mockReturnValueOnce({
        close() {},
        question(prompt: string, answer: (line: string) => void) {
          if (prompt.includes("a payment made to its invoice afterwards")) prompted.resolve(answer);
          else prompted.reject(new Error(`Expected an unpaid quote prompt, got: ${prompt}`));
        },
      } as Interface);

      const funding = walletFund("1000", {
        sats: true, mint: MINT, float: false, qrImage: join(root, "invoice.png"),
      }).then(() => undefined, (error: unknown) => error);
      let forgetting: Promise<unknown> | undefined;
      try {
        await Promise.race([
          polling.promise,
          funding.then((error) => { throw error ?? new Error("Funding ended before the quote was checked"); }),
        ]);
        forgetting = walletForgetQuote(quoteId, { human: true })
          .then(() => undefined, (error: unknown) => error);
        const confirm = await Promise.race([
          prompted.promise,
          forgetting.then((error) => { throw error ?? new Error("Forget ended before confirmation"); }),
        ]);
        fixture.states.set(quoteId, "PAID");
        paid.resolve();
        await Promise.race([
          issuing.promise,
          funding.then((error) => { throw error ?? new Error("Funding ended before issuance"); }),
        ]);
        if (replyLost) {
          finishIssuance.resolve();
          expect(await funding).toMatchObject({ code: "fund_mint_interrupted" });
        }
        if (lookupError) fixture.wallet.checkMintQuoteBolt11.mockRejectedValue(lookupError);
        confirm(quoteId);
        const forgetError = await forgetting;
        expect(sdk.loadAgentWallet()?.pending_mints[0]).toMatchObject({
          quote_id: quoteId,
          minting: { outputs: [{ blinded_message: { B_: blinded.B_ } }] },
        });
        expect(forgetError).toMatchObject({
          code: replyLost ? "mint_quote_collectable" : "mint_quote_busy",
        });
        if (!replyLost) {
          finishIssuance.resolve();
          expect(await funding).toBeUndefined();
          expect(sdk.loadAgentWallet()).toMatchObject({ pending_mints: [], proofs: [{ amount: 1000 }] });
        }
        if (lookupError) {
          await walletForgetQuote(quoteId, { yes: true, force: true });
          expect(lastEvent()).toMatchObject({ status: "forgotten", mint_state: "gone" });
          expect(sdk.loadAgentWallet()?.pending_mints).toEqual([]);
        }
      } finally {
        paid.resolve();
        finishIssuance.resolve();
        void prompted.promise.then((answer) => answer(quoteId), () => undefined);
        await funding;
        await forgetting;
      }
    }
  );

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
    expect(lastEvent()).toMatchObject({
      status: "minted", sats_minted: 1000, denominations: [8, 32, 64, 128, 256, 512],
    });
    expect(fixture.wallet.checkMintQuoteBolt11).toHaveBeenCalledExactlyOnceWith("quote-1");
    expect(sdk.loadAgentWallet()?.pending_mints).toEqual([]);
  });
});
