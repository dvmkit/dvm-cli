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

import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "fs";

import { applyConfigPatch, assertValidConfig, authorizeProtectedRemoval, changedConfigPaths, deepFreezeConfig, isSecretProtectedTarget, protectedRemovals, protectedTargetValue, protectedValuesMatch, supersededProtectedSecrets, withoutProtectedTargets, writeConfigFile } from "../config-mutation";
import { DvmError } from "@dvmkit/sdk/internal";
import type { Config } from "../identity";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyConfigPatch", () => {
  const base = {
    nwcUri: "nostr+walletconnect://kept",
    defaultBudget: "$1",
    futureRail: { token: "kept" },
  } as unknown as Config;

  it("merges the declared fields and leaves every other one alone", () => {
    const next = applyConfigPatch(base, { set: { defaultBudget: "$2" } });
    expect(next).toEqual({
      nwcUri: "nostr+walletconnect://kept",
      defaultBudget: "$2",
      futureRail: { token: "kept" },
    });
  });

  it("removes only the fields named for removal", () => {
    expect(applyConfigPatch(base, { unset: ["defaultBudget"] })).toEqual({
      nwcUri: "nostr+walletconnect://kept",
      futureRail: { token: "kept" },
    });
  });

  it("refuses a field declared with no value — the way fields get dropped", () => {
    expect(() => applyConfigPatch(base, { set: { defaultBudget: undefined } })).toThrow(
      expect.objectContaining({ code: "config_patch_invalid" })
    );
    try {
      applyConfigPatch(base, { set: { defaultBudget: undefined } });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DvmError);
      expect((err as DvmError).hint).toContain("unset");
    }
  });

  it("refuses a field both written and removed by one change", () => {
    expect(() =>
      applyConfigPatch(base, { set: { defaultBudget: "$2" }, unset: ["defaultBudget"] })
    ).toThrow(expect.objectContaining({ code: "config_patch_invalid" }));
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an array", []],
    ["a set that is not an object", { set: "nope" }],
    ["an unset that is not an array", { unset: "nwcUri" }],
    ["an unset entry that is not a field name", { unset: [7] }],
  ])("refuses %s rather than throwing out of the taxonomy", (_label, patch) => {
    expect(() => applyConfigPatch(base, patch as never)).toThrow(
      expect.objectContaining({ code: "config_patch_invalid" })
    );
  });
});

const configured: Config = {
  nwcUri: "nostr+walletconnect://x",
  defaultIdentity: "default",
  tempo: { method: "tempo", apiKey: "0xkey" },
  x402: { privateKey: "0xkey", network: "eip155:8453" },
};

describe("protectedRemovals", () => {
  it("names every credential and identity pointer a whole-config replacement drops", () => {
    expect(protectedRemovals(configured, {})).toEqual([
      "nwcUri",
      "defaultIdentity",
      "tempo",
      "x402",
    ]);
  });

  it("reads whitespace as destruction too — a wallet cannot be reached through it", () => {
    expect(
      protectedRemovals(configured, {
        ...configured,
        nwcUri: "   ",
        tempo: { method: "tempo", apiKey: "\t" },
      })
    ).toEqual(["nwcUri", "tempo.apiKey"]);
  });

  it("reads an empty-string overwrite as the removal it is", () => {
    expect(
      protectedRemovals(configured, {
        ...configured,
        nwcUri: "",
        defaultIdentity: "",
        tempo: { method: "tempo", apiKey: "" },
        x402: { privateKey: "", network: "eip155:8453" },
      })
    ).toEqual(["nwcUri", "defaultIdentity", "tempo.apiKey", "x402.privateKey"]);
  });

  it("reports a lost credential by its own path, not as the whole block", () => {
    const rebuilt = { ...configured, tempo: { method: "tempo" } } as unknown as Config;
    expect(protectedRemovals(configured, rebuilt)).toEqual(["tempo.apiKey"]);
  });

  it("catches a rebuild that keeps the field and destroys the key inside it", () => {
    const rebuilt = { ...configured, x402: { network: "eip155:137" } } as unknown as Config;
    expect(protectedRemovals(configured, rebuilt)).toEqual(["x402.privateKey"]);
  });

  it("treats rotating a key in place as no removal at all", () => {
    expect(
      protectedRemovals(configured, {
        ...configured,
        x402: { privateKey: "0xrotated", network: "eip155:8453" },
      })
    ).toEqual([]);
  });

  it("leaves descriptive connection metadata unprotected", () => {
    const withFloat: Config = { ...configured, float: { connectedAt: "2026-08-01T00:00:00.000Z" } };
    expect(protectedRemovals(withFloat, configured)).toEqual([]);
  });
});

