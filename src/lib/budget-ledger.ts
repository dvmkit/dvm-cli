import { BUDGET_FILE } from "@dvmkit/sdk/internal";
import { resolveBtcUsdRate } from "./btc-rate";
import { formatUsd } from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";
import {
  breakdownSince,
  capFor,
  checkBudgetForLedger,
  windowStart,
  windowEnd,
  type BudgetCaps,
  type BudgetLedger,
  type BudgetWindow,
  type BudgetCheckResult,
  type BudgetSpendBreakdown,
  type RecordSpendOptions,
} from "@dvmkit/sdk/internal";
import { appendBudgetSpend, loadBudgetLedger, saveBudgetLedger } from "@dvmkit/sdk/internal";
export {
  type BudgetWindow,
  type BudgetCaps,
  type BudgetSpendKind,
  type BudgetLedgerEntry,
  type BudgetLedger,
  type BudgetSpendBreakdown,
  type BudgetCheckResult,
  type RecordSpendOptions,
  entryKind,
  windowStart,
  windowEnd,
} from "@dvmkit/sdk/internal";

export function loadLedger(): BudgetLedger {
  return loadBudgetLedger(BUDGET_FILE);
}

export function saveLedger(ledger: BudgetLedger, _now: Date = new Date()): void {
  saveBudgetLedger(BUDGET_FILE, ledger);
}

/** Replace caps in the ledger; preserves existing entries. */
export function setCaps(caps: BudgetCaps): BudgetCaps {
  const ledger = loadLedger();
  ledger.caps = caps;
  saveLedger(ledger);
  return ledger.caps;
}

export function recordSpend(opts: RecordSpendOptions): void {
  appendBudgetSpend(BUDGET_FILE, opts);
}

export function recordSpendOnce(opts: RecordSpendOptions): boolean {
  return appendBudgetSpend(BUDGET_FILE, opts, true);
}

export function checkBudget(opts: {
  plannedMsats: number;
  btcRate: number;
  now?: Date;
}): BudgetCheckResult {
  return checkBudgetForLedger(loadLedger(), opts);
}

/**
 * Enforce the global budget caps before a planned spend.
 * - If any cap is set, resolves the BTC/USD rate, runs the check, and throws `DvmError("budget_exceeded")` on overflow.
 * - If no cap is set, attempts a best-effort rate resolution for ledger recording (tolerates failure).
 *
 * A rate-provider outage degrades to the last-known cached rate on both branches
 * a stale rate still enforces caps roughly right, where a hard failure
 * blocked every spend on the branch every default install takes. With caps set and
 * *no* rate at all, `resolveBtcUsdRate` throws `DvmError("rate_unavailable")` and the
 * spend is blocked: an unpriceable spend can't be cap-checked, and recording it as $0
 * would corrupt future cap enforcement.
 *
 * Returns the resolved BTC/USD rate to thread into the post-payment `recordSpend` call so the
 * pre-check and the debit use a single rate.
 */
export async function enforceGlobalBudget(opts: {
  plannedMsats: number;
  btcRate?: number;
}): Promise<number> {
  const ledger = loadLedger();
  const hasCaps =
    ledger.caps.dailyUsd !== undefined ||
    ledger.caps.weeklyUsd !== undefined ||
    ledger.caps.monthlyUsd !== undefined;

  if (!hasCaps) {
    if (opts.btcRate !== undefined && opts.btcRate > 0) return opts.btcRate;
    try {
      return (await resolveBtcUsdRate("payment")).rate;
    } catch {
      // Only reached when there is *no* rate at all — `resolveBtcUsdRate` already
      // served the stale cached one if there was, precisely because a drifted rate
      // beats a $0 ledger entry. With nothing to price against and no cap to
      // enforce, the spend is allowed through and lands in the ledger at $0:
      // blocking here would refuse payment to a caller who never asked to be capped.
      return 0;
    }
  }

  const rate =
    opts.btcRate && opts.btcRate > 0 ? opts.btcRate : (await resolveBtcUsdRate("payment")).rate;
  const check = checkBudget({ plannedMsats: opts.plannedMsats, btcRate: rate });
  if (!check.ok) {
    const windowName = check.window.charAt(0).toUpperCase() + check.window.slice(1);
    const suffix = check.window === "daily" ? "day" : check.window === "weekly" ? "week" : "month";
    const suggestedCap = Math.max(1, Math.ceil(check.limitUsd * 2));
    throw new DvmError(
      "budget_exceeded",
      `${windowName} budget would be exceeded by this payment.`,
      `${windowName} budget exhausted. The window resets at ${new Date(check.resetsAt).toISOString()}. Ask the user if they'd like to raise the cap (e.g. 'dvm budget set --${check.window} "$${suggestedCap}"' — substitute any USD amount).`,
      {
        window: check.window,
        spent: {
          display: `$${formatUsd(check.spentUsd)}`,
          // the cap counts both what the agent paid DVMs and what it
          // moved out of the Lightning float, so name the split rather than
          // leaving the user to wonder why the number is higher than their jobs.
          jobs: `$${formatUsd(check.breakdown.jobsUsd)}`,
          float_fundings: `$${formatUsd(check.breakdown.floatFundingsUsd)}`,
          credit_fundings: `$${formatUsd(check.breakdown.creditFundingsUsd)}`,
        },
        limit: { display: `$${formatUsd(check.limitUsd)}/${suffix}` },
        resets_at: new Date(check.resetsAt).toISOString(),
      }
    );
  }
  return rate;
}

export function statusSnapshot(now: Date = new Date()): {
  caps: BudgetCaps;
  windows: {
    window: BudgetWindow;
    spentUsd: number;
    limitUsd?: number;
    resetsAt: number;
    breakdown: BudgetSpendBreakdown;
  }[];
} {
  const ledger = loadLedger();
  const windows: BudgetWindow[] = ["daily", "weekly", "monthly"];
  return {
    caps: ledger.caps,
    windows: windows.map((window) => {
      const breakdown = breakdownSince(ledger.entries, windowStart(window, now).getTime());
      return {
        window,
        spentUsd: breakdown.totalUsd,
        limitUsd: capFor(ledger.caps, window),
        resetsAt: windowEnd(window, now).getTime(),
        breakdown,
      };
    }),
  };
}
