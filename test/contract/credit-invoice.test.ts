import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

const execute = promisify(execFile);
const binary = resolve(import.meta.dirname, "../../dist/dvm.js");
const roots: string[] = [];
let root: string;
let endpoint: string;
let server: Server;
let paid: boolean;
let invoiceTtl: number;
let loseResponse: boolean;
let requests: Array<Record<string, unknown>>;
const invoices = new Map<string, { creditId: string; amountMicro: number; bolt11: string; expiresAt: number }>();
const menu = {
  min_micro: 100_000, max_micro: 100_000_000, ttl_ms: 86400000,
  currency: "usd", funding: ["lightning"], lightning_min_micro: 100_000,
};

beforeAll(async () => {
  server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/info") {
      response.end(JSON.stringify({ name: "Invoice fixture", protocol_version: 1, auth: ["secp256k1-schnorr-v2"],
        auth_audience: { dvm_id: "invoice-fixture", builder_pubkey: "00".repeat(32) } }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    if (body.op === "balance") {
      response.end(JSON.stringify({ op: "balance", credits: [], menu }));
      return;
    }
    requests.push(body);
    const fund = body.fund as { fund_id: string; amount_micro: number; method: string };
    if (fund.method !== "lightning") {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "payment_invalid", message: "Expected Lightning funding." }));
      return;
    }
    let invoice = invoices.get(fund.fund_id);
    if (!invoice) {
      invoice = { creditId: String(body.credit_id), amountMicro: fund.amount_micro,
        bolt11: `lnbcrt1000n1invoice${invoices.size}`, expiresAt: Date.now() + invoiceTtl };
      invoices.set(fund.fund_id, invoice);
    }
    if (invoice.creditId !== body.credit_id || invoice.amountMicro !== fund.amount_micro) {
      response.statusCode = 409;
      response.end(JSON.stringify({ error: "funding_commitment_mismatch", message: "Funding intent changed." }));
      return;
    }
    if (loseResponse) {
      loseResponse = false;
      response.destroy();
      return;
    }
    if (paid) {
      response.end(JSON.stringify({ op: "fund", funded_micro: invoice.amountMicro, credit: {
        credit_id: invoice.creditId, balance_micro: invoice.amountMicro, remaining_micro: invoice.amountMicro,
        spent_micro: 0, currency: "usd", status: "active", expires_at: Date.now() + 86400000,
      } }));
      return;
    }
    response.statusCode = 402;
    response.end(JSON.stringify(Date.now() >= invoice.expiresAt
      ? { error: "lightning_invoice_expired", message: "Invoice expired without payment.", retryable: false }
      : { error: "lightning_settlement_pending", message: "Pay the invoice.", retryable: true,
        lightning: { invoice: invoice.bolt11, amount_msats: 100_000, payment_hash: "ab".repeat(32), expires_at_ms: invoice.expiresAt } }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "invoice-caller-"));
  roots.push(root);
  writeFileSync(join(root, "btc-rate.json"), JSON.stringify({ rate: 100_000, timestamp: Date.now() }));
  paid = loseResponse = false;
  invoiceTtl = 600_000;
  requests = [];
  invoices.clear();
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  for (const directory of roots) rmSync(directory, { recursive: true, force: true });
});

function command(extra: string[] = []) {
  return [binary, "credit", "fund", endpoint, "--rail", "lightning", "--invoice", "--amount", "$0.10", ...extra];
}
function env() {
  return { ...process.env, DVM_CONFIG_DIR: root, DVM_IDENTITY_KEY: "0d".repeat(32) };
}
function fund(extra: string[] = ["--no-wait"], invoice = true) {
  return execute(process.execPath, command(extra).filter((arg) => invoice || arg !== "--invoice"), { env: env(), timeout: 15000 })
    .then((result) => ({ ...result, code: 0 }), (error) => error as { stdout: string; stderr: string; code: number });
}
function store(): { pendingFundings: Array<Record<string, unknown>>; credits: Array<Record<string, unknown>> } {
  const path = join(root, "credits.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { pendingFundings: [], credits: [] };
}

function streamingFund() {
  const child = spawn(process.execPath, command(), { env: env(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let announced = false;
  let announce: (event: Record<string, unknown>) => void;
  let failAnnouncement: (error: Error) => void;
  const first = new Promise<Record<string, unknown>>((resolve, reject) => { announce = resolve; failAnnouncement = reject; });
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    if (!announced && stdout.includes("\n")) {
      announced = true;
      try { announce(JSON.parse(stdout.slice(0, stdout.indexOf("\n")))); }
      catch (error) { failAnnouncement(error as Error); }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on("error", (error) => failAnnouncement(error));
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (!announced) failAnnouncement(new Error(`No invoice printed: ${stdout} ${stderr}`));
      resolve({ code, stdout, stderr });
    });
  });
  return { child, first, result };
}

it("prints a durable invoice before payment and records only the DVM-confirmed credit", async () => {
  const run = streamingFund();
  try {
    const announcement = await run.first;
    expect(announcement).toMatchObject({ status: "awaiting_payment", rail: "lightning", amount_micro: 100_000,
      amount_msats: 100_000, amount_sats: 100, expires_at_ms: expect.any(Number), bolt11: expect.any(String) });
    expect(store().credits).toEqual([]);
    expect(store().pendingFundings).toMatchObject([{ creditId: announcement.credit_id, fundId: announcement.fund_id,
      bolt11: announcement.bolt11, lightningPaymentMode: "invoice" }]);
    paid = true;
    const result = await run.result;
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((event) => event.status)).toEqual(["awaiting_payment", "funded"]);
    expect(events[1]).toMatchObject({ credit_id: announcement.credit_id, fund_id: announcement.fund_id, funded_micro: 100_000 });
    expect(events[1]).not.toHaveProperty("wallet_debit_sats");
    expect(store().pendingFundings).toEqual([]);
    expect(store().credits).toMatchObject([{ creditId: announcement.credit_id, rail: "lightning", remainingMicro: 100_000 }]);
    expect(invoices.size).toBe(1);
    expect(new Set(requests.map((body) => JSON.stringify(body.fund))).size).toBe(1);
    expect(requests[0]).not.toEqual(requests[1]);
  } finally {
    run.child.kill();
    await run.result;
  }
}, 15000);

