vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
 ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
 loadAgentWallet: vi.fn(),
saveAgentWallet: vi.fn(),
withWalletLock: vi.fn(<T>(fn: () => Promise<T> | T) => Promise.resolve(fn()))
}));
import { beforeEach, describe, expect, it, vi } from "vitest";

const { FakeOutputData } = vi.hoisted(() => {
  class FakeOutputData {
    constructor(
      public blindedMessage: { amount: { toNumber: () => number }; B_: string; id: string },
      public blindingFactor: bigint,
      public secret: Uint8Array,
      public ephemeralE?: string
    ) {}
    toProof(
      sig: { id: string; amount: number; C_: string },
      _keyset: { id: string; keys: Record<number, string> }
    ): { id: string; amount: number; secret: string; C: string } {
      return {
        id: this.blindedMessage.id,
        amount: this.blindedMessage.amount.toNumber(),
        secret: new TextDecoder().decode(this.secret),
        C: sig.C_,
      };
    }
  }
  return { FakeOutputData };
});

vi.mock("@cashu/cashu-ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("@cashu/cashu-ts")>()), ...(() => ({
  Amount: {
    from: (x: unknown) => ({
      toNumber: () =>
        typeof x === "object" && x !== null && "toNumber" in x
          ? (x as { toNumber: () => number }).toNumber()
          : Number(x),
    }),
  },
  MintQuoteState: { UNPAID: "UNPAID", PAID: "PAID", ISSUED: "ISSUED" } as const,
  OutputData: FakeOutputData,
}))() }));

import { DvmError } from "@dvmkit/sdk/internal";
import { fundAgentWallet, fundTimeoutMs, pollUntilPaidOrTimeout } from "../fund";
import type { AgentWallet } from "@dvmkit/sdk/internal";
import { loadAgentWallet, saveAgentWallet } from "@dvmkit/sdk/internal";

const baseWallet: AgentWallet = {
  version: 9,
  lock_privkey: "ab".repeat(32),
  lock_pubkey: "02" + "cd".repeat(32),
  mnemonic_fingerprint: null,
  mints: [],
  proofs: [],
  nut13_counters: {},
  pending_mints: [],
  pending_melts: [],
  pending_submissions: [],
  recent_spends: [],
  created_at: "2026-05-09T00:00:00.000Z",
};

interface MockedCashuWallet {
  createLockedMintQuote: ReturnType<typeof vi.fn>;
  checkMintQuoteBolt11: ReturnType<typeof vi.fn>;
  prepareMint: ReturnType<typeof vi.fn>;
  completeMint: ReturnType<typeof vi.fn>;
  keyChain: { getKeysets: ReturnType<typeof vi.fn> };
}

function makeMockWallet(overrides: Partial<MockedCashuWallet> = {}): MockedCashuWallet {
  const defaultPreview = {
    payload: { outputs: [], quote: "quote-123" },
    outputData: [
      new FakeOutputData(
        { amount: { toNumber: () => 4 }, B_: "02BB04", id: "k1" },
        7n,
        new TextEncoder().encode("s4")
      ),
      new FakeOutputData(
        { amount: { toNumber: () => 1 }, B_: "02BB01", id: "k1" },
        9n,
        new TextEncoder().encode("s1")
      ),
    ],
    keysetId: "k1",
    quote: { quote: "quote-123", request: "lnbc1...", state: "PAID" },
  };
  return {
    createLockedMintQuote: vi.fn().mockResolvedValue({
      quote: "quote-123",
      request: "lnbc1...",
      state: "UNPAID",
      amount: 1000,
      unit: "sat",
      expiry: 1_800_000_000,
    }),
    checkMintQuoteBolt11: vi.fn().mockResolvedValue({
      quote: "quote-123",
      request: "lnbc1...",
      state: "PAID",
      amount: 1000,
      unit: "sat",
      expiry: null,
    }),
    prepareMint: vi.fn().mockResolvedValue(defaultPreview),
    completeMint: vi.fn().mockResolvedValue([
      { id: "k1", amount: 4, secret: "s4", C: "02C4" },
      { id: "k1", amount: 1, secret: "s1", C: "02C1" },
    ]),
    // Default to no keysets — the cap stays off, so existing assertions on
    // exact denomination shapes don't change. Tests targeting the cap path
    // override this with a synthetic keyset.
    keyChain: { getKeysets: vi.fn().mockReturnValue([]) },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadAgentWallet).mockReturnValue({ ...baseWallet, pending_mints: [], proofs: [] });
});

