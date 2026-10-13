import { shellQuoteArg } from "@dvmkit/sdk/internal";

import type { RequestOptions } from "./request";

/**
 * Structured "what to do next" for a payment-required stop where the agent
 * should re-invoke `dvm request` with safety adjustments. The
 * `command` is shell-ready and preserves the original opts so the agent can
 * confirm cost with its user, then re-run cleanly without rebuilding flags
 * from prose.
 */
export interface ResubmitNextAction {
  type: "resubmit";
  command: string;
  requires_user_approval: true;
  hint: string;
}

/**
 * Structured "what to do next" for a no-wallet stop on `dvm request` — the
 * caller has quotes but nothing to pay them with, so the action is to set up
 * a wallet rather than re-issue the request as-is.
 */
export interface SetupWalletNextAction {
  type: "setup_wallet";
  command: string;
  requires_user_approval: true;
  hint: string;
}

/**
 * Structured "what to do next" when the agent wallet is connected and funded
 * but holds no spendable balance at any mint the DVM currently accepts. Unlike
 * {@link SetupWalletNextAction} the wallet exists — the action is to fund an
 * *accepted* mint, so `command` pins one via `--mint`. A common trigger is a
 * mint the caller already holds being down and health-filtered out of the DVM's
 * `/v1/info`, leaving the caller's float stranded at a mint the DVM no longer
 * advertises.
 */
export interface FundWalletNextAction {
  type: "fund_wallet";
  command: string;
  requires_user_approval: true;
  hint: string;
}

export interface ResubmitAdjustments {
  forceAutoPay?: boolean;
  minMaxPayments?: number;
  minAutoPayBelowMsats?: number;
  minBudgetMsats?: number;
}

/**
 * Build a shell-ready `dvm request …` command from the original opts with
 * the given safety adjustments applied. Flag order matches the option spec
 * in `src/cli/dvm.ts` so the emitted command reads naturally to a human.
 */
export function buildResubmitCommand(
  opts: RequestOptions,
  adjustments: ResubmitAdjustments = {}
): string {
  const parts: string[] = ["dvm", "request"];

  if (opts.dvm) {
    parts.push("-d", shellQuoteArg(opts.dvm));
  } else if (opts.endpoint) {
    parts.push("--endpoint", shellQuoteArg(opts.endpoint));
  }

  if (opts.input !== undefined) {
    parts.push("-i", shellQuoteArg(opts.input));
  }

  if (opts.param) {
    for (const p of opts.param) {
      parts.push("--param", shellQuoteArg(p));
    }
  }

  if (opts.data !== undefined) {
    parts.push("--data", shellQuoteArg(opts.data));
  }

  const budget = resolveBudget(opts.budget, adjustments.minBudgetMsats);
  if (budget !== undefined) {
    parts.push("--budget", shellQuoteArg(budget));
  }

  const autoPayBelow = resolveAutoPayBelow(opts.autoPayBelow, adjustments.minAutoPayBelowMsats);
  if (autoPayBelow !== undefined) {
    parts.push("--auto-pay-below", shellQuoteArg(autoPayBelow));
  }

  if (opts.maxIncrement !== undefined) {
    parts.push("--max-increment", shellQuoteArg(opts.maxIncrement));
  }

  const maxPayments = resolveMaxPayments(opts.maxPayments, adjustments.minMaxPayments);
  if (maxPayments !== undefined) {
    parts.push("--max-payments", shellQuoteArg(maxPayments));
  }

  if (opts.outputType !== undefined) {
    parts.push("--output-type", shellQuoteArg(opts.outputType));
  }

  if (opts.stream === false) {
    parts.push("--no-stream");
  }

  if (opts.autoPay || adjustments.forceAutoPay) {
    parts.push("--auto-pay");
  }

  if (opts.rail !== undefined) {
    parts.push("--rail", shellQuoteArg(opts.rail));
  }

  if (opts.mint !== undefined) {
    parts.push("--mint", shellQuoteArg(opts.mint));
  }

  if (opts.maxCashuFeeSats !== undefined) {
    parts.push("--max-cashu-fee-sats", shellQuoteArg(opts.maxCashuFeeSats));
  }

  if (opts.cashuBindingFingerprint !== undefined) {
    parts.push("--cashu-binding-fingerprint", shellQuoteArg(opts.cashuBindingFingerprint));
  }

  if (opts.strictPerCall) {
    parts.push("--strict-per-call");
  }

  if (opts.as !== undefined) {
    parts.push("--as", shellQuoteArg(opts.as));
  }

  if (opts.requestId !== undefined) {
    parts.push("--request-id", shellQuoteArg(opts.requestId));
  }

  if (opts.human) {
    parts.push("--human");
  }

  if (opts.timeout !== undefined) {
    parts.push("--timeout", shellQuoteArg(opts.timeout));
  }

  return parts.join(" ");
}

export function buildResubmitAction(
  opts: RequestOptions,
  adjustments: ResubmitAdjustments,
  hint: string
): ResubmitNextAction {
  return {
    type: "resubmit",
    command: buildResubmitCommand(opts, adjustments),
    requires_user_approval: true,
    hint,
  };
}

function resolveMaxPayments(
  current: string | undefined,
  minimum: number | undefined
): string | undefined {
  if (minimum === undefined) return current;
  const parsed = current === undefined ? Number.NaN : Number.parseInt(current, 10);
  if (Number.isFinite(parsed) && parsed >= minimum) return current;
  return String(minimum);
}

function resolveAutoPayBelow(
  current: string | undefined,
  minimumMsats: number | undefined
): string | undefined {
  if (minimumMsats === undefined) return current;
  return String(minimumMsats);
}

// `--budget` accepts millisats or `$USD`; a caller's `$0.05` is replaced
// outright by the msats bump rather than compared against it.
function resolveBudget(
  current: string | undefined,
  minimumMsats: number | undefined
): string | undefined {
  if (minimumMsats === undefined) return current;
  return String(minimumMsats);
}
