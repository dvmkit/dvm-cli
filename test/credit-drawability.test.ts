import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveIdentityFromPrivkey, type CreditWire, type StoredImplicitCredit } from "@dvmkit/sdk/internal";
import { creditBalance, creditList } from "../src/commands/credit";
import { attestedDvm } from "../src/lib/__tests__/fixtures/receipt-fixture";

const seams = vi.hoisted(() => ({ json: vi.fn(), info: vi.fn(), describe: vi.fn(), credit: vi.fn(), close: vi.fn() }));
vi.mock("../src/lib/output", async (original) => ({
  ...await original<typeof import("../src/lib/output")>(), json: seams.json, info: seams.info,
}));
vi.mock("../src/lib/transport", () => ({ createDvmTransport: () => seams }));

const root = process.env.DVM_CONFIG_DIR!;
const endpoint = "https://provider.example";
const alias = "https://alias.example";
const signer = deriveIdentityFromPrivkey("01".repeat(32));
const dvm = attestedDvm();
const identity = { dvmId: dvm.attestation.dvm_id, builderPubkey: dvm.identity.pubkey };
const expiry = Date.now() + 86_400_000;
const primary: CreditWire = {
  credit_id: "held-credit", currency: "usd", balance_micro: 750_000, remaining_micro: 750_000,
  ledger_seq: 1, expiry_ms: expiry, expired: false, drainable: true,
};
const sibling: CreditWire = { ...primary, credit_id: "sibling", balance_micro: 250_000, remaining_micro: 250_000 };

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  vi.stubEnv("DVM_IDENTITY_KEY", signer.privkey);
  seams.describe.mockResolvedValue({ name: "Provider", builder: dvm.anchor,
    capabilities: { count: {} }, auth: ["secp256k1-schnorr-v2"],
    authAudience: { dvm_id: identity.dvmId, builder_pubkey: identity.builderPubkey } });
  seams.credit.mockResolvedValue({ credit: primary, credits: [primary, sibling] });
  writeFileSync(join(root, "credits.json"), JSON.stringify({ credits: [{
    endpoint, ...identity, callerPubkey: signer.pubkey, creditId: primary.credit_id,
    currency: "usd", balanceMicro: 750_000, remainingMicro: 750_000, targetMicro: 1_000_000,
    ledgerSeq: 1, expiryMs: expiry, status: "active", openedAt: 1, updatedAt: 1,
    siblingCredits: [{ creditId: "sibling", currency: "usd", balanceMicro: 250_000,
      remainingMicro: 250_000, ledgerSeq: 1, expiryMs: expiry, expired: false, drainable: true, observedAt: 1 }],
  }], implicitCredits: [], pendingFundings: [] }));
});
afterEach(() => vi.unstubAllEnvs());

function configure(mode: "off" | "suggest" | "auto", scope: "endpoint" | "alias" | "global" = "endpoint"): string {
  const config = { credit: { posture: scope === "global" ? mode : "auto", perDvm: {
    [endpoint]: { ...identity, ...(scope === "global" ? {} : { posture: scope === "alias" ? "auto" : mode }) },
    ...(scope === "alias" ? { [alias]: { ...identity, posture: mode } } : {}),
  } } };
  const text = JSON.stringify(config);
  writeFileSync(join(root, "config.json"), text);
  return text;
}

function output() { return seams.json.mock.calls.at(-1)![0]; }

describe("posture-aware credit reporting", () => {
  it.each((["endpoint", "alias", "global"] as const).flatMap((scope) =>
    (["list", "balance"] as const).map((command) => ({ scope, command }))
  ))("keeps switched-off prepaid value held and reclaimable ($command, $scope)", async ({ scope, command }) => {
    const config = configure("off", scope);
    if (command === "list") creditList({});
    else await creditBalance(endpoint, {});
    const result = output();
    expect(result.credits[0]).toMatchObject({ credit_id: "held-credit", remaining_micro: 750_000,
      tracked: true, drawable: false, draw_blocked_reason: "posture_off" });
    expect(result.credits[0].display).toMatch(/held.*switched off/i);
    expect(result.totals_by_currency[0]).toMatchObject({ drawable_micro: 0,
      posture_blocked_micro: 750_000, sibling_spendable_micro: 250_000, spendable_micro: 1_000_000 });
    expect(result.display).toMatch(/held.*switched off/i);
    if (command === "balance") {
      expect(result.credits[0]).toMatchObject({ drainable: true });
      expect(result.credits[1]).toMatchObject({ drawable: false, drainable: true,
        drain_command: expect.stringContaining("--credit-id sibling") });
    } else if (scope === "global") {
      expect(result.posture.display).toMatch(/spending held credit.*switched off/i);
    }
    expect(readFileSync(join(root, "config.json"), "utf8")).toBe(config);
    if (command === "list") creditList({ human: true });
    else await creditBalance(endpoint, { human: true });
    expect(seams.info.mock.calls.flat().join("\n")).toMatch(/held.*switched off/i);
    expect(readFileSync(join(root, "config.json"), "utf8")).toBe(config);
  });

  it.each(["suggest", "auto"] as const)("preserves drawable and spendable amounts under %s", async (mode) => {
    configure(mode);
    for (const read of [() => creditList({}), () => creditBalance(endpoint, {})]) {
      await read();
      const result = output();
      expect(result.credits[0]).toMatchObject({ drawable: true, remaining_micro: 750_000 });
      expect(result.credits[0]).not.toHaveProperty("draw_blocked_reason");
      expect(result.totals_by_currency[0]).toMatchObject({ drawable_micro: 750_000,
        sibling_spendable_micro: 250_000, spendable_micro: 1_000_000 });
    }
  });

  it.each([true, false])("reports released per-call balances as switched off (prepaid supported: %s)", async (supported) => {
    configure("off", "alias");
    const store = { credits: [], pendingFundings: [], implicitCredits: [{
      endpoint, ...identity, callerPubkey: signer.pubkey, creditId: "imp:released", currency: "usd",
      remainingMicro: 125_000, ledgerSeq: 1, expiryMs: expiry, status: "active",
      releasedByJobId: "failed-job", releasedAt: 1, updatedAt: 1,
    } satisfies StoredImplicitCredit] };
    writeFileSync(join(root, "credits.json"), JSON.stringify(store));
    if (supported) seams.credit.mockResolvedValue({ credits: [] });
    else {
      const { DvmError } = await import("@dvmkit/sdk/internal");
      seams.credit.mockRejectedValue(new DvmError("credit_not_supported", "No prepaid credit"));
    }
    creditList({});
    expect(output().implicit_credits[0]).toMatchObject({ drawable: false,
      draw_blocked_reason: "posture_off", drainable: false, remaining_micro: 125_000 });
    expect(output().implicit_credits[0].display).toMatch(/held.*switched off/i);
    expect(output().totals_by_currency[0]).toMatchObject({ drawable_micro: 0,
      posture_blocked_micro: 125_000, spendable_micro: 125_000 });
    creditList({ human: true });
    expect(seams.info.mock.calls.flat().join("\n")).toMatch(/held.*switched off/i);
    await creditBalance(endpoint, {});
    expect(output().credits[0]).toMatchObject({ drawable: false, draw_blocked_reason: "posture_off",
      drainable: false, remaining_micro: 125_000 });
    expect(output().totals_by_currency[0]).toMatchObject({ drawable_micro: 0,
      posture_blocked_micro: 125_000, spendable_micro: 125_000 });
  });
});
