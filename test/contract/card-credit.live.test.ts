/* Card-funded credit through the built `dvm` CLI against Stripe test mode: a
 * real test shared payment token, a real PaymentIntent, a job drawing from the
 * booked credit, and the refund of what is left. Runs only when
 * STRIPE_TEST_SECRET_KEY holds a Stripe test-mode key; otherwise it skips and
 * the suite stays offline. */
import { type ChildProcess, fork, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const KEY = process.env.STRIPE_TEST_SECRET_KEY;
const live = KEY !== undefined && /^(sk|rk)_test_/.test(KEY);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const binary = join(repositoryRoot, "dist", "dvm.js");
const SLOW = 120_000;

describe.skipIf(!live)("card credit against Stripe test mode", () => {
  let provider: ChildProcess;
  let endpoint: string;
  let configRoot: string;

  beforeAll(async () => {
    provider = fork(join(repositoryRoot, "test/support/card-credit-provider.mjs"), ["live"], {
      cwd: repositoryRoot,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    endpoint = (await new Promise<{ endpoint: string }>((done) => provider.once("message", done))).endpoint;
    configRoot = mkdtempSync(join(tmpdir(), "dvm-card-credit-live-"));
    writeFileSync(join(configRoot, "btc-rate.json"), JSON.stringify({ rate: 100_000, timestamp: Date.now() }));
  }, SLOW);

  afterAll(async () => {
    provider?.send({ type: "shutdown" });
    if (configRoot) rmSync(configRoot, { recursive: true, force: true });
  });

  it("funds with a test token, draws a job from it, and refunds the rest to the card", async () => {
    const spt = await testSpt(200);
    const funded = await dvm(["credit", "fund", endpoint, "--amount", "$2", "--over-trust", "--spt", "-"], `${spt}\n`, spt);
    expect(funded.code, funded.stdout).toBe(0);
    expect(JSON.parse(funded.stdout)).toMatchObject({ status: "funded", rail: "stripe", funded_micro: 2_000_000 });

    const job = await dvm(["request", "--endpoint", `${endpoint}/run`, "--data", "{}", "--budget", "$0.20"], "", spt);
    expect(job.code, job.stdout + job.stderr).toBe(0);
    const balance = JSON.parse((await dvm(["credit", "balance", endpoint], "", spt)).stdout);
    expect(balance.credits[0].remaining_micro).toBe(1_900_000);

    const drained = await dvm(["credit", "drain", endpoint], "", spt);
    expect(drained.code, drained.stdout + drained.stderr).toBe(0);
    const drain = JSON.parse(drained.stdout);
    expect(["pending", "sent"]).toContain(drain.drain.status);
    if (drain.drain.status === "sent") expect(drain.refund_ids.length).toBeGreaterThan(0);
  }, SLOW);

  async function dvm(args: string[], stdin: string, spt: string) {
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((done, reject) => {
      const child = spawn(process.execPath, [binary, ...args], {
        cwd: repositoryRoot,
        env: { ...process.env, DVM_CONFIG_DIR: configRoot, DVM_IDENTITY_KEY: "0e".repeat(32), LANG: "C", LC_ALL: "C" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => done({ stdout, stderr, code }));
      child.stdin.end(stdin);
    });
    expect(result.stdout + result.stderr).not.toContain(spt);
    return result;
  }
});

/** Stripe's test helper stands in for the human approving a spend request in Link. */
async function testSpt(cents: number): Promise<string> {
  const response = await fetch("https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${KEY ?? ""}:`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      payment_method: "pm_card_visa",
      "usage_limits[currency]": "usd",
      "usage_limits[max_amount]": String(cents),
      "usage_limits[expires_at]": String(Math.floor(Date.now() / 1000) + 3600),
    }),
  });
  const body = (await response.json()) as { id?: string; error?: { code?: string } };
  if (!response.ok || !body.id) throw new Error(`test SPT refused: ${body.error?.code ?? String(response.status)}`);
  return body.id;
}
