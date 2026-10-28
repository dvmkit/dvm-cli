import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Amount, MintOperationError, type Proof, type Wallet } from "@cashu/cashu-ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadAgentWallet, receiptPubkeyFromSecret, saveAgentWallet, WALLET_VERSION,
  type JobEnvelope, type Payment,
} from "@dvmkit/sdk/internal";
import { request } from "../src/commands/request";
import { loadJob } from "../src/lib/job-store";
import { HEALTHY_MINT_NUTS, MELT_ONLY_MINT_NUTS } from "../src/lib/cashu/__tests__/__helpers__/mint-info-fixtures";

const seams = vi.hoisted(() => ({
  getWallet: vi.fn(), describe: vi.fn(), submit: vi.fn(), stream: vi.fn(),
  status: vi.fn(), json: vi.fn(),
}));

vi.mock("@dvmkit/sdk/internal", async (original) => ({
  ...(await original<typeof import("@dvmkit/sdk/internal")>()),
  getWallet: seams.getWallet,
}));
vi.mock("../src/lib/transport", () => ({
  createDvmTransport: () => ({
    describe: seams.describe, submit: seams.submit, stream: seams.stream,
    status: seams.status, close: vi.fn(),
  }),
}));
vi.mock("../src/lib/output", async (original) => ({
  ...(await original<typeof import("../src/lib/output")>()),
  json: seams.json, info: vi.fn(),
}));
vi.mock("../src/lib/cli-identity-resolve", () => ({
  resolveSigningIdentity: () => ({ privkey: "01".repeat(32), pubkey: receiptPubkeyFromSecret("01".repeat(32)) }),
}));
vi.mock("../src/lib/btc-rate", () => ({
  resolveBtcUsdRate: async () => ({ rate: 100_000, stale: false }),
  tryResolveBtcUsdRate: async () => ({ rate: 100_000, stale: false }),
}));
vi.mock("../src/lib/x402/wallet", () => ({ loadX402Wallet: () => null }));
vi.mock("../src/lib/payment-rails/tempo-wallet", async (original) => ({
  ...(await original<typeof import("../src/lib/payment-rails/tempo-wallet")>()),
  connectedTempoAccount: async () => null,
}));
vi.mock("../src/lib/float", async (original) => ({
  ...(await original<typeof import("../src/lib/float")>()), loadFloat: () => null,
}));

const endpoint = "https://provider.invalid";
const mints = ["https://a.mint", "https://b.mint", "https://c.mint", "https://d.mint", "https://e.mint"];
const keysetId = "00ad268c4d1f5826";
const lockPrivkey = "01".repeat(32);
const lockPubkey = `02${receiptPubkeyFromSecret(lockPrivkey)}`;
const C = `02${"11".repeat(32)}`;
const root = process.env.DVM_CONFIG_DIR!;

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
  saveAgentWallet({
    version: WALLET_VERSION, lock_privkey: lockPrivkey, lock_pubkey: lockPubkey,
    mnemonic_fingerprint: null, mints, nut13_counters: {},
    proofs: mints.map((mint, index) => ({
      mint, secret: `input-secret-${index}`, amount: 8, id: keysetId, C,
      locked_to_pubkey: lockPubkey, status: "valid" as const,
    })),
    pending_mints: [], pending_melts: [], pending_submissions: [], recent_spends: [],
    created_at: new Date().toISOString(),
  });
  writeFileSync(join(root, "config.json"), JSON.stringify({ credit: { posture: "off" }, feedback: { posture: "off" } }));
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network call"))));
  seams.describe.mockResolvedValue({
    name: "Test provider", auth: ["secp256k1-schnorr-v2"],
    authAudience: { dvm_id: "test-provider", builder_pubkey: "03".repeat(32) },
    capabilities: { echo: { description: "Echo" } },
    cashu: { mints, lock_pubkeys: [lockPubkey], min_locktime: 60, canonical_id: null },
  });
  seams.submit.mockImplementation(async (_ref, _envelope: JobEnvelope, payment?: Payment) => payment
    ? { jobId: "job", status: "completed", summary: "Done" }
    : { jobId: "", status: "payment-required", quotes: [{ priceMsats: 5_000 }] });
  seams.status.mockResolvedValue({ jobId: "job", status: "completed", summary: "Done" });
  seams.stream.mockResolvedValue({ messages: [{
    seq: 1, type: "complete", from: "provider", timestamp: Date.now(), content: { summary: "Done" },
  }], lastSeq: 1 });
});

afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

// Mint transport and keyset metadata are external inputs. Selection, fee
// arithmetic, journaling, token encoding, commit and request rendering stay real.
function mintWallet(failure?: "keys" | "disabled" | "refused"): Wallet {
  let inputs: Proof[] = [];
  const send: Proof[] = [{ id: keysetId, amount: Amount.from(5), secret: "output-secret", C }];
  const keep: Proof[] = [{ id: keysetId, amount: Amount.from(1), secret: "change-secret", C }];
  const outputData = (proofs: Proof[]) => proofs.map((proof, index) => ({
    blindedMessage: { amount: Amount.from(proof.amount), B_: C, id: keysetId },
    blindingFactor: BigInt(index + 1), secret: new TextEncoder().encode(proof.secret),
  }));
  const builder = {
    asP2PK: vi.fn().mockReturnThis(), keepAsP2PK: vi.fn().mockReturnThis(),
    privkey: vi.fn().mockReturnThis(), includeFees: vi.fn().mockReturnThis(),
    prepare: vi.fn(async () => ({
      keysetId, inputs, sendOutputs: outputData(send), keepOutputs: outputData(keep), unselectedProofs: [],
    })),
  };
  return {
    ops: { send: vi.fn((_amount, selected: Proof[]) => { inputs = selected; return builder; }) },
    completeSwap: vi.fn(async () => {
      if (failure === "refused") throw new MintOperationError(11000, "Authorization: Bearer credential-secret");
      return { send, keep };
    }),
    getKeyset: vi.fn(() => {
      if (failure === "keys") throw new Error("cashuBtoken-secret");
      return { id: keysetId, fee: 100, keys: Object.fromEntries(
        Array.from({ length: 11 }, (_, i) => [2 ** i, C])
      ) };
    }),
    getFeesForKeyset: (n: number) => Amount.from(Math.ceil(n * 100 / 1000)),
    getFeesForProofs: (proofs: Proof[]) => Amount.from(Math.ceil(proofs.length * 100 / 1000)),
    getMintInfo: () => ({ cache: { nuts: failure === "disabled" ? MELT_ONLY_MINT_NUTS : HEALTHY_MINT_NUTS } }),
  } as unknown as Wallet;
}

