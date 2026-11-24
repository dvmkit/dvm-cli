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
  if (process.env.CI && !process.env.DVM_CLI_MANDATE_DATABASE_URL)
    throw new Error("CI requires DVM_CLI_MANDATE_DATABASE_URL for the provider-settled mandate contract.");
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
  if (!child) return;
  if (child.connected) child.send({ op: "shutdown" });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { expect(await completion).toBe(0); } finally { clearTimeout(timeout); }
  for (const directory of roots) rmSync(directory, { recursive: true, force: true });
});

async function request(extra: string[] = [], stream = false) {
  return execute(process.execPath, [binary, "request", "--endpoint", endpoint, "--input", "watch",
    "--budget", "$1.10", "--auto-pay-below", "$0.55", ...(stream ? [] : ["--no-stream"]), ...extra], {
    env: { ...process.env, DVM_CONFIG_DIR: root, DVM_IDENTITY_KEY: "0d".repeat(32) }, timeout: 15_000,
  }).then((run) => ({ ...run, code: 0 }), (error) => error as { stdout: string; stderr: string; code: number });
}
function records(): Array<Record<string, any>> { return JSON.parse(readFileSync(join(root, "jobs.json"), "utf8")); }

it("signs native credit limits for 24 hours and the real SDK stores the same mandate", async () => {
  const started = Date.now();
  const run = await request(["--max-payments", "5"]);
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

it("auto-pays a later ask after the upfront draw when budget equals the threshold", async () => {
  await control({ op: "configure", pieces: 1 });
  const before = await control({ op: "snapshot", ids: [] });
  const run = await request(["--budget", "$0.30", "--auto-pay-below", "$0.30", "--auto-pay", "--no-mandate"], true);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  const { jobId, status: result } = JSON.parse(run.stdout.trim().split("\n").at(-1)!);
  expect(result).toBe("completed");
  const after = await control({ op: "snapshot", ids: [jobId] });
  expect(after.paymentPosts.slice(before.paymentPosts.length)).toMatchObject([
    { content: { credit: { amount_micro: 200_000 } } },
  ]);
  expect(after.jobs[0].status).toBe("completed");
  expect(records()[0]).toMatchObject({ paymentsHonoured: 2, totalPaidMsats: 300_000, policy: { maxPayments: 5 } });
  const status = await execute(process.execPath, [binary, "status", jobId], {
    env: { ...process.env, DVM_CONFIG_DIR: root, DVM_IDENTITY_KEY: "0d".repeat(32) }, timeout: 15_000,
  });
  expect(JSON.parse(status.stdout).spend).toMatchObject({ payments: 2, max_payments: 5 });
}, 20_000);

it("sets a two-hour expiry and relays the same sentence in human mode", async () => {
  const started = Date.now();
  const run = await request(["--mandate-until", "2h", "--human", "--max-payments", "5"]);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  const m = records()[0].mandate;
  expect(m.expires_at_ms).toBeGreaterThanOrEqual(started + 7_200_000);
  expect(m.expires_at_ms).toBeLessThanOrEqual(Date.now() + 7_200_000);
  expect(run.stderr).toContain("can charge at most $1.10 USD until");
  expect(run.stderr.indexOf("can charge at most")).toBeLessThan(run.stderr.indexOf("Signed as"));
  expect(run.stderr).toContain("while the credit lasts");
  expect(run.stderr).toContain("including the upfront payment");
  expect(run.stderr).toContain(`until ${new Date(m.expires_at_ms).toISOString()}`);
});

it("refuses fourteen days when the provider omits its duration limit before signing or posting", async () => {
  await control({ op: "configure", omitMaxDuration: true });
  const before = await control({ op: "snapshot", ids: [] });
  const run = await request(["--mandate-until", "14d"]);
  expect(run.code).toBe(1);
  expect(JSON.parse(run.stdout).error).toMatchObject({
    code: "mandate_duration_unsupported",
    display: "The DVM accepts standing limits up to 7 days.",
    hint: "Choose a shorter --mandate-until or check back to pay later asks.",
  });
  const human = await request(["--mandate-until", "14d", "--human"]);
  expect(human.code).toBe(1);
  expect(human.stderr).toContain("The DVM accepts standing limits up to 7 days.");
  expect(human.stderr).not.toContain("Signed as");
  const after = await control({ op: "snapshot", ids: [] });
  expect(after.postPaths.slice(before.postPaths.length)).toEqual([]);
});

it.each([true, false])("refuses an explicit expiry without standing support before any POST (credit advertised: %s)", async (advertiseCredit) => {
  await control({ op: "support", value: false });
  await control({ op: "configure", advertiseCredit });
  const before = await control({ op: "snapshot", ids: [] });
  const run = await request(["--mandate-until", "14d"]);
  expect(run.code).toBe(1);
  expect(JSON.parse(run.stdout).error).toMatchObject({
    code: "mandate_duration_unsupported",
    display: expect.stringContaining("does not advertise automatic credit payments"),
  });
  expect((await control({ op: "snapshot", ids: [] })).postPaths).toEqual(before.postPaths);
});

it("previews a fourteen-day mandate when info explicitly has no ceiling", async () => {
  await control({ op: "configure", maxDuration: null });
  const before = await control({ op: "snapshot", ids: [] });
  const expiry = new Date(Date.now() + 14 * 86_400_000);
  const run = await request(["--dry-run", "--mandate-until", expiry.toISOString()]);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  expect(JSON.parse(run.stdout).mandate).toMatchObject({ max_total_micro: 1_100_000, expires_at_ms: expiry.getTime() });
  expect((await control({ op: "snapshot", ids: [] })).postPaths).toEqual(before.postPaths);
});

it("keeps the full mixed-currency budget within the signed ceiling", async () => {
  writeFileSync(join(root, "btc-rate.json"), JSON.stringify({ rate: 90_001, timestamp: Date.now() }));
  const run = await request(["--budget", "3111080", "--auto-pay-below", "$0.20"]);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  const output = JSON.parse(run.stdout);
  const snapshot = await control({ op: "snapshot", ids: [output.jobId] });
  expect(snapshot.submissions.at(-1).data.mandate).toMatchObject({ max_total_micro: 2_800_003, max_ask_micro: 200_000 });
});

it("previews exact limits without signing or posting and signs the approved terms on submit", async () => {
  await control({ op: "configure", advertisedUpfront: 0.50 });
  const expiry = new Date(Date.now() + 3_600_000);
  expiry.setUTCMilliseconds(999);
  const before = await control({ op: "snapshot", ids: [] });
  const preview = await request(["--dry-run", "--mandate-until", expiry.toISOString()]);
  expect(preview.code, preview.stdout + preview.stderr).toBe(0);
  const { status, mandate } = JSON.parse(preview.stdout);
  expect(status).toBe("dry_run");
  expect(mandate).toMatchObject({
    status: "preview", max_total_micro: 1_100_000, max_ask_micro: 550_000,
    max_total: { amount_micro: 1_100_000, currency: "usd", display: "$1.10 USD" },
    expires_at_ms: expiry.getTime(), expires_at: expiry.toISOString(),
    display: expect.stringContaining(`can charge at most $1.10 USD until ${expiry.toISOString()}`),
  });
  expect((await control({ op: "snapshot", ids: [] })).postPaths).toEqual(before.postPaths);

  const live = await request(["--mandate-preview", mandate.approval]);
  expect(live.code, live.stdout + live.stderr).toBe(0);
  const { jobId, mandate: signed } = JSON.parse(live.stdout);
  expect(signed).toMatchObject({ max_total_micro: 1_100_000, max_ask_micro: 550_000 });
  const { submissions } = await control({ op: "snapshot", ids: [jobId] });
  expect(submissions.at(-1).data.mandate).toEqual({
    max_total_micro: 1_100_000, max_ask_micro: 550_000, expires_at_ms: expiry.getTime(),
  });

  await control({ op: "configure", quote: "fail" });
  const changed = await request(["--mandate-preview", mandate.approval, "--max-payments", "2"]);
  expect(changed.code).toBe(1);
  expect(JSON.parse(changed.stdout).error.code).toBe("mandate_preview_unavailable");
  expect((await control({ op: "snapshot", ids: [] })).submissions).toHaveLength(submissions.length);

  const withoutQuote = await request(["--mandate-preview", mandate.approval]);
  expect(withoutQuote.code, withoutQuote.stdout + withoutQuote.stderr).toBe(0);
  const { jobId: unquotedJobId } = JSON.parse(withoutQuote.stdout);
  const unquoted = await control({ op: "snapshot", ids: [unquotedJobId] });
  expect(unquoted.submissions.at(-1).data.mandate).toEqual({
    max_total_micro: mandate.max_total_micro, max_ask_micro: mandate.max_ask_micro, expires_at_ms: mandate.expires_at_ms,
  });
}, 15_000);

async function previewApproval(extra: string[] = []) {
  const run = await request(["--dry-run", ...extra]);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  return JSON.parse(run.stdout).mandate;
}

it.each(["removed", "replaced"])("refuses to sign when the selected credit was %s after preview", async (change) => {
  const mandate = await previewApproval();
  const file = join(root, "credits.json");
  const store = JSON.parse(readFileSync(file, "utf8"));
  if (change === "removed") store.credits = [];
  else store.credits[0].creditId = "replacement-credit";
  writeFileSync(file, JSON.stringify(store));
  const before = await control({ op: "snapshot", ids: [] });

  const run = await request(["--mandate-preview", mandate.approval]);
  expect(run.code).toBe(1);
  const { error } = JSON.parse(run.stdout);
  expect(error.code).toBe(change === "removed" ? "mandate_preview_unavailable" : "mandate_preview_changed");
  if (change === "replaced") {
    expect(error.display).toContain("approved credit was mandate-credit. The live credit is replacement-credit");
    expect(error.hint).toContain("confirm a new approval for replacement-credit");
  }
  expect((await control({ op: "snapshot", ids: [] })).postPaths).toEqual(before.postPaths);
});

it.each([
  { requestId: [] },
  { requestId: ["--request-id", "approved-credit-rejected"] },
])("stops after the DVM rejects approved credit without retrying or paying ($requestId)", async ({ requestId }) => {
  const mandate = await previewApproval();
  await control({ op: "configure", rejectCredit: true });
  const before = await control({ op: "snapshot", ids: [] });

  const run = await request(["--mandate-preview", mandate.approval, ...requestId]);
  expect(run.code).toBe(1);
  expect(JSON.parse(run.stdout).error).toMatchObject({
    code: "mandate_preview_unavailable",
    display: expect.stringContaining("credit_not_found"),
  });
  const after = await control({ op: "snapshot", ids: [] });
  expect(after.postPaths.slice(before.postPaths.length)).toEqual(["/v1/quote", "/v1/job"]);
  expect(after.submissions.at(-1).data.mandate).toMatchObject({ max_total_micro: 1_100_000 });
});

it("keeps the mandate on recovery after an approved submit is refused", async () => {
  const mandate = await previewApproval();
  await control({ op: "configure", rejectCredit: true });
  const requestId = "approved-recovery";
  const submit = await request(["--mandate-preview", mandate.approval, "--request-id", requestId]);
  expect(JSON.parse(submit.stdout).error.code).toBe("mandate_preview_unavailable");
  const before = await control({ op: "snapshot", ids: [] });

  const resume = await execute(process.execPath, [binary, "request-resume", requestId], {
    env: { ...process.env, DVM_CONFIG_DIR: root, DVM_IDENTITY_KEY: "0d".repeat(32) }, timeout: 15_000,
  }).then((run) => ({ ...run, code: 0 }), (error) => error as { stdout: string; stderr: string; code: number });
  expect(resume.code).toBe(1);
  expect(JSON.parse(resume.stdout).error.code).toBe("invalid_mandate");
  const after = await control({ op: "snapshot", ids: [] });
  expect(after.postPaths.slice(before.postPaths.length)).toEqual([
    `/v1/request-result/${requestId}`, `/v1/request-resume/${requestId}`,
  ]);
  const original = before.submissions.at(-1).data.mandate;
  expect(after.recoveryPosts.slice(before.recoveryPosts.length).map(({ data }: { data: { mandate: unknown } }) => data.mandate))
    .toEqual([original, original]);
});

it("refuses when the provider shortens the maximum below the approved expiry", async () => {
  const mandate = await previewApproval(["--mandate-until", "2h"]);
  await control({ op: "configure", maxDuration: 3_600_000 });
  const before = await control({ op: "snapshot", ids: [] });
  const run = await request(["--mandate-preview", mandate.approval]);
  expect(run.code).toBe(1);
  expect(JSON.parse(run.stdout).error).toMatchObject({
    code: "mandate_duration_unsupported",
    display: expect.stringContaining(`The approved expiry is ${mandate.expires_at}. The DVM currently accepts standing limits up to 1h.`),
  });
  expect((await control({ op: "snapshot", ids: [] })).postPaths).toEqual(before.postPaths);
});

it.each([
  [[], 650_000, 550_000, "$0.65"],
  [["--max-increment", "$0.40"], 500_000, 400_000, "$0.50"],
] as const)("signs and reports lower live caps when the upfront ceiling is higher (%j)", async (flags, total, ask, label) => {
  await control({ op: "configure", advertisedUpfront: 0.50 });
  const cap = ["--max-payments", "2"];
  const approval = await previewApproval(cap);
  expect(approval.max_total_micro).toBe(1_050_000);

  const run = await request([...cap, "--mandate-preview", approval.approval, ...flags]);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  const output = JSON.parse(run.stdout);
  const snapshot = await control({ op: "snapshot", ids: [output.jobId] });
  expect(snapshot.submissions.at(-1).data.mandate).toEqual({
    max_total_micro: total, max_ask_micro: ask, expires_at_ms: approval.expires_at_ms,
  });
  expect(output.mandate).toMatchObject({
    max_total_micro: total, approved_max_total_micro: 1_050_000,
    max_ask_micro: ask, approved_max_ask_micro: 550_000,
  });
  expect(output.mandate.display).toContain(`Approved up to $1.05 USD total. Signed ${label} USD under the live limits.`);
  if (flags.length) expect(output.mandate.display).toContain("Approved up to $0.55 USD per charge. Signed $0.40 USD under the live limits.");
});

it.each([
  [90_002, 2_800_003],
  [90_000, 2_700_000],
])("bounds the signed total when the FX rate moves to %s", async (liveRate, signedTotal) => {
  const setRate = (rate: number) => writeFileSync(join(root, "btc-rate.json"), JSON.stringify({ rate, timestamp: Date.now() }));
  const flags = ["--budget", "3111080", "--auto-pay-below", "$0.20"];
  setRate(90_001);
  const approval = await previewApproval(flags);
  expect(approval.max_total_micro).toBe(2_800_003);
  setRate(liveRate);

  const run = await request([...flags, "--mandate-preview", approval.approval]);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  const output = JSON.parse(run.stdout);
  const snapshot = await control({ op: "snapshot", ids: [output.jobId] });
  expect(snapshot.submissions.at(-1).data.mandate).toEqual({
    max_total_micro: signedTotal, max_ask_micro: 200_000, expires_at_ms: approval.expires_at_ms,
  });
  expect(output.mandate).toMatchObject({ max_total_micro: signedTotal, approved_max_total_micro: 2_800_003 });
  if (liveRate < 90_001)
    expect(output.mandate.display).toContain("Approved up to $2.800003 USD total. Signed $2.70 USD under the live limits.");
});

it("withholds a mandate without advertised support and says a payer is needed", async () => {
  await control({ op: "support", value: false });
  await control({ op: "configure", maxDuration: 4 * 3_600_000 });
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

// Two CLI startups and PostgreSQL submissions include a deliberate 1 s quote
// deadline (the fixture replies at 1.5 s); allow headroom under shared CI load.
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
}, 15_000);

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
  await control({ op: "configure", reject: true, omitMaxDuration: true });
  const before = await control({ op: "snapshot", ids: [] });
  const run = await request(["--mandate-until", "7d"]);
  expect(run.code).toBe(1);
  expect(run.stdout).toContain("shorter --mandate-until");
  expect(run.stdout).toContain("clock");
  const after = await control({ op: "snapshot", ids: [] });
  expect(after.submissions.length).toBe(before.submissions.length + 1);
  expect(after.submissions.at(-1).data.mandate.expires_at_ms).toBeLessThan(Date.now() + 7 * 86_400_000 - 290_000);
});


