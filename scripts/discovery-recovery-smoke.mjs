import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { cpSync, createWriteStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export async function verifyDiscoveryRecovery(packageRoot, expectedSdkVersion) {
  const diagnosticsRoot = mkdtempSync(join(tmpdir(), "dvm-discovery-diagnostics-"));
  const diagnosticsPath = join(diagnosticsRoot, "fixture.log");
  const diagnostics = createWriteStream(diagnosticsPath, { mode: 0o600 });
  // Resolve the fixture's ESM imports from the installed dependency tree.
  const fixture = join(packageRoot, ".discovery-provider.mjs");
  cpSync(resolve(import.meta.dirname, "../test/support/discovery-provider.mjs"), fixture);
  const child = fork(fixture, {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout.pipe(diagnostics, { end: false });
  child.stderr.pipe(diagnostics, { end: false });
  const completion = new Promise((done) => child.once("close", (code) => {
    diagnostics.end(() => done(code));
  }));
  const roots = [];
  let failed = false;
  let providerCode;
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    assert.equal(manifest.dependencies["@dvmkit/sdk"], expectedSdkVersion);
    const ready = await receive("ready");
    const binary = join(packageRoot, "dist/dvm.js");
    for (const signed of [false, true]) {
      for (const capability of ["search", "browse"]) {
        const root = mkdtempSync(join(tmpdir(), "dvm-discovery-caller-"));
        roots.push(root);
        let callerPubkey;
        if (signed) {
          const initialized = await cli(binary, root, ["init"]);
          assert.equal(initialized.code, 0);
          callerPubkey = JSON.parse(initialized.stdout).identity.pubkey;
        }
        const endpoint = signed ? ready.authenticated : ready.anonymous;
        const before = await send("snapshot", "snapshot");
        await send("defer", "deferred");
        const first = await cli(binary, root, [capability, ...(capability === "search" ? ["weather"] : []), "--endpoint", endpoint, "--timeout", "0.1"]);
        assert.equal(first.code, 1);
        assert.equal(first.stderr, "");
        const error = JSON.parse(first.stdout).error;
        assert.equal(error.code, "timeout");
        const job = JSON.parse(readFileSync(join(root, "jobs.json"), "utf8")).at(-1);
        assert.equal(job.endpoint, endpoint);
        assert.equal(job.capability, capability);
        assert.equal(job.status, "submitted");
        assert.ok(job.messageCursor > 0);
        assert.match(job.jobToken, /^[0-9a-f]{64}$/i);
        const hint = /`(dvm messages [\w-]+ --wait)`/.exec(error.hint);
        assert.ok(hint, "timeout must advertise a continuation command");
        const args = hint[1].split(" ").slice(1);
        assert.deepEqual(args, ["messages", job.id, "--wait"]);
        await send("release", "released");
        const resumed = await cli(binary, root, args);
        assert.equal(resumed.code, 0);
        assert.equal(resumed.stderr, "");
        const output = JSON.parse(resumed.stdout);
        assert.equal(output.jobId, job.id);
        assert.equal(output.next_action, null);
        const complete = output.messages.find((message) => message.type === "complete");
        assert.ok(complete, "continuation must deliver the completed result");
        const summary = JSON.parse(complete.content.summary);
        if (capability === "search") assert.equal(summary.query, "weather");
        else assert.deepEqual(summary.entries, []);
        assert.equal(JSON.parse(readFileSync(join(root, "jobs.json"), "utf8")).at(-1).status, "completed");
        if (job.jobToken) assert.ok(!(first.stdout + first.stderr + resumed.stdout + resumed.stderr).includes(job.jobToken));
        const after = await send("snapshot", "snapshot");
        assert.equal(after.jobs.at(-1).pubkey, callerPubkey);
        assert.equal(after.submissions.length - before.submissions.length, 1);
        const requests = after.requests.slice(before.requests.length);
        assert.deepEqual(requests.filter((request) => request.method === "POST").map((request) => request.path), ["/v1/job"]);
        assert.ok(requests.every((request) => request.authenticated === signed));
      }
    }
  } catch (error) {
    // Provider spans and assertion details can contain raw routes and credentials.
    diagnostics.write(String(error.stack ?? error));
    failed = true;
  } finally {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      if (child.connected) child.send("shutdown");
      providerCode = await completion;
    } finally {
      clearTimeout(timeout);
      for (const root of roots) rmSync(root, { recursive: true, force: true });
      rmSync(fixture, { force: true });
    }
  }
  if (failed || providerCode !== 0) throw new Error("Installed discovery recovery fixture failed; diagnostics retained privately.");
  console.log("installed discovery recovery ok: search/browse, anonymous/signed, exact timeout hints, no resubmission or payment");

  function receive(type) {
    return new Promise((done, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("error", onFailure);
        child.off("close", onFailure);
      };
      const onFailure = () => {
        cleanup();
        reject(new Error("Discovery provider unavailable"));
      };
      const onMessage = (message) => {
        if (message.type !== type) return;
        cleanup();
        done(message);
      };
      const timeout = setTimeout(onFailure, 10_000);
      child.on("message", onMessage);
      child.once("error", onFailure);
      child.once("close", onFailure);
      if (child.exitCode !== null || child.signalCode !== null) onFailure();
    });
  }

  async function send(message, type) {
    const response = receive(type);
    if (child.connected) child.send(message);
    return response;
  }
}

function cli(binary, root, args) {
  return new Promise((done, reject) => {
    const env = { ...process.env, DVM_CONFIG_DIR: root };
    delete env.DVM_IDENTITY_KEY;
    delete env.DVM_JOB_ENDPOINT;
    delete env.DVM_JOB_TOKEN;
    const child = spawn(process.execPath, [binary, ...args], {
      env, stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => done({ code, stdout, stderr }));
  });
}
