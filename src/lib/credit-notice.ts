import { fundingRailLabel } from "./rail-labels";
/**
 * What a job says about the credit it did or didn't buy.
 *
 * Two payloads, one deferred-field sink. Both are produced deep on the request
 * path — at the moment a purchase is suppressed, or the moment one lands — and
 * both have to reach the *terminal* output, which is emitted several call
 * frames later and in one of nine places. So the prose goes to stderr at the
 * moment it happens — the surrounding credit path already narrates itself that
 * way in both output modes — and the structured block is stashed here for the
 * terminal emission to spread in with {@link takeCreditNoticeFields}.
 *
 * `take` clears: the fields land on exactly one output line, so every terminal
 * emission can spread them without any of them having to know whether another
 * one already did.
 *
 * Copy rules, all load-bearing and all pinned by test: the suggestion **offers**
 * rather than instructs, names the concrete win ("reduce per-job fees"), says
 * *credit* and never "tab", carries no CLI persona (funding "is handled
 * automatically", never "I'll manage it"), and teaches both moves — the
 * one-shot `dvm credit fund <dvm>` and the standing `dvm credit posture auto`.
 */

import { formatFiat } from "@dvmkit/sdk";
import { type CreditFundOutcome, type CreditRailReason, type CreditRailSource } from "./credit-fund";
import {
  type CreditFundRail,
  formatUsd,
  shellQuoteArg,
  type X402CreditFlavour,
  type X402CreditInstrument,
  x402NetworkByCaip2,
} from "@dvmkit/sdk/internal";
import {
  type CreditPosture,
} from "./identity";
import {
  info,
} from "./output";
import {
  x402NetworkLabel,
} from "./x402/networks";
import {
  type DrawCeilingSource,
  type DrawSkip,
  type FundingSkip,
  type SuppressedPurchase,
} from "./credit-policy";

import type { AdoptedWedgedDrain } from "./credit-reclaim";

export interface CreditSuggestion {
  code: "credit_purchase_suppressed";
  dvm: string;
  endpoint: string;
  /** `open` — a first credit here. `refill` — deepening one already held. */
  reason: "open" | "refill";
  posture: CreditPosture;
  posture_source: "default" | "global" | "per_dvm";
  /** What would have been funded, micro-units of {@link currency}. */
  amount_micro: number;
  currency: string;
  fund_command: string;
  opt_in_command: string;
  opt_in_command_global: string;
  display: string;
  hint: string;
}

export interface CreditFundingSkipped extends FundingSkip {
  code: "credit_funding_skipped";
  dvm: string;
  endpoint: string;
  display: string;
  hint: string;
}

/**
 * Why an automatic purchase fired. Supplied by the call site, never derived
 * from the shape of the plan: an open fires on the second job here, on the Nth
 * after a drain, *and* on the first job after `dvm credit posture auto`, so
 * "your second job" is not a reason. And the two top-ups have genuinely
 * different triggers — the in-request one because the stored balance couldn't
 * cover *this* job, the post-job one because the balance crossed the low-water
 * mark.
 */
export type CreditFundingReason = "no_credit_open" | "short_for_job" | "below_refill_target";

export type CreditFundingStage = "in_flight" | "settled";

export interface CreditFundingReport {
  code: "credit_funded";
  dvm: string;
  endpoint: string;
  reason: CreditFundingReason;
  /** Micro-units of {@link currency} that left the wallet for the deposit. */
  amount_micro: number;
  currency: string;
  /**
   * Which rail carried the funding — the registry type, so a rail added to
   * {@link CREDIT_FUND_RAILS} has to be given copy here rather than silently
   * reporting as ecash.
   */
  route: CreditFundRail;
  /**
   * Why that rail — the structured half of "every funding names its
   * route and the reason". Absent only for a funding whose route nothing
   * chose, which no automatic path produces.
   */
  route_reason?: CreditRailReason;
  /** Where a forced route came from. Set only when {@link route_reason} is `forced`. */
  route_reason_source?: CreditRailSource;
  /** Which x402 mechanism actually carried the funding, when {@link route} is `x402`. */
  x402_flavour?: X402CreditFlavour;
  /** Which Tempo mechanism actually carried the funding, when {@link route} is `tempo`. */
  tempo_intent?: "charge" | "session";
  /** Exact Lightning wallet debit when wallet evidence proved it. */
  spent_sats?: number;
  principal_sats?: number;
  /** Wallet-reported routing fee, or null when omitted. */
  routing_fee_sats?: number | null;
  /** Total wallet fee, or null when the total debit is unprovable. */
  total_wallet_fee_sats?: number | null;
  /** Wallet fee not itemized as routing, or null when the split is unprovable. */
  unitemized_wallet_fee_sats?: number | null;
  /** Exact wallet debit, or null when wallet evidence is ambiguous. */
  wallet_debit_sats?: number | null;
  /** How the Lightning payment reached settlement. */
  payment_outcome?: "paid" | "reconciled" | "republished";
  display: string;
}

/**
 * An automatic funding that did not land on the credit it was asked for
 * *
 * The counterpart to {@link CreditFundingReport}, and the reason it exists
 * separately: that block is written for a purchase that landed, so its `route`
 * is required and its copy hard-asserts success. These four outcomes each moved
 * or risked money without producing one:
 *
 * - `credit_funding_refused` — the DVM declined the funding. On the Lightning
 *   rail the refusal can arrive *after* the bolt11 was paid, and then
 *   {@link spent_sats} is set and nothing was credited for it; the refusals that
 *   arrive before any signature (a cross-rail binding, a retired voucher, an
 *   ecash spend the path drops) carry no spend at all.
 * - `credit_funding_settlement_pending` — the payment went out and is recorded,
 *   but the DVM hadn't observed it. Crediting is pull-based; the next request
 *   settles it, and nothing is lost.
 * - `credit_funding_reconciled` — the balance landed, on a credit this caller
 *   never named, because the provider's operator repaired a blocked invoice
 *   onto one of their choosing. {@link credit_id} is that credit.
 * - `credit_funding_deferred` — the funding never went out, because a signature
 *   the DVM can still submit is outstanding: an x402 voucher, an
 *   exact authorization, or a Tempo charge. Usually the
 *   one this credit signed itself, and then {@link fund_id} is that intent's —
 *   the key the retry re-presents it under, and what an operator traces it by.
 *   The exception is an x402 voucher this attempt cannot replay: a sibling
 *   credit's, since the channel is shared across the credits at a DVM, or this
 *   credit's own already-refused one. There {@link fund_id} is a fresh key
 *   nothing went out under. {@link credit_id} is this credit throughout, and
 *   {@link display} names the credit actually holding the block either way.
 *   Nothing moved on this attempt, and where the outstanding intent is this
 *   credit's own, signing a second payment for the same top-up is the one wrong
 *   move.
 *
 * {@link spent_sats} and {@link spent_micro} are the money test across all four:
 * present means it left the wallet on this funding, absent means it did not.
 * Neither is a promise about a `deferred` block's outstanding intent.
 *
 * Field names deliberately match what `dvm credit fund` emits for the same
 * outcomes, so the automatic path and the typed one read alike — with the one
 * divergence that the amount here is `amount_micro`, since only a landed
 * funding has a `funded_micro` to report.
 */
