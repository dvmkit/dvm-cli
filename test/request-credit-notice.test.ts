import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobEnvelope, Payment, ProviderInfo } from "@dvmkit/sdk/internal";

const endpoint = "https://provider.invalid";
const mint = "https://mint.invalid";
const secret = "01".repeat(32);
const receiptSecret = "02".repeat(32);

const seams = vi.hoisted(() => ({
  describe: vi.fn(),
  submit: vi.fn(),
  close: vi.fn(),
  prepareAgentSpend: vi.fn(),
  info: vi.fn(),
  json: vi.fn(),
  rate: undefined as number | undefined,
}));

vi.mock("../src/lib/transport", () => ({
  createDvmTransport: () => ({
    describe: seams.describe,
    submit: seams.submit,
    close: seams.close,
  }),
}));

let root: string;
let sdk: typeof import("@dvmkit/sdk/internal");
let request: typeof import("../src/commands/request")["request"];
let notices: typeof import("../src/lib/credit-notice");
let fetchRate: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "dvm-cli-funding-notice-"));
  vi.stubEnv("DVM_CONFIG_DIR", root);
  vi.resetModules();
  vi.doMock("@dvmkit/sdk/internal", async (importOriginal) => {
    const sdk = await importOriginal<typeof import("@dvmkit/sdk/internal")>();
    return { ...sdk,
resolveSigningIdentity: () => ({ privkey: secret, pubkey: sdk.receiptPubkeyFromSecret(secret) }),
loadAgentWallet: () => ({ proofs: [], mints: [mint] }),
loadFloat: () => null,
loadX402Wallet: () => null,
connectedTempoAccount: async () => null };
  });
vi.doMock("../src/lib/output", async () => ({ ...(await vi.importActual<typeof import("../src/lib/output")>("../src/lib/output")), info: seams.info,
json: seams.json }));
  vi.doMock("../src/lib/cli-identity-resolve", () => ({
    resolveSigningIdentity: () => ({ privkey: secret, pubkey: sdk.receiptPubkeyFromSecret(secret) }),
  }));
  vi.doMock("../src/lib/x402/wallet", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/lib/x402/wallet")>()), loadX402Wallet: () => null,
  }));
  vi.doMock("../src/lib/payment-rails/tempo-wallet", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/lib/payment-rails/tempo-wallet")>()), connectedTempoAccount: async () => null,
  }));
