import {
  type BudgetCaps,
  type BudgetWindow,
  DvmError,
  formatUsd,
} from "@dvmkit/sdk/internal";
import {
  info,
  json,
} from "../lib/output";
import { loadLedger, saveLedger, statusSnapshot } from "../lib/budget-ledger";

export interface BudgetSetOptions {
  /** Daily cap (e.g. "$5", "5.00", or "off" to clear). Missing flag preserves the existing value. */
  daily?: string;
  weekly?: string;
  monthly?: string;
  /** Clear ALL caps. Mutually exclusive with --daily/--weekly/--monthly. */
  clear?: boolean;
  human?: boolean;
}

export interface BudgetStatusOptions {
  human?: boolean;
}

/**
 * Configure or update fiat-denominated spending caps in the global ledger.
 * Caps not passed on the command line are preserved. Pass "off" to remove a single cap,
 * or `--clear` to remove all caps.
 */
export function budgetSet(opts: BudgetSetOptions): void {
  if (opts.clear && (opts.daily || opts.weekly || opts.monthly)) {
    throw new DvmError(
      "invalid_args",
      "--clear cannot be combined with --daily/--weekly/--monthly.",
      "Run 'dvm budget set --clear' on its own to remove all caps, or pass cap values without --clear. To clear a single window, pass 'off' (e.g. 'dvm budget set --daily off')."
    );
  }

  const ledger = loadLedger();
  const next: BudgetCaps = opts.clear ? {} : { ...ledger.caps };

  if (!opts.clear) {
    if (opts.daily !== undefined) applyCap(next, "daily", opts.daily);
    if (opts.weekly !== undefined) applyCap(next, "weekly", opts.weekly);
    if (opts.monthly !== undefined) applyCap(next, "monthly", opts.monthly);
  }

  ledger.caps = next;
  saveLedger(ledger);

  emitStatus(opts.human ?? false);
}

export function budgetStatus(opts: BudgetStatusOptions): void {
  emitStatus(opts.human ?? false);
}


function applyCap(caps: BudgetCaps, window: BudgetWindow, raw: string): void {
  const trimmed = raw.trim();
  if (trimmed === "off" || trimmed === "none") {
    if (window === "daily") delete caps.dailyUsd;
    if (window === "weekly") delete caps.weeklyUsd;
    if (window === "monthly") delete caps.monthlyUsd;
    return;
  }
  const num = parseUsd(trimmed);
  if (num === null) {
    throw new DvmError(
      "invalid_cap",
      `Invalid value for --${window}: ${raw}`,
      "Pass a USD amount like '$5' or '5.00'. Use 'off' to remove the cap."
    );
  }
  if (num <= 0) {
    throw new DvmError(
      "invalid_cap",
      `--${window} must be positive (received ${raw}).`,
      "Use 'off' to remove a cap; positive values define the spending ceiling."
    );
  }
  if (window === "daily") caps.dailyUsd = num;
  if (window === "weekly") caps.weeklyUsd = num;
  if (window === "monthly") caps.monthlyUsd = num;
}

function parseUsd(raw: string): number | null {
  const stripped = raw.startsWith("$") ? raw.slice(1) : raw;
  const num = parseFloat(stripped);
  if (isNaN(num) || !isFinite(num)) return null;
  return num;
}

function emitStatus(human: boolean): void {
  const snapshot = statusSnapshot();
  // a cap now covers Lightning float top-ups as well as job payments,
  // so a user whose spend looks higher than their jobs has an explanation
  // instead of a mystery. Only shown once a float funding actually exists.
  // same for prepaid-credit fundings.
  const anyFloatSpend = snapshot.windows.some((w) => w.breakdown.floatFundingsUsd > 0);
  const anyCreditSpend = snapshot.windows.some((w) => w.breakdown.creditFundingsUsd > 0);
  const showSplit = anyFloatSpend || anyCreditSpend;

  if (human) {
    info("Budget status:");
    for (const w of snapshot.windows) {
      const spent = `$${formatUsd(w.spentUsd)}`;
      const cap = w.limitUsd !== undefined ? `$${formatUsd(w.limitUsd)}` : "no cap";
      const resets = new Date(w.resetsAt).toISOString();
      info(`  ${w.window.padEnd(7)} ${spent} / ${cap}    resets at ${resets}`);
      if (showSplit) {
        info(
          `          jobs $${formatUsd(w.breakdown.jobsUsd)} · wallet top-ups $${formatUsd(w.breakdown.floatFundingsUsd)} · credit fundings $${formatUsd(w.breakdown.creditFundingsUsd)}`
        );
      }
    }
    if (showSplit) {
      info("");
      info(`  ${FLOAT_COUNTED_NOTE}`);
    }
    return;
  }
  json({
    caps: snapshot.caps,
    windows: snapshot.windows.map((w) => {
      const spent = `$${formatUsd(w.spentUsd)}`;
      const cap = w.limitUsd !== undefined ? `$${formatUsd(w.limitUsd)}` : "no cap";
      return {
        window: w.window,
        spentUsd: round2(w.spentUsd),
        limitUsd: w.limitUsd !== undefined ? round2(w.limitUsd) : null,
        resetsAt: new Date(w.resetsAt).toISOString(),
        spent_breakdown: {
          jobs_usd: round2(w.breakdown.jobsUsd),
          float_fundings_usd: round2(w.breakdown.floatFundingsUsd),
          credit_fundings_usd: round2(w.breakdown.creditFundingsUsd),
        },
        display: `${w.window}: ${spent} / ${cap}`,
      };
    }),
    ...(showSplit ? { note: FLOAT_COUNTED_NOTE } : {}),
  });
}

/** Why the cap total can exceed what was paid to DVMs. */
const FLOAT_COUNTED_NOTE =
  "Topping the agent up from your Lightning wallet counts against these caps too, not just payments to DVMs — the cap limits how much money the agent moves.";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