describe("supersededProtectedSecrets", () => {
  it("names a rotated credential by its own path", () => {
    expect(
      supersededProtectedSecrets(configured, {
        ...configured,
        x402: { privateKey: "0xrotated", network: "eip155:8453" },
      })
    ).toEqual(["x402.privateKey"]);
  });

  it("names a replaced connection string", () => {
    expect(
      supersededProtectedSecrets(configured, { ...configured, nwcUri: "nostr+walletconnect://y" })
    ).toEqual(["nwcUri"]);
  });

  it("does not treat re-pinning a chain as superseding the key", () => {
    expect(
      supersededProtectedSecrets(configured, {
        ...configured,
        x402: { privateKey: "0xkey", network: "eip155:137" },
      })
    ).toEqual([]);
  });

  it("leaves the identity pointer out of it", () => {
    expect(
      supersededProtectedSecrets(configured, { ...configured, defaultIdentity: "alt" })
    ).toEqual([]);
  });
});

describe("authorizeProtectedRemoval", () => {
  it("covers only the fields it names", () => {
    const auth = authorizeProtectedRemoval("nwcUri");
    expect(auth.covers("nwcUri")).toBe(true);
    expect(auth.covers("x402")).toBe(false);
  });

  it("naming a field covers the credential inside it", () => {
    const auth = authorizeProtectedRemoval("tempo");
    expect(auth.covers("tempo.apiKey")).toBe(true);
  });

  it("naming a credential does not cover the block it sits in", () => {
    const auth = authorizeProtectedRemoval("tempo.apiKey");
    expect(auth.covers("tempo.apiKey")).toBe(true);
    expect(auth.covers("tempo")).toBe(false);
  });

  it("covers every protected field when every one is named", () => {
    const auth = authorizeProtectedRemoval("nwcUri", "defaultIdentity", "tempo", "x402");
    for (const field of ["nwcUri", "defaultIdentity", "tempo", "x402"]) {
      expect(auth.covers(field)).toBe(true);
    }
  });
});

describe("protectedTargetValue", () => {
  it("resolves a field target to the credential inside it", () => {
    expect(protectedTargetValue(configured, "tempo")).toBe("0xkey");
    expect(protectedTargetValue(configured, "x402")).toBe("0xkey");
  });

  it("resolves a leaf target to itself", () => {
    expect(protectedTargetValue(configured, "tempo.apiKey")).toBe("0xkey");
  });

  it("resolves a field with no credential inside to its own value", () => {
    expect(protectedTargetValue(configured, "nwcUri")).toBe("nostr+walletconnect://x");
    expect(protectedTargetValue(configured, "defaultIdentity")).toBe("default");
  });

  it("reports nothing for a field the config does not hold", () => {
    expect(protectedTargetValue({}, "tempo")).toBeUndefined();
  });
});

describe("protectedValuesMatch", () => {
  it("reads two casings of a hex key as the same key", () => {
    expect(protectedValuesMatch("tempo", "0xABCD", "0xabcd")).toBe(true);
    expect(protectedValuesMatch("x402.privateKey", "0xABCD", "0xabcd")).toBe(true);
  });

  it("ignores surrounding whitespace", () => {
    expect(
      protectedValuesMatch("nwcUri", "nostr+walletconnect://x", " nostr+walletconnect://x ")
    ).toBe(true);
  });

  it("does not case-fold a connection string", () => {
    expect(
      protectedValuesMatch("nwcUri", "nostr+walletconnect://X", "nostr+walletconnect://x")
    ).toBe(false);
  });

  it("matches nothing when either side is absent or blank", () => {
    expect(protectedValuesMatch("nwcUri", undefined, undefined)).toBe(false);
    expect(protectedValuesMatch("nwcUri", "   ", "   ")).toBe(false);
    expect(protectedValuesMatch("tempo", "0xabcd", undefined)).toBe(false);
  });

  it("keeps two genuinely different keys apart", () => {
    expect(protectedValuesMatch("tempo", "0xabcd", "0xabce")).toBe(false);
  });
});

describe("isSecretProtectedTarget", () => {
  it("is true for the three rails' credentials", () => {
    for (const target of ["nwcUri", "tempo", "x402", "tempo.apiKey", "x402.privateKey"] as const) {
      expect(isSecretProtectedTarget(target)).toBe(true);
    }
  });

  it("is false for the identity pointer", () => {
    expect(isSecretProtectedTarget("defaultIdentity")).toBe(false);
  });
});

describe("withoutProtectedTargets", () => {
  it("drops the block a named credential sits in", () => {
    expect(withoutProtectedTargets(configured, ["x402.privateKey"])).toEqual({
      nwcUri: "nostr+walletconnect://x",
      defaultIdentity: "default",
      tempo: { method: "tempo", apiKey: "0xkey" },
    });
  });

  it("drops the legacy name a field may still be spelled with", () => {
    const legacy = {
      mpp: { method: "tempo", apiKey: "0xkey" },
      defaultBudget: "$1",
    } as unknown as Config;
    expect(withoutProtectedTargets(legacy, ["tempo"])).toEqual({ defaultBudget: "$1" });
  });
});

