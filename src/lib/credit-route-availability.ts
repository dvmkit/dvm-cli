/**
 * Read-only caller-side funding availability for credit-headroom diagnostics.
 *
 * This deliberately does not feed the funding loop. `credit-fund.ts` remains
 * the authority that attempts rails and handles live failures; this snapshot
 * only prevents quote/headroom prose from promising money the caller cannot
 * presently source.
 */

import {
  type AgentWallet,
  coveringMintsForSpend,
  type CreditMenu,
  effectiveMints,
  isCreditFundRail,
  loadAgentWallet,
  microToSats,
  offersTempoCreditFunding,
  offersX402CreditFunding,
  type ProviderInfo,
} from "@dvmkit/sdk/internal";
import {
  type Config,
  loadConfig,
} from "./identity";
import {
  loadX402Wallet,
} from "./x402/wallet";
import { loadFloat } from "./float";

import type { CreditRouteAvailability } from "./credit-headroom";

export function localCreditRouteAvailability(args: {
  menu: CreditMenu;
  providerInfo?: ProviderInfo;
  amountMicro?: number;
  btcRate?: number;
  config?: Config | null;
  wallet?: AgentWallet | null;
}): CreditRouteAvailability[] {
  const config = args.config === undefined ? loadConfig() : args.config;
  const floatConnected = hasUsableFloat(config);
  const wallet = args.wallet === undefined ? safeLoadWallet() : args.wallet;

  return args.menu.funding.filter(isCreditFundRail).map((rail) => {
    switch (rail) {
      case "cashu":
        return cashuAvailability({ ...args, wallet, floatConnected });
      case "lightning":
        return floatConnected
          ? { rail, available: true, source: "lightning_float" }
          : { rail, available: false };
      case "x402": {
        // Same evidence the funding loop demands: a connected wallet
        // is only half of it — the menu has to name a scheme this caller can
        // build on that wallet's chain, either flavour, or the rail would be
        // reported as available and then dead-end.
        const x402Wallet = loadX402Wallet();
        return x402Wallet && offersX402CreditFunding(args.menu, x402Wallet.network)
          ? { rail, available: true, source: "x402_wallet" }
          : { rail, available: false };
      }
      case "tempo": {
        // Same evidence the funding loop demands: a valid local
        // Tempo key is only half of it — the menu has to name a Tempo charge or
        // session method, or the rail would be reported as available and then
        // dead-end.
        const configured =
          config?.tempo?.method === "tempo" &&
          typeof config.tempo.apiKey === "string" &&
          /^0x[0-9a-fA-F]{64}$/.test(config.tempo.apiKey);
        return configured && offersTempoCreditFunding(args.menu)
          ? { rail, available: true, source: "tempo_wallet" }
          : { rail, available: false };
      }
    }
  });
}

function cashuAvailability(args: {
  menu: CreditMenu;
  providerInfo?: ProviderInfo;
  amountMicro?: number;
  btcRate?: number;
  wallet: AgentWallet | null;
  floatConnected: boolean;
}): CreditRouteAvailability {
  const offer = args.providerInfo?.cashu;
  // An offline headroom view has no current mint/lock offer. That is unknown,
  // not proof that ecash is unavailable; never turn a missing network read into
  // a local-wallet diagnosis.
  if (!args.providerInfo) return { rail: "cashu" };
  if (!offer || offer.mints.length === 0 || offer.lock_pubkeys.length === 0) {
    return { rail: "cashu", available: false };
  }

  const balanceCovers = cashuBalanceCovers({
    wallet: args.wallet,
    mints: offer.mints,
    amountMicro: args.amountMicro,
    btcRate: args.btcRate,
  });
  const floatCanReplenish =
    args.floatConnected &&
    args.wallet !== null &&
    effectiveMints(args.wallet).some((mint) => offer.mints.includes(mint));
  if (balanceCovers === true) {
    return {
      rail: "cashu",
      available: true,
      source: "cashu_balance",
      ...(floatCanReplenish ? { replenishableFromFloat: true } : {}),
    };
  }
  if (floatCanReplenish) {
    return {
      rail: "cashu",
      available: true,
      source: "lightning_float",
      replenishableFromFloat: true,
    };
  }
  if (balanceCovers === undefined) return { rail: "cashu" };
  return { rail: "cashu", available: false };
}

function cashuBalanceCovers(args: {
  wallet: AgentWallet | null;
  mints: string[];
  amountMicro?: number;
  btcRate?: number;
}): boolean | undefined {
  if (!args.wallet) return false;
  const eligibleProofs = args.wallet.proofs.filter(
    (proof) =>
      args.mints.includes(proof.mint) &&
      proof.status === "valid" &&
      proof.reserved_for === undefined
  );
  if (eligibleProofs.length === 0) return false;
  if (args.amountMicro !== undefined) {
    // Without the advisory BTC rate we cannot turn sats into the requested
    // fiat amount. Keep availability unknown instead of promising that an
    // arbitrary non-zero balance covers it.
    if (args.btcRate === undefined || args.btcRate <= 0) return undefined;
    return (
      "mints" in
      coveringMintsForSpend({
        proofs: eligibleProofs,
        mintAllowlist: args.mints,
        amountSats: microToSats(args.amountMicro, args.btcRate),
      })
    );
  }
  return true;
}

function hasUsableFloat(config: Config | null): boolean {
  try {
    return loadFloat(config) !== null;
  } catch {
    return false;
  }
}

function safeLoadWallet(): AgentWallet | null {
  try {
    return loadAgentWallet();
  } catch {
    return null;
  }
}
