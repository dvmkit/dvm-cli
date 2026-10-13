import { readFileSync, statSync } from "node:fs";
import { CONFIG_DIR, CONFIG_FILE, WALLET_FILE, WALLET_VERSION, deriveAgentMasterKeypair, loadAgentWallet, loadWalletConfiguredMints, saveAgentWallet } from "@dvmkit/sdk/internal";
import { loadConfig, updateConfig } from "../../identity";
import { expect, it } from "vitest";
import { loadConfiguredMints } from "../mint-inventory";

it("migrates with the shared writer, preserves other config, and reloads canonical wallet mints", async () => {
  const keys = deriveAgentMasterKeypair("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
  saveAgentWallet({
    version: WALLET_VERSION, lock_privkey: keys.privkey, lock_pubkey: keys.pubkey,
    mnemonic_fingerprint: null, mints: [], proofs: [], nut13_counters: {},
    pending_mints: [], pending_melts: [], pending_submissions: [], recent_spends: [],
    created_at: "2026-01-01T00:00:00.000Z",
  });
  await updateConfig({ reason: "fixture", patch: () => ({ set: {
    cashuMints: ["https://mint-a.invalid", "https://mint-b.invalid", "https://mint-a.invalid"],
    defaultBudget: "5000", preferredCurrency: "usd",
  } }) });
  expect(CONFIG_DIR).toBe(process.env.DVM_CONFIG_DIR);
  expect(await loadConfiguredMints()).toEqual(["https://mint-a.invalid", "https://mint-b.invalid"]);
  expect(loadConfig()).toMatchObject({ defaultBudget: "5000", preferredCurrency: "usd" });
  expect(loadConfig()?.cashuMints).toBeUndefined();
  expect(loadWalletConfiguredMints()).toEqual(loadAgentWallet()?.mints);
  expect(JSON.parse(readFileSync(WALLET_FILE, "utf8")).mints).toEqual(["https://mint-a.invalid", "https://mint-b.invalid"]);
  expect(statSync(WALLET_FILE).mode & 0o777).toBe(0o600);
  expect(statSync(CONFIG_FILE).mode & 0o777).toBe(0o600);
  const before = readFileSync(CONFIG_FILE, "utf8");
  expect(await loadConfiguredMints()).toEqual(["https://mint-a.invalid", "https://mint-b.invalid"]);
  expect(readFileSync(CONFIG_FILE, "utf8")).toBe(before);
});