export interface CreditFundingIncomplete {
  code:
    | "credit_funding_refused"
    | "credit_funding_settlement_pending"
    | "credit_funding_reconciled"
    | "credit_funding_deferred";
  dvm: string;
  endpoint: string;
  reason: CreditFundingReason;
  /** The credit the balance is on — the reconciled target, else the one asked for. */
  credit_id: string;
  /**
   * Idempotency key for this funding, and the handle an operator traces its
   * payment by where one went out. On a `deferred` block it is usually the
   * outstanding intent's key instead — see that code's bullet above for the one
   * shape where it isn't.
   */
  fund_id: string;
  /** The rail that carried it, or would have on a `deferred` block. */
  rail?: CreditFundRail;
  /** Micro-units of {@link currency} the funding was for, or credited elsewhere. */
  amount_micro: number;
  currency: string;
  /** Sats that left a Cashu or Lightning wallet. Absent for stablecoin funding. */
  spent_sats?: number;
  /** Lightning invoice principal. Present even when its routing fee is unknown. */
  principal_sats?: number;
  /** Wallet-reported Lightning routing fee, or null when omitted. */
  routing_fee_sats?: number | null;
  /** Total Lightning wallet fee, or null when the total debit is unprovable. */
  total_wallet_fee_sats?: number | null;
  /** Wallet fee not itemized as routing, or null when the split is unprovable. */
  unitemized_wallet_fee_sats?: number | null;
  /** Exact Lightning wallet debit, or null when wallet evidence is ambiguous. */
  wallet_debit_sats?: number | null;
  /** Stablecoin micro-units committed through a Tempo charge or session. */
  spent_micro?: number;
  /** How a Lightning payment resolved — `reconciled` means it was not re-sent. */
  payment_outcome?: "paid" | "reconciled" | "republished";
  error_code?: string;
  /**
   * The drain id a wedged x402 channel's refusal named, now recorded as this
   * credit's pending reclaim. Present only on that refusal, and only
   * where the settlement is genuinely wedged — a written-off hold names no id,
   * because a *fresh* drain reclaims from then on and nothing was recorded.
   */
  drain_id?: string;
  /**
   * The command that posts {@link drain_id}. Bare, because the adoption above
   * is what lets the reclaim resolve its own id — except where the local record
   * tracks a sibling credit, when it names this one explicitly.
   */
  drain_command?: string;
  display: string;
  hint?: string;
}

interface CreditRefillNoticeBase {
  dvm: string;
  endpoint: string;
  credit_id: string;
  balance_micro: number;
  currency: string;
  display: string;
  hint: string;
}

interface CreditRefillUnavailableBase extends CreditRefillNoticeBase {
  bound_rail: CreditFundRail;
}

interface CreditRefillBindingUnavailable extends CreditRefillUnavailableBase {
  code: "credit_refill_rail_unavailable" | "credit_refill_instrument_unavailable";
  /**
   * The x402 instrument the credit is bound to, in the server's own vocabulary
   * — the same words a funding refusal names as `credit_instrument`. Instrument
   * code only; the rail diagnosis says nothing about the flavour.
   */
  credit_instrument?: X402CreditInstrument;
  /**
   * CAIP-2 chain the diagnosis names, and only ever the credit's own: the chain
   * its settlement channel was opened on, where the record carries it. Absent
   * on the chain-independent diagnosis — the instrument offered on no chain at
   * all — and never the chain the connected wallet happens to be pinned to,
   * which a re-pin can move and so proves nothing about this binding.
   * Instrument code only.
   */
  network?: string;
  drain_command: string;
}

interface CreditRefillWalletNetworkMismatch extends CreditRefillUnavailableBase {
  code: "credit_refill_wallet_network_mismatch";
  bound_rail: "x402";
  credit_instrument: X402CreditInstrument;
  /** A mismatch names refill targets instead of a stranded channel's chain. */
  network?: never;
  /** Re-pinning reaches this balance, so draining is not a remedy. */
  drain_command?: never;
  /** The connected wallet's current CAIP-2 chain pin. */
  wallet_network: string;
  /** CAIP-2 chains on which this particular credit can refill. */
  refill_networks: string[];
  /** One concrete re-pin command, targeting the first viable refill chain. */
  repin_command: string;
}

interface CreditRefillDrainPending extends CreditRefillNoticeBase {
  code: "credit_refill_drain_pending";
  /**
   * No rail is named: this hold is a decision the caller is part-way through,
   * not anything the credit's binding decides, and the binding is healthy.
   */
  bound_rail?: never;
  /** Nor an instrument or a chain, for the same reason. */
  credit_instrument?: never;
  network?: never;
  drain_id: string;
  /**
   * The command that posts {@link drain_id} — the same spelling the refusal
   * that recorded it quoted, and the only thing that retires the record.
   */
  drain_command: string;
}

/**
 * A stored credit whose automatic top-up cannot, or will not, run right now.
 *
 * Three of the codes are about the caller's configuration: the rail and
 * instrument ones are dead ends whose remedy is to drain the balance, and the
 * wallet-network one is deliberately distinct — the binding is still healthy,
 * and temporarily re-pinning the shared wallet reaches it. The fourth is not a
 * configuration fact at all: the refill is standing aside for a reclaim already
 * on record for this credit, and posting that reclaim is what resumes it.
 */
export type CreditRefillUnavailable =
  | CreditRefillBindingUnavailable
  | CreditRefillWalletNetworkMismatch
  | CreditRefillDrainPending;

/**
 * A live credit at this DVM that the job did not draw on, and why.
 *
 * Emitted whenever a caller holding a balance is about to be quoted or charged
 * per-call anyway. Without it the two facts arrive unconnected — a funded
 * balance and an upfront price — and the gap reads as the DVM refusing a draw
 * it was never asked for.
 */
export interface CreditDrawSkipped {
  code: "credit_draw_skipped";
  dvm: string;
  endpoint: string;
  credit_id: string;
  reason: DrawSkip["reason"];
  balance_micro: number;
  /** The job ceiling the capability price was measured against. `price_above_ceiling` only. */
  ceiling_micro?: number;
  /** Compatibility name: the quoted or capability-specific historical price that exceeded it. */
  last_price_micro?: number;
  /** Which knob set that ceiling — the one {@link hint} names. `price_above_ceiling` only. */
  ceiling_source?: DrawCeilingSource;
  display: string;
  hint: string;
}

