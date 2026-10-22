import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { digest, readRuntimeArtifact } from "./runtime-artifact.mjs";
import { installConsumer, runConsumer, runLauncher } from "./installed-consumer.mjs";

const temporaryRoot = mkdtempSync(join(tmpdir(), "dvm-runtime-"));
let stage = "archive integrity";
let server;
let fixtureFailed = false;
try {
  const directory = resolve(process.argv[2] ?? ".artifacts/runtime");
  const metadata = readRuntimeArtifact(directory);
  stage = "consumer install and upgrade";
  const { consumer, installedPackage } = await installConsumer({
    archive: join(directory, metadata.archive), manifest: metadata, temporaryRoot,
  });
  const installed = JSON.parse(readFileSync(join(installedPackage, "package.json"), "utf8"));
  assert.equal(installed.name, metadata.name);
  assert.equal(installed.version, metadata.version);
  stage = "exported bundled skill";
  const resolved = await runConsumer(process.execPath, ["-p", "require.resolve('@dvmkit/dvm-cli/skill')"], { cwd: consumer });
  assert.equal(resolved.status, 0);
  assert.equal(realpathSync(resolved.stdout.trim()), realpathSync(join(installedPackage, "skills/dvm/SKILL.md")));
  for (const file of ["SKILL.md", "calling.md", "wallets.md", "credit.md", "recovery.md"]) {
    assert.equal(digest(readFileSync(join(installedPackage, "skills", "dvm", file))), metadata.skills[file]);
  }
  const entry = readFileSync(join(installedPackage, "skills/dvm/SKILL.md"), "utf8");
  assert.match(entry, /^---\r?\n/u);
  assert.match(entry, /\nname: dvm\r?\n/u);
  for (const file of ["calling.md", "wallets.md", "credit.md", "recovery.md"]) assert.ok(entry.includes(`](${file})`));
  const env = {
    ...Object.fromEntries(Object.keys(process.env).filter((key) => /^(DVM_|DVMKIT_|DVMCTL_)/u.test(key)).map((key) => [key, ""])),
    HOME: temporaryRoot, USERPROFILE: temporaryRoot,
    XDG_CONFIG_HOME: join(temporaryRoot, "xdg config"),
    DVM_CONFIG_DIR: join(temporaryRoot, "caller config with spaces"),
    DVM_IDENTITY_KEY: "", DVM_NWC: "", LANG: "C", LC_ALL: "C",
  };
  async function cli(args, status = 0) {
    const result = await runLauncher(consumer, args, env);
    assert.equal(fixtureFailed, false);
    assert.equal(result.status, status);
    assert.equal(result.stderr, "");
    return result.stdout;
  }
  stage = "npm launcher version and help";
  assert.equal((await cli(["--version"])).trim(), metadata.version);
  assert.match(await cli(["--help"]), /Usage: dvm/u);
  stage = "isolated initialization and JSON error";
  const initialized = JSON.parse(await cli(["init"]));
  assert.match(initialized.identity.pubkey, /^[a-f0-9]{64}$/u);
  const error = JSON.parse(await cli(["status", "unknown-runtime-job"], 1)).error;
  assert.equal(error.code, "job_access_required");
  assert.match(error.message, /not in the local store/u);
  assert.match(error.hint, /--endpoint.*--job-token/u);
  stage = "loopback free request and poll";
  const reached = new Set();
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
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const requested = JSON.parse(await cli(["request", "--no-stream", "--endpoint", endpoint, "--input", "runtime hello"]));
  assert.equal(requested.jobId, "runtime-job");
  assert.equal(submitted.capability, "echo");
  assert.equal(submitted.input, "runtime hello");
  const polled = JSON.parse(await cli(["status", "runtime-job", "--timeout", "1"]));
  assert.equal(polled.status, "completed");
  assert.equal(polled.summary, "runtime free result");
  assert.equal(polled.source, "provider");
  assert.equal(polled.next_action, null);
  for (const route of ["GET /v1/info", "POST /v1/job", "GET /v1/job/runtime-job"]) assert.ok(reached.has(route));
  assert.ok(readFileSync(join(env.DVM_CONFIG_DIR, "jobs.json"), "utf8").includes("runtime-job"));
  console.log(`runtime ok: Node ${process.versions.node}, ${process.platform}/${process.arch}, install, upgrade, skill, launcher, JSON, free request/poll`);
} catch {
  // Never echo captured npm/CLI text or exception stacks into public runner logs.
  console.error(`runtime failed: ${stage} (captured output withheld)`);
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
