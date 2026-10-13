import { DvmError } from "@dvmkit/sdk/internal";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CLIENT_COMPATIBILITY_HEADERS,
  DVM_CLIENT,
  DVM_CLIENT_CAPABILITIES,
  DVM_PROTOCOL_VERSION,
} from "../src/lib/client-compatibility";
import {
  streamUpload,
  UPLOAD_RESPONSE_MAX_BYTES,
} from "../src/lib/upload-stream";

const fixture = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../protocol-fixtures/client-compatibility.json"),
    "utf8"
  )
) as {
  cases: Array<{
    name: string;
    response?: { status: number; body: Record<string, unknown> };
  }>;
};

let tempDir: string;
let uploadFile: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dvm-upload-compatibility-"));
  uploadFile = join(tempDir, "payload.bin");
  writeFileSync(uploadFile, "upload payload");
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("stream upload compatibility", () => {
  it("sends canonical headers and preserves a valid 426", async () => {
    const fixtureResponse = fixture.cases.find((entry) => entry.name === "missing-capability")
      ?.response;
    if (!fixtureResponse) throw new Error("fixture response is missing");
    let requestHeaders: IncomingMessage["headers"] | undefined;
    let requestCount = 0;

    await withServer(
      (req, res) => {
        requestCount += 1;
        requestHeaders = req.headers;
        req.resume();
        req.on("end", () => {
          res.writeHead(fixtureResponse.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(fixtureResponse.body));
        });
      },
      async (url) => {
        const error = await uploadTo(url).catch((caught) => caught);
        expect(error).toBeInstanceOf(DvmError);
        expect(error).toMatchObject({
          code: "client_upgrade_required",
          data: {
            required_capabilities: ["credit-recovery", "request-resume"],
            minimum_client_version: "0.1.0",
            current_client_version: "0.1.0",
            display: fixtureResponse.body.display,
            hint: fixtureResponse.body.hint,
          },
          proseSources: { display: "provider", hint: "provider" },
        });
      }
    );

    expect(requestCount).toBe(1);
    expect(requestHeaders?.[CLIENT_COMPATIBILITY_HEADERS.client.toLowerCase()]).toBe(DVM_CLIENT);
    expect(requestHeaders?.[CLIENT_COMPATIBILITY_HEADERS.protocolVersion.toLowerCase()]).toBe(
      DVM_PROTOCOL_VERSION
    );
    expect(requestHeaders?.[CLIENT_COMPATIBILITY_HEADERS.capabilities.toLowerCase()]).toBe(
      DVM_CLIENT_CAPABILITIES.join(",")
    );
  });

  it("fails closed on a malformed 426 without retrying or reflecting its body", async () => {
    let requestCount = 0;
    await withServer(
      (req, res) => {
        requestCount += 1;
        req.resume();
        req.on("end", () => {
          res.writeHead(426, { "Content-Type": "text/plain" });
          res.end("private ingest diagnostic");
        });
      },
      async (url) => {
        const error = await uploadTo(url).catch((caught) => caught);
        expect(error).toMatchObject({
          code: "invalid_client_upgrade_response",
          message:
            "The server requires a client upgrade but returned an invalid compatibility response.",
        });
        if (!(error instanceof DvmError)) throw new Error("expected DvmError");
        expect(error.message).not.toContain("diagnostic");
        expect(error.data).toBeUndefined();
        expect(error.proseSources).toBeUndefined();
      }
    );
    expect(requestCount).toBe(1);
  });

  it("destroys an oversized 426 response and returns the stable bounded error", async () => {
    let requestCount = 0;
    let sentBytes = 0;
    const intendedBytes = UPLOAD_RESPONSE_MAX_BYTES * 4;
    let responseClosed: (() => void) | undefined;
    const responseWasClosed = new Promise<void>((resolveClose) => {
      responseClosed = resolveClose;
    });

    await withServer(
      (req, res) => {
        requestCount += 1;
        req.resume();
        req.on("end", () => {
          res.writeHead(426, { "Content-Type": "application/json" });
          res.on("close", () => responseClosed?.());
          const writeChunk = () => {
            if (res.destroyed || sentBytes >= intendedBytes) {
              if (!res.destroyed) res.end();
              return;
            }
            const chunk = Buffer.alloc(4_096, 0x61);
            sentBytes += chunk.byteLength;
            res.write(chunk);
            setTimeout(writeChunk, 1);
          };
          writeChunk();
        });
      },
      async (url) => {
        const error = await uploadTo(url).catch((caught) => caught);
        expect(error).toMatchObject({
          code: "invalid_client_upgrade_response",
          message:
            "The server requires a client upgrade but returned an invalid compatibility response.",
        });
        if (!(error instanceof DvmError)) throw new Error("expected DvmError");
        expect(error.message).not.toContain("aaaa");
        expect(error.data).toBeUndefined();
        expect(error.proseSources).toBeUndefined();
        await responseWasClosed;
      }
    );

    expect(requestCount).toBe(1);
    expect(sentBytes).toBeGreaterThan(UPLOAD_RESPONSE_MAX_BYTES);
    expect(sentBytes).toBeLessThan(intendedBytes);
  });
});

async function uploadTo(url: string): Promise<unknown> {
  return streamUpload({
    url,
    header: "X-Test-Upload-Claim",
    claimB64: "claim",
    filePath: uploadFile,
    sizeBytes: Buffer.byteLength("upload payload"),
    maxAttempts: 4,
    sleep: async () => undefined,
  });
}

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (url: string) => Promise<void>
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");
    await run(`http://127.0.0.1:${address.port.toString()}/upload`);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((err) => (err ? rejectClose(err) : resolveClose()));
    });
  }
}
