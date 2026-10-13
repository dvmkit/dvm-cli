import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const output = vi.hoisted(() => ({ progress: vi.fn(), info: vi.fn() }));
vi.mock("../src/lib/output", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/output")>("../src/lib/output")),
  progress: output.progress,
  info: output.info,
}));

import { HttpsTransport } from "../src/lib/transport/https";

const FIELD = "DVM-Job-Identity-V1";
const CLAIM = "x-dvmkit-router-feedback-claim";
const ENVELOPE = { capability: "echo", input: "hi" };
const servers = new Set<Server>();

afterEach(async () => {
  output.progress.mockReset();
  output.info.mockReset();
  await Promise.all([...servers].map(close));
  servers.clear();
});

describe("paid submit job identity", () => {
  it("takes the job from a field that matches the body and keeps the claim beside it", async () => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(202, { [FIELD]: "job-a", [CLAIM]: "claim-a", "Content-Type": "application/json" });
      response.end(JSON.stringify({ job_id: "job-a", status: "processing" }));
    });

    const receipt = await submit(endpoint);

    expect(receipt).toMatchObject({ jobId: "job-a", feedbackClaim: "claim-a" });
  });

  it("refuses a field that names a different job than the body, without the token or claim", async () => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(202, { [FIELD]: "job-a", [CLAIM]: "claim-b", "Content-Type": "application/json" });
      response.end(JSON.stringify({ job_id: "job-b", job_token: "secret-token", status: "processing" }));
    });

    const error = await submit(endpoint).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "provider_identity_mismatch",
      data: { identity_kind: "identity_mismatch", header_job_id: "job-a", body_job_id: "job-b" },
    });
    // `data` is what the error handler prints.
    expect(JSON.stringify((error as { data: unknown }).data)).not.toMatch(/secret-token|claim-b/);
  });

  it("ignores a repeated field with a warning and stores no claim minted beside it", async () => {
    const endpoint = await listen((_request, response) => {
      response.setHeader(FIELD, ["job-a", "job-a"]);
      response.setHeader(CLAIM, "claim-a");
      response.setHeader("Content-Type", "application/json");
      response.writeHead(202);
      response.end(JSON.stringify({ job_id: "job-a", status: "processing" }));
    });

    const receipt = await submit(endpoint);

    expect(receipt.jobId).toBe("job-a");
    expect(receipt.feedbackClaim).toBeUndefined();
    expect(output.progress).toHaveBeenCalledWith(
      expect.objectContaining({ event: "warning", code: "job_identity_header_invalid" })
    );
  });

  it.each([
    {
      label: "breaks off",
      respond: (response: ServerResponse) => {
        response.writeHead(202, { [FIELD]: "job-a", "Content-Type": "application/json", "Content-Length": "200" });
        response.write('{"job_id":"job-a",');
        setTimeout(() => response.destroy(), 20);
      },
    },
    {
      label: "stalls past the deadline",
      respond: (response: ServerResponse) => {
        response.writeHead(202, { [FIELD]: "job-a", "Content-Type": "application/json" });
        response.write('{"job_id":"job-a",');
      },
    },
  ])("reports a 2xx body that $label as unreadable, never as a retryable timeout", async ({ respond }) => {
    const endpoint = await listen((_request, response) => respond(response));

    const error = await submit(endpoint, 200).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "provider_body_unreadable",
      data: { identity_kind: "body_unreadable", header_job_id: "job-a" },
    });
  });

  it.each([
    { status: 409, payment: { cashuToken: "cashuBtest" }, code: "provider_body_unreadable" },
    { status: 500, payment: undefined, code: "provider_error" },
  ])("reports a $status whose body breaks off as $code", async ({ status, payment, code }) => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(status, { "Content-Type": "application/json", "Content-Length": "200" });
      response.write('{"error":');
      setTimeout(() => response.destroy(), 20);
    });

    const error = await new HttpsTransport()
      .submit({ endpoint }, ENVELOPE, payment, { timeoutMs: 2_000 })
      .catch((caught: unknown) => caught);

    // A DvmError keeps the paid path's "already sent" context; a raw read error would lose it.
    expect(error).toMatchObject({ code });
  });

  it("treats a 2xx with no job ID and no field as unreadable", async () => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(202, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "processing" }));
    });

    await expect(submit(endpoint)).rejects.toMatchObject({ code: "provider_body_unreadable" });
  });

  it("prints an unstorable body job ID only escaped", async () => {
    const hostile = `job-\u0085-${"x".repeat(20)}`;
    const endpoint = await listen((_request, response) => {
      response.writeHead(202, { [FIELD]: "job-a", "Content-Type": "application/json" });
      response.end(JSON.stringify({ job_id: hostile, status: "processing" }));
    });

    const error = (await submit(endpoint).catch((caught: unknown) => caught)) as {
      code: string;
      message: string;
      data: Record<string, unknown>;
    };

    expect(error.code).toBe("provider_identity_mismatch");
    expect(error.data.body_job_id).toBeUndefined();
    expect(error.data.body_job_id_escaped).toBe(JSON.stringify(hostile).replace("\u0085", "\\u0085"));
    expect(JSON.stringify(error.data) + error.message).not.toContain("\u0085");
  });

  it("surfaces the router's refusal of a second job for an accepted request as an identity failure", async () => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(409, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            code: "hosting_job_identity_conflict",
            message: "The provider returned a different job for a request it had already accepted",
            display:
              "This request was already accepted as job job-a. The service then answered with a different job, so that answer was refused.",
            hint: "Do not pay again or resubmit this request. It was already accepted as job job-a.",
            accepted_job_id: "job-a",
          },
          trace_id: "trace-1",
        })
      );
    });

    const error = await submit(endpoint).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "hosting_job_identity_conflict",
      data: { identity_kind: "router_identity_conflict", accepted_job_id: "job-a" },
    });
    expect(error).toHaveProperty("observation.kind", "router_identity_conflict");
  });
});