function watchSettlement(jobId: string) {
  // The watch exits at completion. Leave time for sequential asks under suite load.
  return execute(process.execPath, [binary, "messages", jobId, "--wait", "--until", "60s"], {
    env: { ...process.env, DVM_CONFIG_DIR: root, DVM_IDENTITY_KEY: "0d".repeat(32) }, timeout: 70_000,
  });
}

it.skipIf(!process.env.DVM_CLI_MANDATE_DATABASE_URL && !process.env.CI)("settles a later ask by mandate when budget equals the threshold", async () => {
  await control({ op: "configure", pieces: 1 });
  const before = await control({ op: "snapshot", ids: [] });
  const run = await request(["--budget", "$0.30", "--auto-pay-below", "$0.30", "--auto-pay"], true);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  const { jobId, status } = JSON.parse(run.stdout.trim().split("\n").at(-1)!);
  expect(status).toBe("completed");
  const after = await control({ op: "snapshot", ids: [jobId] });
  expect(after.submissions.at(-1).data.mandate).toMatchObject({ max_total_micro: 300_000, max_ask_micro: 300_000 });
  expect(after.paymentPosts).toHaveLength(before.paymentPosts.length);
  expect(after.jobs[0].status).toBe("completed");
  const [job] = records();
  expect(job).toMatchObject({
    upfrontPayment: { amount_micro: 100_000 }, paymentsHonoured: 2, totalPaidMsats: 300_000,
    policy: { maxPayments: 5 },
  });
  expect(Object.values(job.mandatePaymentMsats ?? {})).toEqual([200_000]);
}, 20_000);

