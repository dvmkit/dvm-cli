import * as fs from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { JOBS_FILE, WALLET_VERSION, saveAgentWallet } from "@dvmkit/sdk/internal";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ writes: [] as { fd: number; text: string }[] }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, writeSync: vi.fn((fd: number, buffer: Uint8Array, offset = 0, length = buffer.length) => {
    if (fd !== 1 && fd !== 2) return actual.writeSync(fd, buffer, offset, length);
    captured.writes.push({ fd, text: Buffer.from(buffer).subarray(offset, offset + length).toString() });
    return length;
  }) };
});

import { resolveJobAccess } from "../src/lib/job-access";
import { hasUnsavedJobState } from "../src/lib/job-persistence";
import { loadJob, recordUpfrontRailPayment, saveAcceptedJob, saveJob, saveSubmittedJob, updateJob, updateObservedJob, type JobRecord } from "../src/lib/job-store";
import { json, withOutputWarnings } from "../src/lib/output";
import { walletSubmissions } from "../src/commands/wallet-submissions";
import { listAcceptedJobAccess, listSubmissionEvidence, recordAcceptedJobAccess, SUBMISSION_EVIDENCE_DIR } from "../src/lib/submission-evidence";

const token = "ab".repeat(32);
const job: JobRecord = { id: "accepted", endpoint: "https://provider.example", status: "submitted", submittedAt: 2,
  requestId: "request-a", jobToken: token, policy: { maxTotalMsats: 2000, autoPayBelowMsats: 1000, maxIncrementMsats: 1000, maxPayments: 2 } };
const text = () => captured.writes.map(({ text }) => text).join("");
const output = () => JSON.parse(captured.writes.filter(({ fd }) => fd === 1).map(({ text }) => text).join(""));
const denyLock = () => vi.spyOn(lockfile, "lockSync").mockImplementation(() => {
  throw Object.assign(new Error("Denied"), { code: "EACCES" });
});

beforeEach(() => {
  fs.rmSync(SUBMISSION_EVIDENCE_DIR, { recursive: true, force: true });
  fs.rmSync(JOBS_FILE, { force: true });
  captured.writes.length = 0;
  vi.stubEnv("DVM_JOB_ENDPOINT", undefined);
  vi.stubEnv("DVM_JOB_TOKEN", undefined);
});

afterEach(() => vi.unstubAllEnvs());

it.each([saveAcceptedJob, saveSubmittedJob])("recovers accepted access after a failed save, including later observed bookkeeping (%s)", async (save) => {
  expect(() => resolveJobAccess(job.id, {})).toThrow(expect.objectContaining({ code: "job_access_required" }));
  const lock = denyLock();
  await withOutputWarnings(async () => {
    save(job);
    recordUpfrontRailPayment(job.id, { method: "cashu", amountMsats: 1000 }, true);
    expect(hasUnsavedJobState()).toBe(true);
    expect(() => updateJob(job.id, { status: "processing" })).toThrow(expect.objectContaining({ code: "local_job_state_unsaved" }));
    json({ jobId: job.id });
  });
  lock.mockRestore();
  expect(fs.existsSync(JOBS_FILE)).toBe(false);
  expect(resolveJobAccess(job.id, {})).toMatchObject({ ref: { endpoint: job.endpoint }, jobToken: token,
    stored: { policy: job.policy, totalPaidMsats: 1000, paymentsHonoured: 1 } });
  expect(output().warnings).toEqual([expect.objectContaining({ code: "local_job_state_unsaved", hint: expect.stringContaining("dvm status") })]);
  expect(text()).not.toContain(token);
  expect(listSubmissionEvidence().records).toEqual([]);
  for (const name of fs.readdirSync(SUBMISSION_EVIDENCE_DIR)) {
    expect(fs.statSync(join(SUBMISSION_EVIDENCE_DIR, name)).mode & 0o777).toBe(0o600);
  }
  updateObservedJob(job.id, { status: "processing" });
  const saved = JSON.parse(fs.readFileSync(JOBS_FILE, "utf8"));
  expect(saved).toEqual([expect.objectContaining({ id: job.id, jobToken: token, status: "processing", totalPaidMsats: 1000, paymentsHonoured: 1 })]);
  expect(listAcceptedJobAccess()).toEqual([]);
  const before = fs.readFileSync(JOBS_FILE, "utf8");
  updateObservedJob(job.id, { status: "processing" });
  expect(fs.readFileSync(JOBS_FILE, "utf8")).toBe(before);
});

it("keeps the recovery record when folding cannot write the jobs file", async () => {
  recordAcceptedJobAccess(job, "request-scope", 0);
  const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("Disk full"); });
  await withOutputWarnings(async () => updateObservedJob(job.id, { status: "processing" }));
  expect(listAcceptedJobAccess()).toHaveLength(1);
  rename.mockRestore();
  updateObservedJob(job.id, { status: "processing" });
  expect(loadJob(job.id)?.jobToken).toBe(token);
  expect(listAcceptedJobAccess()).toEqual([]);
});

