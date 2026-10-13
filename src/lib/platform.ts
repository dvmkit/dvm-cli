import { DvmError } from "@dvmkit/sdk/internal";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AuthCredentials {
  token: string;
  account: string;
}

/**
 * Resolve the platform URL without requiring a Bearer token. Used by
 * surfaces whose auth comes from elsewhere (e.g. `dvm feedback`, which signs
 * a secp256k1 envelope per submission and never carries an API key).
 */
export function getPlatformUrl(): string {
  return process.env.DVMKIT_PLATFORM_URL ?? "https://api.dvmkit.dev";
}

/** Resolve auth + platform URL, throwing if not authenticated. */
export function requireAuth(): { token: string; platformUrl: string } {
  const creds = resolveAuth();
  if (!creds) {
    throw new DvmError(
      "auth_required",
      "Not authenticated.",
      "Set DVMKIT_API_KEY or run `dvmctl auth`."
    );
  }
  return {
    token: creds.token,
    platformUrl: process.env.DVMKIT_PLATFORM_URL ?? "https://api.dvmkit.dev",
  };
}

/** Resolve auth credentials from env or config file. Env takes precedence. */
export function resolveAuth(): AuthCredentials | null {
  const envKey = process.env.DVMKIT_API_KEY;
  if (envKey) {
    return { token: envKey, account: "api-key" };
  }
  return loadAuthToken();
}

/** Save auth token to ~/.dvmctl/config.json with owner-only permissions. */
export function saveAuthToken(creds: AuthCredentials): void {
  const dir = dvmctlConfigDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const configPath = join(dir, "config.json");
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    } catch {
    }
  }
  config.auth = creds;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export function loadAuthToken(): AuthCredentials | null {
  const configPath = join(dvmctlConfigDir(), "config.json");
  if (!existsSync(configPath)) return null;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const auth = config.auth as AuthCredentials | undefined;
    if (auth?.token && auth.account) return auth;
  } catch {
  }
  return null;
}

export function clearAuthToken(): void {
  const configPath = join(dvmctlConfigDir(), "config.json");
  if (!existsSync(configPath)) return;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    delete config.auth;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  } catch {
  }
}

/**
 * Resolve which org a command runs against: an explicit `--org` first, then
 * the persistent context from `dvmctl switch`, then nothing (the platform
 * answers for the caller's own org).
 *
 * Reads and deploys both go through this, so a switched context can't apply
 * to one verb and silently skip another — that split is what made an
 * `activeOrg` of `dvmkit` return an empty fleet in .
 */
export function resolveOrgScope(opts: { org?: string } = {}): string | undefined {
  return opts.org ?? loadActiveOrg() ?? undefined;
}

export function loadActiveOrg(): string | null {
  const configPath = join(dvmctlConfigDir(), "config.json");
  if (!existsSync(configPath)) return null;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const context = config.context as { activeOrg?: string } | undefined;
    return context?.activeOrg ?? null;
  } catch {
    return null;
  }
}

export function saveActiveOrg(handle: string): void {
  const dir = dvmctlConfigDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const configPath = join(dir, "config.json");
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    } catch {
    }
  }
  const existingContext =
    typeof config.context === "object" && config.context != null
      ? (config.context as Record<string, unknown>)
      : {};
  config.context = { ...existingContext, activeOrg: handle };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/** Clear the active org context — subsequent commands run against the personal builder. */
export function clearActiveOrg(): void {
  const configPath = join(dvmctlConfigDir(), "config.json");
  if (!existsSync(configPath)) return;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    if (typeof config.context === "object" && config.context != null) {
      const context = config.context as Record<string, unknown>;
      delete context.activeOrg;
      if (Object.keys(context).length === 0) delete config.context;
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  } catch {
  }
}


function dvmctlConfigDir(): string {
  return process.env.DVMCTL_CONFIG_DIR ?? join(homedir(), ".dvmctl");
}
