import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { cpSync, createWriteStream, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  let phase = "provider startup";
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    assert.equal(manifest.dependencies["@dvmkit/sdk"], expectedSdkVersion);
    const ready = await receive("ready");
    const binary = join(packageRoot, "dist/dvm.js");
    for (const signed of [false, true]) {
      for (const capability of ["search", "browse"]) {
        const root = mkdtempSync(join(tmpdir(), "dvm-discovery-caller-"));
        roots.push(root);
        phase = "caller initialization";
        let callerPubkey;
        if (signed) {
          const initialized = await cli(binary, root, ["init"]);
          assert.equal(initialized.code, 0);
          callerPubkey = JSON.parse(initialized.stdout).identity.pubkey;
        }
        const endpoint = signed ? ready.authenticated : ready.anonymous;
        const before = await send("snapshot", "snapshot");
        await send("defer", "deferred");
        phase = "discovery timeout";
        const first = await cli(binary, root, [capability, ...(capability === "search" ? ["weather"] : []), "--endpoint", endpoint, "--timeout", "0.1"]);
        assert.equal(first.code, 1);
        assert.equal(first.stderr, "");
        const error = JSON.parse(first.stdout).error;
        assert.equal(error.code, "timeout");
        phase = "stored job access";
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
        phase = "job continuation";
        const resumed = await cli(binary, root, args);
        assert.equal(resumed.code, 0);
        assert.equal(resumed.stderr, "");
        const lines = resumed.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
        const output = lines.at(-1);
        assert.equal(output.event, "result");
        assert.equal(output.jobId, job.id);
        assert.equal(output.next_action, null);
        const complete = lines.find((line) => line.event === "message" && line.type === "complete");
        assert.ok(complete, "continuation must deliver the completed result");
        phase = "completion summary";
        assert.equal(complete.content.summary._source, "provider");
        assert.equal(typeof complete.content.summary.text, "string");
        const summary = JSON.parse(complete.content.summary.text);
        if (capability === "search") assert.equal(summary.query, "weather");
        else assert.deepEqual(summary.entries, []);
        phase = "recovery evidence";
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
    phase = "jobs-lock access recovery";
    const root = mkdtempSync(join(tmpdir(), "dvm-locked-caller-"));
    roots.push(root);
    writeFileSync(join(root, "config.json"), JSON.stringify({ credit: { posture: "off" }, feedback: { posture: "off" } }), { mode: 0o600 });
    const jobsFile = join(root, "jobs.json");
    writeFileSync(jobsFile, "[]", { mode: 0o600 });
    const holder = await holdJobsLock(packageRoot, jobsFile);
    let accepted;
    let access;
    const before = await send("snapshot", "snapshot");
    try {
      await send("defer", "deferred");
      accepted = await cli(binary, root, ["request", "--endpoint", `${ready.anonymous}/search`,
        "--data", JSON.stringify({ query: "locked", mode: "keyword", limit: 1 }), "--no-stream"]);
      assert.equal(accepted.code, 0);
      const output = JSON.parse(accepted.stdout);
      assert.equal(output.warnings[0].code, "local_job_state_unsaved");
      assert.match(output.warnings[0].hint, /dvm status/);
      assert.deepEqual(JSON.parse(readFileSync(jobsFile, "utf8")), []);
      const directory = join(root, "submission-evidence");
      access = readdirSync(directory).filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")))
        .find((record) => record.kind === "accepted_job_access");
      assert.ok(access, "accepted job access must survive outside the locked jobs file");
      assert.equal(access.job.id, output.jobId);
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) {
        const exited = new Promise((done) => holder.once("close", done));
        const timeout = setTimeout(() => holder.kill("SIGKILL"), 5_000);
        try {
          if (holder.connected) holder.send("release");
          await exited;
        } finally { clearTimeout(timeout); }
      }
    }
    await send("release", "released");
    const resumed = await cli(binary, root, ["status", access.job.id, "--messages"]);
    assert.equal(resumed.code, 0);
    const output = JSON.parse(resumed.stdout);
    assert.equal(output.status, "completed");
    assert.equal(output.next_action, null);
    assert.ok(output.messages.some((message) => message.type === "complete"));
    const saved = JSON.parse(readFileSync(jobsFile, "utf8"));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].jobToken, access.job.jobToken);
    assert.equal(saved[0].status, "completed");
    assert.equal(readdirSync(join(root, "submission-evidence")).filter((name) => name.endsWith(".json")).length, 0);
    const again = await cli(binary, root, ["status", access.job.id]);
    assert.equal(again.code, 0);
    assert.equal(JSON.parse(readFileSync(jobsFile, "utf8")).length, 1);
    assert.ok(!(accepted.stdout + accepted.stderr + resumed.stdout + resumed.stderr + again.stdout + again.stderr).includes(access.job.jobToken));
    const after = await send("snapshot", "snapshot");
    assert.equal(after.submissions.length - before.submissions.length, 1);
    assert.deepEqual(after.requests.slice(before.requests.length).filter((request) => request.method === "POST")
      .map((request) => request.path), ["/v1/job"]);
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
  if (failed || providerCode !== 0) throw new Error(`Installed discovery recovery fixture failed during ${phase}; diagnostics retained privately.`);
  console.log("installed discovery recovery ok: search/browse, anonymous/signed, exact timeout hints, jobs-lock recovery, no resubmission or payment");

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

async function holdJobsLock(packageRoot, jobsFile) {
  const child = spawn(process.execPath, ["-e", `
    const { createRequire } = require("node:module");
    const requirePackage = createRequire(process.argv[1]);
    const release = requirePackage("proper-lockfile").lockSync(process.argv[2], { realpath: false });
    process.on("message", () => { release(); process.exit(0); });
    process.send("locked");
  `, join(packageRoot, "package.json"), jobsFile], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await new Promise((done, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Jobs lock holder did not start")); }, 10_000);
    child.once("message", () => { clearTimeout(timeout); done(); });
    child.once("error", () => { clearTimeout(timeout); reject(new Error("Jobs lock holder unavailable")); });
    child.once("exit", () => { clearTimeout(timeout); reject(new Error("Jobs lock holder exited early")); });
  });
  return child;
}
