vi.mock("@dvmkit/sdk/internal", async () => {
 const actual = await vi.importActual<typeof import("@dvmkit/sdk/internal")>("@dvmkit/sdk/internal");
 return { ...actual, CONFIG_DIR: "/mock/.dvm",
CONFIG_FILE: "/mock/.dvm/config.json",
CONFIG_BACKUP_FILE: "/mock/.dvm/config.json.bak",
CONFIG_PINNED_FILE: "/mock/.dvm/config.json.pinned",
CONFIG_AUDIT_FILE: "/mock/.dvm/config-audit.jsonl" };
});
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("fs");

import { existsSync, readFileSync } from "fs";

import { DvmError } from "@dvmkit/sdk/internal";
import { loadConfig, migrateCreditConfig } from "../identity";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadConfig", () => {
  it("returns null when file does not exist", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(loadConfig()).toBeNull();
  });

  it("returns parsed config when file exists", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const config = { nwcUri: "nostr+walletconnect://..." };
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(config));
    expect(loadConfig()).toEqual(config);
  });

  it("throws DvmError on corrupt JSON", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("not valid json{{{");
    try {
      loadConfig();
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DvmError);
      expect((e as DvmError).code).toBe("config_corrupt");
    }
  });
});

/**
 * folded the `credit.disabled` switch into the consent posture. The
 * rule that matters is "no second switch survives": a later reader must never
 * find two fields that can disagree about whether credit is on.
 */
describe("credit posture migration", () => {
  function load(raw: unknown): ReturnType<typeof loadConfig> {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(raw));
    return loadConfig();
  }

  it("reads a pre-posture `disabled: true` as `posture: off`, at both layers", () => {
    const config = load({
      credit: {
        disabled: true,
        targetJobs: 40,
        perDvm: { "https://scrape.example": { disabled: true, targetJobs: 5 } },
      },
    });
    expect(config?.credit).toEqual({
      posture: "off",
      targetJobs: 40,
      perDvm: { "https://scrape.example": { posture: "off", targetJobs: 5 } },
    });
  });

  it("drops `disabled: false` without inventing a posture — that caller never chose one", () => {
    const config = load({ credit: { disabled: false, tier0Cap: "$1" } });
    expect(config?.credit).toEqual({ tier0Cap: "$1" });
  });

  it("an explicit posture wins over a stale `disabled` beside it", () => {
    const config = load({ credit: { disabled: true, posture: "auto" } });
    expect(config?.credit).toEqual({ posture: "auto" });
  });

  it("leaves a config with no credit block alone", () => {
    expect(migrateCreditConfig({ nwcUri: "nostr+walletconnect://x" })).toEqual({
      nwcUri: "nostr+walletconnect://x",
    });
  });
});

describe("mpp → tempo config migration", () => {
  function load(raw: unknown): ReturnType<typeof loadConfig> {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(raw));
    return loadConfig();
  }

  it("moves a connected wallet off the `mpp` key", () => {
    // The key holds the caller's private key and nothing else on disk records
    // it, so missing this silently disconnects every pre-rename Tempo wallet.
    const config = load({ mpp: { method: "tempo", apiKey: "sk-test" } });
    expect(config?.tempo).toEqual({ method: "tempo", apiKey: "sk-test" });
    expect(config).not.toHaveProperty("mpp");
  });

  it("keeps an already-migrated `tempo` wallet when a stale `mpp` sits beside it", () => {
    const config = load({
      mpp: { method: "tempo", apiKey: "sk-stale" },
      tempo: { method: "tempo", apiKey: "sk-current" },
    });
    expect(config?.tempo).toEqual({ method: "tempo", apiKey: "sk-current" });
  });

  it("repoints a pinned fundingRail at both layers", () => {
    // `mpp` is no longer a member of `CREDIT_FUND_RAILS`, so an unmigrated pin
    // matches no rail and `dvm doctor` reports the caller's own config invalid.
    const config = load({
      credit: {
        fundingRail: "mpp",
        perDvm: { "https://scrape.example": { fundingRail: "mpp", targetJobs: 5 } },
      },
    });
    expect(config?.credit).toEqual({
      fundingRail: "tempo",
      perDvm: { "https://scrape.example": { fundingRail: "tempo", targetJobs: 5 } },
    });
  });

  it("leaves a pin on another rail alone", () => {
    expect(load({ credit: { fundingRail: "lightning" } })?.credit).toEqual({
      fundingRail: "lightning",
    });
  });
});
