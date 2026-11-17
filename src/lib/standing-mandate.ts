import { storedMandateSummary } from "./mandate-payments";
import { formatFiat, type SignedRequestDomain } from "@dvmkit/sdk";
import { DvmError, signDvmRequestData, unsignRequestData,
  parseCreditTerms, type JobEnvelope, type ProviderInfo, type Quote } from "@dvmkit/sdk/internal";
import { balanceCurrencyRate } from "./credit-currency";
import { parseBudget } from "./currency";
import { parseDurationMs } from "./duration";
import { info } from "./output";
import { loadJob } from "./job-store";
import { providerJobJson } from "./provider-output";

interface MandateLimits {
  max_total_micro: number;
  max_ask_micro: number;
  expires_at_ms: number;
}

export interface SignedStandingMandate extends MandateLimits {
  credit_id: string;
  draw_id: string;
  currency: string;
  /** Original signed data, including the signature that authorizes these limits. */
  signed_data: Record<string, unknown>;
}

export interface StandingMandateOptions {
  budget?: string;
  autoPayBelow?: string;
  maxIncrement?: string;
  mandate?: boolean;
  mandateUntil?: string;
}

export interface PreparedStandingMandate {
  currency: string;
  supported: boolean;
  unavailable?: string;
  total: number;
  ask: number;
  durationMs: number;
  maxPayments: number;
  upfront?: number;
  expiresAtMs?: number;
}

export function mandateDurationMs(input?: string): number {
  const duration = parseDurationMs(input ?? "24h");
  if (duration <= 0 || duration > 7 * 86_400_000)
    throw new DvmError("invalid_arguments", "--mandate-until must be greater than zero and at most 7 days.",
      "Use a duration such as 2h, 1d, or 7d.");
  return duration;
}

export async function prepareStandingMandate(
  opts: StandingMandateOptions, provider: ProviderInfo, btcUsdRate: number, maxPayments: number,
): Promise<PreparedStandingMandate | undefined> {
  if (opts.mandate === false || !opts.budget || !opts.autoPayBelow || !provider.credit) return undefined;
  const currency = provider.credit.currency;
  const durationMs = mandateDurationMs(opts.mandateUntil);
  if ((provider.credit as { standing_mandate?: true }).standing_mandate !== true)
    return { currency, supported: false, total: 0, ask: 0, durationMs, maxPayments };
  let currencyRate: number | undefined;
  try { currencyRate = currency === "usd" && btcUsdRate > 0 ? btcUsdRate : await balanceCurrencyRate(currency); }
  catch { /* Rate failure only withholds automatic future-payment authority. */ }
  const unavailable = (reason: string): PreparedStandingMandate => ({ currency, supported: false,
    total: 0, ask: 0, durationMs, maxPayments, unavailable: `The mandate was skipped because ${reason}. Later charges need a payer attached or scheduled check-ins.` });
  const convert = (amount: string): number | undefined => {
    if (amount.startsWith("$")) {
      const dollars = decimalRatio(amount.slice(1));
      if (!dollars) return undefined;
      if (currency === "usd") return Number(dollars[0] * 1_000_000n / dollars[1]);
      const native = currencyRate && decimalRatio(String(currencyRate));
      const usd = btcUsdRate > 0 && decimalRatio(String(btcUsdRate));
      return native && usd ? Number(dollars[0] * 1_000_000n * native[0] * usd[1] /
        (dollars[1] * native[1] * usd[0])) : undefined;
    }
    const msats = parseBudget(amount, btcUsdRate);
    const rate = currencyRate && decimalRatio(String(currencyRate));
    return rate && Number.isSafeInteger(msats) && msats >= 0
      ? Number(BigInt(msats) * rate[0] / (100_000n * rate[1])) : undefined;
  };
  const total = convert(opts.budget);
  const threshold = convert(opts.autoPayBelow);
  const increment = opts.maxIncrement ? convert(opts.maxIncrement) : total;
  if (total === undefined || threshold === undefined || increment === undefined)
    return unavailable(`the limits could not be converted into ${currency.toUpperCase()} using a local exchange rate`);
  const ask = Math.min(threshold, increment, total);
  if (![total, ask].every((value) => Number.isSafeInteger(value) && value > 0))
    return unavailable("the limits do not allow a positive charge in the credit's currency");
  return { currency, supported: true, total, ask, durationMs, maxPayments };
}

