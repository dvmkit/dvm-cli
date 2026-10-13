import { type AmountLabelOptions, formatPaymentAmount } from "../lib/currency";
import {
  asProviderText,
  type Quote,
} from "@dvmkit/sdk/internal";
import {
  info,
  json,
} from "../lib/output";

import { takeCreditNoticeFields } from "../lib/credit-notice";
import { type DvmIdentity, dvmIdentity } from "./dvm-identity";
import type {
  FundWalletNextAction,
  ResubmitNextAction,
  SetupWalletNextAction,
} from "./request-resubmit";

export interface OutputOptions {
  human?: boolean;
  /** Durable public request identifier, when the caller supplied one. */
  requestId?: string;
}

/**
 * Output collected quotes (from Transport.submit) with instructions to pay.
 * When `nextAction` is supplied, JSON output includes it at the top level and
 * human output prints the suggested rerun command under the hint so a copy/paste
 * gets the caller unstuck.
 */
export function outputCollectedQuotes(
  jobId: string | null,
  quotes: Quote[],
  opts: OutputOptions,
  identity: DvmIdentity | undefined,
  hint?: string,
  nextAction?: ResubmitNextAction
): void {
  const defaultHint = jobId
    ? "Use --auto-pay or --budget to pay automatically."
    : "Upfront payment required. Re-submit with --auto-pay to pay automatically.";
  const effectiveHint = nextAction?.hint ?? hint ?? defaultHint;

  if (opts.human) {
    info(`${quotes.length} quote(s) received:`);
    for (let i = 0; i < quotes.length; i++) {
      const q = quotes[i];
      info(`  ${i + 1}. ${quoteAmountLabel(q)}`);
    }
    info(`\n${effectiveHint}`);
    if (nextAction) {
      info(`  ${nextAction.command}`);
    }
  } else {
    json({
      ...(jobId ? { jobId } : {}),
      ...requestIdFields(opts),
      ...dvmIdentity(identity?.dvmId, identity?.capability),
      status: "quotes-collected",
      quotes: formatQuotes(quotes),
      hint: effectiveHint,
      ...takeCreditNoticeFields(),
      next_action: nextAction ?? null,
    });
  }
}

/**
 * Output quotes when no wallet is connected. Emits a `setup_wallet` next_action
 * so an agent can drive the operator through wallet bring-up without having to
 * know which CLI command kicks it off.
 */
export function outputQuotesNoWallet(
  jobId: string,
  quotes: Quote[],
  opts: OutputOptions,
  identity: DvmIdentity | undefined
): void {
  const nextAction: SetupWalletNextAction = {
    type: "setup_wallet",
    command: "dvm wallet setup",
    requires_user_approval: true,
    hint: "No wallet connected. Run 'dvm wallet setup' for a guided walkthrough, or 'dvm wallet connect' if you already have one.",
  };

  if (opts.human) {
    info("No wallet connected. Quotes received:");
    for (const q of quotes) {
      info(`  ${quoteAmountLabel(q)}`);
    }
    info(`\n${nextAction.hint}`);
    info(`  ${nextAction.command}`);
  } else {
    json({
      jobId,
      ...requestIdFields(opts),
      ...dvmIdentity(identity?.dvmId, identity?.capability),
      status: "quotes-collected",
      quotes: formatQuotes(quotes),
      message: "No wallet connected.",
      hint: nextAction.hint,
      ...takeCreditNoticeFields(),
      next_action: nextAction,
    });
  }
}

export interface HeldMintBalance {
  mint: string;
  /** Spendable (valid, unreserved) sats the wallet holds at this mint. */
  sats: number;
}

export interface NoEligibleMintDetail {
  /** `no_eligible_mint` — holds nothing at an accepted mint; `insufficient_balance` — holds too little. */
  code: "no_eligible_mint" | "insufficient_balance";
  acceptedMints: string[];
  heldMints: HeldMintBalance[];
  heldSats: number;
  fundCommand: string;
}

/**
 * Output quotes when the agent wallet IS connected and funded but holds no
 * spendable balance at any mint the DVM currently accepts. Distinct from
 * {@link outputQuotesNoWallet}: emitting "No wallet connected" here is a lie
 * that sends an operator hunting for a disconnected wallet when the real cause
 * is a mint mismatch — the DVM health-filters an unreachable mint out of its
 * `/v1/info`, so a caller whose float sits at that mint suddenly has nothing
 * eligible to spend. Emits a `fund_wallet` next_action pinning an accepted
 * mint, and names where the caller's funds actually sit so an agent can relay
 * that they are safe, not lost.
 */
