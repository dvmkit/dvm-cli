vi.mock("../../cli-identity-resolve", async () => ({ ...(await vi.importActual<typeof import("../../cli-identity-resolve")>("../../cli-identity-resolve")), findSigningIdentityByPubkey: vi.fn() }));
vi.mock("../../job-store", async () => ({ ...(await vi.importActual<typeof import("../../job-store")>("../../job-store")), saveJob: vi.fn() }));
vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
 ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
 loadAgentWallet: vi.fn(),
saveAgentWallet: vi.fn(),
withWalletLock: vi.fn(<T>(fn: () => Promise<T> | T) => Promise.resolve(fn())),
WALLET_VERSION: 5 as const,
RECENT_SPENDS_CAP: 10 as const,
saveJob: vi.fn(),
findSigningIdentityByPubkey: vi.fn(),
loadCredit: vi.fn(),
recordFundResponse: vi.fn(),
recordBalanceResponse: vi.fn()
}));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cashu/cashu-ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("@cashu/cashu-ts")>()), ...(() => ({
  getEncodedToken: vi.fn((token: { mint: string; proofs: { secret: string }[] }) => {
    const secrets = token.proofs.map((p) => p.secret).join(",");
    return `cashu:${token.mint}:${secrets}`;
  }),
  Amount: {
    from: (n: number) => ({ toNumber: () => n }),
  },
  CheckStateEnum: { UNSPENT: "UNSPENT", PENDING: "PENDING", SPENT: "SPENT" },
  OutputData: class {
    constructor(
      public blindedMessage: { amount: { toNumber: () => number }; B_: string; id: string },
      public blindingFactor: bigint,
      public secret: Uint8Array
    ) {}

    toProof(signature: { id: string; C_: string; dleq?: { e: string; s: string; r?: string } }) {
      return {
        id: signature.id,
        amount: this.blindedMessage.amount,
        secret: new TextDecoder().decode(this.secret),
        C: signature.C_,
        ...(signature.dleq ? { dleq: signature.dleq } : {}),
      };
    }
  },
}))() }));

import type { Wallet } from "@cashu/cashu-ts";
import { schnorr } from "@noble/curves/secp256k1.js";

