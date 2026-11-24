import { assertValidBudget, decimalRatio, parseBudget } from "./currency";
import { DvmError } from "@dvmkit/sdk/internal";
import type { JobBudgetPolicy } from "./job-budget";
import { dollarLimitMicro } from "./quote-limit";

/**
 * Build a JobPolicy from CLI options and/or config values.
 * Budget strings can be msats ("5000") or USD ("$0.50").
 * `maxPayments` is required — pass 0 for free jobs, 1 for typical paid jobs, higher for multi-turn flows.
 */
export function buildPolicy(
  opts: { budget?: string; autoPayBelow?: string; maxIncrement?: string; maxPayments?: number },
  btcRate: number
): JobBudgetPolicy {
  if (opts.maxPayments === undefined) {
    throw new DvmError(
      "missing_max_payments",
      "Cannot build a spending policy without a payment count cap.",
      "Pass --max-payments <n> on dvm request. Use 0 for free jobs, 1 for typical paid jobs, or higher for multi-turn flows that may require progressive payments."
    );
  }
  if (!Number.isInteger(opts.maxPayments) || opts.maxPayments < 0) {
    throw new DvmError(
      "invalid_max_payments",
      "Invalid value for --max-payments.",
      "Pass a non-negative integer (e.g. --max-payments 1)."
    );
  }

  const maxTotalMsats = opts.budget ? parseBudget(opts.budget, btcRate) : 0;
  const autoPayBelowMsats = opts.autoPayBelow
    ? parseBudget(opts.autoPayBelow, btcRate)
    : Math.floor(maxTotalMsats * 0.2);
  const maxIncrementMsats = opts.maxIncrement
    ? parseBudget(opts.maxIncrement, btcRate)
    : maxTotalMsats;

  // Keep a dollar budget in dollars too, so dollar-priced asks are held to the
  // figure the caller approved rather than its one-time sat conversion.
  const maxTotalUsdMicro = opts.budget?.trim().startsWith("$") ? dollarLimitMicro(opts.budget) : undefined;
  return { maxTotalMsats, autoPayBelowMsats, maxIncrementMsats, maxPayments: opts.maxPayments, maxIncrementExplicit: opts.maxIncrement !== undefined,
    ...(maxTotalUsdMicro !== undefined && Number.isSafeInteger(Number(maxTotalUsdMicro))
      ? { maxTotalUsdMicro: Number(maxTotalUsdMicro) } : {}) };
}

export function defaultPaymentCount(budget: string | undefined, perPayment: string | undefined, btcRate: number): number {
  if (!budget || !perPayment) return 100;
  const budgetIsUsd = budget.startsWith("$");
  const capIsUsd = perPayment.startsWith("$");
  const rate = budgetIsUsd === capIsUsd ? [1n, 1n] : decimalRatio(String(btcRate));
  if (!rate || rate[0] === 0n) return 100;

  // Convert mixed amounts to rational millisats without rounding either operand.
  const amount = (text: string, dollars: boolean) => {
    if (!dollars) return decimalRatio(String(assertValidBudget(text)));
    const usd = decimalRatio(text.slice(1)) ?? decimalRatio(String(assertValidBudget(text)));
    return usd && budgetIsUsd !== capIsUsd
      ? [usd[0] * 100_000_000_000n * rate[1], usd[1] * rate[0]]
      : usd;
  };
  const total = amount(budget, budgetIsUsd);
  const cap = amount(perPayment, capIsUsd);
  if (!total || !cap || cap[0] === 0n) return 100;
  const numerator = total[0] * cap[1];
  const denominator = total[1] * cap[0];
  const count = Number((numerator + denominator - 1n) / denominator);
  return Math.min(Math.max(5, count), Number.MAX_SAFE_INTEGER);
}