export interface SiblingCreditAvailable {
  code: "sibling_credit_available";
  dvm: string;
  endpoint: string;
  tracked_credit_id: string;
  sibling_credit_id: string;
  sibling_balance_micro: number;
  required_micro: number;
  currency: string;
  drain_command: string;
  display: string;
  hint: string;
}

/**
 * Two spellings of one DVM carried different funding-rail pins, so both were
 * dropped. Said once, at the moment the CLI learns the two
 * hostnames are one DVM and clears them, and before the next funding routes.
 */
export interface CreditRailPinConflict {
  code: "credit_rail_pin_conflict";
  dvm: string;
  endpoint: string;
  /** The rails that disagreed, in config order. */
  former_rails: CreditFundRail[];
  endpoints: string[];
  repin_command: string;
  /** The rail that governs now the pins are gone — a global pin, or absent for the amount rule. */
  now_rail?: CreditFundRail;
  display: string;
  hint: string;
}

/**
 * The deferred credit fields for one terminal JSON emission.
 *
 * The two funding fields are **lists**, in the order the purchases happened,
 * and the other notices are single blocks. The split is what each field
 * describes: a suggestion, a funding skip, a refill diagnosis, a draw skip, a sibling balance
 * and a rail-pin conflict each describe the state the command left behind, so a
 * second one supersedes the first. A funding describes a *spend*, and one
 * `dvm request` under posture `auto` can make more than one — the in-request
 * fund-and-draw that rides the job request, then a post-job refill or deferred
 * open over `/v1/credit`. Every one of those moved money, so none of them may
 * be dropped.
 *
 * A list field is absent rather than empty when nothing was recorded, which is
 * what lets every terminal emission spread the sink in blind.
 */
export interface CreditNoticeFields {
  credit_suggestion?: CreditSuggestion;
  credit_funding?: CreditFundingReport[];
  credit_funding_incomplete?: CreditFundingIncomplete[];
  credit_funding_skipped?: CreditFundingSkipped;
  credit_refill?: CreditRefillUnavailable;
  credit_draw_skipped?: CreditDrawSkipped;
  credit_sibling?: SiblingCreditAvailable;
  credit_rail_pin_conflict?: CreditRailPinConflict;
}

export function buildCreditFundingSkipped(args: {
  dvm: string;
  endpoint: string;
  skipped: FundingSkip;
}): CreditFundingSkipped {
  return {
    code: "credit_funding_skipped",
    dvm: args.dvm,
    endpoint: args.endpoint,
    ...args.skipped,
    display:
      `Prepaid credit not ${args.skipped.operation === "open" ? "opened" : "refilled"} at ${args.dvm}: ` +
      "BTC/USD rate unavailable. This request uses the ordinary per-call payment path.",
    hint: "Retry automatic credit funding on a later request when BTC/USD pricing is available. Posture auto remains enabled.",
  };
}

export function noteCreditFundingSkipped(skipped: CreditFundingSkipped, human?: boolean): void {
  info(`${skipped.display} ${skipped.hint}`);
  if (!human) pending.credit_funding_skipped = skipped;
}

/**
 * Build the suggestion for a purchase the posture held back.
 *
 * `dvm` is the handle the caller would type — the qualified DVM id when the
 * request resolved one, the endpoint otherwise — because both commands quoted
 * in the copy take exactly that.
 */
export function buildCreditSuggestion(args: {
  dvm: string;
  endpoint: string;
  posture: CreditPosture;
  postureSource: "default" | "global" | "per_dvm";
  suppressed: SuppressedPurchase;
  /** Jobs the deposit would have covered, when the price is known. */
  coversJobs?: number;
}): CreditSuggestion {
  const { dvm, suppressed } = args;
  const amount = `$${formatUsd(suppressed.fundMicro / 1_000_000)}`;
  const fundCommand = `dvm credit fund ${shellQuoteArg(dvm)}`;
  const optIn = `dvm credit posture auto --dvm ${shellQuoteArg(dvm)}`;
  const covers =
    args.coversJobs !== undefined && args.coversJobs > 1
      ? ` about ${String(args.coversJobs)} jobs`
      : " a run of jobs";

  const display =
    suppressed.reason === "open"
      ? `Prepaid credit is available at ${dvm}. Funding ${amount} once would cover${covers} in a single payment and reduce per-job fees. Nothing was funded — this job paid per-call.`
      : `The prepaid credit at ${dvm} is running low. Adding ${amount} would keep${covers} on one payment and reduce per-job fees. Nothing was funded — jobs keep drawing on what is left, then go back to paying per-call.`;

  return {
    code: "credit_purchase_suppressed",
    dvm,
    endpoint: args.endpoint,
    reason: suppressed.reason,
    posture: args.posture,
    posture_source: args.postureSource,
    amount_micro: suppressed.fundMicro,
    currency: suppressed.currency,
    fund_command: fundCommand,
    opt_in_command: optIn,
    opt_in_command_global: "dvm credit posture auto",
    display,
    hint: `Fund it once with '${fundCommand}', or run '${optIn}' (drop --dvm for every DVM) and funding is handled automatically.`,
  };
}

/**
 * Build the report for an automatic purchase.
 *
 * `display` is written for the moment the purchase has landed, which is when
 * the terminal JSON carrying it is emitted. A purchase still riding on an
 * unfinished request is narrated by {@link noteCreditFunding} with
 * `stage: "in_flight"` instead, from the same fields.
 */
