import { parseBudget } from "./currency";
import { DvmError } from "@dvmkit/sdk/internal";

import type { JobPolicy } from "@dvmkit/sdk/internal";

/**
 * Build a JobPolicy from CLI options and/or config values.
 * Budget strings can be msats ("5000") or USD ("$0.50").
 * `maxPayments` is required — pass 0 for free jobs, 1 for typical paid jobs, higher for multi-turn flows.
 */
export function buildPolicy(
  opts: { budget?: string; autoPayBelow?: string; maxIncrement?: string; maxPayments?: number },
  btcRate: number
): JobPolicy {
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

  return { maxTotalMsats, autoPayBelowMsats, maxIncrementMsats, maxPayments: opts.maxPayments };
}