import { attestedDvm } from "../../__tests__/fixtures/receipt-fixture";
import {
  deriveAgentRefundSubkeyPubkey,
} from "@dvmkit/sdk/internal";
import { type JsonValue, verifyCanonicalSignedRequest } from "@dvmkit/sdk/internal";
import { findSigningIdentityByPubkey } from "../../cli-identity-resolve";
import {
  loadCredit,
  recordBalanceResponse,
  recordFundResponse,
  type StoredCredit,
} from "@dvmkit/sdk/internal";
import { saveJob } from "../../job-store";
import { readFileSync, rmSync } from "node:fs";
import {
  recordSubmissionEvidence,
  SUBMISSION_EVIDENCE_DIR,
} from "../../submission-evidence";
import { RECEIPTS_FILE } from "@dvmkit/sdk/internal";
function storedFundingReceipts() {
  return readFileSync(RECEIPTS_FILE, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}
import {
  recoverPendingSubmission,
  RESUME_MAX_ATTEMPTS,
  sweepPendingSubmissions,
} from "../recovery-submissions";
import {
  type AgentProof,
  type AgentWallet,
  loadAgentWallet,
  type PendingSubmission,
  type PendingSubmissionContext,
  saveAgentWallet,
  WALLET_VERSION,
  withWalletLock,
} from "@dvmkit/sdk/internal";
import {
  cashuSubmissionBindingFingerprint,
  cashuSubmissionBindingFromContext,
} from "@dvmkit/sdk/internal";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const ENDPOINT = "https://api.example.com";
const CREATED_AT = "2026-05-09T00:00:00.000Z";
const NOW_MS = Date.parse(CREATED_AT) + 10 * 60 * 1000;
const now = () => NOW_MS;

function proof(secret: string, amount: number): AgentProof {
  return {
    mint: "https://mint.example",
    secret,
    C: "02DEAD",
    amount,
    id: "k1",
    locked_to_pubkey: "02" + "ee".repeat(32),
    status: "valid",
  };
}

const JOB_DOMAIN = {
  audience: { dvm_id: "scribe", builder_pubkey: "cc".repeat(32) },
  method: "POST", path: "/v1/job", capability: "summarize",
};
const CREDIT_DOMAIN = { ...JOB_DOMAIN, path: "/v1/credit", capability: null };

function context(overrides: Partial<PendingSubmissionContext> = {}): PendingSubmissionContext {
  return {
    submit_body: { input: "hello", capability: "summarize" },
    dvm_id: "scribe",
    capability: "summarize",
    auth_domain: JOB_DOMAIN,
    ...overrides,
  };
}

function submission(overrides: Partial<PendingSubmission> = {}): PendingSubmission {
  return {
    endpoint: ENDPOINT,
    request_id: REQUEST_ID,
    intended_lock_pubkey: "02" + "ee".repeat(32),
    mint: "https://mint.example",
    amount_sats: 5,
    output_proofs: [proof("out-1", 5)],
    created_at: CREATED_AT,
    context: context(),
    ...overrides,
  };
}

function strictSubmission(
  overrides: Partial<PendingSubmission> = {},
  contextOverrides: Partial<PendingSubmissionContext> = {}
): { entry: PendingSubmission; bindingFingerprint: string } {
  const strictContext: PendingSubmissionContext = {
    submit_body: {
      input: "",
      capability: "fetch",
      data: { url: "https://example.com", tier: "fast", format: "markdown" },
      bid_msats: 5_000,
    },
    dvm_id: "dvmkit--scrape",
    capability: "fetch",
    pinned_mint: "https://mint.example",
    policy: {
      maxTotalMsats: 5_000,
      autoPayBelowMsats: 5_000,
      maxIncrementMsats: 5_000,
      maxPayments: 1,
    },
    strict_per_call: true,
    max_cashu_fee_sats: 2,
    initial_cashu_fee_sats: 2,
    ...contextOverrides,
  };
  const binding = cashuSubmissionBindingFromContext(strictContext);
  if (!binding) throw new Error("strict recovery fixture must be bindable");
  const bindingFingerprint = cashuSubmissionBindingFingerprint(binding);
  return {
    bindingFingerprint,
    entry: submission({
      max_cashu_fee_sats: 2,
      initial_cashu_fee_sats: 2,
      context: { ...strictContext, binding_fingerprint: bindingFingerprint },
      ...overrides,
    }),
  };
}

function baseWallet(pending: PendingSubmission[] = []): AgentWallet {
  return {
    version: WALLET_VERSION,
    lock_privkey: "ab".repeat(32),
    lock_pubkey: "02" + "cd".repeat(32),
    mnemonic_fingerprint: null,
    mints: ["https://mint.example"],
    proofs: [],
    nut13_counters: {},
    pending_mints: [],
    pending_melts: [],
    pending_submissions: pending,
    recent_spends: [],
    created_at: CREATED_AT,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(recordFundResponse).mockReset();
});

describe("recoverPendingSubmission exact strict recovery", () => {
  it("holds the wallet lock, marks one attempt before I/O, and preserves unrelated submissions", async () => {
    const exact = strictSubmission();
    const unrelated = submission({
      request_id: "22222222-2222-4222-8222-222222222222",
      endpoint: "https://other.example",
      output_proofs: [proof("unrelated-output", 7)],
    });
    const unrelatedBytes = JSON.stringify(unrelated);
    vi.mocked(loadAgentWallet).mockImplementation(() => {
      const saved = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
      return saved ?? baseWallet([exact.entry, unrelated]);
    });
    const httpPost = vi.fn().mockImplementation(async () => {
      const attempted = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
      expect(
        attempted?.pending_submissions.find((entry) => entry.request_id === REQUEST_ID)
      ).toMatchObject({
        attempts: 1,
        last_attempt_at: new Date(NOW_MS).toISOString(),
      });
      expect(
        JSON.stringify(
          attempted?.pending_submissions.find(
            (entry) => entry.request_id === "22222222-2222-4222-8222-222222222222"
          )
        )
      ).toBe(unrelatedBytes);
      return { status: 202, body: { job_id: "job-exact" } };
    });

    const result = await recoverPendingSubmission({
      requestId: REQUEST_ID,
      bindingFingerprint: exact.bindingFingerprint,
      httpPost,
      now,
    });

    expect(withWalletLock).toHaveBeenCalledTimes(1);
    expect(httpPost).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `${ENDPOINT}/v1/job`,
        headers: expect.objectContaining({ "X-Cashu-Request-Id": REQUEST_ID }),
      })
    );
    expect(result).toEqual({
      requestId: REQUEST_ID,
      outcome: "shipped",
      jobId: "job-exact",
      attemptCount: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(/cashu:|proof|secret|witness|signature/i);
    const finalWallet = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(finalWallet?.pending_submissions.map((entry) => entry.request_id)).toEqual([
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(JSON.stringify(finalWallet?.pending_submissions[0])).toBe(unrelatedBytes);
  });

  it("durably consumes the only same-ID attempt after an unknown network outcome", async () => {
    const exact = strictSubmission();
    vi.mocked(loadAgentWallet).mockImplementation(() => {
      const saved = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
      return saved ?? baseWallet([exact.entry]);
    });
    const httpPost = vi.fn().mockRejectedValue(new Error("connection reset after write"));

    await expect(
      recoverPendingSubmission({
        requestId: REQUEST_ID,
        bindingFingerprint: exact.bindingFingerprint,
        httpPost,
        now,
      })
    ).resolves.toMatchObject({ outcome: "pending", attemptCount: 1 });
    await expect(
      recoverPendingSubmission({
        requestId: REQUEST_ID,
        bindingFingerprint: exact.bindingFingerprint,
        httpPost,
        now,
      })
    ).rejects.toMatchObject({ code: "submission_recovery_exhausted" });

    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0].pending_submissions[0]).toMatchObject({
      request_id: REQUEST_ID,
      attempts: 1,
    });
  });

  it("rejects the same endpoint, mint, and amount when the exact request body changed", async () => {
    const approved = strictSubmission();
    const approvedContext = approved.entry.context;
    if (!approvedContext) throw new Error("strict fixture is missing its submission context");
    const changed = strictSubmission(
      {},
      {
        submit_body: {
          ...approvedContext.submit_body,
          data: { url: "https://different.example", tier: "fast", format: "markdown" },
        },
      }
    );
    const changedContext = changed.entry.context;
    if (!changedContext) throw new Error("strict fixture is missing its changed context");
    changed.entry.context = {
      ...changedContext,
      binding_fingerprint: approved.bindingFingerprint,
    };
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([changed.entry]));
    const httpPost = vi.fn();

    await expect(
      recoverPendingSubmission({
        requestId: REQUEST_ID,
        bindingFingerprint: approved.bindingFingerprint,
        httpPost,
        now,
      })
    ).rejects.toMatchObject({ code: "submission_binding_mismatch" });

    expect(httpPost).not.toHaveBeenCalled();
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  describe("after the provider accepted it without a settled job identity", () => {
    afterEach(() => rmSync(SUBMISSION_EVIDENCE_DIR, { recursive: true, force: true }));

    it("refuses a marked entry with no POST", async () => {
      const exact = strictSubmission({
        accepted_unresolved: {
          kind: "identity_mismatch",
          observed_at: CREATED_AT,
          header_job_id: "job-a",
          body_job_id: "job-b",
          ambiguity_id: REQUEST_ID,
        },
      });
      vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([exact.entry]));
      const httpPost = vi.fn();

      await expect(
        recoverPendingSubmission({
          requestId: REQUEST_ID,
          bindingFingerprint: exact.bindingFingerprint,
          httpPost,
          now,
        })
      ).rejects.toMatchObject({ code: "submission_accepted_unresolved" });
      expect(httpPost).not.toHaveBeenCalled();
    });

    it("writes the missing marker from an evidence record and refuses, with no POST", async () => {
      const exact = strictSubmission();
      vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([exact.entry]));
      recordSubmissionEvidence({
        observation: { kind: "body_unreadable", headerJobId: "job-a" },
        endpoint: ENDPOINT,
        cashuRequestId: REQUEST_ID,
        rail: "cashu",
      });
      const httpPost = vi.fn();

      await expect(
        recoverPendingSubmission({
          requestId: REQUEST_ID,
          bindingFingerprint: exact.bindingFingerprint,
          httpPost,
          now,
        })
      ).rejects.toMatchObject({ code: "submission_accepted_unresolved" });
      expect(httpPost).not.toHaveBeenCalled();
      expect(withWalletLock).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0].pending_submissions[0].accepted_unresolved
      ).toMatchObject({ kind: "body_unreadable", header_job_id: "job-a", ambiguity_id: REQUEST_ID });
    });

    it("marks the entry and refuses when the one attempt meets an unsettled identity", async () => {
      const exact = strictSubmission();
      vi.mocked(loadAgentWallet).mockImplementation(() => {
        const saved = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
        return saved ?? baseWallet([exact.entry]);
      });
      const httpPost = vi.fn().mockResolvedValue({
        status: 202,
        body: { job_id: "job-b" },
        jobIdentity: "job-a",
      });

      await expect(
        recoverPendingSubmission({
          requestId: REQUEST_ID,
          bindingFingerprint: exact.bindingFingerprint,
          httpPost,
          now,
        })
      ).rejects.toMatchObject({
        code: "provider_identity_mismatch",
        data: { ambiguity_id: REQUEST_ID, cashu_request_id: REQUEST_ID, claim_stored: false },
      });
      expect(httpPost).toHaveBeenCalledTimes(1);
      expect(saveJob).not.toHaveBeenCalled();
      const persisted = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
      expect(persisted?.pending_submissions[0].accepted_unresolved).toMatchObject({
        kind: "identity_mismatch",
        header_job_id: "job-a",
        body_job_id: "job-b",
      });
      expect(persisted?.recent_spends).toEqual([]);
    });
  });
});

