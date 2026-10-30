import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function verifyDrawFunding(packageRoot, expectedSdkVersion) {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--fixture", packageRoot, expectedSdkVersion], {
    encoding: "utf8", env: process.env, timeout: 60_000,
  });
  if (result.error || result.status !== 0) {
    const diagnostics = mkdtempSync(join(tmpdir(), "dvm-draw-funding-diagnostics-"));
    writeFileSync(join(diagnostics, "fixture.log"), `${result.stdout ?? ""}${result.stderr ?? ""}`, { mode: 0o600 });
    throw new Error("Installed draw funding fixture failed; diagnostics retained privately.");
  }
  console.log(`installed draw funding ok: SDK ${expectedSdkVersion}; signed native balances, sequences, contradiction, legacy evidence absence`);
}

async function fixture(packageRoot, expectedSdkVersion) {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.dependencies["@dvmkit/sdk"], expectedSdkVersion);
  const root = mkdtempSync(join(tmpdir(), "dvm-draw-funding-"));
  process.env.DVM_CONFIG_DIR = root;
  const loader = join(packageRoot, ".draw-funding-fixture.mjs");
  writeFileSync(loader, 'export * from "@dvmkit/sdk/internal";\n');
  let sdk;
  try { sdk = await import(pathToFileURL(loader).href); }
  finally { rmSync(loader); }
  const binary = join(packageRoot, "dist", "dvm.js");
  const run = (args) => cli(binary, root, args);
  const caller = JSON.parse((await run(["init"])).stdout).identity.pubkey;
  const builderSecret = "11".repeat(32);
  const dvmId = "funding-fixture";
  const key = sdk.deriveReceiptKeypair(builderSecret, dvmId);
  const attestation = sdk.buildAttestation({ dvmId, slug: "funding", capabilities: ["work"],
    builderPubkey: sdk.receiptPubkeyFromSecret(builderSecret), receiptPubkey: key.pubkey,
    deployedAt: 1_700_000_000 });
  const builder = { pubkey: attestation.builder_pubkey, attestation,
    signature: sdk.signAttestation(attestation, builderSecret) };
  const configPath = join(root, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  writeFileSync(configPath, JSON.stringify({ ...config, credit: { posture: "suggest" }, feedback: { posture: "off" } }));
  let scenario;
  let submitted = 0;
  const unexpected = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/v1/info") {
      response.end(JSON.stringify({ protocol_version: 1, name: "Funding fixture", builder, receipts: true,
        auth: ["secp256k1-schnorr-v2"], auth_audience: { dvm_id: dvmId, builder_pubkey: builder.pubkey },
        capabilities: { work: { description: "Work" } } }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/quote") {
      response.end(JSON.stringify({ upfront: { amount: 0, currency: "usd" },
        description: "Prepaid work settles on completion." }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/job") {
      unexpected.push(request.url);
      response.writeHead(400).end("{}");
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { data } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (data.credit_id !== "credit-held" || data.pubkey !== caller || typeof data.draw_id !== "string") {
      response.writeHead(400).end('{"error":"unexpected_draw"}');
      return;
    }
    const jobId = `funded-job-${++submitted}`;
    const funding = sdk.signDrawFundingReceipt({ v: 1, kind: "credit_draw_funding", credit_id: "credit-held",
      job_id: jobId, draw_id: data.draw_id, fund_id: `payment-${submitted}`, payment_seq: 8,
      currency: "usd", funded_micro: 50_000, balance_after_micro: scenario.before - 100_000,
      ledger_seq: scenario.seq, issued_at: 1_789_300_000, caller_pubkey: caller,
      dvm_id: dvmId, dvm: "funding", receipt_pubkey: key.pubkey }, key.secret);
    const receipt = sdk.signReceipt({ v: 1, job_id: jobId, dvm_id: dvmId, dvm: "funding", capability: "work",
      outcome: "completed", reason: null, seq: submitted, issued_at: 1_789_300_000,
      requester_pubkey: caller, paid: { msats: 150_000, rail: "cashu", native_amount: 50,
        native_asset: "sat", tx_hash: null, mint: "https://mint.invalid" },
      result_hash: sdk.computeResultHash("Done", []), receipt_pubkey: key.pubkey,
      credit: { credit_id: "credit-held", draw_id: data.draw_id, amount: 150_000,
        balance_after: scenario.after, ledger_seq: scenario.seq } }, key.secret);
    response.end(JSON.stringify({ job_id: jobId, status: "completed", summary: "Done", receipt,
      ...(scenario.evidence ? { draw_funding_receipts: [funding] } : {}) }));
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    for (scenario of [
      { before: 500_000, after: 400_000, seq: 6, evidence: true, mismatch: false, expected: 400_000 },
      { before: 400_000, after: 300_000, seq: 7, evidence: true, mismatch: false, expected: 300_000 },
      { before: 500_000, after: 390_000, seq: 6, evidence: true, mismatch: true, expected: 400_000 },
      { before: 500_000, after: 400_000, seq: 6, evidence: false, mismatch: true, expected: 350_000 },
    ]) {
      rmSync(sdk.CREDITS_FILE, { force: true });
      sdk.recordFundResponse({ endpoint, identity: sdk.attestedDvmIdentity(builder), callerPubkey: caller,
        targetMicro: 500_000, credit: { credit_id: "credit-held", currency: "usd",
          remaining_micro: scenario.before, balance_micro: scenario.before, ledger_seq: scenario.seq - 1,
          expiry_ms: Date.now() + 86400000, expired: false, drainable: true } });
      const result = await run(["request", "--endpoint", endpoint, "--input", "Work", "--budget", "1000000"]);
      const output = JSON.parse(result.stdout);
      assert.equal(output.receipt_verified, "verified");
      const credit = sdk.loadCredit(endpoint, caller, sdk.attestedDvmIdentity(builder));
      assert.equal(credit.remainingMicro, scenario.after);
      assert.equal(credit.ledgerSeq, scenario.seq);
      assert.equal(result.stderr.includes("credit balance mismatch"), scenario.mismatch);
      if (scenario.mismatch) assert.equal(credit.discrepancy.expectedMicro, scenario.expected);
      else assert.equal(credit.discrepancy, undefined);
      const job = JSON.parse(readFileSync(sdk.JOBS_FILE, "utf8")).find((entry) => entry.id === output.jobId);
      assert.equal(job.drawFundingReceipts?.length ?? 0, scenario.evidence ? 1 : 0);
    }
    assert.deepEqual(unexpected, [], "receipt reconciliation must not fund or refresh balances");
    assert.equal(submitted, 4);
    assert.equal(sdk.loadBudgetLedger(sdk.BUDGET_FILE).entries.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}

function cli(binary, root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args], {
      env: { ...process.env, DVM_CONFIG_DIR: root }, stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`Fixture command exited ${code}`)));
  });
}

if (process.argv[2] === "--fixture") await fixture(process.argv[3], process.argv[4]);
