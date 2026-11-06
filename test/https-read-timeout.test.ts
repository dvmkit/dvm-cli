import { DvmError } from "@dvmkit/sdk/internal";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("HTTPS payment send deadlines", () => {
  it.each([undefined, 201, 402])("bounds a payment send including its response body (HTTP %s)", async (status) => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(300));
    let closed = 0;
    const endpoint = await listen(createServer((_request, response) => {
      response.once("close", () => { closed += 1; });
      if (status) {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.write(status === 402 ? '{"error":' : '{"seq":');
      }
    }));
    await expect(new HttpsTransport().sendMessage("job-1", {
      type: "payment", content: { amount_msats: 10_000 },
    }, { endpoint })).rejects.toMatchObject({ code: "timeout", message: "Payment send timed out." });
    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    await expect.poll(() => closed).toBe(1);
  });
});

describe("HTTPS payment refusals", () => {
  const send = (endpoint: string) => new HttpsTransport().sendMessage("job-1", {
    type: "payment", content: { cashu_token: "token", cashu_request_id: "request-1", amount_msats: 10_000 },
  }, { endpoint });
  const answer = (status: number, body: string) => listen(createServer((_request, response) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(body);
  }));

  // The SDK accumulator's body for proofs refused under a request id that already carries another payment.
  it("keeps request_id_reused a payment refusal on a live job, with its status", async () => {
    const endpoint = await answer(409, JSON.stringify({ error: "request_id_reused",
      message: "This request id already carries a different payment at this DVM; these proofs were not accepted.",
      display: "This payment was not accepted and nothing was charged.", retryable: false }));
    await expect(send(endpoint)).rejects.toMatchObject({ code: "request_id_reused", data: { http_status: 409 } });
  });

  it("still reports a conflict without a payment code as the job having ended", async () => {
    const endpoint = await answer(409, JSON.stringify({ error: "job_not_active" }));
    await expect(send(endpoint)).rejects.toMatchObject({ code: "job_terminal" });
  });

  // Only a code the provider's own `error` field names may release a payment.
  it.each([
    ["an empty body", "{}"],
    ["a message without a code", JSON.stringify({ message: "Payment required" })],
  ])("marks the code of a 402 with %s as inferred", async (_label, body) => {
    const endpoint = await answer(402, body);
    await expect(send(endpoint)).rejects.toMatchObject({ code: "payment_insufficient",
      data: { http_status: 402, code_source: "inferred" } });
  });

  it("keeps a nested structured 402 code as the provider's own", async () => {
    const endpoint = await answer(402, JSON.stringify({ error: { code: "payment_invalid", message: "Refused" } }));
    const refusal = await send(endpoint).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: "payment_invalid", data: { http_status: 402 } });
    expect((refusal as DvmError).data?.code_source).toBeUndefined();
  });

  it("carries the status of a prose 404 so a payment is not released on it", async () => {
    const endpoint = await answer(404, JSON.stringify({ error: "Job not found" }));
    await expect(send(endpoint)).rejects.toMatchObject({ data: { http_status: 404 } });
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