describe("fundAgentWallet", () => {
  it("rejects non-positive amounts", async () => {
    await expect(
      fundAgentWallet(0, {
        mintUrl: "https://mint.example",
        getWalletForMint: vi.fn(),
      })
    ).rejects.toBeInstanceOf(DvmError);
  });

  it("throws wallet_missing when no agent wallet exists", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(null);
    await expect(
      fundAgentWallet(100, {
        mintUrl: "https://mint.example",
        getWalletForMint: vi.fn(),
      })
    ).rejects.toMatchObject({ code: "wallet_missing" });
  });

  it("persists pending_mint BEFORE awaiting payment", async () => {
    const cashu = makeMockWallet();
    let invoiceShown = false;

    await fundAgentWallet(5, {
      mintUrl: "https://mint.example",
      pollIntervalMs: 0,
      timeoutMs: 1_000_000,
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
      onInvoice: () => {
        invoiceShown = true;
        const firstSave = vi.mocked(saveAgentWallet).mock.calls[0][0];
        expect(firstSave.pending_mints).toHaveLength(1);
        expect(firstSave.pending_mints[0]).toMatchObject({
          mint: "https://mint.example",
          quote_id: "quote-123",
          amount_sats: 5,
          expires_at: 1_800_000_000,
        });
        expect(firstSave.pending_mints[0].minting).toBeUndefined();
        expect(firstSave.proofs).toHaveLength(0);
      },
    });

    expect(invoiceShown).toBe(true);
    const calls = vi.mocked(saveAgentWallet).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const lastSave = calls[calls.length - 1][0];
    expect(lastSave.pending_mints).toHaveLength(0);
    expect(lastSave.proofs.length).toBeGreaterThan(0);
  });

  it("testSkipLightning suppresses onInvoice but still mints", async () => {
    const cashu = makeMockWallet();
    const onInvoice = vi.fn();
    const payInvoice = vi.fn();

    const result = await fundAgentWallet(5, {
      mintUrl: "https://mint.example",
      pollIntervalMs: 0,
      timeoutMs: 1_000_000,
      testSkipLightning: true,
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
      onInvoice,
      payInvoice,
    });

    expect(onInvoice).not.toHaveBeenCalled();
    expect(payInvoice).not.toHaveBeenCalled();
    expect(result.proofs.length).toBeGreaterThan(0);
  });

  it("save 2 + save 3 reload-and-merge: a concurrent run's writes between saves are preserved", async () => {
    const cashu = makeMockWallet();
    const otherPending = {
      mint: "https://other-mint.example",
      quote_id: "other-quote",
      amount_sats: 42,
      requested_at: "2026-05-09T11:00:00.000Z",
    };
    const otherProof = {
      mint: "https://other-mint.example",
      secret: "other",
      C: "02OTHER",
      amount: 7,
      id: "ko",
      locked_to_pubkey: baseWallet.lock_pubkey,
      status: "valid" as const,
    };
    vi.mocked(loadAgentWallet)
      .mockReturnValueOnce({ ...baseWallet, pending_mints: [], proofs: [] })
      .mockReturnValue({
        ...baseWallet,
        pending_mints: [otherPending],
        proofs: [otherProof],
      });

    await fundAgentWallet(5, {
      mintUrl: "https://mint.example",
      pollIntervalMs: 0,
      timeoutMs: 1_000_000,
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
    });

    const calls = vi.mocked(saveAgentWallet).mock.calls;
    const save2 = calls[1][0];
    expect(save2.pending_mints.map((p) => p.quote_id).sort()).toEqual(["other-quote", "quote-123"]);
    expect(save2.pending_mints.find((p) => p.quote_id === "quote-123")?.minting?.keyset_id).toBe(
      "k1"
    );
    const save3 = calls[calls.length - 1][0];
    expect(save3.pending_mints.map((p) => p.quote_id)).toEqual(["other-quote"]);
    expect(save3.proofs.find((p) => p.secret === "other")).toBeTruthy();
    expect(save3.proofs.length).toBeGreaterThan(1);
  });

  it("a crash inside completeMint leaves the minting sub-state on disk for the next sweep", async () => {
    const cashu = makeMockWallet();
    cashu.completeMint.mockImplementation(async () => {
      const durable = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
      const pending = durable?.pending_mints.find((p) => p.quote_id === "quote-123");
      expect(pending?.minting).toMatchObject({
        keyset_id: "k1",
        outputs: [{
          blinded_message: { amount: 4, B_: "02BB04", id: "k1" },
          blinding_factor: "07",
          secret: "7334",
        }, expect.anything()],
      });
      throw new Error("kill -9");
    });

    await expect(
      fundAgentWallet(5, {
        mintUrl: "https://mint.example",
        pollIntervalMs: 0,
        timeoutMs: 1_000_000,
        getWalletForMint: vi.fn().mockResolvedValue(cashu),
      })
    ).rejects.toThrow("kill -9");

    const lastSave = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    const pending = lastSave?.pending_mints.find((p) => p.quote_id === "quote-123");
    expect(pending?.minting?.outputs.length).toBeGreaterThan(0);
  });

  it("passes P2PK + denominations to prepareMint (primary cashu-ts API path)", async () => {
    const cashu = makeMockWallet();
    await fundAgentWallet(5_000, {
      mintUrl: "https://mint.example",
      pollIntervalMs: 0,
      timeoutMs: 1_000_000,
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
    });

    expect(cashu.createLockedMintQuote).toHaveBeenCalledWith(5_000, baseWallet.lock_pubkey);

    const [method, amount, _quote, config, outputType] = cashu.prepareMint.mock.calls[0] as [
      string,
      number,
      unknown,
      { privkey: string },
      { type: string; options: { pubkey: string }; denominations: number[] },
    ];
    expect(method).toBe("bolt11");
    expect(amount).toBe(5_000);
    expect(config.privkey).toBe(baseWallet.lock_privkey);
    expect(outputType.type).toBe("p2pk");
    expect(outputType.options.pubkey).toBe(baseWallet.lock_pubkey);
    expect(outputType.denominations.reduce((s, n) => s + n, 0)).toBe(5_000);
    expect(outputType.denominations.filter((d) => d === 1).length).toBeLessThanOrEqual(1);

    expect(cashu.completeMint).toHaveBeenCalledTimes(1);
  });

  it("polls until PAID and immediately mints proofs", async () => {
    const cashu = makeMockWallet({
      checkMintQuoteBolt11: vi
        .fn()
        .mockResolvedValueOnce({ quote: "q", state: "UNPAID" })
        .mockResolvedValueOnce({ quote: "q", state: "UNPAID" })
        .mockResolvedValueOnce({ quote: "q", state: "PAID" }),
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    let now = 0;

    await fundAgentWallet(100, {
      mintUrl: "https://mint.example",
      pollIntervalMs: 2_000,
      timeoutMs: 600_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        await sleep(ms);
      },
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
    });

    expect(cashu.checkMintQuoteBolt11).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(cashu.prepareMint).toHaveBeenCalledTimes(1);
    expect(cashu.completeMint).toHaveBeenCalledTimes(1);
  });

  it("rides out transient quote failures and honors Retry-After", async () => {
    const rateLimited = Object.assign(new Error("too many requests"), {
      name: "RateLimitError",
      status: 429,
      retryAfterMs: 5_000,
    });
    const cashu = makeMockWallet({
      checkMintQuoteBolt11: vi
        .fn()
        .mockRejectedValueOnce(rateLimited)
        .mockRejectedValueOnce(rateLimited)
        .mockResolvedValue({ quote: "q", state: "PAID" }),
    });
    const sleeps: number[] = [];
    let now = 0;

    await fundAgentWallet(100, {
      mintUrl: "https://mint.example",
      timeoutMs: 60_000,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
    });

    expect(cashu.checkMintQuoteBolt11).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([5_000, 5_000]);
    expect(cashu.completeMint).toHaveBeenCalledTimes(1);
  });

  it("carries retry backoff across successful quote polls", async () => {
    const transient = Object.assign(new Error("mint failed"), {
      name: "HttpResponseError",
      status: 503,
    });
    const cashu = makeMockWallet({
      checkMintQuoteBolt11: vi
        .fn()
        .mockRejectedValueOnce(transient)
        .mockResolvedValueOnce({ quote: "q", state: "UNPAID" })
        .mockRejectedValueOnce(transient)
        .mockResolvedValueOnce({ quote: "q", state: "PAID" }),
    });
    const sleeps: number[] = [];
    let now = 0;

    await fundAgentWallet(100, {
      mintUrl: "https://mint.example",
      pollIntervalMs: 1_000,
      timeoutMs: 60_000,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
    });

    expect(sleeps).toEqual([2_000, 1_000, 4_000]);
  });

  it("resets quote retry backoff after a healthy stretch", async () => {
    const transient = Object.assign(new Error("mint failed"), {
      name: "HttpResponseError",
      status: 503,
    });
    const cashu = makeMockWallet({
      checkMintQuoteBolt11: vi
        .fn()
        .mockRejectedValueOnce(transient)
        .mockResolvedValueOnce({ quote: "q", state: "UNPAID" })
        .mockRejectedValueOnce(transient)
        .mockResolvedValueOnce({ quote: "q", state: "PAID" }),
    });
    const sleeps: number[] = [];
    let now = 0;

    await fundAgentWallet(100, {
      mintUrl: "https://mint.example",
      pollIntervalMs: 10_000,
      timeoutMs: 60_000,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
    });

    expect(sleeps).toEqual([2_000, 10_000, 2_000]);
  });

  it("returns a structured error exactly at the deadline after only transient failures", async () => {
    const cashu = makeMockWallet({
      checkMintQuoteBolt11: vi.fn().mockRejectedValue(
        Object.assign(new Error("mint failed"), {
          name: "HttpResponseError",
          status: 503,
        })
      ),
    });
    const sleeps: number[] = [];
    let now = 0;

    const err = await fundAgentWallet(100, {
      mintUrl: "https://mint.example",
      timeoutMs: 10_000,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
    }).catch((error: unknown) => error as DvmError);

    expect(now).toBe(10_000);
    expect(sleeps).toEqual([2_000, 4_000, 4_000]);
    expect(err).toMatchObject({
      code: "mint_quote_poll_unavailable",
      data: {
        quote_id: "quote-123",
        cause: "mint_server_error",
        retryable: true,
        retry_after_ms: 8_000,
      },
    });
    expect(cashu.prepareMint).not.toHaveBeenCalled();
    expect(vi.mocked(saveAgentWallet).mock.calls[0]?.[0].pending_mints[0]?.quote_id).toBe(
      "quote-123"
    );
  });

  it("does not retry a non-transient quote failure", async () => {
    const refusal = Object.assign(new Error("bad request"), {
      name: "HttpResponseError",
      status: 400,
    });
    const checkMintQuoteBolt11 = vi.fn().mockRejectedValue(refusal);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      pollUntilPaidOrTimeout(
        { checkMintQuoteBolt11 } as never,
        "quote-1",
        { timeoutMs: 10_000, now: () => 0, sleep }
      )
    ).rejects.toBe(refusal);

    expect(checkMintQuoteBolt11).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws fund_already_issued when the quote has been collected by another run", async () => {
    const cashu = makeMockWallet({
      checkMintQuoteBolt11: vi.fn().mockResolvedValue({ quote: "q", state: "ISSUED" }),
    });

    await expect(
      fundAgentWallet(100, {
        mintUrl: "https://mint.example",
        pollIntervalMs: 0,
        timeoutMs: 1_000_000,
        getWalletForMint: vi.fn().mockResolvedValue(cashu),
      })
    ).rejects.toMatchObject({ code: "fund_already_issued" });

    expect(cashu.prepareMint).not.toHaveBeenCalled();
    expect(cashu.completeMint).not.toHaveBeenCalled();
  });

  it("caps denominations to the active keyset's max amount", async () => {
    const keys: Record<number, string> = {};
    for (let p = 1; p <= 1 << 15; p *= 2) keys[p] = "0".repeat(64);
    const cashu = makeMockWallet({
      keyChain: {
        getKeysets: vi.fn().mockReturnValue([{ isActive: true, hasKeys: true, keys, fee: 100 }]),
      },
    });

    await fundAgentWallet(500_000, {
      mintUrl: "https://mint.example",
      pollIntervalMs: 0,
      timeoutMs: 1_000_000,
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
    });

    const [, , , , outputType] = cashu.prepareMint.mock.calls[0] as [
      string,
      number,
      unknown,
      unknown,
      { denominations: number[] },
    ];
    expect(Math.max(...outputType.denominations)).toBeLessThanOrEqual(1 << 15);
    expect(outputType.denominations.reduce((s, n) => s + n, 0)).toBe(500_000);
  });

  it("throws fund_timeout when payment never arrives", async () => {
    const cashu = makeMockWallet({
      checkMintQuoteBolt11: vi.fn().mockResolvedValue({ quote: "q", state: "UNPAID" }),
    });
    let now = 0;
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      now += ms;
    });

    await expect(
      fundAgentWallet(100, {
        mintUrl: "https://mint.example",
        pollIntervalMs: 100,
        timeoutMs: 500,
        now: () => now,
        sleep,
        getWalletForMint: vi.fn().mockResolvedValue(cashu),
      })
    ).rejects.toMatchObject({ code: "fund_timeout" });

    expect(cashu.prepareMint).not.toHaveBeenCalled();
    expect(cashu.completeMint).not.toHaveBeenCalled();
    const lastSave = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(lastSave?.pending_mints[0]?.quote_id).toBe("quote-123");
    expect(lastSave?.pending_mints[0]?.minting).toBeUndefined();
  });

  it("pays the quote from the float instead of relaying an invoice", async () => {
    const cashu = makeMockWallet();
    const onInvoice = vi.fn();
    const payment = {
      outcome: "paid" as const,
      principalMsats: 5_000,
      routingFeeMsats: 0,
      walletDebitMsats: 5_000,
    };
    const payInvoice = vi.fn().mockResolvedValue(payment);
    const onFloatPayment = vi.fn();

    const result = await fundAgentWallet(5, {
      mintUrl: "https://mint.example",
      pollIntervalMs: 0,
      timeoutMs: 1_000_000,
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
      payInvoice,
      onFloatPayment,
      onInvoice,
    });

    expect(payInvoice).toHaveBeenCalledWith(
      "lnbc1...",
      expect.objectContaining({ quote: "quote-123" })
    );
    expect(onInvoice).not.toHaveBeenCalled();
    expect(onFloatPayment).toHaveBeenCalledWith(payment);
    expect(result.float_payment).toEqual(payment);
  });

  it("persists the pending mint BEFORE the float pays, so a crash mid-flow is recoverable", async () => {
    const cashu = makeMockWallet();
    let pendingAtPayTime: unknown;

    await fundAgentWallet(5, {
      mintUrl: "https://mint.example",
      pollIntervalMs: 0,
      timeoutMs: 1_000_000,
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
      payInvoice: () => {
        pendingAtPayTime = vi.mocked(saveAgentWallet).mock.calls[0][0].pending_mints;
        return Promise.resolve({
          outcome: "paid" as const,
          principalMsats: 5_000,
          routingFeeMsats: 0,
          walletDebitMsats: 5_000,
          totalWalletFeeMsats: 0,
          unitemizedWalletFeeMsats: 0,
        });
      },
    });

    expect(pendingAtPayTime).toHaveLength(1);
    expect(pendingAtPayTime).toMatchObject([{ quote_id: "quote-123", amount_sats: 5 }]);
  });

  it("surfaces a float payment that the mint never credited as money in flight", async () => {
    let now = 0;
    const sleep = vi.fn(() => {
      now += 100;
      return Promise.resolve();
    });
    const cashu = makeMockWallet({
      checkMintQuoteBolt11: vi.fn().mockResolvedValue({ quote: "quote-123", state: "UNPAID" }),
    });

    const err = await fundAgentWallet(5, {
      mintUrl: "https://mint.example",
      pollIntervalMs: 100,
      timeoutMs: 500,
      now: () => now,
      sleep,
      getWalletForMint: vi.fn().mockResolvedValue(cashu),
      payInvoice: () =>
        Promise.resolve({
          outcome: "paid" as const,
          principalMsats: 5_000,
          routingFeeMsats: 0,
          walletDebitMsats: 5_000,
          totalWalletFeeMsats: 0,
          unitemizedWalletFeeMsats: 0,
        }),
    }).catch((e: unknown) => e as DvmError);

    expect(err).toBeInstanceOf(DvmError);
    expect((err as DvmError).code).toBe("fund_timeout");
    expect((err as DvmError).message).toMatch(/paid mint quote/);
    expect((err as DvmError).data?.float_payment).toMatchObject({ outcome: "paid" });
    const lastSave = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(lastSave?.pending_mints[0]?.quote_id).toBe("quote-123");
  });

});

describe("fundTimeoutMs", () => {
  const orig = process.env.DVM_FUND_TIMEOUT_SEC;
  beforeEach(() => {
    process.env.DVM_FUND_TIMEOUT_SEC = orig;
  });
  it("defaults to 600 000 ms (10 min)", () => {
    delete process.env.DVM_FUND_TIMEOUT_SEC;
    expect(fundTimeoutMs()).toBe(600_000);
  });
  it("respects DVM_FUND_TIMEOUT_SEC when set", () => {
    process.env.DVM_FUND_TIMEOUT_SEC = "30";
    expect(fundTimeoutMs()).toBe(30_000);
  });
  it("falls back to default for invalid values", () => {
    process.env.DVM_FUND_TIMEOUT_SEC = "not-a-number";
    expect(fundTimeoutMs()).toBe(600_000);
    process.env.DVM_FUND_TIMEOUT_SEC = "-1";
    expect(fundTimeoutMs()).toBe(600_000);
  });
});