export function buildCreditFundingReport(args: {
  dvm: string;
  endpoint: string;
  reason: CreditFundingReason;
  amountMicro: number;
  currency: string;
  route: CreditFundRail;
  routeReason?: CreditRailReason;
  routeReasonSource?: CreditRailSource;
  x402Flavour?: X402CreditFlavour;
  tempoIntent?: "charge" | "session";
  /** The DVM's advertised Lightning floor, so a below-minimum route can quote it. */
  lightningMinMicro?: number;
  /** Balance after the deposit, micro-units, when the DVM stated one. */
  balanceMicro?: number;
  /** True when the funding rode a `/v1/credit` call rather than the job request. */
  ownRoundTrip?: boolean;
  outcome?: Pick<
    CreditFundOutcome,
    | "spentSats"
    | "principalSats"
    | "routingFeeSats"
    | "totalWalletFeeSats"
    | "unitemizedWalletFeeSats"
    | "walletDebitSats"
    | "paymentOutcome"
  >;
}): CreditFundingReport {
  const amount = `$${formatUsd(args.amountMicro / 1_000_000)}`;
  // The carrier is part of the route, and it follows the mechanism, not the
  // trigger: an in-request fund-and-draw rides the job, while everything the
  // post-job healthy moment funds — a refill, and an open the
  // float carries — is a `/v1/credit` round trip of its own.
  const ownCall = args.ownRoundTrip ?? args.reason === "below_refill_target";
  const routeDisplay = settledRouteDisplay(args.route, ownCall, args.x402Flavour, args.tempoIntent);
  const why = routeReasonClause(args.routeReason, args.routeReasonSource, args.lightningMinMicro);
  const balance =
    args.balanceMicro !== undefined
      ? ` Balance now $${formatUsd(args.balanceMicro / 1_000_000)}.`
      : "";
  const verb = args.reason === "no_credit_open" ? "Opened" : "Topped up";
  const lightningSpend = creditFundingSpendDisplay(args.outcome);

  return {
    code: "credit_funded",
    dvm: args.dvm,
    endpoint: args.endpoint,
    reason: args.reason,
    amount_micro: args.amountMicro,
    currency: args.currency,
    route: args.route,
    ...(args.routeReason ? { route_reason: args.routeReason } : {}),
    ...(args.routeReasonSource ? { route_reason_source: args.routeReasonSource } : {}),
    ...(args.x402Flavour ? { x402_flavour: args.x402Flavour } : {}),
    ...(args.tempoIntent ? { tempo_intent: args.tempoIntent } : {}),
    ...(args.outcome?.spentSats !== undefined ? { spent_sats: args.outcome.spentSats } : {}),
    ...(args.outcome?.principalSats !== undefined
      ? { principal_sats: args.outcome.principalSats }
      : {}),
    ...(args.outcome?.routingFeeSats !== undefined
      ? { routing_fee_sats: args.outcome.routingFeeSats }
      : {}),
    ...(args.outcome?.totalWalletFeeSats !== undefined
      ? { total_wallet_fee_sats: args.outcome.totalWalletFeeSats }
      : {}),
    ...(args.outcome?.unitemizedWalletFeeSats !== undefined
      ? { unitemized_wallet_fee_sats: args.outcome.unitemizedWalletFeeSats }
      : {}),
    ...(args.outcome?.walletDebitSats !== undefined
      ? { wallet_debit_sats: args.outcome.walletDebitSats }
      : {}),
    ...(args.outcome?.paymentOutcome ? { payment_outcome: args.outcome.paymentOutcome } : {}),
    display:
      `${verb} prepaid credit at ${args.dvm} with ${amount} — ${routeDisplay}${why}, because ${whyFunded(args.reason)}.${balance}${lightningSpend} ` +
      POSTURE_FOOTER,
  };
}

/**
 * Build the block for an automatic funding that did not land as asked.
 *
 * `display` and `hint` are the outcome's own, never recomposed: they are the
 * story the funding path assembled while it still knew what had moved — "the
 * Lightning payment of 350 sats went out, but the DVM won't be crediting it",
 * "don't fund again, a fresh funding id issues a second invoice" — and no
 * sentence written here could reconstruct it. Only the posture footer is added,
 * because the caller never typed this funding and the copy has to say so.
 *
 * `adoptedDrain` is the one exception, and it appends rather than substitutes
 * for the same reason: the outcome's hint is the server's, which cannot know
 * that this CLI has since recorded the reclaim it points at. The
 * `dvm credit fund` door composes its own hint the same way, off the same
 * sentence.
 *
 * The `code` is passed in rather than derived from the outcome's status: a
 * `funded` outcome reaches here only when it landed on another credit, and that
 * is a fact about the branch the reporter took, not one the status carries.
 */
export function buildCreditFundingIncomplete(args: {
  code: CreditFundingIncomplete["code"];
  dvm: string;
  endpoint: string;
  reason: CreditFundingReason;
  amountMicro: number;
  currency: string;
  outcome: CreditFundOutcome;
  adoptedDrain?: AdoptedWedgedDrain;
}): CreditFundingIncomplete {
  const { adoptedDrain, outcome } = args;
  const hint = [outcome.hint, adoptedDrain?.advice].filter(Boolean).join(" ");
  return {
    code: args.code,
    dvm: args.dvm,
    endpoint: args.endpoint,
    reason: args.reason,
    credit_id: outcome.creditId,
    fund_id: outcome.fundId,
    ...(outcome.rail ? { rail: outcome.rail } : {}),
    amount_micro: outcome.fundedMicro ?? args.amountMicro,
    currency: args.currency,
    ...(outcome.spentSats !== undefined ? { spent_sats: outcome.spentSats } : {}),
    ...(outcome.principalSats !== undefined ? { principal_sats: outcome.principalSats } : {}),
    ...(outcome.routingFeeSats !== undefined ? { routing_fee_sats: outcome.routingFeeSats } : {}),
    ...(outcome.totalWalletFeeSats !== undefined
      ? { total_wallet_fee_sats: outcome.totalWalletFeeSats }
      : {}),
    ...(outcome.unitemizedWalletFeeSats !== undefined
      ? { unitemized_wallet_fee_sats: outcome.unitemizedWalletFeeSats }
      : {}),
    ...(outcome.walletDebitSats !== undefined
      ? { wallet_debit_sats: outcome.walletDebitSats }
      : {}),
    ...(outcome.spentMicro !== undefined ? { spent_micro: outcome.spentMicro } : {}),
    ...(outcome.paymentOutcome ? { payment_outcome: outcome.paymentOutcome } : {}),
    ...(outcome.error ? { error_code: outcome.error.code } : {}),
    ...(adoptedDrain
      ? { drain_id: adoptedDrain.drainId, drain_command: adoptedDrain.command }
      : {}),
    display: `${outcome.display} ${POSTURE_FOOTER}`,
    ...(hint ? { hint } : {}),
  };
}

/**
 * Build the once-per-job diagnosis for a credit whose bound rail disappeared.
 *
 * The balance did not disappear with the rail: it remains drawable and
 * reclaimable. Draining is therefore offered as the explicit way to retire the
 * binding; a fresh credit can then apply the ordinary amount-aware rail pick.
 */
export function buildCreditRefillUnavailable(args: {
  dvm: string;
  endpoint: string;
  creditId: string;
  boundRail: CreditFundRail;
  balanceMicro: number;
  currency: string;
}): CreditRefillUnavailable {
  const { drainCommand, balanceRemedy } = refillBalanceRemedy(args.dvm, args.balanceMicro);
  const rail = fundingRailLabel(args.boundRail);
  return {
    code: "credit_refill_rail_unavailable",
    dvm: args.dvm,
    endpoint: args.endpoint,
    credit_id: args.creditId,
    bound_rail: args.boundRail,
    balance_micro: args.balanceMicro,
    currency: args.currency,
    drain_command: drainCommand,
    display:
      `The prepaid credit at ${args.dvm} is bound to ${rail}, but that funding rail is unavailable here, so it cannot refill. ` +
      balanceRemedy,
    hint: "A fresh credit will pick its funding rail by amount after this one is drained.",
  };
}