describe("sweepPendingSubmissions (crash-resume)", () => {
  it("refuses to sign or post signed job and credit recovery without a persisted domain", async () => {
    vi.mocked(findSigningIdentityByPubkey).mockReturnValue({
      privkey: "aa".repeat(32), pubkey: "bb".repeat(32),
      source: { kind: "sole", name: "default" },
    });
    for (const route of [undefined, "credit"] as const) {
      vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([submission({ context: context({
        route, auth_domain: undefined, signing_pubkey: "bb".repeat(32),
        credit_body: { op: "fund" },
      }) })]));
      const httpPost = vi.fn().mockResolvedValue({ status: 200, body: { job_id: "job-refused" } });
      const result = await sweepPendingSubmissions({ httpPost, now });
      expect(result.outcomes[0].kind).toBe("unresumable");
      expect(httpPost).not.toHaveBeenCalled();
      expect(saveAgentWallet).not.toHaveBeenCalled();
    }
  });
  it("returns empty outcomes when there are no pending submissions", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([]));
    const result = await sweepPendingSubmissions();
    expect(result.outcomes).toEqual([]);
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("re-POSTs the original request body alongside the payment headers", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([submission()]));
    const httpPost = vi.fn().mockResolvedValue({ status: 200, body: { job_id: "job-1" } });

    const result = await sweepPendingSubmissions({ httpPost, now });
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].kind).toBe("shipped");
    const saved = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(saved?.pending_submissions).toEqual([]);
    expect(saved?.recent_spends).toMatchObject([{ request_id: REQUEST_ID }]);
    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(recordBalanceResponse).not.toHaveBeenCalled();

    expect(httpPost).toHaveBeenCalledWith({
      url: `${ENDPOINT}/v1/job`,
      headers: expect.objectContaining({
        "Content-Type": "application/json",
        "X-Cashu-Request-Id": REQUEST_ID,
        "X-Cashu": expect.stringContaining("cashu:https://mint.example:out-1"),
      }),
      body: JSON.stringify({ input: "hello", capability: "summarize" }),
    });
  });

  it("writes a local job record from a successful re-ship so the caller can `dvm status` it", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([submission()]));
    const httpPost = vi.fn().mockResolvedValue({
      status: 202,
      body: { job_id: "job-42", job_token: "tok-1" },
      feedbackClaim: "router-claim",
    });

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0]).toMatchObject({ kind: "shipped", jobId: "job-42" });
    expect(saveJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "job-42",
        endpoint: ENDPOINT,
        dvmId: "scribe",
        feedbackClaim: "router-claim",
        capability: "summarize",
        status: "submitted",
        paymentMethod: "cashu",
        jobToken: "tok-1",
      })
    );
  });

  it("treats 409 replay as already-accepted — the DVM took the original spend", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([submission()]));
    const httpPost = vi.fn().mockResolvedValue({ status: 409, body: { error: "replay_rejected" } });

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0].kind).toBe("already_accepted");
    const saved = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(saved?.pending_submissions).toHaveLength(0);
    expect(saved?.recent_spends).toHaveLength(1);
    expect(saveJob).not.toHaveBeenCalled();
  });

  it("retires replay after lock-key rotation while keeping the swapped proofs", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([submission()]));
    const httpPost = vi
      .fn()
      .mockResolvedValue({ status: 402, body: { error: "wrong_lock_pubkey" } });

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0].kind).toBe("abandoned");
    const saved = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(saved?.pending_submissions).toHaveLength(1);
    expect(saved?.pending_submissions[0].context).toBeUndefined();
    expect(saved?.recent_spends).toHaveLength(0);
  });

  it("keeps the entry and counts the attempt on a network error", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([submission()]));
    const httpPost = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0].kind).toBe("still_pending");
    const saved = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(saved?.pending_submissions).toHaveLength(1);
    expect(saved?.pending_submissions[0].attempts).toBe(1);
    expect(saved?.pending_submissions[0].last_attempt_at).toBe(new Date(NOW_MS).toISOString());
  });

  it("stops re-shipping once the attempt cap is hit, keeping the entry for the operator", async () => {
    const initial = baseWallet([submission({ attempts: RESUME_MAX_ATTEMPTS })]);
    const initialBytes = JSON.stringify(initial);
    vi.mocked(loadAgentWallet).mockReturnValue(initial);
    const httpPost = vi.fn();

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0].kind).toBe("stale");
    expect(httpPost).not.toHaveBeenCalled();
    expect(saveAgentWallet).not.toHaveBeenCalled();
    expect(JSON.stringify(initial)).toBe(initialBytes);
  });

  it("stops re-shipping an entry older than the resume window", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([submission()]));
    const httpPost = vi.fn();
    const twoDaysLater = () => Date.parse(CREATED_AT) + 2 * 24 * 60 * 60 * 1000;

    const result = await sweepPendingSubmissions({ httpPost, now: twoDaysLater });

    expect(result.outcomes[0].kind).toBe("stale");
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("never re-ships an entry with no persisted request body", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([submission({ context: undefined })]));
    const httpPost = vi.fn();

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0].kind).toBe("unresumable");
    expect(httpPost).not.toHaveBeenCalled();
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("holds an empty-output entry while its inputs are still in the in-flight window", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([submission({ output_proofs: [] })]));
    const httpPost = vi.fn();
    const tenSecondsLater = () => Date.parse(CREATED_AT) + 10_000;

    const result = await sweepPendingSubmissions({ httpPost, now: tenSecondsLater });

    expect(result.outcomes[0].kind).toBe("no_swap");
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("prunes an empty-output entry once its inputs have aged out of the in-flight window", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([submission({ output_proofs: [] })]));
    const httpPost = vi.fn();

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0].kind).toBe("pruned");
    expect(httpPost).not.toHaveBeenCalled();
    const saved = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(saved?.pending_submissions).toHaveLength(0);
  });

  it("restores an interrupted swap with its DLEQ and persists a shippable token", async () => {
    const input = { ...proof("input-1", 8), status: "in_flight" as const };
    const blinded = { amount: 5, B_: "02blind", id: "k1" };
    const pending = submission({
      output_proofs: [],
      swapping: {
        keyset_id: "k1",
        input_proofs: [input],
        unselected_proofs: [],
        send_outputs: [
          {
            blinded_message: blinded,
            blinding_factor: "01",
            secret: Buffer.from("restored-send").toString("hex"),
          },
        ],
        keep_outputs: [],
      },
    });
    vi.mocked(loadAgentWallet).mockReturnValue({
      ...baseWallet([pending]),
      proofs: [input],
    });
    const wallet = {
      mint: {
        restore: vi.fn().mockResolvedValue({
          outputs: [blinded],
          signatures: [
            {
              id: "k1",
              amount: 5,
              C_: "02restored",
              dleq: { e: "dleq-e", s: "dleq-s", r: "blind-r" },
            },
          ],
        }),
      },
      keyChain: { getKeyset: vi.fn().mockReturnValue({}) },
    } as unknown as Wallet;

    const result = await sweepPendingSubmissions({
      getWalletForMint: () => Promise.resolve(wallet),
      httpPost: vi.fn(),
      now,
    });

    expect(result.outcomes[0].kind).toBe("swap_restored");
    const saved = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(saved?.proofs).toEqual([]);
    expect(saved?.pending_submissions[0].swapping).toBeUndefined();
    expect(saved?.pending_submissions[0].cashu_token).toBe(
      "cashu:https://mint.example:restored-send"
    );
    expect(saved?.pending_submissions[0].output_proofs[0].dleq).toEqual({
      e: "dleq-e",
      s: "dleq-s",
      r: "blind-r",
    });
  });

  it("returns interrupted-swap inputs only after NUT-07 proves all are unspent", async () => {
    const input = {
      ...proof("input-1", 8),
      status: "in_flight" as const,
      in_flight_until_ms: NOW_MS - 1,
    };
    const pending = submission({
      output_proofs: [],
      swapping: {
        keyset_id: "k1",
        input_proofs: [input],
        unselected_proofs: [],
        send_outputs: [],
        keep_outputs: [],
      },
    });
    vi.mocked(loadAgentWallet).mockReturnValue({
      ...baseWallet([pending]),
      proofs: [input],
    });
    const wallet = {
      mint: { restore: vi.fn().mockRejectedValue(new Error("NUT-09 unavailable")) },
      checkProofsStates: vi.fn().mockResolvedValue([{ Y: "y", state: "UNSPENT", witness: null }]),
    } as unknown as Wallet;

    const result = await sweepPendingSubmissions({
      getWalletForMint: () => Promise.resolve(wallet),
      httpPost: vi.fn(),
      now,
    });

    expect(result.outcomes[0].kind).toBe("swap_reverted");
    const saved = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(saved?.pending_submissions).toEqual([]);
    expect(saved?.proofs[0].status).toBe("valid");
    expect(saved?.proofs[0].in_flight_until_ms).toBeUndefined();
  });

  it("returns empty when no wallet", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(null);
    const result = await sweepPendingSubmissions();
    expect(result.outcomes).toEqual([]);
  });
});

