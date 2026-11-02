/* Card-funded prepaid credit through the built `dvm` CLI, against a DVM running
 * the SDK's real card rail and a fake Stripe (test/support/card-credit-provider.mjs).
 *
 * The shared payment token is a bearer approval for a card charge, so every
 * run here also checks that it never reaches stdout, stderr or the caller's
 * state directory, on success and on each failure path. */
import { type ChildProcess, fork, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const binary = join(repositoryRoot, "dist", "dvm.js");
const IDENTITY = "0d".repeat(32);
const SLOW = 60_000;

interface Snapshot {
  chargeAttempts: number;
  intents: Array<{ id: string; amount: number; refunded: number }>;
  refundCreates: number;
  jobs: number;
}

let provider: ChildProcess;
let endpoint: string;
const configDirs: string[] = [];
let spt: string;

beforeAll(async () => {
  provider = fork(join(repositoryRoot, "test/support/card-credit-provider.mjs"), [], {
    cwd: repositoryRoot,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const ready = await nextMessage<{ endpoint: string }>("ready");
  endpoint = ready.endpoint;
}, SLOW);

afterAll(async () => {
  provider.send({ type: "shutdown" });
  await new Promise((done) => provider.once("disconnect", done));
  for (const dir of configDirs) rmSync(dir, { recursive: true, force: true });
});

let configRoot: string;
afterEach(async () => {
  // Every test runs on its own state and resets the fake back to a clean card.
  await control({ charge: "succeed", lostChargeResponses: 0, feeSettled: true, dropPaidResponses: 0 });
});

function freshCaller(): string {
  const dir = mkdtempSync(join(tmpdir(), "dvm-card-credit-"));
  configDirs.push(dir);
  // A cached rate keeps the job's budget check offline.
  writeFileSync(join(dir, "btc-rate.json"), JSON.stringify({ rate: 100_000, timestamp: Date.now() }));
  return dir;
}

function startTest(): void {
  configRoot = freshCaller();
  spt = `spt_test_${randomBytes(12).toString("hex")}`;
}

describe("card top-up without an approval", () => {
  it("charges nothing and hands back the link-cli steps for the human's approval", async () => {
    startTest();
    const before = await snapshot();
    const run = await dvm(["credit", "fund", endpoint, "--rail", "stripe", "--amount", "$2", "--over-trust"]);

    expect(run.code).toBe(1);
    const error = JSON.parse(run.stdout).error;
    expect(error).toMatchObject({
      code: "card_approval_required",
      rail: "stripe",
      amount_micro: 2_000_000,
      amount_cents: 200,
      currency: "usd",
      network_id: "profile_test",
    });
    expect(error.link_cli.create).toContain(
      "link-cli spend-request create --credential-type shared_payment_token --network-id profile_test --amount 200 --currency usd"
    );
    expect(error.link_cli.create).toContain("--request-approval");
    expect(error.link_cli.retrieve).toContain("--include shared_payment_token");
    expect(error.next_command).toBe(`dvm credit fund ${endpoint} --rail stripe --amount '$2.00' --spt -`);
    expect(error.display).toContain("card top-up");
    expect(error.display).toContain("Nothing has been charged");
    expect(error.display).toContain("refunded to the card");
    expect(error.hint).toContain("link-cli mpp pay");
    expect((await snapshot()).chargeAttempts).toBe(before.chargeAttempts);
  }, SLOW);
});

describe("card top-up with an approval", () => {
  it("funds the credit, a signed job draws from it, and a drain refunds the rest to the card", async () => {
    startTest();
    const before = await snapshot();
    const funded = await dvm(["credit", "fund", endpoint, "--amount", "$2", "--over-trust", "--spt", "-"], `${spt}\n`);
    expect(funded.code, funded.stderr).toBe(0);
    const fund = JSON.parse(funded.stdout);
    expect(fund).toMatchObject({ status: "funded", rail: "stripe", funded_micro: 2_000_000, charged_micro: 2_000_000 });
    expect(fund.credit.remaining_micro).toBe(2_000_000);
    expect(fund.display).toContain("charged to the card");

    const job = await dvm(["request", "--endpoint", `${endpoint}/run`, "--data", "{}", "--budget", "$0.20"]);
    expect(job.code, job.stdout + job.stderr).toBe(0);
    const balance = JSON.parse((await dvm(["credit", "balance", endpoint])).stdout);
    expect(balance.credits[0].remaining_micro).toBe(1_900_000);

    const drained = await dvm(["credit", "drain", endpoint]);
    expect(drained.code, drained.stderr).toBe(0);
    const drain = JSON.parse(drained.stdout);
    expect(drain.drain).toMatchObject({ method: "stripe", status: "sent" });
    expect(drain.refund_ids).toEqual([expect.stringMatching(/^re_test_/)]);
    // $1.90 back from a $2.00 charge whose fee was 36 cents: the refund's share is 34 cents.
    expect(drain.card_refund).toMatchObject({ refunded_usd: "$1.56", stripe_fee_share_usd: "$0.34" });
    expect(drain.display).toBe(
      "$1.56 was refunded to the card that paid for this credit. $0.34 of the balance covered this refund's share of Stripe's card processing fee, which Stripe does not return on a refund."
    );

    const after = await snapshot();
    expect(after.chargeAttempts - before.chargeAttempts).toBe(1);
    expect(after.jobs - before.jobs).toBe(1);
    expect(after.refundCreates - before.refundCreates).toBe(1);
    expectNoSecretOnDisk(configRoot);
  }, SLOW);

  it("reports a decline in plain words, charges nothing, and keeps no journal", async () => {
    startTest();
    await control({ charge: "decline" });
    const run = await dvm(["credit", "fund", endpoint, "--amount", "$1", "--over-trust", "--spt", spt]);
    expect(run.code).toBe(1);
    const error = JSON.parse(run.stdout).error;
    expect(error).toMatchObject({ code: "payment_invalid", reason: "declined", decline_code: "insufficient_funds" });
    expect(error.display).toBe(
      "The card was declined (decline code insufficient_funds, Stripe code card_declined), so nothing was charged and no credit was added."
    );
    expect(cardJournal(configRoot)).toEqual([]);
    expectNoSecretOnDisk(configRoot);
  }, SLOW);

  it("resends the same approval when Stripe's answer is lost, and books one charge", async () => {
    startTest();
    const before = await snapshot();
    await control({ lostChargeResponses: 1 });
    const run = await dvm(["credit", "fund", endpoint, "--amount", "$1", "--over-trust", "--spt", spt]);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ status: "funded", funded_micro: 1_000_000 });
    const after = await snapshot();
    // Two charge calls under one idempotency key: one PaymentIntent.
    expect(after.chargeAttempts - before.chargeAttempts).toBe(2);
    expect(after.intents.length - before.intents.length).toBe(1);
    expect(cardJournal(configRoot)).toEqual([]);
    expectNoSecretOnDisk(configRoot);
  }, SLOW);
});

describe("an interrupted card top-up", () => {
  it("books once and charges once when the run that charged never hears back", async () => {
    startTest();
    const before = await snapshot();
    // Every paid response in the first run is lost after the DVM charged and booked.
    await control({ dropPaidResponses: 3 });
    const first = await dvm(["credit", "fund", endpoint, "--amount", "$1", "--over-trust", "--spt", spt]);
    expect(first.code).toBe(1);
    const unknown = JSON.parse(first.stdout).error;
    expect(unknown.display).toContain("may or may not have been charged");
    expect(unknown.hint).toContain("same --spt");
    expect(cardJournal(configRoot)).toHaveLength(1);
    // The journal outlives the run, so it is where a leaked token would sit.
    expectNoSecretOnDisk(configRoot);

    const second = await dvm(["credit", "fund", endpoint, "--amount", "$1", "--over-trust", "--spt", spt]);
    expect(second.code, second.stdout + second.stderr).toBe(0);
    const resumed = JSON.parse(second.stdout);
    expect(resumed).toMatchObject({ status: "funded", funded_micro: 1_000_000, charged_micro: 1_000_000 });
    expect(resumed.credit.remaining_micro).toBe(1_000_000);
    expect(cardJournal(configRoot)).toEqual([]);

    const after = await snapshot();
    expect(after.intents.length - before.intents.length).toBe(1);
    expectNoSecretOnDisk(configRoot);
  }, SLOW);

  it("would charge twice without the journal, which is the hazard it closes", async () => {
    startTest();
    const before = await snapshot();
    await control({ dropPaidResponses: 3 });
    await dvm(["credit", "fund", endpoint, "--amount", "$1", "--over-trust", "--spt", spt]);
    rmSync(join(configRoot, "card-fundings"), { recursive: true, force: true });

    const rerun = await dvm(["credit", "fund", endpoint, "--amount", "$1", "--over-trust", "--spt", spt]);
    expect(rerun.code).toBe(0);
    expect((await snapshot()).intents.length - before.intents.length).toBe(2);
  }, SLOW);
});

describe("card refund drain", () => {
  it("reports a refund Stripe hasn't finished as pending, then sent on a later poll", async () => {
    startTest();
    expect((await dvm(["credit", "fund", endpoint, "--amount", "$1", "--over-trust", "--spt", spt])).code).toBe(0);
    await control({ feeSettled: false });

    const pending = await dvm(["credit", "drain", endpoint]);
    expect(pending.code, pending.stderr).toBe(0);
    const first = JSON.parse(pending.stdout);
    expect(first.drain).toMatchObject({ method: "stripe", status: "pending" });
    expect(first.display).toContain("Stripe hasn't finished it yet");
    expect(first.hint).toContain("--method stripe");

    await control({ feeSettled: true });
    const sent = JSON.parse((await dvm(["credit", "drain", endpoint])).stdout);
    expect(sent.drain).toMatchObject({ drain_id: first.drain.drain_id, status: "sent" });
    expect(sent.refund_ids).toHaveLength(1);
  }, SLOW);

  it("follows the card refund another machine already started instead of failing", async () => {
    startTest();
    const funded = JSON.parse(
      (await dvm(["credit", "fund", endpoint, "--amount", "$1", "--over-trust", "--spt", spt])).stdout
    );
    await control({ feeSettled: false });
    const started = JSON.parse((await dvm(["credit", "drain", endpoint])).stdout);
    expect(started.drain.status).toBe("pending");

    // Same caller identity, no local record of that drain.
    const elsewhere = freshCaller();
    await control({ feeSettled: true });
    const run = await dvm(
      ["credit", "drain", endpoint, "--credit-id", funded.credit_id, "--method", "stripe"],
      undefined,
      elsewhere
    );
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const adopted = JSON.parse(run.stdout);
    expect(adopted.drain).toMatchObject({ drain_id: started.drain.drain_id, status: "sent" });
    expect(adopted.adopted_drain_id).toBe(started.drain.drain_id);
    expect(adopted.display).toContain("followed instead of starting a second one");
  }, SLOW);

  it("refuses a payout address for a card refund", async () => {
    startTest();
    const run = await dvm([
      "credit", "drain", endpoint, "--credit-id", "any", "--method", "stripe",
      "--address", "0x1111111111111111111111111111111111111111",
    ]);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout).error.hint).toContain("goes back to the card");
  }, SLOW);
});

