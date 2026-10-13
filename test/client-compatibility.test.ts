import { asProviderText, DvmError } from "@dvmkit/sdk/internal";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_COMPATIBILITY_HEADERS,
  clientCompatibilityError,
  clientUpgradeHumanGuidance,
  DVM_CLIENT,
  DVM_CLIENT_CAPABILITIES,
  DVM_PROTOCOL_VERSION,
  parseClientUpgradeRequired,
} from "../src/lib/client-compatibility";
import { getMintReliability } from "../src/lib/caller-platform-client";
import { CALLER_VERSION } from "../src/lib/caller-version";
import { dvmFetch, withDecodableAcceptEncoding } from "../src/lib/http";
import { handleError } from "../src/lib/error-handler";
import { HttpsTransport } from "../src/lib/transport/https";

interface FixtureCase {
  name: string;
  request_headers: Record<string, string>;
  capabilities: string[];
  response?: { status: number; body: Record<string, unknown> };
}

const fixturePath = resolve(import.meta.dirname, "../protocol-fixtures/client-compatibility.json");
const fixtureText = readFileSync(fixturePath, "utf8");
const fixture = JSON.parse(fixtureText) as {
  protocol_version: string;
  headers: Record<string, string>;
  cases: FixtureCase[];
};
const output = vi.hoisted(() => ({ json: vi.fn() }));

vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()) }));
vi.mock("../src/lib/output", async () => ({ ...(await vi.importActual<typeof import("../src/lib/output")>("../src/lib/output")), json: output.json }));

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("client compatibility metadata", () => {
  it("ports the public protocol fixture byte-for-byte", () => {
    expect(createHash("sha256").update(fixtureText).digest("hex")).toBe(
      "2ee2dea412441f4d80b0b6238d9cfc5437ae48b5607f9af9025bd4c39968c223"
    );
  });

  it("derives the current client token from the package manifest", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")
    ) as { version: string };
    expect(CALLER_VERSION).toBe(manifest.version);
    expect(DVM_CLIENT).toBe(`dvm/${manifest.version}`);
  });

  it("advertises exactly the implemented capability set", () => {
    expect(DVM_CLIENT_CAPABILITIES).toEqual(["credit-recovery", "request-resume"]);
  });

  it("fills missing headers and replaces caller-supplied compatibility values", async () => {
    let captured: Headers | undefined;
    globalThis.fetch = vi.fn(async (_input, init) => {
      captured = new Headers(init?.headers);
      return Response.json({ ok: true });
    });

    await dvmFetch("https://service.example/v1/info", {
      headers: {
        "DVM-Client": "dvm/999.0.0",
        "DVM-Client-Capabilities": "request-resume,request-resume",
      },
    });

    expect(captured?.get(CLIENT_COMPATIBILITY_HEADERS.client)).toBe(DVM_CLIENT);
    expect(captured?.get(CLIENT_COMPATIBILITY_HEADERS.protocolVersion)).toBe(
      DVM_PROTOCOL_VERSION
    );
    expect(captured?.get(CLIENT_COMPATIBILITY_HEADERS.capabilities)).toBe(
      DVM_CLIENT_CAPABILITIES.join(",")
    );
  });

  it("sends identical metadata to a direct DVM and the managed platform", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      requests.push({ url, headers: new Headers(init?.headers) });
      return url.includes("/v1/info")
        ? Response.json({ protocol_version: 1 })
        : Response.json({ mints: [] });
    });

    await new HttpsTransport().describe({ endpoint: "https://independent.example" });
    await getMintReliability("https://api.example");

    expect(requests.map(({ url }) => url)).toEqual([
      "https://independent.example/v1/info",
      "https://api.example/api/v1/mint-health",
    ]);
    const compatibility = (headers: Headers) => ({
      client: headers.get(CLIENT_COMPATIBILITY_HEADERS.client),
      protocol: headers.get(CLIENT_COMPATIBILITY_HEADERS.protocolVersion),
      capabilities: headers.get(CLIENT_COMPATIBILITY_HEADERS.capabilities),
    });
    expect(compatibility(requests[0].headers)).toEqual(compatibility(requests[1].headers));
    expect(compatibility(requests[0].headers)).toEqual({
      client: DVM_CLIENT,
      protocol: DVM_PROTOCOL_VERSION,
      capabilities: DVM_CLIENT_CAPABILITIES.join(","),
    });
  });

  it("does not add compatibility metadata to a third-party request hardening pass", () => {
    const init = withDecodableAcceptEncoding("https://third-party.example/rate");
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept-Encoding")).toBe("gzip, deflate, br");
    expect(headers.get(CLIENT_COMPATIBILITY_HEADERS.client)).toBeNull();
    expect(headers.get(CLIENT_COMPATIBILITY_HEADERS.protocolVersion)).toBeNull();
    expect(headers.get(CLIENT_COMPATIBILITY_HEADERS.capabilities)).toBeNull();
  });
});