describe("descriptor-auth resumes are re-signed, not replayed", () => {
  const PRIVKEY = "11".repeat(32);
  const PUBKEY = Buffer.from(schnorr.getPublicKey(Buffer.from(PRIVKEY, "hex"))).toString("hex");

  function signedSubmission(): PendingSubmission {
    return submission({
      context: context({
        submit_body: { input: "hello", capability: "add-episode", data: { url: "https://x.test" } },
        signing_pubkey: PUBKEY,
        auth_domain: { ...JOB_DOMAIN, capability: "add-episode" },
      }),
    });
  }

  it("signs a fresh envelope over the persisted body on every attempt", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([signedSubmission()]));
    vi.mocked(findSigningIdentityByPubkey).mockReturnValue({
      privkey: PRIVKEY,
      pubkey: PUBKEY,
      source: { kind: "pubkey", name: "me" },
    });
    const httpPost = vi.fn().mockResolvedValue({ status: 200, body: { job_id: "job-1" } });

    await sweepPendingSubmissions({ httpPost, now });

    const body = JSON.parse(httpPost.mock.calls[0][0].body as string) as {
      input: string;
      data: Record<string, unknown> & { signature: string; pubkey: string; timestamp: number };
    };
    expect(body.input).toBe("hello");
    expect(body.data.url).toBe("https://x.test");
    expect(body.data.pubkey).toBe(PUBKEY);
    expect(Math.abs(body.data.timestamp - Math.floor(Date.now() / 1000))).toBeLessThan(60);
    const { signature, auth_statement: authStatement, ...input } = body.data;
    expect(
      verifyCanonicalSignedRequest(
        { ...(authStatement as Record<string, JsonValue>), input } as JsonValue,
        signature,
        PUBKEY
      )
    ).toBe(true);
  });

  it("is unresumable — with no POST attempted — when the caller identity is gone", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([signedSubmission()]));
    vi.mocked(findSigningIdentityByPubkey).mockReturnValue(null);
    const httpPost = vi.fn();

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0].kind).toBe("unresumable");
    expect(httpPost).not.toHaveBeenCalled();
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });
});

describe("sweepPendingSubmissions — credit entries", () => {
  const CREDIT_CTX: PendingSubmissionContext = {
    submit_body: {},
    route: "credit",
    auth_domain: CREDIT_DOMAIN,
    credit_body: {
      op: "fund",
      credit_id: "credit-1",
      fund: { amount_micro: 350_000, fund_id: "fund-1", commitment: "ab".repeat(32) },
    },
    signing_pubkey: "bb".repeat(32),
  };

  it("prefers the persisted verbatim token over re-encoding from proofs", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(
      baseWallet([submission({ cashu_token: "cashu:VERBATIM" })])
    );
    const httpPost = vi.fn().mockResolvedValue({ status: 200, body: { job_id: "job-1" } });

    await sweepPendingSubmissions({ httpPost, now });

    expect(httpPost).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Cashu": "cashu:VERBATIM" }),
      })
    );
  });

  it("re-ships a credit top-up to /v1/credit with a freshly signed body", async () => {
    vi.mocked(findSigningIdentityByPubkey).mockReturnValue({
      privkey: "aa".repeat(32),
      pubkey: "bb".repeat(32),
      source: { kind: "sole", name: "default" },
    });
    vi.mocked(loadAgentWallet).mockReturnValue(
      baseWallet([submission({ context: CREDIT_CTX, cashu_token: "cashu:FUND" })])
    );
    const httpPost = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        op: "fund",
        funded_micro: 350_000,
        replayed: true,
        credit: {
          credit_id: "credit-1",
          currency: "usd",
          balance_micro: 350_000,
          remaining_micro: 350_000,
          expiry_ms: 1,
          expired: false,
          drainable: true,
          ledger_seq: 2,
        },
      },
    });

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0].kind).toBe("shipped");
    const call = httpPost.mock.calls[0][0] as { url: string; body: string };
    expect(call.url).toBe(`${ENDPOINT}/v1/credit`);
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body.op).toBe("fund");
    expect(body.credit_id).toBe("credit-1");
    expect(body.signature).toBeTruthy();
    expect((body.fund as Record<string, unknown>).commitment).toBe("ab".repeat(32));
    expect(saveJob).not.toHaveBeenCalled();
  });

  it("a credit entry whose signer is gone is unresumable, never dropped", async () => {
    vi.mocked(findSigningIdentityByPubkey).mockReturnValue(null);
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([submission({ context: CREDIT_CTX })]));
    const httpPost = vi.fn();

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0].kind).toBe("unresumable");
    expect(httpPost).not.toHaveBeenCalled();
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("retires a permanent credit refusal without deleting or replaying its proofs", async () => {
    vi.mocked(findSigningIdentityByPubkey).mockReturnValue({
      privkey: "aa".repeat(32),
      pubkey: "bb".repeat(32),
      source: { kind: "sole", name: "default" },
    });
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([submission({ context: CREDIT_CTX })]));
    const httpPost = vi
      .fn()
      .mockResolvedValue({ status: 400, body: { error: "credit_id_unavailable" } });

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0]).toMatchObject({
      kind: "abandoned",
      reason: "credit_id_unavailable",
    });
    const saved = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(saved?.pending_submissions).toHaveLength(1);
    expect(saved?.pending_submissions[0].output_proofs).toEqual(submission().output_proofs);
    expect(saved?.pending_submissions[0].context).toBeUndefined();
    vi.mocked(loadAgentWallet).mockReturnValue(saved!);
    const retry = await sweepPendingSubmissions({ httpPost, now });
    expect(retry.outcomes[0].kind).toBe("unresumable");
    expect(httpPost).toHaveBeenCalledTimes(1);
  });

  it("abandons a credit-route fund-amount mismatch — that route checks the hash only", async () => {
    vi.mocked(findSigningIdentityByPubkey).mockReturnValue({
      privkey: "aa".repeat(32),
      pubkey: "bb".repeat(32),
      source: { kind: "sole", name: "default" },
    });
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([submission({ context: CREDIT_CTX })]));
    const httpPost = vi.fn().mockResolvedValue({
      status: 402,
      body: { error: "funding_commitment_mismatch", expected_micro: 999_999 },
    });

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0]).toMatchObject({
      kind: "abandoned",
      reason: "funding_commitment_mismatch",
    });
    expect(httpPost).toHaveBeenCalledTimes(1);
  });
});

