import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DvmError, WALLET_FILE, WALLET_VERSION, loadAgentWallet, saveAgentWallet, type AgentWallet, type PendingSubmission } from "@dvmkit/sdk/internal";
import { loadJob } from "../src/lib/job-store";
import {
  loadSubmissionEvidence,
  recordSubmissionEvidence,
  SUBMISSION_EVIDENCE_DIR,
} from "../src/lib/submission-evidence";
import { sweepPendingSubmissions } from "../src/lib/wallet-agent/recovery-submissions";
import { describePendingSubmissions } from "../src/lib/wallet-agent/submissions-view";

const ENDPOINT = "https://dvm.test";
const REQUEST_ID = "6f1b1d3e-6f1a-4f0e-9a3d-2b7c8f5e4a11";
const OTHER_REQUEST_ID = "7f1b1d3e-6f1a-4f0e-9a3d-2b7c8f5e4a12";
const PUBLIC_ID = "0b6b1c2e-1f1a-4f0e-9a3d-2b7c8f5e4a99";
const LOCK_PUBKEY = `02${"a".repeat(64)}`;
const SUBMIT_BODY = { capability: "echo", input: { text: "hi" } };

/**
 * One resumable entry: output proofs the mint already signed, a persisted body
 * to re-POST, no signing identity to re-sign as, and no refund clause — so the
 * sweep reaches the HTTP re-ship rather than the reclaim or unresumable exits.
 */
function seedWallet(entries: PendingSubmission[] = [pendingEntry(REQUEST_ID)]): void {
  const wallet: AgentWallet = {
    version: WALLET_VERSION,
    lock_privkey: "11".repeat(32),
    lock_pubkey: LOCK_PUBKEY,
    mnemonic_fingerprint: null,
    mints: ["https://mint.test"],
    proofs: [],
    nut13_counters: {},
    pending_mints: [],
    pending_melts: [],
    pending_submissions: entries,
    recent_spends: [],
    created_at: new Date().toISOString(),
  };
  saveAgentWallet(wallet);
}

function pendingEntry(requestId: string, data?: Record<string, unknown>): PendingSubmission {
  return {
    endpoint: ENDPOINT,
    request_id: requestId,
    intended_lock_pubkey: LOCK_PUBKEY,
    mint: "https://mint.test",
    amount_sats: 21,
    output_proofs: [
      {
        mint: "https://mint.test",
        secret: `0f1e2d3c-${requestId}`,
        C: `02${"b".repeat(64)}`,
        amount: 21,
        id: "00ad268c4d1f5826",
        locked_to_pubkey: LOCK_PUBKEY,
        status: "valid",
      },
    ],
    created_at: new Date().toISOString(),
    cashu_token: "cashuBtest",
    context: {
      submit_body: data ? { ...SUBMIT_BODY, data } : SUBMIT_BODY,
      dvm_id: "dvm-test",
      capability: "echo",
    },
  };
}