it.skipIf(!process.env.DVM_CLI_MANDATE_DATABASE_URL && !process.env.CI)("reports the SDK's second and third mandate-paid pieces once each without a CLI payment POST", async () => {
  await control({ op: "configure", hold: true, pieces: 2 });
  const submitted = await request(["--max-payments", "5"]);
  expect(submitted.code, submitted.stdout + submitted.stderr).toBe(0);
  const { jobId } = JSON.parse(submitted.stdout);
  const before = await control({ op: "snapshot", ids: [] });
  await control({ op: "release" });
  const run = await watchSettlement(jobId);
  const events = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const payments = events.filter((event) => event.event === "payment");
  expect(payments, JSON.stringify({ events, snapshot: await control({ op: "snapshot", ids: [jobId] }) })).toHaveLength(2);
  expect(payments.map((event) => event.amount.amount_micro)).toEqual([200_000, 200_000]);
  expect(payments.map((event) => event.total_micro)).toEqual([300_000, 500_000]);
  for (const payment of payments) expect(payment).toMatchObject({ mandate: true, budget_micro: 1_100_000,
    overcharged: false, display: expect.stringContaining("paid from your credit under your standing limit") });
  const snapshot = await control({ op: "snapshot", ids: [jobId] });
  expect(snapshot.paymentPosts).toHaveLength(before.paymentPosts.length);
  expect(snapshot.jobs[0].status).toBe("completed");
  expect(records()[0]).toMatchObject({ totalPaidMsats: 500_000, paymentsHonoured: 3 });
}, 90_000);

