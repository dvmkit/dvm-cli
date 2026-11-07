import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DvmError, deriveIdentityFromPrivkey, type ProviderInfo } from "@dvmkit/sdk/internal";

const seams = vi.hoisted(() => ({
  describe: vi.fn(), credit: vi.fn(), close: vi.fn(),
  stdout: [] as string[], stderr: [] as string[],
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, writeSync: (...args: Parameters<typeof fs.writeSync>) => {
    if (args[0] === 1 || args[0] === 2) {
      const data = args[1] as unknown as Uint8Array;
      const offset = typeof args[2] === "number" ? args[2] : 0;
      const length = typeof args[3] === "number" ? args[3] : data.byteLength;
      (args[0] === 1 ? seams.stdout : seams.stderr).push(Buffer.from(data).subarray(offset, offset + length).toString());
      return length;
    }
    return Reflect.apply(fs.writeSync, fs, args);
  } };
});
vi.mock("../src/lib/transport", () => ({ createDvmTransport: () => seams }));

import { runCreditDrain } from "../src/lib/credit/drain";

const endpoint = "https://provider.example";
const creditId = "tempo-credit";
const signer = deriveIdentityFromPrivkey("01".repeat(32));
const root = process.env.DVM_CONFIG_DIR!;
const info: ProviderInfo = {
  name: "Test provider",
  capabilities: { work: { description: "Work" } },
  requestRecovery: true,
  auth: ["secp256k1-schnorr-v2"],
  authAudience: { dvm_id: "test-provider", builder_pubkey: "03".repeat(32) },
  credit: { funding: ["tempo"], currency: "usd", min_micro: 1, max_micro: 5_000_000, ttl_ms: 86_400_000 },
} as ProviderInfo;

function seedCredit(overrides: Record<string, unknown>): void {
  writeFileSync(join(root, "credits.json"), JSON.stringify({
    credits: [{
      endpoint, callerPubkey: signer.pubkey, creditId, currency: "usd", rail: "tempo",
      remainingMicro: 0, balanceMicro: 0, targetMicro: 750_000,
      expiryMs: Date.now() + 86_400_000, status: "drained", ledgerSeq: 2, ...overrides,
    }],
    implicitCredits: [], pendingFundings: [],
  }));
}

const exitRefusal = () => new DvmError(
  "tempo_channel_exit_required", "Cooperative close unavailable.", "Provider retry advice.",
  { drain_registered: false, status: "exit_required" }
);
const output = () => JSON.parse(seams.stdout.join("").trim().split("\n").at(-1)!);

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  seams.stdout.length = 0;
  seams.stderr.length = 0;
  seams.describe.mockResolvedValue(info);
  vi.stubEnv("DVM_IDENTITY_KEY", signer.privkey);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network access")));
});

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("repeat Tempo drain", () => {
  it("answers already drained from the record without posting a drain", async () => {
    seedCredit({});
    await runCreditDrain(endpoint, { creditId });

    expect(seams.credit).not.toHaveBeenCalled();
    expect(output()).toMatchObject({ op: "drain", credit_id: creditId, already_drained: true, balance_micro: 0 });
    expect(output().display).toContain("already drained");
    expect(JSON.stringify(output())).not.toMatch(/tempo-exit|timed exit/);
  });

  it("maps an unregistered exit refusal on a drained credit to already drained", async () => {
    seedCredit({});
    seams.credit.mockRejectedValue(exitRefusal());
    await runCreditDrain(endpoint, { creditId, drainId: "drain-again", method: "tempo", address: `0x${"12".repeat(20)}` });

    expect(seams.credit).toHaveBeenCalledOnce();
    expect(output()).toMatchObject({ already_drained: true, balance_micro: 0 });
    expect(JSON.stringify(output())).not.toMatch(/tempo-exit|timed exit/);
  });

  it("keeps the timed-exit guidance for a credit that still holds a balance", async () => {
    seedCredit({ status: "active", remainingMicro: 750_000, balanceMicro: 750_000 });
    seams.credit.mockRejectedValue(exitRefusal());
    const failure = runCreditDrain(endpoint, { creditId, method: "tempo", address: `0x${"12".repeat(20)}` });

    await expect(failure).rejects.toMatchObject({
      code: "tempo_channel_exit_required",
      hint: expect.stringContaining("dvm wallet tempo-exit"),
    });
    expect(seams.stdout).toEqual([]);
  });
});