describe("sweepPendingSubmissions — fund-amount correction", () => {
  const SIGNED_MICRO = 4_800;
  const PROVIDER_MICRO = 4_761;
  const COMMITMENT = "cd".repeat(32);

  function fundEntry(): PendingSubmission {
    return submission({
      cashu_token: "cashu:FUND",
      context: context({
        signing_pubkey: "bb".repeat(32),
        submit_body: {
          capability: "summarize",
          data: {
            action: "go",
            credit_id: "c1",
            draw_id: "d1",
            fund: { amount_micro: SIGNED_MICRO, commitment: COMMITMENT },
          },
        },
      }),
    });
  }

  function shippedFund(httpPost: ReturnType<typeof vi.fn>, n: number): Record<string, unknown> {
    const call = httpPost.mock.calls[n][0] as { body: string };
    const body = JSON.parse(call.body) as { data: Record<string, unknown> };
    return body.data.fund as Record<string, unknown>;
  }

  beforeEach(() => {
    vi.mocked(findSigningIdentityByPubkey).mockReturnValue({
      privkey: "aa".repeat(32),
      pubkey: "bb".repeat(32),
      source: { kind: "sole", name: "default" },
    });
  });

  it("re-signs the same token with the provider's figure and lands, funding once", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([fundEntry()]));
    const httpPost = vi
      .fn()
      .mockResolvedValueOnce({
        status: 402,
        body: { error: "funding_commitment_mismatch", expected_micro: PROVIDER_MICRO },
      })
      .mockResolvedValueOnce({ status: 200, body: { job_id: "job-9" } });

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0]).toMatchObject({ kind: "shipped", jobId: "job-9" });
    expect(httpPost).toHaveBeenCalledTimes(2);
    expect(shippedFund(httpPost, 0).amount_micro).toBe(SIGNED_MICRO);
    expect(shippedFund(httpPost, 1).amount_micro).toBe(PROVIDER_MICRO);
    expect(shippedFund(httpPost, 1).commitment).toBe(COMMITMENT);
    expect(saveJob).toHaveBeenCalledWith(expect.objectContaining({ id: "job-9" }));
  });

  it("sends the corrected block without the public request ID the refused data bound", async () => {
    const entry = fundEntry();
    const data = entry.context!.submit_body.data as Record<string, unknown>;
    entry.context!.submit_body.data = { ...data, request_id: "req-1" };
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([entry]));
    const httpPost = vi
      .fn()
      // The read-back under the ID finds no job: the refused POST created none.
      .mockResolvedValueOnce({ status: 404, body: { error: "request_not_found", status: "unknown" } })
      .mockResolvedValueOnce({
        status: 402,
        body: { error: "funding_commitment_mismatch", expected_micro: PROVIDER_MICRO },
      })
      .mockResolvedValueOnce({ status: 200, body: { job_id: "job-9" } });

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0]).toMatchObject({ kind: "shipped", jobId: "job-9" });
    expect(httpPost).toHaveBeenCalledTimes(3);
    expect((httpPost.mock.calls[0][0] as { url: string }).url).toContain("/v1/request-result/req-1");
    const refused = JSON.parse((httpPost.mock.calls[1][0] as { body: string }).body) as { data: Record<string, unknown> };
    const corrected = JSON.parse((httpPost.mock.calls[2][0] as { body: string }).body) as { data: Record<string, unknown> };
    expect(refused.data.request_id).toBe("req-1");
    expect(corrected.data).not.toHaveProperty("request_id");
    expect(shippedFund(httpPost, 2).amount_micro).toBe(PROVIDER_MICRO);
    const written = vi.mocked(saveAgentWallet).mock.calls[0][0];
    expect(written.pending_submissions[0].context?.submit_body.data).not.toHaveProperty("request_id");
  });

  it("persists the corrected figure BEFORE the corrected body goes on the wire", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([fundEntry()]));
    const httpPost = vi
      .fn()
      .mockResolvedValueOnce({
        status: 402,
        body: { error: "funding_commitment_mismatch", expected_micro: PROVIDER_MICRO },
      })
      .mockResolvedValueOnce({ status: 200, body: { job_id: "job-9" } });

    await sweepPendingSubmissions({ httpPost, now });

    const written = vi.mocked(saveAgentWallet).mock.calls[0][0];
    const ctx = written.pending_submissions[0].context;
    const data = ctx?.submit_body.data as Record<string, unknown>;
    expect((data.fund as Record<string, unknown>).amount_micro).toBe(PROVIDER_MICRO);
    expect(vi.mocked(saveAgentWallet).mock.invocationCallOrder[0]).toBeLessThan(
      httpPost.mock.invocationCallOrder[1]
    );
  });

  it("abandons the commitment-hash branch, which no re-sign can fix", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([fundEntry()]));
    const httpPost = vi.fn().mockResolvedValue({
      status: 402,
      body: {
        error: "funding_commitment_mismatch",
        message: "fund.commitment does not match the SHA-256 of the attached funding artifact.",
      },
    });

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0]).toMatchObject({
      kind: "abandoned",
      reason: "funding_commitment_mismatch",
    });
    expect(httpPost).toHaveBeenCalledTimes(1);
  });

  it("holds — never abandons — when the provider states back the figure we already signed", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([fundEntry()]));
    const httpPost = vi.fn().mockResolvedValue({
      status: 402,
      body: { error: "funding_commitment_mismatch", expected_micro: SIGNED_MICRO },
    });

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0]).toMatchObject({
      kind: "still_pending",
      reason: "funding_commitment_mismatch",
    });
    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0].pending_submissions).toHaveLength(1);
  });

  it("holds on a malformed expected_micro rather than reading it as the hash branch", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([fundEntry()]));
    const httpPost = vi.fn().mockResolvedValue({
      status: 402,
      body: { error: "funding_commitment_mismatch", expected_micro: -1, message: "refused" },
    });

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0]).toMatchObject({
      kind: "still_pending",
      reason: "funding_commitment_mismatch",
    });
    const persisted = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(persisted?.pending_submissions).toHaveLength(1);
  });

  it("still corrects off the message when expected_micro itself is unusable", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([fundEntry()]));
    const httpPost = vi
      .fn()
      .mockResolvedValueOnce({
        status: 402,
        body: {
          error: "funding_commitment_mismatch",
          expected_micro: 0,
          message: `fund.amount_micro (${String(SIGNED_MICRO)}) does not match the attached token's value at the quoted price (${String(PROVIDER_MICRO)}).`,
        },
      })
      .mockResolvedValueOnce({ status: 200, body: { job_id: "job-9" } });

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0]).toMatchObject({ kind: "shipped", jobId: "job-9" });
    expect(shippedFund(httpPost, 1).amount_micro).toBe(PROVIDER_MICRO);
  });

  it("holds the entry when the corrected figure is refused too, never dropping it", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([fundEntry()]));
    const httpPost = vi
      .fn()
      .mockResolvedValueOnce({
        status: 402,
        body: { error: "funding_commitment_mismatch", expected_micro: PROVIDER_MICRO },
      })
      .mockResolvedValueOnce({
        status: 402,
        body: { error: "funding_commitment_mismatch", expected_micro: 4_700 },
      });

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0]).toMatchObject({
      kind: "still_pending",
      reason: "funding_commitment_mismatch",
    });
    expect(httpPost).toHaveBeenCalledTimes(2);
    const persisted = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(persisted?.pending_submissions).toHaveLength(1);
    expect(persisted?.pending_submissions[0].attempts).toBe(1);
  });

});

