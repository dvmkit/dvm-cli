import { execFile, fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

const execute = promisify(execFile);
const binary = resolve(import.meta.dirname, "../../dist/dvm.js");
const roots: string[] = [];
let child: ChildProcess;
let completion: Promise<number | null>;
let endpoint: string;
let pubkey: string;
let credit: Record<string, unknown>;
let root: string;
function control(message: Record<string, unknown>): Promise<Record<string, any>> {
  return new Promise((done) => { child.once("message", (reply) => done(reply as Record<string, any>)); child.send(message); });
}

beforeAll(async () => {
  child = fork(resolve(import.meta.dirname, "../support/standing-mandate-provider.mjs"), [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  completion = new Promise((done) => child.once("exit", done));
  const ready = await new Promise<Record<string, any>>((done, reject) => {
    child.once("message", (message) => done(message as Record<string, any>));
    child.once("exit", () => reject(new Error("Mandate provider exited before readiness")));
    child.stderr?.on("data", (chunk) => { process.stderr.write(chunk); });
  });
  ({ endpoint, pubkey, credit } = ready);
}, 15_000);
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "mandate-caller-")); roots.push(root);
  writeFileSync(join(root, "btc-rate.json"), JSON.stringify({ rate: 100_000, timestamp: Date.now() }));
  writeFileSync(join(root, "credits.json"), JSON.stringify({ version: 1, credits: [{ ...credit,
    endpoint, callerPubkey: pubkey, status: "active", targetMicro: 20_000_000, openedAt: Date.now(), updatedAt: Date.now() }] }));
  await control({ op: "support", value: true });
  await control({ op: "configure" });
});
afterAll(async () => {
  if (child?.connected) child.send({ op: "shutdown" });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { expect(await completion).toBe(0); } finally { clearTimeout(timeout); }
  for (const directory of roots) rmSync(directory, { recursive: true, force: true });
});

async function request(extra: string[] = []) {
  return execute(process.execPath, [binary, "request", "--endpoint", endpoint, "--input", "watch",
    "--budget", "$1.10", "--auto-pay-below", "$0.55", "--no-stream", ...extra], {
    env: { ...process.env, DVM_CONFIG_DIR: root, DVM_IDENTITY_KEY: "0d".repeat(32) }, timeout: 15_000,
  }).then((run) => ({ ...run, code: 0 }), (error) => error as { stdout: string; stderr: string; code: number });
}
function records(): Array<Record<string, any>> { return JSON.parse(readFileSync(join(root, "jobs.json"), "utf8")); }

it("signs native credit limits for 24 hours and the real SDK stores the same mandate", async () => {
  const started = Date.now();
  const run = await request();
  expect(run.code, run.stdout + run.stderr).toBe(0);
  const output = JSON.parse(run.stdout);
  const snapshot = await control({ op: "snapshot", ids: [output.jobId] });
  const submitted = snapshot.submissions.at(-1).data;
  expect(submitted.mandate).toMatchObject({ max_total_micro: 1_100_000, max_ask_micro: 550_000 });
  expect(submitted.mandate.expires_at_ms).toBeGreaterThanOrEqual(started + 86_400_000);
  expect(submitted.mandate.expires_at_ms).toBeLessThanOrEqual(Date.now() + 86_400_000);
  expect(snapshot.jobs[0].mandate).toEqual({ ...submitted.mandate, credit_id: submitted.credit_id, draw_id: submitted.draw_id });
  expect(records()[0].mandate).toMatchObject({ ...submitted.mandate, currency: "usd", signed_data: submitted });
  expect(output.mandate).toMatchObject({ currency: "usd", max_total_micro: 1_100_000, max_ask_micro: 550_000,
    max_total: { display: "$1.10 USD" }, max_ask: { display: "$0.55 USD" },
    display: expect.stringContaining("while the credit lasts") });
  expect(output.next_action).toBeNull();
  const requestId = records()[0].requestId;
  expect(requestId).toEqual(expect.any(String));
  writeFileSync(join(root, "jobs.json"), "[]");
  await execute(process.execPath, [binary, "request-result", requestId], {
    env: { ...process.env, DVM_CONFIG_DIR: root, DVM_IDENTITY_KEY: "0d".repeat(32) }, timeout: 15_000,
  });
  expect(records()[0].mandate).toMatchObject({ ...submitted.mandate, signed_data: submitted });
});

it("honors opt-out without sending or storing a mandate", async () => {
  const run = await request(["--no-mandate"]);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  const output = JSON.parse(run.stdout);
  const snapshot = await control({ op: "snapshot", ids: [output.jobId] });
  expect(snapshot.submissions.at(-1).data.mandate).toBeUndefined();
  expect(snapshot.jobs[0].mandate).toBeUndefined();
  expect(records()[0].mandate).toBeUndefined();
  expect(output.mandate).toBeUndefined();
});

