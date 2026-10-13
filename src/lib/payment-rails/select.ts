/**
 * Resolve which rails to attempt for a `dvm request` upfront payment, in
 * preference order. Pure: no I/O, no wallet reads — caller passes
 * in the local-availability bits.
 *
 * Resolution rules:
 *
 *   1. `--rail <flag>` forces a single rail. The caller may attempt that
 *      rail only; no implicit fallback to others (an explicit choice should
 *      surface a clear error if the rail can't satisfy the call, not silently
 *      pay via a different one).
 *   2. Else, the resolver enumerates the rails that are both locally
 *      configured (a Cashu wallet exists / a Tempo wallet exists /
 *      an x402 wallet exists) and advertised by the DVM via `/v1/info`.
 *      If only one rail meets both bars, it auto-fires without `--rail`.
 *   3. When more than one rail qualifies, `config.default_rail` wins
 *      (mapped to its concrete `Rail` form — `cashu` → `cashu_p2pk`).
 *      Otherwise, the issue-spec order `cashu_p2pk > tempo > x402` applies.
 */

import {
  type ProviderInfo,
  type Quote,
  type Rail,
  type RailFlag,
  resolveX402Asset,
  tryResolveTempoAsset,
} from "@dvmkit/sdk/internal";

export interface SelectRailOrderArgs {
  flagRail?: RailFlag;
  /** `config.default_rail` from `~/.dvm/config.json`, or undefined when not set. */
  defaultRail?: RailFlag;
  providerInfo: ProviderInfo;
  /**
   * The 402 quote chosen for payment, when known. Its `mints` field is the
   * live Cashu advertise (the DVM's actual willingness to take a bare-token
   * spend on this call) and supplements `providerInfo.mints` — some DVMs
   * surface Cashu acceptance only via the 402 quote, not via `/v1/info`.
   */
  quote?: Quote;
  /** Whether `~/.dvm/wallet.json` exists with at least one valid proof. */
  hasAgentWallet: boolean;
  /** Whether `config.tempo.method === "tempo"` with a valid apiKey. */
  hasTempoWallet: boolean;
  /** Whether `config.x402.privateKey` is configured. */
  hasX402Wallet: boolean;
}

export interface RailSelection {
  /** Rails to attempt, in order. May be empty when nothing fits. */
  rails: Rail[];
  /**
   * When `flagRail` was set but resulted in zero qualifying rails, this
   * carries the reason so the caller can throw a clear `DvmError`.
   */
  unsatisfiableFlag?: { rail: RailFlag; reason: string; hint: string };
}

/**
 * Resolve the ordered list of rails to attempt. See module-level doc for
 * the rules. Returns an empty `rails` array when no rail qualifies — the
 * caller surfaces the "no wallet covers this" outcome.
 */
export function selectRailOrder(args: SelectRailOrderArgs): RailSelection {
  const advertises = advertisedRails(args.providerInfo, args.quote);
  const locallyConfigured = locallyConfiguredRails(args);

  if (args.flagRail) {
    return resolveFlag(args.flagRail, advertises, locallyConfigured);
  }

  const eligible = ISSUE_SPEC_ORDER.filter((r) => advertises.has(r) && locallyConfigured.has(r));

  if (eligible.length <= 1) {
    return { rails: eligible };
  }

  if (args.defaultRail) {
    return { rails: orderByDefault(eligible, args.defaultRail) };
  }

  return { rails: eligible };
}

const ISSUE_SPEC_ORDER: readonly Rail[] = ["cashu_p2pk", "tempo", "x402"] as const;

function advertisedRails(info: ProviderInfo, _quote: Quote | undefined): Set<Rail> {
  const out = new Set<Rail>();
  if ((info.cashu?.lock_pubkeys.length ?? 0) > 0) {
    out.add("cashu_p2pk");
  }
  if (info.tempo?.methods.some((m) => m.method === "tempo" && m.intent === "charge")) {
    out.add("tempo");
  }
  if (info.x402?.pay_to) {
    out.add("x402");
  }
  return out;
}

function locallyConfiguredRails(args: SelectRailOrderArgs): Set<Rail> {
  const out = new Set<Rail>();
  if (args.hasAgentWallet) out.add("cashu_p2pk");
  if (args.hasTempoWallet) out.add("tempo");
  if (args.hasX402Wallet) out.add("x402");
  return out;
}

function resolveFlag(flag: RailFlag, advertises: Set<Rail>, configured: Set<Rail>): RailSelection {
  const candidates = flagToRails(flag);
  const rails = candidates.filter((r) => advertises.has(r) && configured.has(r));
  if (rails.length > 0) return { rails };

  const advertised = candidates.some((r) => advertises.has(r));
  const configuredLocally = candidates.some((r) => configured.has(r));

  if (!advertised) {
    return {
      rails: [],
      unsatisfiableFlag: {
        rail: flag,
        reason: `DVM does not advertise the ${flag} rail.`,
        hint: `Drop --rail to let the CLI auto-select an advertised rail, or pick a different DVM.`,
      },
    };
  }
  return {
    rails: [],
    unsatisfiableFlag: {
      rail: flag,
      reason: `No local ${flag} wallet is configured.`,
      hint: hintForUnconfigured(flag, configuredLocally),
    },
  };
}

function flagToRails(flag: RailFlag): Rail[] {
  switch (flag) {
    case "cashu":
      return ["cashu_p2pk"];
    case "tempo":
      return ["tempo"];
    case "x402":
      return ["x402"];
  }
}

function orderByDefault(rails: Rail[], defaultRail: RailFlag): Rail[] {
  const preferred = flagToRails(defaultRail);
  const head: Rail[] = [];
  const tail: Rail[] = [];
  for (const r of rails) (preferred.includes(r) ? head : tail).push(r);
  return [...head, ...tail];
}

function hintForUnconfigured(flag: RailFlag, _hasOther: boolean): string {
  switch (flag) {
    case "cashu":
      return "Run `dvm wallet init` and `dvm wallet fund <amount>` to set up the Cashu agent wallet.";
    case "tempo": {
      // "deposit USDC" is where-to-send-money copy, and Tempo carries
      // more than one dollar — name the one this rail settles in.
      const asset = tryResolveTempoAsset();
      return `Run \`dvm wallet fund $X --rail tempo\` to generate a Tempo key, then deposit ${asset?.label ?? "the rail's settlement token"} to the printed address.`;
    }
    case "x402": {
      // "USDC on the target chain" is where-to-send-money copy that
      // names neither the dollar nor the chain. No wallet is connected yet, so
      // the chain is whatever `--network` selects — name the default.
      const asset = resolveX402Asset();
      return `Run \`dvm wallet x402-connect\` to generate an EVM wallet (or \`--key-file <path>\` to import one you already hold), then fund the printed address with ${asset?.label ?? "USDC"} on ${asset?.networkLabel ?? "the target chain"} (\`--network\` picks a different chain; a bridged dollar such as USDbC is a different token and won't be spendable).`;
    }
  }
}