describe("sweepPendingSubmissions — resumed fund-and-draw projection", () => {
  const CREDIT_ID = "credit-77";
  const PUBKEY = "bb".repeat(32);
  const JOB_DOMAIN = {
    audience: { dvm_id: "scribe", builder_pubkey: "cc".repeat(32) },
    method: "POST",
    path: "/v1/job",
    capability: "summarize",
  };
  const RECEIPT_DVM = attestedDvm("scribe");

  function fundEntry(): PendingSubmission {
    return submission({
      cashu_token: "cashu:FUND",
      context: context({
        signing_pubkey: PUBKEY,
        auth_domain: JOB_DOMAIN,
        builder: RECEIPT_DVM.anchor,
        submit_body: {
          capability: "summarize",
          data: {
            action: "go",
            credit_id: CREDIT_ID,
            draw_id: "draw-1",
            fund: { amount_micro: 4_800, commitment: "cd".repeat(32) },
          },
        },
      }),
    });
  }

  function provisional(): StoredCredit {
    return {
      endpoint: ENDPOINT,
      dvmId: "scribe",
      callerPubkey: PUBKEY,
      creditId: CREDIT_ID,
      currency: "usd",
      balanceMicro: 0,
      remainingMicro: 0,
      ledgerSeq: 0,
      expiryMs: 0,
      targetMicro: 800_000,
      status: "active",
      provisional: true,
      openedAt: 0,
      updatedAt: 0,
    };
  }

  const wire = {
    credit_id: CREDIT_ID,
    currency: "usd",
    balance_micro: 400_000,
    remaining_micro: 395_200,
    expiry_ms: NOW_MS + 86_400_000,
    expired: false,
    drainable: true,
    ledger_seq: 1,
  };

  beforeEach(() => {
    vi.mocked(findSigningIdentityByPubkey).mockReturnValue({
      privkey: "aa".repeat(32),
      pubkey: PUBKEY,
      source: { kind: "sole", name: "default" },
    });
    vi.mocked(loadCredit).mockReturnValue(provisional());
  });

  it("reads the balance the job response cannot state, and reconciles from it", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([fundEntry()]));
    const httpPost = vi
      .fn()
      .mockResolvedValueOnce({ status: 202, body: { job_id: "job-9" } })
      .mockResolvedValueOnce({
        status: 200,
        body: { op: "balance", credit: wire, credits: [wire] },
      });

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0]).toMatchObject({ kind: "shipped", jobId: "job-9" });
    const read = httpPost.mock.calls[1][0] as { url: string; body: string };
    expect(read.url).toBe(`${ENDPOINT}/v1/credit`);
    const signed = JSON.parse(read.body) as Record<string, unknown>;
    expect(signed.op).toBe("balance");
    expect(signed.signature).toBeTruthy();
    expect(signed.auth_statement).toMatchObject({
      audience: JOB_DOMAIN.audience,
      method: "POST",
      path: "/v1/credit",
      capability: null,
    });
    expect(recordBalanceResponse).toHaveBeenCalledWith({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credits: [wire],
      primary: wire,
      sequenced: false,
    });
  });

  it("takes a credit block off the body when one is there, with no second hop", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([fundEntry()]));
    const fundingCredit = { ...wire, remaining_micro: 400_000 };
    const fundingReceipt = RECEIPT_DVM.signFunding({
      credit_id: CREDIT_ID,
      fund_id: REQUEST_ID,
      funded_micro: 400_000,
      balance_after_micro: 400_000,
      ledger_seq: fundingCredit.ledger_seq,
      caller_pubkey: PUBKEY,
    });
    const httpPost = vi.fn().mockResolvedValue({
      status: 202,
      body: {
        job_id: "job-9",
        funded_micro: 400_000,
        funding_receipt: fundingReceipt,
        credit: fundingCredit,
      },
    });

    await sweepPendingSubmissions({ httpPost, now });

    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(storedFundingReceipts()).toContainEqual(
      expect.objectContaining({ receipt: fundingReceipt, verification: "verified" })
    );
    expect(recordFundResponse).toHaveBeenCalledWith(
      expect.objectContaining({ callerPubkey: PUBKEY, credit: fundingCredit, sequenced: true })
    );
  });

  it("verifies a credit-route replay but keeps its mutable live snapshot unsequenced", async () => {
    const fundId = "fund-replayed";
    const entry = submission({
      cashu_token: "cashu:FUND",
      context: context({
        route: "credit",
        signing_pubkey: PUBKEY,
        auth_domain: { ...JOB_DOMAIN, path: "/v1/credit", capability: null },
        builder: RECEIPT_DVM.anchor,
        submit_body: {},
        credit_body: {
          op: "fund",
          credit_id: CREDIT_ID,
          fund: { amount_micro: 400_000, fund_id: fundId, commitment: "cd".repeat(32) },
        },
      }),
    });
    const fundingReceipt = RECEIPT_DVM.signFunding({
      credit_id: CREDIT_ID,
      fund_id: fundId,
      funded_micro: 400_000,
      balance_after_micro: 400_000,
      ledger_seq: 1,
      caller_pubkey: PUBKEY,
    });
    const liveCredit = { ...wire, remaining_micro: 300_000, ledger_seq: 3 };
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([entry]));
    const httpPost = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        op: "fund",
        replayed: true,
        funded_micro: 400_000,
        funding_receipt: fundingReceipt,
        credit: liveCredit,
      },
    });

    await sweepPendingSubmissions({ httpPost, now });

    expect(storedFundingReceipts()).toContainEqual(
      expect.objectContaining({ receipt: fundingReceipt, verification: "verified" })
    );
    expect(recordFundResponse).toHaveBeenCalledWith(
      expect.objectContaining({ credit: liveCredit, sequenced: false })
    );
  });

  it("reconciles behind a 409 replay too", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([fundEntry()]));
    const httpPost = vi
      .fn()
      .mockResolvedValueOnce({ status: 409, body: { error: "replay_rejected" } })
      .mockResolvedValueOnce({ status: 200, body: { op: "balance", credits: [wire] } });

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0].kind).toBe("already_accepted");
    expect(recordBalanceResponse).toHaveBeenCalled();
  });

  it("spends none on a record the server has already spoken for", async () => {
    vi.mocked(loadCredit).mockReturnValue({ ...provisional(), provisional: undefined });
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([fundEntry()]));
    const httpPost = vi.fn().mockResolvedValue({ status: 202, body: { job_id: "job-9" } });

    await sweepPendingSubmissions({ httpPost, now });

    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(recordBalanceResponse).not.toHaveBeenCalled();
  });

  it("ships regardless of what the balance read does", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([fundEntry()]));
    const httpPost = vi
      .fn()
      .mockResolvedValueOnce({ status: 202, body: { job_id: "job-9" } })
      .mockRejectedValueOnce(new Error("ECONNRESET"));

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0]).toMatchObject({ kind: "shipped", jobId: "job-9" });
    expect(recordBalanceResponse).not.toHaveBeenCalled();
    const saved = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(saved?.pending_submissions).toHaveLength(0);
  });

  it("ships when the credit store cannot be read", async () => {
    vi.mocked(loadCredit).mockImplementation(() => {
      throw new Error("credit_store_lock_failed");
    });
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([fundEntry()]));
    const httpPost = vi.fn().mockResolvedValue({ status: 202, body: { job_id: "job-9" } });

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0]).toMatchObject({ kind: "shipped", jobId: "job-9" });
    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0].pending_submissions).toHaveLength(0);
  });

  it("ships when the credit store cannot be written", async () => {
    vi.mocked(recordFundResponse).mockImplementation(() => {
      throw new Error("credit_store_lock_failed");
    });
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([fundEntry()]));
    const httpPost = vi
      .fn()
      .mockResolvedValueOnce({ status: 202, body: { job_id: "job-9", credit: wire } })
      .mockResolvedValueOnce({ status: 503, body: null });

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0]).toMatchObject({ kind: "shipped", jobId: "job-9" });
    expect(vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0].pending_submissions).toHaveLength(0);
  });

  it("ships a credit top-up whose projection write is refused", async () => {
    vi.mocked(recordFundResponse).mockImplementation(() => {
      throw new Error("credit_store_lock_failed");
    });
    vi.mocked(loadAgentWallet).mockReturnValue(
      baseWallet([
        submission({
          cashu_token: "cashu:FUND",
          context: context({
            submit_body: {},
            route: "credit",
    auth_domain: CREDIT_DOMAIN,
            signing_pubkey: PUBKEY,
            credit_body: { op: "fund", credit_id: CREDIT_ID, fund: { fund_id: "fund-refused", amount_micro: 400_000, commitment: "cd".repeat(32) } },
          }),
        }),
      ])
    );
    const httpPost = vi.fn().mockResolvedValue({ status: 200, body: { op: "fund", credit: wire } });

    const result = await sweepPendingSubmissions({ httpPost, now });

    expect(result.outcomes[0].kind).toBe("shipped");
    expect(recordFundResponse).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0].pending_submissions).toHaveLength(0);
  });

  it("writes nothing from a balance body carrying no usable credit", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([fundEntry()]));
    const httpPost = vi
      .fn()
      .mockResolvedValueOnce({ status: 202, body: { job_id: "job-9" } })
      .mockResolvedValueOnce({ status: 200, body: { op: "balance", credits: [{ nope: 1 }] } });

    await sweepPendingSubmissions({ httpPost, now });

    expect(recordBalanceResponse).not.toHaveBeenCalled();
  });
});

