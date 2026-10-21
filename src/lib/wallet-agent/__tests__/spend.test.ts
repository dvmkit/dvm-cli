vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
 ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
 loadAgentWallet: vi.fn(),
saveAgentWallet: vi.fn(),
withWalletLock: vi.fn(<T>(fn: () => Promise<T> | T) => Promise.resolve(fn())),
WALLET_VERSION: 5 as const,
RECENT_SPENDS_CAP: 10 as const
}));
import { createHash } from "node:crypto";

import type * as CashuTs from "@cashu/cashu-ts";
import { Amount, MintOperationError, type SerializedDLEQ, type Wallet } from "@cashu/cashu-ts";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cashu/cashu-ts", async (importActual) => {
  // Keep Amount and splitAmount real so fee reserves use cashu-ts arithmetic.
  const actual = await importActual<typeof CashuTs>();
  return {
    ...actual,
    getEncodedToken: vi.fn((token: { mint: string; proofs: { secret: string }[] }) => {
      const secrets = token.proofs.map((p) => p.secret).join(",");
      return `cashu:${token.mint}:${secrets}`;
    }),
  };
});

import {
  HEALTHY_MINT_NUTS,
  MELT_ONLY_MINT_NUTS,
} from "../../cashu/__tests__/__helpers__/mint-info-fixtures";
import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
function generateAgentKeypair() {
  const privkey = randomBytes(32).toString("hex");
  const pubkey = Buffer.from(secp256k1.getPublicKey(Buffer.from(privkey, "hex"))).toString("hex");
  return { privkey, pubkey };
}
import {
  abandonPendingSubmission,
  commitAgentSpend,
  correctPendingFundAmount,
  prepareAgentSpend,
} from "../spend";
import {
  type AgentProof,
  type AgentWallet,
  loadAgentWallet,
  type PendingSubmissionContext,
  saveAgentWallet,
  WALLET_VERSION,
} from "@dvmkit/sdk/internal";
import {
  cashuSubmissionBindingFingerprint,
  cashuSubmissionBindingFromContext,
} from "@dvmkit/sdk/internal";

function proof(secret: string, amount: number): AgentProof {
  return {
    mint: "https://mint.example",
    secret,
    C: "02" + "ff".repeat(32),
    amount,
    id: "k1",
    locked_to_pubkey: "02" + "ab".repeat(32),
    status: "valid",
  };
}

function baseWallet(privkey: string, pubkey: string, proofs: AgentProof[] = []): AgentWallet {
  return {
    version: WALLET_VERSION,
    lock_privkey: privkey,
    lock_pubkey: pubkey,
    mnemonic_fingerprint: null,
    mints: ["https://mint.example"],
    proofs,
    nut13_counters: {},
    pending_mints: [],
    pending_melts: [],
    pending_submissions: [],
    recent_spends: [],
    created_at: "2026-05-09T00:00:00.000Z",
  };
}

const FIXED_UUID = "11111111-1111-4111-8111-111111111111";
const FIXED_NOW = 1_000_000;
const ENDPOINT = "https://api.example.com";

function strictContext(overrides: Partial<PendingSubmissionContext> = {}): {
  context: PendingSubmissionContext;
  fingerprint: string;
} {
  const context: PendingSubmissionContext = {
    submit_body: {
      capability: "fetch",
      input: "",
      data: { url: "https://example.com", tier: "fast", format: "markdown" },
      bid_msats: 5_000,
    },
    dvm_id: "dvmkit--scrape",
    capability: "fetch",
    signing_pubkey: "aa".repeat(32),
    pinned_mint: "https://mint.example",
    policy: {
      maxTotalMsats: 5_000,
      autoPayBelowMsats: 5_000,
      maxIncrementMsats: 5_000,
      maxPayments: 1,
    },
    strict_per_call: true,
    max_cashu_fee_sats: 2,
    ...overrides,
  };
  const binding = cashuSubmissionBindingFromContext(context);
  if (!binding) throw new Error("strict test context must be bindable");
  return { context, fingerprint: cashuSubmissionBindingFingerprint(binding) };
}

interface SwapProof {
  id: string;
  amount: number;
  secret: string;
  C: string;
  dleq?: SerializedDLEQ;
}
interface SwapResult {
  send: SwapProof[];
  keep: SwapProof[];
}

/** Power-of-two denominations, as every real keyset carries. */
const KEYSET_KEYS: Record<number, string> = Object.fromEntries(
  Array.from({ length: 11 }, (_, i) => [2 ** i, "02" + "cc".repeat(32)])
);