/**
 * The same diagnosis one level down: the x402 rail is still fundable here, but
 * the *instrument* this credit is pinned to is no longer offered on
 * the chain that decides its refills, so every top-up would be refused.
 *
 * Provable from a listing, which is why it exists separately from the
 * funding-time refusal in `credit-fund.ts` — that one is the authority and
 * speaks in the moment ("nothing was signed"); this one is what a caller reads
 * before a job has to discover it, and so says only what the record proves.
 *
 * Two shapes, and the difference is what the record proves. With `network` —
 * the chain a channel was opened on — the sentence can point at one chain,
 * because a channel is tied to it and re-pinning the wallet reaches a different
 * channel rather than this balance. Without one the claim has to be
 * chain-independent, which only holds where the bound flavour is offered on no
 * chain at all; anything narrower would be reading the wallet's current pin,
 * which a re-pin moves.
 *
 * `alternativeOffered` is the caller's own read of whether the *other* x402
 * flavour is offered — on that chain where there is one, else anywhere — and it
 * is what keeps the sentence honest: a DVM that has switched instruments still
 * takes x402 top-ups, they just can't be added to this credit, where one that
 * offers neither has dropped the route outright.
 */
export function buildCreditRefillInstrumentUnavailable(args: {
  dvm: string;
  endpoint: string;
  creditId: string;
  instrument: X402CreditInstrument;
  /** CAIP-2 chain this credit's channel was opened on, where the record has it. */
  network?: string;
  alternativeOffered: boolean;
  balanceMicro: number;
  currency: string;
}): CreditRefillUnavailable {
  const { drainCommand, balanceRemedy } = refillBalanceRemedy(args.dvm, args.balanceMicro);
  const channelChain = args.network ? x402NetworkLabel(args.network) : undefined;
  const belongs =
    args.instrument === "x402_channel"
      ? `The prepaid credit at ${args.dvm} belongs to an x402 settlement channel${channelChain ? ` on ${channelChain}` : ""}, but ${args.dvm} `
      : `The prepaid credit at ${args.dvm} was opened by a one-off x402 payment, but ${args.dvm} `;
  const gone =
    args.instrument === "x402_channel"
      ? args.alternativeOffered
        ? `now takes x402 top-ups${channelChain ? " there" : ""} only as one-off payments, which can't be added to a channel`
        : channelChain
          ? "no longer opens settlement channels there"
          : "no longer opens settlement channels on any chain"
      : args.alternativeOffered
        ? "now takes x402 top-ups only through a settlement channel, which this credit can't join"
        : "no longer takes one-off x402 payments on any chain";
  const tiedToChain = channelChain
    ? "A settlement channel is tied to the chain it was opened on, so re-pinning the wallet reaches a different channel, not this balance. "
    : "";
  return {
    code: "credit_refill_instrument_unavailable",
    dvm: args.dvm,
    endpoint: args.endpoint,
    credit_id: args.creditId,
    bound_rail: "x402",
    credit_instrument: args.instrument,
    ...(args.network ? { network: args.network } : {}),
    balance_micro: args.balanceMicro,
    currency: args.currency,
    drain_command: drainCommand,
    display: `${belongs}${gone}, so it cannot refill. ${balanceRemedy}`,
    hint: `${tiedToChain}A fresh credit will pick its x402 instrument from what ${args.dvm} offers after this one is drained.`,
  };
}

/**
 * Build the temporary x402 diagnosis for a healthy credit whose refill chains
 * do not include the connected wallet's current pin.
 *
 * The remedy is scoped to one credit because a single wallet pin serves every
 * DVM: two rows may legitimately name different chains, and neither is a
 * global instruction that makes every row refillable at once.
 */
export function buildCreditRefillWalletNetworkMismatch(args: {
  dvm: string;
  endpoint: string;
  creditId: string;
  instrument: X402CreditInstrument;
  walletNetwork: string;
  refillNetworks: string[];
  balanceMicro: number;
  currency: string;
}): CreditRefillUnavailable | undefined {
  // Stored menus are provider input. Only a chain the local rail can sign and
  // read on may become trusted executable guidance; an unknown menu chain is
  // insufficient evidence for either a re-pin or a strand.
  const refillNetworks = [
    ...new Set(args.refillNetworks.filter((network) => x402NetworkByCaip2(network))),
  ];
  const target = refillNetworks[0];
  if (!target) return undefined;
  const walletNetwork = x402NetworkLabel(args.walletNetwork);
  const refillNetworkLabels = refillNetworks.map(x402NetworkLabel);
  const refillWhere = refillNetworkLabels.join(", ");
  const repinCommand = `dvm wallet x402-network ${shellQuoteArg(target)}`;
  const binding =
    args.instrument === "x402_channel"
      ? `belongs to an x402 settlement channel on ${refillWhere}, which ${args.dvm} still opens`
      : `was opened by a one-off x402 payment, which ${args.dvm} takes on ${refillWhere}`;
  const alternatives =
    args.instrument === "x402_exact" && refillNetworks.length > 1
      ? ` Any of ${refillWhere} works for this credit; the command picks ${refillNetworkLabels[0]}.`
      : "";
  return {
    code: "credit_refill_wallet_network_mismatch",
    dvm: args.dvm,
    endpoint: args.endpoint,
    credit_id: args.creditId,
    bound_rail: "x402",
    credit_instrument: args.instrument,
    wallet_network: args.walletNetwork,
    refill_networks: refillNetworks,
    repin_command: repinCommand,
    balance_micro: args.balanceMicro,
    currency: args.currency,
    display: `The prepaid credit at ${args.dvm} ${binding}, but the connected wallet is pinned to ${walletNetwork}, so this credit cannot refill from the current pin.`,
    hint:
      `For this credit's next refill, re-pin the wallet without handling its key: '${repinCommand}'.${alternatives} ` +
      "One x402 wallet pin applies at a time; another credit row may name a different chain.",
  };
}

/**
 * Build the diagnosis for a refill this credit's own recorded reclaim held back.
 *
 * The gate itself is right: refilling a balance the caller is taking back would
 * be perverse, and while the reclaim is in flight against a wedged channel the
 * draws are refused too, so the hold announces itself on every request. What it
 * cannot see is the far side of that. Once an operator repairs the settlement
 * the draws resume, the balance spends down, and nothing retires the record but
 * the reclaim itself — so the top-up is off for good with nothing said, on a
 * credit whose caller may quite reasonably never bother to reclaim it
 * *
 * `drainCommand` is handed in rather than composed here, so this quotes the
 * same command as the refusal that recorded the drain in the first place.
 */
