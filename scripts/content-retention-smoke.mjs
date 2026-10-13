import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export async function verifyContentRetention(packageRoot, expectedSdkVersion) {
  // The fixture SDK writes route-shaped span diagnostics directly to stdout.
  // Isolate them from public gate output without changing CLI assertions or the
  // fail-closed CI sanitizer; retain complete diagnostics in a private file.
  const diagnosticsRoot = mkdtempSync(join(tmpdir(), "dvm-content-diagnostics-"));
  const diagnosticsPath = join(diagnosticsRoot, "fixture.log");
  const result = spawnSync(process.execPath, [
    fileURLToPath(import.meta.url), "--fixture", packageRoot, expectedSdkVersion,
  ], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  writeFileSync(diagnosticsPath, `${result.stdout ?? ""}${result.stderr ?? ""}`, { mode: 0o600, flag: "wx" });
  if (result.error || result.status !== 0) {
    throw new Error("Installed content retention fixture failed; diagnostics retained privately.");
  }
  console.log(`installed content retention ok: SDK ${expectedSdkVersion}; future/null/unavailable/legacy, cached offline outcome/receipt, status --messages, stream fallback, unchanged expiry/activity, local artifact save, portable/local saves`);
  return diagnosticsPath;
}

async function runContentRetentionFixture(packageRoot, expectedSdkVersion) {
  const loader = join(packageRoot, ".content-retention-service.mjs");
  writeFileSync(loader, `export { configureDVM } from "@dvmkit/sdk";
export { createDVMHost } from "@dvmkit/sdk/server";
export { MemoryJobStore } from "@dvmkit/sdk/testing";
export { computeResultHash, signReceipt, receiptPubkeyFromSecret } from "@dvmkit/sdk/internal";
`);
  let producer;
  try { producer = await import(pathToFileURL(loader).href); }
  finally { rmSync(loader); }
  const { configureDVM, createDVMHost, MemoryJobStore, computeResultHash, signReceipt, receiptPubkeyFromSecret } = producer;
  assert.equal(JSON.parse(readFileSync(join(packageRoot, "package.json"))).dependencies["@dvmkit/sdk"], expectedSdkVersion);
  const root = mkdtempSync(join(tmpdir(), "dvm-content-observation-"));
  const binary = join(packageRoot, "dist", "dvm.js");
  const token = "ab".repeat(32);
  const store = new MemoryJobStore();
  const activity = Date.now();
  const deadline = activity + 730 * 86_400_000;
  const base = { tags: [], capability: "work", input: "private input", params: {}, requesterId: "dev-anonymous", requesterTokenHash: createHash("sha256").update(token).digest("hex"), status: "completed", summary: "saved outcome", messages: [], seq: 0, paidMsats: 0, receivedProofs: [], stepCache: [], state: {}, createdAt: activity, lastActivityAt: activity };
  for (const id of ["future", "held", "redacted", "batch"]) {
    await store.save({ ...base, id, seq: 2, messages: [
      { seq: 1, from: "provider", timestamp: new Date(activity).toISOString(), type: "artifact", content: { name: "result.txt", mime_type: "text/plain", data: "saved artifact" } },
      { seq: 2, from: "provider", timestamp: new Date(activity).toISOString(), type: "complete", content: { summary: "saved outcome" } },
    ] });
  }
  await store.mutateContentHold("held", { action: "placed", purpose: "support", actor: "test-actor", reason: "temporary review", at: activity, review_due_at: activity + 86_400_000 });
  // The provider's real redaction operation must erase raw content independently
  // of the caller's durable local outcome. Seed a signed receipt to pin evidence.
  const secret = "11".repeat(32);
  const receiptFor = (jobId) => signReceipt({ v: 1, job_id: jobId, dvm_id: "content-service", dvm: "Content service", capability: "work", outcome: "completed", reason: null, seq: 1, issued_at: Math.floor(activity / 1000), requester_pubkey: null, paid: { msats: 0, rail: null, native_amount: null, native_asset: null, tx_hash: null, mint: null }, result_hash: computeResultHash("saved outcome", []), receipt_pubkey: receiptPubkeyFromSecret(secret) }, secret);
  const receipt = receiptFor("redacted");
  await store.saveReceipt("redacted", receipt);
  assert.equal(await store.redactJob({ jobId: "redacted", expectedLastActivityAt: activity, redactedAt: activity }), true);
  const host = createDVMHost({ env: {}, devMode: true, jobStore: store });
  host.mount(configureDVM({ name: "content acceptance", capability: "work", onJob(ctx) { ctx.complete("ok"); } }));
  const service = await host.serve({ port: 0 });
  let proxy;
  try {
    const args = (verb, id, extra = []) => [verb, id, ...extra, "--endpoint", service.url];
    const run = (argv) => cli(binary, root, token, argv);
    for (const [id, expiry, available] of [["future", deadline, true], ["held", null, true], ["redacted", deadline, false]]) {
      for (const verb of ["status", "messages"]) {
        const output = JSON.parse((await run(args(verb, id, verb === "messages" ? ["--no-stream"] : []))).stdout);
        assert.equal(output.content_expires_at, expiry);
        assert.equal(output.content_available, available);
        assert.equal(output.content_metadata_source, "provider");
        assert.equal(output.content_metadata_known, true);
        assert.equal(JSON.stringify(output).includes("temporary review"), false);
        if (id === "redacted" && verb === "status") {
          assert.equal(output.status, "completed");
          assert.equal(output.receipt.job_id, "redacted");
          assert.equal(output.receipt_verified, "verified_unattested");
          assert.equal(output.summary, undefined);
        }
        if (id === "redacted" && verb === "messages") assert.equal(output.messages.length, 0);
      }
      const human = await run(args("status", id, ["--human"]));
      assert.ok((human.stdout + human.stderr).includes(expiry === null ? "No automatic content expiry" : new Date(expiry).toISOString()));
      if (!available) assert.match(human.stdout + human.stderr, /Provider content is unavailable/);
      assert.equal((await store.get(id)).lastActivityAt, activity);
    }
    const portableArgs = ["--endpoint", service.url, "--job-token", token];
    const portableStatus = await cli(binary, root, undefined, ["status", "future", ...portableArgs]);
    const portableHint = JSON.parse(portableStatus.stdout).content_hint;
    for (const option of ["--endpoint", "--job-token", "DVM_JOB_ENDPOINT", "DVM_JOB_TOKEN"]) {
      assert.ok(portableHint.includes(option), "portable save guidance must retain original access");
    }
    assert.equal((portableStatus.stdout + portableStatus.stderr).includes(token), false);
    const portableSave = await cli(binary, root, undefined, ["messages", "future", "--no-stream", ...portableArgs]);
    const outputPath = join(root, "messages.json");
    writeFileSync(outputPath, portableSave.stdout);
    assert.equal(JSON.parse(readFileSync(outputPath)).messages[0].content.data, "saved artifact");
    assert.equal((portableSave.stdout + portableSave.stderr).includes(token), false);
    const localCompletion = { summary: "saved outcome", hasArtifacts: true, artifactCount: 1, payloadIn: "messages" };
    writeFileSync(join(root, "jobs.json"), JSON.stringify([{ id: "future", endpoint: service.url, jobToken: token, status: "completed", submittedAt: activity, completion: localCompletion }]));
    const localStatus = JSON.parse((await cli(binary, root, undefined, ["status", "future"])).stdout);
    assert.equal(localStatus.source, "local");
    const localSave = await cli(binary, root, undefined, ["messages", "future", "--no-stream"]);
    writeFileSync(outputPath, localSave.stdout);
    assert.equal(JSON.parse(readFileSync(outputPath)).messages[0].content.data, "saved artifact");
    assert.equal((localSave.stdout + localSave.stderr).includes(token), false);
    const batch = JSON.parse((await run(args("status", "batch", ["--messages"]))).stdout);
    assert.equal(batch.content_expires_at, deadline);
    assert.equal(batch.messages[0].type, "artifact");
    const streamed = JSON.parse((await run(args("messages", "future", ["--after", "0"]))).stdout);
    assert.equal(streamed.content_expires_at, deadline);
    assert.equal(streamed.messages[0].type, "artifact");
    assert.equal((await store.get("future")).lastActivityAt, activity);
    const saved = await run(args("messages", "future", ["--no-stream", "--human", "--after", "0"]));
    assert.match(saved.stdout + saved.stderr, /result.txt/);
    const artifactPath = (saved.stdout + saved.stderr).match(/→ ([^\n)]+)/)?.[1];
    assert.ok(artifactPath, "human output must report its saved artifact path");
    assert.equal(readFileSync(artifactPath, "utf8"), "saved artifact");
    rmSync(dirname(artifactPath), { recursive: true });
    // Legacy wire service and failed metadata observation remain compatible with
    // successfully retrieved message batches, including SSE's JSON fallback.
    proxy = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url.includes("/messages")) response.end(JSON.stringify({ messages: [{ seq: 1, from: "provider", timestamp: new Date(activity).toISOString(), type: "complete", content: { summary: "legacy result" } }] }));
      else if (request.url.includes("hanging")) return;
      else if (request.url.includes("broken")) response.destroy();
      else response.end(JSON.stringify({ status: "completed", summary: "legacy result" }));
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${proxy.address().port}`;
    for (const [verb, id, extra] of [["status", "legacy", []], ["messages", "legacy", ["--no-stream"]], ["messages", "broken", ["--no-stream"]], ["messages", "broken", []], ["messages", "hanging", ["--no-stream", "--timeout", "0.05"]]]) {
      const output = JSON.parse((await run([verb, id, ...extra, ...(verb === "messages" ? ["--after", "0"] : []), "--endpoint", endpoint])).stdout);
      assert.equal(output.content_metadata_known, false);
      assert.equal(output.content_metadata_source, id === "broken" || id === "hanging" ? "unknown" : "provider");
      assert.equal(output.content_expires_at, undefined);
      assert.equal(output.content_available, undefined);
      if (verb === "messages") assert.equal(output.messages[0].type, "complete");
    }
    const retainedCompletion = { summary: "saved outcome", hasArtifacts: true, artifactCount: 1, payloadIn: "messages" };
    writeFileSync(join(root, "jobs.json"), JSON.stringify([{ id: "redacted", endpoint: service.url, jobToken: token, status: "completed", submittedAt: activity, receipt, completion: retainedCompletion }]));
    const redactedRead = JSON.parse((await cli(binary, root, undefined, ["status", "redacted", "--messages"])).stdout);
    assert.equal(redactedRead.summary, undefined);
    assert.equal(redactedRead.content_available, false);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "jobs.json")))[0].completion, retainedCompletion);
    const retained = JSON.parse((await cli(binary, root, undefined, ["status", "redacted"])).stdout);
    assert.equal(retained.summary, "saved outcome");
    assert.equal(retained.content_metadata_source, "unknown");
    writeFileSync(join(root, "jobs.json"), JSON.stringify([{ id: "cached", endpoint: "http://127.0.0.1:1", status: "completed", submittedAt: activity, receipt: receiptFor("cached"), completion: { summary: "saved outcome", content_expires_at: null, content_available: true } }]));
    writeFileSync(join(root, "budget.json"), JSON.stringify({ caps: {}, entries: [{ timestamp: activity - 100 * 86_400_000, jobId: "old-spend", providerEndpoint: "https://service.example", msats: 1000, btcRate: 100000, usd: 0.001 }] }));
    const history = JSON.parse((await cli(binary, root, undefined, ["wallet", "history"])).stdout);
    assert.equal(history.entries[0].job_id, "old-spend");
    assert.equal(history.window.retention_days, null);
    assert.equal(history.display.includes("32 days"), false);
    const cached = JSON.parse((await cli(binary, root, undefined, ["status", "cached"])).stdout);
    assert.equal(cached.summary, "saved outcome");
    assert.equal(cached.receipt_verified, "verified_unattested");
    assert.equal(cached.receipt.job_id, "cached");
    assert.equal(cached.source, "local");
    assert.equal(cached.content_metadata_source, "unknown");
    assert.equal(cached.content_expires_at, undefined);
    assert.equal(cached.content_available, undefined);
    console.log(`installed content retention ok: SDK ${expectedSdkVersion}; future/null/unavailable/legacy, cached offline outcome/receipt, status --messages, stream fallback, unchanged expiry/activity, local artifact save`);
  } finally {
    if (proxy) { proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); }
    await service.close();
    // Keep cleanup local to the acceptance state, never a user's caller state.
    rmSync(root, { recursive: true, force: true });
  }
}

function cli(binary, root, token, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args], { env: { ...process.env, HOME: root, DVM_CONFIG_DIR: root, DVM_JOB_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`caller failed (${code}): ${stderr || stdout}`)));
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url && process.argv[2] === "--fixture") {
  await runContentRetentionFixture(process.argv[3], process.argv[4]);
}