describe("deepFreezeConfig", () => {
  it("refuses an in-place edit of a nested credential", () => {
    const frozen = deepFreezeConfig(structuredClone(configured));
    expect(() => {
      delete (frozen.tempo as { apiKey?: string }).apiKey;
    }).toThrow(TypeError);
  });

  it("refuses an in-place removal of a top-level field", () => {
    const frozen = deepFreezeConfig(structuredClone(configured));
    expect(() => {
      delete frozen.nwcUri;
    }).toThrow(TypeError);
  });
});

describe("changedConfigPaths", () => {
  it("descends into known structures", () => {
    expect(
      changedConfigPaths(
        { x402: { privateKey: "0xa", network: "eip155:8453" } },
        { x402: { privateKey: "0xa", network: "eip155:137" } }
      )
    ).toEqual(["x402.network"]);
  });

  it("elides the DVM origin from a per-DVM policy path", () => {
    expect(
      changedConfigPaths(
        { credit: { perDvm: { "https://scrape.example": { posture: "suggest" } } } },
        { credit: { perDvm: { "https://scrape.example": { posture: "auto" } } } }
      )
    ).toEqual(["credit.perDvm.*.posture"]);
  });

  it("names a stamped DVM identity without naming the DVM", () => {
    expect(
      changedConfigPaths(
        { credit: { perDvm: { "https://scrape.example": { posture: "off" } } } },
        {
          credit: {
            perDvm: {
              "https://scrape.example": {
                posture: "off",
                dvmId: "dvm-scrape",
                builderPubkey: "ab".repeat(32),
              },
            },
          },
        }
      )
    ).toEqual(["credit.perDvm.*.builderPubkey", "credit.perDvm.*.dvmId"]);
  });

  it("elides the builder pubkey from a trust pre-grant path", () => {
    expect(
      changedConfigPaths(
        { credit: {} },
        { credit: { trustOverrides: { ["ab".repeat(32)]: "$50" } } }
      )
    ).toEqual(["credit.trustOverrides.*"]);
  });

  it("names an unknown field without descending into a shape it cannot read", () => {
    expect(
      changedConfigPaths({}, { futureRail: { token: "secret" } } as unknown as Config)
    ).toEqual(["futureRail"]);
  });

  it("reports nothing for an unchanged config", () => {
    const config: Config = { credit: { perDvm: { "https://a.example": { targetJobs: 3 } } } };
    expect(changedConfigPaths(config, { ...config })).toEqual([]);
  });
});

describe("assertValidConfig", () => {
  it("accepts the legacy Tempo shape with no network", () => {
    expect(() =>
      assertValidConfig({ tempo: { method: "tempo", apiKey: "0xkey" } })
    ).not.toThrow();
  });

  it("rejects an unsupported Tempo network", () => {
    expect(() =>
      assertValidConfig({
        tempo: { method: "tempo", network: "devnet" },
      } as unknown as Config)
    ).toThrow(/tempo\.network.*mainnet.*moderato/);
  });

  it("refuses a field the CLI could not read back", () => {
    expect(() => {
      assertValidConfig({ defaultMaxPayments: "5" } as unknown as Config);
    }).toThrow(expect.objectContaining({ code: "config_invalid" }));
  });

  it("refuses an x402 block with no key in it", () => {
    expect(() => {
      assertValidConfig({ x402: { network: "eip155:8453" } } as unknown as Config);
    }).toThrow(expect.objectContaining({ code: "config_invalid" }));
  });

  it("leaves a field outside the change's scope alone, so one bad field cannot brick the rest", () => {
    expect(() => {
      assertValidConfig({ defaultMaxPayments: "5", defaultBudget: "$1" } as unknown as Config, [
        "defaultBudget",
      ]);
    }).not.toThrow();
  });

  it("accepts an unknown field, which this build must round-trip rather than judge", () => {
    expect(() => {
      assertValidConfig({ futureRail: { token: "x" } } as unknown as Config);
    }).not.toThrow();
  });
});

describe("writeConfigFile", () => {
  it("writes a temp file owner-only and renames it into place", () => {
    writeConfigFile({ nwcUri: "nostr+walletconnect://x" });

    expect(mkdirSync).toHaveBeenCalledWith(process.env.DVM_CONFIG_DIR, { recursive: true, mode: 0o700 });
    expect(writeFileSync).toHaveBeenCalledWith(
      "/mock/.dvm/config.json.tmp",
      JSON.stringify({ nwcUri: "nostr+walletconnect://x" }, null, 2) + "\n",
      { mode: 0o600 }
    );
    // `writeFileSync`'s mode only applies to a file it creates, so a temp left
    // by an earlier crash would otherwise carry its mode onto the config.
    expect(chmodSync).toHaveBeenCalledWith("/mock/.dvm/config.json.tmp", 0o600);
    expect(renameSync).toHaveBeenCalledWith("/mock/.dvm/config.json.tmp", "/mock/.dvm/config.json");
  });

  it("cleans up the temp file when the rename fails", () => {
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("rename failed");
    });
    expect(() => {
      writeConfigFile({});
    }).toThrow("rename failed");
    expect(unlinkSync).toHaveBeenCalledWith("/mock/.dvm/config.json.tmp");
  });

});
