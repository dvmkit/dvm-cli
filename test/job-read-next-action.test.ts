import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WALLET_FILE, WALLET_VERSION, type Message } from "@dvmkit/sdk/internal";
import { messages } from "../src/commands/messages";
import { status } from "../src/commands/status";
import { loadJob, saveJob, updateJob, type JobRecord } from "../src/lib/job-store";
import { appendMessages } from "../src/lib/messages";
import { heldPaymentResendable } from "../src/lib/next-action";

const wire = vi.hoisted(() => ({
  status: vi.fn(), getMessages: vi.fn(), stream: vi.fn(), sendMessage: vi.fn(), close: vi.fn(), json: vi.fn(),
}));
vi.mock("../src/lib/transport", () => ({ createDvmTransport: () => wire }));
vi.mock("../src/lib/output", async (original) => ({
  ...await original<typeof import("../src/lib/output")>(), json: wire.json, info: vi.fn(),
}));

const root = process.env.DVM_CONFIG_DIR!;
const endpoint = "https://provider.example";
const jobId = "job-read";
const ask = { seq: 5, from: "provider", timestamp: 1, type: "payment-request",
  content: { amount_msats: 5000, reason: "Continue work" } } satisfies Message;
const held: NonNullable<JobRecord["unconfirmedPaymentSubmissions"]> = {
  5: { rail: "cashu_p2pk", cashuRequestId: "held-token", requestAmountMsats: 5000, amountMsats: 5000, btcRate: 100000 },
};
const output = () => wire.json.mock.calls.at(-1)![0];
const reads = [
  { name: "status", run: () => status(jobId, {}) },
  { name: "status --messages", run: () => status(jobId, { messages: true }) },
  { name: "messages --no-stream", run: () => messages(jobId, { stream: false }) },
] as const;

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "config.json"), JSON.stringify({ credit: { posture: "off" }, feedback: { posture: "off" } }));
  saveJob({ id: jobId, endpoint, status: "awaiting-input", submittedAt: 1, messageCursor: 4 });
  wire.status.mockResolvedValue({ jobId, status: "awaiting-input" });
  wire.getMessages.mockImplementation(async (_jobId: string, after: number) => [ask].filter((message) => message.seq > after));
  wire.stream.mockResolvedValue({ messages: [ask], reason: "yield" });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network access")));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function answerLocally(kind: "paid" | "credit" | "declined"): void {
  if (kind === "paid") updateJob(jobId, { paidPaymentRequestSeqs: [5] });
  if (kind === "credit") updateJob(jobId, { bookedCreditPayments: [{
    request: ask.content,
    authorization: { credit_id: "credit", draw_id: "draw", payment_id: "payment", request_seq: 5,
      amount_micro: 5000, currency: "usd", pubkey: "01".repeat(32), signature: "02".repeat(64), timestamp: 1, nonce: "nonce",
      auth_statement: { v: 2, protocol: "dvmkit", protocol_version: 1, auth: "secp256k1-schnorr-v2",
        audience: { dvm_id: "provider.example", builder_pubkey: "03".repeat(32) },
        method: "POST", path: `/v1/job/${jobId}/messages`, capability: null } },
  }] });
  if (kind === "declined") {
    appendMessages(jobId, [ask, { seq: 6, from: "requester", timestamp: 2, type: "decline", content: { reason: "Stop" } }]);
    updateJob(jobId, { callerDeclined: true, callerCancelled: true });
  }
}

describe.each(reads)("$name local answered asks", ({ run }) => {
  it("still offers an unanswered ask", async () => {
    await run();
    expect(output()).toMatchObject({ next_action: { type: "pay", amount_msats: 5000 } });
  });

  it.each(["paid", "credit", "declined"] as const)("does not offer an ask answered by %s while provider history lags", async (kind) => {
    answerLocally(kind);
    await run();
    expect(output()).toMatchObject({ next_action: { type: "poll" } });
    expect(wire.sendMessage).not.toHaveBeenCalled();
  });
});

