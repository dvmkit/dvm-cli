vi.mock("../src/lib/identity", async () => ({ ...(await vi.importActual<typeof import("../src/lib/identity")>("../src/lib/identity")), loadConfig: vi.fn(() => ({ credit: {} })) }));
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const MINT = "https://mint.invalid";

const seams = vi.hoisted(() => ({
  close: vi.fn(),
  describe: vi.fn(async () => ({ cashu: { mints: [MINT] } })),
  fundAgentWallet: vi.fn(),
  info: vi.fn(),
  json: vi.fn(),
  reserveAgentWallet: vi.fn(),
}));

vi.mock("../src/lib/transport", () => ({
  createDvmTransport: () => ({ close: seams.close, describe: seams.describe }),
}));

vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
effectiveFundingMint: vi.fn(() => ({ url: MINT, source: "configured" })),
effectiveMints: vi.fn(() => [MINT]),
loadAgentWallet: vi.fn(() => ({ mints: [MINT], proofs: [] })),
loadConfig: vi.fn(() => ({ credit: {} })),
microToSats: vi.fn(() => 100),
msatsToMicro: vi.fn(() => 0) }));
vi.mock("../src/lib/output", async () => ({ ...(await vi.importActual<typeof import("../src/lib/output")>("../src/lib/output")), info: seams.info,
json: seams.json }));
vi.mock("../src/lib/wallet-agent/builder-handle", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/wallet-agent/builder-handle")>()), extractBuilderHandle: vi.fn(() => "builder.example") }));
vi.mock("../src/lib/wallet-agent/fund", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/wallet-agent/fund")>()), fundAgentWallet: seams.fundAgentWallet }));
vi.mock("../src/lib/wallet-agent/mint-inventory", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/wallet-agent/mint-inventory")>()), loadConfiguredMints: vi.fn(async () => undefined) }));
vi.mock("../src/lib/wallet-agent/reserve", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/wallet-agent/reserve")>()), reserveAgentWallet: seams.reserveAgentWallet }));
vi.mock("../src/lib/wallet-agent/mint-selection", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/wallet-agent/mint-selection")>()), resolveFundMint: vi.fn(async () => ({
    url: MINT,
    preferredProbe: { mintAmountBounds: null },
  })) }));
vi.mock("../src/lib/wallet-agent/recovery", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/wallet-agent/recovery")>()), sweepPendingMints: vi.fn(async () => ({ recovered_proofs: [] })) }));

vi.mock("../src/lib/float", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/float")>()),
  assertFloatBudget: vi.fn(async () => 100_000),
  emitFloatBudgetWarning: vi.fn(),
}));

vi.mock("../src/lib/credit-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/credit-policy")>()),
  needsPocketRefill: vi.fn(() => true),
  pocketTargetMicro: vi.fn(() => 5_000_000),
}));

vi.mock("../src/lib/btc-rate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/btc-rate")>()),
  tryResolveBtcUsdRate: vi.fn(async () => ({ rate: 100_000 })),
}));

let sdk: typeof import("@dvmkit/sdk/internal");
let walletReserve: (typeof import("../src/commands/wallet-agent-reserve"))["walletReserve"];
let refillPocketIfLow: (typeof import("../src/lib/pocket-refill"))["refillPocketIfLow"];

afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("SDK-owned quote retry consumers", () => {
  beforeAll(async () => {
    sdk = await import("@dvmkit/sdk/internal");
    ({ walletReserve } = await import("../src/commands/wallet-agent-reserve"));
    ({ refillPocketIfLow } = await import("../src/lib/pocket-refill"));
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("Network disabled for this unit test");
    }));
    vi.clearAllMocks();
  });

  it("lets reserve surface the SDK deadline error without installing a wallet proxy", async () => {
    const unavailable = new sdk.DvmError(
      "mint_quote_poll_unavailable",
      "The mint did not answer status checks before the wait ended.",
      "Reconcile the existing quote later.",
      { quote_id: "reserve-quote", cause: "mint_unreachable", retryable: true }
    );
    seams.reserveAgentWallet.mockRejectedValueOnce(unavailable);

    await expect(
      walletReserve("100", {
        builder: "https://builder.example",
        sats: true,
        timeout: "3",
      })
    ).rejects.toBe(unavailable);

    expect(seams.reserveAgentWallet).toHaveBeenCalledExactlyOnceWith(
      100,
      expect.objectContaining({ mintUrl: MINT, timeoutMs: 3_000 })
    );
    const options = seams.reserveAgentWallet.mock.calls[0][1] as Record<string, unknown>;
    expect(options).not.toHaveProperty("getWalletForMint");
    expect(seams.close).toHaveBeenCalledExactlyOnceWith();
  });

  it("keeps pocket refill opportunistic while delegating its wait directly to the SDK", async () => {
    const unavailable = new sdk.DvmError(
      "mint_quote_poll_unavailable",
      "The mint did not answer status checks before the wait ended.",
      "Reconcile the existing quote later.",
      { quote_id: "refill-quote", cause: "rate_limited", retryable: true }
    );
    seams.fundAgentWallet.mockRejectedValueOnce(unavailable);

    await expect(refillPocketIfLow({ float: {} as never })).resolves.toBeUndefined();

    expect(seams.fundAgentWallet).toHaveBeenCalledExactlyOnceWith(
      100,
      expect.objectContaining({ mintUrl: MINT, timeoutMs: 60_000 })
    );
    const options = seams.fundAgentWallet.mock.calls[0][1] as Record<string, unknown>;
    expect(options).not.toHaveProperty("getWalletForMint");
    expect(seams.info).toHaveBeenCalledWith(
      expect.stringContaining("The mint did not answer status checks before the wait ended.")
    );
  });
});
