import { getLastKnownBtcRate, usdToMsats, type Quote } from "@dvmkit/sdk/internal";
import { buildPolicy } from "./policy";

export interface AutoPayWarning {
  code: "auto_pay_bound_exceeded";
  bound: string;
  maximum: string;
  auto_pay_below: string;
  source: "quote" | "provider_ceiling";
  display: string;
}

interface Limits {
  budget?: string;
  autoPayBelow?: string;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function autoPayWarnings(
  quotes: Quote[],
  limits: Limits,
  ceiling?: unknown,
  btcRate = getLastKnownBtcRate()?.rate ?? 0
): AutoPayWarning[] {
  if (!limits.budget && !limits.autoPayBelow) return [];
  if (!positive(btcRate)) {
    const quoted = quotes.find((quote) => quote.upfront?.currency === "usd" &&
      positive(quote.upfront.amount) && positive(quote.priceMsats));
    btcRate = getLastKnownBtcRate()?.rate ?? (quoted
      ? quoted.upfront.amount * 100_000_000_000 / quoted.priceMsats : 0);
  }
  const amounts: number[] = [];
  for (const quote of quotes) {
    if (quote.upfront?.currency === "usd" && positive(quote.upfront.amount)) amounts.push(quote.upfront.amount);
    const rate = quote.rate;
    if (rate?.per_unit.currency === "usd" && positive(rate.per_unit.amount) && positive(rate.max_units)) {
      const maximum = Number((rate.per_unit.amount * rate.max_units).toPrecision(15));
      if (positive(maximum)) amounts.push(maximum);
    }
  }
  let source: AutoPayWarning["source"] = "quote";
  if (!amounts.length && ceiling && typeof ceiling === "object") {
    const max = ceiling as { amount?: unknown; currency?: unknown };
    if (max.currency === "usd" && positive(max.amount)) {
      amounts.push(max.amount);
      source = "provider_ceiling";
    }
  }
  if (!amounts.length) return [];
  const maximumUsd = Math.max(...amounts);
  let bound: string;
  let maximum: string;
  let flag: string;
  if (positive(btcRate)) {
    const policy = buildPolicy({ ...limits, maxPayments: 0 }, btcRate);
    const maximumMsats = usdToMsats(maximumUsd, btcRate);
    if (!Number.isSafeInteger(maximumMsats) || maximumMsats <= policy.autoPayBelowMsats) return [];
    bound = `${policy.autoPayBelowMsats} msats`;
    maximum = `$${maximumUsd} USD (${maximumMsats} msats)`;
    flag = String(maximumMsats);
  } else {
    // Dollar previews need no FX lookup or cache write. Mixed units cannot be
    // compared safely without a rate, so leave those previews unqualified.
    const declared = limits.autoPayBelow ?? limits.budget;
    if (!declared || !/^\$\d+(?:\.\d+)?$/.test(declared)) return [];
    const boundUsd = Number(declared.slice(1)) * (limits.autoPayBelow ? 1 : 0.2);
    if (!Number.isFinite(boundUsd) || maximumUsd <= boundUsd) return [];
    bound = `$${Number(boundUsd.toPrecision(15))} USD`;
    maximum = `$${maximumUsd} USD`;
    flag = `'$${maximumUsd}'`;
  }
  const subject = source === "provider_ceiling" ? "this provider's advertised job ceiling" : "the quote's largest possible charge";
  return [{
    code: "auto_pay_bound_exceeded", bound, maximum, auto_pay_below: flag, source,
    display: `Auto-pay bound: ${bound}; ${subject}: ${maximum}. For the next request, use --auto-pay-below ${flag} within your approved budget. The total budget, increment and payment-count limits still apply.`,
  }];
}
