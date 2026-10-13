#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export async function verifyRefundRecovery(packageRoot, expectedSdkVersion) {
  const manifest = readJson(join(packageRoot, "package.json"));
  assert.equal(manifest.dependencies["@dvmkit/sdk"], expectedSdkVersion);
  const require = createRequire(join(packageRoot, "package.json"));
  const sdkManifest = require.resolve.paths("@dvmkit/sdk")
    .map((path) => join(path, "@dvmkit", "sdk", "package.json")).find(existsSync);
  assert.ok(sdkManifest, "installed SDK package not found");
  assert.equal(readJson(sdkManifest).version, expectedSdkVersion);

  const binary = join(packageRoot, "dist", "dvm.js");
  const configRoot = mkdtempSync(join(tmpdir(), "dvm-refund-recovery-"));
  const observed = [];
  const resolved = new Set();
  let loseResponse = true;
  let currentCreditId = "recovery-credit-0";
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/v1/info") {
      response.end(JSON.stringify({
        protocol_version: 1,
        name: "Recovery fixture",
        auth: ["secp256k1-schnorr-v2"],
        auth_audience: { dvm_id: "recovery-fixture", builder_pubkey: "00".repeat(32) },
        capabilities: {},
        payment: { methods: [] },
      }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/credit") {
      response.writeHead(404).end("{}");
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body.op === "balance") {
      currentCreditId = body.credit_id ?? currentCreditId;
      const credit = creditWire(currentCreditId, 750_000);
      response.end(JSON.stringify({
        op: "balance", credit, credits: [credit],
        menu: { funding: ["lightning"], min_micro: 100_000, max_micro: 5_000_000,
          lightning_min_micro: 100_000, currency: "usd", ttl_ms: 86_400_000 },
      }));
      return;
    }
    if (body.op !== "drain") {
      response.writeHead(400).end("{}");
      return;
    }
    observed.push({ creditId: body.credit_id, ...body.drain });
    // Accept the first refund, then lose its reply before the caller learns its ID.
    if (loseResponse) {
      loseResponse = false;
      response.destroy();
      return;
    }
    response.end(JSON.stringify({
      op: "drain", credit: creditWire(body.credit_id, 0),
      drain: {
        credit_id: body.credit_id, drain_id: body.drain.drain_id, method: body.drain.method,
        status: resolved.has(body.credit_id) ? "sent" : "pending",
        amount_micro: 750_000, currency: "usd", ledger_seq: 2,
        created_at: 1_700_000_000_000, receipts: [],
      },
    }));
  });

  try {
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const cli = (args) => runCli(binary, configRoot, args);
    const version = await cli(["--version"]);
    assert.equal(version.stdout.trim(), manifest.version);
    await cli(["init"]);
    const configBefore = readJson(join(configRoot, "config.json"));
    const expected = [];
    const drainArgs = (creditId, address) => [
      "credit", "drain", endpoint, "--credit-id", creditId,
      "--method", "x402", "--address", address,
    ];
    const pending = () => readJson(join(configRoot, "credits.json")).credits[0].pendingDrains ?? [];
    for (let index = 0; index < 10; index++) {
      const creditId = `recovery-credit-${index}`;
      const address = `0x${(index + 1).toString(16).padStart(40, "0")}`;
      await cli(["credit", "balance", endpoint, "--credit-id", creditId]);
      const result = await runCli(binary, configRoot, drainArgs(creditId, address), index === 0);
      if (index === 0) {
        assert.notEqual(result.code, 0, "lost response must reach the error boundary");
        assert.equal(typeof JSON.parse(result.stdout).error.code, "string");
      } else {
        assert.equal(JSON.parse(result.stdout).drain.status, "pending");
      }
      const saved = pending().find((drain) => drain.creditId === creditId);
      assert.ok(saved, "new refund descriptor must be persisted before the POST");
      assert.equal(saved.method, "x402");
      assert.deepEqual(saved.payout, { address });
      assert.equal(saved.drainId, observed.at(-1).drain_id);
      expected.push(saved);
    }
    assert.deepEqual(pending(), expected, "all ten descriptors must survive rollover and fresh-process reload");
    const list = JSON.parse((await cli(["credit", "list"])).stdout);
    const publicDrains = list.credits.flatMap((credit) => credit.pending_drains ?? []);
    assert.deepEqual(publicDrains, expected.map((drain) => ({
      drain_id: drain.drainId, credit_id: drain.creditId,
      method: "x402", requested_at_ms: drain.requestedAt,
    })), "the installed caller must list every descriptor without payout credentials");

    for (const drain of expected) {
      // A new payout argument must not replace the immutable saved destination.
      const result = JSON.parse((await cli(drainArgs(drain.creditId, `0x${"ff".repeat(20)}`))).stdout);
      assert.equal(result.drain.drain_id, drain.drainId);
      assert.equal(result.drain.status, "pending");
      assert.match(result.hint, /Re-run/);
      assert.deepEqual(observed.at(-1), {
        creditId: drain.creditId, drain_id: drain.drainId, method: "x402", payout: drain.payout,
      });
      assert.deepEqual(result.unclaimed_drains.map((entry) => entry.credit_id).sort(),
        expected.filter((other) => other.creditId !== drain.creditId).map((other) => other.creditId).sort());
    }
    assert.deepEqual(pending(), expected, "retry must retain every unresolved descriptor");

    const first = expected[0];
    resolved.add(first.creditId);
    const sent = JSON.parse((await cli(drainArgs(first.creditId, first.payout.address))).stdout);
    assert.equal(sent.drain.status, "sent");
    assert.equal(sent.drain.drain_id, first.drainId);
    assert.deepEqual(pending(), expected.slice(1), "terminal cleanup must remove only the resolved descriptor");
    const projection = readJson(join(configRoot, "credits.json")).credits[0];
    assert.equal(projection.creditId, expected.at(-1).creditId);
    assert.equal(projection.status, "active");
    assert.ok(isDeepStrictEqual(readJson(join(configRoot, "config.json")), configBefore),
      "recovery must preserve caller configuration and signing identity");
    console.log(`refund recovery ok: dvm ${manifest.version}, SDK ${expectedSdkVersion}, 10 drains, lost reply, rollover, retry, exact cleanup`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(configRoot, { recursive: true, force: true });
  }
}

function creditWire(creditId, remainingMicro) {
  return { credit_id: creditId, currency: "usd", balance_micro: remainingMicro,
    remaining_micro: remainingMicro, expiry_ms: 4_102_444_800_000, expired: false,
    drainable: remainingMicro > 0, ledger_seq: remainingMicro > 0 ? 1 : 2 };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function runCli(binary, configRoot, args, allowFailure = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [binary, ...args], {
      env: { ...process.env, DVM_CONFIG_DIR: configRoot, LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"], timeout: 20_000,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    // Keep diagnostics and signing material local, including on failed assertions.
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0 && !allowFailure) {
        let errorCode;
        try { errorCode = JSON.parse(stdout).error?.code; } catch { /* Non-JSON failures have no wire code. */ }
        reject(new Error(`recovery command ${args.slice(0, 2).join(" ")} exited ${code} (${errorCode ?? "no error code"})`));
      }
      else resolveRun({ code, stdout });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const packageRoot = resolve(process.argv[2] ?? ".");
  const manifest = readJson(resolve(import.meta.dirname, "../package.json"));
  await verifyRefundRecovery(packageRoot, manifest.dependencies["@dvmkit/sdk"]);
}