it.skipIf(!process.env.DVM_CLI_MANDATE_DATABASE_URL && !process.env.CI)("submits a fourteen-day mandate and settles fourteen later asks with the default payment count", async () => {
  const info = await fetch(new URL("/v1/info", endpoint)).then((response) => response.json());
  expect(info.credit).toMatchObject({ standing_mandate: true, mandate_max_duration: null });
  const flags = ["--mandate-until", "14d", "--budget", "$2.90", "--auto-pay-below", "$0.20"];
  const duration = 14 * 86_400_000;
  const started = Date.now();
  await control({ op: "configure", hold: true, pieces: 14 });
  const submitted = await request(flags);
  expect(submitted.code, submitted.stdout + submitted.stderr).toBe(0);
  const { jobId, mandate } = JSON.parse(submitted.stdout);
  expect(mandate.expires_at_ms).toBeGreaterThanOrEqual(started + duration);
  expect(mandate.expires_at_ms).toBeLessThanOrEqual(Date.now() + duration);
  const expiry = new Date(mandate.expires_at_ms).toISOString();
  expect(mandate).toMatchObject({
    max_total_micro: 2_900_000,
    expires_at: expiry,
    display: expect.stringContaining(`can charge at most $2.90 USD until ${expiry}`),
  });
  const before = await control({ op: "snapshot", ids: [jobId] });
  expect(before.jobs[0].mandate).toMatchObject({ max_total_micro: 2_900_000, expires_at_ms: mandate.expires_at_ms });
  await control({ op: "release" });
  const run = await watchSettlement(jobId);
  const payments = run.stdout.trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.event === "payment");
  expect(payments).toHaveLength(14);
  for (const [index, payment] of payments.entries()) {
    expect(payment).toMatchObject({ mandate: true, total_micro: 100_000 + (index + 1) * 200_000, overcharged: false });
  }
  expect(run.stderr).not.toMatch(/overcharg/i);
  expect(records()[0]).toMatchObject({ paymentsHonoured: 15, totalPaidMsats: 2_900_000 });
  const after = await control({ op: "snapshot", ids: [jobId] });
  expect(after.paymentPosts).toHaveLength(before.paymentPosts.length);
  expect(after.jobs[0].status).toBe("completed");

  await control({ op: "configure" });
  const humanStarted = Date.now();
  const human = await request([...flags, "--human"]);
  expect(human.code, human.stdout + human.stderr).toBe(0);
  const confirmation = await control({ op: "snapshot", ids: [] });
  const humanExpiry = confirmation.submissions.at(-1).data.mandate.expires_at_ms;
  expect(humanExpiry).toBeGreaterThanOrEqual(humanStarted + duration);
  expect(humanExpiry).toBeLessThanOrEqual(Date.now() + duration);
  const sentence = `can charge at most $2.90 USD until ${new Date(humanExpiry).toISOString()}`;
  expect(human.stderr).toContain(sentence);
  expect(human.stderr).toContain("Signed as");
  expect(human.stderr.indexOf(sentence)).toBeLessThan(human.stderr.indexOf("Signed as"));
}, 110_000);

