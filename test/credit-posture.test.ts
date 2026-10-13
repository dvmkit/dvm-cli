vi.mock("../src/lib/output", async () => ({ ...(await vi.importActual<typeof import("../src/lib/output")>("../src/lib/output")), json: output.json, info: output.info, raw: output.raw }));
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const output = vi.hoisted(() => ({
  info: vi.fn(),
  json: vi.fn(),
  raw: vi.fn(),
}));

vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
  ...output,
}));

const endpoint = "http://127.0.0.1:1";
const aliasEndpoint = "https://alias.invalid";
const identityOnlyEndpoint = "https://old-alias.invalid";
const builderPubkey = "a".repeat(64);
const dvmId = "dvm-test-identity";

let configRoot: string;
let originalConfigRoot: string | undefined;
let creditPosture: typeof import("../src/commands/credit")["creditPosture"];

describe("credit posture override clearing", () => {
  beforeAll(async () => {
    configRoot = mkdtempSync(join(tmpdir(), "dvm-cli-credit-posture-"));
    originalConfigRoot = process.env.DVM_CONFIG_DIR;
    process.env.DVM_CONFIG_DIR = configRoot;
    vi.resetModules();
    ({ creditPosture } = await import("../src/commands/credit"));
  });

  beforeEach(() => {
    rmSync(configRoot, { recursive: true, force: true });
    mkdirSync(configRoot, { recursive: true });
    output.info.mockClear();
    output.json.mockClear();
    output.raw.mockClear();
  });

  afterAll(() => {
    rmSync(configRoot, { recursive: true, force: true });
    if (originalConfigRoot === undefined) delete process.env.DVM_CONFIG_DIR;
    else process.env.DVM_CONFIG_DIR = originalConfigRoot;
  });

  it("clears every saved alias while preserving unrelated per-DVM policy", async () => {
    writeConfig({
      credit: {
        posture: "suggest",
        perDvm: {
          [endpoint]: {
            posture: "auto",
            fundingRail: "tempo",
            dvmId,
            builderPubkey,
          },
          [aliasEndpoint]: {
            posture: "off",
            targetJobs: 3,
            dvmId,
            builderPubkey,
          },
          [identityOnlyEndpoint]: { posture: "auto", dvmId, builderPubkey },
          "https://other.invalid": { posture: "off" },
        },
      },
    });

    await creditPosture(undefined, { clear: true, dvm: endpoint });

    expect(readConfig()).toMatchObject({
      credit: {
        posture: "suggest",
        perDvm: {
          [endpoint]: { fundingRail: "tempo", dvmId, builderPubkey },
          [aliasEndpoint]: { targetJobs: 3, dvmId, builderPubkey },
          "https://other.invalid": { posture: "off" },
        },
      },
    });
    expect(output.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "cleared",
        posture: "suggest",
        posture_source: "global",
        cleared_endpoints: [endpoint, aliasEndpoint, identityOnlyEndpoint],
        scope: "per_dvm",
        endpoint,
      })
    );
  });

  it("is idempotent and leaves an absent config absent", async () => {
    await creditPosture(undefined, { clear: true, dvm: endpoint });
    await creditPosture(undefined, { clear: true, dvm: endpoint });

    expect(existsSync(join(configRoot, "config.json"))).toBe(false);
    expect(output.json).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "cleared",
        posture: "suggest",
        posture_source: "default",
      })
    );
  });

  it("fails closed offline when the saved identity is incomplete", async () => {
    const original = {
      credit: {
        posture: "off",
        perDvm: {
          [endpoint]: {
            posture: "suggest",
            dvmId,
            builderPubkey: "not-a-builder-key",
          },
          [aliasEndpoint]: { posture: "auto", dvmId, builderPubkey },
        },
      },
    };
    writeConfig(original);

    await expect(creditPosture(undefined, { clear: true, dvm: endpoint })).rejects.toMatchObject({
      code: "credit_posture_identity_unavailable",
    });
    expect(readConfig()).toEqual(original);
    expect(output.json).not.toHaveBeenCalled();
  });

  it("preserves policy fields written by a newer CLI", async () => {
    writeConfig({
      credit: {
        perDvm: {
          [endpoint]: {
            posture: "auto",
            dvmId,
            builderPubkey,
            futureSettlementPolicy: { mode: "manual", retries: 2 },
          },
        },
      },
    });

    await creditPosture(undefined, { clear: true, dvm: endpoint });

    expect(readConfig()).toMatchObject({
      credit: {
        perDvm: {
          [endpoint]: {
            dvmId,
            builderPubkey,
            futureSettlementPolicy: { mode: "manual", retries: 2 },
          },
        },
      },
    });
  });

  it("requires exactly one posture value or one scoped clear", async () => {
    await expect(creditPosture(undefined, {})).rejects.toMatchObject({
      code: "invalid_argument",
      message: "Missing credit posture.",
    });
    await expect(creditPosture("off", { clear: true, dvm: endpoint })).rejects.toMatchObject({
      code: "invalid_argument",
      message: expect.stringContaining("not both"),
    });
    await expect(creditPosture(undefined, { clear: true })).rejects.toMatchObject({
      code: "invalid_argument",
      message: expect.stringContaining("requires --dvm"),
    });
    expect(existsSync(join(configRoot, "config.json"))).toBe(false);
  });
});

function writeConfig(value: unknown): void {
  writeFileSync(join(configRoot, "config.json"), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function readConfig(): unknown {
  return JSON.parse(readFileSync(join(configRoot, "config.json"), "utf8"));
}