export function buildCreditRefillDrainPending(args: {
  dvm: string;
  endpoint: string;
  creditId: string;
  drainId: string;
  drainCommand: string;
  balanceMicro: number;
  currency: string;
}): CreditRefillUnavailable {
  const balance = `$${formatUsd(Math.max(args.balanceMicro, 0) / 1_000_000)}`;
  return {
    code: "credit_refill_drain_pending",
    dvm: args.dvm,
    endpoint: args.endpoint,
    credit_id: args.creditId,
    drain_id: args.drainId,
    drain_command: args.drainCommand,
    balance_micro: args.balanceMicro,
    currency: args.currency,
    display:
      `The prepaid credit at ${args.dvm} is down to ${balance} and due a top-up, but drain ${args.drainId} is on record as reclaiming this credit, so nothing was funded. ` +
      "Automatic top-up stays off here until that reclaim is posted.",
    hint:
      `Post it with '${args.drainCommand}', which takes the balance back and is also what clears the record, so top-ups resume. ` +
      "Until then jobs keep drawing on what is left, then go back to paying per-call.",
  };
}

/**
 * Surface a suppressed purchase.
 *
 * The prose goes to stderr in **both** modes, which is how the rest of the
 * credit path narrates itself (stderr is human-visible and ignored by JSON
 * consumers), and the structured block is stashed for the JSON emission. A
 * second suggestion in one command replaces the first — the last one describes
 * what the caller is actually left holding.
 */
export function noteCreditSuggestion(suggestion: CreditSuggestion, human?: boolean): void {
  info(`${suggestion.display} ${suggestion.hint}`);
  if (!human) pending.credit_suggestion = suggestion;
}

/**
 * Surface an automatic purchase. Same stderr/sink split as
 * {@link noteCreditSuggestion}, but the block **appends** rather than replaces
 * Every call here is a distinct spend, so a second funding in one
 * command that wrote over the first would leave the agent's only machine-
 * readable record short by a purchase — even while both stderr lines print.
 *
 * `stage: "in_flight"` is for a funding that rides on a request still in the
 * air: the stderr line stays present-tense, so a submit that then fails hasn't
 * claimed a purchase that never landed. The structured block is stashed either
 * way for the terminal JSON emission, including an error after a failed submit.
 */
export function noteCreditFunding(
  report: CreditFundingReport,
  human?: boolean,
  stage: CreditFundingStage = "settled"
): void {
  info(stage === "in_flight" ? inFlightLine(report) : report.display);
  if (!human) (pending.credit_funding ??= []).push(report);
}

/**
 * Carry a funding that didn't land as asked to terminal JSON.
 *
 * The one `note*` that does not narrate. Every other outcome on this path has
 * a single sentence, but these four are announced by the funding reporter,
 * which owns the "Credit top-up" / "Credit opening" label and the
 * paid-but-not-credited wording that must not read as "skipped" — so a second
 * `info` here would print the story twice.
 *
 * Appends, for the reason {@link noteCreditFunding} does: one
 * `settleCreditAfterJob` runs the refill leg and the deferred-open leg
 * independently, so two fundings can each miss in one command, and a block that
 * carries a spend is the last thing that may be written over.
 */
export function noteCreditFundingIncomplete(
  incomplete: CreditFundingIncomplete,
  human?: boolean
): void {
  if (!human) (pending.credit_funding_incomplete ??= []).push(incomplete);
}

/**
 * Explain a live credit that went undrawn, in the caller's own vocabulary:
 * what is still parked here, why this job did not spend it, and the one
 * command that changes the outcome.
 */
export function buildCreditDrawSkipped(args: {
  dvm: string;
  endpoint: string;
  skip: DrawSkip;
}): CreditDrawSkipped {
  const { dvm, skip } = args;
  const handle = shellQuoteArg(dvm);
  const balance = `$${formatUsd(skip.remainingMicro / 1_000_000)}`;
  const parked = `${balance} of prepaid credit is held at ${dvm}`;

  const { display, hint } = ((): { display: string; hint: string } => {
    switch (skip.reason) {
      case "posture_off":
        return {
          display: `${parked}, but prepaid credit is switched off here, so this job pays per-call instead.`,
          hint: `Spend it with 'dvm credit posture suggest --dvm ${handle}', or reclaim it with 'dvm credit drain ${handle}'.`,
        };
      case "not_active":
        return {
          display: `${parked} on a credit that is no longer live, so this job pays per-call instead.`,
          hint: `The balance is still yours — reclaim it with 'dvm credit drain ${handle}'.`,
        };
      case "reconciliation_pending":
        return {
          display: `${parked}, but the DVM could not confirm its backing on chain, so this job pays per-call instead.`,
          hint: `Retry 'dvm credit balance ${handle}' after the chain read recovers. Do not top up this credit while reconciliation is pending.`,
        };
      case "exhausted":
        return {
          display: `The prepaid credit at ${dvm} is spent, so this job pays per-call instead.`,
          hint: `Top it back up with 'dvm credit fund ${handle}'.`,
        };
      case "expired":
        return {
          display: `${parked} on a credit that has expired, so this job pays per-call instead.`,
          hint: `An expired credit keeps its balance — reclaim it with 'dvm credit drain ${handle}'.`,
        };
      case "price_above_ceiling": {
        const last = `$${formatUsd((skip.lastPriceMicro ?? 0) / 1_000_000)}`;
        const ceiling = `$${formatUsd((skip.ceilingMicro ?? 0) / 1_000_000)}`;
        return {
          display:
            `${parked}, but this capability's quoted or last drawn price is ${last}, above the ${ceiling} ceiling this request declared — ` +
            `so it was left undrawn and this job pays per-call instead.`,
          hint: raiseCeilingHint(skip.ceilingSource, last),
        };
      }
    }
  })();

  return {
    code: "credit_draw_skipped",
    dvm,
    endpoint: args.endpoint,
    credit_id: skip.creditId,
    reason: skip.reason,
    balance_micro: skip.remainingMicro,
    ...(skip.ceilingMicro !== undefined ? { ceiling_micro: skip.ceilingMicro } : {}),
    ...(skip.lastPriceMicro !== undefined ? { last_price_micro: skip.lastPriceMicro } : {}),
    ...(skip.ceilingSource !== undefined ? { ceiling_source: skip.ceilingSource } : {}),
    display,
    hint,
  };
}