function makeMockWallet(
  swapResult: SwapResult | Error,
  fee: number | Error = 100,
  nuts?: Record<string, unknown>
): Wallet {
  let selectedInputs: { secret: string }[] = [];
  const outputData = (proofs: SwapProof[]) =>
    proofs.map((proof, index) => ({
      blindedMessage: { amount: Amount.from(proof.amount), B_: `02BLINDED${index}`, id: proof.id },
      blindingFactor: BigInt(index + 1),
      secret: new TextEncoder().encode(proof.secret),
    }));
  const builder = {
    asP2PK: vi.fn().mockReturnThis(),
    keepAsP2PK: vi.fn().mockReturnThis(),
    privkey: vi.fn().mockReturnThis(),
    includeFees: vi.fn().mockReturnThis(),
    prepare: vi.fn().mockImplementation(() =>
      Promise.resolve({
        keysetId: "k1",
        inputs: selectedInputs,
        sendOutputs: swapResult instanceof Error ? [] : outputData(swapResult.send),
        keepOutputs: swapResult instanceof Error ? [] : outputData(swapResult.keep),
        unselectedProofs: [],
      })
    ),
  };
  return {
    ops: {
      send: vi.fn().mockImplementation((_amount, inputs: { secret: string }[]) => {
        selectedInputs = inputs;
        return builder;
      }),
    },
    completeSwap: vi.fn().mockImplementation(() => {
      if (swapResult instanceof Error) return Promise.reject(swapResult);
      return Promise.resolve(swapResult);
    }),
    getKeyset: vi.fn().mockImplementation(() => {
      if (fee instanceof Error) throw fee;
      return { id: "k1", fee, keys: KEYSET_KEYS };
    }),
    // Bodies lifted from cashu-ts, so the reserve the spend computes is the
    // arithmetic the swap would have done.
    getFeesForKeyset: vi.fn().mockImplementation((nInputs: number) => {
      const ppk = fee instanceof Error ? 0 : fee;
      return Amount.from(Math.floor(Math.max((nInputs * ppk + 999) / 1000, 0)));
    }),
    getFeesForProofs: vi.fn().mockImplementation((proofs: { id: string }[]) => {
      const ppk = fee instanceof Error ? 0 : fee;
      return Amount.from(Math.ceil((proofs.length * ppk) / 1000));
    }),
    ...(nuts ? { getMintInfo: vi.fn().mockReturnValue({ cache: { nuts } }) } : {}),
  } as unknown as Wallet;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("prepareAgentSpend per-call swap", () => {
  it("selects inputs covering price + fee, swaps to DVM-locked outputs, persists pending_submission, removes inputs", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const dvmPubkey = "02" + "ee".repeat(32);
    vi.mocked(loadAgentWallet).mockImplementation(() => {
      const calls = vi.mocked(saveAgentWallet).mock.calls;
      return calls.length > 0
        ? calls[calls.length - 1][0]
        : baseWallet(privkey, pubkey, [proof("input-a", 8), proof("input-b", 4)]);
    });

    const swapResult: SwapResult = {
      send: [
        {
          id: "k1",
          amount: 4,
          secret: "dvm-locked-1",
          C: "02DEAD",
          dleq: { e: "dleq-e", s: "dleq-s", r: "blind-r" },
        },
        { id: "k1", amount: 3, secret: "dvm-locked-2", C: "02BEEF" },
      ],
      keep: [],
    };
    const mockWallet = makeMockWallet(swapResult);

    const result = await prepareAgentSpend({
      amountSats: 7,
      endpoint: ENDPOINT,
      cashuP2pk: { mints: ["https://mint.example"], lock_pubkey: dvmPubkey },
      now: () => FIXED_NOW,
      uuid: () => FIXED_UUID,
      inFlightTimeoutSec: 60,
      getWalletForMint: () => Promise.resolve(mockWallet),
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.requestId).toBe(FIXED_UUID);
    expect(result.totalSats).toBe(7);
    expect(result.endpoint).toBe(ENDPOINT);
    expect(result.intendedLockPubkey).toBe(dvmPubkey);
    expect(result.cashuToken).toBe("cashu:https://mint.example:dvm-locked-1,dvm-locked-2");

    const sendSpy = vi.mocked(mockWallet.ops.send);
    expect(sendSpy).toHaveBeenCalledWith(7, expect.any(Array));

    const saved = lastSavedWallet();
    expect(saved.proofs.some((p) => p.secret === "input-a")).toBe(false);
    expect(saved.proofs.some((p) => p.secret === "input-b")).toBe(false);
    expect(saved.pending_submissions).toHaveLength(1);
    const sub = saved.pending_submissions[0];
    expect(sub.endpoint).toBe(ENDPOINT);
    expect(sub.request_id).toBe(FIXED_UUID);
    expect(sub.intended_lock_pubkey).toBe(dvmPubkey);
    expect(sub.amount_sats).toBe(7);
    expect(sub.output_proofs).toHaveLength(2);
    expect(sub.output_proofs.map((p) => p.secret)).toEqual(["dvm-locked-1", "dvm-locked-2"]);
    expect(sub.output_proofs[0].locked_to_pubkey).toBe(dvmPubkey);
    expect(sub.output_proofs[0].dleq).toEqual({
      e: "dleq-e",
      s: "dleq-s",
      r: "blind-r",
    });
  });

  it("persists the submit context so a resume can re-POST the original call", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const dvmPubkey = "02" + "ee".repeat(32);
    vi.mocked(loadAgentWallet).mockImplementation(() => {
      const calls = vi.mocked(saveAgentWallet).mock.calls;
      return calls.length > 0
        ? calls[calls.length - 1][0]
        : baseWallet(privkey, pubkey, [proof("input-a", 8)]);
    });

    const mockWallet = makeMockWallet({
      send: [{ id: "k1", amount: 5, secret: "dvm-locked-1", C: "02DEAD" }],
      keep: [],
    });

    await prepareAgentSpend({
      amountSats: 5,
      endpoint: ENDPOINT,
      cashuP2pk: { mints: ["https://mint.example"], lock_pubkey: dvmPubkey },
      now: () => FIXED_NOW,
      uuid: () => FIXED_UUID,
      inFlightTimeoutSec: 60,
      getWalletForMint: () => Promise.resolve(mockWallet),
      submitContext: {
        submit_body: { input: "hello", capability: "summarize" },
        dvm_id: "scribe",
        capability: "summarize",
      },
    });

    const sub = lastSavedWallet().pending_submissions[0];
    expect(sub.context).toEqual({
      submit_body: { input: "hello", capability: "summarize" },
      dvm_id: "scribe",
      capability: "summarize",
      initial_cashu_fee_sats: 2,
    });
    expect(sub.initial_cashu_fee_sats).toBe(2);
  });

  it("captures result.keep into wallet.proofs[] P2PK-locked to the agent's own pubkey", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const dvmPubkey = "02" + "ee".repeat(32);
    vi.mocked(loadAgentWallet).mockImplementation(() => {
      const calls = vi.mocked(saveAgentWallet).mock.calls;
      return calls.length > 0
        ? calls[calls.length - 1][0]
        : baseWallet(privkey, pubkey, [proof("big", 10)]);
    });

    const mockWallet = makeMockWallet(
      {
        send: [{ id: "k1", amount: 5, secret: "to-dvm", C: "02SEND" }],
        keep: [
          { id: "k1", amount: 2, secret: "change-a", C: "02KEEPA" },
          { id: "k1", amount: 2, secret: "change-b", C: "02KEEPB" },
        ],
      },
      100
    );

    const result = await prepareAgentSpend({
      amountSats: 5,
      endpoint: ENDPOINT,
      cashuP2pk: { mints: ["https://mint.example"], lock_pubkey: dvmPubkey },
      now: () => FIXED_NOW,
      uuid: () => FIXED_UUID,
      inFlightTimeoutSec: 60,
      getWalletForMint: () => Promise.resolve(mockWallet),
    });

    expect("error" in result).toBe(false);

    const saved = lastSavedWallet();
    expect(saved.proofs.some((p) => p.secret === "big")).toBe(false);
    const change = saved.proofs.filter((p) => p.secret === "change-a" || p.secret === "change-b");
    expect(change.map((p) => p.secret).sort()).toEqual(["change-a", "change-b"]);
    for (const p of change) {
      expect(p.locked_to_pubkey).toBe(pubkey);
      expect(p.status).toBe("valid");
      expect(p.mint).toBe("https://mint.example");
    }
    expect(saved.pending_submissions[0].output_proofs.map((p) => p.secret)).toEqual(["to-dvm"]);
    expect(saved.pending_submissions[0].output_proofs[0].locked_to_pubkey).toBe(dvmPubkey);
  });

  it("returns insufficient_balance when wallet covers price but not price + count-aware swap fee", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    // 5 × 1-sat proofs at input_fee_ppk=100. The provisional pass (no fee)
    // succeeds, the mint is loaded, but Lock 2's fee-aware pass needs
    // ≥ 5 + ceil(5*100/1000) = 6 and the wallet only has 5.
    const tinyProofs = Array.from({ length: 5 }, (_, i) => proof(`p${i}`, 1));
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet(privkey, pubkey, tinyProofs));
    const mockWallet = makeMockWallet(new Error("swap must not be called"), 100);
    const result = await prepareAgentSpend({
      amountSats: 5,
      endpoint: ENDPOINT,
      cashuP2pk: { mints: ["https://mint.example"], lock_pubkey: pubkey },
      getWalletForMint: () => Promise.resolve(mockWallet),
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.code).toBe("insufficient_balance");
      expect(result.error.message).toBe(
        "Agent wallet has 5 sats at the DVM's mints; need 5 plus the per-call mint swap fee."
      );
    }
  });

  it("reports a shortfall rather than letting the mint refuse an under-sized swap", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    // At 100 ppk, [8,2,1] covers the 10-sat price but not the two fees:
    // one sat for this swap and one for the DVM to receive all 10 sats.
    vi.mocked(loadAgentWallet).mockReturnValue(
      baseWallet(privkey, pubkey, [proof("p8", 8), proof("p2", 2), proof("p1", 1)])
    );
    const mockWallet = makeMockWallet(new Error("Not enough funds available to send"), 100);

    const result = await prepareAgentSpend({
      amountSats: 10,
      endpoint: ENDPOINT,
      cashuP2pk: { mints: ["https://mint.example"], lock_pubkey: pubkey },
      now: () => FIXED_NOW,
      uuid: () => FIXED_UUID,
      getWalletForMint: () => Promise.resolve(mockWallet),
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.code).toBe("insufficient_balance");
    expect(result.error.attempts).toEqual([
      {
        mint: "https://mint.example",
        reason: "insufficient_balance",
        message:
          "Agent wallet has 11 sats at the DVM's mints; need 10 plus the per-call mint swap fee.",
      },
    ]);
    expect(vi.mocked(mockWallet.ops.send)).not.toHaveBeenCalled();
    const saves = vi.mocked(saveAgentWallet).mock.calls;
    for (const [w] of saves) {
      expect(w.proofs.every((p) => p.status === "valid")).toBe(true);
    }
  });

  it("refuses an over-cap selected proof set before any mint submission or wallet mutation", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const initial = baseWallet(privkey, pubkey, [proof("input", 8)]);
    const initialBytes = JSON.stringify(initial);
    vi.mocked(loadAgentWallet).mockReturnValue(initial);
    // At 100 ppk, a 5-sat send from one selected proof reserves 1 sat for
    // this swap and 1 sat for the DVM's later receive: 2 sats total.
    const mockWallet = makeMockWallet(
      { send: [{ id: "k1", amount: 5, secret: "must-not-exist", C: "02SEND" }], keep: [] },
      100
    );

    const result = await prepareAgentSpend({
      amountSats: 5,
      endpoint: ENDPOINT,
      cashuP2pk: { mints: ["https://mint.example"], lock_pubkey: pubkey },
      maxCashuFeeSats: 1,
      now: () => FIXED_NOW,
      uuid: () => FIXED_UUID,
      getWalletForMint: () => Promise.resolve(mockWallet),
    });

    expect(result).toMatchObject({
      error: {
        code: "cashu_fee_cap_exceeded",
        attempts: [
          expect.objectContaining({ mint: "https://mint.example", reason: "fee_cap_exceeded" }),
        ],
      },
    });
    expect(vi.mocked(mockWallet.ops.send)).not.toHaveBeenCalled();
    expect(vi.mocked(mockWallet.completeSwap)).not.toHaveBeenCalled();
    expect(saveAgentWallet).not.toHaveBeenCalled();
    expect(JSON.stringify(initial)).toBe(initialBytes);
  });

  it("refuses a principal cap before reading a wallet or preparing proofs", async () => {
    const getWalletForMint = vi.fn();

    const result = await prepareAgentSpend({
      amountSats: 5,
      endpoint: ENDPOINT,
      cashuP2pk: { mints: ["https://mint.example"], lock_pubkey: "02" + "ee".repeat(32) },
      maxCashuPrincipalSats: 4,
      getWalletForMint,
    });

    expect(result).toMatchObject({ error: { code: "cashu_principal_cap_exceeded" } });
    expect(getWalletForMint).not.toHaveBeenCalled();
    expect(loadAgentWallet).not.toHaveBeenCalled();
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("clears the same shape with one more sat in the wallet", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    // [8,2,1,1] = 12 at the same mint and price: 12 ≥ 10 + 1 receiver fee +
    // ceil(4*100/1000) input fee, so the swap goes ahead.
    vi.mocked(loadAgentWallet).mockImplementation(() => {
      const calls = vi.mocked(saveAgentWallet).mock.calls;
      return calls.length > 0
        ? calls[calls.length - 1][0]
        : baseWallet(privkey, pubkey, [
            proof("p8", 8),
            proof("p2", 2),
            proof("p1a", 1),
            proof("p1b", 1),
          ]);
    });
    const mockWallet = makeMockWallet(
      { send: [{ id: "k1", amount: 10, secret: "to-dvm", C: "02X" }], keep: [] },
      100
    );

    const result = await prepareAgentSpend({
      amountSats: 10,
      endpoint: ENDPOINT,
      cashuP2pk: { mints: ["https://mint.example"], lock_pubkey: pubkey },
      now: () => FIXED_NOW,
      uuid: () => FIXED_UUID,
      getWalletForMint: () => Promise.resolve(mockWallet),
    });

    expect("error" in result).toBe(false);
    expect(vi.mocked(mockWallet.ops.send)).toHaveBeenCalledWith(10, expect.any(Array));
    const inputs = vi.mocked(mockWallet.ops.send).mock.calls[0][1] as unknown[];
    expect(inputs).toHaveLength(4);
  });

  it("returns no_agent_wallet when the wallet file is missing", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(null);
    const result = await prepareAgentSpend({
      amountSats: 5,
      endpoint: ENDPOINT,
      cashuP2pk: { mints: ["https://mint.example"], lock_pubkey: "02" + "00".repeat(32) },
    });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.code).toBe("no_agent_wallet");
  });

  it("returns missing_lock_pubkey when the DVM doesn't advertise one", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet(privkey, pubkey, [proof("a", 8)]));
    const result = await prepareAgentSpend({
      amountSats: 5,
      endpoint: ENDPOINT,
      cashuP2pk: { mints: ["https://mint.example"], lock_pubkey: "" },
    });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.code).toBe("missing_lock_pubkey");
  });

  it("sweeps stale in-flight proofs before selecting", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const dvmPubkey = "02" + "ee".repeat(32);
    const stale: AgentProof = {
      ...proof("stale", 8),
      status: "in_flight",
      in_flight_until_ms: FIXED_NOW - 1,
    };
    vi.mocked(loadAgentWallet).mockImplementation(() => {
      const calls = vi.mocked(saveAgentWallet).mock.calls;
      return calls.length > 0 ? calls[calls.length - 1][0] : baseWallet(privkey, pubkey, [stale]);
    });
    const mockWallet = makeMockWallet({
      send: [{ id: "k1", amount: 5, secret: "out", C: "02X" }],
      keep: [],
    });

    const result = await prepareAgentSpend({
      amountSats: 5,
      endpoint: ENDPOINT,
      cashuP2pk: { mints: ["https://mint.example"], lock_pubkey: dvmPubkey },
      now: () => FIXED_NOW,
      uuid: () => FIXED_UUID,
      inFlightTimeoutSec: 60,
      getWalletForMint: () => Promise.resolve(mockWallet),
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const saved = lastSavedWallet();
    expect(saved.proofs.some((p) => p.secret === "stale")).toBe(false);
  });
});