vi.doMock("../src/lib/wallet-agent/spend", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/wallet-agent/spend")>()), prepareAgentSpend: seams.prepareAgentSpend,
commitAgentSpend: vi.fn(async () => undefined) }));
vi.doMock("../src/lib/wallet-agent/recovery-submissions", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/wallet-agent/recovery-submissions")>()), sweepPendingSubmissions: vi.fn(async () => undefined) }));
  vi.doMock("../src/lib/float", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/lib/float")>()),
    loadFloat: () => null,
  }));
  vi.doMock("../src/lib/btc-rate", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/lib/btc-rate")>();
    return {
      ...actual,
      tryResolveBtcUsdRate: () => seams.rate === undefined ? actual.tryResolveBtcUsdRate() : Promise.resolve({ rate: seams.rate, stale: false }),
    };
  });
  sdk = await import("@dvmkit/sdk/internal");
  ({ request } = await import("../src/commands/request"));
  notices = await import("../src/lib/credit-notice");
});

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  notices.resetCreditNotices();
  seams.rate = undefined;
  writeConfig("auto");
  fetchRate = vi.fn().mockRejectedValue(new Error("rate provider unavailable"));
  vi.stubGlobal("fetch", fetchRate);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const credit = {
    funding: ["cashu"],
    currency: "usd",
    min_micro: 1_000,
    max_micro: 5_000_000,
    ttl_ms: 86_400_000,
  } satisfies NonNullable<ProviderInfo["credit"]>;
  seams.describe.mockResolvedValue({
    name: "Test provider",
    auth: ["secp256k1-schnorr-v2"],
    authAudience: { dvm_id: "test-provider", builder_pubkey: "03".repeat(32) },
    capabilities: { echo: { description: "Echo" } },
    cashu: { mints: [mint], lock_pubkeys: ["03" + "01".repeat(32)], min_locktime: 60, canonical_id: null },
    credit,
  } satisfies ProviderInfo);
  let paidJobs = 0;
  seams.submit.mockImplementation(async (_ref, envelope: JobEnvelope, payment?: Payment) => {
    if (!payment) {
      return {
        jobId: "",
        status: "payment-required",
        quotes: [{ priceMsats: 1_000, upfront: { amount: 0.001, amount_micro: 1_000, currency: "usd" }, credit }],
      };
    }
    const jobId = `job-${++paidJobs}`;
    const prepaid = typeof envelope.data?.credit_id === "string";
    return {
      jobId,
      status: "completed",
      summary: "Done",
      receipt: sdk.signReceipt({
        v: 1,
        job_id: jobId,
        dvm_id: "test-provider",
        dvm: "echo-provider",
        capability: "echo",
        outcome: "completed",
        reason: null,
        seq: paidJobs,
        issued_at: Math.floor(Date.now() / 1000),
        requester_pubkey: sdk.receiptPubkeyFromSecret(secret),
        paid: {
          msats: 1_000,
          rail: "cashu",
          native_amount: null,
          native_asset: null,
          tx_hash: null,
          mint,
        },
        result_hash: sdk.computeResultHash("Done", []),
        receipt_pubkey: sdk.receiptPubkeyFromSecret(receiptSecret),
        credit: {
          credit_id: prepaid ? String(envelope.data?.credit_id) : `imp:cashu:payment-${paidJobs}`,
          draw_id: prepaid ? String(envelope.data?.draw_id) : `payment-${paidJobs}`,
          amount: 1_000,
          balance_after: prepaid ? 19_000 : 0,
          ledger_seq: 1,
        },
      }, receiptSecret),
    };
  });
  seams.prepareAgentSpend.mockImplementation(async ({ amountSats }) => ({
    cashuToken: "mock-wallet-token",
    requestId: `payment-${paidJobs + 1}`,
    mint,
    totalSats: amountSats,
    intendedLockPubkey: "03" + "01".repeat(32),
  }));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("automatic credit funding notices", () => {
  it("explains a skipped open on the second paid request when the rate fetch fails with no cache", async () => {
    await paidRequest();
    expect(terminal()).not.toHaveProperty("credit_funding_skipped");
    await paidRequest();

    expect(terminal()).toMatchObject({
      paidWith: "cashu_p2pk",
      receipt_verified: "verified_unattested",
      receipt: { credit: { credit_id: "imp:cashu:payment-2", balance_after: 0 } },
      credit_funding_skipped: {
        code: "credit_funding_skipped",
        operation: "open",
        reason: "btc_rate_unavailable",
        dvm: endpoint,
        endpoint,
        display: expect.stringMatching(/not opened.*BTC\/USD rate unavailable/),
        hint: expect.stringContaining("later request"),
      },
    });
    expect(fetchRate).toHaveBeenCalled();
    expect(existsSync(join(root, "btc-rate.json"))).toBe(false);
    expect(seams.prepareAgentSpend.mock.calls.map(([args]) => args.amountSats)).toEqual([1, 1]);
    expect(paidEnvelopes().every((envelope) => !envelope.data?.fund)).toBe(true);
    expect(terminal()).not.toHaveProperty("credit_funding");
    expect(terminal()).not.toHaveProperty("credit_funding_incomplete");
    expect(notices.takeCreditNoticeFields()).toEqual({});
  });

  it("names a refill when an active prepaid credit cannot cover the job", async () => {
    seedEmptyCredit();
    await paidRequest();

    expect(terminal()).toMatchObject({
      paidWith: "cashu_p2pk",
      credit_funding_skipped: {
        operation: "refill",
        reason: "btc_rate_unavailable",
        display: expect.stringMatching(/not refilled.*BTC\/USD rate unavailable/),
        hint: expect.any(String),
      },
    });
    expect(seams.prepareAgentSpend.mock.calls.map(([args]) => args.amountSats)).toEqual([1]);
    expect(paidEnvelopes()[0].data).not.toHaveProperty("fund");
  });

  it("narrates the skipped funding in human mode without leaving a JSON notice behind", async () => {
    await paidRequest();
    seams.json.mockClear();
    await paidRequest(true);

    expect(seams.info).toHaveBeenCalledWith(
      expect.stringMatching(/not opened.*BTC\/USD rate unavailable.*later request/)
    );
    expect(seams.json).not.toHaveBeenCalled();
    expect(notices.takeCreditNoticeFields()).toEqual({});
  });

  it.each(["off", "suggest"] as const)("does not blame missing pricing under %s posture", async (posture) => {
    writeConfig(posture);
    await paidRequest();
    await paidRequest();
    expect(terminal()).not.toHaveProperty("credit_funding_skipped");
  });

  it("preserves the valid-rate open and funding report without a skip notice", async () => {
    seams.rate = 100_000;
    await paidRequest();
    await paidRequest();

    expect(terminal()).not.toHaveProperty("credit_funding_skipped");
    expect(terminal()).toMatchObject({ credit_funding: [{ code: "credit_funded", reason: "no_credit_open" }] });
    expect(paidEnvelopes()[1].data).toHaveProperty("fund");
    expect(seams.prepareAgentSpend.mock.calls.map(([args]) => args.amountSats)).toEqual([1, 20]);
    expect(fetchRate).not.toHaveBeenCalled();
  });
});

function writeConfig(posture: "auto" | "off" | "suggest"): void {
  writeFileSync(join(root, "config.json"), JSON.stringify({ credit: { posture }, feedback: { posture: "off" } }));
}

function seedEmptyCredit(): void {
  writeFileSync(join(root, "credits.json"), JSON.stringify({
    credits: [{
      endpoint,
      callerPubkey: sdk.receiptPubkeyFromSecret(secret),
      creditId: "prepaid-credit",
      currency: "usd",
      remainingMicro: 0,
      balanceMicro: 0,
      targetMicro: 40_000,
      expiryMs: Date.now() + 86_400_000,
      status: "active",
      ledgerSeq: 1,
      updatedAt: Date.now(),
    }],
    implicitCredits: [],
    pendingFundings: [],
    fundingMenuSnapshots: [],
  }));
}

async function paidRequest(human = false): Promise<void> {
  await request({ endpoint, input: "Echo", autoPay: true, budget: "100000", autoPayBelow: "100000", human });
}

function terminal(): Record<string, unknown> {
  return seams.json.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

function paidEnvelopes(): JobEnvelope[] {
  return seams.submit.mock.calls.filter(([, , payment]) => payment).map(([, envelope]) => envelope);
}
