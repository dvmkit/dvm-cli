import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { X402Wallet } from "@dvmkit/sdk/internal";

// The provider below is a real HTTP server driven through the real transport.
// The seams are local state only: the signing key, the rails' wallets, the BTC
// rate, and the Cashu spend (which would otherwise swap at a mint).
const mint = "https://mint.invalid";
const lockPubkey = `03${"01".repeat(32)}`;
const secret = "01".repeat(32);
const audience = { dvm_id: "test-provider", builder_pubkey: "03".repeat(32) };
const creditTerms = { funding: ["cashu"], currency: "usd", min_micro: 1_000, max_micro: 5_000_000, ttl_ms: 86_400_000 };
const FIELD = "DVM-Job-Identity-V1";

const seams = vi.hoisted(() => ({
  prepareAgentSpend: vi.fn(),
  info: vi.fn(),
  json: vi.fn(),
  progress: vi.fn(),
  rate: 100_000,
  x402Wallet: null as X402Wallet | null,
  realSweep: undefined as
    | undefined
    | typeof import("../src/lib/wallet-agent/recovery-submissions")["sweepPendingSubmissions"],
}));

const root = process.env.DVM_CONFIG_DIR as string;
const realFetch = globalThis.fetch;
const servers = new Set<Server>();
let sdk: typeof import("@dvmkit/sdk/internal");
let verifierFor: typeof import("@dvmkit/sdk")["createSignedRequestVerifier"];
let request: typeof import("../src/commands/request")["request"];
let evidence: typeof import("../src/lib/submission-evidence");
let intents: typeof import("../src/lib/request-intent-store");
let jobs: typeof import("../src/lib/job-store");
let budget: typeof import("../src/lib/budget-ledger");
let requestResult: typeof import("../src/commands/request-result")["requestResult"];
let requestResume: typeof import("../src/commands/request-resume")["requestResume"];
let access: typeof import("../src/lib/job-access");
let views: typeof import("../src/lib/wallet-agent/submissions-view");
let provider: Provider;

beforeAll(async () => {
  vi.resetModules();
  vi.doMock("../src/lib/output", async () => ({
    ...(await vi.importActual<typeof import("../src/lib/output")>("../src/lib/output")),
    info: seams.info,
    json: seams.json,
    progress: seams.progress,
  }));
  vi.doMock("../src/lib/cli-identity-resolve", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/lib/cli-identity-resolve")>()),
    resolveSigningIdentity: () => ({ privkey: secret, pubkey: sdk.receiptPubkeyFromSecret(secret) }),
    findSigningIdentityByPubkey: () => ({ privkey: secret, pubkey: sdk.receiptPubkeyFromSecret(secret) }),
  }));
  vi.doMock("../src/lib/x402/wallet", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/lib/x402/wallet")>()),
    loadX402Wallet: () => seams.x402Wallet,
  }));
  vi.doMock("../src/lib/payment-rails/tempo-wallet", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/lib/payment-rails/tempo-wallet")>()),
    connectedTempoAccount: async () => null,
  }));
  vi.doMock("../src/lib/float", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/lib/float")>()),
    loadFloat: () => null,
  }));
  vi.doMock("../src/lib/btc-rate", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/lib/btc-rate")>()),
    tryResolveBtcUsdRate: () => Promise.resolve({ rate: seams.rate, stale: false }),
    resolveBtcUsdRate: () => Promise.resolve({ rate: seams.rate, stale: false }),
  }));
  vi.doMock("../src/lib/wallet-agent/spend", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/lib/wallet-agent/spend")>()),
    prepareAgentSpend: seams.prepareAgentSpend,
    commitAgentSpend: vi.fn(async () => undefined),
  }));
  // The paid path sweeps before it spends. The tests run the real sweep
  // themselves, after the paid call, as the restart.
  vi.doMock("../src/lib/wallet-agent/recovery-submissions", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/lib/wallet-agent/recovery-submissions")>();
    seams.realSweep = actual.sweepPendingSubmissions;
    return { ...actual, sweepPendingSubmissions: vi.fn(async () => ({ outcomes: [] })) };
  });
  sdk = await import("@dvmkit/sdk/internal");
  ({ createSignedRequestVerifier: verifierFor } = await import("@dvmkit/sdk"));
  evidence = await import("../src/lib/submission-evidence");
  intents = await import("../src/lib/request-intent-store");
  jobs = await import("../src/lib/job-store");
  budget = await import("../src/lib/budget-ledger");
  ({ request } = await import("../src/commands/request"));
  ({ requestResult } = await import("../src/commands/request-result"));
  ({ requestResume } = await import("../src/commands/request-resume"));
  access = await import("../src/lib/job-access");
  views = await import("../src/lib/wallet-agent/submissions-view");
});