export function buildSiblingCreditAvailable(args: {
  dvm: string;
  endpoint: string;
  trackedCreditId: string;
  siblingCreditId: string;
  siblingBalanceMicro: number;
  requiredMicro: number;
  currency: string;
}): SiblingCreditAvailable {
  const balance = formatFiat(args.siblingBalanceMicro / 1_000_000, args.currency);
  const required = formatFiat(args.requiredMicro / 1_000_000, args.currency);
  const drainCommand = `dvm credit drain ${shellQuoteArg(args.dvm)} --credit-id ${shellQuoteArg(args.siblingCreditId)}`;
  return {
    code: "sibling_credit_available",
    dvm: args.dvm,
    endpoint: args.endpoint,
    tracked_credit_id: args.trackedCreditId,
    sibling_credit_id: args.siblingCreditId,
    sibling_balance_micro: args.siblingBalanceMicro,
    required_micro: args.requiredMicro,
    currency: args.currency,
    drain_command: drainCommand,
    display: `Tracked credit ${args.trackedCreditId} is too short for this ${required} job, while sibling credit ${args.siblingCreditId} holds ${balance} and could cover it. The CLI does not switch credits automatically.`,
    hint: `Reclaim that sibling with this command: ${drainCommand}. Or keep it there and let this job use the ordinary payment or tracked-credit top-up path.`,
  };
}

export function noteCreditDrawSkipped(skipped: CreditDrawSkipped, human?: boolean): void {
  info(`${skipped.display} ${skipped.hint}`);
  if (!human) pending.credit_draw_skipped = skipped;
}

export function noteSiblingCreditAvailable(
  available: SiblingCreditAvailable,
  human?: boolean
): void {
  info(`${available.display} ${available.hint}`);
  if (!human) pending.credit_sibling = available;
}

/**
 * Build the notice for two hostnames of one DVM pinned to different rails.
 *
 * Names both former rails rather than picking one: there is no reading of the
 * config that honours both, and the caller is the only one who knows which
 * they meant. The amount rule is in charge until they say.
 */
export function buildCreditRailPinConflict(args: {
  dvm: string;
  endpoint: string;
  formerRails: CreditFundRail[];
  endpoints: string[];
  nowRail?: CreditFundRail;
}): CreditRailPinConflict {
  // The choices offered are the caller's own two, not the whole rail registry:
  // this notice exists to recover an intent they already expressed twice.
  const repinCommand = `dvm credit rail <${args.formerRails.join("|")}> --dvm ${shellQuoteArg(args.dvm)}`;
  const named = args.formerRails.map(fundingRailLabel).join(" and ");
  // What decides next is the layer below the dropped pins, not always the
  // amount rule: a caller with a global pin falls through to it.
  const decides = args.nowRail
    ? `your account-wide ${fundingRailLabel(args.nowRail)} pin now applies here`
    : "the amount rule now picks";
  return {
    code: "credit_rail_pin_conflict",
    dvm: args.dvm,
    endpoint: args.endpoint,
    former_rails: args.formerRails,
    endpoints: args.endpoints,
    repin_command: repinCommand,
    ...(args.nowRail ? { now_rail: args.nowRail } : {}),
    display: `${args.dvm} answers on ${String(args.endpoints.length)} addresses you had pinned to different funding rails — ${named} — so both pins were cleared and ${decides}.`,
    hint: `Re-pin the one you meant with '${repinCommand}'. It will then apply however you spell the DVM.`,
  };
}

export function noteCreditRailPinConflict(conflict: CreditRailPinConflict, human?: boolean): void {
  info(`${conflict.display} ${conflict.hint}`);
  if (!human) pending.credit_rail_pin_conflict = conflict;
}

export function noteCreditRefillUnavailable(
  unavailable: CreditRefillUnavailable,
  human?: boolean
): void {
  info(`${unavailable.display} ${unavailable.hint}`);
  if (!human) pending.credit_refill = unavailable;
}

/**
 * Take whatever credit notices this command accumulated, clearing them.
 * Spread into a terminal JSON emission; safe to call from every one of them
 * because only the first call after a notice was recorded returns anything.
 */
export function takeCreditNoticeFields(): CreditNoticeFields {
  const taken = { ...pending };
  pending = {};
  return taken;
}

export function resetCreditNotices(): void {
  pending = {};
}


function creditFundingSpendDisplay(
  outcome:
    | Pick<
        CreditFundOutcome,
        | "principalSats"
        | "routingFeeSats"
        | "totalWalletFeeSats"
        | "unitemizedWalletFeeSats"
        | "walletDebitSats"
      >
    | undefined
): string {
  if (outcome?.principalSats === undefined) return "";
  const principal = outcome.principalSats;
  if (outcome.walletDebitSats == null || outcome.totalWalletFeeSats == null) {
    const routing =
      outcome.routingFeeSats == null
        ? "The wallet did not report its routing fee."
        : `The wallet reported ${satCount(outcome.routingFeeSats)} of routing fee.`;
    return ` Invoice principal ${satCount(principal)}; the total wallet debit is unknown. ${routing}`;
  }
  if (outcome.routingFeeSats == null) {
    return ` ${satCount(outcome.walletDebitSats)} went out: invoice principal ${satCount(principal)} and total wallet fee ${satCount(outcome.totalWalletFeeSats)}. The wallet did not report its routing fee, so the fee split is unknown.`;
  }
  if (outcome.unitemizedWalletFeeSats == null) {
    return ` ${satCount(outcome.walletDebitSats)} went out: invoice principal ${satCount(principal)} and total wallet fee ${satCount(outcome.totalWalletFeeSats)}. The wallet reported ${satCount(outcome.routingFeeSats)} of routing fee; the remaining fee split is unknown.`;
  }
  return ` ${satCount(outcome.walletDebitSats)} went out: invoice principal ${satCount(principal)} and total wallet fee ${satCount(outcome.totalWalletFeeSats)} (${satCount(outcome.routingFeeSats)} wallet-reported routing fee and ${satCount(outcome.unitemizedWalletFeeSats)} unitemized wallet fee).`;
}

function satCount(value: number): string {
  return `${String(value)} sat${value === 1 ? "" : "s"}`;
}

/**
 * What is left to do about the balance itself, shared by both refill
 * diagnoses: a binding that closed never takes the money with it. A positive
 * balance is reclaimable, and an empty one is only a local record to retire —
 * offering a drain that moves nothing would send the caller after a payout the
 * server has no reason to make.
 */
function refillBalanceRemedy(
  dvm: string,
  balanceMicro: number
): { drainCommand: string; balanceRemedy: string } {
  const balance = `$${formatUsd(Math.max(balanceMicro, 0) / 1_000_000)}`;
  const drainCommand = `dvm credit drain ${shellQuoteArg(dvm)}`;
  return {
    drainCommand,
    balanceRemedy:
      balanceMicro > 0
        ? `Its ${balance} balance is still spendable and reclaimable with '${drainCommand}'.`
        : `Its ${balance} balance has nothing left to reclaim; '${drainCommand}' retires the empty local credit.`,
  };
}