export function outputQuotesNoEligibleMint(
  jobId: string,
  quotes: Quote[],
  opts: OutputOptions,
  identity: DvmIdentity | undefined,
  detail: NoEligibleMintDetail
): void {
  const acceptedList = detail.acceptedMints.join(", ") || "(none advertised)";
  const heldList = detail.heldMints.map((m) => `${m.mint}: ${m.sats} sats`).join(", ");
  const message =
    detail.code === "no_eligible_mint"
      ? "Wallet connected, but it holds no balance at any Cashu mint this service accepts."
      : "Wallet connected, but its balance at this service's accepted mint is too low to cover the quote.";
  const hint =
    detail.code === "no_eligible_mint"
      ? `This service accepts Cashu ecash from: ${acceptedList}. Your wallet holds ${detail.heldSats} sats` +
        `${heldList ? ` (${heldList})` : ""} — your funds are safe, they are just not at a mint this service ` +
        "accepts right now (a mint you hold may be temporarily down). Fund an accepted mint to continue: " +
        `${detail.fundCommand}.`
      : `This service accepts Cashu from: ${acceptedList}. Top up an accepted mint: ${detail.fundCommand}.`;

  const nextAction: FundWalletNextAction = {
    type: "fund_wallet",
    command: detail.fundCommand,
    requires_user_approval: true,
    hint,
  };

  if (opts.human) {
    info(message);
    for (const q of quotes) {
      info(`  ${quoteAmountLabel(q)}`);
    }
    info(`\n${hint}`);
    info(`  ${nextAction.command}`);
  } else {
    json({
      jobId,
      ...requestIdFields(opts),
      ...dvmIdentity(identity?.dvmId, identity?.capability),
      status: "quotes-collected",
      quotes: formatQuotes(quotes),
      message,
      hint,
      ...takeCreditNoticeFields(),
      next_action: nextAction,
      accepted_mints: detail.acceptedMints,
      wallet_balance_sats: detail.heldSats,
      wallet_mints: detail.heldMints,
    });
  }
}

/**
 * Output quotes that exceed the caller's budget. `nextAction` carries the
 * rerun command with `--budget` raised to the cheapest quote, so an agent can
 * confirm the price with its user and re-issue without rebuilding flags.
 */
export function outputOverBudget(
  jobId: string | null,
  quotes: Quote[],
  opts: OutputOptions,
  identity: DvmIdentity | undefined,
  nextAction?: ResubmitNextAction
): void {
  const effectiveHint =
    nextAction?.hint ??
    `Every quote is above your budget${quotes.length > 0 ? ` — the cheapest is ${quoteAmountLabel(cheapestQuote(quotes))}` : ""}. Re-run with --budget at or above the quote price to approve it.`;

  if (opts.human) {
    info("No quotes within budget.");
    for (const q of quotes) {
      info(`  ${quoteAmountLabel(q)}`);
    }
    info(`\n${effectiveHint}`);
    if (nextAction) {
      info(`  ${nextAction.command}`);
    }
  } else {
    json({
      ...(jobId ? { jobId } : {}),
      ...requestIdFields(opts),
      ...dvmIdentity(identity?.dvmId, identity?.capability),
      status: "over-budget",
      quotes: formatQuotes(quotes),
      hint: effectiveHint,
      ...takeCreditNoticeFields(),
      next_action: nextAction ?? null,
    });
  }
}

export function cheapestQuote(quotes: Quote[]): Quote {
  return quotes.reduce((min, q) => (q.priceMsats < min.priceMsats ? q : min));
}

/**
 * Format Quote[] for JSON output. Provider-supplied descriptions are wrapped as
 * ProviderText. `upfront` is the provider's own fiat commitment — including the
 * exact `amount_micro` it charges at — and rides beside `msats`, which is the
 * client's local advisory conversion. On a stablecoin-priced DVM the sats are
 * derived from the fiat figure, so relaying sats alone inverts the price.
 */
export function formatQuotes(quotes: Quote[]): object[] {
  return quotes.map((q) => ({
    upfront: q.upfront,
    msats: q.priceMsats,
    ...(q.description ? { description: asProviderText(q.description) } : {}),
    ...(q.mints ? { mints: q.mints } : {}),
  }));
}

/**
 * The fiat-first label for one quote, for every human line and CLI-owned hint
 * that names a price. Leads with the provider's stated fiat figure and keeps
 * sats as the parenthetical; degrades to a cached-rate estimate when a legacy
 * provider quoted no fiat price. Keeps the cost anchor by default — this is the
 * moment a human is deciding whether the price is reasonable; pass
 * `{ anchor: false }` on the surfaces that render after that decision.
 */
export function quoteAmountLabel(q: Quote, opts?: AmountLabelOptions): string {
  return formatPaymentAmount(q.priceMsats, q.upfront, opts);
}

function requestIdFields(opts: OutputOptions): { request_id?: string } {
  return opts.requestId ? { request_id: opts.requestId } : {};
}