beforeEach(async () => {
  for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  vi.clearAllMocks();
  seams.rate = 100_000;
  seams.x402Wallet = null;
  writeConfig("off");
  seedWallet();
  seams.prepareAgentSpend.mockImplementation(journalSpend);
  provider = await startProvider();
  // Only the provider's own origin is reachable.
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    String(input instanceof Request ? input.url : input).startsWith(provider.endpoint)
      ? realFetch(input, init)
      : Promise.reject(new Error(`no network beyond the test provider: ${String(input)}`))
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all([...servers].map(close));
  servers.clear();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("a paid submit the provider accepts without a settled job identity", () => {
  it.each([
    {
      label: "a field naming another job",
      reply: (accepted: string) => answer(202, { job_id: "job-b", job_token: "e".repeat(64), status: "processing" }, { [FIELD]: accepted }),
      kind: "identity_mismatch",
    },
    { label: "a body that breaks off after a valid field", reply: (accepted: string) => breakOff(accepted), kind: "body_unreadable" },
    { label: "the router's identity conflict", reply: (accepted: string) => routerConflict(accepted), kind: "router_identity_conflict" },
  ])("holds the payment after $label, and a restart never POSTs it", async ({ reply, kind }) => {
    provider.recovery = false;
    provider.paid = (_post, accepted) => reply(accepted);

    const error = await paidRequest().catch((caught: unknown) => caught);

    const journalId = onlyJournalEntry().request_id;
    expect(error).toMatchObject({
      data: { identity_kind: kind, ambiguity_id: journalId, cashu_request_id: journalId, claim_stored: false },
    });
    expect(JSON.stringify((error as { data: unknown }).data)).not.toContain("e".repeat(64));
    expect(evidence.loadSubmissionEvidence(journalId)).toMatchObject({ kind, rail: "cashu" });
    // Neither abandoned nor left to resume.
    expect(onlyJournalEntry().accepted_unresolved).toMatchObject({ kind, ambiguity_id: journalId });
    const postsBefore = provider.jobPosts.length;

    const result = await seams.realSweep!({ fetchImpl: globalThis.fetch });

    expect(result.outcomes).toMatchObject([{ kind: "accepted_unresolved", evidence: "recorded" }]);
    expect(provider.jobPosts.length).toBe(postsBefore);
    expect(provider.paidPosts()).toHaveLength(1);
  });

  it("keeps a paid 409 that names no error as unresolved rather than a refusal", async () => {
    provider.recovery = false;
    provider.paid = () => (response) => {
      response.writeHead(409, { "Content-Type": "text/html" });
      response.end("<html>Conflict</html>");
    };

    const error = await paidRequest().catch((caught: unknown) => caught);

    const journalId = onlyJournalEntry().request_id;
    expect(error).toMatchObject({ code: "provider_body_unreadable" });
    expect(onlyJournalEntry().accepted_unresolved).toMatchObject({ kind: "body_unreadable", ambiguity_id: journalId });
  });

  it("wraps a --request-id failure with the inner code, both IDs and the evidence key", async () => {
    provider.paid = (_post, accepted) => answer(202, { job_id: "job-b", status: "processing" }, { [FIELD]: accepted });
    const requestId = randomUUID();

    const error = await paidRequest({ requestId }).catch((caught: unknown) => caught);

    const journalId = onlyJournalEntry().request_id;
    expect(error).toMatchObject({
      code: "request_outcome_unknown",
      data: {
        request_id: requestId,
        inner_code: "provider_identity_mismatch",
        header_job_id: "job-a",
        body_job_id: "job-b",
        ambiguity_id: journalId,
        cashu_request_id: journalId,
      },
    });
    expect(evidence.loadSubmissionEvidence(journalId)).toMatchObject({ request_id: requestId });
  });

  it("keeps the evidence apart from a local job that already holds an observed ID", async () => {
    jobs.saveJob({ id: "job-a", endpoint: "https://other.invalid", status: "submitted", submittedAt: 1 });
    const before = JSON.stringify(jobs.loadJob("job-a"));
    provider.recovery = false;
    provider.paid = (_post, accepted) => answer(202, { job_id: "job-b", status: "processing" }, { [FIELD]: accepted });

    await paidRequest().catch(() => undefined);

    expect(JSON.stringify(jobs.loadJob("job-a"))).toBe(before);
    expect(jobs.loadJob("job-b")).toBeNull();
    expect(evidence.loadSubmissionEvidence(onlyJournalEntry().request_id)).toMatchObject({
      header_job_id: "job-a",
      endpoint: provider.endpoint,
    });
  });

  it.each([
    { label: "no field and no job ID", reply: () => answer(202, { status: "processing" }) },
    { label: "an invalid field and no job ID", reply: (accepted: string) => answer(202, { status: "processing" }, { [FIELD]: [accepted, accepted] }) },
    { label: "a body that is not JSON", reply: () => answerText(202, "accepted") },
  ])("recovers a generated-ID submit answered with $label through request-result, paying once", async ({ reply }) => {
    provider.paid = (_post, accepted) => reply(accepted);

    const error = (await paidRequest().catch((caught: unknown) => caught)) as {
      code: string;
      hint: string;
      data: { request_id: string };
    };

    const requestId = error.data.request_id;
    expect(error).toMatchObject({ code: "request_outcome_unknown", data: { inner_code: "provider_body_unreadable" } });
    expect(error.hint).toContain(`dvm request-result ${requestId}`);
    expect(await seams.realSweep!({ fetchImpl: globalThis.fetch })).toMatchObject({
      outcomes: [{ kind: "accepted_unresolved" }],
    });

    await requestResult(requestId);

    expect(jobs.loadJob("job-a")).toMatchObject({ requestId, endpoint: provider.endpoint, jobToken: provider.token });
    expect(provider.resultPosts).toEqual([requestId]);
    expect(provider.paidPosts()).toHaveLength(1);
    // The held payment is confirmed by the job, not kept as unconfirmed.
    expect(sdk.loadAgentWallet()?.pending_submissions).toEqual([]);
  });

  it("points a request-result the router refuses at a direct read of the accepted job", async () => {
    provider.paid = (_post, accepted) => answer(202, { job_id: "job-b", status: "processing" }, { [FIELD]: accepted });
    const requestId = ((await paidRequest().catch((caught: unknown) => caught)) as {
      data: { request_id: string };
    }).data.request_id;
    provider.requestResult = () => routerConflict("job-a", requestId);

    const error = (await requestResult(requestId).catch((caught: unknown) => caught)) as {
      code: string;
      hint: string;
      data: { ambiguity_id: string };
    };

    expect(error.code).toBe("hosting_job_identity_conflict");
    expect(error.hint).toContain(
      `dvm status job-a --endpoint ${provider.endpoint} --job-token <job_token_bearer_secret>`
    );
    expect(error.hint).not.toContain(`dvm request-result ${requestId}`);
    expect(evidence.loadSubmissionEvidence(error.data.ambiguity_id)).toMatchObject({
      kind: "router_identity_conflict",
      request_id: requestId,
      accepted_job_id: "job-a",
      rail: "none",
    });
    expect(jobs.loadJob("job-a")).toBeNull();
  });

  it("records a draw-first probe's failure against the credit it drew on", async () => {
    writeConfig("auto");
    seedCredit(40_000);
    provider.recovery = false;
    provider.unpaid = () => answer(202, { job_id: "job-b", status: "processing" }, { [FIELD]: "job-a" });

    const error = await paidRequest().catch((caught: unknown) => caught);

    const ambiguityId = (error as { data: { ambiguity_id: string } }).data.ambiguity_id;
    expect(error).toMatchObject({ code: "provider_identity_mismatch" });
    expect(evidence.loadSubmissionEvidence(ambiguityId)).toMatchObject({
      rail: "credit",
      rail_correlation: { credit_id: "prepaid-credit", draw_id: expect.any(String) },
    });
    expect(provider.paidPosts()).toHaveLength(0);
  });
});

describe("a paid submit whose response is lost", () => {
  it("is read back through request-result on restart, with one payment and no second paid POST", async () => {
    // The provider accepts the job and the connection drops before it answers.
    // The retry meets the provider's claim on the request ID.
    provider.paid = () => (response) => response.socket?.destroy();

    const error = (await paidRequest().catch((caught: unknown) => caught)) as {
      code: string;
      hint: string;
      data: Record<string, unknown>;
    };

    const journalId = onlyJournalEntry().request_id;
    const requestId = error.data.request_id as string;
    expect(requestId).not.toBe(journalId);
    expect(error).toMatchObject({
      code: "request_outcome_unknown",
      data: { inner_code: "request_id_exists", spend_committed: true, cashu_request_id: journalId },
    });
    expect(error.hint).toContain(`dvm request-result ${requestId}`);
    expect(provider.jobPosts.map((post) => post.status)).toEqual([402, 0, 409]);
    const postsBefore = provider.jobPosts.length;

    const result = await seams.realSweep!({ fetchImpl: globalThis.fetch });

    expect(result.outcomes).toMatchObject([{ kind: "shipped", jobId: "job-a" }]);
    expect(provider.jobPosts.length).toBe(postsBefore);
    expect(provider.resultPosts).toEqual([requestId]);
    expect(new Set(provider.paidPosts().map((post) => post.payment))).toEqual(new Set(["cashuB-1"]));
    expect(seams.prepareAgentSpend).toHaveBeenCalledOnce();
    expect(jobs.loadJob("job-a")).toMatchObject({ requestId, endpoint: provider.endpoint, jobToken: provider.token });
    expect(jobs.loadJob("job-a")).not.toHaveProperty("feedbackClaim");
    expect(sdk.loadAgentWallet()?.pending_submissions).toEqual([]);
  });

  it("never overwrites a local job from another provider that shares the job ID it reads back", async () => {
    provider.paid = () => (response) => response.socket?.destroy();
    const requestId = ((await paidRequest().catch((caught: unknown) => caught)) as {
      data: { request_id: string };
    }).data.request_id;
    jobs.saveJob({ id: "job-a", endpoint: "https://other.invalid", status: "submitted", submittedAt: 1, jobToken: "d".repeat(64) });
    const before = JSON.stringify(jobs.loadJob("job-a"));
    const postsBefore = provider.jobPosts.length;

    const swept = await seams.realSweep!({ fetchImpl: globalThis.fetch });
    const keptBySweep = evidence.listSubmissionEvidence().records;
    const error = (await requestResult(requestId).catch((caught: unknown) => caught)) as {
      code: string;
      hint: string;
      data: { ambiguity_id: string };
    };
    // The next pass reconciles evidence against the journal before any POST.
    const sweptAgain = await seams.realSweep!({ fetchImpl: globalThis.fetch });

    expect(swept.outcomes).toMatchObject([{ kind: "still_pending", reason: expect.stringContaining("request_result_conflict") }]);
    expect(sweptAgain.outcomes).toMatchObject([{ kind: "still_pending" }]);
    expect(error).toMatchObject({ code: "request_result_conflict", data: { local_endpoint: "https://other.invalid", server_job_id: "job-a" } });
    expect(JSON.stringify(jobs.loadJob("job-a"))).toBe(before);
    expect(provider.jobPosts.length).toBe(postsBefore);
    expect(onlyJournalEntry().accepted_unresolved).toBeUndefined();

    // The recovered job's token is kept as evidence, once, by the sweep and the command alike.
    const kept = evidence.loadSubmissionEvidence(error.data.ambiguity_id);
    expect(keptBySweep).toEqual([kept]);
    expect(kept).toMatchObject({
      kind: "local_job_collision",
      request_id: requestId,
      accepted_job_id: "job-a",
      endpoint: provider.endpoint,
      job_token: provider.token,
    });
    expect(error.hint).toContain(`evidence row ${error.data.ambiguity_id} in 'dvm wallet submissions'`);
    // The hint can be followed: the row's read is a status call with the row's
    // own endpoint and token, which reach the recovered job and not the local one.
    const [row] = views.describeSubmissionEvidence([kept!]);
    expect(row.read_job).toEqual([
      `DVM_JOB_TOKEN=<job_token_bearer_secret> dvm status job-a --endpoint ${provider.endpoint}`,
    ]);
    expect(access.resolveJobAccess("job-a", { endpoint: provider.endpoint, jobToken: row.job_token_bearer_secret })).toMatchObject({
      stored: null,
      ref: { endpoint: provider.endpoint },
      jobToken: provider.token,
    });
    expect(() => access.resolveJobAccess("job-a", { endpoint: provider.endpoint })).toThrowError(
      expect.objectContaining({ code: "job_token_required", data: expect.objectContaining({ ambiguity_id: error.data.ambiguity_id }) })
    );
  });

  it("reads back a request ID holding a colon, signed over the encoded path it is sent to", async () => {
    provider.paid = () => (response) => response.socket?.destroy();
    await paidRequest({ requestId: "order:42" }).catch(() => undefined);

    await requestResult("order:42");

    expect(provider.resultPosts).toEqual(["order:42"]);
    expect(jobs.loadJob("job-a")).toMatchObject({ requestId: "order:42", jobToken: provider.token });
  });

  it("resumes a request ID holding a colon, signed over the encoded path it is sent to", async () => {
    provider.paid = () => (response) => response.socket?.destroy();
    provider.bindsPaid = false;
    await paidRequest({ requestId: "order:43" }).catch(() => undefined);

    await requestResume("order:43");

    expect(provider.resumePosts).toEqual(["order:43"]);
    expect(jobs.loadJob("job-a")).toMatchObject({ requestId: "order:43", jobToken: provider.token });
  });

  it("re-sends the same payment on restart when the provider never received the request", async () => {
    provider.paid = () => (response) => response.socket?.destroy();
    provider.bindsPaid = false;

    await paidRequest().catch(() => undefined);
    provider.bindsPaid = true;
    provider.paid = (_post, accepted) => answer(202, { job_id: accepted, status: "processing" }, { [FIELD]: accepted });
    const result = await seams.realSweep!({ fetchImpl: globalThis.fetch });

    expect(result.outcomes).toMatchObject([{ kind: "shipped", jobId: "job-a" }]);
    expect(provider.resultPosts).toHaveLength(1);
    expect(new Set(provider.paidPosts().map((post) => post.payment))).toEqual(new Set(["cashuB-1"]));
  });
});

describe("generated request IDs", () => {
  it("binds a per-call paid submit to a recovery-capable provider to a persisted request ID", async () => {
    await paidRequest();

    const [probe, paid] = provider.jobPosts;
    expect(probe.body).not.toHaveProperty("request_id");
    const requestId = paid.body.request_id as string;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(intents.loadRequestIntent(requestId)?.body.data).toMatchObject({ request_id: requestId });
    expect(onlyJournalEntry().context?.submit_body.data).toMatchObject({ request_id: requestId });
  });

  it("leaves a provider without recovery none, per-call and credit-funded alike", async () => {
    provider.recovery = false;
    await paidRequest();
    writeConfig("auto");
    seedCredit(0);
    await paidRequest();
    seedCredit(40_000);
    provider.draw = completeDraw;
    await paidRequest();

    const paid = provider.paidPosts().map((post) => post.body);
    expect(paid).toHaveLength(2);
    expect(paid[0]).not.toHaveProperty("request_id");
    expect(paid[1]).toHaveProperty("fund");
    expect(paid[1]).not.toHaveProperty("request_id");
    const drawn = provider.jobPosts.at(-1)!.body;
    expect(drawn).toHaveProperty("credit_id");
    expect(drawn).not.toHaveProperty("request_id");
    expect(existsSync(sdk.REQUEST_INTENTS_DIR) ? readdirSync(sdk.REQUEST_INTENTS_DIR) : []).toEqual([]);
  });

  it("keeps a provider's refusal of the payment under its own code", async () => {
    provider.paid = () => answer(402, { error: "payment_insufficient", required_msats: 2_000, received_msats: 1_000 });

    await expect(paidRequest()).rejects.toMatchObject({ code: "payment_insufficient" });
  });

  it("names the request ID beside the wallet's own on a paid failure it does not wrap", async () => {
    provider.paid = () => answer(500, { error: "internal_error", message: "The provider failed." });

    const error = await paidRequest().catch((caught: unknown) => caught);

    const requestId = provider.paidPosts()[0].body.request_id as string;
    expect(error).toMatchObject({
      code: "internal_error",
      data: { spend_committed: true, request_id: requestId, cashu_request_id: onlyJournalEntry().request_id },
    });
    expect((error as { data: { display: string } }).data.display).toContain(`reads request ${requestId} back`);
  });

  it("keeps a timeout raised before any payment under its own code", async () => {
    seams.prepareAgentSpend.mockRejectedValue(new sdk.DvmError("timeout", "The mint did not answer."));

    await expect(paidRequest()).rejects.toMatchObject({ code: "timeout" });
    expect(provider.paidPosts()).toHaveLength(0);
  });
});

describe("a credit-funded submit to a recovery-capable provider", () => {
  it.each(["read-back", "re-ship", "direct"])("counts a lost rail submit once through %s recovery and subsequent charges", async (recovery) => {
    writeConfig("auto");
    seedCredit(0);
    provider.bindsPaid = recovery !== "re-ship";
    provider.paid = () => (response) => response.socket?.destroy();
    await expect(paidRequest({ budget: "10000", maxPayments: "2", stream: false })).rejects.toBeInstanceOf(Error);
    const entry = onlyJournalEntry();
    const requestId = provider.paidPosts()[0].body.request_id as string;
    expect(jobs.loadJob("job-a")).toBeNull();
    expect(intents.loadRequestIntent(requestId)?.railPayment).toEqual({ method: "cashu", amountMsats: 1000 });
    expect(entry.amount_sats).toBeGreaterThan(1);
    const before = budget.loadLedger();
    const postsBeforeRecovery = provider.jobPosts.length;
    provider.bindsPaid = true;
    provider.paid = (_post, accepted) => answer(202, { job_id: accepted, job_token: provider.token,
      status: "processing" }, { [FIELD]: accepted });
    if (recovery === "direct") await requestResult(requestId);
    else await seams.realSweep!({ fetchImpl: globalThis.fetch });
    expect(provider.jobPosts).toHaveLength(postsBeforeRecovery + (recovery === "re-ship" ? 1 : 0));
    expect(jobs.loadJob("job-a")).toMatchObject({ totalPaidMsats: 1000, paymentsHonoured: 1, paymentMethod: "cashu" });

    seedCredit(40000);
    const { handlePaymentRequest } = await import("../src/lib/payment-responder");
    const { HttpsTransport } = await import("../src/lib/transport/https");
    const policy = jobs.loadJob("job-a")!.policy!;
    const transport = new HttpsTransport();
    await expect(handlePaymentRequest("job-a", { amount_msats: 3000, reason: "More",
      credit: { amount_micro: 3000, currency: "usd" } }, policy,
      transport, { endpoint: provider.endpoint }, { requestSeq: 4 })).resolves.toMatchObject({ rail: "credit", amountMsats: 3000 });
    await requestResult(requestId);
    await requestResult(requestId);
    // Reconcile a journal surviving the job write, after a later payment.
    sdk.saveAgentWallet({ ...sdk.loadAgentWallet()!, pending_submissions: [entry] });
    await seams.realSweep!({ fetchImpl: globalThis.fetch });
    expect(jobs.loadJob("job-a")).toMatchObject({ totalPaidMsats: 4000, paymentsHonoured: 2 });
    await expect(handlePaymentRequest("job-a", { amount_msats: 7000, reason: "More" }, policy,
      transport, { endpoint: provider.endpoint }, { requestSeq: 6 })).resolves.toBe("over-budget");
    await expect(handlePaymentRequest("job-a", { amount_msats: 100, reason: "More" }, policy,
      transport, { endpoint: provider.endpoint }, { requestSeq: 6 })).resolves.toBe("payment-cap-exceeded");
    expect(provider.balancePayments).toHaveLength(1);
    expect(sdk.loadAgentWallet()?.recent_spends).toHaveLength(1);
    expect(budget.loadLedger()).toEqual(before);
  });

  it.each(["prepaid", "implicit"])("counts the original %s draw before authorizing later charges", async (source) => {
    writeConfig("auto");
    seedCredit(40_000);
    if (source === "implicit") {
      const state = JSON.parse(readFileSync(join(root, "credits.json"), "utf8"));
      state.implicitCredits = [{ ...state.credits[0], creditId: "imp:cashu:released",
        releasedByJobId: "prior-job", releasedAt: Date.now() }];
      state.credits = [];
      writeFileSync(join(root, "credits.json"), JSON.stringify(state));
    }
    let upfront: Record<string, unknown>;
    provider.draw = (post, accepted) => {
      upfront = { amount_msats: 6000, amount_micro: 6000, currency: "usd",
        credit_id: post.body.credit_id, draw_id: post.body.draw_id, rail: "cashu" };
      return answer(202, { job_id: accepted, status: "processing", job_token: provider.token,
        upfront_payment: upfront }, { [FIELD]: accepted });
    };
    const before = budget.loadLedger();
    await paidRequest({ budget: "10000", maxPayments: "3", stream: false });
    const requestId = provider.jobPosts[0].body.request_id as string;
    expect(jobs.loadJob("job-a")).toMatchObject({ totalPaidMsats: 6000, paymentsHonoured: 1,
      upfrontCreditBooked: true, upfrontPayment: { amount_msats: 6000 } });
    const { handlePaymentRequest } = await import("../src/lib/payment-responder");
    const { HttpsTransport } = await import("../src/lib/transport/https");
    const transport = new HttpsTransport();
    const policy = jobs.loadJob("job-a")!.policy!;
    const ask = { amount_msats: 3000, reason: "Additional work", credit: { amount_micro: 3000, currency: "usd" } };
    await expect(handlePaymentRequest("job-a", ask, policy, transport,
      { endpoint: provider.endpoint }, { requestSeq: 4 })).resolves.toMatchObject({ rail: "credit", amountMsats: 3000 });
    provider.requestResult = () => answer(202, { request_id: requestId, job_id: "job-a", status: "processing",
      job_token: provider.token, upfront_payment: upfront });
    seams.rate = 200_000;
    await requestResult(requestId);
    await requestResult(requestId);
    expect(jobs.loadJob("job-a")).toMatchObject({ totalPaidMsats: 9000, paymentsHonoured: 2,
      upfrontPayment: { amount_msats: 6000, amount_micro: 6000 } });
    await expect(handlePaymentRequest("job-a", ask, policy, transport,
      { endpoint: provider.endpoint }, { requestSeq: 6 })).resolves.toBe("over-budget");
    expect(provider.balancePayments).toHaveLength(1);
    expect(budget.loadLedger()).toEqual(before);
  });

  it("counts a recovered draw toward max-payments without drawing again", async () => {
    writeConfig("auto");
    seedCredit(40_000);
    provider.draw = () => (response) => response.socket?.destroy();
    await expect(paidRequest({ budget: "10000", maxPayments: "1", stream: false })).rejects.toMatchObject({ code: "request_outcome_unknown" });
    const original = provider.jobPosts[0].body;
    const requestId = original.request_id as string;
    provider.requestResult = () => answer(202, { request_id: requestId, job_id: "job-a", status: "processing",
      job_token: provider.token, upfront_payment: { amount_msats: 6000,
        credit_id: original.credit_id, draw_id: original.draw_id } });
    await requestResult(requestId);
    await requestResult(requestId);
    const { handlePaymentRequest } = await import("../src/lib/payment-responder");
    const { HttpsTransport } = await import("../src/lib/transport/https");
    await expect(handlePaymentRequest("job-a", { amount_msats: 1000, reason: "More" }, jobs.loadJob("job-a")!.policy!,
      new HttpsTransport(), { endpoint: provider.endpoint }, { requestSeq: 4 })).resolves.toBe("payment-cap-exceeded");
    expect(jobs.loadJob("job-a")).toMatchObject({ totalPaidMsats: 6000, paymentsHonoured: 1 });
    expect(provider.jobPosts).toHaveLength(1);
    expect(seams.prepareAgentSpend).not.toHaveBeenCalled();
  });

  it.each([undefined, { amount_msats: -1 }, { amount_msats: 1000, credit_id: "wrong", draw_id: "wrong" }])(
    "refuses further payments when the accepted draw evidence is unknown or invalid: %j", async (upfront) => {
      writeConfig("auto");
      seedCredit(40_000);
      provider.draw = (_post, accepted) => answer(202, { job_id: accepted, status: "processing",
        upfront_payment: upfront }, { [FIELD]: accepted });
      await paidRequest({ stream: false });
      const { handlePaymentRequest } = await import("../src/lib/payment-responder");
      const { HttpsTransport } = await import("../src/lib/transport/https");
      await expect(handlePaymentRequest("job-a", { amount_msats: 1000, reason: "More" }, jobs.loadJob("job-a")!.policy!,
        new HttpsTransport(), { endpoint: provider.endpoint }, { requestSeq: 4 })).rejects.toMatchObject({ code: "upfront_credit_unknown" });
      expect(provider.balancePayments).toHaveLength(0);
      expect(seams.prepareAgentSpend).not.toHaveBeenCalled();
    });

  it("does not count fund-and-draw consumption a second time", async () => {
    writeConfig("auto");
    seedCredit(0);
    provider.paid = (post, accepted) => answer(200, { job_id: accepted, status: "completed", summary: "Done",
      upfront_payment: { amount_msats: 1000, amount_micro: 1000, currency: "usd",
        credit_id: post.body.credit_id, draw_id: post.body.draw_id } }, { [FIELD]: accepted });
    await paidRequest();
    expect(jobs.loadJob("job-a")).toMatchObject({ totalPaidMsats: 1000, paymentsHonoured: 1 });
    const requestId = provider.paidPosts()[0].body.request_id as string;
    const body = provider.paidPosts()[0].body;
    provider.requestResult = () => answer(202, { request_id: requestId, job_id: "job-a", status: "processing",
      upfront_payment: { amount_msats: 1000, credit_id: body.credit_id, draw_id: body.draw_id } });
    await requestResult(requestId);
    expect(jobs.loadJob("job-a")).toMatchObject({ totalPaidMsats: 1000, paymentsHonoured: 1 });
  });

  it("binds a fund-and-draw to a persisted request ID on its final signed data", async () => {
    writeConfig("auto");
    seedCredit(0);

    await paidRequest();

    const [probe, paid] = provider.jobPosts;
    expect(probe.body).not.toHaveProperty("request_id");
    expect(paid.body).toMatchObject({ credit_id: "prepaid-credit", fund: { amount_micro: expect.any(Number) } });
    const requestId = paid.body.request_id as string;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    // The intent and the journal both hold the exact unsigned data that was
    // sent, commitment included, so a read-back or a re-ship fingerprints alike.
    expect(intents.loadRequestIntent(requestId)?.body.data).toEqual(paid.body);
    expect(onlyJournalEntry().context?.submit_body.data).toEqual(paid.body);
    expect(jobs.loadJob("job-a")).toMatchObject({ requestId });
  });

  it("binds a draw-first probe to a persisted request ID with no payment", async () => {
    writeConfig("auto");
    seedCredit(40_000);
    provider.draw = completeDraw;

    await paidRequest();

    expect(provider.jobPosts).toHaveLength(1);
    const [drawn] = provider.jobPosts;
    expect(drawn.body).toMatchObject({ credit_id: "prepaid-credit", draw_id: expect.any(String) });
    const requestId = drawn.body.request_id as string;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(intents.loadRequestIntent(requestId)?.body.data).toEqual(drawn.body);
    expect(jobs.loadJob("job-a")).toMatchObject({ requestId, paymentMethod: "credit",
      creditBinding: { creditId: "prepaid-credit", drawId: drawn.body.draw_id, callerPubkey: sdk.receiptPubkeyFromSecret(secret) } });
    expect(seams.prepareAgentSpend).not.toHaveBeenCalled();
  });

  it("re-sends the same request ID and data when the fund-and-draw's first attempt drops", async () => {
    writeConfig("auto");
    seedCredit(0);
    provider.bindsPaid = false;
    let attempts = 0;
    provider.paid = (post, accepted) =>
      attempts++ === 0
        ? (response) => response.socket?.destroy()
        : answer(200, { job_id: accepted, status: "completed", summary: "Done" }, { [FIELD]: accepted });

    await paidRequest();

    expect(provider.jobPosts.map((post) => post.status)).toEqual([402, 0, 200]);
    const [first, second] = provider.paidPosts();
    expect(first.body).toHaveProperty("request_id");
    expect(second.body).toEqual(first.body);
    expect(second.payment).toBe(first.payment);
    expect(seams.prepareAgentSpend).toHaveBeenCalledOnce();
  });

  it("reads a lost fund-and-draw back through request-result on restart, with one payment", async () => {
    writeConfig("auto");
    seedCredit(0);
    provider.paid = () => (response) => response.socket?.destroy();

    const error = (await paidRequest().catch((caught: unknown) => caught)) as {
      code: string;
      data: Record<string, unknown>;
    };

    const requestId = error.data.request_id as string;
    expect(error).toMatchObject({
      code: "request_outcome_unknown",
      data: { inner_code: "request_id_exists", spend_committed: true, cashu_request_id: onlyJournalEntry().request_id },
    });
    expect(provider.jobPosts.map((post) => post.status)).toEqual([402, 0, 409]);
    const postsBefore = provider.jobPosts.length;

    const result = await seams.realSweep!({ fetchImpl: globalThis.fetch });

    expect(result.outcomes).toMatchObject([{ kind: "shipped", jobId: "job-a" }]);
    expect(provider.jobPosts.length).toBe(postsBefore);
    expect(provider.resultPosts).toEqual([requestId]);
    expect(new Set(provider.paidPosts().map((post) => post.payment))).toEqual(new Set(["cashuB-1"]));
    expect(seams.prepareAgentSpend).toHaveBeenCalledOnce();
    expect(jobs.loadJob("job-a")).toMatchObject({ requestId, jobToken: provider.token });
  });

  it.each([
    { recovery: "read-back", existing: false },
    { recovery: "read-back", existing: true },
    { recovery: "re-ship", existing: false },
    { recovery: "re-ship", existing: true },
  ])("retains the accepted draw on $recovery recovery (existing record: $existing) for a later balance ask", async ({ recovery, existing }) => {
    writeConfig("auto");
    seedCredit(0);
    provider.bindsPaid = recovery === "read-back";
    provider.paid = () => (response) => response.socket?.destroy();
    await expect(paidRequest()).rejects.toBeInstanceOf(Error);
    const original = provider.paidPosts()[0].body;
    const publicId = original.request_id as string;
    if (existing) jobs.saveJob({ id: "job-a", endpoint: provider.endpoint, status: "processing",
      submittedAt: Date.now(), requestId: publicId, policy: { maxTotalMsats: 100000,
        maxIncrementMsats: 100000, autoPayBelowMsats: 100000, maxPayments: 5 } });
    provider.paid = (_post, accepted) => answer(200, { job_id: accepted, job_token: provider.token, status: "completed", summary: "Done" }, { [FIELD]: accepted });
    const postsBefore = provider.jobPosts.length;
    const result = await seams.realSweep!({ fetchImpl: globalThis.fetch });
    expect(result.outcomes).toMatchObject([{ kind: "shipped", jobId: "job-a" }]);
    expect(provider.jobPosts.length).toBe(postsBefore + (recovery === "re-ship" ? 1 : 0));
    expect(jobs.loadJob("job-a")?.creditBinding).toEqual({ creditId: "prepaid-credit",
      drawId: original.draw_id, callerPubkey: sdk.receiptPubkeyFromSecret(secret) });
    expect(jobs.loadAllJobs().filter((job) => job.id === "job-a")).toHaveLength(1);
    seedCredit(40000);
    const before = budget.loadLedger();
    const { handlePaymentRequest } = await import("../src/lib/payment-responder");
    const { HttpsTransport } = await import("../src/lib/transport/https");
    await expect(handlePaymentRequest("job-a", { amount_msats: 1500, reason: "Additional work",
      credit: { amount_micro: 1500, currency: "usd" } }, jobs.loadJob("job-a")!.policy!,
      new HttpsTransport(), { endpoint: provider.endpoint }, { requestSeq: 4 }))
      .resolves.toMatchObject({ rail: "credit", amountMsats: 1500 });
    expect(provider.balancePayments).toMatchObject([{ credit_id: "prepaid-credit", draw_id: original.draw_id,
      pubkey: sdk.receiptPubkeyFromSecret(secret), request_seq: 4 }]);
    expect(budget.loadLedger()).toEqual(before);
  });

  it("reads a lost draw back through request-result with no second draw or payment", async () => {
    writeConfig("auto");
    seedCredit(40_000);
    provider.draw = () => (response) => response.socket?.destroy();

    const error = (await paidRequest().catch((caught: unknown) => caught)) as {
      code: string;
      hint: string;
      data: Record<string, unknown>;
    };

    const requestId = error.data.request_id as string;
    expect(error).toMatchObject({ code: "request_outcome_unknown", data: { status: "unknown" } });
    expect(error.hint).toContain(`dvm request-result ${requestId}`);
    expect(provider.jobPosts).toHaveLength(1);

    await requestResult(requestId);

    expect(provider.resultPosts).toEqual([requestId]);
    expect(provider.jobPosts).toHaveLength(1);
    expect(jobs.loadJob("job-a")).toMatchObject({ requestId, endpoint: provider.endpoint, jobToken: provider.token });
    expect(seams.prepareAgentSpend).not.toHaveBeenCalled();
  });

  it("retains a signed free-start job across read-back before its first balance ask", async () => {
    provider.unpaid = () => answer(202, { job_id: "job-a", status: "processing", job_token: provider.token }, { [FIELD]: "job-a" });
    await paidRequest({ requestId: "free-start", stream: false });
    expect(jobs.loadJob("job-a")?.creditBinding).toEqual({ unbound: true, callerPubkey: sdk.receiptPubkeyFromSecret(secret) });
    expect(jobs.loadJob("job-a")?.upfrontRailPayment).toBe("free");
    provider.requestResult = () => answer(202, { request_id: "free-start", job_id: "job-a", status: "processing", job_token: provider.token });
    await requestResult("free-start");
    writeConfig("auto");
    seedCredit(40000);
    const { handlePaymentRequest } = await import("../src/lib/payment-responder");
    const { HttpsTransport } = await import("../src/lib/transport/https");
    await expect(handlePaymentRequest("job-a", { amount_msats: 1000, reason: "Metered work",
      credit: { amount_micro: 1000, currency: "usd" } }, jobs.loadJob("job-a")!.policy!,
      new HttpsTransport(), { endpoint: provider.endpoint }, { requestSeq: 4 }))
      .resolves.toMatchObject({ rail: "credit", amountMsats: 1000 });
    await requestResult("free-start");
    expect(jobs.loadJob("job-a")).toMatchObject({ totalPaidMsats: 1000, paymentsHonoured: 1, upfrontRailPayment: "free" });
    expect(provider.balancePayments).toHaveLength(1);
    expect(seams.prepareAgentSpend).not.toHaveBeenCalled();
  });

  it("persists the accepted replacement draw after a draw conflict", async () => {
    writeConfig("auto");
    seedCredit(40_000);
    provider.draw = (post, accepted) => provider.jobPosts.indexOf(post) === 0
      ? answer(409, { error: "draw_conflict" })
      : answer(200, { job_id: accepted, status: "completed", summary: "Done" }, { [FIELD]: accepted });
    await paidRequest();
    const [refused, replacement] = provider.jobPosts.map((post) => post.body);
    expect(replacement.draw_id).not.toBe(refused.draw_id);
    expect(jobs.loadJob("job-a")?.creditBinding).toEqual({ creditId: "prepaid-credit",
      drawId: replacement.draw_id, callerPubkey: sdk.receiptPubkeyFromSecret(secret) });
  });

  it("records an identity failure on a draw-conflict resubmit under the ID that draw carried", async () => {
    writeConfig("auto");
    seedCredit(40_000);
    provider.draw = (post, accepted) =>
      provider.jobPosts.indexOf(post) === 0
        ? answer(409, { error: "draw_conflict", message: "This draw id was already used." })
        : answer(202, { job_id: "job-b", status: "processing" }, { [FIELD]: accepted });

    const error = (await paidRequest().catch((caught: unknown) => caught)) as {
      code: string;
      hint: string;
      data: Record<string, unknown>;
    };

    const [refused, resubmitted] = provider.jobPosts.map((post) => post.body);
    expect(provider.jobPosts.map((post) => post.status)).toEqual([409, 202]);
    expect(resubmitted.draw_id).not.toBe(refused.draw_id);
    const requestId = resubmitted.request_id as string;
    expect(requestId).not.toBe(refused.request_id);
    // The refused draw's ID is bound to data the provider refused; only the
    // resubmitted draw can be read back, so the evidence must name its ID.
    expect(error).toMatchObject({
      code: "request_outcome_unknown",
      data: { request_id: requestId, identity_kind: "identity_mismatch" },
    });
    expect(error.hint).toContain(`dvm request-result ${requestId}`);
    expect(evidence.loadSubmissionEvidence(error.data.ambiguity_id as string)).toMatchObject({
      rail: "credit",
      request_id: requestId,
      rail_correlation: { draw_id: resubmitted.draw_id },
    });
    expect(seams.prepareAgentSpend).not.toHaveBeenCalled();
  });

  it("sends a corrected fund amount as a new request, without the refused ID", async () => {
    writeConfig("auto");
    seedCredit(0);
    provider.paid = (post, accepted) =>
      (post.body.fund as { amount_micro: number }).amount_micro === 777
        ? answer(200, { job_id: accepted, status: "completed", summary: "Done" }, { [FIELD]: accepted })
        : answer(400, {
            error: "funding_commitment_mismatch",
            message: "fund.amount_micro (41000) does not match the attached authorization's value at the quoted price (777).",
          });

    await paidRequest();

    // The refused POST bound the ID to the refused data; a corrected block
    // under the same ID would be refused as `request_id_exists`.
    expect(provider.jobPosts.map((post) => post.status)).toEqual([402, 400, 200]);
    const [refused, corrected] = provider.paidPosts();
    expect(refused.body).toHaveProperty("request_id");
    expect(corrected.body).not.toHaveProperty("request_id");
    expect(corrected.body).toMatchObject({ fund: { amount_micro: 777 } });
    expect(onlyJournalEntry().context?.submit_body.data).not.toHaveProperty("request_id");
    expect(jobs.loadJob("job-a")?.requestId).toBeUndefined();
  });
});

describe("an x402 payment whose outcome is unknown", () => {
  it.each([
    {
      label: "an identity failure",
      reply: (accepted: string) => answer(202, { job_id: "job-b", status: "processing" }, { [FIELD]: accepted }),
      innerCode: "provider_identity_mismatch",
    },
    { label: "a lost response", reply: () => (response: ServerResponse) => response.socket?.destroy(), innerCode: "provider_unreachable" },
  ])("after $label is counted against the budget once, as unconfirmed", async ({ reply, innerCode }) => {
    seams.x402Wallet = { privateKey: `0x${"55".repeat(32)}`, address: "", network: "eip155:84532" };
    provider.x402 = true;
    provider.paid = (_post, accepted) => reply(accepted);

    const error = (await paidRequest({ rail: "x402" }).catch((caught: unknown) => caught)) as {
      data: Record<string, unknown>;
    };

    const requestId = error.data.request_id as string;
    expect(error).toMatchObject({ code: "request_outcome_unknown", data: { inner_code: innerCode } });
    expect(provider.paidPosts()).toMatchObject([{ rail: "x402" }]);
    expect(budget.loadLedger().entries).toMatchObject([
      { jobId: requestId, providerEndpoint: provider.endpoint, label: "unconfirmed · echo" },
    ]);
    if (innerCode === "provider_identity_mismatch") {
      expect(evidence.loadSubmissionEvidence(error.data.ambiguity_id as string)).toMatchObject({
        rail: "x402",
        request_id: requestId,
      });
    }
  });
});

interface JobPost {
  paid: boolean;
  rail: "cashu" | "x402" | null;
  payment?: string;
  /** The signed body with its envelope removed. */
  body: Record<string, unknown>;
  /** The status answered; 0 when the connection was dropped. */
  status: number;
}

type Reply = (response: ServerResponse) => void;

interface Provider {
  endpoint: string;
  /** Advertise `request_recovery`. */
  recovery: boolean;
  /** Advertise and accept x402. */
  x402: boolean;
  /** False to bind no job to a paid submit, as if it never arrived. */
  bindsPaid: boolean;
  /** The job token every accepted job is issued. */
  token: string;
  jobPosts: JobPost[];
  resultPosts: string[];
  resumePosts: string[];
  balancePayments: Record<string, unknown>[];
  unpaid: (post: JobPost) => Reply;
  /** How a paid submit is answered once accepted as job `accepted`. */
  paid: (post: JobPost, accepted: string) => Reply;
  /**
   * How an unpaid submit that draws on a credit is answered once accepted as
   * job `accepted`. Unset, a draw is answered like any unpaid submit.
   */
  draw?: (post: JobPost, accepted: string) => Reply;
  /** Overrides the request-result answer. */
  requestResult?: (requestId: string) => Reply;
  paidPosts(): JobPost[];
}

interface BoundRequest {
  jobId: string;
  pubkey: string;
  fingerprint: string;
}

/**
 * A provider with the SDK's request-ID semantics: a submit carrying a public
 * request ID holds a claim while it is handled, and once a job is bound to the
 * ID every later submit of it is answered `request_id_exists` before payment
 * is looked at. Request-result verifies the signature against its own path and
 * answers only the same signer's same request. Request-resume checks the
 * signature the same way and binds the request, as the SDK does once it
 * resumes a committed draw; the fixture holds no draw.
 */
async function startProvider(): Promise<Provider> {
  const live = new Set<string>();
  const bound = new Map<string, BoundRequest>();
  const verifier = verifierFor(anySchema, { replayStore: null });
  const state: Provider = {
    endpoint: "",
    recovery: true,
    x402: false,
    bindsPaid: true,
    token: "c".repeat(64),
    jobPosts: [],
    resultPosts: [],
    resumePosts: [],
    balancePayments: [],
    unpaid: () => answer(402, {
      error: "payment_required",
      required_msats: 1_000,
      price_micro: 1_000,
      price_currency: "usd",
      mints: [mint],
      credit: creditTerms,
    }),
    paid: () => answer(200, { job_id: "job-a", status: "completed", summary: "Done" }, { [FIELD]: "job-a" }),
    paidPosts: () => state.jobPosts.filter((post) => post.paid),
  };

  const verified = (request: IncomingMessage, raw: Record<string, unknown>) => {
    const url = new URL(request.url ?? "/", state.endpoint);
    const envelope = verifier.checkAuth(raw.data, {
      audience,
      method: "POST",
      path: sdk.canonicalRequestPath(url.href),
      capability: typeof raw.capability === "string" ? raw.capability : null,
    }) as unknown as { pubkey: string };
    const unsigned = sdk.unsignRequestData(raw.data as Record<string, unknown>)?.body ?? {};
    const fingerprint = JSON.stringify(sorted({ capability: raw.capability, input: raw.input, params: raw.params, data: unsigned }));
    return { pubkey: envelope.pubkey, unsigned, fingerprint };
  };

  const onJob = (request: IncomingMessage, response: ServerResponse, raw: Record<string, unknown>) => {
    const { pubkey, unsigned, fingerprint } = verified(request, raw);
    const cashu = request.headers["x-cashu"];
    const x402 = request.headers["payment-signature"] ?? request.headers["x-payment"];
    const post: JobPost = {
      paid: cashu !== undefined || x402 !== undefined,
      rail: cashu !== undefined ? "cashu" : x402 !== undefined ? "x402" : null,
      ...(typeof cashu === "string" ? { payment: cashu } : {}),
      body: unsigned,
      status: 0,
    };
    state.jobPosts.push(post);
    response.once("finish", () => (post.status = response.statusCode));
    const requestId = typeof unsigned.request_id === "string" ? unsigned.request_id : undefined;
    if (requestId && (live.has(requestId) || bound.has(requestId))) {
      return answer(409, {
        error: "request_id_exists",
        message: "This request id is already reserved or bound to an accepted request.",
        hint: `Run dvm request-result ${requestId}; do not submit or pay again.`,
        request_id: requestId,
      })(response);
    }
    if (requestId) {
      live.add(requestId);
      response.once("close", () => live.delete(requestId));
    }
    const drawn = !post.paid && typeof unsigned.credit_id === "string" ? state.draw : undefined;
    if (!post.paid && !drawn) return state.unpaid(post)(response);
    const accepted = "job-a";
    if (requestId && state.bindsPaid) bound.set(requestId, { jobId: accepted, pubkey, fingerprint });
    (drawn ?? state.paid)(post, accepted)(response);
  };

  const onRequestResult = (request: IncomingMessage, response: ServerResponse, raw: Record<string, unknown>, requestId: string) => {
    state.resultPosts.push(requestId);
    const override = state.requestResult?.(requestId);
    if (override) return override(response);
    let signer;
    try {
      signer = verified(request, raw);
    } catch {
      return answer(401, { error: "auth_error" })(response);
    }
    const job = bound.get(requestId);
    if (
      signer.unsigned.request_id !== requestId ||
      !job ||
      job.pubkey !== signer.pubkey ||
      job.fingerprint !== signer.fingerprint
    ) {
      return answer(404, { error: "request_not_found", status: "unknown", request_id: requestId })(response);
    }
    answer(202, { request_id: requestId, job_id: job.jobId, status: "processing", job_token: state.token }, { [FIELD]: job.jobId })(response);
  };

  const onRequestResume = (request: IncomingMessage, response: ServerResponse, raw: Record<string, unknown>, requestId: string) => {
    state.resumePosts.push(requestId);
    let signer;
    try {
      signer = verified(request, raw);
    } catch {
      return answer(401, { error: "auth_error" })(response);
    }
    if (signer.unsigned.request_id !== requestId) {
      return answer(404, { error: "request_not_found", status: "unknown", request_id: requestId })(response);
    }
    bound.set(requestId, { jobId: "job-a", pubkey: signer.pubkey, fingerprint: signer.fingerprint });
    answer(202, { request_id: requestId, status: "processing" })(response);
  };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => {
      const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
      if (request.method === "GET" && path === "/v1/info") return answer(200, info(state))(response);
      const raw = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      if (request.method === "POST" && path === "/v1/job") return onJob(request, response, raw);
      if (request.method === "POST" && path === "/v1/job/job-a/messages") {
        const authorization = (raw.content as { credit: Record<string, unknown> }).credit;
        verifier.checkAuth(authorization, { audience, method: "POST", path, capability: null });
        expect(request.headers["x-job-token"]).toBe(state.token);
        state.balancePayments.push(authorization);
        return answer(201, { seq: 5 })(response);
      }
      const result = /^\/v1\/request-result\/([^/]+)$/.exec(path);
      if (request.method === "POST" && result) {
        return onRequestResult(request, response, raw, decodeURIComponent(result[1]));
      }
      const resume = /^\/v1\/request-resume\/([^/]+)$/.exec(path);
      if (request.method === "POST" && resume) {
        return onRequestResume(request, response, raw, decodeURIComponent(resume[1]));
      }
      answer(404, { error: "not_found" })(response);
    });
  });
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  state.endpoint = `http://127.0.0.1:${address.port.toString()}`;
  return state;
}

