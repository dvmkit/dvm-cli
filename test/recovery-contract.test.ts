import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cashuSubmissionBindingFingerprint, cashuSubmissionBindingFromContext,
  JOB_IDENTITY_HEADER, loadAgentWallet, receiptPubkeyFromSecret, saveAgentWallet, WALLET_VERSION,
  type AgentWallet, type PendingSubmission, type PendingSubmissionContext,
} from "@dvmkit/sdk/internal";
import { buildProgram } from "../src/cli/dvm";
import { requestResult } from "../src/commands/request-result";
import { requestResume } from "../src/commands/request-resume";
import { buildResubmitAction } from "../src/commands/request-resubmit";
import { outputOverBudget } from "../src/commands/request-output";
import { walletRecoverSubmission } from "../src/commands/wallet-recover-submission";
import { walletSubmissions } from "../src/commands/wallet-submissions";
import { json } from "../src/lib/output";
import { saveRequestIntent } from "../src/lib/request-intent-store";
import { adoptWedgedChannelDrain } from "../src/lib/credit-reclaim";
import { buildCreditFundingIncomplete, noteCreditFundingIncomplete, resetCreditNotices, takeCreditNoticeFields } from "../src/lib/credit-notice";

vi.mock("../src/lib/output", async (original) => ({
  ...await original<typeof import("../src/lib/output")>(), json: vi.fn(), info: vi.fn(),
}));
vi.mock("../src/lib/cli-identity-resolve", async (original) => ({
  ...await original<typeof import("../src/lib/cli-identity-resolve")>(),
  findSigningIdentityByPubkey: () => ({ privkey: "01".repeat(32), pubkey: receiptPubkeyFromSecret("01".repeat(32)) }),
}));

const endpoint = "https://provider.example";
const requestId = "order:42";
const journalId = "11111111-1111-4111-8111-111111111111";
const caller = receiptPubkeyFromSecret("01".repeat(32));
const policy = { maxTotalMsats: 5000, autoPayBelowMsats: 5000, maxIncrementMsats: 5000, maxPayments: 1 };
const root = process.env.DVM_CONFIG_DIR!;

beforeEach(() => {
  for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true, force: true });
  resetCreditNotices();
});
afterEach(() => vi.unstubAllGlobals());

function intent(): void {
  saveRequestIntent({ v: 2, requestId, endpoint, capability: "echo", callerPubkey: caller, policy,
    body: { input: "Work", data: { request_id: requestId } }, createdAt: 1,
    authAudience: { dvm_id: "provider", builder_pubkey: "02".repeat(32) } });
}

function wallet(entries: PendingSubmission[]): AgentWallet {
  return { version: WALLET_VERSION, lock_privkey: "01".repeat(32), lock_pubkey: `02${caller}`,
    mnemonic_fingerprint: null, mints: ["https://mint.example"], proofs: [], nut13_counters: {},
    pending_mints: [], pending_melts: [], pending_submissions: entries, recent_spends: [],
    created_at: new Date().toISOString() };
}

function submission(): PendingSubmission {
  return { request_id: journalId, endpoint, intended_lock_pubkey: `02${caller}`, mint: "https://mint.example",
    amount_sats: 5, created_at: new Date().toISOString(), cashu_token: "saved-payment-token",
    output_proofs: [{ id: "00ad268c4d1f5826", amount: 5, secret: "saved-output", C: `02${"ab".repeat(32)}`,
      mint: "https://mint.example", locked_to_pubkey: `02${caller}`, status: "valid" }],
    context: { submit_body: { input: "Work", data: { request_id: requestId } }, capability: "echo" } };
}