it("does not consume the message cursor when status reads full history for an answered ask", async () => {
  answerLocally("paid");
  await status(jobId, {});
  expect(output()).toMatchObject({ next_action: { type: "poll" } });
  expect(wire.getMessages).toHaveBeenCalledWith(jobId, 0, { endpoint }, expect.anything());
  expect(loadJob(jobId)?.messageCursor).toBe(4);
});

it("filters answered asks in a full-history fallback after an empty status message batch", async () => {
  answerLocally("credit");
  updateJob(jobId, { messageCursor: 5 });
  await status(jobId, { messages: true });
  expect(output()).toMatchObject({ messages: [], cursor: 5, next_action: { type: "poll" } });
  expect(wire.getMessages.mock.calls.map((call) => call[1])).toEqual([5, 0]);
});

it.each(["status", "messages"] as const)("%s endpoint overrides ignore local answers and held payments", async (command) => {
  answerLocally("paid");
  updateJob(jobId, { unconfirmedPaymentSubmissions: held });
  writeFileSync(WALLET_FILE, "invalid JSON");
  if (command === "status") await status(jobId, { endpoint });
  else await messages(jobId, { endpoint, stream: false });
  expect(output()).toMatchObject({ next_action: { type: "pay", hint: expect.stringContaining("get approval") } });
  expect(loadJob(jobId)?.messageCursor).toBe(4);
});

it("an endpoint from the environment also ignores local answered asks", async () => {
  answerLocally("paid");
  vi.stubEnv("DVM_JOB_ENDPOINT", endpoint);
  await status(jobId, {});
  expect(output()).toMatchObject({ next_action: { type: "pay" } });
});

describe.each([
  ...reads,
  { name: "messages", run: () => messages(jobId, {}) },
])("$name with a held Cashu payment", ({ run }) => {
  it("reports an unreadable wallet without losing progress or the held payment", async () => {
    updateJob(jobId, { unconfirmedPaymentSubmissions: held });
    writeFileSync(WALLET_FILE, "invalid JSON");
    await run();
    expect(output()).toMatchObject({ next_action: { hint: expect.stringContaining("wallet is unreadable") } });
    const hint = output().next_action.hint;
    expect(hint).toContain("dvm wallet recover");
    expect(hint).toContain("No new payment will be signed");
    expect(hint).not.toMatch(/Resolve it with `dvm pay|delete|no longer holds/);
    expect(loadJob(jobId)?.unconfirmedPaymentSubmissions).toEqual(held);
    expect(readFileSync(WALLET_FILE, "utf8")).toBe("invalid JSON");
    expect(wire.sendMessage).not.toHaveBeenCalled();
  });
});

it("treats a corrupt wallet as not resendable", () => {
  writeFileSync(WALLET_FILE, "invalid JSON");
  expect(heldPaymentResendable({ ...loadJob(jobId)!, unconfirmedPaymentSubmissions: held }, 5)).toBe(false);
});

it.each([true, false])("keeps resend guidance dependent on the actual wallet entry (present=%s)", async (present) => {
  updateJob(jobId, { unconfirmedPaymentSubmissions: held });
  writeFileSync(WALLET_FILE, JSON.stringify({ version: WALLET_VERSION,
    lock_privkey: "01".repeat(32), lock_pubkey: `02${"01".repeat(32)}`, mnemonic_fingerprint: null,
    mints: [], proofs: [], nut13_counters: {}, pending_mints: [], pending_melts: [], recent_spends: [],
    pending_submissions: present ? [{ request_id: "held-token", endpoint, mint: "https://mint.example", amount_sats: 5,
      output_proofs: [], cashu_token: "cashuBheld", created_at: new Date().toISOString() }] : [], created_at: new Date().toISOString() }));
  await status(jobId, {});
  expect(output()).toMatchObject({ next_action: { type: "pay",
    hint: expect.stringContaining(present ? "re-sends that same payment" : "no longer holds") } });
});
