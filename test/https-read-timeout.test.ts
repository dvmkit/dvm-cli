import { DvmError } from "@dvmkit/sdk/internal";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { HttpsTransport } from "../src/lib/transport/https";

const servers = new Set<Server>();
const reads = [
  {
    name: "message poll",
    message: "Message poll timed out.",
    invoke: (endpoint: string, timeoutMs?: number) =>
      new HttpsTransport().getMessages("job-1", 0, { endpoint }, { timeoutMs }),
    bodies: [{ label: "messages JSON", statusCode: 200, partialBody: '{"messages":[' }],
    completed: '{"messages":[]}',
    expected: [],
  },
  {
    name: "status",
    message: "Status check timed out.",
    invoke: (endpoint: string, timeoutMs?: number) =>
      new HttpsTransport().status("job-1", { endpoint }, { timeoutMs }),
    bodies: [
      { label: "status JSON", statusCode: 200, partialBody: '{"status":' },
      { label: "error body", statusCode: 500, partialBody: '{"error":' },
    ],
    completed: '{"status":"processing"}',
    expected: expect.objectContaining({ jobId: "job-1", status: "processing" }),
  },
];

afterEach(async () => {
  await Promise.all([...servers].map(close));
  servers.clear();
});

describe.each(reads)("HTTPS $name deadlines", (read) => {
  it("aborts a request while the provider withholds response headers", async () => {
    let closedRequests = 0;
    const endpoint = await listen(createServer((request) => {
      request.once("close", () => {
        closedRequests += 1;
      });
    }));

    // The deadline must outlast handler scheduling under load; polling for the
    // close (not for zero active requests) cannot pass if the server never saw
    // the request.
    await expect(read.invoke(endpoint, 300)).rejects.toMatchObject({
      code: "timeout", message: read.message,
    });
    await expect.poll(() => closedRequests).toBe(1);
  });

  it.each(read.bodies)("aborts a $label read when the provider stops mid-body", async (body) => {
    let closedResponses = 0;
    const endpoint = await listen(createServer((_request, response) => {
      response.once("close", () => {
        closedResponses += 1;
      });
      response.writeHead(body.statusCode, { "Content-Type": "application/json" });
      response.write(body.partialBody);
    }));

    const error = await read.invoke(endpoint, 300).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DvmError);
    expect(error).toMatchObject({ code: "timeout", message: read.message });
    await expect.poll(() => closedResponses).toBe(1);
  });

  it("leaves a read unbounded when the caller supplies no timeout", async () => {
    let release: (() => void) | undefined;
    let markRequestStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolveStarted) => {
      markRequestStarted = resolveStarted;
    });
    const endpoint = await listen(createServer((_request, response) => {
      release = () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(read.completed);
      };
      markRequestStarted?.();
    }));
    const result = read.invoke(endpoint);
    await requestStarted;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    release?.();
    await expect(result).resolves.toEqual(read.expected);
  });
});

describe("HTTPS message poll disconnections", () => {
  it.each([
    { status: 200, body: '{"messages":[' },
    { status: 503, body: '{"error":' },
  ])("reports a dropped $status response body as unreachable", async ({ status, body }) => {
    const server = createServer((_request, response) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.write(body);
      setTimeout(() => response.destroy(), 25);
    });
    const endpoint = await listen(server);

    const error = await new HttpsTransport()
      .getMessages("job-disconnected", 0, { endpoint }, { timeoutMs: 1_000 })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(DvmError);
    expect(error).toMatchObject({
      code: "provider_unreachable",
      message: "Could not reach the provider to fetch messages for job job-disconnected.",
    });
  });

});

async function listen(server: Server): Promise<string> {
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  return `http://127.0.0.1:${address.port.toString()}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
