import type {
  Config,
} from "./identity";
import {
  info,
} from "./output";

/**
 * Wallet rail that dvm can surface funding guidance for.
 *
 * Lightning takes precedence over Cashu in {@link detectWalletType} because an
 * NWC Lightning wallet is immediately spendable; Cashu requires a Lightning
 * source to mint tokens, so it's only returned as the primary rail when no
 * Lightning backend is configured.
 */
export type WalletType = "nwc" | "cashu";

export interface FundingOption {
  method:
    | "lightning"
    | "onchain"
    | "external"
    | "cashu-mint"
    | "cashu-receive-token"
    | "cashu-add-mint";
  display: string;
  /** CLI command the user should run, when actionable */
  command?: string;
  description: string;
  hint: string;
  mints?: string[];
}

export interface FundingGuidanceResult {
  /** Actionable funding paths — empty when the wallet already has a balance. */
  fundingOptions: FundingOption[];
  /** Cross-rail safety advisory — always present so agents always have the prose. */
  advisory: { display: string; description: string; hint: string };
}

const SAFE_FUNDING_ADVISORY: { display: string; description: string; hint: string } = {
  display: "Start small — fund a few days' worth and top up as confidence grows",
  description:
    "There's no need to fund a large amount up front. A few days of expected spend is enough to get going; top up once you've seen how your agent uses the wallet.",
  hint: "Funding lightly is the safest posture across all rails. A connected Lightning wallet lets the agent top itself up on its own — set a spending cap on the wallet (it's the one the agent can't change) and 'dvm budget set' caps here.",
};

/**
 * Detect the primary wallet rail from a config + the wallet's currently
 * configured Cashu mints. Lightning takes precedence; Cashu is only
 * returned when no Lightning backend is configured. `cashuMints` is
 * supplied separately because the canonical store is `wallet.mints` in
 * `~/.dvm/wallet.json` — callers obtain it via
 * `loadConfiguredMints()`.
 */
export function detectWalletType(
  config: Config | null,
  cashuMints: readonly string[]
): WalletType | null {
  if (!config && cashuMints.length === 0) return null;
  if (config?.nwcUri) return "nwc";
  if (cashuMints.length > 0) return "cashu";
  return null;
}

/**
 * Build funding guidance for any wallet. Always returns the safe-funding
 * advisory so agents always have the prose; `fundingOptions` is empty when
 * the wallet already has a balance.
 *
 * Pure: this function does not perform I/O. Use {@link printFundingGuidance}
 * to render the result to stderr for human-mode output.
 */
export function getFundingGuidance(opts: {
  walletType: WalletType;
  /**
   * Current balance in millisats — positive values suppress funding options.
   * `undefined` means the balance couldn't be read, which shows the guidance:
   * "here's how to add funds" is safe advice for an unknown balance, whereas
   * suppressing it would hide the path for a wallet that really is empty.
   */
  balanceMsats: number | undefined;
  /** For Cashu: list of configured mint URLs so guidance can adapt. */
  cashuMints?: string[];
  /** Whether a Lightning backend is also available. Affects Cashu ordering. */
  hasLightningBackend?: boolean;
}): FundingGuidanceResult {
  const fundingOptions: FundingOption[] =
    (opts.balanceMsats ?? 0) > 0
      ? []
      : opts.walletType === "nwc"
        ? nwcOptions()
        : cashuOptions(opts.cashuMints, opts.hasLightningBackend ?? false);
  return { fundingOptions, advisory: SAFE_FUNDING_ADVISORY };
}

/** Render funding guidance prose to stderr for human-mode output. */
export function printFundingGuidance(result: FundingGuidanceResult): void {
  info(`\n${result.advisory.display}`);
  info(`  ${result.advisory.description}`);
  info(`  ${result.advisory.hint}`);
  if (result.fundingOptions.length === 0) return;
  info("\nFund your wallet:");
  for (let i = 0; i < result.fundingOptions.length; i++) {
    const o = result.fundingOptions[i];
    info(`  ${i + 1}. ${o.display}`);
    if (o.command) info(`     ${o.command}`);
    info(`     ${o.description}`);
  }
}

function nwcOptions(): FundingOption[] {
  return [
    {
      method: "external",
      display: "Add funds in your wallet app",
      description:
        "The connected Lightning wallet is the agent's float — the pot it tops itself up from. Money goes in through the wallet app itself (Alby Hub, Coinos, etc.); dvm spends from it but never fills it.",
      hint: "Receive a payment in your wallet app, then run 'dvm wallet fund <amount>' — the agent will move sats across on its own.",
    },
  ];
}

function cashuOptions(mints: string[] | undefined, hasLightningBackend: boolean): FundingOption[] {
  const exampleMint = mints && mints.length > 0 ? mints[0] : undefined;
  const hasMints = exampleMint !== undefined;
  const mintCommand = exampleMint
    ? `dvm wallet fund <sats> --mint ${exampleMint}`
    : "dvm wallet fund <sats> --mint <url>";

  const mintOption: FundingOption = {
    method: "cashu-mint",
    display: "Mint Cashu tokens via Lightning",
    command: mintCommand,
    description: hasMints
      ? "Pays a Lightning invoice from your Lightning wallet and mints matching P2PK-locked Cashu tokens into the agent wallet. Cashu mints are custodial — only deposit what you're willing to lose."
      : "After adding a mint above, pays a Lightning invoice from your Lightning wallet and mints matching P2PK-locked Cashu tokens into the agent wallet. Cashu mints are custodial — only deposit what you're willing to lose.",
    hint: hasLightningBackend
      ? "Requires a Lightning wallet — you have one configured."
      : "Requires a Lightning wallet — connect one with 'dvm wallet connect' first (pipe the connection string in, or pass --file <path>).",
    ...(hasMints ? { mints } : {}),
  };

  const receiveTokenOption: FundingOption = {
    method: "cashu-receive-token",
    display: "Receive an existing Cashu token",
    command: "dvm wallet receive-token <cashu-token>",
    description:
      "Claim a pre-minted Cashu token (e.g. from a friend or a faucet) into the agent wallet. The token is re-locked to your wallet's key so it's spendable.",
    hint: "Tokens are single-use; a token locked to a third party can't be claimed.",
    ...(hasMints ? { mints } : {}),
  };

  const options: FundingOption[] = [];
  if (!hasMints) {
    options.push({
      method: "cashu-add-mint",
      display: "Add a Cashu mint",
      command: "dvm wallet mint-add <url>",
      description:
        "Cashu mints hold your tokens. Add one before you can mint or receive tokens — 'dvm wallet mint-list' shows recommended mints. Cashu mints are custodial — only deposit what you're willing to lose.",
      hint: "Recommended mints: see 'dvm wallet mint-list' for trusted options.",
    });
  }

  // Without a Lightning backend, minting is not directly actionable — surface
  // receive-token first so an agent picking the first option steers the user
  // toward the workable path.
  if (hasLightningBackend) {
    options.push(mintOption, receiveTokenOption);
  } else {
    options.push(receiveTokenOption, mintOption);
  }

  return options;
}
