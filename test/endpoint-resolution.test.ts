import { DvmError, type ProviderInfo } from "@dvmkit/sdk/internal";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveCapability } from "../src/lib/dvm-identifier";
import { resolveProviderEndpoint } from "../src/lib/resolve-provider-endpoint";
import { HttpsTransport } from "../src/lib/transport/https";

const descriptor = { capabilities: { ask: {}, summarize: {} } };
const endpoint = "https://provider.example/service";

afterEach(() => vi.unstubAllGlobals());

function stubProvider(routes: Record<string, { status?: number; body?: unknown }>) {
  const paths: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = new URL(input).pathname;
    paths.push(path);
    const route = routes[path];
    return new Response(JSON.stringify(route?.body ?? {}), {
      status: route?.status ?? (route ? 200 : 404),
      headers: { "content-type": "application/json" },
    });
  }));
  return paths;
}

describe("endpoint capability resolution", () => {
  it("preserves a working base path even when the parent lists that segment", async () => {
    const paths = stubProvider({
      "/service/v1/info": { body: descriptor },
      "/v1/info": { body: { capabilities: { service: {} } } },
    });
    const resolved = await resolveProviderEndpoint(new HttpsTransport(), `${endpoint}/`, { capabilityPath: true });
    expect(resolved.endpoint).toBe(endpoint);
    expect(resolved.capability).toBeUndefined();
    expect(paths).toEqual(["/service/v1/info"]);
  });

  it("uses the immediate parent descriptor after a capability path returns 404", async () => {
    const paths = stubProvider({ "/service/v1/info": { body: descriptor } });
    const resolved = await resolveProviderEndpoint(new HttpsTransport(), `${endpoint}/%61sk/`, { capabilityPath: true });
    expect(resolved.endpoint).toBe(endpoint);
    expect(resolveCapability(resolved.info, resolved.capability, undefined, resolved.endpoint)).toBe("ask");
    expect(paths).toEqual(["/service/%61sk/v1/info", "/service/v1/info"]);
  });

  it("does not reinterpret an identifier's saved base path", async () => {
    const paths = stubProvider({ "/v1/info": { body: descriptor } });
    await expect(resolveProviderEndpoint(new HttpsTransport(), endpoint)).rejects.toMatchObject({ code: "not_a_dvm_endpoint" });
    expect(paths).toEqual(["/service/v1/info"]);
  });

  it("does not walk beyond the immediate parent", async () => {
    const paths = stubProvider({ "/v1/info": { body: descriptor } });
    await expect(resolveProviderEndpoint(new HttpsTransport(), `${endpoint}/ask`, { capabilityPath: true }))
      .rejects.toMatchObject({ code: "not_a_dvm_endpoint" });
    expect(paths).toEqual(["/service/ask/v1/info", "/service/v1/info"]);
  });

  it("requires a parent's capability menu before treating the suffix as a selection", async () => {
    stubProvider({ "/service/v1/info": { body: { name: "Legacy provider" } } });
    await expect(resolveProviderEndpoint(new HttpsTransport(), `${endpoint}/ask`, { capabilityPath: true }))
      .rejects.toMatchObject({ code: "not_a_dvm_endpoint", message: expect.stringContaining("/service/ask/v1/info") });
  });

  it("retries transient errors at the supplied base without falling back", async () => {
    const paths = stubProvider({
      "/service/ask/v1/info": { status: 503 },
      "/service/v1/info": { body: descriptor },
    });
    await expect(resolveProviderEndpoint(new HttpsTransport(), `${endpoint}/ask`, {
      capabilityPath: true, maxAttempts: 2, sleep: async () => undefined,
    })).rejects.toMatchObject({ code: "endpoint_unreachable" });
    expect(paths).toEqual(["/service/ask/v1/info", "/service/ask/v1/info"]);
  });

  it("shares the warmup deadline with the parent probe", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (new URL(input).pathname === "/service/ask/v1/info") {
        now += 25;
        return new Response(null, { status: 404 });
      }
      return Response.json(descriptor);
    }));
    await resolveProviderEndpoint(new HttpsTransport(), `${endpoint}/ask`, {
      capabilityPath: true, budgetMs: 100, maxAttempts: 1,
    });
    expect(timeouts.mock.calls).toEqual([[100], [75]]);
  });

  it("classifies a root metadata 404 without echoing its provider body", async () => {
    const paths = stubProvider({ "/v1/info": { status: 404, body: "untrusted body" } });
    const error = await resolveProviderEndpoint(new HttpsTransport(), "https://provider.example", { capabilityPath: true })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(DvmError);
    expect(error).toMatchObject({ code: "not_a_dvm_endpoint" });
    expect((error as DvmError).message).not.toContain("untrusted body");
    expect(paths).toEqual(["/v1/info"]);
  });

  it("does not start a parent probe after exhausting the warmup budget", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetch = vi.fn(async () => {
      now += 100;
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(resolveProviderEndpoint(new HttpsTransport(), `${endpoint}/ask`, {
      capabilityPath: true, budgetMs: 100, maxAttempts: 1,
    })).rejects.toMatchObject({ code: "not_a_dvm_endpoint" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("capability retry guidance", () => {
  function capabilityError(info: ProviderInfo, requested: string | undefined, base: string): DvmError {
    try {
      resolveCapability(info, requested, undefined, base);
    } catch (error) {
      if (error instanceof DvmError) return error;
      throw error;
    }
    throw new Error("Expected a capability selection error");
  }

  it.each([undefined, "missing"])("offers direct URL and hosted identifier retries for %s", (requested) => {
    const error = capabilityError(descriptor, requested, "https://builder--service.dvmkit.ai");
    expect(error.code).toBe(requested ? "unknown_capability" : "ambiguous_capability");
    expect(error.data).toEqual({ available_capabilities: ["ask", "summarize"], _provider_fields: ["available_capabilities"] });
    expect(error.hint).toContain("dvm quote --endpoint https://builder--service.dvmkit.ai/ask --data '{}'");
    expect(error.hint).toContain("dvm quote -d builder--service/ask --data '{}'");
    expect(error.hint).not.toContain("search");
  });

  it("keeps a hosted path in URL guidance rather than suggesting a different root service", () => {
    const error = capabilityError(descriptor, undefined, "https://builder--service.dvmkit.ai/nested");
    expect(error.hint).toContain("https://builder--service.dvmkit.ai/nested/ask");
    expect(error.hint).not.toContain(" -d ");
  });

  it("keeps malformed provider names in marked choices without interpolating them into guidance", () => {
    const malicious = "$(touch injected)";
    const info = { capabilities: { [malicious]: {}, ask: {} } };
    const error = capabilityError(info, undefined, endpoint);
    expect(error.data?.available_capabilities).toEqual([malicious, "ask"]);
    expect(error.hint).toContain(`${endpoint}/ask`);
    expect(error.hint).not.toContain(malicious);
    const noSafeChoice = capabilityError({ capabilities: { [malicious]: {}, "also invalid": {} } }, undefined, endpoint);
    expect(noSafeChoice.hint).toContain(`dvm describe ${endpoint}`);
    expect(noSafeChoice.hint).not.toContain(malicious);
  });
});
