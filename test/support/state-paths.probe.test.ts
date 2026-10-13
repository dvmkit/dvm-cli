import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as sdk from "@dvmkit/sdk/internal";
import { expect, it } from "vitest";

it("keeps every published shared state path and real store writes inside the startup sandbox", () => {
  const root = process.env.DVM_CONFIG_DIR!;
  expect(root).not.toBe(join(homedir(), ".dvm"));
  expect(resolve(root).startsWith(resolve(tmpdir()) + "/")).toBe(true);
  expect(process.env.DVMKIT_CONFIG_DIR).toBe(join(root, "builder"));
  expect(sdk.CONFIG_DIR).toBe(root);
  const statePaths = Object.entries(sdk).filter(([name, value]) =>
    typeof value === "string" && /(?:_FILE|_DIR)$/.test(name)
  );
  expect(statePaths.map(([name]) => name).sort()).toEqual([
    "AGENT_MNEMONIC_FILE", "BTC_RATE_FILE", "BUDGET_FILE", "CONFIG_AUDIT_FILE",
    "CONFIG_BACKUP_FILE", "CONFIG_DIR", "CONFIG_FILE", "CONFIG_PINNED_FILE",
    "CREDITS_FILE", "FAVORITES_FILE", "FEEDBACK_NUDGES_FILE", "IDENTITIES_FILE",
    "JOBS_FILE", "MESSAGES_DIR", "PAIRINGS_DIR", "RECEIPTS_FILE",
    "RECOVERY_MNEMONIC_FILE", "REQUEST_INTENTS_DIR", "TEMPO_CHANNELS_FILE",
    "WALLET_FILE", "X402_CHANNELS_FILE",
  ]);
  for (const [name, path] of statePaths) {
    expect(path === root || (path as string).startsWith(root + "/"), name).toBe(true);
  }
  sdk.saveBudgetLedger(sdk.BUDGET_FILE, { caps: { dailyUsd: 2 }, entries: [] });
  assert.deepEqual(JSON.parse(readFileSync(join(root, "budget.json"), "utf8")), {
    caps: { dailyUsd: 2 }, entries: [],
  });
});

it("passes disposable roots to a fresh Node process before SDK import and real store writes", () => {
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import { join } from "node:path";
    const sdk = await import("@dvmkit/sdk/internal");
    assert.equal(sdk.CONFIG_DIR, process.env.DVM_CONFIG_DIR);
    assert.equal(process.env.DVMKIT_CONFIG_DIR, join(sdk.CONFIG_DIR, "builder"));
    assert.equal(sdk.BUDGET_FILE, join(sdk.CONFIG_DIR, "budget.json"));
    sdk.appendBudgetSpend(sdk.BUDGET_FILE, {
      msats: 1000000, btcRate: 100000, jobId: "sandbox-child",
      providerEndpoint: "https://example.com", now: new Date("2026-01-01T00:00:00Z"),
    });
    const stored = JSON.parse(readFileSync(sdk.BUDGET_FILE, "utf8"));
    assert.equal(stored.entries.at(-1).jobId, "sandbox-child");
    assert.equal(stored.entries.at(-1).usd, 1);
    console.log("sandbox-child-ok");
  `], { encoding: "utf8", timeout: 20_000 });
  expect(result.trim()).toBe("sandbox-child-ok");
});