async function paidRequest(): Promise<void> {
  await request({ endpoint, input: "Echo", autoPay: true, budget: "100000", autoPayBelow: "100000" });
}

function terminal(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(seams.json.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
}

describe("successful request mint diagnostics", () => {
  it("reports an unreachable first mint through real spend preparation and successful JSON", async () => {
    const healthy = mintWallet();
    seams.getWallet.mockImplementation(async (mint: string) => {
      if (mint === mints[0]) throw new Error("input-secret-0 cashuBtoken-secret Authorization: Bearer credential-secret");
      return healthy;
    });

    await paidRequest();

    expect(terminal()).toMatchObject({
      jobId: "job", paidWith: "cashu_p2pk", mint: mints[1], amountSats: 5, next_action: null,
      mint_attempts: [{ mint: mints[0], reason: "unreachable", message: "Mint could not be loaded." }],
    });
    expect(terminal()).not.toHaveProperty("error");
    assertSingleSpend(healthy);
    assertSecretFree();
  });

  it.each(["immediate", "streamed", "status recovery"])("preserves all skipped reasons in order on %s completion", async (completion) => {
    const wallets = [mintWallet("keys"), mintWallet("disabled"), mintWallet("refused"), mintWallet()];
    seams.getWallet.mockImplementation(async (mint: string) => {
      const index = mints.indexOf(mint);
      if (index === 0) throw new Error("proof-secret " + "x".repeat(20_000));
      return wallets[index - 1];
    });
    if (completion !== "immediate") seams.submit.mockImplementation(async (_ref, _envelope, payment?: Payment) => payment
      ? { jobId: "job", status: "processing" }
      : { jobId: "", status: "payment-required", quotes: [{ priceMsats: 5_000 }] });
    if (completion === "status recovery") seams.stream.mockResolvedValue({ messages: [], lastSeq: 0 });

    await paidRequest();

    expect(terminal()).toMatchObject({ jobId: "job", paidWith: "cashu_p2pk", mint: mints[4], amountSats: 5, next_action: null });
    expect(terminal().mint_attempts).toEqual([
      { mint: mints[0], reason: "unreachable", message: "Mint could not be loaded." },
      { mint: mints[1], reason: "keys_unavailable", message: "Mint did not provide an active keyset." },
      { mint: mints[2], reason: "swap_disabled", message: "Mint advertises swaps switched off (NUT-3 disabled)." },
      { mint: mints[3], reason: "swap_rejected", message: "Mint swap could not be prepared or was definitely refused." },
    ]);
    expect(seams.getWallet.mock.calls.map(([mint]) => mint)).toEqual(mints);
    expect(wallets[1].ops.send).not.toHaveBeenCalled();
    expect(wallets[2].completeSwap).toHaveBeenCalledTimes(1);
    assertSingleSpend(wallets[3]);
    expect(loadAgentWallet()?.proofs.find((proof) => proof.mint === mints[3])?.status).toBe("valid");
    expect(completion === "status recovery" ? terminal().recovered : true).toBe(true);
    assertSecretFree();
  });

  it("omits diagnostics on ordinary first-mint success", async () => {
    const healthy = mintWallet();
    seams.getWallet.mockResolvedValue(healthy);

    await paidRequest();

    expect(terminal()).toMatchObject({ paidWith: "cashu_p2pk", mint: mints[0], next_action: null });
    expect(terminal()).not.toHaveProperty("mint_attempts");
    expect(seams.getWallet.mock.calls).toEqual([[mints[0]]]);
    assertSingleSpend(healthy);
  });
});

function assertSingleSpend(healthy: Wallet): void {
  expect(healthy.completeSwap).toHaveBeenCalledTimes(1);
  const payments = seams.submit.mock.calls.filter(([, , payment]) => payment);
  expect(payments).toHaveLength(1);
  const payment = payments[0][2] as { cashuRequestId: string };
  expect(terminal().requestId).toBe(payment.cashuRequestId);
  expect(loadJob("job")).toMatchObject({ totalPaidMsats: 5_000, paymentsHonoured: 1 });
  const wallet = loadAgentWallet()!;
  expect(wallet.pending_submissions).toEqual([]);
  expect(wallet.recent_spends).toHaveLength(1);
  expect(wallet.recent_spends[0].request_id).toBe(payment.cashuRequestId);
  expect(JSON.stringify(wallet)).not.toContain("attempts");
}

function assertSecretFree(): void {
  const output = JSON.stringify(terminal());
  for (const secret of ["input-secret", "output-secret", "cashuBtoken-secret", "credential-secret", "Authorization", "proof-secret"]) {
    expect(output).not.toContain(secret);
  }
  expect(output.length).toBeLessThan(10_000);
}