describe("prepareAgentSpend strict per-call contract", () => {
  it("fails before mint or wallet mutation when any pending wallet state exists", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const initial = baseWallet(privkey, pubkey, [proof("free", 8)]);
    initial.pending_mints.push({
      mint: "https://mint.example",
      quote_id: "pending",
      amount_sats: 8,
      requested_at: "2026-08-20T00:00:00.000Z",
    });
    const before = JSON.stringify(initial);
    vi.mocked(loadAgentWallet).mockReturnValue(initial);
    const getWalletForMint = vi.fn();
    const { context, fingerprint } = strictContext();

    const result = await prepareAgentSpend({
      amountSats: 5,
      endpoint: ENDPOINT,
      maxCashuFeeSats: 2,
      mode: "strict_per_call",
      cashuP2pk: { mints: ["https://mint.example"], lock_pubkey: "02" + "ee".repeat(32) },
      submitContext: { ...context, binding_fingerprint: fingerprint },
      getWalletForMint,
    });

    expect(result).toMatchObject({ error: { code: "strict_per_call_unsafe" } });
    expect(getWalletForMint).not.toHaveBeenCalled();
    expect(saveAgentWallet).not.toHaveBeenCalled();
    expect(JSON.stringify(initial)).toBe(before);
  });

  it("rejects a changed request body against the approved binding before reading the wallet", async () => {
    const approved = strictContext();
    const changed = strictContext({
      submit_body: {
        ...approved.context.submit_body,
        data: { url: "https://different.example", tier: "fast", format: "markdown" },
      },
      binding_fingerprint: approved.fingerprint,
    });
    const getWalletForMint = vi.fn();

    const result = await prepareAgentSpend({
      amountSats: 5,
      endpoint: ENDPOINT,
      maxCashuFeeSats: 2,
      mode: "strict_per_call",
      cashuP2pk: { mints: ["https://mint.example"], lock_pubkey: "02" + "ee".repeat(32) },
      submitContext: changed.context,
      getWalletForMint,
    });

    expect(result).toMatchObject({ error: { code: "strict_per_call_unsafe" } });
    expect(loadAgentWallet).not.toHaveBeenCalled();
    expect(getWalletForMint).not.toHaveBeenCalled();
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("uses only free proofs, persists the exact binding, and never consumes reserve-direct proofs", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const reserved = {
      ...proof("reserved", 8),
      reserved_for: "builder/api.example.com",
      t_expire: FIXED_NOW + 60_000,
    };
    const initial = baseWallet(privkey, pubkey, [reserved, proof("free", 8)]);
    vi.mocked(loadAgentWallet).mockImplementation(() => {
      const calls = vi.mocked(saveAgentWallet).mock.calls;
      const latest = calls.at(-1);
      return latest ? latest[0] : initial;
    });
    const mockWallet = makeMockWallet(
      { send: [{ id: "k1", amount: 5, secret: "strict-output", C: "02SEND" }], keep: [] },
      100
    );
    const { context, fingerprint } = strictContext();

    const result = await prepareAgentSpend({
      amountSats: 5,
      endpoint: ENDPOINT,
      maxCashuFeeSats: 2,
      mode: "strict_per_call",
      cashuP2pk: { mints: ["https://mint.example"], lock_pubkey: "02" + "ee".repeat(32) },
      submitContext: { ...context, binding_fingerprint: fingerprint },
      now: () => FIXED_NOW,
      uuid: () => FIXED_UUID,
      getWalletForMint: () => Promise.resolve(mockWallet),
    });

    expect(result).toMatchObject({
      requestId: FIXED_UUID,
      submissionBindingFingerprint: fingerprint,
    });
    expect(vi.mocked(mockWallet.ops.send).mock.calls[0][1]).toEqual([
      expect.objectContaining({ secret: "free" }),
    ]);
    const saved = lastSavedWallet();
    expect(saved.proofs).toContainEqual(expect.objectContaining({ secret: "reserved" }));
    expect(saved.pending_submissions[0]).toMatchObject({
      max_cashu_fee_sats: 2,
      initial_cashu_fee_sats: 2,
      context: {
        strict_per_call: true,
        max_cashu_fee_sats: 2,
        initial_cashu_fee_sats: 2,
        binding_fingerprint: fingerprint,
      },
    });
  });
});

