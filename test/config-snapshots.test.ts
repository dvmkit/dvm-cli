import { CONFIG_BACKUP_FILE, CONFIG_FILE, CONFIG_PINNED_FILE } from "@dvmkit/sdk/internal";
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configReset } from "../src/commands/config";
import { readConfigBackup } from "../src/lib/config-mutation";
import {
  authorizeProtectedRemoval,
  type ConfigPatch,
  ensureConfig,
  loadConfig,
  pinConfigSnapshot,
  updateConfig,
} from "../src/lib/identity";
import * as output from "../src/lib/output";

const settings = { defaultBudget: "$1" };
const original = { ...settings, nwcUri: "nostr+walletconnect://previous" };
const replacement = { ...settings, nwcUri: "nostr+walletconnect://replacement" };

beforeEach(() => {
  for (const path of [CONFIG_FILE, CONFIG_BACKUP_FILE, CONFIG_PINNED_FILE]) {
    rmSync(path, { force: true });
  }
});

describe.each([
  {
    operation: "removing a credential",
    patch: { unset: ["nwcUri"] } satisfies ConfigPatch,
    authorize: authorizeProtectedRemoval("nwcUri"),
    live: settings,
  },
  {
    operation: "rotating a credential",
    patch: { set: { nwcUri: replacement.nwcUri } } satisfies ConfigPatch,
    authorize: undefined,
    live: replacement,
  },
])("$operation", ({ patch, authorize, live }) => {
  it.each([
    { label: "omitted", options: {}, pinned: settings },
    { label: "false", options: { preservePin: false }, pinned: settings },
    { label: "true", options: { preservePin: true }, pinned: original },
  ])("sanitizes the rolling backup and honors preservePin when $label", async ({ options, pinned }) => {
    await ensureConfig(original);
    await pinConfigSnapshot("config_snapshot_test");

    await updateConfig({ reason: "config_snapshot_test", patch: () => patch, authorize, ...options });

    expect(loadConfig()).toEqual(live);
    expect(readConfigBackup("backup")).toEqual(settings);
    expect(readConfigBackup("pinned")).toEqual(pinned);
  });
});

it("requires authorization to remove a credential when preserving the pin", async () => {
  await ensureConfig(original);
  await pinConfigSnapshot("config_snapshot_test");

  await expect(
    updateConfig({
      reason: "config_snapshot_test",
      preservePin: true,
      patch: () => ({ unset: ["nwcUri"] }),
    })
  ).rejects.toMatchObject({ code: "config_protected_field" });

  expect(loadConfig()).toEqual(original);
  expect(readConfigBackup("backup")).toBeNull();
  expect(readConfigBackup("pinned")).toEqual(original);
});

describe("config reset", () => {
  it("clears settings and pins the pre-reset configuration", async () => {
    const beforeReset = { ...settings, defaultIdentity: "default" };
    await ensureConfig(beforeReset);
    vi.spyOn(output, "json").mockImplementation(() => undefined);

    await configReset({ yes: true });

    expect(loadConfig()).toEqual({ defaultIdentity: "default" });
    expect(readConfigBackup("pinned")).toEqual(beforeReset);
  });

  it("refuses a reset while a wallet is connected", async () => {
    await ensureConfig(original);

    await expect(configReset({ yes: true })).rejects.toMatchObject({ code: "config_reset_blocked" });

    expect(loadConfig()).toEqual(original);
    expect(readConfigBackup("pinned")).toBeNull();
  });
});
