import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

const binary = resolve(import.meta.dirname, "../../dist/dvm.js");
const root = mkdtempSync(join(tmpdir(), "dvm-deadline-"));
const expires = Date.parse("2100-01-02T02:40:00Z");
let server: Server;
let endpoint: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    const type = request.url?.includes("/prompt") ? "prompt" : "payment-request";
    const expiry = request.url?.includes("malformed") ? 1e300 : request.url?.includes("past") ? 1 : expires;
    const content = type === "prompt"
      ? { id: "question", text: "Keep observing?", options: ["keep", "wait"], expires_at_ms: expiry }
      : { amount_msats: 5000, reason: "More observing", fiat_amount: { amount: 0.05, currency: "usd" }, expires_at_ms: expiry };
    response.end(JSON.stringify(request.url?.includes("/messages")
      ? { messages: [{ seq: 1, from: "provider", timestamp: "2030-01-01T00:00:00Z", type, content }] }
      : { status: "awaiting-input" }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  endpoint = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  rmSync(root, { recursive: true, force: true });
});

function run(job: string, flags: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    execFile(process.execPath, [binary, "messages", job, "--endpoint", endpoint, "--job-token", "ab".repeat(32), ...flags], {
      env: { ...process.env, DVM_CONFIG_DIR: root }, timeout: 15_000,
    }, (error, stdout, stderr) => done({ code: error ? Number(error.code) || 1 : 0, stdout, stderr }));
  });
}

it.each([
  { job: "prompt", type: "respond", verb: "Answer", flags: [] },
  { job: "prompt", type: "respond", verb: "Answer", flags: ["--no-stream"] },
  { job: "charge", type: "pay", verb: "Pay", flags: [] },
  { job: "charge", type: "pay", verb: "Pay", flags: ["--no-stream"] },
])("relays $job deadlines through built CLI JSON and human output with $flags", async ({ job, type, verb, flags }) => {
  const result = await run(job, flags);
  expect(result.code, result.stderr || result.stdout).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.messages[0].content.expires_at_ms).toBe(expires);
  expect(output.next_action).toMatchObject({ type, expires_at_ms: expires });
  const clause = new RegExp(`${verb} by 2100-01-02 02:40 UTC \\(in \\d+ days(?: \\d+ h)?\\), or the provider cancels the job\\.`);
  expect(output.next_action.display).toMatch(clause);
  expect(output.next_action.hint).toMatch(clause);
  if (type === "respond") expect(output.next_action.options).toEqual(["keep", "wait"]);

  const human = await run(job, [...flags, "--human"]);
  expect(human.code, human.stderr || human.stdout).toBe(0);
  const next = human.stderr.trimEnd().split("\n").at(-1);
  expect(next).toMatch(/^Next: /);
  expect(next).toMatch(clause);
  expect(next).not.toContain("job..");
  expect(next).toContain(type === "respond"
    ? 'dvm message prompt "<answer>" --type response --prompt-id question'
    : "dvm pay charge");
});

it.each(["prompt-malformed", "charge-malformed"])("reads %s through the built CLI without an internal error", async (job) => {
  const result = await run(job, ["--no-stream"]);
  expect(result.code, result.stderr || result.stdout).toBe(0);
  const action = JSON.parse(result.stdout).next_action;
  expect(action).not.toHaveProperty("expires_at_ms");
  expect(action.display).toBe(job.startsWith("prompt")
    ? 'The provider asks: Keep observing? Choices: "keep", "wait".'
    : "$0.05 USD (5 sats) — comparable to an API call");
  expect(action.hint).not.toMatch(/deadline|cancel/);
});

it.each(["prompt-past", "charge-past"])("directs %s to check status after expiry in JSON and human output", async (job) => {
  const result = await run(job, ["--no-stream"]);
  expect(result.code, result.stderr || result.stdout).toBe(0);
  const action = JSON.parse(result.stdout).next_action;
  for (const text of [action.display, action.hint]) {
    expect(text).toContain("has passed. The provider will probably cancel the job.");
    expect(text).toContain(`dvm status ${job}`);
    expect(text).not.toMatch(/waiting for your input|approval|dvm pay |dvm message /);
  }
  const human = await run(job, ["--no-stream", "--human"]);
  expect(human.code, human.stderr || human.stdout).toBe(0);
  expect(human.stderr.trimEnd().split("\n").at(-1)).toBe(`Next: ${job.startsWith("charge") ? "the provider's charge of " : ""}${action.display}`);
});