function info(state: Provider): Record<string, unknown> {
  return {
    name: "Test provider",
    auth: ["secp256k1-schnorr-v2"],
    auth_audience: audience,
    capabilities: { echo: { description: "Echo" } },
    cashu: { mints: [mint], lock_pubkeys: [lockPubkey], min_locktime: 60, canonical_id: null },
    credit: { ...creditTerms, balance_payment: true },
    ...(state.recovery ? { request_recovery: true } : {}),
    ...(state.x402
      ? { x402: { pay_to: `0x${"77".repeat(20)}`, network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" } }
      : {}),
  };
}

function answer(status: number, body: unknown, headers: Record<string, string | string[]> = {}): Reply {
  return (response) => {
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    response.setHeader("Content-Type", "application/json");
    response.writeHead(status);
    response.end(JSON.stringify(body));
  };
}

function answerText(status: number, body: string): Reply {
  return (response) => {
    response.writeHead(status, { "Content-Type": "text/plain" });
    response.end(body);
  };
}

function breakOff(accepted: string): Reply {
  return (response) => {
    response.writeHead(202, { [FIELD]: accepted, "Content-Type": "application/json", "Content-Length": "200" });
    response.write(`{"job_id":"${accepted}",`);
    setTimeout(() => response.destroy(), 20);
  };
}

function routerConflict(accepted: string, requestId?: string): Reply {
  return answer(409, {
    error: {
      code: "hosting_job_identity_conflict",
      message: "The provider returned a different job for a request it had already accepted",
      display: `This request was already accepted as job ${accepted}. The service then answered with a different job, so that answer was refused.`,
      hint: requestId
        ? `Do not pay again. Run \`dvm request-result ${requestId}\` to recover job ${accepted}.`
        : `Do not pay again or resubmit this request. It was already accepted as job ${accepted}.`,
      accepted_job_id: accepted,
      ...(requestId ? { request_id: requestId } : {}),
    },
    trace_id: "trace-1",
  });
}

const anySchema = {
  _zod: {},
  parse: (data: unknown) => data,
  safeParse: (data: unknown) => ({ success: true as const, data }),
};

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sorted(entry)])
    );
  }
  return value;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

