import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dvmkit/sdk/internal", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, fetchBtcUsdRate: vi.fn(), getLastKnownBtcRate: vi.fn() };
});
vi.mock("../../output", () => ({ info: vi.fn() }));

import { fetchBtcUsdRate, getLastKnownBtcRate } from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";
import { info } from "../../output";
import { tryX402Payment } from "../client";
import { decodePayment, type PaymentPayloadV2 } from "@dvmkit/sdk/internal";
import type { X402Wallet } from "@dvmkit/sdk/internal";

const WALLET: X402Wallet = {
  privateKey: `0x${"11".repeat(32)}`,
  address: "",
  network: "eip155:8453",
};

const REQUEST = {
  amountMsats: 500_000,
  payTo: `0x${"f".repeat(40)}`,
  network: "eip155:8453",
};

/** The signed `value` the DVM will be asked to accept, in USDC micro-units. */
async function signedValue(request: Parameters<typeof tryX402Payment>[0]): Promise<string> {
  const proof = await tryX402Payment(request, WALLET);
  if (!proof) throw new Error("expected a proof for a mapped network");
  return decodePayment(proof.paymentHeader).payload.authorization.value;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("tryX402Payment — BTC/USD rate", () => {
  it("derives a legacy server's amount from the caller rate, with no second fetch", async () => {
    const proof = await tryX402Payment({ ...REQUEST, btcRate: 100_000 }, WALLET);
    if (!proof) throw new Error("expected a proof for a mapped network");

    expect(proof.x402Version).toBe(1);
    expect(decodePayment(proof.paymentHeader)).toMatchObject({
      x402Version: 1,
      scheme: "exact",
      payload: {
        authorization: { value: "500000" },
      },
    });
    expect(fetchBtcUsdRate).not.toHaveBeenCalled();
  });

  it("signs the server-advertised amount when caller and server rates differ", async () => {
    const proof = await tryX402Payment(
      { ...REQUEST, btcRate: 100_000, requiredUsdcMicro: "515000" },
      WALLET
    );
    if (!proof) throw new Error("expected a proof for a mapped network");

    expect(decodePayment(proof.paymentHeader).payload.authorization.value).toBe("515000");
    expect(proof).toMatchObject({
      x402Version: 1,
      amountUsdcMicro: "515000",
      amountMsats: 515_000,
      btcRate: 100_000,
    });
    expect(fetchBtcUsdRate).not.toHaveBeenCalled();
  });

  it("falls back to a legacy v1 body challenge", async () => {
    const proof = await tryX402Payment(
      {
        ...REQUEST,
        btcRate: 100_000,
        paymentRequired: {
          x402Version: 1,
          accepts: [
            {
              scheme: "exact",
              network: "base",
              maxAmountRequired: "515000",
              resource: "https://example.com/v1/job",
              description: "test",
              mimeType: "application/json",
              payTo: REQUEST.payTo,
              asset: `0x${"1".repeat(40)}`,
              maxTimeoutSeconds: 60,
            },
          ],
        },
      },
      WALLET
    );
    if (!proof) throw new Error("expected a v1 proof");

    expect(proof.x402Version).toBe(1);
    expect(decodePayment(proof.paymentHeader)).toMatchObject({
      x402Version: 1,
      scheme: "exact",
      network: "base",
      payload: { authorization: { value: "515000" } },
    });
  });

  it("skips unsupported alternatives and selects exact EIP-3009", async () => {
    const supported = {
      scheme: "exact",
      network: "eip155:8453",
      amount: "515000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: REQUEST.payTo,
      maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
    };
    const paymentRequired = {
      x402Version: 2 as const,
      resource: { url: "https://example.com/v1/job" },
      accepts: [
        { ...supported, scheme: "upto" },
        { ...supported, extra: { assetTransferMethod: "permit2" } },
        supported,
      ],
      extensions: {},
    };

    const proof = await tryX402Payment({ ...REQUEST, btcRate: 100_000, paymentRequired }, WALLET);
    if (!proof) throw new Error("expected a v2 proof");
    const payload = decodePayment(proof.paymentHeader) as PaymentPayloadV2;

    expect(payload.accepted).toEqual(supported);
    expect(payload.resource).toEqual(paymentRequired.resource);
    expect(payload.extensions).toEqual(paymentRequired.extensions);
  });

  // `extra` is optional and nullable in the v2 schema — a requirement without
  // one still means exact/EIP-3009, and the EIP-712 domain falls back to the
  // network's known USDC values.
  it.each([
    { label: "omits extra", extra: {} },
    { label: "nulls extra", extra: { extra: null } },
  ])("pays a v2 requirement that $label", async ({ extra }) => {
    const supported = {
      scheme: "exact",
      network: "eip155:8453",
      amount: "515000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: REQUEST.payTo,
      maxTimeoutSeconds: 60,
      ...extra,
    };
    const paymentRequired = {
      x402Version: 2 as const,
      resource: { url: "https://example.com/v1/job" },
      accepts: [{ ...supported, extra: { assetTransferMethod: "permit2" } }, supported],
      extensions: {},
    };

    const proof = await tryX402Payment({ ...REQUEST, btcRate: 100_000, paymentRequired }, WALLET);
    if (!proof) throw new Error("expected a v2 proof");
    const payload = decodePayment(proof.paymentHeader) as PaymentPayloadV2;

    expect(payload.accepted).toEqual(supported);
    expect(payload.payload.authorization.value).toBe("515000");
  });

  it("refuses an advertised amount more than 10% above the caller estimate", async () => {
    await expect(
      tryX402Payment({ ...REQUEST, btcRate: 100_000, requiredUsdcMicro: "550001" }, WALLET)
    ).rejects.toMatchObject({
      code: "x402_amount_exceeds_limit",
      data: {
        advertised_usdc_microunits: "550001",
        local_usdc_microunits: "500000",
        max_usdc_microunits: "550000",
      },
    });
  });

  it("rejects malformed advertised amounts with a typed terminating error", async () => {
    try {
      await tryX402Payment({ ...REQUEST, btcRate: 100_000, requiredUsdcMicro: "0.5" }, WALLET);
      expect.unreachable("should have rejected the malformed amount");
    } catch (err) {
      expect(err).toBeInstanceOf(DvmError);
      expect((err as DvmError).code).toBe("x402_amount_invalid");
    }
  });

  it("falls back to the cached rate when the provider is down", async () => {
    vi.mocked(fetchBtcUsdRate).mockRejectedValue(new Error("coingecko returned HTTP 429"));
    vi.mocked(getLastKnownBtcRate).mockReturnValue({ rate: 70_000, cachedAt: Date.now() - 60_000 });

    const value = await signedValue(REQUEST);

    expect(value).toBe("350000");
  });

  it("falls through to the next rail — not throws — when there is no rate at all", async () => {
    vi.mocked(fetchBtcUsdRate).mockRejectedValue(new Error("coingecko returned HTTP 429"));
    vi.mocked(getLastKnownBtcRate).mockReturnValue(null);

    // Only an *uncapped* caller reaches this state — `enforceGlobalBudget` hard-
    // fails a capped one upstream — and it deliberately let the unpriceable spend
    // through. Throwing here would abort the rail loop and skip the rails ordered
    // after x402 that don't need a rate — ecash, and Lightning — losing a payment
    // that legacy went out fine. (Tempo needs one too as of and
    // skips itself the same way.) This rail just can't quote USDC without a rate;
    // that's a `null`, same as any other unbuildable payload.
    const proof = await tryX402Payment(REQUEST, WALLET);

    expect(proof).toBeNull();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("Skipping the x402 rail"));
  });
});