it.skipIf(!process.env.DVM_CLI_MANDATE_DATABASE_URL && !process.env.CI).each([true, false])(
  "protects the preview per-charge cap after FX rises (attached payer: %s)", async (attached) => {
    const setRate = (rate: number) => writeFileSync(join(root, "btc-rate.json"), JSON.stringify({ rate, timestamp: Date.now() }));
    const flags = ["--auto-pay-below", "200000"];
    setRate(90_001);
    const approval = await previewApproval(flags);
    expect(approval.max_ask_micro).toBe(180_002);
    setRate(100_000);
    await control({ op: "configure", pieces: 1, hold: !attached });
    const before = await control({ op: "snapshot", ids: [] });
    const submit = await request([...flags, "--mandate-preview", approval.approval, "--timeout", "8"], attached);
    const cli = (args: string[]) => execute(process.execPath, [binary, ...args], {
      env: { ...process.env, DVM_CONFIG_DIR: root, DVM_IDENTITY_KEY: "0d".repeat(32) }, timeout: 15_000,
    }).then((run) => ({ ...run, code: 0 }), (error) => error as { stdout: string; stderr: string; code: number });

    let blocked = submit;
    if (!attached) {
      expect(submit.code, submit.stdout + submit.stderr).toBe(0);
      await control({ op: "release" });
      blocked = await cli(["messages", JSON.parse(submit.stdout).jobId, "--wait", "--until", "5s"]);
    }
    expect(blocked.code, blocked.stdout + blocked.stderr).toBe(1);
    const { error } = JSON.parse(blocked.stdout.trim().split("\n").at(-1)!);
    const { job_id: jobId, request_seq: seq } = error;
    expect(error).toMatchObject({
      code: "mandate_payment_approval_required",
      display: expect.stringContaining("exceeds the standing per-charge limit"),
      hint: expect.stringContaining(`dvm pay ${jobId} ${seq}`),
    });
    const after = await control({ op: "snapshot", ids: [jobId] });
    expect(after.submissions.at(-1).data.mandate.max_ask_micro).toBe(180_002);
    expect(after.paymentPosts).toHaveLength(before.paymentPosts.length);
    expect(after.jobs[0].status).toBe("awaiting-input");
    if (!attached) {
      const auto = await cli(["pay", jobId, "--auto"]);
      expect(JSON.parse(auto.stdout).error.code).toBe("mandate_payment_approval_required");
      const wrongAsk = await cli(["pay", jobId, String(seq + 1)]);
      expect(JSON.parse(wrongAsk.stdout).error.code).toBe("payment_request_not_pending");
      expect((await control({ op: "snapshot", ids: [jobId] })).paymentPosts).toHaveLength(before.paymentPosts.length);
      const explicit = await cli(["pay", jobId, String(seq)]);
      expect(explicit.code, explicit.stdout + explicit.stderr).toBe(0);
      const paid = await control({ op: "snapshot", ids: [jobId] });
      expect(paid.paymentPosts.slice(before.paymentPosts.length)).toMatchObject([{ content: { credit: { amount_micro: 200_000, request_seq: seq } } }]);
    }
  }, 25_000);

