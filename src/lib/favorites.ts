import { DvmError, ensureConfigDir, FAVORITES_FILE } from "@dvmkit/sdk/internal";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import lockfile from "proper-lockfile";

const DEFAULT_FILE_MODE = 0o600;

export interface Favorite {
  endpoint: string;
  /** Human-readable provider name (from /v1/info at save time). */
  name?: string;
  /** When this favorite was saved (unix ms). */
  addedAt: number;
}

export type FavoritesMap = Record<string, Favorite>;

/** Load favorites from disk, returning an empty map only when the file is missing. */
export function loadFavorites(): FavoritesMap {
  let raw: string;
  try {
    raw = readFileSync(FAVORITES_FILE, "utf8");
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return {};
    throw unreadableFavorites(error);
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isFavoritesMap(parsed)) throw new Error("invalid favorites shape");
    return parsed;
  } catch (error) {
    throw unreadableFavorites(error);
  }
}

/** Save a favorite under the given alias. Returns true if it replaced an existing one. */
export async function saveFavorite(alias: string, fav: Favorite): Promise<boolean> {
  return withFavoritesLock(() => {
    const favs = loadFavorites();
    const existed = Object.hasOwn(favs, alias);
    favs[alias] = fav;
    writeFavorites(favs);
    return existed;
  });
}

/** Remove a favorite by alias. Returns true if it existed. */
export async function removeFavorite(alias: string): Promise<boolean> {
  return withFavoritesLock(() => {
    const favs = loadFavorites();
    if (!Object.hasOwn(favs, alias)) return false;
    const { [alias]: _, ...rest } = favs;
    writeFavorites(rest);
    return true;
  });
}

/**
 * Resolve an endpoint string: if it starts with `@`, look up the alias in
 * favorites and return the stored endpoint. Otherwise return the input unchanged.
 */
export function resolveEndpoint(input: string): string {
  if (!input.startsWith("@")) return input;

  const alias = input.slice(1);
  const favs = loadFavorites();
  const fav = Object.hasOwn(favs, alias) ? favs[alias] : undefined;
  if (!fav) {
    throw new DvmError(
      "unknown_favorite",
      `No favorite named "${alias}".`,
      "Run 'dvm fav list' to see saved favorites, or 'dvm fav add <endpoint>' to save one."
    );
  }

  return fav.endpoint;
}

/**
 * Derive a default alias from an endpoint URL.
 *
 * For `*.dvmkit.ai` URLs like `https://builder--scribe.dvmkit.ai`,
 * extracts the slug after `--` (e.g. `scribe`).
 * Otherwise uses the hostname with dots replaced by hyphens.
 *
 * There is deliberately no `dvmkit-<x>.fly.dev` case. A platform Fly app is
 * named from the DVM's UUID, so stripping the prefix off one yields
 * a UUID, not a name anyone would type — the generic hostname rule gives a
 * worse-looking but honest alias, and the caller can always pass `--alias`.
 */
export function deriveAlias(endpoint: string): string {
  try {
    const hostname = new URL(endpoint).hostname;

    if (hostname.endsWith(".dvmkit.ai")) {
      const prefix = hostname.replace(".dvmkit.ai", "");
      const dashIdx = prefix.indexOf("--");
      if (dashIdx !== -1) return prefix.slice(dashIdx + 2);
      return prefix;
    }

    return hostname.replace(/\.[^.]+$/, "").replace(/\./g, "-");
  } catch {
    return endpoint.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  }
}

async function withFavoritesLock<T>(fn: () => Promise<T> | T): Promise<T> {
  ensureConfigDir();
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(FAVORITES_FILE, {
      lockfilePath: `${FAVORITES_FILE}.lock`,
      realpath: false,
      stale: 30_000,
      retries: { retries: 10, factor: 1, minTimeout: 100, maxTimeout: 100 },
    });
  } catch {
    throw new DvmError(
      "favorites_locked",
      "Another dvm process is updating saved favorites.",
      "Wait a moment and retry."
    );
  }

  try {
    return await fn();
  } finally {
    await release().catch(() => undefined);
  }
}

function writeFavorites(favorites: FavoritesMap): void {
  const mode = favoritesFileMode();
  const temporary = `${FAVORITES_FILE}.${String(process.pid)}.${randomSuffix()}.tmp`;
  const contents = JSON.stringify(favorites, null, 2) + "\n";
  let fd: number | undefined;

  try {
    fd = openSync(temporary, "wx", mode);
    fchmodSync(fd, mode);
    writeFileSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, FAVORITES_FILE);
    fsyncDirectory(dirname(FAVORITES_FILE));
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
    }
    throw error;
  }
}

function favoritesFileMode(): number {
  try {
    return statSync(FAVORITES_FILE).mode & 0o777;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return DEFAULT_FILE_MODE;
    throw error;
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function randomSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function unreadableFavorites(error: unknown): DvmError {
  return new DvmError(
    "favorites_unreadable",
    "Saved favorites are corrupt or unreadable.",
    `The original file at ${FAVORITES_FILE} was left unchanged. Restore it from a backup, or move it aside before rebuilding favorites.`,
    {
      path: FAVORITES_FILE,
      ...(nodeErrorCode(error) ? { error_code: nodeErrorCode(error) } : {}),
    }
  );
}

function nodeErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && /^E[A-Z0-9_]{1,63}$/.test(code) ? code : undefined;
}

function isFavoritesMap(value: unknown): value is FavoritesMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(isFavorite);
}

function isFavorite(value: unknown): value is Favorite {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.endpoint === "string" &&
    typeof candidate.addedAt === "number" &&
    Number.isFinite(candidate.addedAt) &&
    (candidate.name === undefined || typeof candidate.name === "string")
  );
}
