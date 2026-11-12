import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

const execute = promisify(execFile);
const binary = resolve(import.meta.dirname, "../../dist/dvm.js");
const roots: string[] = [];
const link = "https://checkout.stripe.com/c/pay/cs_test_example";
let root: string;
let endpoint: string;
let server: Server;
let paid = false;
let expired = false;
let refunded = false;
const ordinaryExpiryHint = "Start a new top-up with a new fund_id. Any abandoned payment is automatically refunded to the card.";
const refundedExpiryHint = "What was still owed on the charge was refunded to the card. Start a new top-up with a new fund_id.";
const disputeLostExpiryHint = "The card dispute was lost; no additional refund is due. Start a new top-up with a new fund_id.";
let expiryHint: string | undefined = ordinaryExpiryHint;
let unavailable = false;
let unavailableRetryable = false;
let unavailableCause = "permission_denied";
let stripeStatus = 403;
let payOnPoll = false;
let loseResponse = false;
let expireOnPoll = false;
let holdMenus = false;
let delaySecondMenu = false;
let firstMenuSeen: (() => void) | undefined;
let menuReplies: Array<() => void> = [];
let expiresAt: number;
let requests: Array<Record<string, unknown>> = [];
const menu = {
  min_micro: 100_000, max_micro: 100_000_000, ttl_ms: 86400000, currency: "usd", funding: ["stripe", "lightning"],
  stripe: { network_id: "example", currency: "usd", min_micro: 5_000_000, checkout: true },
};

