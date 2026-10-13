import {
  DvmError,
} from "@dvmkit/sdk/internal";
import {
  info,
  json,
} from "../lib/output";
import {
  loadAllJobs,
} from "../lib/job-store";

import {
  deriveAlias,
  type Favorite,
  loadFavorites,
  removeFavorite,
  saveFavorite,
} from "../lib/favorites";
import { getAllProviderHistory } from "../lib/history";
import { createDvmTransport } from "../lib/transport";

export interface FavAddOptions {
  name?: string;
  human?: boolean;
}

export interface FavListOptions {
  human?: boolean;
}

export interface FavRmOptions {
  human?: boolean;
}

const ALIAS_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export async function favAdd(endpoint: string, opts: FavAddOptions): Promise<void> {
  const alias = opts.name ?? deriveAlias(endpoint);

  if (!ALIAS_RE.test(alias)) {
    throw new DvmError(
      "invalid_alias",
      `Invalid alias "${alias}".`,
      "Aliases must be lowercase alphanumeric with hyphens (e.g. my-dvm)."
    );
  }

  let providerName: string | undefined;
  const transport = createDvmTransport();
  try {
    const providerInfo = await transport.describe({ endpoint });
    providerName = providerInfo.name;
  } catch {
    // Provider unreachable — save without name
  } finally {
    transport.close();
  }

  const fav: Favorite = {
    endpoint,
    ...(providerName && { name: providerName }),
    addedAt: Date.now(),
  };

  const replaced = await saveFavorite(alias, fav);
  const verb = replaced ? "Updated" : "Saved";

  if (opts.human) {
    info(`${verb} "${alias}" → ${endpoint}`);
    if (providerName) info(`  Provider: ${providerName}`);
    info(`  Use @${alias} with --endpoint in any command.`);
  } else {
    json({
      alias,
      endpoint,
      ...(providerName && { name: providerName }),
      updated: replaced,
      hint: `Use @${alias} with --endpoint in any command.`,
    });
  }
}

/** List saved favorites, enriched with usage history from the job store. */
export function favList(opts: FavListOptions): void {
  const favs = loadFavorites();
  const entries = Object.entries(favs);

  const history = getAllProviderHistory(loadAllJobs());
  const lastUsedByEndpoint = new Map<string, number>();
  for (const h of history) {
    lastUsedByEndpoint.set(h.endpoint, h.lastUsed);
  }

  if (opts.human) {
    if (entries.length === 0) {
      info("No favorites saved. Use 'dvm fav add <endpoint>' to save one.");
      return;
    }
    info(`${entries.length} favorite(s):\n`);
    for (const [alias, fav] of entries) {
      info(`  @${alias}`);
      if (fav.name) info(`    ${fav.name}`);
      info(`    ${fav.endpoint}`);
      const lastUsed = lastUsedByEndpoint.get(fav.endpoint);
      if (lastUsed) info(`    Last used: ${new Date(lastUsed).toLocaleDateString()}`);
    }
  } else {
    json({
      favorites: entries.map(([alias, fav]) => {
        const lastUsed = lastUsedByEndpoint.get(fav.endpoint);
        return {
          alias,
          ...fav,
          ...(lastUsed && { lastUsed }),
        };
      }),
    });
  }
}

export async function favRm(name: string, opts: FavRmOptions): Promise<void> {
  const removed = await removeFavorite(name);

  if (!removed) {
    throw new DvmError(
      "unknown_favorite",
      `No favorite named "${name}".`,
      "Run 'dvm fav list' to see saved favorites."
    );
  }

  if (opts.human) {
    info(`Removed favorite "${name}".`);
  } else {
    json({
      removed: name,
      hint: `@${name} will no longer resolve.`,
    });
  }
}