it.skipIf(!process.env.DVM_CLI_MANDATE_DATABASE_URL && !process.env.CI).each([false, true])(
  "reports the approved charge as paid and the later ask separately (lost payment response: %s)", async (dropPaymentResponse) => {
    const flags = ["--auto-pay-below", "$0.20", "--max-payments", "3"];
    const approval = await previewApproval(flags);
    await control({ op: "configure", hold: true, askAmounts: [0.45, 0.20], dropPaymentResponse });
    const submit = await request([...flags, "--mandate-preview", approval.approval]);
    expect(submit.code, submit.stdout + submit.stderr).toBe(0);
    const { jobId, mandate } = JSON.parse(submit.stdout);
    expect(mandate.max_total_micro).toBe(500_000);
    const before = await control({ op: "snapshot", ids: [] });
    await control({ op: "release" });
    const cli = (args: string[]) => execute(process.execPath, [binary, ...args], {
      env: { ...process.env, DVM_CONFIG_DIR: root, DVM_IDENTITY_KEY: "0d".repeat(32) }, timeout: 15_000,
    }).then((run) => ({ ...run, code: 0 }), (error) => error as { stdout: string; stderr: string; code: number });

    const initial = await cli(["pay", jobId, "--auto"]);
    const { error } = JSON.parse(initial.stdout);
    expect(error.code).toBe("mandate_payment_approval_required");
    const seq = error.request_seq;
    const explicit = await cli(["pay", jobId, String(seq), "--timeout", "5"]);
    if (dropPaymentResponse) {
      expect(explicit.code).toBe(1);
      expect(records()[0].pendingCreditPayment.authorization.request_seq).toBe(seq);
    }
    const result = dropPaymentResponse ? await cli(["pay", jobId, "--auto", "--timeout", "5"]) : explicit;
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const { paid, next_action: next } = JSON.parse(result.stdout);
    const after = await control({ op: "snapshot", ids: [jobId] });
    const posts = after.paymentPosts.slice(before.paymentPosts.length);
    expect(posts).toHaveLength(1);
    expect(paid).toMatchObject({
      seq, rail: "credit", amount: { amount_micro: 450_000, currency: "usd", display: "$0.45 USD" },
      receipt: { payment_id: posts[0].content.credit.payment_id, amount_micro: 450_000, currency: "usd" },
    });
    expect(next, result.stdout).toMatchObject({ type: "pay", code: "mandate_payment_approval_required", requires_approval: true,
      display: expect.stringContaining("exceed the total"), credit: { amount_micro: 200_000, currency: "usd" } });
    expect(next.request_seq).toBeGreaterThan(seq);
    expect(next.hint).toContain(`dvm pay ${jobId} ${next.request_seq}`);
    expect(records()[0]).toMatchObject({ paymentsHonoured: 2, totalPaidMsats: 550_000 });
    expect(records()[0].pendingCreditPayment).toBeUndefined();
  }, 25_000);
