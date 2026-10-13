import { rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import {
  deriveIdentityFromPrivkey,
  type JsonValue,
  receiptPubkeyFromSecret,
  signReceipt,
  verifyCanonicalSignedRequest,
} from "@dvmkit/sdk/internal";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const configRoot = mkdtempSync(join(tmpdir(), "dvm-cli-feedback-"));
  const previousConfigRoot = process.env.DVM_CONFIG_DIR;
  process.env.DVM_CONFIG_DIR = configRoot;
  return { configRoot, previousConfigRoot, info: vi.fn(), json: vi.fn() };
});
const output = fixture;
vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()) }));
vi.mock("../src/lib/output", async () => ({ ...(await vi.importActual<typeof import("../src/lib/output")>("../src/lib/output")), info: fixture.info,
json: fixture.json }));
let feedback: typeof import("../src/commands/feedback")["feedback"];
let notices: typeof import("../src/lib/feedback-notice");

let originalIdentityKey: string | undefined;
let originalPlatformUrl: string | undefined;

const configRoot = fixture.configRoot;
const requester = deriveIdentityFromPrivkey("12".repeat(32));
const other = deriveIdentityFromPrivkey("34".repeat(32));
const jobId = "feedback-job";
const receiptSecret = "56".repeat(32);
const receipt = signReceipt({
  v: 1,
  job_id: jobId,
  dvm_id: "registered-provider",
  dvm: "Example provider",
  capability: "report",
  outcome: "completed",
  reason: null,
  seq: 1,
  issued_at: 1_789_300_000,
  requester_pubkey: requester.pubkey,
  paid: {
    msats: 12_000,
    rail: "cashu",
    native_amount: null,
    native_asset: null,
    tx_hash: null,
    mint: "https://mint.example",
  },
  result_hash: null,
  receipt_pubkey: receiptPubkeyFromSecret(receiptSecret),
  ...{
    duration_ms: 125,
    future_signed_evidence: { steps: ["fetch", { count: 2 }], value: null },
  },
}, receiptSecret);

const requests: Record<string, unknown>[] = [];
let server: Server;
let platformUrl: string;
let refusal: string | undefined;
let tier: "receipt_verified" | "claimed" | null;