beforeAll(async () => {
  server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/info") {
      response.end(JSON.stringify({ name: "Checkout fixture", protocol_version: 1, auth: ["secp256k1-schnorr-v2"],
        auth_audience: { dvm_id: "checkout-fixture", builder_pubkey: "00".repeat(32) } }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    if (body.op === "balance") {
      const reply = () => response.end(JSON.stringify({ op: "balance", credits: [], menu }));
      if (holdMenus) {
        menuReplies.push(reply);
        if (menuReplies.length === 1) firstMenuSeen?.();
        if (menuReplies.length === 2) {
          if (delaySecondMenu) {
            menuReplies[0]();
            holdMenus = false;
          } else for (const send of menuReplies) send();
        }
      } else reply();
      return;
    }
    requests.push(body);
    if (loseResponse) {
      loseResponse = false;
      response.destroy();
      return;
    }
    if (expireOnPoll && Date.now() >= expiresAt * 1000) expired = true;
    if (unavailable || expired) {
      response.statusCode = unavailable ? (unavailableRetryable ? 503 : 502) : 409;
      response.end(JSON.stringify({ error: unavailable ? "checkout_unavailable" : "checkout_expired", retryable: unavailable && unavailableRetryable,
        cause: unavailable ? unavailableCause : undefined, stripe_status: unavailable ? stripeStatus : undefined,
        message: "Checkout could not complete.", hint: refunded ? refundedExpiryHint : expiryHint }));
    } else if (paid || (payOnPoll && requests.length > 1)) {
      response.end(JSON.stringify({ op: "fund", funded_micro: 5_000_000, credit: {
        credit_id: body.credit_id, balance_micro: 5_000_000, remaining_micro: 5_000_000, spent_micro: 0,
        currency: "usd", status: "active", expires_at: Date.now() + 86400000,
      } }));
    } else {
      response.statusCode = 202;
      response.end(JSON.stringify({ status: "pending", fund_id: (body.fund as { fund_id: string }).fund_id,
        credit_id: body.credit_id, checkout: { url: link, expires_at: expiresAt } }));
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "checkout-caller-"));
  roots.push(root);
  writeFileSync(join(root, "btc-rate.json"), JSON.stringify({ rate: 100_000, timestamp: Date.now() }));
  requests = [];
  holdMenus = false;
  delaySecondMenu = false;
  firstMenuSeen = undefined;
  menuReplies = [];
  paid = expired = refunded = unavailable = payOnPoll = loseResponse = expireOnPoll = false;
  unavailableRetryable = false;
  unavailableCause = "permission_denied";
  stripeStatus = 403;
  expiryHint = ordinaryExpiryHint;
  expiresAt = Math.floor(Date.now() / 1000) + 3600;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  for (const directory of roots) rmSync(directory, { recursive: true, force: true });
});

async function fund(extra = ["--no-wait"], amount = "$5") {
  return execute(process.execPath, [binary, "credit", "fund", endpoint, "--rail", "stripe", "--amount", amount, ...extra], {
    env: { ...process.env, DVM_CONFIG_DIR: root, DVM_IDENTITY_KEY: "0d".repeat(32) }, timeout: 15000,
  }).then((result) => ({ ...result, code: 0 }), (error) => error as { stdout: string; stderr: string; code: number });
}
function journal() {
  const directory = join(root, "card-fundings");
  return existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8"))) : [];
}

it("hands off a durable link, resumes one fund id, and records the booked card credit", async () => {
  const first = await fund();
  expect(first.code, first.stdout + first.stderr).toBe(0);
  const output = JSON.parse(first.stdout);
  expect(output).toMatchObject({ status: "awaiting_payment", amount_micro: 5_000_000,
    relay: { copy_text: link, standalone: true }, checkout: { url: link, expires_at: expiresAt },
    next_step: expect.stringContaining("dvm credit fund") });
  expect(journal()).toMatchObject([{ creditId: output.credit_id, fundId: output.fund_id, amountMicro: 5_000_000,
    checkout: { expires_at: expiresAt } }]);
  expect(output.fund_id.length).toBeLessThanOrEqual(200);
  expect(requests[0].fund).toEqual({ method: "stripe", via: "checkout", fund_id: output.fund_id, amount_micro: 5_000_000 });
  expect(first.stdout).not.toContain('"sig"');
  expect(JSON.parse((await fund()).stdout).fund_id).toBe(output.fund_id);
  paid = true;
  const final = await fund();
  expect(final.code, final.stdout + final.stderr).toBe(0);
  expect(JSON.parse(final.stdout)).toMatchObject({ status: "funded", credit_id: output.credit_id, charged_micro: 5_000_000,
    credit: { credit_id: output.credit_id, remaining_micro: 5_000_000 } });
  expect(journal()).toEqual([]);
  expect(JSON.parse(readFileSync(join(root, "credits.json"), "utf8")).credits).toMatchObject([
    { creditId: output.credit_id, rail: "stripe", remainingMicro: 5_000_000 },
  ]);
  expect(new Set(requests.map((request) => JSON.stringify(request.fund))).size).toBe(1);
});

it("prints the link before polling with fresh signatures on the same fund block", async () => {
  payOnPoll = true;
  const run = await fund([]);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  const events = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
  expect(events.map((event) => event.status)).toEqual(["awaiting_payment", "funded"]);
  expect(requests).toHaveLength(2);
  expect(requests[0].fund).toEqual(requests[1].fund);
  expect(requests[0]).not.toEqual(requests[1]);
  expect(journal()).toEqual([]);
});

it("raises a below-minimum ask with an explicit explanation before payment", async () => {
  const run = await fund(["--no-wait"], "$1");
  expect(run.code, run.stdout + run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({ amount_micro: 5_000_000,
    display: expect.stringContaining("Raised the requested $1.00") });
});

it.each([false, true])("retires an expired checkout without recording credit (refunded: %s)", async (refund) => {
  await fund();
  expired = true;
  refunded = refund;
  const run = await fund();
  expect(run.code).toBe(1);
  expect(JSON.parse(run.stdout).error).toMatchObject({ code: "checkout_expired", display: expect.stringContaining("No credit was added") });
  const expectedHint = refund ? refundedExpiryHint : ordinaryExpiryHint;
  expect(JSON.parse(run.stdout).error.display).toBe(`The card checkout expired. No credit was added. ${expectedHint}`);
  expect(JSON.parse(run.stdout).error.hint).toBe(expectedHint);
  expect(JSON.parse(run.stdout).error.display).not.toContain("No payment was taken");
  expect(journal()).toEqual([]);
  const creditFile = join(root, "credits.json");
  expect(existsSync(creditFile) ? JSON.parse(readFileSync(creditFile, "utf8")).credits : []).toEqual([]);
});

it("names a terminal checkout failure's cause and another rail", async () => {
  unavailable = true;
  const run = await fund();
  expect(run.code).toBe(1);
  expect(JSON.parse(run.stdout).error).toMatchObject({ code: "checkout_unavailable", cause: "permission_denied",
    display: expect.stringContaining("Use another rail") });
  expect(journal()).toEqual([]);
});

it("resumes a paid session after the link expiry instead of starting a second checkout", async () => {
  expiresAt = Math.floor(Date.now() / 1000) - 60;
  const first = JSON.parse((await fund()).stdout);
  paid = true;
  const run = await fund();
  expect(run.code, run.stdout + run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({ status: "funded", fund_id: first.fund_id });
  expect(journal()).toEqual([]);
});

it("retains the original id when the first create response is lost", async () => {
  loseResponse = true;
  const lost = await fund();
  expect(lost.code).toBe(1);
  const original = journal()[0];
  expect(original).toMatchObject({ amountMicro: 5_000_000 });
  expect(original.checkout).toBeUndefined();
  const resumed = await fund();
  expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
  expect(JSON.parse(resumed.stdout)).toMatchObject({ fund_id: original.fundId, credit_id: original.creditId });
  expect(requests[0].fund).toEqual(requests.at(-1)!.fund);
});

it("puts pay-by-card before wallet setup when Lightning is unavailable", async () => {
  const run = await execute(process.execPath, [binary, "credit", "fund", endpoint, "--rail", "lightning", "--amount", "$5", "--over-trust"], {
    env: { ...process.env, DVM_CONFIG_DIR: root, DVM_IDENTITY_KEY: "0d".repeat(32) }, timeout: 15000,
  }).catch((error) => error as { stdout: string; stderr: string });
  const error = JSON.parse(run.stdout).error;
  expect(error.display).toContain("Pay by card");
  expect(error.hint.indexOf("Pay by card")).toBeLessThan(error.hint.indexOf("dvm wallet fund"));
  expect(requests).toEqual([]);
});

it("stops default polling at expiry with a structured terminal error", async () => {
  expiresAt = Math.floor(Date.now() / 1000) + 2;
  expireOnPoll = true;
  const started = Date.now();
  const run = await fund([]);
  expect(run.code).toBe(1);
  const events = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
  expect(events[0].status).toBe("awaiting_payment");
  expect(events.at(-1).error.code).toBe("checkout_expired");
  expect(Date.now() - started).toBeLessThan(6000);
  expect(journal()).toEqual([]);
});

it("refuses fractional-cent card amounts before creating a checkout", async () => {
  const run = await fund(["--no-wait"], "$5.000001");
  expect(run.code).toBe(1);
  expect(JSON.parse(run.stdout).error).toMatchObject({ code: "invalid_argument", display: "Card top-ups must be whole USD cents." });
  expect(requests).toEqual([]);
  expect(journal()).toEqual([]);
});

it("shares one payable session across simultaneous first card top-ups", async () => {
  holdMenus = true;
  const runs = await Promise.all([fund(), fund()]);
  for (const run of runs) expect(run.code, run.stdout + run.stderr).toBe(0);
  const outputs = runs.map((run) => JSON.parse(run.stdout));
  expect(outputs[0].fund_id).toBe(outputs[1].fund_id);
  expect(outputs[0].credit_id).toBe(outputs[1].credit_id);
  expect(new Set(requests.map((request) => JSON.stringify(request.fund))).size).toBe(1);
  expect(journal()).toHaveLength(1);
});

it("preserves deliberately separate credits during simultaneous card top-ups", async () => {
  holdMenus = true;
  const runs = await Promise.all([fund(["--no-wait", "--credit-id", "first"]), fund(["--no-wait", "--credit-id", "second"])]);
  for (const run of runs) expect(run.code, run.stdout + run.stderr).toBe(0);
  expect(new Set(runs.map((run) => JSON.parse(run.stdout).fund_id)).size).toBe(2);
  expect(journal()).toHaveLength(2);
});

it.each([[403, "permission_denied"], [404, "not_found"]])("keeps a paid checkout recoverable after Stripe read %s", async (status, cause) => {
  const original = JSON.parse((await fund()).stdout);
  paid = unavailable = true;
  stripeStatus = Number(status);
  unavailableCause = String(cause);
  const failed = await fund();
  expect(failed.code).toBe(1);
  expect(journal()).toMatchObject([{ fundId: original.fund_id, creditId: original.credit_id }]);
  const error = JSON.parse(failed.stdout).error;
  expect(error.display).toContain("unresolved");
  expect(error.hint).toContain("Re-run the same command");
  expect(error.hint).toContain("24 hours");
  expect(error.hint).toContain("refunds it to the card");
  expect(error.display + error.hint).not.toContain("another rail");
  unavailable = false;
  const repaired = await fund();
  expect(repaired.code, repaired.stdout + repaired.stderr).toBe(0);
  expect(JSON.parse(repaired.stdout)).toMatchObject({ status: "funded", fund_id: original.fund_id, credit_id: original.credit_id });
  expect(new Set(requests.map((request) => JSON.stringify(request.fund))).size).toBe(1);
  expect(journal()).toEqual([]);
});

it("resumes the returned command as the original named caller", async () => {
  const env = { ...process.env, DVM_CONFIG_DIR: root, DVM_IDENTITY_KEY: "0d".repeat(32) };
  await execute(process.execPath, [binary, "identity", "create", "secondary"], { env });
  const original = JSON.parse((await fund(["--no-wait", "--as", "secondary"])).stdout);
  const originalCaller = requests[0].pubkey;
  paid = true;
  const resumed = await execute("/bin/sh", ["-c", original.next_step.replace(/^dvm /, '"' + process.execPath + '" "' + binary + '" ') + " --no-wait"], { env, timeout: 15000 });
  expect(JSON.parse(resumed.stdout)).toMatchObject({ status: "funded", credit_id: original.credit_id, fund_id: original.fund_id });
  expect(requests.at(-1)!.pubkey).toBe(originalCaller);
  expect(journal()).toEqual([]);
  expect(original.next_step).toContain("--as secondary");
  expect(original.balance_command).toContain("--as secondary");
});

it.each([
  "The charge is being refunded to the card; the refund is still processing.",
  disputeLostExpiryHint,
])("does not claim a completed refund from expiry guidance: %s", async (hint) => {
  await fund();
  expired = true;
  expiryHint = hint;
  const run = await fund();
  const error = JSON.parse(run.stdout).error;
  expect(error.code).toBe("checkout_expired");
  expect(error.display).toBe(`The card checkout expired. No credit was added. ${hint}`);
  expect(error.display).not.toContain("No payment was taken");
  expect(error.hint).toBe(hint);
  expect(journal()).toEqual([]);
});

it("consistently resumes a retryable create error instead of switching rails", async () => {
  unavailable = unavailableRetryable = true;
  unavailableCause = "api_error";
  stripeStatus = 503;
  const failed = await fund();
  expect(failed.code).toBe(1);
  const error = JSON.parse(failed.stdout).error;
  expect(error.display).toContain("Re-run the same command");
  expect(error.hint).toContain("Re-run the same command");
  expect(error.display + error.hint).not.toContain("another rail");
  const original = journal()[0];
  unavailable = false;
  const resumed = await fund();
  expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
  expect(JSON.parse(resumed.stdout).fund_id).toBe(original.fundId);
  expect(new Set(requests.map((request) => JSON.stringify(request.fund))).size).toBe(1);
});

it("reports expiry without a recovery hint without inferring payment state", async () => {
  await fund();
  expired = true;
  expiryHint = undefined;
  const run = await fund();
  const error = JSON.parse(run.stdout).error;
  expect(error.display).toBe("The card checkout expired. No credit was added. Start a new top-up.");
  expect(error.display).not.toContain("No payment was taken");
  expect(error.hint).toBeUndefined();
  expect(journal()).toEqual([]);
});

it.each([false, true])("handles stale overlapping discovery after completion (explicit separate credit: %s)", async (explicit) => {
  const env = { ...process.env, DVM_CONFIG_DIR: root, DVM_IDENTITY_KEY: "0d".repeat(32) };
  await execute(process.execPath, [binary, "identity", "create", "secondary"], { env });
  holdMenus = delaySecondMenu = payOnPoll = true;
  const firstDiscovery = new Promise<void>((resolve) => { firstMenuSeen = resolve; });
  const first = fund(["--as", "secondary"]);
  await firstDiscovery;
  const overlapping = fund(["--as", "secondary", "--no-wait", ...(explicit ? ["--credit-id", "separate"] : [])]);
  const completed = await first;
  payOnPoll = false;
  menuReplies[1]();
  const late = await overlapping;
  expect(completed.code, completed.stdout + completed.stderr).toBe(0);
  const funded = JSON.parse(completed.stdout.trim().split("\n").at(-1)!);
  expect(funded.status).toBe("funded");
  if (explicit) {
    expect(late.code, late.stdout + late.stderr).toBe(0);
    expect(JSON.parse(late.stdout)).toMatchObject({ status: "awaiting_payment", credit_id: "separate" });
    expect(JSON.parse(late.stdout).fund_id).not.toBe(funded.fund_id);
    expect(new Set(requests.map((request) => JSON.stringify(request.fund))).size).toBe(2);
  } else {
    expect(late.code, late.stdout + late.stderr).toBe(1);
    const error = JSON.parse(late.stdout).error;
    expect(error.display).toContain("completed while this command was starting");
    expect(error.display).toContain(`dvm credit balance ${endpoint} --as secondary`);
    expect(error.display).toContain("Re-run");
    expect(new Set(requests.map((request) => JSON.stringify(request.fund))).size).toBe(1);
    expect(journal()).toEqual([]);
  }
  const rerun = await fund(["--as", "secondary", "--no-wait"]);
  expect(rerun.code, rerun.stdout + rerun.stderr).toBe(0);
  expect(JSON.parse(rerun.stdout).status).toBe("awaiting_payment");
  expect(JSON.parse(rerun.stdout).fund_id).not.toBe(funded.fund_id);
});
