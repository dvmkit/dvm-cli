import type { Wallet } from "@cashu/cashu-ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const MINT = "https://mint.invalid";
const MINT_PROSE = "429 Too Many Requests — this message belongs to the mint";

const seams = vi.hoisted(() => ({
  info: vi.fn(),
  json: vi.fn(),
  getWallet: vi.fn(),
  fundAgentWallet: vi.fn(async () => ({
    proofs: [],
    denominations: [],
    quote_id: "new-fund",
  })),
}));

vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
getWallet: seams.getWallet }));
vi.mock("../src/lib/output", async () => ({ ...(await vi.importActual<typeof import("../src/lib/output")>("../src/lib/output")), info: seams.info,
json: seams.json }));
vi.mock("../src/lib/wallet-agent/fund", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/wallet-agent/fund")>()), fundAgentWallet: seams.fundAgentWallet }));
vi.mock("../src/lib/wallet-agent/mint-selection", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/wallet-agent/mint-selection")>()), resolveFundMint: vi.fn(async () => ({
    url: MINT,
    preferredProbe: { mintAmountBounds: null },
  })) }));

function rateLimit(): Error {
  return Object.assign(new Error(MINT_PROSE), {
    name: "RateLimitError",
    status: 429,
    retryAfterMs: 5_000,
  });
}

function fakeMint() {
  const state: { outcome: "rate_limited" | "PAID" } = { outcome: "rate_limited" };
  const wallet = {
    checkMeltQuoteBolt11: vi.fn(async () => {
      if (state.outcome === "rate_limited") throw rateLimit();
      return { quote: "melt-1", state: "PAID" };
    }),
    keyChain: {
      getKeysets: vi.fn(() => []),
      getKeyset: vi.fn(() => ({ id: "01ab", unit: "sat", keys: {} })),
    },
    mint: {
      restore: vi.fn(async () => ({ outputs: [], signatures: [] })),
    },
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
let walletFund: (typeof import("../src/commands/wallet-agent-fund"))["walletFund"];
let walletShow: (typeof import("../src/commands/wallet-agent-fund"))["walletShow"];
let reconcilePendingMelts: (typeof import("../src/lib/wallet-agent/melt-sweep"))["reconcilePendingMelts"];

function writeWalletWithPendingMelt(): void {
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
      proofs: [
        {
          mint: MINT,
          id: "01ab",
          amount: 64,
          secret: "melt-input",
          C: `02${"c".repeat(64)}`,
          locked_to_pubkey:
            "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
          status: "in_flight",
          in_flight_until_ms: Date.now() + 600_000,
        },
      ],
      nut13_counters: {},
      pending_mints: [],
      pending_melts: [
        {
          mint: MINT,
          quote_id: "melt-1",
          bolt11: "lnbc60fake",
          destination: "operator@example.com",
          amount_sats: 60,
          fee_reserve_sats: 2,
          input_fee_sats: 2,
          input_proofs: [
            {
              mint: MINT,
              id: "01ab",
              amount: 64,
              secret: "melt-input",
              C: `02${"c".repeat(64)}`,
              locked_to_pubkey:
                "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
              status: "in_flight",
              in_flight_until_ms: Date.now() + 600_000,
            },
          ],
          created_at: new Date().toISOString(),
        },
      ],
      pending_submissions: [],
      recent_spends: [],
      created_at: new Date().toISOString(),
    })
  );
}

describe("pending-melt reconcile against a mint that won't answer", () => {
  beforeAll(async () => {
    configRoot = mkdtempSync(join(tmpdir(), "dvm-cli-melt-reconcile-"));
    originalConfigRoot = process.env.DVM_CONFIG_DIR;
    process.env.DVM_CONFIG_DIR = configRoot;
    vi.resetModules();
    sdk = await import("@dvmkit/sdk/internal");
    ({ walletFund, walletShow } = await import("../src/commands/wallet-agent-fund"));
    ({ reconcilePendingMelts } = await import("../src/lib/wallet-agent/melt-sweep"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    writeWalletWithPendingMelt();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    rmSync(configRoot, { recursive: true, force: true });
    if (originalConfigRoot === undefined) delete process.env.DVM_CONFIG_DIR;
    else process.env.DVM_CONFIG_DIR = originalConfigRoot;
  });

  it("settles the same melt on the next reconcile after the mint confirms it", async () => {
    const mint = fakeMint();
    const getWalletForMint = async () => mint.wallet;

    const { clock, now, sleep } = fakeClock();
    const sweep = await reconcilePendingMelts({ getWalletForMint, now, sleep });

    expect(clock.sleeps).toEqual([5_000, 5_000]);
    expect(mint.wallet.checkMeltQuoteBolt11).toHaveBeenCalledTimes(2);
    expect(sweep.unchecked).toMatchObject([
      {
        quote_id: "melt-1",
        mint: MINT,
        amount_sats: 60,
        cause: "rate_limited",
        retryable: true,
        pending: true,
        retry_after_ms: 5_000,
        error_name: "RateLimitError",
        next_action: {
          type: "run_command",
          command: "dvm wallet show",
          retry_after_ms: 5_000,
        },
      },
    ]);
    expect(JSON.stringify(sweep.unchecked)).not.toContain(MINT_PROSE);
    expect(sdk.loadAgentWallet()?.pending_melts.map((m) => m.quote_id)).toEqual(["melt-1"]);

    mint.state.outcome = "PAID";
    const settled = await reconcilePendingMelts({ getWalletForMint });

    expect(settled.unchecked).toEqual([]);
    expect(settled.settled_sats).toBe(60);
    expect(sdk.loadAgentWallet()?.pending_melts).toEqual([]);
    expect(sdk.loadAgentWallet()?.proofs).toEqual([]);
  });

  it("publishes melt_sweep.unchecked without the mint's prose", async () => {
    const mint = fakeMint();
    seams.getWallet.mockResolvedValue(mint.wallet);
    vi.useFakeTimers();

    const show = walletShow({});
    await vi.runAllTimersAsync();
    await show;

    const [event] = seams.json.mock.calls.at(-1) as [Record<string, unknown>];
    expect(event).toMatchObject({
      status: "ok",
      melt_sweep: {
        unchecked: [
          {
            quote_id: "melt-1",
            cause: "rate_limited",
            retryable: true,
            pending: true,
            retry_after_ms: 5_000,
          },
        ],
      },
      pending_melts: [{ quote_id: "melt-1", committed_sats: 64 }],
    });
    expect(event.melt_sweep).not.toHaveProperty("errors");
    expect(JSON.stringify(event)).not.toContain(MINT_PROSE);
  });

  it("names the cause and wait in human wallet show and wallet fund output", async () => {
    const mint = fakeMint();
    seams.getWallet.mockResolvedValue(mint.wallet);
    vi.useFakeTimers();

    const show = walletShow({ human: true });
    await vi.runAllTimersAsync();
    await show;
    const fund = walletFund("100", { human: true, sats: true, testSkipLightning: true });
    await vi.runAllTimersAsync();
    await fund;

    const lines = seams.info.mock.calls.map(([line]) => String(line));
    const failures = lines.filter(
      (line) => line.includes("Cash-out quote melt-1") && line.includes("too frequent")
    );
    expect(failures).toHaveLength(2);
    expect(failures.every((line) => line.includes("Wait 5s and try again"))).toBe(true);
    expect(lines.some((line) => line.includes("64 sats committed, not yet confirmed"))).toBe(true);
    expect(lines.join("\n")).not.toContain(MINT_PROSE);
  });
});