/**
 * The remedy for a draw the price proxy refused, naming the knob that actually
 * set the ceiling.
 *
 * Three knobs can set it and only one is `--budget`; each remedy must name
 * the knob that changes the effective ceiling.
 */
function raiseCeilingHint(source: DrawCeilingSource | undefined, last: string): string {
  switch (source) {
    case "auto_pay_below":
      return (
        `Raise the ceiling to draw on it: re-run with --auto-pay-below at or above ${last}. ` +
        "--budget won't move it while --auto-pay-below is set."
      );
    case "config_threshold":
      return (
        `Your standing auto-pay threshold set this ceiling, not --budget. Re-run with --auto-pay-below ` +
        `at or above ${last} for this job, or raise 'autoPayThreshold' in ~/.dvm/config.json for every job.`
      );
    // `budget`, and any skip recorded before the source was carried.
    default:
      return `Raise the ceiling to draw on it: re-run with --budget at or above ${last}.`;
  }
}

const POSTURE_FOOTER =
  "This is automatic under 'posture: auto'; 'dvm credit posture suggest' returns to being asked first.";

/**
 * The parenthetical after the route — why the funding went the way it did
 * *
 * Written for the audience that reads it: an agent relaying to a human who has
 * no idea a Lightning receive channel has a routing minimum, so the ecash cases
 * say what the alternative *was* and why it didn't apply. Kept short — this
 * sits mid-sentence in a line that already carries amount, trigger and balance.
 */
function routeReasonClause(
  reason: CreditRailReason | undefined,
  source: CreditRailSource | undefined,
  lightningMinMicro: number | undefined
): string {
  const floor =
    lightningMinMicro !== undefined ? `$${formatUsd(lightningMinMicro / 1_000_000)}` : undefined;
  switch (reason) {
    case "above_lightning_minimum":
      return floor
        ? ` (at or above this DVM's ${floor} Lightning minimum, so it skips the mint)`
        : " (large enough to go direct, so it skips the mint)";
    case "below_lightning_minimum":
      return floor
        ? ` (below this DVM's ${floor} Lightning minimum, which ecash has no floor for)`
        : " (below this DVM's Lightning minimum, which ecash has no floor for)";
    case "no_float":
      return " (no Lightning wallet is connected here)";
    case "lightning_not_offered":
      return " (this DVM takes no Lightning funding)";
    case "no_lightning_minimum":
      return " (this DVM states no Lightning minimum, so ecash stays the default)";
    case "x402_channel":
      return " (this prepaid credit can use a reusable x402 stablecoin channel)";
    case "x402_exact":
      return " (this prepaid credit uses one signed x402 stablecoin authorization per top-up)";
    case "tempo_session_available":
      return " (this prepaid credit can use Tempo's reusable stablecoin channel)";
    case "tempo_charge":
      return " (this prepaid credit uses one ordinary Tempo stablecoin charge per top-up)";
    case "forced":
      return forcedRouteClause(source);
    default:
      return "";
  }
}

/** The `forced` arm, split out because each source is a different claim. */
function forcedRouteClause(source: CreditRailSource | undefined): string {
  switch (source) {
    case "per_dvm":
      return " (funding at this DVM is pinned to that rail)";
    case "global":
      return " (funding is pinned to that rail for every DVM)";
    case "credit_bound":
      return " (this credit was opened on that rail, so top-ups can only arrive on it)";
    default:
      return " (that rail was requested)";
  }
}

/** The clause after "because" — one per trigger, never inferred from the plan shape. */
function whyFunded(reason: CreditFundingReason): string {
  switch (reason) {
    case "no_credit_open":
      return "no prepaid credit was open here, and the payment was sized to cover a run of jobs and reduce per-job fees";
    case "short_for_job":
      return "the prepaid credit here could not cover this job on its own";
    case "below_refill_target":
      return "the balance dropped below a quarter of its refill target";
  }
}

/**
 * How a settled funding was carried. Exhaustive over the rail registry with no
 * `default`, so adding a rail is a compile error here rather than a funding
 * that quietly narrates itself as ecash (the return type has no `undefined`).
 */
function settledRouteDisplay(
  rail: CreditFundRail,
  ownCall: boolean,
  x402Flavour: X402CreditFlavour | undefined,
  tempoIntent: "charge" | "session" | undefined
): string {
  switch (rail) {
    case "lightning":
      return "paid from your Lightning wallet";
    case "cashu":
      return ownCall
        ? "paid in ecash, in a funding call of its own"
        : "paid in ecash, riding inside the job request";
    case "x402":
      if (x402Flavour === "exact") return "paid by one x402 stablecoin authorization";
      if (x402Flavour === "batch-settlement") {
        return "funded from your x402 stablecoin wallet through its reusable custody channel";
      }
      return "funded from your x402 stablecoin wallet";
    case "tempo":
      if (tempoIntent === "charge") return "paid by one ordinary Tempo stablecoin charge";
      if (tempoIntent === "session") {
        return "funded from your Tempo stablecoin wallet through its reusable custody channel";
      }
      return "funded from your Tempo stablecoin wallet";
  }
}

function inFlightRouteDisplay(
  rail: CreditFundRail,
  x402Flavour: X402CreditFlavour | undefined,
  tempoIntent: "charge" | "session" | undefined
): string {
  switch (rail) {
    case "lightning":
      return "your Lightning wallet is paying it";
    case "cashu":
      return "the payment rides inside this job request as ecash";
    case "x402":
      if (x402Flavour === "exact") {
        return "your x402 wallet is signing one stablecoin authorization";
      }
      if (x402Flavour === "batch-settlement") {
        return "your x402 wallet is funding its reusable custody channel";
      }
      return "your x402 wallet is funding prepaid credit";
    case "tempo":
      if (tempoIntent === "charge") {
        return "your Tempo wallet is signing one ordinary stablecoin charge";
      }
      if (tempoIntent === "session") {
        return "your Tempo wallet is funding its reusable custody channel";
      }
      return "your Tempo wallet is funding prepaid credit";
  }
}

function inFlightLine(report: CreditFundingReport): string {
  const amount = `$${formatUsd(report.amount_micro / 1_000_000)}`;
  const route = inFlightRouteDisplay(report.route, report.x402_flavour, report.tempo_intent);
  return (
    `Funding ${amount} of prepaid credit at ${report.dvm} — ${route}, because ${whyFunded(report.reason)}. ` +
    `It lands when the job does. ${POSTURE_FOOTER}`
  );
}

let pending: CreditNoticeFields = {};
