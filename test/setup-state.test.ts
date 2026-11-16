import {
  CONFIG_DIR,
  CONFIG_FILE,
  IDENTITIES_FILE,
  JOBS_FILE,
  MESSAGES_DIR,
  WALLET_FILE,
} from "@dvmkit/sdk/internal";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const output = vi.hoisted(() => ({ json: vi.fn(), info: vi.fn() }));
vi.mock("../src/lib/output", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/output")>("../src/lib/output")),
  json: output.json,
  info: output.info,
}));
vi.mock("@dvmkit/sdk/internal", async () => ({
  ...(await vi.importActual<typeof import("@dvmkit/sdk/internal")>("@dvmkit/sdk/internal")),
  fetchBtcUsdRate: vi.fn().mockResolvedValue(100_000),
}));

import { doctor, type DoctorReport } from "../src/commands/doctor";
import { init } from "../src/commands/init";

const exitCode = process.exitCode;

beforeEach(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
});

afterEach(() => {
  process.exitCode = exitCode;
});

describe("caller setup diagnostics", () => {
  it.each([
    { jobs: true, messages: false },
    { jobs: false, messages: true },
    { jobs: true, messages: true },
  ])("leaves wallet-only guidance after init and history $jobs/$messages", async (history) => {
    await init({});
    expect(output.json.mock.calls.at(-1)?.[0]).toMatchObject({ nextStep: "wallet_setup" });
    if (history.jobs) writeFileSync(JOBS_FILE, "[]\n");
    if (history.messages) mkdirSync(MESSAGES_DIR);

    await doctor({});

    const report = output.json.mock.calls.at(-1)?.[0] as DoctorReport;
    expect(report.checks.find((check) => check.name === "partial_setup_state")).toBeUndefined();
    expect(report.checks.find((check) => check.name === "wallet_present")).toMatchObject({
      status: "warn",
      hint: expect.stringContaining("dvm wallet setup"),
    });
    expect(existsSync(WALLET_FILE)).toBe(false);
  });

  it.each([
    { config: true, identity: false, files: ["config.json"] },
    { config: false, identity: true, files: ["identities.json"] },
    { config: true, identity: true, files: ["config.json", "identities.json"] },
  ])("names the missing setup files $files in doctor and init", async ({ config, identity, files }) => {
    await init({});
    const jobs = JSON.stringify([
      { id: "existing-job", endpoint: "https://dvm.example", status: "completed", submittedAt: 1 },
    ]);
    writeFileSync(JOBS_FILE, jobs);
    mkdirSync(MESSAGES_DIR);
    if (config) rmSync(CONFIG_FILE);
    if (identity) rmSync(IDENTITIES_FILE);

    await doctor({});

    const report = output.json.mock.calls.at(-1)?.[0] as DoctorReport;
    const check = report.checks.find((row) => row.name === "partial_setup_state");
    expect(check).toMatchObject({
      status: "warn",
      hint: expect.stringContaining("dvm init"),
      details: {
        existingState: { jobs: true, messages: true },
        missing: { config, identity, wallet: true },
      },
    });
    for (const file of files) {
      expect(check?.display).toContain(file);
      expect(check?.hint).toContain(file);
    }
    expect(check?.hint).not.toContain("wallet");
    if (!config) expect(check?.hint).not.toContain("config.json");
    if (!identity) expect(check?.hint).not.toContain("identities.json");

    output.info.mockClear();
    await init({ human: true, askPosture: async () => undefined });

    const messages = output.info.mock.calls.map(([message]) => message as string);
    const found = messages.find((message) => message.startsWith("Found existing"));
    for (const file of files) expect(found).toContain(file);
    expect(found).not.toContain("wallet");
    if (!config) expect(found).not.toContain("config.json");
    if (!identity) expect(found).not.toContain("identities.json");
    expect(messages).toContainEqual(expect.stringContaining("dvm wallet setup"));
    expect(existsSync(CONFIG_FILE)).toBe(true);
    expect(existsSync(IDENTITIES_FILE)).toBe(true);
    expect(existsSync(WALLET_FILE)).toBe(false);
    expect(readFileSync(JOBS_FILE, "utf8")).toBe(jobs);
    expect(existsSync(MESSAGES_DIR)).toBe(true);
  });

  it("does not report history-free setup as partial", async () => {
    await doctor({ network: false });

    const report = output.json.mock.calls.at(-1)?.[0] as DoctorReport;
    expect(report.checks.find((check) => check.name === "partial_setup_state")).toBeUndefined();
  });

  it("keeps wallet-only re-init quiet about partial setup", async () => {
    await init({});
    writeFileSync(JOBS_FILE, "[]\n");

    await init({ human: true });

    const messages = output.info.mock.calls.map(([message]) => message as string);
    expect(messages.some((message) => message.startsWith("Found existing"))).toBe(false);
    expect(messages).toContainEqual(expect.stringContaining("dvm wallet setup"));
  });
});