beforeAll(async () => {
  originalIdentityKey = process.env.DVM_IDENTITY_KEY;
  originalPlatformUrl = process.env.DVMKIT_PLATFORM_URL;
  process.env.DVM_CONFIG_DIR = configRoot;
  delete process.env.DVM_IDENTITY_KEY;
  ({ feedback } = await import("../src/commands/feedback"));
  notices = await import("../src/lib/feedback-notice");
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.setHeader("content-type", "application/json");
      if (request.url !== "/api/v1/feedback" || request.method !== "POST") {
        response.writeHead(404).end();
      } else if (refusal) {
        response.writeHead(400).end(JSON.stringify({ error: {
          code: refusal,
          message: "Feedback refused",
          display: `Display for ${refusal}`,
          hint: `Hint for ${refusal}`,
        } }));
      } else {
        response.end(JSON.stringify({
          id: "feedback-id",
          created_at: "2026-09-26T12:00:00.000Z",
          dvm_id: "registered-provider",
          job_id: jobId,
          tier,
        }));
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  platformUrl = `http://127.0.0.1:${address.port}`;
  process.env.DVMKIT_PLATFORM_URL = platformUrl;
});

beforeEach(() => {
  output.json.mockClear();
  output.info.mockClear();
  requests.length = 0;
  refusal = undefined;
  tier = "receipt_verified";
  writeFileSync(join(configRoot, "identities.json"), JSON.stringify({
    version: 1, identities: { requester, other },
  }));
  writeFileSync(join(configRoot, "config.json"), JSON.stringify({ defaultIdentity: "other" }));
  writeJob({ feedbackClaim: "routed-claim", traceId: "trace-context" });
  writeFileSync(join(configRoot, "receipts.jsonl"), `${JSON.stringify({
    receipt, endpoint: "https://provider.example", verification: "verified", verified_at: 1,
  })}\n`);
});

afterAll(async () => {
  await new Promise<void>((done, reject) => server.close((err) => err ? reject(err) : done()));
  rmSync(configRoot, { recursive: true, force: true });
  restoreEnv("DVM_CONFIG_DIR", fixture.previousConfigRoot);
  restoreEnv("DVM_IDENTITY_KEY", originalIdentityKey);
  restoreEnv("DVMKIT_PLATFORM_URL", originalPlatformUrl);
});

describe("receipt-backed feedback contract", () => {
  it("signs the unchanged stored receipt, verdict and routed context with the job identity", async () => {
    const result = await runCli(["--job", jobId, "--verdict", "down", "output was wrong"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      verdict: "down", tier: "receipt_verified", scope: "job", job_id: jobId,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      pubkey: requester.pubkey,
      job_id: jobId,
      body: "output was wrong",
      verdict: "down",
      feedback_claim: "routed-claim",
      feedback_endpoint_host: "provider.example",
      trace_id: "trace-context",
    });
    expect(requests[0].receipt).toEqual(receipt);
    const { signature, ...unsigned } = requests[0];
    expect(verifyCanonicalSignedRequest(unsigned as JsonValue, String(signature), requester.pubkey)).toBe(true);
    expect(verifyCanonicalSignedRequest({ ...unsigned, verdict: "up" } as unknown as JsonValue, String(signature), requester.pubkey)).toBe(false);
    expect(verifyCanonicalSignedRequest({ ...unsigned, receipt: { ...receipt, duration_ms: 126 } } as unknown as JsonValue, String(signature), requester.pubkey)).toBe(false);
  });

  it("rates an endpoint-only job without a claim, DVM id, or note", async () => {
    writeJob({});
    const result = await runCli(["--job", jobId, "--verdict", "up"]);
    expect(result.code).toBe(0);
    expect(requests[0]).toMatchObject({ job_id: jobId, verdict: "up", body: "", receipt });
    expect(requests[0]).not.toHaveProperty("dvm_id");
    expect(requests[0]).not.toHaveProperty("feedback_claim");
    expect(requests[0]).not.toHaveProperty("feedback_endpoint_host");
    expect(JSON.parse(result.stdout)).toMatchObject({ tier: "receipt_verified" });
  });

  it("rates from the job's stored receipt when the collection copy is unavailable", async () => {
    writeFileSync(join(configRoot, "receipts.jsonl"), "");
    writeJob({ receipt });
    const result = await runCli(["--job", jobId, "--verdict", "up"]);
    expect(result.code).toBe(0);
    expect(requests[0].receipt).toEqual(receipt);
    expect(requests[0].pubkey).toBe(requester.pubkey);
  });

  it("relays the unverified eligibility hint when only a router claim exists", async () => {
    writeFileSync(join(configRoot, "receipts.jsonl"), "");
    tier = "claimed";
    const result = await runCli(["--job", jobId, "--verdict", "down"]);
    expect(result.code).toBe(0);
    expect(requests[0]).not.toHaveProperty("receipt");
    expect(requests[0].feedback_claim).toBe("routed-claim");
    expect(JSON.parse(result.stdout)).toMatchObject({
      tier: "claimed",
      hint: "No receipt is stored for this job, so the verdict was recorded as an unverified claim and does not count toward the provider's public record.",
    });
  });

  it("refuses an endpoint-only job with neither a claim nor a receipt", async () => {
    writeFileSync(join(configRoot, "receipts.jsonl"), "");
    writeJob({});
    const result = await runCli(["--job", jobId, "--verdict", "up"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("platform_dvm_id_unavailable");
    expect(requests).toHaveLength(0);
  });

  it.each([
    [["--verdict", "up"], "verdict_requires_job"],
    [["--dvm", "provider", "--verdict", "down"], "verdict_requires_job"],
    [["--job", jobId, "--verdict", "sideways"], "invalid_argument"],
    [["--posture", "ask", "--verdict", "up"], "bad_arguments"],
    [["--job", jobId], "bad_arguments"],
  ])("rejects usage %j without posting", async (args, code) => {
    const result = await runCli(args);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe(code);
    expect(requests).toHaveLength(0);
  });

  it.each(["receipt_invalid", "receipt_mismatch", "unknown_dvm_identity", "verdict_requires_job"])(
    "relays platform refusal %s with its display and hint", async (code) => {
      refusal = code;
      const result = await runCli(["--job", jobId, "--verdict", "down"]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).error).toMatchObject({
        code,
        display: `Display for ${code}`,
        hint: `Hint for ${code}`,
      });
    }
  );

  it.each(["flag", "environment"])("warns before a receipt refusal with a different %s identity", async (choice) => {
    refusal = "receipt_mismatch";
    const result = await runCli(
      ["--job", jobId, "--verdict", "up", ...(choice === "flag" ? ["--as", "other"] : [])],
      choice === "environment" ? { DVM_IDENTITY_KEY: other.privkey } : {},
    );
    expect(result.code).toBe(1);
    expect(requests[0].pubkey).toBe(other.pubkey);
    expect(result.stderr).toContain("The selected identity differs from the job's requester. The platform will refuse this receipt.");
  });

  it("refuses when the job identity is unavailable instead of signing with the changed default", async () => {
    writeFileSync(join(configRoot, "identities.json"), JSON.stringify({ version: 1, identities: { other } }));
    const result = await runCli(["--job", jobId, "--verdict", "up"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("auth_required");
    expect(requests).toHaveLength(0);
  });

  it("keeps free-text job feedback on the current default when the receipt requester key was removed", async () => {
    writeFileSync(join(configRoot, "identities.json"), JSON.stringify({ version: 1, identities: { other } }));
    const result = await runCli(["--job", jobId, "free-text evaluation"]);
    expect(result.code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ pubkey: other.pubkey, body: "free-text evaluation", feedback_claim: "routed-claim" });
    expect(requests[0]).not.toHaveProperty("receipt");
    expect(requests[0]).not.toHaveProperty("verdict");
    expect(JSON.parse(result.stdout)).toMatchObject({ verdict: null, tier: null });
  });

  it("leaves a completed job's verdict to evaluation and offers a working free-text command", async () => {
    const nudge = notices.buildFeedbackNudge({
      code: "feedback_first_success", dvmId: "provider", jobId,
      approval: "ask", postureSource: "default",
    });
    expect(nudge.command).toBe(`dvm feedback --job ${jobId}`);
    const result = await runCli([...nudge.command.split(" ").slice(2), "evaluation without a verdict"]);
    expect(result.code).toBe(0);
    expect(requests[0]).toMatchObject({ body: "evaluation without a verdict", feedback_claim: "routed-claim" });
    expect(requests[0]).not.toHaveProperty("verdict");
  });

  it("suggests a down verdict for failed jobs and output that fell short", () => {
    const nudge = notices.buildFeedbackNudge({
      code: "feedback_job_failed", dvmId: "provider", jobId,
      approval: "ask", postureSource: "default",
    });
    expect(nudge.command).toBe(`dvm feedback --job ${jobId} --verdict down`);
    expect(notices.buildFeedbackHint(jobId)).toContain(`dvm feedback --job ${jobId} --verdict down`);
  });

  it.each([
    [[], {}],
    [["--dvm", "registered-provider"], { dvm_id: "registered-provider" }],
    [["--job", jobId], { job_id: jobId, feedback_claim: "routed-claim" }],
  ])("keeps free-text feedback %j without rating fields", async (args, expected) => {
    tier = null;
    const result = await runCli([...args, "free text"]);
    expect(result.code).toBe(0);
    expect(requests[0]).toMatchObject({ body: "free text", ...expected });
    expect(requests[0]).not.toHaveProperty("receipt");
    expect(requests[0]).not.toHaveProperty("verdict");
    expect(JSON.parse(result.stdout)).toMatchObject({ verdict: null, tier: null });
  });
});

function writeJob(fields: Record<string, unknown>) {
  writeFileSync(join(configRoot, "jobs.json"), JSON.stringify([{
    id: jobId, endpoint: "https://provider.example/path", dvmId: "provider",
    status: "completed", submittedAt: 1, ...fields,
  }]));
}

async function runCli(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const options: Record<string, string> = {};
  const body: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index].startsWith("--")) options[args[index].slice(2)] = args[++index];
    else body.push(args[index]);
  }
  const previousKey = process.env.DVM_IDENTITY_KEY;
  if (env.DVM_IDENTITY_KEY) process.env.DVM_IDENTITY_KEY = env.DVM_IDENTITY_KEY;
  try {
    await feedback(body, options);
    return { stdout: JSON.stringify(output.json.mock.calls.at(-1)?.[0]), stderr: output.info.mock.calls.map(([line]) => line).join("\n"), code: 0 };
  } catch (error) {
    return { stdout: JSON.stringify({ error }), stderr: output.info.mock.calls.map(([line]) => line).join("\n"), code: 1 };
  } finally {
    restoreEnv("DVM_IDENTITY_KEY", previousKey);
  }
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