async function dvm(
  args: string[],
  stdin?: string,
  root = configRoot
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((done, reject) => {
    const child = spawn(process.execPath, [binary, ...args], {
      cwd: repositoryRoot,
      env: { ...process.env, DVM_CONFIG_DIR: root, DVM_IDENTITY_KEY: IDENTITY, LANG: "C", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => done({ stdout, stderr, code }));
    child.stdin.end(stdin ?? "");
  });
  // The token is a bearer approval for a card charge: no output may carry it.
  expect(result.stdout).not.toContain(spt);
  expect(result.stderr).not.toContain(spt);
  expect(result.stdout + result.stderr).not.toMatch(/spt_test_[0-9a-f]{24}/);
  return result;
}

function expectNoSecretOnDisk(root: string): void {
  for (const file of filesUnder(root)) {
    expect(readFileSync(file, "utf8"), file).not.toContain(spt);
  }
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function cardJournal(root: string): string[] {
  const dir = join(root, "card-fundings");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
}

async function control(settings: Record<string, unknown>): Promise<void> {
  provider.send({ type: "control", control: settings });
  await nextMessage("ok");
}

async function snapshot(): Promise<Snapshot> {
  provider.send({ type: "snapshot" });
  return nextMessage<Snapshot>("snapshot");
}

function nextMessage<T>(type: string): Promise<T> {
  return new Promise((done) => {
    const listener = (message: { type?: string }) => {
      if (message?.type !== type) return;
      provider.off("message", listener);
      done(message as T);
    };
    provider.on("message", listener);
  });
}
