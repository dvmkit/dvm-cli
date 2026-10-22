import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { digest, readRuntimeArtifact } from "./runtime-artifact.mjs";
import { ConsumerProcessError, checkConsumer, installConsumer, runConsumer, runLauncher } from "./installed-consumer.mjs";

const temporaryRoot = mkdtempSync(join(tmpdir(), "dvm-runtime-"));
let stage = "archive integrity";
let server;
let fixtureFailed = false;
let lastCommand = null;
const reached = new Set();
try {
  const directory = resolve(process.argv[2] ?? ".artifacts/runtime");
  const metadata = readRuntimeArtifact(directory);
  stage = "consumer install and upgrade";
  const { consumer, installedPackage } = await installConsumer({
    archive: join(directory, metadata.archive), manifest: metadata, temporaryRoot,
  });
  checkConsumer("installed-metadata-check", () => {
    const installed = JSON.parse(readFileSync(join(installedPackage, "package.json"), "utf8"));
    assert.equal(installed.name, metadata.name);
    assert.equal(installed.version, metadata.version);
  });
  stage = "skill-resolution-command";
  const resolved = await runConsumer(process.execPath, ["-p", "require.resolve('@dvmkit/dvm-cli/skill')"], { cwd: consumer });
  stage = "skill-resolution-exit";
  assert.equal(resolved.status, 0);
  stage = "skill-resolution-path";
  assert.equal(realpathSync(resolved.stdout.trim()), realpathSync(join(installedPackage, "skills/dvm/SKILL.md")));
  for (const file of ["SKILL.md", "calling.md", "wallets.md", "credit.md", "recovery.md"]) {
    stage = "skill-content";
    assert.equal(digest(readFileSync(join(installedPackage, "skills", "dvm", file))), metadata.skills[file]);
  }
  const entry = readFileSync(join(installedPackage, "skills/dvm/SKILL.md"), "utf8");
  stage = "skill-entry-header";
  assert.match(entry, /^---\r?\n/u);
  stage = "skill-entry-name";
  assert.match(entry, /\nname: dvm\r?\n/u);
  stage = "skill-entry-routes";
  for (const file of ["calling.md", "wallets.md", "credit.md", "recovery.md"]) assert.ok(entry.includes(`](${file})`));
  const env = {
    ...Object.fromEntries(Object.keys(process.env).filter((key) => /^(DVM_|DVMKIT_|DVMCTL_)/u.test(key)).map((key) => [key, ""])),
    HOME: temporaryRoot, USERPROFILE: temporaryRoot,
    XDG_CONFIG_HOME: join(temporaryRoot, "xdg config"),
    DVM_CONFIG_DIR: join(temporaryRoot, "caller config with spaces"),
    DVM_IDENTITY_KEY: "", DVM_NWC: "", LANG: "C", LC_ALL: "C",
  };
  async function cli(command, args, status = 0) {
    const started = Date.now();
    lastCommand = {
      command: ["version", "help", "init", "unknown-job-status", "request", "status"].includes(command) ? command : "unknown",
      expected_exit: Number.isSafeInteger(status) ? status : null,
      actual_exit: null, termination: "unknown", elapsed_ms: 0, stderr_present: false, error_code: "unknown", error_name: "unknown", error_errno: "unknown",
    };
    const result = await runLauncher(consumer, args, env);
    const exit = result.exitStatus ?? result.status;
    lastCommand.actual_exit = Number.isSafeInteger(exit) ? exit : null;
    lastCommand.termination = ["spawn-error", "timeout", "output-limit", "nonzero-exit"].includes(result.termination)
      ? result.termination : result.status === 0 ? "success" : "unknown";
    lastCommand.elapsed_ms = Number.isSafeInteger(result.elapsedMs) && result.elapsedMs >= 0
      ? result.elapsedMs : Math.max(0, Date.now() - started);
    lastCommand.stderr_present = Boolean(result.stderr?.length);
    if (result.status !== 0 && typeof result.stdout === "string" && result.stdout.length <= 65_536) {
      try {
        const error = JSON.parse(result.stdout)?.error;
        const code = error?.code;
        if (["internal", "invalid_argument", "endpoint_unreachable", "unsupported_version", "auth_required", "job_access_required", "timeout"].includes(code)) lastCommand.error_code = code;
        if (code === "internal") {
          if (["Error", "TypeError", "RangeError", "SyntaxError", "SystemError"].includes(error.error_name)) lastCommand.error_name = error.error_name;
          if (["EACCES", "EBADF", "EBUSY", "EEXIST", "EINVAL", "EIO", "EISDIR", "EMFILE", "ENFILE", "ENOENT", "ENOSPC", "ENOTDIR", "ENOTEMPTY", "ENOTSUP", "EPERM", "EROFS"].includes(error.error_code)) lastCommand.error_errno = error.error_code;
        }
      } catch { /* Captured output remains private even when it is not JSON. */ }
    }
    assert.equal(fixtureFailed, false);
    assert.equal(result.status, status);
    assert.equal(result.stderr, "");
    return result.stdout;
  }
  stage = "version-command";
  const versionText = await cli("version", ["--version"]);
  stage = "version-value";
  assert.equal(versionText.trim(), metadata.version);
  stage = "help-command";
  const helpText = await cli("help", ["--help"]);
  stage = "help-usage";
  assert.match(helpText, /Usage: dvm/u);
  stage = "init-command";
  const initializedText = await cli("init", ["init"]);
  stage = "init-parse";
  const initialized = JSON.parse(initializedText);
  stage = "init-identity";
  assert.match(initialized.identity.pubkey, /^[a-f0-9]{64}$/u);
  stage = "unknown-job-command";
  const errorText = await cli("unknown-job-status", ["status", "unknown-runtime-job"], 1);
  stage = "unknown-job-parse";
  const error = JSON.parse(errorText).error;
  stage = "unknown-job-code";
  assert.equal(error.code, "job_access_required");
  stage = "unknown-job-message";
  assert.match(error.message, /not in the local store/u);
  stage = "unknown-job-hint";
  assert.match(error.hint, /--endpoint.*--job-token/u);
  stage = "fixture-create";
  let submitted;
  server = createServer((request, response) => {
    const route = `${request.method} ${request.url?.split("?")[0]}`;
    reached.add(route);
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      try {
        response.setHeader("content-type", "application/json");
        if (route === "GET /v1/info") {
          response.end(JSON.stringify({
            protocol_version: 1, name: "Runtime fixture", description: "Loopback free service",
            auth: ["secp256k1-schnorr-v2"],
            auth_audience: { dvm_id: "runtime-fixture", builder_pubkey: "00".repeat(32) },
            capabilities: { echo: { description: "Echo", input_schema: { type: "string" }, pricing: { max: { amount: 0, currency: "usd" } } } },
            payment: { methods: [] },
          }));
        } else if (route === "POST /v1/quote") {
          response.end(JSON.stringify({ upfront: { amount: 0, currency: "usd" }, description: "Free", shape: "fixed" }));
        } else if (route === "POST /v1/job") {
          submitted = JSON.parse(body);
          response.end(JSON.stringify({ job_id: "runtime-job", status: "processing" }));
        } else if (route === "GET /v1/job/runtime-job") {
          response.end(JSON.stringify({ status: "completed", summary: "runtime free result" }));
        } else if (route === "GET /v1/job/runtime-job/messages") {
          response.end(JSON.stringify({ messages: [] }));
        } else { response.statusCode = 404; response.end('{}'); }
      } catch {
        fixtureFailed = true;
        response.statusCode = 500;
        response.end('{"error":"runtime_fixture_failed"}');
      }
    });
  });
  stage = "fixture-listen";
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  stage = "request-command";
  const requestedText = await cli("request", ["request", "--no-stream", "--endpoint", endpoint, "--input", "runtime hello"]);
  stage = "request-parse";
  const requested = JSON.parse(requestedText);
  stage = "request-job-id";
  assert.equal(requested.jobId, "runtime-job");
  stage = "request-submitted-capability";
  assert.equal(submitted.capability, "echo");
  stage = "request-submitted-input";
  assert.equal(submitted.input, "runtime hello");
  stage = "status-command";
  const polledText = await cli("status", ["status", "runtime-job", "--timeout", "1"]);
  stage = "status-parse";
  const polled = JSON.parse(polledText);
  stage = "status-value";
  assert.equal(polled.status, "completed");
  stage = "status-summary";
  assert.equal(polled.summary, "runtime free result");
  stage = "status-source";
  assert.equal(polled.source, "provider");
  stage = "status-next-action";
  assert.equal(polled.next_action, null);
  stage = "route-info-assert";
  assert.ok(reached.has("GET /v1/info"));
  stage = "route-job-assert";
  assert.ok(reached.has("POST /v1/job"));
  stage = "route-status-assert";
  assert.ok(reached.has("GET /v1/job/runtime-job"));
  stage = "persisted-job-read";
  const savedJobs = readFileSync(join(env.DVM_CONFIG_DIR, "jobs.json"), "utf8");
  stage = "persisted-job-assert";
  assert.ok(savedJobs.includes("runtime-job"));
  console.log(`runtime ok: Node ${process.versions.node}, ${process.platform}/${process.arch}, install, upgrade, skill, launcher, JSON, free request/poll`);
} catch (error) {
  // Never echo captured npm/CLI text or exception stacks into public runner logs.
  const diagnostic = error instanceof ConsumerProcessError ? `; ${error.message}` : "";
  const facts = {
    command: lastCommand,
    routes: {
      info: reached.has("GET /v1/info"), quote: reached.has("POST /v1/quote"), job: reached.has("POST /v1/job"),
      status: reached.has("GET /v1/job/runtime-job"), messages: reached.has("GET /v1/job/runtime-job/messages"),
    },
    fixtureFailed,
  };
  console.error(`runtime failed: ${stage}${diagnostic}; facts=${JSON.stringify(facts)} (captured output withheld)`);
  process.exitCode = 1;
} finally {
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  try {
    rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  } catch {
    console.error("runtime failed: temporary-state cleanup (diagnostics withheld)");
    process.exitCode = 1;
  }
}
