import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

const binary = resolve(import.meta.dirname, "../../dist/dvm.js");
const root = mkdtempSync(join(tmpdir(), "dvm-endpoint-contract-"));
const execute = promisify(execFile);
const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
const capabilities = { ask: { pricing: { max: { amount: 0, currency: "usd" } } }, summarize: {} };
let endpoint: string;
let server: Server;

async function run(args: string[], expectedExit = 0) {
  const result = await execute(process.execPath, [binary, ...args], {
    env: { ...process.env, DVM_CONFIG_DIR: root }, timeout: 15_000,
  }).then((result) => ({ ...result, code: 0 }), (error) => error as { stdout: string; stderr: string; code: number });
  expect(result.code, result.stdout + result.stderr).toBe(expectedExit);
  return result;
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const path = new URL(request.url!, "http://provider.invalid").pathname;
    requests.push({ method: request.method!, path, body });
    const route = path.replace(/^\/nested(?=\/)/, "");
    response.setHeader("content-type", "application/json");
    if (route === "/v1/info") {
      response.end(JSON.stringify({ protocol_version: 1, name: "Endpoint fixture",
        capabilities: path.startsWith("/nested/") ? { ask: capabilities.ask } : capabilities,
        payment: { methods: [] } }));
    } else if (request.method === "POST" && route === "/v1/quote") {
      response.end(JSON.stringify({ upfront: { amount: 0, currency: "usd" }, description: "Free quote" }));
    } else if (request.method === "POST" && route === "/v1/job") {
      response.statusCode = 202;
      response.end(JSON.stringify({ job_id: "endpoint-job", job_token: "ab".repeat(32), status: "processing" }));
    } else if (request.method === "GET" && route === "/v1/job/endpoint-job") {
      if (request.headers["x-job-token"] !== "ab".repeat(32)) {
        response.statusCode = 403;
        response.end("{}");
      } else response.end(JSON.stringify({ status: "processing" }));
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await run(["init"]);
  writeFileSync(join(root, "btc-rate.json"), JSON.stringify({ rate: 100_000, timestamp: Date.now() }));
  writeFileSync(join(root, "favorites.json"), JSON.stringify({ fixture: { endpoint: `${endpoint}/nested`, addedAt: 1 } }));
  const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
  writeFileSync(join(root, "config.json"), JSON.stringify({ ...config, feedback: { posture: "off" } }));
});

beforeEach(() => { requests.length = 0; });

afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

it.each(["ask", "summarize"])("quotes the selected %s capability at the resolved base", async (capability) => {
  const result = await run(["quote", "--endpoint", `${endpoint}/${capability}`, "--input", "hello"]);
  expect(JSON.parse(result.stdout)).toMatchObject({ upfront: { amount: 0, currency: "usd" } });
  expect(requests.map(({ path }) => path)).toEqual([`/${capability}/v1/info`, "/v1/info", "/v1/quote"]);
  expect(requests[2].body).toMatchObject({ capability, input: "hello" });
});

it.each(["quote", "request", "describe"])("reports an unknown URL capability from %s with marked choices", async (command) => {
  const args = command === "describe" ? [command, `${endpoint}/missing`]
    : [command, "--endpoint", `${endpoint}/missing`, "--input", "hello"];
  const result = JSON.parse((await run(args, 1)).stdout);
  expect(result.error).toMatchObject({ code: "unknown_capability", available_capabilities: ["ask", "summarize"],
    _provider_fields: ["available_capabilities"] });
  expect(result.error.hint).toContain(`${endpoint}/ask`);
  expect(result.error.hint).not.toContain("search");
  expect(requests.every(({ method }) => method === "GET")).toBe(true);
});

it("offers a runnable URL retry for an ambiguous endpoint", async () => {
  const result = JSON.parse((await run(["quote", "--endpoint", endpoint, "--input", "hello"], 1)).stdout);
  expect(result.error).toMatchObject({ code: "ambiguous_capability", available_capabilities: ["ask", "summarize"] });
  expect(result.error.hint).not.toContain("search");
  const retry = /`(dvm quote [^`]+)`/.exec(result.error.hint)?.[1];
  expect(retry).toBe(`dvm quote --endpoint ${endpoint}/ask --data '{}'`);
  const quoted = JSON.parse((await run(["quote", "--endpoint", `${endpoint}/ask`, "--data", "{}"])).stdout);
  expect(quoted.upfront).toEqual({ amount: 0, currency: "usd" });
});

it("describes a capability URL using its base and prints capability-specific examples", async () => {
  const result = JSON.parse((await run(["describe", `${endpoint}/ask`])).stdout);
  expect(result.endpoint).toBe(endpoint);
  expect(Object.keys(result.capabilities)).toEqual(["ask", "summarize"]);
  expect(result._provider_fields).toContain("capabilities");
  const human = await run(["describe", endpoint, "--human"]);
  expect(human.stderr).toContain(`dvm quote --endpoint ${endpoint}/ask --data '{}'`);
  expect(human.stderr).toContain(`dvm quote --endpoint ${endpoint}/summarize --data '{}'`);
});

it("submits to the resolved nested base and reuses that base and token for status", async () => {
  const submitted = JSON.parse((await run(["request", "--endpoint", `${endpoint}/nested/ask`, "--input", "hello", "--no-stream"])).stdout);
  expect(submitted.jobId).toBe("endpoint-job");
  expect(requests.find(({ method, path }) => method === "POST" && path === "/nested/v1/job")?.body)
    .toMatchObject({ capability: "ask", input: "hello" });
  expect(requests.some(({ method, path }) => method === "POST" && path.startsWith("/nested/ask/"))).toBe(false);
  const status = JSON.parse((await run(["status", "endpoint-job"])).stdout);
  expect(status.status).toBe("processing");
  expect(requests.at(-1)?.path).toBe("/nested/v1/job/endpoint-job");
});

it.each([["--endpoint", "/nested/"], ["--endpoint", "@fixture"], ["-d", "fixture/ask"]])(
  "preserves base paths and favourites with %s %s", async (flag, reference) => {
    const target = reference.startsWith("/") ? `${endpoint}${reference}` : reference;
    await run(["quote", flag, target, "--input", "hello"]);
    expect(requests.map(({ path }) => path)).toEqual(["/nested/v1/info", "/nested/v1/quote"]);
    expect(requests[1].body?.capability).toBe("ask");
  }
);

it.each(["quote", "request", "describe"])("classifies missing metadata from %s as an endpoint error", async (command) => {
  const missing = `${endpoint}/absent/path`;
  const args = command === "describe" ? [command, missing] : [command, "--endpoint", missing, "--input", "hello"];
  const result = JSON.parse((await run(args, 1)).stdout);
  expect(result.error.code).toBe("not_a_dvm_endpoint");
  expect(requests.map(({ path }) => path)).toEqual(["/absent/path/v1/info", "/absent/v1/info"]);
});
