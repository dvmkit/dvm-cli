import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fsFailures = vi.hoisted(() => ({
  readCode: undefined as string | undefined,
  rename: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (fsFailures.readCode !== undefined) {
        throw Object.assign(new Error("injected read failure"), { code: fsFailures.readCode });
      }
      return Reflect.apply(actual.readFileSync, actual, args) as ReturnType<
        typeof actual.readFileSync
      >;
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (fsFailures.rename) {
        fsFailures.rename = false;
        throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
      }
      return Reflect.apply(actual.renameSync, actual, args) as ReturnType<typeof actual.renameSync>;
    },
  };
});

const alpha = {
  endpoint: "https://alpha.invalid",
  name: "Alpha",
  addedAt: 1,
};

let configRoot: string;
let originalConfigRoot: string | undefined;
let favoritesPath: string;
let favorites: typeof import("../src/lib/favorites");

describe("favorites persistence", () => {
  beforeAll(async () => {
    configRoot = mkdtempSync(join(tmpdir(), "dvm-cli-favorites-"));
    originalConfigRoot = process.env.DVM_CONFIG_DIR;
    process.env.DVM_CONFIG_DIR = configRoot;
    vi.resetModules();
    ({ FAVORITES_FILE: favoritesPath } = await import("@dvmkit/sdk/internal"));
    favorites = await import("../src/lib/favorites");
  });

  beforeEach(() => {
    fsFailures.readCode = undefined;
    fsFailures.rename = false;
    rmSync(configRoot, { recursive: true, force: true });
    mkdirSync(configRoot, { recursive: true, mode: 0o700 });
  });

  afterAll(() => {
    rmSync(configRoot, { recursive: true, force: true });
    if (originalConfigRoot === undefined) delete process.env.DVM_CONFIG_DIR;
    else process.env.DVM_CONFIG_DIR = originalConfigRoot;
  });

  it("treats a missing file as empty and preserves add, resolve, and remove semantics", async () => {
    expect(favorites.loadFavorites()).toEqual({});
    await expect(favorites.saveFavorite("alpha", alpha)).resolves.toBe(false);
    await expect(
      favorites.saveFavorite("alpha", { ...alpha, endpoint: "https://updated.invalid" })
    ).resolves.toBe(true);
    expect(favorites.resolveEndpoint("@alpha")).toBe("https://updated.invalid");
    expect(favorites.resolveEndpoint("https://literal.invalid")).toBe("https://literal.invalid");
    expect(() => favorites.resolveEndpoint("@constructor")).toThrowError(
      expect.objectContaining({ code: "unknown_favorite" })
    );
    await expect(favorites.removeFavorite("missing")).resolves.toBe(false);
    await expect(favorites.removeFavorite("alpha")).resolves.toBe(true);
    expect(favorites.loadFavorites()).toEqual({});
  });

  it("rejects corrupt state without changing its recovery bytes", async () => {
    const corrupt = '{"alpha":';
    writeFileSync(favoritesPath, corrupt);

    expect(() => favorites.loadFavorites()).toThrowError(
      expect.objectContaining({
        code: "favorites_unreadable",
        hint: expect.stringContaining("left unchanged"),
        data: expect.objectContaining({ path: favoritesPath }),
      })
    );
    await expect(favorites.saveFavorite("beta", alpha)).rejects.toMatchObject({
      code: "favorites_unreadable",
    });
    await expect(favorites.removeFavorite("alpha")).rejects.toMatchObject({
      code: "favorites_unreadable",
    });
    expect(readFileSync(favoritesPath, "utf8")).toBe(corrupt);
  });

  it("rejects malformed parsed state without replacing it", async () => {
    const malformed = JSON.stringify({ alpha: { endpoint: "https://alpha.invalid" } });
    writeFileSync(favoritesPath, malformed);

    expect(() => favorites.loadFavorites()).toThrowError(
      expect.objectContaining({ code: "favorites_unreadable" })
    );
    await expect(favorites.saveFavorite("beta", alpha)).rejects.toMatchObject({
      code: "favorites_unreadable",
    });
    expect(readFileSync(favoritesPath, "utf8")).toBe(malformed);
  });

  it("turns read failures into typed recovery errors and leaves the file untouched", () => {
    const original = JSON.stringify({ alpha });
    writeFileSync(favoritesPath, original);
    fsFailures.readCode = "EACCES";

    expect(() => favorites.loadFavorites()).toThrowError(
      expect.objectContaining({
        code: "favorites_unreadable",
        data: expect.objectContaining({ error_code: "EACCES" }),
      })
    );

    fsFailures.readCode = undefined;
    expect(readFileSync(favoritesPath, "utf8")).toBe(original);
  });

  it("keeps the previous live file when atomic publication fails", async () => {
    await favorites.saveFavorite("alpha", alpha);
    const original = readFileSync(favoritesPath, "utf8");
    fsFailures.rename = true;

    await expect(
      favorites.saveFavorite("beta", { endpoint: "https://beta.invalid", addedAt: 2 })
    ).rejects.toMatchObject({ code: "EIO" });

    expect(readFileSync(favoritesPath, "utf8")).toBe(original);
    expect(readdirSync(configRoot).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("uses a private mode for new state and preserves an existing mode", async () => {
    await favorites.saveFavorite("alpha", alpha);
    expect(statSync(favoritesPath).mode & 0o777).toBe(0o600);

    chmodSync(favoritesPath, 0o640);
    await favorites.saveFavorite("beta", { endpoint: "https://beta.invalid", addedAt: 2 });
    expect(statSync(favoritesPath).mode & 0o777).toBe(0o640);
  });

  it("serialises concurrent additions and removal without losing unrelated aliases", async () => {
    await favorites.saveFavorite("remove-me", {
      endpoint: "https://remove.invalid",
      addedAt: 0,
    });

    await Promise.all([
      favorites.removeFavorite("remove-me"),
      ...Array.from({ length: 6 }, (_, index) =>
        favorites.saveFavorite(`favorite-${String(index)}`, {
          endpoint: `https://favorite-${String(index)}.invalid`,
          addedAt: index + 1,
        })
      ),
    ]);

    const saved = favorites.loadFavorites();
    expect(saved).not.toHaveProperty("remove-me");
    expect(Object.keys(saved).sort()).toEqual(
      Array.from({ length: 6 }, (_, index) => `favorite-${String(index)}`)
    );
  });

  it("preserves forward-compatible fields while updating another alias", async () => {
    writeFileSync(
      favoritesPath,
      JSON.stringify({ alpha: { ...alpha, future: { retained: true } } }, null, 2) + "\n"
    );

    await favorites.saveFavorite("beta", { endpoint: "https://beta.invalid", addedAt: 2 });

    const saved = JSON.parse(readFileSync(favoritesPath, "utf8")) as Record<string, unknown>;
    expect(saved.alpha).toMatchObject({ future: { retained: true } });
  });
});
