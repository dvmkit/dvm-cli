let sweepPendingMints: typeof import("../src/lib/wallet-agent/recovery")["sweepPendingMints"];
import type { Wallet } from "@cashu/cashu-ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const MINT = "https://mint.invalid";

const seams = vi.hoisted(() => ({
  info: vi.fn(),
  json: vi.fn(),
  getWallet: vi.fn(),
}));

// Output and the mint are the only seams: the fund flow, the wallet file and
// the later sweep run local orchestration with published shared stores against an isolated config dir.
vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
getWallet: seams.getWallet }));
vi.mock("../src/lib/output", async () => ({ ...(await vi.importActual<typeof import("../src/lib/output")>("../src/lib/output")), info: seams.info,
json: seams.json }));
vi.mock("../src/lib/wallet-agent/mint-selection", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/wallet-agent/mint-selection")>()), resolveFundMint: vi.fn(async () => ({ url: MINT, preferredProbe: { mintAmountBounds: null } })) }));

class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super("process.exit");
  }
}

function httpError(name: string, status: number, retryAfterMs?: number): Error {
  return Object.assign(new Error(String(status)), { name, status, retryAfterMs });
}

function fakeMint(pollError: () => Error) {
  const state = { paid: false };
  const quote = { quote: "quote-1", request: "lnbc10n1fake", expiry: null };
  const wallet = {
    createLockedMintQuote: vi.fn(async () => ({ ...quote, state: "UNPAID" })),
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
let walletFund: (typeof import("../src/commands/wallet-agent-fund"))["walletFund"];
let catchErrors: (typeof import("../src/lib/error-handler"))["catchErrors"];
let fundWait: typeof import("../src/lib/wallet-agent/fund-wait");

describe("dvm wallet fund when the payment wait ends early", () => {
  beforeAll(async () => {
    configRoot = mkdtempSync(join(tmpdir(), "dvm-cli-fund-wait-"));
    originalConfigRoot = process.env.DVM_CONFIG_DIR;
    process.env.DVM_CONFIG_DIR = configRoot;
    vi.resetModules();
    sdk = await import("@dvmkit/sdk/internal");
    ({ sweepPendingMints } = await import("../src/lib/wallet-agent/recovery"));
    ({ walletFund } = await import("../src/commands/wallet-agent-fund"));
    ({ catchErrors } = await import("../src/lib/error-handler"));
    fundWait = await import("../src/lib/wallet-agent/fund-wait");
  });

  beforeEach(() => {
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
        pending_mints: [],
        pending_melts: [],
        pending_submissions: [],
        recent_spends: [],
        created_at: new Date().toISOString(),
      })
    );
  });

  afterAll(() => {
    rmSync(configRoot, { recursive: true, force: true });
    if (originalConfigRoot === undefined) delete process.env.DVM_CONFIG_DIR;
    else process.env.DVM_CONFIG_DIR = originalConfigRoot;
  });

  it("exits non-zero with a recovery action, keeps the invoice pending, and a later sweep mints it", async () => {
    const mint = fakeMint(() => httpError("HttpResponseError", 400));
    seams.getWallet.mockResolvedValue(mint.wallet);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSignal(code);
    }) as never);

    await expect(
      catchErrors(() =>
        walletFund("1000", {
          sats: true,
          float: false,
          timeout: "3000",
          qrImage: join(configRoot, "invoice.png"),
        })
      )
    ).rejects.toMatchObject({ code: 1 });

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    const events = seams.json.mock.calls.map(([event]) => event as Record<string, unknown>);
    expect(events.map((event) => event.status)).toContain("awaiting_payment");
    expect(events.at(-1)).toMatchObject({
      error: {
        code: "fund_wait_interrupted",
        cause: "unexpected",
        quote_id: "quote-1",
        mint: MINT,
        amount_sats: 1000,
        pending: true,
        retryable: false,
        next_action: { type: "run_command", command: "dvm wallet show" },
      },
    });
    // A refusal is the one cause with no wait worth suggesting, so the terminal
    // publishes no `retry_after_ms` for an agent to sleep on.
    const interrupted = events.at(-1)?.error as Record<string, unknown>;
    expect(interrupted.retry_after_ms).toBeUndefined();
    expect((interrupted.next_action as Record<string, unknown>).retry_after_ms).toBeUndefined();
    expect(interrupted.hint).not.toContain("Wait");
    expect(sdk.loadAgentWallet()?.pending_mints.map((p) => p.quote_id)).toEqual(["quote-1"]);

    mint.state.paid = true;
    const sweep = await sweepPendingMints({ getWalletForMint: async () => mint.wallet });

    expect(sweep.recovered_proofs.map((p) => p.amount)).toEqual([1000]);
    const after = sdk.loadAgentWallet();
    expect(after?.pending_mints).toEqual([]);
    expect(after?.proofs.map((p) => p.amount)).toEqual([1000]);
  });

  it("passes through a failure thrown before any invoice is recorded", async () => {
    const cause = new TypeError("boom");
    await expect(
      fundWait.fundWithRecoverableWait(1000, { mintUrl: MINT }, () => Promise.reject(cause))
    ).rejects.toBe(cause);
  });

  it("lets the SDK ride out mint rate limits while preserving the caller's poll callback", async () => {
    const { clock, now, sleep } = fakeClock();
    let failures = 2;
    const mint = fakeMint(() => httpError("RateLimitError", 429, 5_000));
    const checkMintQuoteBolt11 = vi.fn(async () => {
        if (failures-- > 0) throw httpError("RateLimitError", 429, 5_000);
        return { quote: "quote-1", request: "lnbc10n1fake", expiry: null, state: "PAID" };
      });
    Object.assign(mint.wallet, { checkMintQuoteBolt11 });
    const onPoll = vi.fn();

    await expect(
      fundWait.fundWithRecoverableWait(1000, {
        mintUrl: MINT,
        timeoutMs: 60_000,
        now,
        sleep,
        onPoll,
        getWalletForMint: async () => mint.wallet,
      })
    ).resolves.toMatchObject({ quote_id: "quote-1", amount_sats: 1000 });

    expect(clock.sleeps).toEqual([5_000, 5_000]);
    expect(checkMintQuoteBolt11).toHaveBeenCalledTimes(3);
    expect(onPoll).toHaveBeenCalledWith("PAID", 10_000);
    expect(sdk.loadAgentWallet()?.pending_mints).toEqual([]);
  });

  it("lets the SDK consume the fund deadline and reshapes its typed exhaustion error", async () => {
    const { clock, now, sleep } = fakeClock();
    const mint = fakeMint(() => httpError("HttpResponseError", 503));

    await expect(
      fundWait.fundWithRecoverableWait(1000, {
        mintUrl: MINT,
        timeoutMs: 20_000,
        now,
        sleep,
        getWalletForMint: async () => mint.wallet,
      })
    ).rejects.toMatchObject({
      code: "fund_wait_interrupted",
      data: {
        cause: "mint_server_error",
        quote_id: "quote-1",
        pending: true,
        retry_after_ms: 30_000,
        next_action: { type: "run_command", command: "dvm wallet show" },
      },
    });

    expect(clock.now).toBe(20_000);
    expect(clock.sleeps).toEqual([2_000, 4_000, 8_000, 6_000]);
    expect(mint.wallet.checkMintQuoteBolt11).toHaveBeenCalledTimes(4);
    expect(sdk.loadAgentWallet()?.pending_mints.map((p) => p.quote_id)).toEqual(["quote-1"]);
  });
  it("reports a mint that rate-limits every status check as such, not as an internal error", async () => {
    const mint = fakeMint(() => httpError("RateLimitError", 429, 5_000));
    seams.getWallet.mockResolvedValue(mint.wallet);
    seams.json.mockClear();
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSignal(code);
    }) as never);

    // The SDK spends this one-second deadline retrying, then the CLI reshapes
    // its typed terminal without exposing the mint's prose.
    await expect(
      catchErrors(() =>
        walletFund("1000", {
          sats: true,
          float: false,
          timeout: "1",
          qrImage: join(configRoot, "invoice.png"),
        })
      )
    ).rejects.toMatchObject({ code: 1 });

    const events = seams.json.mock.calls.map(([event]) => event as Record<string, unknown>);
    expect(events.at(-1)).toMatchObject({
      error: {
        code: "fund_wait_interrupted",
        cause: "rate_limited",
        quote_id: "quote-1",
        pending: true,
        // The real class, not the minified constructor name: cashu-ts sets
        // `name` on its error classes and the fingerprint prefers it.
        error_name: "RateLimitError",
        // The mint named its own Retry-After, so the terminal repeats it rather
        // than the default rate-limit wait, and says it in the hint too.
        retryable: true,
        retry_after_ms: 5_000,
        hint: expect.stringContaining("Wait 5s first.") as unknown as string,
        next_action: {
          type: "run_command",
          command: "dvm wallet show",
          retry_after_ms: 5_000,
        },
      },
    });
    expect(sdk.loadAgentWallet()?.pending_mints.map((p) => p.quote_id)).toEqual(["quote-1"]);
  });

  it.each([
    {
      label: "has no Retry-After header",
      retryAfterMs: undefined,
      expectedWaitMs: 60_000,
      expectedHint: "Wait 1m first.",
    },
    {
      label: "names a Retry-After above the CLI cap",
      retryAfterMs: 86_400_000,
      expectedWaitMs: 300_000,
      expectedHint: "Wait 5m first.",
    },
  ])(
    "preserves the established recovery wait when a rate limit $label",
    async ({ retryAfterMs, expectedWaitMs, expectedHint }) => {
      const mint = fakeMint(() => httpError("RateLimitError", 429, retryAfterMs));
      seams.getWallet.mockResolvedValue(mint.wallet);
      vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new ExitSignal(code);
      }) as never);

      await expect(
        catchErrors(() =>
          walletFund("1000", {
            sats: true,
            float: false,
            timeout: "1",
            qrImage: join(configRoot, "invoice.png"),
          })
        )
      ).rejects.toMatchObject({ code: 1 });

      const events = seams.json.mock.calls.map(([event]) => event as Record<string, unknown>);
      expect(events.at(-1)).toMatchObject({
        error: {
          code: "fund_wait_interrupted",
          cause: "rate_limited",
          retry_after_ms: expectedWaitMs,
          hint: expect.stringContaining(expectedHint) as unknown as string,
          next_action: { retry_after_ms: expectedWaitMs },
        },
      });
    }
  );

  it("says the invoice was paid when collecting the sats fails after payment", async () => {
    const mint = fakeMint(() => httpError("HttpResponseError", 400));
    mint.state.paid = true;
    Object.assign(mint.wallet, {
      prepareMint: vi.fn(() => Promise.reject(httpError("HttpResponseError", 503))),
    });
    seams.getWallet.mockResolvedValue(mint.wallet);
    seams.json.mockClear();
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSignal(code);
    }) as never);

    await expect(
      catchErrors(() =>
        walletFund("1000", {
          sats: true,
          float: false,
          timeout: "3000",
          qrImage: join(configRoot, "invoice.png"),
        })
      )
    ).rejects.toMatchObject({ code: 1 });

    const events = seams.json.mock.calls.map(([event]) => event as Record<string, unknown>);
    expect(events.at(-1)).toMatchObject({
      error: {
        code: "fund_mint_interrupted",
        cause: "mint_server_error",
        quote_id: "quote-1",
        pending: true,
        message: expect.stringContaining("was paid") as unknown as string,
        // A 503 names no wait, so the terminal falls back to the shared
        // transient wait — the same one the reconcile sweep suggests.
        retryable: true,
        retry_after_ms: 30_000,
        next_action: {
          type: "run_command",
          command: "dvm wallet show",
          retry_after_ms: 30_000,
        },
      },
    });
    expect(sdk.loadAgentWallet()?.pending_mints.map((p) => p.quote_id)).toEqual(["quote-1"]);
  });

});