describe("recovery JSON compatibility", () => {
  it.each(["processing", "completed", "failed", "cancelled"])("recovers the original request and job IDs for %s", async (status) => {
    intent();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ request_id: requestId, job_id: "job-original", status }),
      { status: status === "processing" ? 202 : 200 }));
    vi.stubGlobal("fetch", fetch);
    await requestResult(requestId);
    expect(json).toHaveBeenLastCalledWith(expect.objectContaining({ request_id: "order:42", jobId: "job-original", status,
      next_action: status === "processing" ? expect.objectContaining({ type: "poll", job_id: "job-original", hint: expect.any(String) }) : null }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toMatchObject([`${endpoint}/v1/request-result/order%3A42`, { method: "POST" }]);
  });

  it("resumes only after not found, with the original signed intent and no replacement payment", async () => {
    intent();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      if (calls.length === 1) return new Response(JSON.stringify({ error: { code: "request_not_found", message: "Not found" } }), { status: 404 });
      return new Response(JSON.stringify({ request_id: requestId, job_id: "job-original", status: "processing" }), { status: 202 });
    });
    vi.stubGlobal("fetch", fetch);
    await requestResume(requestId);
    expect(calls.map((call) => call.url)).toEqual([
      `${endpoint}/v1/request-result/order%3A42`, `${endpoint}/v1/request-resume/order%3A42`, `${endpoint}/v1/request-result/order%3A42`,
    ]);
    for (const call of calls) {
      expect(call.body).toMatchObject({ input: "Work", data: { request_id: "order:42", pubkey: caller } });
      expect(JSON.stringify(call.body)).not.toMatch(/cashu_token|x402_payment|mpp|"fund"|"draw_id"|"credit_id"/);
    }
    expect(json).toHaveBeenLastCalledWith(expect.objectContaining({ request_id: "order:42", jobId: "job-original",
      next_action: expect.objectContaining({ type: "poll", job_id: "job-original" }) }));
  });

  it.each([requestResult, requestResume])("keeps a missing intent unknown without network I/O (%#)", async (recover) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(recover(requestId)).rejects.toMatchObject({ code: "request_not_found", data: { request_id: "order:42", status: "unknown" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves recoverable journal IDs and refuses unforced forgetting (failed=%s)", async (failed) => {
    const entry = submission();
    entry.created_at = "2020-01-01T00:00:00.000Z";
    entry.canonical_id = "42";
    entry.t_expire = Date.parse("2020-01-02T00:00:00.000Z");
    if (failed) entry.reclaim_error = "mint unavailable";
    saveAgentWallet(wallet([entry]));
    await walletSubmissions({});
    expect(json).toHaveBeenLastCalledWith(expect.objectContaining({ stranded_count: 0,
      reclaimable_count: failed ? 0 : 1, reclaim_failed_count: failed ? 1 : 0,
      pending_submissions: [expect.objectContaining({ request_id: journalId, public_request_id: "order:42",
        state: failed ? "reclaim_failed" : "reclaimable", reclaim_at: "2020-01-02T00:00:00.000Z",
        reclaim_error: failed ? "mint unavailable" : null })] }));
    await expect(walletSubmissions({ forget: journalId, yes: true })).rejects.toMatchObject({ code: "reclaim_pending" });
    expect(loadAgentWallet()?.pending_submissions).toEqual([entry]);
  });

  it.each(["recovered", "unknown"])("emits the exact strict recovery action when %s", async (outcome) => {
    const entry = submission();
    const context: PendingSubmissionContext = { submit_body: { input: "Work", capability: "echo", data: { request_id: requestId } },
      dvm_id: "provider", capability: "echo", pinned_mint: entry.mint, strict_per_call: true,
      policy, max_cashu_fee_sats: 2, initial_cashu_fee_sats: 0 };
    const binding = cashuSubmissionBindingFromContext(context)!;
    const fingerprint = cashuSubmissionBindingFingerprint(binding);
    entry.context = { ...context, binding_fingerprint: fingerprint };
    const other = { ...submission(), request_id: "22222222-2222-4222-8222-222222222222" };
    saveAgentWallet(wallet([entry, other]));
    const fetch = vi.fn(async () => {
      expect(loadAgentWallet()?.pending_submissions[0].attempts).toBe(1);
      if (outcome === "unknown") throw new Error("Reply lost");
      return new Response(JSON.stringify({ job_id: "job-original" }), { status: 202, headers: { [JOB_IDENTITY_HEADER]: "job-original" } });
    });
    vi.stubGlobal("fetch", fetch);
    await walletRecoverSubmission(journalId, { bindingFingerprint: fingerprint });
    expect(json).toHaveBeenLastCalledWith(expect.objectContaining({ request_id: journalId, recovery_attempts: 1,
      job_id: outcome === "recovered" ? "job-original" : null,
      next_action: outcome === "recovered" ? expect.objectContaining({ type: "verify_receipt", job_id: "job-original" })
        : expect.objectContaining({ type: "lookup_receipt", request_id: journalId }) }));
    expect(loadAgentWallet()?.pending_submissions.find((saved) => saved.request_id === other.request_id)).toEqual(other);
    if (outcome === "unknown") {
      await expect(walletRecoverSubmission(journalId, { bindingFingerprint: fingerprint })).rejects.toMatchObject({ code: "submission_recovery_exhausted" });
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("emits an approval-gated resubmit command retaining the request and spending limits", () => {
    const action = buildResubmitAction({ endpoint, input: "Work", requestId, budget: "1000", maxIncrement: "500", rail: "cashu" },
      { minBudgetMsats: 5000, forceAutoPay: true }, "Ask the user before increasing the budget.");
    outputOverBudget(null, [], { requestId }, undefined, action);
    expect(json).toHaveBeenLastCalledWith(expect.objectContaining({ request_id: "order:42", next_action: expect.objectContaining({
      type: "resubmit", requires_user_approval: true, hint: expect.any(String),
      command: "dvm request --endpoint https://provider.example -i Work --budget 5000 --max-increment 500 --auto-pay --rail cashu --request-id order:42",
    }) }));
  });

  it("carries credit and funding recovery IDs plus the adopted original drain command through the notice sink", () => {
    const adopted = adoptWedgedChannelDrain({ endpoint, callerPubkey: caller, creditId: "credit-original",
      data: { settlement_drain_id: "drain-original" } })!;
    const report = buildCreditFundingIncomplete({ code: "credit_funding_refused", dvm: "provider", endpoint,
      reason: "no_credit_open", amountMicro: 1000, currency: "usd", adoptedDrain: adopted,
      outcome: { status: "refused", creditId: "credit-original", fundId: "fund-original", display: "Settlement pending" } });
    noteCreditFundingIncomplete(report);
    expect(takeCreditNoticeFields()).toMatchObject({ credit_funding_incomplete: [expect.objectContaining({
      credit_id: "credit-original", fund_id: "fund-original", drain_id: "drain-original",
      drain_command: "dvm credit drain https://provider.example",
    })] });
  });
});

it("keeps recovery command arguments and the exact-binding option registered", () => {
  const program = buildProgram();
  for (const name of ["request-result", "request-resume"]) {
    const command = program.commands.find((command) => command.name() === name)!;
    expect(command?.registeredArguments.map((argument) => [argument.name(), argument.required])).toEqual([["request-id", true]]);
  }
  const wallet = program.commands.find((command) => command.name() === "wallet")!;
  const recover = wallet.commands.find((command) => command.name() === "recover-submission")!;
  expect(recover?.registeredArguments.map((argument) => [argument.name(), argument.required])).toEqual([["request-id", true]]);
  expect(recover?.options).toContainEqual(expect.objectContaining({ long: "--binding-fingerprint", mandatory: true, required: true }));
  expect(program.commands.some((command) => command.name() === "request")).toBe(true);
});