describe("prepareAgentSpend reserve-direct path", () => {
  const DVM_PUBKEY = "02" + "ee".repeat(32);
  const BUILDER_HANDLE = "scrape.dvmkit.ai";
  const RESERVED_FOR = `builder/${BUILDER_HANDLE}`;
  const FUTURE = FIXED_NOW + 100_000;

  function reserveProof(secret: string, amount: number): AgentProof {
    return {
      ...proof(secret, amount),
      locked_to_pubkey: DVM_PUBKEY,
      reserved_for: RESERVED_FOR,
      t_expire: FUTURE,
    };
  }

  it("uses reserve proofs and skips the mint swap when the builder has sufficient unexpired reserve", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const reserveOnly = [reserveProof("rA", 3), reserveProof("rB", 3)];
    vi.mocked(loadAgentWallet).mockImplementation(() => {
      const calls = vi.mocked(saveAgentWallet).mock.calls;
      return calls.length > 0
        ? calls[calls.length - 1][0]
        : baseWallet(privkey, pubkey, reserveOnly);
    });

    const mockWallet = makeMockWallet(new Error("swap must not be called"));

    const result = await prepareAgentSpend({
      amountSats: 4,
      endpoint: `https://${BUILDER_HANDLE}`,
      cashuP2pk: { mints: ["https://mint.example"], lock_pubkey: DVM_PUBKEY },
      builderHandle: BUILDER_HANDLE,
      now: () => FIXED_NOW,
      uuid: () => FIXED_UUID,
      inFlightTimeoutSec: 60,
      getWalletForMint: () => Promise.resolve(mockWallet),
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.totalSats).toBeGreaterThanOrEqual(4);
    expect(result.mint).toBe("https://mint.example");
    const sendSpy = vi.mocked(mockWallet.ops.send);
    expect(sendSpy).not.toHaveBeenCalled();

    const saved = lastSavedWallet();
    expect(saved.pending_submissions).toHaveLength(1);
    expect(saved.pending_submissions[0].output_proofs.map((p) => p.secret).sort()).toEqual([
      "rA",
      "rB",
    ]);
    expect(saved.proofs.find((p) => p.secret === "rA")?.status).toBe("in_flight");
    expect(saved.proofs.find((p) => p.secret === "rB")?.status).toBe("in_flight");
  });

  it("picks an exact reserve subset instead of a greedy overshoot", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const reserveProofs = [
      reserveProof("r1", 1),
      reserveProof("r2", 2),
      reserveProof("r4", 4),
      reserveProof("r8", 8),
    ];
    vi.mocked(loadAgentWallet).mockImplementation(() => {
      const calls = vi.mocked(saveAgentWallet).mock.calls;
      return calls.length > 0
        ? calls[calls.length - 1][0]
        : baseWallet(privkey, pubkey, reserveProofs);
    });
    const mockWallet = makeMockWallet(new Error("swap must not be called"));

    const result = await prepareAgentSpend({
      amountSats: 6,
      endpoint: `https://${BUILDER_HANDLE}`,
      cashuP2pk: { mints: ["https://mint.example"], lock_pubkey: DVM_PUBKEY },
      builderHandle: BUILDER_HANDLE,
      now: () => FIXED_NOW,
      uuid: () => FIXED_UUID,
      inFlightTimeoutSec: 60,
      getWalletForMint: () => Promise.resolve(mockWallet),
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.totalSats).toBe(6);
    const saved = lastSavedWallet();
    expect(saved.pending_submissions[0].output_proofs.map((p) => p.secret).sort()).toEqual([
      "r2",
      "r4",
    ]);
  });

  it("picks the minimum-overshoot subset when no exact cover is reachable", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const reserveProofs = [reserveProof("r2", 2), reserveProof("r4", 4), reserveProof("r8", 8)];
    vi.mocked(loadAgentWallet).mockImplementation(() => {
      const calls = vi.mocked(saveAgentWallet).mock.calls;
      return calls.length > 0
        ? calls[calls.length - 1][0]
        : baseWallet(privkey, pubkey, reserveProofs);
    });
    const mockWallet = makeMockWallet(new Error("swap must not be called"));

    const result = await prepareAgentSpend({
      amountSats: 5,
      endpoint: `https://${BUILDER_HANDLE}`,
      cashuP2pk: { mints: ["https://mint.example"], lock_pubkey: DVM_PUBKEY },
      builderHandle: BUILDER_HANDLE,
      now: () => FIXED_NOW,
      uuid: () => FIXED_UUID,
      inFlightTimeoutSec: 60,
      getWalletForMint: () => Promise.resolve(mockWallet),
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.totalSats).toBe(6);
    const saved = lastSavedWallet();
    expect(saved.pending_submissions[0].output_proofs.map((p) => p.secret).sort()).toEqual([
      "r2",
      "r4",
    ]);
  });

  it("falls through to per-call swap when the reserve doesn't cover the price", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const tinyReserve = reserveProof("rTiny", 1);
    const freeBalance = proof("free", 8);
    vi.mocked(loadAgentWallet).mockImplementation(() => {
      const calls = vi.mocked(saveAgentWallet).mock.calls;
      return calls.length > 0
        ? calls[calls.length - 1][0]
        : baseWallet(privkey, pubkey, [tinyReserve, freeBalance]);
    });
    const mockWallet = makeMockWallet({
      send: [{ id: "k1", amount: 5, secret: "swap-out", C: "02SO" }],
      keep: [],
    });

    const result = await prepareAgentSpend({
      amountSats: 5,
      endpoint: `https://${BUILDER_HANDLE}`,
      cashuP2pk: { mints: ["https://mint.example"], lock_pubkey: DVM_PUBKEY },
      builderHandle: BUILDER_HANDLE,
      now: () => FIXED_NOW,
      uuid: () => FIXED_UUID,
      inFlightTimeoutSec: 60,
      getWalletForMint: () => Promise.resolve(mockWallet),
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;

    const sendSpy = vi.mocked(mockWallet.ops.send);
    expect(sendSpy).toHaveBeenCalledWith(5, expect.any(Array));
  });

  it("never bypasses a caller-pinned mint through a reserve at another mint", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const wrongMintReserve = {
      ...reserveProof("wrong-mint-reserve", 8),
      mint: "https://other-mint.example",
    };
    const selectedMintBalance = proof("selected-mint-free", 8);
    vi.mocked(loadAgentWallet).mockImplementation(() => {
      const calls = vi.mocked(saveAgentWallet).mock.calls;
      return calls.length > 0
        ? calls[calls.length - 1][0]
        : baseWallet(privkey, pubkey, [wrongMintReserve, selectedMintBalance]);
    });
    const mockWallet = makeMockWallet({
      send: [{ id: "k1", amount: 5, secret: "selected-mint-output", C: "02SO" }],
      keep: [],
    });

    const result = await prepareAgentSpend({
      amountSats: 5,
      endpoint: `https://${BUILDER_HANDLE}`,
      cashuP2pk: { mints: ["https://mint.example"], lock_pubkey: DVM_PUBKEY },
      builderHandle: BUILDER_HANDLE,
      now: () => FIXED_NOW,
      uuid: () => FIXED_UUID,
      inFlightTimeoutSec: 60,
      getWalletForMint: () => Promise.resolve(mockWallet),
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.mint).toBe("https://mint.example");
    expect(mockWallet.ops.send).toHaveBeenCalled();
    expect(lastSavedWallet().pending_submissions[0].mint).toBe("https://mint.example");
  });

  it("ignores expired reserve proofs", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const expired: AgentProof = {
      ...proof("rOld", 6),
      locked_to_pubkey: DVM_PUBKEY,
      reserved_for: RESERVED_FOR,
      t_expire: FIXED_NOW - 1,
    };
    const freeBalance = proof("free", 8);
    vi.mocked(loadAgentWallet).mockImplementation(() => {
      const calls = vi.mocked(saveAgentWallet).mock.calls;
      return calls.length > 0
        ? calls[calls.length - 1][0]
        : baseWallet(privkey, pubkey, [expired, freeBalance]);
    });
    const mockWallet = makeMockWallet({
      send: [{ id: "k1", amount: 5, secret: "swap-out", C: "02SO" }],
      keep: [],
    });

    const result = await prepareAgentSpend({
      amountSats: 5,
      endpoint: `https://${BUILDER_HANDLE}`,
      cashuP2pk: { mints: ["https://mint.example"], lock_pubkey: DVM_PUBKEY },
      builderHandle: BUILDER_HANDLE,
      now: () => FIXED_NOW,
      uuid: () => FIXED_UUID,
      inFlightTimeoutSec: 60,
      getWalletForMint: () => Promise.resolve(mockWallet),
    });

    expect("error" in result).toBe(false);
    const sendSpy = vi.mocked(mockWallet.ops.send);
    expect(sendSpy).toHaveBeenCalled();
  });
});