it("sets a two-hour expiry and relays the same sentence in human mode", async () => {
  const started = Date.now();
  const run = await request(["--mandate-until", "2h", "--human"]);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  const m = records()[0].mandate;
  expect(m.expires_at_ms).toBeGreaterThanOrEqual(started + 7_200_000);
  expect(m.expires_at_ms).toBeLessThanOrEqual(Date.now() + 7_200_000);
  expect(run.stderr).toContain("while the credit lasts");
  expect(run.stderr).toContain("including the upfront payment");
  expect(run.stderr).toMatch(/until \d{1,2} [A-Z][a-z]+ \d{4} at \d{2}:\d{2} UTC/);
  expect(run.stderr).not.toContain(new Date(m.expires_at_ms).toISOString());
});

it("refuses expiry above seven days before any submit", async () => {
  const before = await control({ op: "snapshot", ids: [] });
  const run = await request(["--mandate-until", "7d1s"]);
  expect(run.code).toBe(1);
  expect(JSON.parse(run.stdout).error.message).toContain("at most 7 days");
  const after = await control({ op: "snapshot", ids: [] });
  expect(after.submissions.length).toBe(before.submissions.length);
});

it("withholds a mandate without advertised support and says a payer is needed", async () => {
  await control({ op: "support", value: false });
  const run = await request();
  expect(run.code, run.stdout + run.stderr).toBe(0);
  const output = JSON.parse(run.stdout);
  const snapshot = await control({ op: "snapshot", ids: [output.jobId] });
  expect(snapshot.submissions.at(-1).data.mandate).toBeUndefined();
  expect(snapshot.jobs[0].mandate).toBeUndefined();
  expect(output.mandate).toMatchObject({ status: "unsupported", display: expect.stringContaining("payer attached or scheduled check-ins") });
});

it("caps total at upfront plus the remaining payment-count times the smaller per-charge limit", async () => {
  const run = await request(["--max-payments", "2", "--max-increment", "$0.20"]);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  const output = JSON.parse(run.stdout);
  const snapshot = await control({ op: "snapshot", ids: [output.jobId] });
  expect(snapshot.jobs[0].mandate).toMatchObject({ max_total_micro: 300_000, max_ask_micro: 200_000 });
  expect(output.mandate).toMatchObject({ max_total_micro: 300_000, max_ask_micro: 200_000 });
});

it("keeps a valid submit working when its price quote is missing or times out", async () => {
  for (const quote of ["fail", "timeout"]) {
    await control({ op: "configure", quote });
    const run = await request(["--budget", "$5", "--auto-pay-below", "$0.50"]);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const output = JSON.parse(run.stdout);
    expect(output.mandate).toMatchObject({ status: "skipped", display: expect.stringContaining("price was unknown") });
    const snapshot = await control({ op: "snapshot", ids: [output.jobId] });
    expect(snapshot.jobs[0].mandate).toBeUndefined();
  }
});

it("shows no future authority when the upfront exhausts max-payments", async () => {
  const run = await request(["--max-payments", "1"]);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  const output = JSON.parse(run.stdout);
  expect(output.mandate.display).toContain("no later charges");
  const snapshot = await control({ op: "snapshot", ids: [output.jobId] });
  expect(snapshot.jobs[0].mandate).toBeUndefined();
});

it("suppresses the attached-payer requirement only on an active nonterminal mandate", async () => {
  await control({ op: "configure", hold: true });
  const run = await request();
  expect(run.code, run.stdout + run.stderr).toBe(0);
  const output = JSON.parse(run.stdout);
  expect(output.next_action).toMatchObject({ type: "poll" });
  expect(output.next_action.hint).not.toContain("Later payment asks are paid only while");
  expect(output.next_action.hint).toContain("credit runs out");
  const without = await request(["--no-mandate"]);
  expect(without.code, without.stdout + without.stderr).toBe(0);
  expect(JSON.parse(without.stdout).next_action.hint).toContain("Later payment asks are paid only while");
});

it("explains a provider's invalid mandate refusal without sending another job", async () => {
  await control({ op: "configure", reject: true });
  const before = await control({ op: "snapshot", ids: [] });
  const run = await request(["--mandate-until", "7d"]);
  expect(run.code).toBe(1);
  expect(run.stdout).toContain("shorter --mandate-until");
  expect(run.stdout).toContain("clock");
  const after = await control({ op: "snapshot", ids: [] });
  expect(after.submissions.length).toBe(before.submissions.length + 1);
  expect(after.submissions.at(-1).data.mandate.expires_at_ms).toBeLessThan(Date.now() + 7 * 86_400_000 - 290_000);
});