// Integer ratios avoid granting an extra micro-unit through binary or intermediate FX rounding.
function decimalRatio(text: string): [bigint, bigint] | undefined {
  const match = /^(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match || !(match[1] || match[2])) return undefined;
  const exponent = Number(match[3] ?? 0) - (match[2]?.length ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return undefined;
  const digits = BigInt((match[1] || "0") + (match[2] ?? ""));
  return exponent >= 0 ? [digits * 10n ** BigInt(exponent), 1n] : [digits, 10n ** BigInt(-exponent)];
}

export function setMandateUpfront(mandate: PreparedStandingMandate | undefined, quote: Quote | undefined): void {
  if (mandate) mandate.upfront = quote?.upfront?.currency === mandate.currency &&
    Number.isSafeInteger(quote.upfront.amount_micro) && quote.upfront.amount_micro! >= 0
    ? quote.upfront.amount_micro : undefined;
}

interface JobSigner {
  privkey: string;
  domain: SignedRequestDomain;
  standingMandate?: PreparedStandingMandate;
}

export function mandateJobData(signing: JobSigner, data: Record<string, unknown>): Record<string, unknown> {
  const { mandate: _reserved, ...body } = data;
  const prepared = signing.standingMandate;
  if (prepared?.supported && typeof body.credit_id === "string" && typeof body.draw_id === "string") {
    const skip = (reason: string) => {
      prepared.unavailable = `The mandate was skipped because ${reason}. Later charges need a payer attached or scheduled check-ins.`;
      return body;
    };
    if (prepared.maxPayments === 0) return skip("--max-payments allows no payments");
    if (prepared.upfront === undefined && (prepared.maxPayments - 1) * prepared.ask < prepared.total)
      return skip("the upfront price was unknown");
    const laterPayments = Math.max(0, prepared.maxPayments - (prepared.upfront !== undefined && prepared.upfront > 0 ? 1 : 0));
    if (laterPayments === 0) return skip("--max-payments allows no later charges after the upfront payment");
    const cappedTotal = prepared.upfront === undefined ? prepared.total
      : Math.min(prepared.total, prepared.upfront + laterPayments * prepared.ask);
    if (cappedTotal <= 0 || (prepared.upfront !== undefined && cappedTotal < prepared.upfront))
      return skip("the budget does not cover the upfront charge");
    // Leave room for the signed-request clock skew the provider accepts at the seven-day boundary.
    prepared.expiresAtMs ??= Date.now() + Math.min(prepared.durationMs, 7 * 86_400_000 - 300_000);
    delete prepared.unavailable;
    body.mandate = { max_total_micro: cappedTotal, max_ask_micro: Math.min(prepared.ask, cappedTotal),
      expires_at_ms: prepared.expiresAtMs } satisfies MandateLimits;
  }
  return body;
}

export function signJobData(signing: JobSigner, data: Record<string, unknown>): Record<string, unknown> {
  return signDvmRequestData(signing.privkey, mandateJobData(signing, data), signing.domain);
}

const PAYER_NEEDED = "Later charges need a payer attached or scheduled check-ins because this provider does not advertise automatic credit payments.";

export function standingMandateRecord(
  envelope: JobEnvelope, prepared: PreparedStandingMandate | undefined, human?: boolean,
): { mandate?: SignedStandingMandate; mandateUnavailable?: string } {
  const body = unsignRequestData(envelope.data)?.body;
  if (!prepared || typeof body?.credit_id !== "string" || typeof body.draw_id !== "string") return {};
  if (!prepared.supported || prepared.unavailable) {
    const display = prepared.unavailable ?? PAYER_NEEDED;
    if (human) info(display);
    return { mandateUnavailable: display };
  }
  if (!body.mandate) return {};
  const mandate = { ...(body.mandate as MandateLimits), credit_id: body.credit_id, draw_id: body.draw_id,
    currency: prepared.currency, signed_data: envelope.data as Record<string, unknown> };
  if (human) info(standingMandateOutput({ mandate }).mandate!.display);
  return { mandate };
}

export function standingMandateOutput(job: { mandate?: SignedStandingMandate; mandateUnavailable?: string } | null) {
  if (job?.mandate) {
    const m = job.mandate;
    const total = formatFiat(m.max_total_micro / 1_000_000, m.currency);
    const ask = formatFiat(m.max_ask_micro / 1_000_000, m.currency);
    const until = new Date(m.expires_at_ms).toISOString();
    const humanUntil = new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" })
      .format(new Date(m.expires_at_ms)) + " UTC";
    return { mandate: { status: "active", currency: m.currency, max_total_micro: m.max_total_micro,
      max_ask_micro: m.max_ask_micro, expires_at_ms: m.expires_at_ms, expires_at: until,
      max_total: { amount_micro: m.max_total_micro, currency: m.currency, display: total },
      max_ask: { amount_micro: m.max_ask_micro, currency: m.currency, display: ask },
      display: `Later charges are paid automatically from your prepaid credit while the credit lasts, up to ${total} for the whole job including the upfront payment, and ${ask} per later charge, until ${humanUntil}.` } };
  }
  return job?.mandateUnavailable ? { mandate: { status: job.mandateUnavailable === PAYER_NEEDED ? "unsupported" : "skipped", display: job.mandateUnavailable } } : {};
}

export function creditTermsWithStandingMandate(raw: unknown) {
  const terms = parseCreditTerms(raw);
  return terms ? { ...terms, ...(raw && typeof raw === "object" &&
    "standing_mandate" in raw && raw.standing_mandate === true ? { standing_mandate: true as const } : {}) } : undefined;
}

export function mandateRequestJson(data: Record<string, unknown>): void {
  providerJobJson({ ...data, ...(typeof data.jobId === "string" ? { ...standingMandateOutput(loadJob(data.jobId)), ...storedMandateSummary(data.jobId) } : {}) });
}

export function invalidMandateError(reason?: string): DvmError {
  return new DvmError("invalid_mandate", reason
    ? `The provider refused the automatic credit payment limits: ${reason}`
    : "The provider could not accept the automatic credit payment limits.",
    reason && /expir|expires_at/i.test(reason)
      ? "Check your clock for skew and try a shorter --mandate-until."
      : "Check the provider's credit terms and the automatic-payment limits.",
    undefined, undefined, reason ? { message: "provider" } : undefined);
}
