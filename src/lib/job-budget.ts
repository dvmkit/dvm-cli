import { usdToMsats, type JobPolicy, type PaymentRequestContent } from "@dvmkit/sdk/internal";
import { formatSats } from "./currency";

/**
 * A job's spending policy as saved. `maxTotalUsdMicro` is the budget exactly as
 * the caller declared it in dollars, in integer micro-dollars; absent on a sat
 * budget and on jobs saved before dollar budgets were kept.
 */
export interface JobBudgetPolicy extends JobPolicy {
  maxTotalUsdMicro?: number;
}

/** The spend counters a budget check reads from a job record. */
export interface JobBudgetLedger {
  totalPaidMsats?: number;
  /**
   * The payer's refusal of an ask, keyed by its seq, when the amount a rail
   * signed was checked rather than the ask's own figures. A next step reads it
   * so it never offers a payment the payer refuses.
   */
  budgetRefusals?: Record<string, BudgetOverrun>;
  /** Exact dollars booked, in micro-dollars, for payments whose dollars are what left the wallet. */
  paidUsdMicro?: number;
  /**
   * The share of {@link totalPaidMsats} that {@link paidUsdMicro} covers. The
   * dollar total is complete only while the two are equal; a payment booked
   * without exact dollars, or by an older CLI, leaves them apart.
   */
  paidUsdMsats?: number;
}

export type BudgetVerdict = { fits: true; unit: "usd" | "msats" } | BudgetOverrun;
export type BudgetOverrun = { fits: false; unit: "usd" | "msats"; spent: number; ask: number; total: number; cap: number };

/**
 * One sat: the rounding a provider may add when it converts a dollar price to
 * whole sats. An ask's sats may exceed its dollar price at the caller's rate by
 * at most this much and still be held to its dollars.
 */
export const ASK_SAT_ROUNDING_MSATS = 1_000;

/**
 * Whether an ask fits the job's budget.
 *
 * Dollars decide only when all of these hold:
 * - the budget was declared in dollars;
 * - every payment booked so far carried the dollars that left the wallet;
 * - the ask carries an exact dollar figure;
 * - at the caller's own BTC/USD `rate`, the ask's sats come to no more than
 *   those dollars plus {@link ASK_SAT_ROUNDING_MSATS}.
 *
 * Then booked dollars plus the ask must not exceed the declared budget, with
 * no tolerance. Anything else compares millisats against the budget converted
 * at submit, as before. That includes a provider whose sats overstate its
 * dollar price, a missing rate, and jobs saved before dollar budgets were kept.
 */
export function budgetVerdict(
  policy: JobBudgetPolicy,
  ledger: JobBudgetLedger | undefined,
  ask: { msats: number; usdMicro?: number; rate?: number }
): BudgetVerdict {
  const spentMsats = ledger?.totalPaidMsats ?? 0;
  const cap = policy.maxTotalUsdMicro;
  const paidUsd = ledger?.paidUsdMicro ?? 0;
  const askUsd = dollarBoundUsdMicro(ask);
  if (validMicro(cap) && askUsd !== undefined && dollarLedgerComplete(ledger) && validMicro(paidUsd)) {
    const total = paidUsd + askUsd;
    return total > cap ? { fits: false, unit: "usd", spent: paidUsd, ask: askUsd, total, cap } : { fits: true, unit: "usd" };
  }
  const total = spentMsats + ask.msats;
  return total > policy.maxTotalMsats
    ? { fits: false, unit: "msats", spent: spentMsats, ask: ask.msats, total, cap: policy.maxTotalMsats }
    : { fits: true, unit: "msats" };
}

/**
 * The ask's dollars when its sats are held to them: the exact figure, provided
 * its sats at `rate` come to at most those dollars plus one sat. Undefined
 * otherwise, so the payment is booked without dollars and the job's later
 * asks compare in millisats.
 */
export function dollarBoundUsdMicro(ask: { msats: number; usdMicro?: number; rate?: number }): number | undefined {
  const { msats, usdMicro: dollars, rate } = ask;
  if (dollars === undefined || !validMicro(dollars) || dollars <= 0 || !Number.isSafeInteger(msats) || msats < 0 ||
      rate === undefined || !Number.isFinite(rate) || rate <= 0) return undefined;
  return msats <= usdToMsats(dollars / 1_000_000, rate) + ASK_SAT_ROUNDING_MSATS ? dollars : undefined;
}

/**
 * The ask's exact USD price in micro-dollars: the integer `credit` charge the
 * provider pinned, else the x402 offer's exact USDC amount. `fiat_amount` is a
 * rounded display figure and never counts.
 */
export function askUsdMicro(request: Pick<PaymentRequestContent, "credit" | "x402">): number | undefined {
  const credit = request.credit;
  if (credit) return usdMicro(credit.amount_micro, credit.currency);
  const required = request.x402?.required_usdc_micro;
  return typeof required === "string" && /^\d+$/.test(required) ? usdMicro(Number(required), "usd") : undefined;
}

/** A USD-denominated integer micro amount, or undefined for any other currency or value. */
export function usdMicro(amountMicro: unknown, currency: unknown): number | undefined {
  return typeof currency === "string" && currency.toLowerCase() === "usd" && validMicro(amountMicro)
    ? amountMicro : undefined;
}

/**
 * One sentence naming the spend, the ask, the total and the overrun, in the
 * unit that decided. Sat figures switch to exact msats, all in one format,
 * when any is not a whole sat: rounded, a total can read equal to its budget.
 */
export function describeBudgetOverrun(verdict: BudgetOverrun, policy?: JobBudgetPolicy): string {
  const figures = [verdict.spent, verdict.ask, verdict.total, verdict.cap];
  const format = verdict.unit === "usd" ? formatUsdMicro
    : figures.every((msats) => msats % 1000 === 0) ? formatSats : (msats: number) => `${msats.toLocaleString("en-US")} msats`;
  // A dollar budget held to sats: say which dollar figure those sats stand for.
  const declared = verdict.unit === "msats" && policy?.maxTotalUsdMicro !== undefined
    ? ` (your ${formatUsdMicro(policy.maxTotalUsdMicro)} budget, converted to sats when the job started)` : "";
  return `This charge would take the job past its budget: ${format(verdict.spent)} spent so far plus ` +
    `${format(verdict.ask)} asked comes to ${format(verdict.total)}, ${format(verdict.total - verdict.cap)} ` +
    `over the ${format(verdict.cap)} budget${declared}.`;
}

/** Exact dollars from micro-dollars: at least cents, more places only when they are non-zero. */
export function formatUsdMicro(micro: number): string {
  const whole = Math.floor(micro / 1_000_000);
  const fraction = String(micro % 1_000_000).padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `$${whole.toLocaleString("en-US")}.${fraction}`;
}

function dollarLedgerComplete(ledger: JobBudgetLedger | undefined): boolean {
  return (ledger?.paidUsdMsats ?? 0) === (ledger?.totalPaidMsats ?? 0);
}

function validMicro(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
