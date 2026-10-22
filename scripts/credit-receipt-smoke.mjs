import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function verifyCreditReceiptRecovery(packageRoot, expectedSdkVersion) {
  assert.equal(readJson(join(packageRoot, "package.json")).dependencies["@dvmkit/sdk"], expectedSdkVersion);
  const loader = join(packageRoot, ".credit-receipt-sdk.mjs");
  writeFileSync(loader, `export { createSignedRequestVerifier } from "@dvmkit/sdk";
export { buildAttestation, signAttestation, deriveReceiptKeypair, receiptPubkeyFromSecret, signReceipt, computeResultHash } from "@dvmkit/sdk/internal";
`);
  let sdk;
  try { sdk = await import(pathToFileURL(loader).href); }
  finally { rmSync(loader); }

  for (const sample of [
    { currency: "usd", askMicro: 50_000, askMsats: 50_000, balanceAfter: 350_000 },
    { currency: "eur", askMicro: 50_001, askMsats: 55_557, balanceAfter: 349_999 },
  ]) await exerciseReceiptRecovery(packageRoot, sdk, sample);
  console.log("installed credit receipts ok: delayed request proof, status reconciliation, exact USD/EUR, payment-free read replay");
}

async function exerciseReceiptRecovery(packageRoot, sdk, sample) {
  const root = mkdtempSync(join(tmpdir(), "dvm-credit-receipt-"));
  const binary = join(packageRoot, "dist", "dvm.js");
  const secret = "01".repeat(32);
  const pubkey = sdk.receiptPubkeyFromSecret(secret);
  const builderSecret = "11".repeat(32);
  const builderPubkey = sdk.receiptPubkeyFromSecret(builderSecret);
  const dvmId = "receipt-service";
  const key = sdk.deriveReceiptKeypair(builderSecret, dvmId);
  const attestation = sdk.buildAttestation({ dvmId, slug: "receipt-service", capabilities: ["echo"],
    builderPubkey, receiptPubkey: key.pubkey, deployedAt: Math.floor(Date.now() / 1000) - 60 });
  const builder = { pubkey: builderPubkey, attestation, signature: sdk.signAttestation(attestation, builderSecret) };
  const audience = { dvm_id: dvmId, builder_pubkey: builderPubkey };
  const verifier = sdk.createSignedRequestVerifier({ _zod: {}, parse: (data) => data,
    safeParse: (data) => ({ success: true, data }) }, { replayStore: null });
  const jobId = `receipt-${sample.currency}`;
  const requestId = `request-${sample.currency}`;
  const creditId = `credit-${sample.currency}`;
  const menu = { funding: ["cashu"], currency: sample.currency, min_micro: 1000,
    max_micro: 5_000_000, ttl_ms: 86_400_000, balance_payment: true };
  const counters = { draws: 0, payments: 0, fundings: 0, balances: 0, jobReads: 0 };
  let drawId, signedReceipt;
  let published = false;
  const message = (seq, type, content) => ({ seq, type, content, from: "provider", timestamp: new Date().toISOString() });
  const completed = () => ({ job_id: jobId, status: "completed", summary: "Done", has_artifacts: false,
    ...(published ? { receipt: signedReceipt } : {}) });
  const creditWire = () => ({ credit_id: creditId, currency: sample.currency,
    balance_micro: 500_000, remaining_micro: 500_000, ledger_seq: 1,
    expiry_ms: Date.now() + 86_400_000, expired: false, drainable: true });
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const url = new URL(request.url, "http://fixture.example");
      const path = url.pathname;
      const reply = (status, value) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.method === "GET" && path === "/v1/info") {
        reply(200, { protocol_version: 1, name: "Receipt service", auth: ["secp256k1-schnorr-v2"],
          auth_audience: audience, receipts: true, builder, request_recovery: true,
          capabilities: { echo: { description: "Echo", pricing: { max: { amount: 0.10, currency: sample.currency } } } },
          credit: menu, payment: { methods: [] } });
      } else if (request.method === "POST" && path === "/v1/credit") {
        verifier.checkAuth(body, { audience, method: "POST", path, capability: null });
        if (body.op === "balance") {
          counters.balances++;
          reply(200, { op: "balance", credit: creditWire(), credits: [creditWire()], menu });
        } else {
          counters.fundings++;
          reply(400, { error: "unexpected_funding" });
        }
      } else if (request.method === "POST" && path === "/v1/job") {
        verifier.checkAuth(body.data, { audience, method: "POST", path, capability: "echo" });
        assert.equal(body.data.pubkey, pubkey);
        assert.equal(body.data.credit_id, creditId);
        assert.equal(body.data.request_id, requestId);
        assert.equal(body.data.fund, undefined);
        assert.equal(request.headers["x-cashu"], undefined);
        assert.equal(request.headers["payment-signature"], undefined);
        drawId = body.data.draw_id;
        assert.equal(typeof drawId, "string");
        counters.draws++;
        response.setHeader("DVM-Job-Identity-V1", jobId);
        reply(202, { job_id: jobId, status: "processing" });
      } else if (request.method === "POST" && path === `/v1/job/${jobId}/messages`) {
        const authorization = body.content.credit;
        verifier.checkAuth(authorization, { audience, method: "POST", path, capability: null });
        assert.equal(authorization.credit_id, creditId);
        assert.equal(authorization.draw_id, drawId);
        assert.equal(authorization.amount_micro, sample.askMicro);
        assert.equal(authorization.currency, sample.currency);
        counters.payments++;
        signedReceipt = sdk.signReceipt({ v: 1, job_id: jobId, dvm_id: dvmId, dvm: "Receipt service", capability: "echo",
          outcome: "completed", reason: null, seq: 1, issued_at: Math.floor(Date.now() / 1000), requester_pubkey: pubkey,
          paid: { msats: 100_000 + sample.askMsats, rail: "cashu", native_amount: null, native_asset: null, tx_hash: null, mint: null },
          result_hash: sdk.computeResultHash("Done", []), receipt_pubkey: key.pubkey,
          credit: { credit_id: creditId, draw_id: drawId, amount: 100_000 + sample.askMicro,
            balance_after: sample.balanceAfter, ledger_seq: 2 } }, key.secret);
        reply(201, { seq: 2 });
      } else if (request.method === "GET" && path === `/v1/job/${jobId}/messages`) {
        reply(200, { messages: counters.payments
          ? [message(3, "complete", { status: "success", summary: "Done" })]
          : [message(1, "payment-request", { amount_msats: sample.askMsats, reason: "Additional work",
            credit: { amount_micro: sample.askMicro, currency: sample.currency } })] });
      } else if (request.method === "GET" && path === `/v1/job/${jobId}`) {
        counters.jobReads++;
        reply(200, completed());
      } else if (request.method === "POST" && path === `/v1/request-result/${requestId}`) {
        verifier.checkAuth(body.data, { audience, method: "POST", path, capability: "echo" });
        response.setHeader("DVM-Job-Identity-V1", jobId);
        reply(200, { request_id: requestId, ...completed() });
      } else reply(404, { error: "not_found" });
    } catch {
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"error":"invalid_fixture_request"}');
    }
  });

  try {
    await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    // Only external exchange-rate responses are mocked; all provider traffic,
    // request signing, payment consent, receipt checks and state writes are real.
    const preload = join(root, "network.mjs");
    writeFileSync(preload, `const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === ${JSON.stringify(endpoint)}) return realFetch(input, init);
  if (url.hostname === "api.coingecko.com") return Promise.resolve(Response.json({ bitcoin: { usd: 100000, eur: 90000 }, "usd-coin": { usd: 1 } }));
  throw new Error("Unexpected external fetch");
};
`);
    const cli = (args) => runCli(binary, root, preload, secret, args);
    await cli(["init"]);
    const config = readJson(join(root, "config.json"));
    writeFileSync(join(root, "config.json"), JSON.stringify({ ...config, credit: { posture: "auto" }, feedback: { posture: "off" } }));
    await cli(["credit", "balance", endpoint]);
    const store = readJson(join(root, "credits.json"));
    store.credits[0].lastPriceMicro = 100_000;
    store.credits[0].targetMicro = 5_000_000;
    writeFileSync(join(root, "credits.json"), JSON.stringify(store));
    const listed = async () => JSON.parse((await cli(["credit", "list"])).stdout).credits[0];
    const requested = JSON.parse((await cli(["request", "--endpoint", endpoint, "--input", "work",
      "--request-id", requestId, "--auto-pay", "--budget", "1000000", "--auto-pay-below", "1000000", "--timeout", "15"])).stdout);
    assert.equal(requested.receipt_verified, "absent");
    assert.equal(requested.next_action, null);
    assert.equal(counters.jobReads, 1, "request makes exactly one best-effort receipt read");
    assert.equal(counters.payments, 1, "request must actually authorize the balance-paid ask");
    assert.equal((await listed()).remaining_micro, 500_000);
    const budgetBefore = snapshot(root, "budget.json");
    const walletBefore = snapshot(root, "agent-wallet.json");
    const jobBefore = readJson(join(root, "jobs.json"))[0];

    // Gate publication on request completion, making the race deterministic.
    published = true;
    const status = JSON.parse((await cli(["status", jobId])).stdout);
    assert.equal(status.receipt_verified, "verified");
    assert.equal(status.receipt.credit.balance_after, sample.balanceAfter);
    const balance = await listed();
    assert.equal(balance.remaining_micro, sample.balanceAfter);
    assert.equal(balance.currency, sample.currency);
    assert.equal(balance.ledger_seq, 2);
    assert.equal(counters.balances, 1, "status must not need a balance reconciliation request");
    for (const args of [["status", jobId], ["status", jobId, "--messages"],
      ["receipts", "show", jobId], ["receipts", "verify", jobId],
      ["request-result", requestId], ["request-result", requestId]]) await cli(args);
    assert.equal((await listed()).remaining_micro, sample.balanceAfter);
    assert.equal(counters.draws, 1);
    assert.equal(counters.payments, 1);
    assert.equal(counters.fundings, 0);
    assert.equal(counters.balances, 1);
    assert.equal(snapshot(root, "budget.json"), budgetBefore);
    assert.equal(snapshot(root, "agent-wallet.json"), walletBefore);
    const jobAfter = readJson(join(root, "jobs.json"))[0];
    for (const field of ["totalPaidMsats", "paymentsHonoured", "bookedCreditPayments", "creditBinding"])
      assert.deepEqual(jobAfter[field], jobBefore[field]);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    rmSync(root, { recursive: true, force: true });
  }
}

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function snapshot(root, name) {
  const path = join(root, name);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
function runCli(binary, root, preload, secret, args) {
  return new Promise((done, reject) => {
    const env = { ...process.env, HOME: root, DVM_CONFIG_DIR: root, DVM_IDENTITY_KEY: secret };
    delete env.DVM_JOB_ENDPOINT;
    delete env.DVM_JOB_TOKEN;
    const child = spawn(process.execPath, ["--import", preload, binary, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"], timeout: 25_000,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) done({ stdout });
      else {
        let errorCode;
        try { errorCode = JSON.parse(stdout).error?.code; } catch { /* Non-JSON failure. */ }
        reject(new Error(`receipt recovery command exited ${code} (${errorCode ?? "no error code"})`));
      }
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const manifest = readJson(resolve(import.meta.dirname, "../package.json"));
  await verifyCreditReceiptRecovery(resolve(process.argv[2] ?? "."), manifest.dependencies["@dvmkit/sdk"]);
}
