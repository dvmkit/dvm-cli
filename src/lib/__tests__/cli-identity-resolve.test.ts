import { rmSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveSigningIdentity } from "../cli-identity-resolve";
import { type CliIdentityEntry, cliIdentityStoreGenerateIdentity as generateIdentity, IDENTITIES_VERSION, saveIdentities } from "@dvmkit/sdk/internal";

let tmp: string;

const ORIGINAL_ENV_KEY = process.env.DVM_IDENTITY_KEY;

beforeEach(() => {
  tmp = process.env.DVM_CONFIG_DIR!;
  rmSync(join(tmp, "identities.json"), { force: true });
  delete process.env.DVM_IDENTITY_KEY;
});

afterEach(() => {
  rmSync(join(tmp, "identities.json"), { force: true });
  if (ORIGINAL_ENV_KEY === undefined) delete process.env.DVM_IDENTITY_KEY;
  else process.env.DVM_IDENTITY_KEY = ORIGINAL_ENV_KEY;
});

function seedIdentities(entries: Record<string, CliIdentityEntry>) {
  saveIdentities({ version: IDENTITIES_VERSION, identities: entries });
}

describe("resolveSigningIdentity", () => {
  it("branch 1: --as <name> wins over everything else", () => {
    const a = generateIdentity(1);
    const b = generateIdentity(2);
    seedIdentities({ a, b });
    process.env.DVM_IDENTITY_KEY = generateIdentity(3).privkey;

    const resolved = resolveSigningIdentity({
      as: "b",
      config: { defaultIdentity: "a" },
    });
    expect(resolved.privkey).toBe(b.privkey);
    expect(resolved.source).toEqual({ kind: "flag", name: "b" });
  });

  it("branch 1: --as <missing> throws auth_required and lists available identities", () => {
    seedIdentities({ a: generateIdentity(1) });
    expect(() => resolveSigningIdentity({ as: "missing" })).toThrow(
      expect.objectContaining({ code: "auth_required" })
    );
  });

  it("branch 2: DVM_IDENTITY_KEY wins over stored default", () => {
    const stored = generateIdentity(1);
    seedIdentities({ default: stored });
    const env = generateIdentity(2);
    process.env.DVM_IDENTITY_KEY = env.privkey;

    const resolved = resolveSigningIdentity({
      config: { defaultIdentity: "default" },
    });
    expect(resolved.privkey).toBe(env.privkey);
    expect(resolved.source).toEqual({ kind: "env" });
  });

  it("branch 3: config.defaultIdentity selects when set and no flag/env", () => {
    const a = generateIdentity(1);
    const b = generateIdentity(2);
    seedIdentities({ a, b });

    const resolved = resolveSigningIdentity({ config: { defaultIdentity: "b" } });
    expect(resolved.privkey).toBe(b.privkey);
    expect(resolved.source).toEqual({ kind: "default", name: "b" });
  });

  it("branch 3: stale defaultIdentity (entry deleted) throws auth_required", () => {
    seedIdentities({ a: generateIdentity(1) });
    expect(() => resolveSigningIdentity({ config: { defaultIdentity: "gone" } })).toThrow(
      expect.objectContaining({ code: "auth_required" })
    );
  });

  it("branch 4: sole entry auto-uses without ceremony", () => {
    const a = generateIdentity(1);
    seedIdentities({ only: a });

    const resolved = resolveSigningIdentity({});
    expect(resolved.privkey).toBe(a.privkey);
    expect(resolved.source).toEqual({ kind: "sole", name: "only" });
  });

  it("branch 5: zero identities throws auth_required pointing at 'dvm identity create'", () => {
    expect(() => resolveSigningIdentity({})).toThrow(
      expect.objectContaining({ code: "auth_required" })
    );
  });

  it("branch 5: multiple identities with no selection throws and lists them", () => {
    seedIdentities({ a: generateIdentity(1), b: generateIdentity(2) });
    expect(() => resolveSigningIdentity({})).toThrow(
      expect.objectContaining({
        code: "auth_required",
      })
    );
  });
});
