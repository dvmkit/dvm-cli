/**
 * The wallet bench for the agent's Lightning float.
 *
 * A float is a wallet an autonomous agent spends from without a human present,
 * so the selection criteria are narrower than "is this a good Lightning wallet":
 * it has to be **always on** (a wallet that sleeps with a phone can't answer),
 * and it has to enforce a **spending cap on the connection itself**, so the
 * ceiling lives somewhere the agent can't edit.
 *
 * Ordering and warnings here are backed by our own probe data and by reading
 * vendor source — see `docs/wallets.md` for the evidence trail. Nothing is
 * recommended for the float role that we haven't checked.
 */

export interface WalletOption {
  type: "nwc";
  name: string;
  description: string;
  url?: string;
  custodial: boolean;
  /**
   * Whether this wallet is vetted for the float role. Only `recommended`
   * entries are offered as float wallets; the rest stay listed so someone who
   * already uses one can connect it knowingly.
   */
  role: "recommended" | "other";
  /** Whether the wallet enforces a spending cap on an NWC connection. */
  budgetSupport: "verified" | "unverified";
  alwaysOn: "yes" | "depends" | "no";
  warning?: string;
  comparison?: string;
}

/**
 * Wallet options for the setup wizard, in display order.
 *
 * Alby Hub leads: self-custodial, per-connection budgets by period, and
 * sub-wallets with isolated balances — the closest thing to a purpose-built
 * agent primitive on the bench. Coinos is kept for the two-minute path but
 * carries its outage record. Strike is listed because people already hold BTC
 * there, not because it's been checked for this job.
 */
export const WALLET_OPTIONS: WalletOption[] = [
  {
    type: "nwc",
    name: "Alby Hub",
    description:
      "Self-custodial Lightning node with per-connection spending budgets — the recommended home for an agent float",
    url: "https://albyhub.com",
    custodial: false,
    role: "recommended",
    budgetSupport: "verified",
    alwaysOn: "depends",
    warning:
      "Self-host it for anything you depend on. Alby's hosted cloud is fine for a casual float but has had multi-hour outages, including one that took Nostr Wallet Connect down for nearly five hours in July 2026.",
    comparison:
      "Requires running (or renting) a node; budgets and permissions are set per connection",
  },
  {
    type: "nwc",
    name: "Coinos",
    description:
      "Custodial web wallet — the two-minute path to a working float, with spending budgets built in",
    url: "https://coinos.io",
    custodial: true,
    role: "recommended",
    budgetSupport: "verified",
    alwaysOn: "yes",
    warning:
      "Treat it as capped pocket money. It holds your funds for you, publishes no status page, and our own monitoring has seen multi-day outages go unannounced — roughly 93% availability of its ecash subsystem between May and July 2026.",
    comparison: "Fastest to set up; custodial, so only keep small amounts in it",
  },
  {
    type: "nwc",
    name: "Strike",
    description:
      "Lightning wallet with a built-in fiat on-ramp — buy bitcoin with a bank account or debit card",
    url: "https://strike.me",
    custodial: true,
    role: "other",
    budgetSupport: "unverified",
    alwaysOn: "yes",
    warning:
      "Good place to buy bitcoin, but we have not verified that it can cap spending on an automated connection — so we don't recommend it as the wallet your agent spends from.",
    comparison: "Use it to buy, then move funds to a wallet with a verified spending cap",
  },
];

export const NWC_WALLETS = WALLET_OPTIONS;

export const FLOAT_WALLETS = WALLET_OPTIONS.filter((w) => w.role === "recommended");

/**
 * Wallets that cannot hold a float, and the two independent ways we recognise
 * one.
 *
 * Two failure modes, both fatal for autonomous funding but neither worth a hard
 * block — someone may be testing, and a heuristic that guesses wrong shouldn't
 * stop them: the wallet service sleeps with a phone, or the wallet itself is
 * ephemeral and deletes your funds.
 *
 * `hosts` are domains the wallet service *operates*, matched against the relay
 * URL's hostname as a suffix. General-purpose Nostr relays never belong here,
 * however strongly they suggest a wallet: `relay.primal.net` is a public relay
 * that a self-hosted Alby Hub can legitimately be pointed at, so Primal is
 * recognised by its alias alone. `aliases` are matched as whole tokens of the
 * wallet's self-reported name, never as substrings.
 */
const UNSUITABLE_WALLETS: { hosts: string[]; aliases: string[]; reason: string }[] = [
  {
    hosts: ["lncurl.lol"],
    aliases: ["lncurl", "lncurl.lol"],
    reason:
      "lncurl.lol wallets delete themselves after a period of inactivity, taking any balance with them. Don't put a float here.",
  },
  {
    hosts: [],
    aliases: ["zeus"],
    reason: "Zeus runs on your phone — the wallet is unreachable whenever the phone sleeps.",
  },
  {
    hosts: [],
    aliases: ["primal"],
    reason: "Primal's wallet runs on your phone — it can't answer while the phone is asleep.",
  },
  {
    hosts: [],
    aliases: ["blitz"],
    reason: "Blitz is a phone wallet — it can't answer while the phone is asleep.",
  },
  {
    hosts: [],
    aliases: ["flash"],
    reason: "Flash is a phone wallet — it can't answer while the phone is asleep.",
  },
  {
    hosts: ["minibits.cash"],
    aliases: ["minibits"],
    reason:
      "Minibits is a phone wallet backed by ecash — it can't answer while the phone is asleep.",
  },
  {
    hosts: [],
    aliases: ["cashu.me", "cashume"],
    reason:
      "Cashu.me is a browser ecash wallet — it only exists while the tab is open, so it can't fund an agent.",
  },
  {
    hosts: ["nutstash.app"],
    aliases: ["nutstash"],
    reason:
      "Nutstash is a browser ecash wallet — it only exists while the tab is open, so it can't fund an agent.",
  },
];

/**
 * Flag a connection that looks like it belongs to a wallet class which can't
 * hold a float. Returns null when nothing matched — a clean result means "no
 * known problem", never "verified suitable".
 */
export function unsuitableFloatWallet(params: {
  relays: string[];
  alias?: string;
}): { reason: string; display: string } | null {
  const hosts = params.relays.map(relayHost).filter((h) => h.length > 0);
  const aliasTokens = tokenizeAlias(params.alias);

  for (const entry of UNSUITABLE_WALLETS) {
    const hostHit = entry.hosts.some((domain) =>
      hosts.some((host) => host === domain || host.endsWith(`.${domain}`))
    );
    const aliasHit = entry.aliases.some((name) => aliasTokens.has(name));
    if (hostHit || aliasHit) {
      return {
        reason: entry.reason,
        display: `This wallet probably can't work as an agent float. ${entry.reason}`,
      };
    }
  }
  return null;
}

/** Hostname of a relay URL, lowercased. Empty string when it won't parse. */
function relayHost(relay: string): string {
  try {
    return new URL(relay).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Split a wallet alias into comparable tokens. Dots survive so "Cashu.me"
 * stays one token and can't be matched by a wallet merely called "Cashu".
 */
function tokenizeAlias(alias: string | undefined): Set<string> {
  if (!alias) return new Set();
  return new Set(
    alias
      .toLowerCase()
      .split(/[^a-z0-9.]+/)
      .map((t) => t.replace(/^\.+|\.+$/g, ""))
      .filter((t) => t.length > 0)
  );
}