describe("request-result job identity", () => {
  it("surfaces the router's conflict as an identity failure with this CLI's own hint", async () => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(409, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            code: "hosting_job_identity_conflict",
            message: "The provider returned a different job for a request it had already accepted",
            display:
              "This request was already accepted as job job-a. The service then answered with a different job, so that answer was refused.",
            hint: "Do not pay again. Run `dvm request-result req-1` to recover job job-a.",
            accepted_job_id: "job-a",
            request_id: "req-1",
          },
          trace_id: "trace-1",
        })
      );
    });

    const error = (await new HttpsTransport()
      .requestResult({ endpoint }, "req-1", ENVELOPE)
      .catch((caught: unknown) => caught)) as {
      code: string;
      hint: string;
      data: Record<string, unknown>;
      proseSources: unknown;
    };

    expect(error).toMatchObject({
      code: "hosting_job_identity_conflict",
      data: { identity_kind: "router_identity_conflict", accepted_job_id: "job-a" },
    });
    expect(error.hint).not.toContain("request-result req-1");
    // Only the router's display is its prose; the message and hint are the CLI's.
    expect(error.proseSources).toEqual({ display: "provider" });
  });


  it("refuses an answer whose field names a different job than its body", async () => {
    const endpoint = await listen((_request, response) => {
      response.writeHead(202, { [FIELD]: "job-b", "Content-Type": "application/json" });
      response.end(JSON.stringify({ job_id: "job-a", status: "processing", request_id: "req-1" }));
    });

    await expect(
      new HttpsTransport().requestResult({ endpoint }, "req-1", ENVELOPE)
    ).rejects.toMatchObject({
      code: "request_outcome_unknown",
      data: { request_id: "req-1", reason: "job_identity_mismatch" },
    });
  });
});

function submit(endpoint: string, timeoutMs = 2_000) {
  return new HttpsTransport().submit({ endpoint }, ENVELOPE, undefined, { timeoutMs });
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<string> {
  const server = createServer((request, response) => {
    request.resume();
    request.once("end", () => handler(request, response));
  });
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