describe("commitAgentSpend", () => {
  it("clears the pending_submission with the given request_id and appends a recent_spend", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const w: AgentWallet = {
      ...baseWallet(privkey, pubkey, []),
      pending_submissions: [
        {
          endpoint: ENDPOINT,
          request_id: FIXED_UUID,
          intended_lock_pubkey: "02" + "ee".repeat(32),
          mint: "https://mint.example",
          amount_sats: 5,
          output_proofs: [{ ...proof("o", 5), locked_to_pubkey: "02" + "ee".repeat(32) }],
          created_at: "2026-05-09T00:00:00.000Z",
        },
      ],
    };
    vi.mocked(loadAgentWallet).mockReturnValue(w);

    await commitAgentSpend({
      requestId: FIXED_UUID,
      recentSpend: {
        request_id: FIXED_UUID,
        dvm_endpoint: ENDPOINT,
        mint: "https://mint.example",
        amount_sats: 5,
        signed_at_ms: FIXED_NOW,
      },
    });

    const saved = lastSavedWallet();
    expect(saved.pending_submissions).toHaveLength(0);
    expect(saved.recent_spends).toHaveLength(1);
    expect(saved.recent_spends[0].request_id).toBe(FIXED_UUID);
  });

  it("is a no-op when the wallet is missing", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(null);
    await commitAgentSpend({
      requestId: FIXED_UUID,
      recentSpend: {
        request_id: FIXED_UUID,
        dvm_endpoint: "x",
        mint: "x",
        amount_sats: 0,
        signed_at_ms: 0,
      },
    });
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });
});