let spends = 0;

async function journalSpend(args: {
  amountSats: number;
  endpoint: string;
  submitContext: import("@dvmkit/sdk/internal").PendingSubmissionContext;
}) {
  spends += 1;
  const requestId = randomUUID();
  const cashuToken = `cashuB-${String(spends)}`;
  // As the real spend does, bind the token hash into a fund block's commitment
  // once the token exists, so the journal holds the data the submit signs.
  const data = args.submitContext.submit_body.data as Record<string, unknown> | undefined;
  const fund = data?.fund as Record<string, unknown> | undefined;
  const context = fund
    ? {
        ...args.submitContext,
        submit_body: {
          ...args.submitContext.submit_body,
          data: { ...data, fund: { ...fund, commitment: createHash("sha256").update(cashuToken).digest("hex") } },
        },
      }
    : args.submitContext;
  const wallet = sdk.loadAgentWallet() as import("@dvmkit/sdk/internal").AgentWallet;
  sdk.saveAgentWallet({
    ...wallet,
    pending_submissions: [
      ...wallet.pending_submissions,
      {
        endpoint: args.endpoint,
        request_id: requestId,
        intended_lock_pubkey: lockPubkey,
        mint,
        amount_sats: args.amountSats,
        output_proofs: [
          {
            mint,
            secret: randomUUID(),
            C: `02${"b".repeat(64)}`,
            amount: args.amountSats,
            id: "00ad268c4d1f5826",
            locked_to_pubkey: lockPubkey,
            status: "valid",
          },
        ],
        created_at: new Date().toISOString(),
        cashu_token: cashuToken,
        context,
      },
    ],
  });
  return { cashuToken, requestId, mint, totalSats: args.amountSats, intendedLockPubkey: lockPubkey };
}

