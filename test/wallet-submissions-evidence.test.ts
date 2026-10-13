import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const output = vi.hoisted(() => ({ json: vi.fn(), info: vi.fn() }));
vi.mock("../src/lib/output", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/output")>("../src/lib/output")),
  json: output.json,
  info: output.info,
}));

import {
  type AgentWallet,
  WALLET_FILE,
  WALLET_VERSION,
  saveAgentWallet,
} from "@dvmkit/sdk/internal";

import { walletSubmissions } from "../src/commands/wallet-submissions";
import {
  journalMarkerFor,
  loadSubmissionEvidence,
  recordSubmissionEvidence,
  SUBMISSION_EVIDENCE_DIR,
} from "../src/lib/submission-evidence";

const ENDPOINT = "https://dvm.test";
const REQUEST_ID = "6f1b1d3e-6f1a-4f0e-9a3d-2b7c8f5e4a11";
const TOKEN = "f".repeat(64);

beforeEach(() => {
  output.json.mockReset();
  output.info.mockReset();
  rmSync(SUBMISSION_EVIDENCE_DIR, { recursive: true, force: true });
  rmSync(WALLET_FILE, { force: true });
});

describe("dvm wallet submissions evidence", () => {
  it("lists evidence with no wallet and prints the job token only as a labelled bearer secret", async () => {
    recordSubmissionEvidence({
      observation: {
        kind: "identity_mismatch",
        headerJobId: "job-a",
        bodyJobId: "job-b",
        jobToken: TOKEN,
      },
      endpoint: ENDPOINT,
      publicRequestId: "req-1",
      rail: "x402",
    });

    await walletSubmissions({});

    const listed = output.json.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(listed).toMatchObject({
      pending_submissions: [],
      submission_evidence: [
        {
          ambiguity_id: "req-1",
          job_token_bearer_secret: TOKEN,
          read_job: [
            "dvm request-result req-1",
            `DVM_JOB_TOKEN=<job_token_bearer_secret> dvm status job-a --endpoint ${ENDPOINT}`,
            `DVM_JOB_TOKEN=<job_token_bearer_secret> dvm status job-b --endpoint ${ENDPOINT}`,
          ],
        },
      ],
    });
    expect(listed.submission_evidence).not.toContainEqual(expect.objectContaining({ job_token: TOKEN }));
    expect(JSON.stringify(listed).split(TOKEN)).toHaveLength(2);
    expect(String(listed.hint)).toContain("treat it like a password and do not share it");
  });

  it("offers no status read for a job ID the provider issued no token for", async () => {
    recordSubmissionEvidence({
      observation: { kind: "identity_mismatch", headerJobId: "job-a", bodyJobId: "job-b" },
      endpoint: ENDPOINT,
      cashuRequestId: REQUEST_ID,
      rail: "cashu",
    });

    await walletSubmissions({});

    const listed = output.json.mock.calls.at(-1)?.[0] as { submission_evidence: { read_job: string[]; display: string }[] };
    expect(listed.submission_evidence[0].read_job).toEqual([]);
    expect(listed.submission_evidence[0].display).toContain("No job token was received for job-a, job-b");
  });

  it("lists the readable records and names a damaged file instead of failing", async () => {
    recordSubmissionEvidence({
      observation: { kind: "body_unreadable", headerJobId: "job-a" },
      endpoint: ENDPOINT,
      cashuRequestId: REQUEST_ID,
      rail: "cashu",
    });
    mkdirSync(SUBMISSION_EVIDENCE_DIR, { recursive: true });
    const damaged = join(SUBMISSION_EVIDENCE_DIR, `${"0".repeat(64)}.json`);
    writeFileSync(damaged, "{not json", { mode: 0o600 });

    await walletSubmissions({});

    expect(output.json.mock.calls.at(-1)?.[0]).toMatchObject({
      submission_evidence: [{ ambiguity_id: REQUEST_ID }],
      submission_evidence_unreadable: [{ path: damaged }],
    });
  });

  it("reads a marked entry as accepted_unresolved, prints its token only on the evidence row, and forgetting it keeps the evidence", async () => {
    const record = recordSubmissionEvidence({
      observation: { kind: "body_unreadable", headerJobId: "job-a", jobToken: TOKEN },
      endpoint: ENDPOINT,
      cashuRequestId: REQUEST_ID,
      rail: "cashu",
    });
    saveAgentWallet(walletWith({ accepted_unresolved: journalMarkerFor(record) }));

    await walletSubmissions({});
    const listed = output.json.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(listed).toMatchObject({
      accepted_unresolved_count: 1,
      stranded_count: 0,
      pending_submissions: [{ request_id: REQUEST_ID, state: "accepted_unresolved", at_risk: true }],
      submission_evidence: [{ ambiguity_id: REQUEST_ID, job_token_bearer_secret: TOKEN }],
    });
    expect(JSON.stringify(listed.pending_submissions)).not.toContain(TOKEN);
    expect(JSON.stringify(listed).split(TOKEN)).toHaveLength(2);

    await walletSubmissions({ forget: REQUEST_ID, yes: true });

    expect(output.json.mock.calls.at(-1)?.[0]).toMatchObject({ status: "forgotten" });
    expect(loadSubmissionEvidence(REQUEST_ID)).toMatchObject({ kind: "body_unreadable" });
  });
});

function walletWith(
  extra: Partial<AgentWallet["pending_submissions"][number]>
): AgentWallet {
  return {
    version: WALLET_VERSION,
    lock_privkey: "11".repeat(32),
    lock_pubkey: `02${"a".repeat(64)}`,
    mnemonic_fingerprint: null,
    mints: ["https://mint.test"],
    proofs: [],
    nut13_counters: {},
    pending_mints: [],
    pending_melts: [],
    pending_submissions: [
      {
        endpoint: ENDPOINT,
        request_id: REQUEST_ID,
        intended_lock_pubkey: `02${"a".repeat(64)}`,
        mint: "https://mint.test",
        amount_sats: 21,
        output_proofs: [
          {
            mint: "https://mint.test",
            secret: "0f1e2d3c",
            C: `02${"b".repeat(64)}`,
            amount: 21,
            id: "00ad268c4d1f5826",
            locked_to_pubkey: `02${"a".repeat(64)}`,
            status: "valid",
          },
        ],
        created_at: new Date().toISOString(),
        context: { submit_body: { capability: "echo", input: "hi" } },
        ...extra,
      },
    ],
    recent_spends: [],
    created_at: new Date().toISOString(),
  };
}