describe("abandonPendingSubmission", () => {
  it("keeps refused swap outputs reclaimable without replaying the refused funding", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const output = proof("refused-output", 5);
    const entry = {
      endpoint: ENDPOINT,
      request_id: FIXED_UUID,
      intended_lock_pubkey: "02" + "ee".repeat(32),
      mint: "https://mint.example",
      amount_sats: 5,
      output_proofs: [output],
      cashu_token: "retained-token",
      canonical_id: "42",
      refund_pubkey: pubkey,
      t_expire: FIXED_NOW + 86_400_000,
      max_cashu_fee_sats: 3,
      initial_cashu_fee_sats: 1,
      created_at: "2026-05-09T00:00:00.000Z",
      context: { submit_body: { input: "refused request" } },
    };
    vi.mocked(loadAgentWallet).mockReturnValue({
      ...baseWallet(privkey, pubkey),
      pending_submissions: [entry],
    });

    const refusal = { requestId: FIXED_UUID, preserveRecovery: true };
    await abandonPendingSubmission(refusal);

    const saved = lastSavedWallet();
    expect(saved.pending_submissions).toHaveLength(1);
    expect(saved.pending_submissions[0]).toEqual({ ...entry, context: undefined });
    expect(saved.recent_spends).toHaveLength(0);
  });

  it("removes the entry without appending a recent_spend", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const w: AgentWallet = {
      ...baseWallet(privkey, pubkey, []),
      pending_submissions: [
        {
          endpoint: ENDPOINT,
          request_id: FIXED_UUID,
          intended_lock_pubkey: "02" + "ee".repeat(32),
          mint: "https://mint.example",
          amount_sats: 5,
          output_proofs: [],
          created_at: "2026-05-09T00:00:00.000Z",
        },
      ],
    };
    vi.mocked(loadAgentWallet).mockReturnValue(w);

    await abandonPendingSubmission({ requestId: FIXED_UUID });

    const saved = lastSavedWallet();
    expect(saved.pending_submissions).toHaveLength(0);
    expect(saved.recent_spends).toHaveLength(0);
  });
});

function lastSavedWallet(): AgentWallet {
  const calls = vi.mocked(saveAgentWallet).mock.calls;
  if (calls.length === 0) throw new Error("saveAgentWallet was not called");
  return calls[calls.length - 1][0];
}

describe("prepareAgentSpend token-bound submitContext", () => {
  it("binds the encoded token to persisted context + cashu_token atomically with the outputs", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const dvmPubkey = "02" + "ee".repeat(32);
    vi.mocked(loadAgentWallet).mockImplementation(() => {
      const calls = vi.mocked(saveAgentWallet).mock.calls;
      return calls.length > 0
        ? calls[calls.length - 1][0]
        : baseWallet(privkey, pubkey, [proof("input-a", 8)]);
    });
    const mockWallet = makeMockWallet({
      send: [{ id: "k1", amount: 5, secret: "dvm-locked-1", C: "02DEAD" }],
      keep: [],
    });
    const submitContext = {
      submit_body: { data: { credit_id: "credit-1", fund: { commitment: "" } } },
    };

    const result = await prepareAgentSpend({
      amountSats: 5,
      endpoint: ENDPOINT,
      cashuP2pk: { mints: ["https://mint.example"], lock_pubkey: dvmPubkey },
      now: () => FIXED_NOW,
      uuid: () => FIXED_UUID,
      inFlightTimeoutSec: 60,
      getWalletForMint: () => Promise.resolve(mockWallet),
      submitContext,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const sub = lastSavedWallet().pending_submissions[0];
    expect(sub.cashu_token).toBe(result.cashuToken);
    expect(sub.context?.submit_body).toEqual({
      data: {
        credit_id: "credit-1",
        fund: {
          commitment: createHash("sha256").update(result.cashuToken).digest("hex"),
        },
      },
    });
    expect(sub.output_proofs).toHaveLength(1);
  });

});

describe("correctPendingFundAmount", () => {
  function fundEntry(amountMicro: number): AgentWallet["pending_submissions"][number] {
    return {
      endpoint: ENDPOINT,
      request_id: FIXED_UUID,
      intended_lock_pubkey: "02" + "ee".repeat(32),
      mint: "https://mint.example",
      amount_sats: 100,
      output_proofs: [],
      created_at: "2026-05-09T00:00:00.000Z",
      cashu_token: "cashu:fund-token",
      context: {
        submit_body: {
          input: "hi",
          data: {
            credit_id: "credit-1",
            draw_id: "draw-1",
            fund: { amount_micro: amountMicro, commitment: "aa".repeat(32) },
          },
        },
        signing_pubkey: "bb".repeat(32),
      },
    };
  }

  it("rewrites the persisted fund amount so the resume sweep ships the server's figure", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const w: AgentWallet = {
      ...baseWallet(privkey, pubkey, []),
      pending_submissions: [fundEntry(131_840)],
    };
    vi.mocked(loadAgentWallet).mockReturnValue(w);

    await correctPendingFundAmount({ requestId: FIXED_UUID, amountMicro: 130_769 });

    const saved = lastSavedWallet().pending_submissions[0];
    const data = saved.context?.submit_body.data as Record<string, unknown>;
    const fund = data.fund as Record<string, unknown>;
    expect(fund.amount_micro).toBe(130_769);
    expect(fund.commitment).toBe("aa".repeat(32));
    expect(data.credit_id).toBe("credit-1");
    expect(data.draw_id).toBe("draw-1");
    expect(saved.cashu_token).toBe("cashu:fund-token");
  });

  it("leaves entries without a fund block (or other request ids) untouched", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const plain: AgentWallet["pending_submissions"][number] = {
      endpoint: ENDPOINT,
      request_id: "99999999-9999-4999-8999-999999999999",
      intended_lock_pubkey: "02" + "ee".repeat(32),
      mint: "https://mint.example",
      amount_sats: 5,
      output_proofs: [],
      created_at: "2026-05-09T00:00:00.000Z",
      context: { submit_body: { input: "hi", data: {} } },
    };
    const w: AgentWallet = {
      ...baseWallet(privkey, pubkey, []),
      pending_submissions: [plain, fundEntry(131_840)],
    };
    vi.mocked(loadAgentWallet).mockReturnValue(w);

    await correctPendingFundAmount({ requestId: plain.request_id, amountMicro: 1 });

    const saved = lastSavedWallet().pending_submissions;
    expect(saved[0]).toEqual(plain);
    const fund = (saved[1].context?.submit_body.data as Record<string, unknown>).fund as Record<
      string,
      unknown
    >;
    expect(fund.amount_micro).toBe(131_840);
  });
});

//