describe("client upgrade responses", () => {
  it("parses the fixture response before generic HTTP handling", async () => {
    const responseCase = fixture.cases.find((testCase) => testCase.name === "missing-capability");
    if (!responseCase?.response) throw new Error("fixture response is missing");
    const fixtureResponse = responseCase.response;
    const { error: _wireCode, ...fixtureData } = fixtureResponse.body;
    globalThis.fetch = vi.fn(async () =>
      Response.json(fixtureResponse.body, { status: fixtureResponse.status })
    );

    const error = await dvmFetch("https://service.example/v1/job").catch((caught) => caught);

    expect(error).toBeInstanceOf(DvmError);
    expect(error).toMatchObject({
      code: "client_upgrade_required",
      message: "This request needs a newer dvm client.",
      data: fixtureData,
      proseSources: { display: "provider", hint: "provider" },
    });
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("terminal exit");
    });
    expect(() => handleError(error)).toThrow("terminal exit");
    expect(output.json).toHaveBeenCalledExactlyOnceWith({
      error: {
        code: "client_upgrade_required",
        message: "This request needs a newer dvm client.",
        required_capabilities: ["credit-recovery", "request-resume"],
        minimum_client_version: "0.1.0",
        current_client_version: "0.1.0",
        display: asProviderText(String(fixtureResponse.body.display)),
        hint: asProviderText(String(fixtureResponse.body.hint)),
      },
    });
  });

  it("preserves an unknown future capability as an actionable upgrade requirement", () => {
    const body = JSON.stringify({
      error: "client_upgrade_required",
      required_capabilities: ["future-streaming-mode"],
      display: "server display sentinel",
      hint: "server hint sentinel",
    });
    const error = clientCompatibilityError(426, body);
    expect(error).toMatchObject({
      code: "client_upgrade_required",
      data: {
        required_capabilities: ["future-streaming-mode"],
        display: "server display sentinel",
        hint: "server hint sentinel",
      },
    });
    expect(error?.hint).toBe(
      "Upgrade or reinstall dvm with support for future-streaming-mode, then retry."
    );
    expect(error?.hint).not.toContain("sentinel");
  });

  it.each([
    "not json",
    JSON.stringify({ error: "other", required_capabilities: [], display: "x", hint: "y" }),
    JSON.stringify({ error: "client_upgrade_required", display: "x", hint: "y" }),
    JSON.stringify({
      error: "client_upgrade_required",
      required_capabilities: ["request-resume", "credit-recovery"],
      display: "x",
      hint: "y",
    }),
    JSON.stringify({
      error: "client_upgrade_required",
      required_capabilities: ["request-resume", "request-resume"],
      display: "x",
      hint: "y",
    }),
    JSON.stringify({
      error: "client_upgrade_required",
      required_capabilities: ["Not-A-Token"],
      display: "x",
      hint: "y",
    }),
    JSON.stringify({
      error: "client_upgrade_required",
      required_capabilities: [],
      minimum_client_version: "latest",
      display: "x",
      hint: "y",
    }),
    JSON.stringify({
      error: "client_upgrade_required",
      required_capabilities: [],
      current_client_version: "1.0.0-999999999999999999999",
      display: "x",
      hint: "y",
    }),
  ])("fails closed on a malformed 426 body", (body) => {
    expect(parseClientUpgradeRequired(body)).toBeUndefined();
    expect(clientCompatibilityError(426, body)).toMatchObject({
      code: "invalid_client_upgrade_response",
      message: "The server requires a client upgrade but returned an invalid compatibility response.",
    });
  });

  it("bounds malformed 426 handling before a transport can reflect the body", async () => {
    globalThis.fetch = vi.fn(async () => new Response("private server diagnostic", { status: 426 }));

    const error = await dvmFetch("https://service.example/v1/job").catch((caught) => caught);

    expect(error).toMatchObject({
      code: "invalid_client_upgrade_response",
      message: "The server requires a client upgrade but returned an invalid compatibility response.",
    });
    expect(error.message).not.toContain("diagnostic");
    expect(error.data).toBeUndefined();
  });

  it("renders human guidance only from validated public requirement fields", () => {
    expect(
      clientUpgradeHumanGuidance({
        required_capabilities: ["credit-recovery", "request-resume"],
        minimum_client_version: "0.1.0",
      })
    ).toBe(
      "Upgrade or reinstall dvm with support for credit-recovery, request-resume and dvm 0.1.0 or newer, then retry."
    );
  });
});
