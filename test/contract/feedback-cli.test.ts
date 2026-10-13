import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const configRoot = mkdtempSync(join(tmpdir(), "dvm-cli-feedback-wire-"));
const children = new Map<ChildProcess, Promise<unknown>>();
const receipt = {
  v: 1, job_id: "wire-job", dvm_id: "wire-provider", dvm: "Wire provider",
  capability: "echo", outcome: "completed", seq: 1, issued_at: 1,
  receipt_pubkey: "11".repeat(32), signature: "22".repeat(64), paid: { msats: 1000 },
  future_evidence: { retained: true },
};
let server: Server;
let platformUrl: string;
let envelope: Record<string, unknown>;
let refuse = false;

beforeAll(async () => {
  writeFileSync(join(configRoot, "jobs.json"), JSON.stringify([{
    id: "wire-job", endpoint: "https://provider.example", status: "completed", submittedAt: 1,
  }]));
  writeFileSync(join(configRoot, "receipts.jsonl"), JSON.stringify({ receipt }) + "\n");
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.setHeader("content-type", "application/json");
      if (refuse) {
        response.writeHead(400).end(JSON.stringify({ error: {
          code: "receipt_invalid", display: "Receipt signature is invalid.", hint: "Fetch a fresh receipt.",
        } }));
      } else {
        response.end(JSON.stringify({ id: "wire-feedback", created_at: "2026-09-26", job_id: "wire-job", dvm_id: "wire-provider", tier: "receipt_verified" }));
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  platformUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  const pending = [...children.entries()];
  for (const [child] of pending) child.kill("SIGKILL");
  await Promise.all(pending.map(([, completion]) => completion));
});

afterAll(async () => {
  await new Promise<void>((done, reject) => server.close((err) => err ? reject(err) : done()));
  rmSync(configRoot, { recursive: true, force: true });
});

it("parses the verdict flag and posts the endpoint-only receipt through the CLI", async () => {
  const result = await runCli();
  expect(result.code).toBe(0);
  expect(envelope).toMatchObject({ job_id: "wire-job", verdict: "down", body: "wrong output", receipt });
  expect(envelope).not.toHaveProperty("feedback_claim");
  expect(JSON.parse(result.stdout)).toMatchObject({ verdict: "down", tier: "receipt_verified" });
}, 30_000);

it("renders refused receipt prose with its existing provider provenance marker", async () => {
  refuse = true;
  const result = await runCli();
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error).toMatchObject({
    code: "receipt_invalid",
    display: { _source: "provider", text: "Receipt signature is invalid." },
    hint: { _source: "provider", text: "Fetch a fresh receipt." },
  });
}, 30_000);

function runCli(): Promise<{ stdout: string; code: number | null }> {
  const child = spawn(process.execPath, [join(root, "dist/dvm.js"), "feedback", "--job", "wire-job", "--verdict", "down", "wrong output"], {
    cwd: root,
    env: { ...process.env, DVM_CONFIG_DIR: configRoot, DVMKIT_PLATFORM_URL: platformUrl, DVM_IDENTITY_KEY: "12".repeat(32) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const completion = new Promise<{ stdout: string; code: number | null }>((done, reject) => {
    let stdout = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => stdout += chunk);
    child.stderr!.resume();
    child.on("error", reject);
    child.on("close", (code) => done({ stdout, code }));
  });
  children.set(child, completion);
  void completion.then(() => children.delete(child), () => children.delete(child));
  return completion;
}
