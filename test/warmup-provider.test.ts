import { createServer, type Server } from "node:http";

import {
  type DescribeOptions,
  DvmError,
  type ProviderInfo,
  type ProviderRef,
  type Transport,
} from "@dvmkit/sdk/internal";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpsTransport } from "../src/lib/transport/https";
import { warmupProvider } from "../src/lib/warmup-provider";

afterEach(() => {
  vi.useRealTimers();
});

describe("provider warmup", () => {
  it("retries a timed-out attempt within the shared deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const starts: Array<{ at: number; timeoutMs: number }> = [];
    const transport = {
      describe: vi.fn(async (_ref: ProviderRef, options?: DescribeOptions) => {
        const timeoutMs = options?.timeoutMs ?? 0;
        starts.push({ at: Date.now(), timeoutMs });
        if (starts.length === 1) {
          await new Promise<void>((_resolve, reject) => {
            setTimeout(() => reject(timeoutError()), timeoutMs);
          });
        }
        return { name: "ready" } as ProviderInfo;
      }),
    } as unknown as Transport;

    const warmup = warmupProvider(transport, { endpoint: "https://provider.test" }, {
      budgetMs: 100,
      maxAttempts: 2,
      baseBackoffMs: 10,
    });
    await vi.runAllTimersAsync();

    await expect(warmup).resolves.toMatchObject({ name: "ready" });
    expect(starts).toEqual([
      { at: 0, timeoutMs: 50 },
      { at: 60, timeoutMs: 40 },
    ]);
  });

  it("keeps attempt timeouts and backoff inside the remaining budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const starts: Array<{ at: number; timeoutMs: number }> = [];
    const sleeps: number[] = [];
    const transport = {
      describe: vi.fn(async (_ref: ProviderRef, options?: DescribeOptions) => {
        const timeoutMs = options?.timeoutMs ?? 0;
        starts.push({ at: Date.now(), timeoutMs });
        await new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(timeoutError()), timeoutMs);
        });
        return {} as ProviderInfo;
      }),
    } as unknown as Transport;

    const warmup = warmupProvider(transport, { endpoint: "https://provider.test" }, {
      budgetMs: 100,
      maxAttempts: 3,
      baseBackoffMs: 80,
      sleep: async (ms) => {
        sleeps.push(ms);
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
    });
    const rejection = expect(warmup).rejects.toMatchObject({
      code: "endpoint_unreachable",
      message: "Provider at https://provider.test did not respond within 0.1s.",
      hint: "The endpoint may be down or the address may be incorrect. Check with 'dvm info <endpoint>'.",
    });
    await vi.runAllTimersAsync();
    await rejection;

    expect(starts).toEqual([
      { at: 1_000, timeoutMs: 33 },
      { at: 1_098, timeoutMs: 1 },
      { at: 1_099, timeoutMs: 1 },
    ]);
    expect(sleeps).toEqual([65]);
    expect(Date.now()).toBe(1_100);
  });

  it("does not retry an unsupported provider version", async () => {
    const unsupported = new DvmError("unsupported_version", "Upgrade required.");
    const transport = {
      describe: vi.fn(async () => {
        throw unsupported;
      }),
    } as unknown as Transport;

    await expect(
      warmupProvider(transport, { endpoint: "https://provider.test" })
    ).rejects.toBe(unsupported);
    expect(transport.describe).toHaveBeenCalledTimes(1);
  });

  it(
    "aborts a stalled HTTP attempt before retrying successfully",
    async () => {
      let requests = 0;
      let activeRequests = 0;
      let closedRequests = 0;
      const server = createServer((request, response) => {
        requests++;
        if (requests === 1) {
          activeRequests++;
          request.once("close", () => {
            activeRequests--;
            closedRequests++;
          });
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ name: "ready" }));
      });
      const endpoint = await listen(server);

      try {
        const info = await warmupProvider(new HttpsTransport(), { endpoint }, {
          budgetMs: 400,
          maxAttempts: 2,
          baseBackoffMs: 10,
        });

        expect(info.name).toBe("ready");
        expect(requests).toBe(2);
        await expect.poll(() => activeRequests).toBe(0);
        expect(closedRequests).toBe(1);
      } finally {
        await close(server);
      }
    },
    2_000
  );
});

function timeoutError(): DvmError {
  return new DvmError(
    "timeout",
    "Provider metadata read timed out.",
    "The provider may be starting up. Retry in a few seconds."
  );
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