it("never shadows a jobs-file record, even when another endpoint holds the same ID", () => {
  saveJob({ ...job, endpoint: "https://original.example", jobToken: "cd".repeat(32) });
  recordAcceptedJobAccess(job, "request-scope", 0);
  expect(resolveJobAccess(job.id, {}).jobToken).toBe("cd".repeat(32));
  expect(() => resolveJobAccess(job.id, { endpoint: job.endpoint })).toThrow(expect.objectContaining({ code: "job_token_required" }));
  updateObservedJob(job.id, { status: "processing" });
  expect(listAcceptedJobAccess()).toHaveLength(1);
  expect(JSON.parse(fs.readFileSync(JOBS_FILE, "utf8"))).toEqual([expect.objectContaining({ endpoint: "https://original.example" })]);
});

it("selects access by endpoint, rejects ambiguous IDs, and retains explicit override precedence", () => {
  recordAcceptedJobAccess(job, "first-request", 0);
  expect(() => resolveJobAccess(job.id, { endpoint: "https://foreign.example" })).toThrow(expect.objectContaining({ code: "job_token_required" }));
  recordAcceptedJobAccess({ ...job, endpoint: "https://second.example", jobToken: "cd".repeat(32) }, "second-request", 0);
  expect(() => resolveJobAccess(job.id, {})).toThrow(expect.objectContaining({ code: "job_access_required" }));
  expect(resolveJobAccess(job.id, { endpoint: job.endpoint + "/" }).jobToken).toBe(token);
  process.env.DVM_JOB_ENDPOINT = "https://second.example";
  process.env.DVM_JOB_TOKEN = "ef".repeat(32);
  expect(resolveJobAccess(job.id, {}).jobToken).toBe("ef".repeat(32));
  expect(resolveJobAccess(job.id, { endpoint: job.endpoint, jobToken: "01".repeat(32) })).toMatchObject({
    ref: { endpoint: job.endpoint }, jobToken: "01".repeat(32),
  });
  delete process.env.DVM_JOB_ENDPOINT;
  delete process.env.DVM_JOB_TOKEN;
  saveJob({ id: "other", endpoint: job.endpoint, submittedAt: 3, status: "processing" });
  expect(listAcceptedJobAccess()).toHaveLength(2);
  expect(JSON.parse(fs.readFileSync(JOBS_FILE, "utf8"))).toHaveLength(1);
});

it.each([false, true])("reports unpreserved access and portable flags without exposing the token (human=%s)", async (human) => {
  fs.mkdirSync(join(SUBMISSION_EVIDENCE_DIR, ".."), { recursive: true });
  fs.writeFileSync(SUBMISSION_EVIDENCE_DIR, "blocks directory creation");
  denyLock();
  await withOutputWarnings(async () => {
    saveAcceptedJob(job);
    expect(loadJob(job.id)?.jobToken).toBe(token);
    expect(hasUnsavedJobState()).toBe(true);
    if (!human) json({ jobId: job.id });
  }, human);
  expect(text()).toContain("access was not preserved");
  for (const route of ["--endpoint", "--job-token", "DVM_JOB_ENDPOINT", "DVM_JOB_TOKEN"]) expect(text()).toContain(route);
  expect(text()).not.toContain(token);
  if (!human) expect(output().warnings).toEqual([expect.objectContaining({ code: "local_job_state_unsaved" })]);
});

it.each([false, true])("does not export accepted-access tokens through wallet evidence output (human=%s)", async (human) => {
  recordAcceptedJobAccess(job, "request-scope", 0);
  saveAgentWallet({ version: WALLET_VERSION, lock_privkey: "01".repeat(32), lock_pubkey: `02${"02".repeat(32)}`,
    mnemonic_fingerprint: null, mints: [], proofs: [], nut13_counters: {}, pending_mints: [], pending_melts: [], pending_submissions: [],
    recent_spends: [], created_at: new Date().toISOString() });
  await walletSubmissions({ human });
  expect(text()).not.toContain(token);
  expect(text()).not.toContain("job_token");
  expect(text()).not.toContain("request-scope");
});

it("does not quote bearer secrets from damaged recovery files in evidence diagnostics", async () => {
  recordAcceptedJobAccess(job, "request-scope", 0);
  const file = fs.readdirSync(SUBMISSION_EVIDENCE_DIR)[0];
  fs.writeFileSync(join(SUBMISSION_EVIDENCE_DIR, file), `{"jobToken":${token}}`);
  await walletSubmissions({});
  expect(output().submission_evidence_unreadable).toHaveLength(1);
  expect(text()).not.toContain(token);
});

it("keeps newer jobs-file payment state when cleaning up an older access snapshot", () => {
  saveJob({ ...job, totalPaidMsats: 1500, paymentsHonoured: 2 });
  recordAcceptedJobAccess({ ...job, totalPaidMsats: 1000, paymentsHonoured: 1 }, "request-scope", 0);
  updateObservedJob(job.id, { status: "processing" });
  expect(loadJob(job.id)).toMatchObject({ status: "processing", totalPaidMsats: 1500, paymentsHonoured: 2 });
  expect(listAcceptedJobAccess()).toEqual([]);
});

it("prints the preserved-access status route in human mode without the bearer token", async () => {
  denyLock();
  await withOutputWarnings(async () => saveAcceptedJob(job), true);
  expect(text()).toContain("access is preserved privately");
  expect(text()).toContain("dvm status");
  expect(text()).not.toContain(token);
});