describe("prepareAgentSpend multi-mint failover", () => {
  const MINT_A = "https://a.mint";
  const MINT_B = "https://b.mint";
  const DVM_PUBKEY = "02" + "ee".repeat(32);

  function proofAt(mint: string, secret: string, amount: number): AgentProof {
    return { ...proof(secret, amount), mint };
  }

  function router(
    map: Partial<Record<string, Wallet | Error>>
  ): (mintUrl: string) => Promise<Wallet> {
    return (mintUrl: string) => {
      const entry = map[mintUrl];
      if (entry === undefined) return Promise.reject(new Error(`unexpected mint ${mintUrl}`));
      if (entry instanceof Error) return Promise.reject(entry);
      return Promise.resolve(entry);
    };
  }

  function mockWalletState(privkey: string, pubkey: string, proofs: AgentProof[]): void {
    vi.mocked(loadAgentWallet).mockImplementation(() => {
      const calls = vi.mocked(saveAgentWallet).mock.calls;
      return calls.length > 0 ? calls[calls.length - 1][0] : baseWallet(privkey, pubkey, proofs);
    });
  }

  const healthySwap: SwapResult = {
    send: [{ id: "k1", amount: 5, secret: "dvm-locked", C: "02DEAD" }],
    keep: [],
  };

  function spend(getWalletForMint: (mintUrl: string) => Promise<Wallet>, mints = [MINT_A, MINT_B]) {
    return prepareAgentSpend({
      amountSats: 5,
      endpoint: ENDPOINT,
      cashuP2pk: { mints, lock_pubkey: DVM_PUBKEY },
      now: () => FIXED_NOW,
      uuid: () => FIXED_UUID,
      inFlightTimeoutSec: 60,
      getWalletForMint,
    });
  }

  it("completes at the healthy mint when the first one can't be reached", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    mockWalletState(privkey, pubkey, [proofAt(MINT_A, "a", 8), proofAt(MINT_B, "b", 8)]);

    const result = await spend(
      router({
        [MINT_A]: new Error("Cannot connect to mint: https://a.mint"),
        [MINT_B]: makeMockWallet(healthySwap),
      })
    );

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.mint).toBe(MINT_B);

    const saved = lastSavedWallet();
    expect(saved.pending_submissions).toHaveLength(1);
    expect(saved.pending_submissions[0].mint).toBe(MINT_B);
    expect(saved.proofs.find((p) => p.secret === "a")?.status).toBe("valid");
  });

  it("completes at the healthy mint when the first one rejects the swap, leaving nothing in flight behind it", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    mockWalletState(privkey, pubkey, [proofAt(MINT_A, "a", 8), proofAt(MINT_B, "b", 8)]);

    const result = await spend(
      router({
        [MINT_A]: makeMockWallet(
          new MintOperationError(
            11000,
            "Could not get fee. No keyset found for keyset id 007311aa2fa58cc8"
          )
        ),
        [MINT_B]: makeMockWallet(healthySwap),
      })
    );

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.mint).toBe(MINT_B);

    const saved = lastSavedWallet();
    expect(saved.proofs.find((p) => p.secret === "a")?.status).toBe("valid");
    expect(saved.proofs.find((p) => p.secret === "a")?.in_flight_until_ms).toBeUndefined();
    expect(saved.pending_submissions).toHaveLength(1);
    expect(saved.pending_submissions[0].request_id).toBe(FIXED_UUID);
    expect(saved.pending_submissions[0].mint).toBe(MINT_B);
    expect(saved.pending_submissions[0].output_proofs).toHaveLength(1);
  });

  it("reaches the same fallthrough when the first mint won't name a keyset", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    mockWalletState(privkey, pubkey, [proofAt(MINT_A, "a", 8), proofAt(MINT_B, "b", 8)]);

    const result = await spend(
      router({
        [MINT_A]: makeMockWallet(healthySwap, new Error("No keyset found")),
        [MINT_B]: makeMockWallet(healthySwap),
      })
    );

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.mint).toBe(MINT_B);
  });

  it("skips a mint that advertises swaps switched off without attempting the swap", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    mockWalletState(privkey, pubkey, [proofAt(MINT_A, "a", 8), proofAt(MINT_B, "b", 8)]);

    const meltOnly = makeMockWallet(healthySwap, 100, MELT_ONLY_MINT_NUTS);
    const healthy = makeMockWallet(healthySwap, 100, HEALTHY_MINT_NUTS);

    const result = await spend(router({ [MINT_A]: meltOnly, [MINT_B]: healthy }));

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.mint).toBe(MINT_B);
    expect(vi.mocked(meltOnly.ops.send)).not.toHaveBeenCalled();
    expect(lastSavedWallet().proofs.find((p) => p.secret === "a")?.status).toBe("valid");
  });

  it("names every mint it tried, and why, when none of them work", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    mockWalletState(privkey, pubkey, [proofAt(MINT_A, "a", 8), proofAt(MINT_B, "b", 8)]);

    const result = await spend(
      router({
        [MINT_A]: new Error("Cannot connect to mint: https://a.mint"),
        [MINT_B]: makeMockWallet(new Error("mint /v1/swap 500")),
      })
    );

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.code).toBe("swap_failed");
    expect(result.error.attempts).toEqual([
      { mint: MINT_A, reason: "unreachable", message: "Cannot connect to mint: https://a.mint" },
      { mint: MINT_B, reason: "swap_rejected", message: "mint /v1/swap 500" },
    ]);
    expect(result.error.message).toContain(MINT_A);
    expect(result.error.message).toContain(MINT_B);
    expect(result.error.message).toContain("unreachable");
  });

  it("keeps insufficient_balance when every mint is short, so the caller still falls through to another rail", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    mockWalletState(privkey, pubkey, [proofAt(MINT_A, "a", 5), proofAt(MINT_B, "b", 5)]);

    const result = await spend(
      router({
        [MINT_A]: makeMockWallet(healthySwap),
        [MINT_B]: makeMockWallet(healthySwap),
      })
    );

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.code).toBe("insufficient_balance");
    expect(result.error.attempts?.map((a) => a.mint)).toEqual([MINT_A, MINT_B]);
  });

  it("carries a candidate's own selection code when its balance vanished between locks", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const withA = [proofAt(MINT_A, "a", 6), proofAt(MINT_B, "b", 5)];
    const withoutA = [proofAt(MINT_B, "b", 5)];
    let loads = 0;
    vi.mocked(loadAgentWallet).mockImplementation(() => {
      loads += 1;
      return baseWallet(privkey, pubkey, loads === 1 ? withA : withoutA);
    });

    const result = await spend(
      router({
        [MINT_A]: makeMockWallet(healthySwap),
        [MINT_B]: makeMockWallet(healthySwap),
      })
    );

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.attempts?.map((a) => a.reason)).toEqual([
      "no_eligible_mint",
      "insufficient_balance",
    ]);
    expect(result.error.code).toBe("insufficient_balance");
  });

  it("hard-errors when a mint problem is mixed with a shortfall, rather than claiming a shortfall", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    mockWalletState(privkey, pubkey, [proofAt(MINT_A, "a", 6), proofAt(MINT_B, "b", 5)]);

    const result = await spend(
      router({
        [MINT_A]: new Error("Cannot connect to mint: https://a.mint"),
        [MINT_B]: makeMockWallet(healthySwap),
      })
    );

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.code).toBe("swap_failed");
    expect(result.error.attempts?.map((a) => a.reason)).toEqual([
      "unreachable",
      "insufficient_balance",
    ]);
  });

  it("doesn't tell an agent to wait out an in-flight timeout that isn't running", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    mockWalletState(privkey, pubkey, [proofAt(MINT_A, "a", 8), proofAt(MINT_B, "b", 8)]);

    const result = await spend(
      router({
        [MINT_A]: new Error("Cannot connect to mint: https://a.mint"),
        [MINT_B]: new Error("Cannot connect to mint: https://b.mint"),
      })
    );

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.hint).toContain("Retry now");
    expect(result.error.hint).not.toContain("in-flight timeout");
    expect(vi.mocked(saveAgentWallet)).not.toHaveBeenCalled();
  });

  it("tries at most once per mint, in the DVM's advertised order", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    mockWalletState(privkey, pubkey, [proofAt(MINT_A, "a", 8), proofAt(MINT_B, "b", 8)]);

    const loads: string[] = [];
    const walletA = makeMockWallet(new MintOperationError(11000, "swap down"));
    const walletB = makeMockWallet(new MintOperationError(11000, "swap down"));
    const result = await spend((mintUrl: string) => {
      loads.push(mintUrl);
      return Promise.resolve(mintUrl === MINT_A ? walletA : walletB);
    });

    expect("error" in result).toBe(true);
    expect(loads).toEqual([MINT_A, MINT_B]);
  });

  it("leaves a single-entry allowlist exactly as before — nothing to fail over to", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    mockWalletState(privkey, pubkey, [proofAt(MINT_A, "a", 8)]);

    const result = await spend(
      router({ [MINT_A]: makeMockWallet(new Error("mint /v1/swap 500")) }),
      [MINT_A]
    );

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.code).toBe("swap_failed");
    expect(result.error.message).toBe("Mint swap failed at https://a.mint: mint /v1/swap 500");
    expect(result.error.hint).toContain("dvm wallet show");
    const saved = lastSavedWallet();
    expect(saved.proofs.find((p) => p.secret === "a")?.status).toBe("in_flight");
    expect(saved.pending_submissions).toHaveLength(1);
    expect(saved.pending_submissions[0].output_proofs).toEqual([]);
    expect(saved.pending_submissions[0].swapping).toBeDefined();
  });

  it("tries a mint that failed the previous call again on the very next one", async () => {
    const { privkey, pubkey } = generateAgentKeypair();
    mockWalletState(privkey, pubkey, [proofAt(MINT_A, "a", 8), proofAt(MINT_B, "b", 8)]);

    let uuidSeq = 0;
    const call = (getWalletForMint: (mintUrl: string) => Promise<Wallet>) =>
      prepareAgentSpend({
        amountSats: 5,
        endpoint: ENDPOINT,
        cashuP2pk: { mints: [MINT_A, MINT_B], lock_pubkey: DVM_PUBKEY },
        now: () => FIXED_NOW,
        uuid: () => `req-${++uuidSeq}`,
        inFlightTimeoutSec: 60,
        getWalletForMint,
      });

    const first = await call(
      router({
        [MINT_A]: new Error("Cannot connect to mint: https://a.mint"),
        [MINT_B]: makeMockWallet(healthySwap),
      })
    );
    expect("error" in first).toBe(false);
    if ("error" in first) return;
    expect(first.mint).toBe(MINT_B);

    const second = await call(
      router({
        [MINT_A]: makeMockWallet({
          send: [{ id: "k1", amount: 5, secret: "dvm-locked-2", C: "02BEEF" }],
          keep: [],
        }),
        [MINT_B]: makeMockWallet(healthySwap),
      })
    );
    expect("error" in second).toBe(false);
    if ("error" in second) return;
    expect(second.mint).toBe(MINT_A);
  });
});