describe("pending-submission sweep", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    rmSync(SUBMISSION_EVIDENCE_DIR, { recursive: true, force: true });
    seedWallet();
    // The default is the global `fetch`, so failing it loudly is what makes the
    // injection assertions mean anything.
    globalThis.fetch = (() => {
      throw new Error("the global fetch was called even though fetchImpl was injected");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("re-ships through the injected fetch", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ job_id: "job-1", status: "processing" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await sweepPendingSubmissions({ fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${ENDPOINT}/v1/job`);
    expect(calls[0].init?.method).toBe("POST");
    expect((calls[0].init?.headers as Record<string, string>)["X-Cashu-Request-Id"]).toBe(
      REQUEST_ID
    );
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(SUBMIT_BODY);
    expect(result.outcomes.map((outcome) => outcome.kind)).toEqual(["shipped"]);
    expect(loadJob("job-1")).not.toHaveProperty("creditBinding");
    expect(loadAgentWallet()?.pending_submissions).toEqual([]);
  });

  it("keeps a DvmError raised by the injected fetch rather than re-wrapping it", async () => {
    const upgrade = new DvmError(
      "client_upgrade_required",
      "This client is too old for that DVM.",
      "Upgrade the CLI."
    );
    const fetchImpl = (async () => {
      throw upgrade;
    }) as unknown as typeof fetch;

    const result = await sweepPendingSubmissions({ fetchImpl });

    // A thrown poster error reaches the outcome as its message, so the message
    // is where re-wrapping would show: the `provider_unreachable` branch below
    // prefixes `Could not reach <url>: `, and this one must not.
    expect(result.outcomes[0]).toMatchObject({
      kind: "still_pending",
      reason: `network error: ${upgrade.message}`,
    });
    expect(loadAgentWallet()?.pending_submissions[0].attempts).toBe(1);
  });

  it("wraps a plain network failure as provider_unreachable", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const result = await sweepPendingSubmissions({ fetchImpl });

    // `Could not reach <url>: ` is the `provider_unreachable` wrap's own text and
    // is written nowhere else in the module, so the message identifies the branch.
    expect(result.outcomes[0]).toMatchObject({
      kind: "still_pending",
      reason: `network error: Could not reach ${ENDPOINT}/v1/job: fetch failed`,
    });
  });

  describe("a re-ship accepted without a settled job identity", () => {
    it.each([
      {
        label: "a 2xx with no job ID",
        response: () => jsonResponse(200, { status: "processing" }),
        kind: "body_unreadable",
      },
      {
        label: "a field naming another job",
        response: () =>
          jsonResponse(202, { job_id: "job-b", status: "processing" }, {
            "DVM-Job-Identity-V1": "job-a",
            "x-dvmkit-router-feedback-claim": "claim-b",
          }),
        kind: "identity_mismatch",
      },
      {
        label: "the router's identity conflict",
        response: () =>
          jsonResponse(409, {
            error: {
              code: "hosting_job_identity_conflict",
              message: "The provider returned a different job for a request it had already accepted",
              display:
                "This request was already accepted as job job-a. The service then answered with a different job, so that answer was refused.",
              hint: "Do not pay again or resubmit this request. It was already accepted as job job-a.",
              accepted_job_id: "job-a",
            },
            trace_id: "trace-1",
          }),
        kind: "router_identity_conflict",
      },
    ])("holds the payment after $label and never POSTs it again", async ({ response, kind }) => {
      let posts = 0;
      const fetchImpl = (async () => {
        posts += 1;
        return response();
      }) as unknown as typeof fetch;

      const first = await sweepPendingSubmissions({ fetchImpl });
      const second = await sweepPendingSubmissions({ fetchImpl });

      expect(first.outcomes[0]).toMatchObject({ kind: "accepted_unresolved", evidence: "recorded" });
      expect(second.outcomes[0]).toMatchObject({ kind: "accepted_unresolved", evidence: "recorded" });
      expect(posts).toBe(1);
      const wallet = loadAgentWallet();
      // Kept, not booked: an ordinary 409 would have cleared the entry into recent_spends.
      expect(wallet?.recent_spends).toEqual([]);
      expect(wallet?.pending_submissions[0].accepted_unresolved).toMatchObject({
        kind,
        ambiguity_id: REQUEST_ID,
      });
      expect(loadSubmissionEvidence(REQUEST_ID)).toMatchObject({
        kind,
        cashu_request_id: REQUEST_ID,
        rail: "cashu",
        claim_stored: false,
      });
      expect(loadJob("job-a")).toBeNull();
      expect(loadJob("job-b")).toBeNull();
    });

    it("writes the marker from a record left by a crash between the two writes, with no POST", async () => {
      recordSubmissionEvidence({
        observation: { kind: "identity_mismatch", headerJobId: "job-a", bodyJobId: "job-b" },
        endpoint: ENDPOINT,
        cashuRequestId: REQUEST_ID,
        rail: "cashu",
      });
      let posts = 0;
      const fetchImpl = (async () => {
        posts += 1;
        return jsonResponse(200, { job_id: "job-a", status: "processing" });
      }) as unknown as typeof fetch;

      const result = await sweepPendingSubmissions({ fetchImpl });

      expect(posts).toBe(0);
      expect(result.outcomes[0]).toMatchObject({ kind: "accepted_unresolved", evidence: "recorded" });
      expect(loadAgentWallet()?.pending_submissions[0].accepted_unresolved).toMatchObject({
        kind: "identity_mismatch",
        header_job_id: "job-a",
        body_job_id: "job-b",
        ambiguity_id: REQUEST_ID,
      });
    });

    it("reports a marker whose evidence record is gone, with no POST", async () => {
      const wallet = loadAgentWallet() as AgentWallet;
      saveAgentWallet({
        ...wallet,
        pending_submissions: wallet.pending_submissions.map((entry) => ({
          ...entry,
          accepted_unresolved: {
            kind: "body_unreadable" as const,
            observed_at: new Date().toISOString(),
            ambiguity_id: REQUEST_ID,
          },
        })),
      });
      let posts = 0;
      const fetchImpl = (async () => {
        posts += 1;
        return jsonResponse(200, { job_id: "job-a", status: "processing" });
      }) as unknown as typeof fetch;

      const result = await sweepPendingSubmissions({ fetchImpl });

      expect(posts).toBe(0);
      expect(result.outcomes[0]).toMatchObject({ kind: "accepted_unresolved", evidence: "missing" });
    });

    it("holds a marker the wallet load had to repair, and finds its evidence by the journal request ID", async () => {
      recordSubmissionEvidence({
        observation: { kind: "identity_mismatch", headerJobId: "job-a", bodyJobId: "job-b" },
        endpoint: ENDPOINT,
        cashuRequestId: REQUEST_ID,
        rail: "cashu",
      });
      // A hand-edited or foreign marker: no ambiguity_id and a C1 job ID, which
      // the save refuses and the load repairs rather than throwing on.
      const raw = JSON.parse(readFileSync(WALLET_FILE, "utf-8")) as AgentWallet;
      raw.pending_submissions[0].accepted_unresolved = {
        kind: "identity_mismatch",
        observed_at: new Date().toISOString(),
        header_job_id: "job-a",
        body_job_id: "job-\u0085b",
      } as unknown as NonNullable<PendingSubmission["accepted_unresolved"]>;
      writeFileSync(WALLET_FILE, JSON.stringify(raw), { mode: 0o600 });
      let posts = 0;
      const fetchImpl = (async () => {
        posts += 1;
        return jsonResponse(200, { job_id: "job-a", status: "processing" });
      }) as unknown as typeof fetch;

      const result = await sweepPendingSubmissions({ fetchImpl });

      expect(posts).toBe(0);
      expect(result.outcomes[0]).toMatchObject({
        kind: "accepted_unresolved",
        evidence: "recorded",
        marker: { ambiguity_id: REQUEST_ID, header_job_id: "job-a" },
      });
      expect(result.outcomes[0]).not.toHaveProperty("marker.body_job_id");
    });

    it("holds a paid 409 whose body cannot be read instead of booking it as a replay", async () => {
      let posts = 0;
      const fetchImpl = (async () => {
        posts += 1;
        return new Response("<html>Conflict</html>", { status: 409, headers: { "content-type": "text/html" } });
      }) as unknown as typeof fetch;

      const first = await sweepPendingSubmissions({ fetchImpl });
      await sweepPendingSubmissions({ fetchImpl });

      expect(first.outcomes[0]).toMatchObject({ kind: "accepted_unresolved", evidence: "recorded" });
      expect(posts).toBe(1);
      expect(loadAgentWallet()?.recent_spends).toEqual([]);
      expect(loadSubmissionEvidence(REQUEST_ID)).toMatchObject({ kind: "body_unreadable", rail: "cashu" });
    });

    it("keeps an unstorable body job ID out of the journal and only escaped in the evidence", async () => {
      const hostile = `job-\u0085${"x".repeat(1100)}`;
      const fetchImpl = (async () =>
        jsonResponse(202, { job_id: hostile, status: "processing" }, {
          "DVM-Job-Identity-V1": "job-a",
        })) as unknown as typeof fetch;

      await sweepPendingSubmissions({ fetchImpl });

      const marker = loadAgentWallet()?.pending_submissions[0].accepted_unresolved;
      expect(marker).toMatchObject({ kind: "body_unreadable", header_job_id: "job-a" });
      expect(marker).not.toHaveProperty("body_job_id");
      const record = loadSubmissionEvidence(REQUEST_ID);
      expect(record?.body_job_id).toBeUndefined();
      expect(record?.unstorable_job_ids?.body_job_id).toBe(
        `${JSON.stringify(hostile.slice(0, 1024)).replace("\u0085", "\\u0085")} [truncated from 1105 characters]`
      );
    });
  });
});

describe("a pending submission that carried a public request ID", () => {
  beforeEach(() => rmSync(SUBMISSION_EVIDENCE_DIR, { recursive: true, force: true }));

  it("is kept, not booked, when its re-POST meets the provider's claim on the ID", async () => {
    // No signing identity, so the read-only lookup cannot be signed and the
    // re-POST is the only thing the sweep can send.
    seedWallet([pendingEntry(REQUEST_ID, { request_id: PUBLIC_ID })]);
    const fetchImpl = (async () =>
      jsonResponse(409, {
        error: "request_id_exists",
        message: "This request id is already reserved or bound to an accepted request.",
        hint: `Run dvm request-result ${PUBLIC_ID}; do not submit or pay again.`,
        request_id: PUBLIC_ID,
      })) as unknown as typeof fetch;

    const result = await sweepPendingSubmissions({ fetchImpl });

    expect(result.outcomes).toMatchObject([{ kind: "still_pending", reason: "request_id_exists" }]);
    const wallet = loadAgentWallet();
    expect(wallet?.recent_spends).toEqual([]);
    expect(wallet?.pending_submissions.map((entry) => entry.request_id)).toEqual([REQUEST_ID]);
    // The ID `dvm request-result` takes is the one the caller is shown.
    expect(describePendingSubmissions(wallet as AgentWallet).entries).toMatchObject([
      { request_id: REQUEST_ID, public_request_id: PUBLIC_ID },
    ]);
  });
});

describe("an evidence record that cannot be read", () => {
  beforeEach(() => rmSync(SUBMISSION_EVIDENCE_DIR, { recursive: true, force: true }));

  it("holds only its own entry, with no POST, and the sweep goes on to the next", async () => {
    seedWallet([pendingEntry(REQUEST_ID), pendingEntry(OTHER_REQUEST_ID)]);
    mkdirSync(SUBMISSION_EVIDENCE_DIR, { recursive: true });
    const damaged = join(SUBMISSION_EVIDENCE_DIR, `${createHash("sha256").update(REQUEST_ID).digest("hex")}.json`);
    writeFileSync(damaged, "{not json", { mode: 0o600 });
    const posted: string[] = [];
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      posted.push((init?.headers as Record<string, string>)["X-Cashu-Request-Id"]);
      return jsonResponse(202, { job_id: "job-1", status: "processing" });
    }) as unknown as typeof fetch;

    const result = await sweepPendingSubmissions({ fetchImpl });

    expect(posted).toEqual([OTHER_REQUEST_ID]);
    expect(result.outcomes).toMatchObject([
      { kind: "evidence_unreadable", entry: { request_id: REQUEST_ID } },
      { kind: "shipped", entry: { request_id: OTHER_REQUEST_ID } },
    ]);
    expect(loadAgentWallet()?.pending_submissions.map((entry) => entry.request_id)).toEqual([REQUEST_ID]);
  });
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
