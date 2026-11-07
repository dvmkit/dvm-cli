import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { JOBS_FILE } from "@dvmkit/sdk/internal";
import type { PaymentContent } from "@dvmkit/sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ writes: [] as { fd: number; text: string }[], fetch: vi.fn() }));
vi.mock("../src/lib/http", () => ({ dvmFetch: captured.fetch }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, writeSync: vi.fn((fd: number, buffer: Uint8Array, offset = 0, length = buffer.length) => {
    if (fd !== 1 && fd !== 2) return actual.writeSync(fd, buffer, offset, length);
    captured.writes.push({ fd, text: Buffer.from(buffer).subarray(offset, offset + length).toString() });
    return length;
  }) };
});

import { cancel } from "../src/commands/cancel";
import { decline } from "../src/commands/decline";
import { message } from "../src/commands/message";
import { request } from "../src/commands/request";
import { pay } from "../src/commands/pay";
import { settleCreditAfterJob } from "../src/lib/credit-topup";
import { sendCreditPayment } from "../src/lib/credit-payment";
import {
  loadJob, markPaymentRequestInFlight, markPaymentRequestPaid, saveAcceptedJob,
  saveJob, saveSubmittedJob, updateJob, updateObservedJob, type CreditPaymentIntent,
} from "../src/lib/job-store";
import { withOutputWarnings, json } from "../src/lib/output";
import { hasUnsavedJobState } from "../src/lib/job-persistence";
import { streamLoop } from "../src/lib/stream-loop";
import { HttpsTransport } from "../src/lib/transport/https";

const endpoint = "https://provider.example";
const jobId = "contended-job";
const children: ChildProcessWithoutNullStreams[] = [];
const root = process.env.DVM_CONFIG_DIR!;
const policy = { maxTotalMsats: 10_000, autoPayBelowMsats: 5_000, maxIncrementMsats: 5_000, maxPayments: 5 };
const ask = { seq: 4, from: "provider", type: "payment-request", timestamp: 1,
  content: { amount_msats: 1000, reason: "More work", mints: ["https://mint.example"] } };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json" },
});
const stdout = () => captured.writes.filter(({ fd }) => fd === 1).map(({ text }) => text).join("");
const stderr = () => captured.writes.filter(({ fd }) => fd === 2).map(({ text }) => text).join("");
const output = () => JSON.parse(stdout());

async function holdJobsLock(): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    const release = require("proper-lockfile").lockSync(process.argv[1], { realpath: false });
    process.stdout.write("locked\\n");
    process.stdin.on("data", () => setTimeout(() => {
      const jobs = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      jobs[0].messageCursor = 17;
      fs.writeFileSync(process.argv[1], JSON.stringify(jobs));
      release();
      process.exit(0);
    }, 100));
  `, JOBS_FILE], { stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Lock holder exited before readiness (${code})`)));
  });
  return child;
}

beforeEach(() => {
  fs.mkdirSync(root, { recursive: true });
  fs.rmSync(JOBS_FILE, { force: true });
  fs.writeFileSync(join(root, "config.json"), JSON.stringify({ credit: { posture: "off" }, feedback: { posture: "off" } }));
  saveJob({ id: jobId, endpoint, status: "processing", submittedAt: 1, policy });
  captured.writes.length = 0;
  captured.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") return response({});
    if (init?.method === "POST") return response({ seq: 5 }, 201);
    if (String(_url).includes("/messages")) return response({ messages: [] });
    return response({ status: "cancelled", has_artifacts: false });
  });
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
  fs.rmSync(`${JOBS_FILE}.lock`, { recursive: true, force: true });
});

it("waits for another process during cancel persistence and preserves its update", async () => {
  const child = await holdJobsLock();
  captured.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      child.stdin.write("release\n");
      return response({});
    }
    return response({ status: "cancelled", has_artifacts: false });
  });
  await cancel(jobId, { reason: "Done" });
  expect(output()).toMatchObject({ status: "cancelled", next_action: null });
  expect(output()).not.toHaveProperty("warnings");
  expect(loadJob(jobId)).toMatchObject({ status: "cancelled", callerCancelled: true, messageCursor: 17, completion: { message: "Done" } });
  expect(captured.fetch.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
});