describe("prepareAgentSpend refund clause", () => {
  const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
  const CANONICAL_ID = "42";
  const DVM_PUBKEY = "02" + "ee".repeat(32);

  async function spendWith(
    offer: Partial<Parameters<typeof prepareAgentSpend>[0]["cashuP2pk"]>,
    extra: Partial<Parameters<typeof prepareAgentSpend>[0]> = {}
  ) {
    const { privkey, pubkey } = generateAgentKeypair();
    vi.mocked(loadAgentWallet).mockImplementation(() => {
      const calls = vi.mocked(saveAgentWallet).mock.calls;
      return calls.length > 0
        ? calls[calls.length - 1][0]
        : baseWallet(privkey, pubkey, [proof("input-a", 16)]);
    });
    const mockWallet = makeMockWallet({
      send: [{ id: "k1", amount: 7, secret: "dvm-locked-1", C: "02DEAD" }],
      keep: [],
    });
    const result = await prepareAgentSpend({
      amountSats: 7,
      endpoint: ENDPOINT,
      cashuP2pk: { mints: ["https://mint.example"], lock_pubkey: DVM_PUBKEY, ...offer },
      now: () => FIXED_NOW,
      uuid: () => FIXED_UUID,
      inFlightTimeoutSec: 60,
      getWalletForMint: () => Promise.resolve(mockWallet),
      readMnemonic: () => MNEMONIC,
      ...extra,
    });
    const builder = vi.mocked(mockWallet.ops.send).mock.results[0]?.value as {
      asP2PK: ReturnType<typeof vi.fn>;
    };
    return { result, asP2PK: builder.asP2PK };
  }

  it("locks outputs with a locktime and the per-DVM refund pubkey", async () => {
    const { result, asP2PK } = await spendWith({ canonical_id: CANONICAL_ID });
    expect("error" in result).toBe(false);

    const opts = asP2PK.mock.calls[0][0] as {
      pubkey: string;
      locktime: number;
      refundKeys: string[];
    };
    expect(opts.pubkey).toBe(DVM_PUBKEY);
    expect(opts.locktime).toBe(Math.floor(FIXED_NOW / 1000) + 48 * 3600);
    expect(opts.refundKeys).toEqual(["02a3e7f5e3a1ef088c5c0b8d23c0ccfeaa5efd0dd6031907bcae4bdce520d5b8b5"]);

    const sub = lastSavedWallet().pending_submissions[0];
    expect(sub.canonical_id).toBe(CANONICAL_ID);
    expect(sub.refund_pubkey).toBe("02a3e7f5e3a1ef088c5c0b8d23c0ccfeaa5efd0dd6031907bcae4bdce520d5b8b5");
    expect(sub.t_expire).toBe(opts.locktime * 1000);
  });

  it("clamps the locktime up to the DVM's advertised min_locktime", async () => {
    const { asP2PK } = await spendWith({
      canonical_id: CANONICAL_ID,
      min_locktime: 7 * 24 * 3600,
    });
    const opts = asP2PK.mock.calls[0][0] as { locktime: number };
    expect(opts.locktime).toBe(Math.floor(FIXED_NOW / 1000) + 7 * 24 * 3600);
  });

  it("never takes an explicit locktime below the builder's floor", async () => {
    const { asP2PK } = await spendWith(
      { canonical_id: CANONICAL_ID, min_locktime: 7 * 24 * 3600 },
      { locktimeSeconds: 60 }
    );
    const opts = asP2PK.mock.calls[0][0] as { locktime: number };
    expect(opts.locktime).toBe(Math.floor(FIXED_NOW / 1000) + 7 * 24 * 3600);
  });

  it("ships an unclaused lock when the DVM advertises no canonical_id", async () => {
    const { result, asP2PK } = await spendWith({});
    expect("error" in result).toBe(false);
    expect(asP2PK.mock.calls[0][0]).toEqual({ pubkey: DVM_PUBKEY });
    const sub = lastSavedWallet().pending_submissions[0];
    expect(sub.canonical_id).toBeUndefined();
    expect(sub.t_expire).toBeUndefined();
  });

  it("ships an unclaused lock when the wallet has no mnemonic", async () => {
    const { result, asP2PK } = await spendWith(
      { canonical_id: CANONICAL_ID },
      { readMnemonic: () => null }
    );
    expect("error" in result).toBe(false);
    expect(asP2PK.mock.calls[0][0]).toEqual({ pubkey: DVM_PUBKEY });
    expect(lastSavedWallet().pending_submissions[0].t_expire).toBeUndefined();
  });
});