describe("refund-clause reclaim", () => {
  const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
  const CANONICAL_ID = "42";
  const EXPIRED_T = NOW_MS - 60 * 60 * 1000;

  function claused(overrides: Partial<PendingSubmission> = {}): PendingSubmission {
    return submission({
      context: undefined,
      canonical_id: CANONICAL_ID,
      refund_pubkey: deriveAgentRefundSubkeyPubkey(MNEMONIC, CANONICAL_ID),
      t_expire: EXPIRED_T,
      ...overrides,
    });
  }

  interface CashuStub {
    wallet: Wallet;
    send: ReturnType<typeof vi.fn>;
    privkey: ReturnType<typeof vi.fn>;
  }

  function cashuStub(
    opts: {
      spentSecrets?: string[];
      pendingSecrets?: string[];
      fee?: number;
      outputs?: { id: string; amount: number; secret: string; C: string }[];
      sendError?: Error;
    } = {}
  ): CashuStub {
    const run = vi.fn(() =>
      opts.sendError
        ? Promise.reject(opts.sendError)
        : Promise.resolve({
            send: opts.outputs ?? [{ id: "k1", amount: 5, secret: "back-1", C: "02CAFE" }],
            keep: [],
          })
    );
    const asP2PK = vi.fn(() => ({ run }));
    const privkey = vi.fn(() => ({ asP2PK }));
    const send = vi.fn(() => ({ privkey }));
    const wallet = {
      ops: { send },
      groupProofsByState: vi.fn(() =>
        Promise.resolve({
          spent: (opts.spentSecrets ?? []).map((secret) => ({ secret })),
          pending: (opts.pendingSecrets ?? []).map((secret) => ({ secret })),
          unspent: [],
        })
      ),
      getFeesForProofs: vi.fn(() => opts.fee ?? 0),
    } as unknown as Wallet;
    return { wallet, send, privkey };
  }

  function sweepOpts(stub: CashuStub, over: Record<string, unknown> = {}) {
    return {
      httpPost: vi.fn(() => Promise.reject(new Error("the reclaim path must not re-ship"))),
      now,
      getWalletForMint: () => Promise.resolve(stub.wallet),
      readMnemonic: () => MNEMONIC,
      ...over,
    };
  }

  it("swaps a past-locktime entry back into spendable balance and drops it", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([claused()]));
    const stub = cashuStub();

    const result = await sweepPendingSubmissions(sweepOpts(stub));

    expect(result.outcomes[0]).toMatchObject({ kind: "reclaimed", reclaimed_sats: 5 });
    expect(stub.privkey).toHaveBeenCalledWith(
      "0ee99cc873c4781d700a7867a9321a59562c9ab2cf707092a94082683e4f84c9"
    );
    const persisted = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(persisted?.pending_submissions).toHaveLength(0);
    expect(persisted?.proofs.map((p) => p.secret)).toEqual(["back-1"]);
  });

  it("clears as already_accepted — never double-spends — when the DVM redeemed late", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([claused()]));
    const stub = cashuStub({ spentSecrets: ["out-1"] });

    const result = await sweepPendingSubmissions(sweepOpts(stub));

    expect(result.outcomes[0].kind).toBe("already_accepted");
    expect(stub.send).not.toHaveBeenCalled();
    const persisted = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(persisted?.pending_submissions).toHaveLength(0);
    expect(persisted?.proofs).toHaveLength(0);
    expect(persisted?.recent_spends).toHaveLength(1);
  });

  function persistedEntry(): PendingSubmission | undefined {
    return vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0].pending_submissions[0];
  }

  it("holds the entry when the mint's swap fee would eat the whole value", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([claused()]));
    const stub = cashuStub({ fee: 5 });

    const result = await sweepPendingSubmissions(sweepOpts(stub));

    expect(result.outcomes[0]).toMatchObject({ kind: "reclaim_skipped", terminal: true });
    expect(stub.send).not.toHaveBeenCalled();
    expect(persistedEntry()?.reclaim_error).toContain("swap fee");
    expect(persistedEntry()?.reclaim_terminal).toBe(true);
  });

  it("enforces the cumulative job-wide fee cap before a recovery swap mutates proofs", async () => {
    const entry = claused({
      max_cashu_fee_sats: 2,
      initial_cashu_fee_sats: 1,
      context: {
        submit_body: { input: "" },
        max_cashu_fee_sats: 2,
        initial_cashu_fee_sats: 1,
      },
    });
    const initial = baseWallet([entry]);
    const initialBytes = JSON.stringify(initial);
    vi.mocked(loadAgentWallet).mockReturnValue(initial);
    // Each 2-sat swap is individually within the 2-sat cap, but the initial
    // 1 sat plus this reclaim's 2 sats would consume 3 sats job-wide.
    const stub = cashuStub({ fee: 2 });

    const result = await sweepPendingSubmissions(sweepOpts(stub));

    expect(result.outcomes[0]).toMatchObject({
      kind: "reclaim_skipped",
      terminal: true,
      reason: expect.stringContaining("leaving a 1-sat allowance"),
    });
    expect(stub.send).not.toHaveBeenCalled();
    const persisted = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(persisted?.proofs).toEqual(initial.proofs);
    expect(persisted?.pending_submissions[0].output_proofs).toEqual(entry.output_proofs);
    expect(JSON.stringify(initial)).toBe(initialBytes);
  });

  it("fails a capped legacy-shaped entry closed instead of assuming its initial fee was zero", async () => {
    const entry = claused({ max_cashu_fee_sats: 2 });
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([entry]));
    const stub = cashuStub({ fee: 1 });

    const result = await sweepPendingSubmissions(sweepOpts(stub));

    expect(result.outcomes[0]).toMatchObject({
      kind: "reclaim_skipped",
      terminal: true,
      reason: expect.stringContaining("missing valid initial Cashu fee accounting"),
    });
    expect(stub.send).not.toHaveBeenCalled();
  });

  it("holds the entry when the mint reports the proofs still in flight", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([claused()]));
    const stub = cashuStub({ pendingSecrets: ["out-1"] });

    const result = await sweepPendingSubmissions(sweepOpts(stub));

    expect(result.outcomes[0]).toMatchObject({ kind: "reclaim_skipped" });
    expect(persistedEntry()?.reclaim_error).toContain("in flight");
  });

  it("holds the entry — rather than crashing the sweep — with no mnemonic on disk", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([claused()]));
    const stub = cashuStub();

    const result = await sweepPendingSubmissions(sweepOpts(stub, { readMnemonic: () => null }));

    expect(result.outcomes[0]).toMatchObject({ kind: "reclaim_skipped" });
    expect(persistedEntry()?.reclaim_error).toContain("no mnemonic");
  });

  it("holds the entry when the reclaim swap itself fails", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([claused()]));
    const stub = cashuStub({ sendError: new Error("mint down") });

    const result = await sweepPendingSubmissions(sweepOpts(stub));

    expect(result.outcomes[0]).toMatchObject({
      kind: "reclaim_skipped",
      reason: "mint down",
      terminal: false,
    });
    expect(persistedEntry()?.reclaim_error).toBe("mint down");
    expect(persistedEntry()?.reclaim_terminal).toBe(false);
  });

  it("explains why a legacy proof rejected for missing DLEQ needs mint support", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(baseWallet([claused()]));
    const stub = cashuStub({
      sendError: new Error("panic mode requires DLEQ data for every input"),
    });

    const result = await sweepPendingSubmissions(sweepOpts(stub));

    expect(result.outcomes[0]).toMatchObject({ kind: "reclaim_skipped", terminal: true });
    expect(persistedEntry()?.reclaim_error).toContain(
      "The NUT-11 key can authorize the spend but cannot recreate DLEQ"
    );
  });

  it("does not rewrite the wallet when the skip reason has not changed", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(
      baseWallet([claused({ reclaim_error: "mint down" })])
    );
    const stub = cashuStub({ sendError: new Error("mint down") });

    const result = await sweepPendingSubmissions(sweepOpts(stub));

    expect(result.outcomes[0]).toMatchObject({ kind: "reclaim_skipped", reason: "mint down" });
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("books the provider's share and reclaims only the rest on a partial redeem", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(
      baseWallet([
        claused({ amount_sats: 9, output_proofs: [proof("out-1", 5), proof("out-2", 4)] }),
      ])
    );
    const stub = cashuStub({
      spentSecrets: ["out-1"],
      outputs: [{ id: "k1", amount: 4, secret: "back-1", C: "02CAFE" }],
    });

    const result = await sweepPendingSubmissions(sweepOpts(stub));

    expect(result.outcomes[0]).toMatchObject({
      kind: "reclaimed",
      reclaimed_sats: 4,
      spent_sats: 5,
    });
    const persisted = vi.mocked(saveAgentWallet).mock.calls.at(-1)?.[0];
    expect(persisted?.pending_submissions).toHaveLength(0);
    expect(persisted?.proofs.map((p) => p.secret)).toEqual(["back-1"]);
    expect(persisted?.recent_spends).toMatchObject([{ amount_sats: 5 }]);
  });

  it("waits out a mixed in-flight / unspent split rather than dropping the entry", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(
      baseWallet([
        claused({ amount_sats: 9, output_proofs: [proof("out-1", 5), proof("out-2", 4)] }),
      ])
    );
    const stub = cashuStub({ pendingSecrets: ["out-1"] });

    const result = await sweepPendingSubmissions(sweepOpts(stub));

    expect(result.outcomes[0]).toMatchObject({ kind: "reclaim_skipped" });
    expect(stub.send).not.toHaveBeenCalled();
    expect(persistedEntry()?.reclaim_error).toContain("some of these proofs in flight");
  });

  it("does not reclaim before the locktime — resume still gets first crack", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(
      baseWallet([claused({ context: context(), t_expire: NOW_MS + 60 * 60 * 1000 })])
    );
    const stub = cashuStub();
    const httpPost = vi.fn(() => Promise.resolve({ status: 200, body: { job_id: "job-1" } }));

    const result = await sweepPendingSubmissions(sweepOpts(stub, { httpPost }));

    expect(result.outcomes[0].kind).toBe("shipped");
    expect(stub.send).not.toHaveBeenCalled();
  });

  describe("on an entry accepted without a settled job identity", () => {
    const marker = {
      kind: "identity_mismatch" as const,
      observed_at: CREATED_AT,
      header_job_id: "job-a",
      body_job_id: "job-b",
      ambiguity_id: REQUEST_ID,
    };

    it.each([
      {
        label: "all redeemed: books the spend",
        proofs: [proof("out-1", 5)],
        stub: { spentSecrets: ["out-1"] },
        outcome: { kind: "already_accepted" },
      },
      {
        label: "none redeemed: takes it back",
        proofs: [proof("out-1", 5)],
        stub: {},
        outcome: { kind: "reclaimed", reclaimed_sats: 5 },
      },
      {
        label: "part redeemed: books that part and takes back the rest",
        proofs: [proof("out-1", 5), proof("out-2", 4)],
        stub: {
          spentSecrets: ["out-1"],
          outputs: [{ id: "k1", amount: 4, secret: "back-1", C: "02CAFE" }],
        },
        outcome: { kind: "reclaimed", reclaimed_sats: 4, spent_sats: 5 },
      },
      {
        label: "any in flight: waits",
        proofs: [proof("out-1", 5), proof("out-2", 4)],
        stub: { pendingSecrets: ["out-1"] },
        outcome: { kind: "reclaim_skipped" },
      },
    ])("$label, with no POST", async ({ proofs, stub, outcome }) => {
      const amount = proofs.reduce((sum, p) => sum + p.amount, 0);
      vi.mocked(loadAgentWallet).mockReturnValue(
        baseWallet([
          claused({
            context: context(),
            amount_sats: amount,
            output_proofs: proofs,
            accepted_unresolved: marker,
          }),
        ])
      );
      const opts = sweepOpts(cashuStub(stub));

      const result = await sweepPendingSubmissions(opts);

      expect(result.outcomes[0]).toMatchObject(outcome);
      expect(opts.httpPost).not.toHaveBeenCalled();
    });

    it("is held with no POST before the locktime, where an unmarked entry would re-ship", async () => {
      vi.mocked(loadAgentWallet).mockReturnValue(
        baseWallet([
          claused({
            context: context(),
            t_expire: NOW_MS + 60 * 60 * 1000,
            accepted_unresolved: marker,
          }),
        ])
      );
      const stub = cashuStub();
      const opts = sweepOpts(stub);

      const result = await sweepPendingSubmissions(opts);

      expect(result.outcomes[0]).toMatchObject({ kind: "accepted_unresolved", evidence: "missing" });
      expect(opts.httpPost).not.toHaveBeenCalled();
      expect(stub.send).not.toHaveBeenCalled();
    });
  });
});