it.each([false, true])("reports cancel success with one local-state warning when the lock stays held (human=%s)", async (human) => {
  await holdJobsLock();
  const lock = vi.spyOn(lockfile, "lockSync");
  await cancel(jobId, { human });
  if (human) {
    expect(stderr()).toContain("cancelled.");
    expect(stderr()).toContain("local job state");
    expect(stderr().match(/Warning:/g)).toHaveLength(1);
    expect(stdout()).toBe("");
  } else {
    expect(output()).toMatchObject({ status: "cancelled", next_action: null,
      warnings: [{ code: "local_job_state_unsaved", display: expect.stringContaining("may lag") }] });
    expect(output()).not.toHaveProperty("error");
  }
  const attempts = lock.mock.calls.filter(([file]) => file === JOBS_FILE).length;
  expect(attempts).toBeGreaterThan(1);
  expect(attempts).toBeLessThanOrEqual(41);
  expect(loadJob(jobId)?.status).toBe("processing");
  expect(lockfile.checkSync(JOBS_FILE, { realpath: false })).toBe(true);
});

it.each(["decline", "message"])("keeps the accepted %s outcome when its local write is locked", async (command) => {
  await holdJobsLock();
  if (command === "decline") await decline(jobId, {});
  else await message(jobId, "Hello", {});
  expect(output()).toMatchObject({ warnings: [{ code: "local_job_state_unsaved" }] });
  expect(output()).toMatchObject(command === "decline" ? { declined: true, status: "cancelled" } : { sent: { type: "text" } });
  expect(captured.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("does not dispatch a payment when its pre-send pin cannot be saved", async () => {
  await holdJobsLock();
  captured.fetch.mockImplementation(async (url: string) => String(url).includes("/messages")
    ? response({ messages: [ask] }) : response({ status: "awaiting-input" }));
  await expect(pay(jobId, { mint: "https://mint.example" })).rejects.toMatchObject({ code: "ELOCKED" });
  expect(captured.fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  expect(loadJob(jobId)?.pinnedMint).toBeUndefined();
});

it("retains an accepted balance payment and its recovery intent when booking is locked", async () => {
  const intent: CreditPaymentIntent = { request: ask.content, amountMsats: 1000,
    authorization: { timestamp: Math.floor(Date.now() / 1000), payment_id: "payment-a", request_seq: 4 } as NonNullable<PaymentContent["credit"]> };
  updateJob(jobId, { pendingCreditPayment: intent });
  await holdJobsLock();
  await withOutputWarnings(async () => {
    await expect(sendCreditPayment(jobId, intent, new HttpsTransport(), { endpoint })).resolves.toBe(true);
    expect(loadJob(jobId)).toMatchObject({ totalPaidMsats: 1000, bookedCreditPayments: [intent] });
    expect(hasUnsavedJobState()).toBe(true);
    const streamed = await streamLoop({ jobId, transport: new HttpsTransport(), provider: { endpoint }, policy, afterSeq: 0 });
    expect(streamed.nextAction?.type).toBe("poll");
    json({ paid: true });
  });
  expect(output()).toMatchObject({ paid: true, warnings: [{ code: "local_job_state_unsaved" }] });
  expect(captured.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect(loadJob(jobId)).toMatchObject({ pendingCreditPayment: intent });
  expect(loadJob(jobId)?.bookedCreditPayments).toBeUndefined();
});

it("does not grant wallet booking ownership until held-payment consumption is durable", async () => {
  const held = { rail: "cashu_p2pk" as const, cashuRequestId: "held-a", amountMsats: 1000, requestAmountMsats: 1000, btcRate: 100000 };
  markPaymentRequestInFlight(jobId, 4, held);
  await holdJobsLock();
  await withOutputWarnings(async () => {
    expect(markPaymentRequestPaid(jobId, 4)).toBeUndefined();
    expect(loadJob(jobId)?.totalPaidMsats).toBe(1000);
    expect(() => markPaymentRequestInFlight(jobId, 6, held)).toThrow(expect.objectContaining({ code: "local_job_state_unsaved" }));
  });
  expect(loadJob(jobId)?.unconfirmedPaymentSubmissions?.[4]).toEqual(held);
});

it("keeps a newly accepted job and token in memory without leaking it to another command", async () => {
  await holdJobsLock();
  await withOutputWarnings(async () => {
    saveAcceptedJob({ id: "accepted", endpoint, submittedAt: 2, status: "processing", jobToken: "private-token" });
    expect(loadJob("accepted")?.jobToken).toBe("private-token");
    json({ jobId: "accepted", status: "processing" });
  });
  expect(loadJob("accepted")).toBeNull();
  expect(stdout()).not.toContain("private-token");
});

it("does not retry unrelated lock errors or swallow mutation conflicts", async () => {
  const denied = Object.assign(new Error("Denied"), { code: "EACCES" });
  const lock = vi.spyOn(lockfile, "lockSync").mockImplementation(() => { throw denied; });
  expect(() => updateJob(jobId, { status: "completed" })).toThrow(denied);
  expect(lock).toHaveBeenCalledTimes(1);
  lock.mockRestore();
  await holdJobsLock();
  await expect(withOutputWarnings(async () => {
    saveSubmittedJob({ id: jobId, endpoint: "https://another.example", status: "submitted", submittedAt: 1 });
  })).rejects.toThrow("conflicts with an existing local job");
});

it("reports an observation write failure while keeping the successful remote outcome", async () => {
  vi.spyOn(fs, "renameSync").mockImplementation(() => { throw Object.assign(new Error("Disk full"), { code: "ENOSPC" }); });
  await cancel(jobId, {});
  expect(output()).toMatchObject({ status: "cancelled", warnings: [{ code: "local_job_state_unsaved" }] });
  expect(loadJob(jobId)?.status).toBe("processing");
  expect(lockfile.checkSync(JOBS_FILE, { realpath: false })).toBe(false);
});

it("keeps command-local observations isolated from parallel output scopes", async () => {
  const denied = Object.assign(new Error("Denied"), { code: "EACCES" });
  const acquire = lockfile.lockSync.bind(lockfile);
  vi.spyOn(lockfile, "lockSync").mockImplementationOnce(() => { throw denied; });
  let finish!: () => void;
  const observed = withOutputWarnings(async () => {
    updateObservedJob(jobId, { status: "cancelled" });
    await new Promise<void>((resolve) => { finish = resolve; });
    expect(loadJob(jobId)?.status).toBe("cancelled");
  });
  try {
    await withOutputWarnings(async () => {
      expect(hasUnsavedJobState()).toBe(false);
      expect(loadJob(jobId)?.status).toBe("processing");
      const release = acquire(JOBS_FILE, { realpath: false });
      release();
    });
  } finally { finish(); }
  await observed;
});

it.each([false, true])("reports an accepted request promptly when local storage is locked (stream=%s)", async (stream) => {
  await holdJobsLock();
  captured.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/info")) return response({ name: "Test provider", capabilities: { echo: { description: "Echo" } } });
    if (String(url).endsWith("/quote")) return response({ price_msats: 0 });
    if (init?.method === "POST" && String(url).endsWith("/job"))
      return response({ job_id: "new-job", status: "processing", job_token: "ab".repeat(32) }, 202);
    throw new Error("Unexpected provider request");
  });
  await request({ endpoint, input: "Hello", stream });
  expect(output()).toMatchObject({ jobId: "new-job", next_action: { type: "poll" },
    warnings: [{ code: "local_job_state_unsaved" }] });
  expect(captured.fetch.mock.calls.filter(([url, init]) => String(url).endsWith("/job") && init?.method === "POST")).toHaveLength(1);
  expect(loadJob("new-job")).toBeNull();
});

it("does not turn a provider refusal into cancellation success", async () => {
  await holdJobsLock();
  captured.fetch.mockResolvedValue(response({ error: { code: "job_completed", message: "Already completed" } }, 409));
  await expect(cancel(jobId, {})).rejects.toMatchObject({ code: "provider_error" });
  expect(stdout()).toBe("");
  expect(loadJob(jobId)?.status).toBe("processing");
});

it("pauses automatic refills when accepted job state could not be saved", async () => {
  const refill = vi.fn(async () => undefined);
  vi.spyOn(lockfile, "lockSync").mockImplementationOnce(() => {
    throw Object.assign(new Error("Denied"), { code: "EACCES" });
  });
  await withOutputWarnings(async () => {
    updateObservedJob(jobId, { status: "completed" });
    await settleCreditAfterJob({ capture: undefined, transport: new HttpsTransport(), ref: { endpoint }, refillPocket: refill });
  });
  expect(refill).not.toHaveBeenCalled();
});