it("resumes the printed invoice after process termination without requesting a second invoice", async () => {
  const run = streamingFund();
  let original: Record<string, unknown>;
  try {
    original = await run.first;
  } finally {
    run.child.kill("SIGTERM");
    await run.result;
  }
  const resumed = await fund(["--no-wait"], false);
  expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
  expect(JSON.parse(resumed.stdout)).toMatchObject({ status: "awaiting_payment", credit_id: original.credit_id,
    fund_id: original.fund_id, bolt11: original.bolt11 });
  paid = true;
  const completed = await fund(["--no-wait"], false);
  expect(completed.code, completed.stdout + completed.stderr).toBe(0);
  expect(JSON.parse(completed.stdout)).toMatchObject({ status: "funded", credit_id: original.credit_id, fund_id: original.fund_id });
  expect(invoices.size).toBe(1);
  expect(new Set(requests.map((body) => JSON.stringify(body.fund))).size).toBe(1);
}, 15000);

it("returns structured expiry with no credit and no replacement invoice", async () => {
  invoiceTtl = 1000;
  const result = await fund([]);
  expect(result.code).not.toBe(0);
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  expect(events[0].status).toBe("awaiting_payment");
  expect(events.at(-1)).toMatchObject({ error: { code: "lightning_invoice_expired", credit_id: events[0].credit_id, fund_id: events[0].fund_id } });
  expect(store().credits).toEqual([]);
  expect(store().pendingFundings).toEqual([]);
  expect(invoices.size).toBe(1);
}, 15000);

it("recovers a payment after the locally recorded expiry without issuing a fresh intent", async () => {
  const first = await fund();
  expect(first.code, first.stdout + first.stderr).toBe(0);
  const original = JSON.parse(first.stdout);
  const recorded = store();
  recorded.pendingFundings[0].expiresAtMs = Date.now() - 1;
  writeFileSync(join(root, "credits.json"), JSON.stringify(recorded));
  paid = true;
  const result = await fund();
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "funded", fund_id: original.fund_id, credit_id: original.credit_id });
  expect(invoices.size).toBe(1);
});

it("recovers the same intent after the first invoice response is lost", async () => {
  loseResponse = true;
  const failed = await fund();
  expect(failed.code).not.toBe(0);
  const [pending] = store().pendingFundings;
  expect(pending).toMatchObject({ lightningPaymentMode: "invoice", fundId: expect.any(String) });
  const result = await fund();
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "awaiting_payment", fund_id: pending.fundId, credit_id: pending.creditId });
  expect(invoices.size).toBe(1);
});

it("renders a terminal QR for a human invoice handoff", async () => {
  const result = await fund(["--no-wait", "--human"]);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain("lnbcrt1000n1invoice0");
  expect(result.stderr).toMatch(/[▄█▀]/u);
  expect(result.stderr).toContain("Resume with:");
  expect(store().credits).toEqual([]);
});

it.each(["cashu", "stripe", "x402", "tempo"])("refuses --invoice with --rail %s before creating an intent", async (rail) => {
  const result = await fund(["--rail", rail]);
  expect(result.code).not.toBe(0);
  expect(JSON.parse(result.stdout).error.code).toBe("invalid_argument");
  expect(requests).toEqual([]);
  expect(store().pendingFundings).toEqual([]);
});