function seedWallet(): void {
  spends = 0;
  sdk.saveAgentWallet({
    version: sdk.WALLET_VERSION,
    lock_privkey: "11".repeat(32),
    lock_pubkey: `02${"a".repeat(64)}`,
    mnemonic_fingerprint: null,
    mints: [mint],
    proofs: [],
    nut13_counters: {},
    pending_mints: [],
    pending_melts: [],
    pending_submissions: [],
    recent_spends: [],
    created_at: new Date().toISOString(),
  });
}

function seedCredit(remainingMicro: number): void {
  writeFileSync(
    join(root, "credits.json"),
    JSON.stringify({
      credits: [
        {
          endpoint: provider.endpoint,
          callerPubkey: sdk.receiptPubkeyFromSecret(secret),
          creditId: "prepaid-credit",
          currency: "usd",
          remainingMicro,
          balanceMicro: remainingMicro,
          targetMicro: 40_000,
          expiryMs: Date.now() + 86_400_000,
          status: "active",
          ledgerSeq: 1,
          updatedAt: Date.now(),
        },
      ],
      implicitCredits: [],
      pendingFundings: [],
      fundingMenuSnapshots: [],
    })
  );
}

function writeConfig(posture: "auto" | "off"): void {
  writeFileSync(join(root, "config.json"), JSON.stringify({ credit: { posture }, feedback: { posture: "off" } }));
}

const completeDraw = (_post: JobPost, accepted: string): Reply =>
  answer(200, { job_id: accepted, status: "completed", summary: "Done" }, { [FIELD]: accepted });

async function paidRequest(extra: { requestId?: string; rail?: string; budget?: string; maxPayments?: string; stream?: boolean } = {}): Promise<void> {
  await request({
    endpoint: provider.endpoint,
    input: "Echo",
    autoPay: true,
    budget: "100000",
    autoPayBelow: "100000",
    ...extra,
  });
}

function onlyJournalEntry() {
  const entries = sdk.loadAgentWallet()?.pending_submissions ?? [];
  expect(entries).toHaveLength(1);
  return entries[0];
}
