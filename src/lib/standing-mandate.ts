import { storedMandateSummary } from "./mandate-payments";
import { formatFiat, type SignedRequestDomain } from "@dvmkit/sdk";
import { DvmError, signDvmRequestData, unsignRequestData,
  parseCreditTerms, type JobEnvelope, type ProviderInfo, type Quote } from "@dvmkit/sdk/internal";
import { balanceCurrencyRate } from "./credit-currency";
import { decimalRatio, parseBudget } from "./currency";
import { formatDurationMs } from "./duration";
import { info } from "./output";
import { loadJob } from "./job-store";
import { providerJobJson } from "./provider-output";

interface MandateLimits {
  max_total_micro: number;
  max_ask_micro: number;
  expires_at_ms: number;
}

type MandateCaps = Pick<MandateLimits, "max_total_micro" | "max_ask_micro">;

interface MandateCreditBinding {
  endpoint: string;
  callerPubkey: string;
  creditId: string;
  currency: string;
}

export interface MandateApproval extends MandateLimits {
  credit: MandateCreditBinding;
}

export interface SignedStandingMandate extends MandateLimits {
  approvedCaps?: MandateCaps;
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
  mandatePreview?: string;
}

export interface PreparedStandingMandate {
  currency: string;
  supported: boolean;
  unavailable?: string;
  total: number;
  ask: number;
  expiry: () => number;
  approval?: MandateApproval;
  maxPayments: number;
  upfront?: number;
}

const DAY_MS = 86_400_000;
const LEGACY_MAX_DURATION_MS = 7 * DAY_MS;
const CLOCK_SKEW_MS = 300_000;
const MANDATE_DURATION = /^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
const ISO_MANDATE_END = /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))?$/i;

export function mandateExpiryMs(input = "24h", now = Date.now()): number {
  const value = input.trim();
  const duration = MANDATE_DURATION.exec(value);
  let expiry = Number.NaN;
  if (duration) {
    const units = [7 * DAY_MS, DAY_MS, 3_600_000, 60_000, 1_000];
    expiry = now + units.reduce((total, unit, index) => total + Number(duration[index + 1] ?? 0) * unit, 0);
  } else if (ISO_MANDATE_END.test(value)) {
    const [date] = value.split(/T/i);
    const midnight = new Date(date + "T00:00:00Z");
    if (Number.isFinite(midnight.getTime()) && midnight.toISOString().split("T")[0] === date)
      expiry = Date.parse(value);
  }
  if (!Number.isSafeInteger(expiry) || expiry <= now || !Number.isFinite(new Date(expiry).getTime()))
    throw new DvmError("invalid_arguments", "--mandate-until must be a positive duration or a future ISO date or timestamp.",
      "Use a duration such as 2h, 15d, or 6w, an ISO date (midnight UTC), or a timestamp with Z or a UTC offset.");
  return expiry;
}

function mandateCredit(provider: ProviderInfo) {
  return provider.credit as (Omit<NonNullable<ProviderInfo["credit"]>, "mandate_max_duration"> & {
    mandate_max_duration?: number | null;
  }) | undefined;
}

export function resolveMandateExpiry(opts: StandingMandateOptions, provider: ProviderInfo): number {
  const credit = mandateCredit(provider);
  if (credit?.standing_mandate !== true)
    throw new DvmError("mandate_duration_unsupported", PAYER_NEEDED,
      "Omit --mandate-until and check back to pay later asks.", undefined, PAYER_NEEDED);
  const now = Date.now();
  const expiry = mandateExpiryMs(opts.mandateUntil, now);
  const limit = credit.mandate_max_duration === undefined ? LEGACY_MAX_DURATION_MS : credit.mandate_max_duration;
  if (limit === null) return expiry;
  if (expiry - now > limit) {
    const bound = limit === LEGACY_MAX_DURATION_MS ? "7 days" : limit % 1000 === 0 && limit > 0
      ? formatDurationMs(limit) : `${limit} ms`;
    const display = opts.mandatePreview
      ? `The approved expiry is ${new Date(expiry).toISOString()}. The DVM currently accepts standing limits up to ${bound}.`
      : `The DVM accepts standing limits up to ${bound}.`;
    throw new DvmError("mandate_duration_unsupported", display,
      opts.mandatePreview
        ? `Choose a new expiry within ${bound} and confirm it, or check back to pay later asks.`
        : "Choose a shorter --mandate-until or check back to pay later asks.", undefined, display);
  }
  if (opts.mandatePreview) return expiry;
  // Leave room for a provider clock ahead of ours at a finite limit.
  return Math.min(expiry, now + limit - Math.min(CLOCK_SKEW_MS, Math.floor(limit / 2)));
}

export async function prepareStandingMandate(
  opts: StandingMandateOptions, provider: ProviderInfo, btcUsdRate: number, maxPayments: number, approval?: MandateApproval,
): Promise<PreparedStandingMandate | undefined> {
  if (opts.mandate === false || !opts.budget || !opts.autoPayBelow || !provider.credit) return undefined;
  const currency = provider.credit.currency;
  let expiresAtMs: number | undefined;
  const expiry = () => expiresAtMs ??= resolveMandateExpiry(opts, provider);
  if (mandateCredit(provider)?.standing_mandate !== true)
    return { currency, supported: false, total: 0, ask: 0, expiry, maxPayments };
  let currencyRate: number | undefined;
  try { currencyRate = currency === "usd" && btcUsdRate > 0 ? btcUsdRate : await balanceCurrencyRate(currency); }
  catch { /* Rate failure only withholds automatic future-payment authority. */ }
  const unavailable = (reason: string): PreparedStandingMandate => ({ currency, supported: false,
    total: 0, ask: 0, expiry, maxPayments, approval, unavailable: `The mandate was skipped because ${reason}. Later charges need a payer attached or scheduled check-ins.` });
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
  return { currency, supported: true, total, ask, expiry, maxPayments, approval };
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

function mandateLimits(prepared: PreparedStandingMandate): MandateLimits | undefined {
  const skip = (reason: string) => {
    prepared.unavailable = `The mandate was skipped because ${reason}. Later charges need a payer attached or scheduled check-ins.`;
    return undefined;
  };
  if (!prepared.supported) return undefined;
  if (prepared.maxPayments === 0) return skip("--max-payments allows no payments");
  if (prepared.upfront === undefined && (prepared.maxPayments - 1) * prepared.ask < prepared.total)
    return skip("the upfront price was unknown");
  const laterPayments = prepared.maxPayments - (prepared.upfront !== undefined && prepared.upfront > 0 ? 1 : 0);
  if (laterPayments === 0) return skip("--max-payments allows no later charges after the upfront payment");
  const cappedTotal = prepared.upfront === undefined ? prepared.total
    : Math.min(prepared.total, prepared.upfront + laterPayments * prepared.ask);
  if (cappedTotal <= 0 || (prepared.upfront !== undefined && cappedTotal < prepared.upfront))
    return skip("the budget does not cover the upfront charge");
  delete prepared.unavailable;
  return { max_total_micro: cappedTotal, max_ask_micro: Math.min(prepared.ask, cappedTotal),
    expires_at_ms: prepared.expiry() };
}

export function parseMandateApproval(input: string): MandateApproval {
  try {
    const fields: unknown = JSON.parse(Buffer.from(input, "base64url").toString("utf8"));
    if (Array.isArray(fields) && fields.length === 7) {
      const [expires_at_ms, max_total_micro, max_ask_micro, endpoint, callerPubkey, creditId, currency] = fields;
      if ([expires_at_ms, max_total_micro, max_ask_micro].every((value) => Number.isSafeInteger(value) && value > 0) &&
          Number.isFinite(new Date(expires_at_ms).getTime()) &&
          [endpoint, callerPubkey, creditId, currency].every((value) => typeof value === "string" && value.length > 0))
        return { expires_at_ms, max_total_micro, max_ask_micro, credit: { endpoint, callerPubkey, creditId, currency } };
    }
  } catch { /* The approval must decode as the terms emitted by a dry run. */ }
  throw new DvmError("invalid_arguments", "Invalid --mandate-preview value.",
    "Pass an approval from dvm request --dry-run that names the selected prepaid credit.");
}

export function approvedMandateUnavailable(reason: string, hint: string): DvmError {
  const display = `The approved standing mandate could not be attached. ${reason}`;
  return new DvmError("mandate_preview_unavailable", display, hint, undefined, display);
}

export function checkMandateCredit(approved: MandateCreditBinding, actual: MandateCreditBinding): void {
  for (const [field, label] of [
    ["endpoint", "DVM endpoint"], ["callerPubkey", "caller identity"], ["creditId", "credit"], ["currency", "credit currency"],
  ] as const) {
    if (approved[field] === actual[field]) continue;
    const display = `The approved ${label} was ${approved[field]}. The live ${label} is ${actual[field]}.`;
    throw new DvmError("mandate_preview_changed", display,
      `Use the approved ${label} (${approved[field]}) or confirm a new approval for ${actual[field]}.`, undefined, display);
  }
}

export function mandateJobData(signing: JobSigner, data: Record<string, unknown>): Record<string, unknown> {
  const { mandate: _reserved, ...body } = data;
  const prepared = signing.standingMandate;
  if (!prepared) return body;
  const approval = prepared.approval;
  const hasBinding = typeof body.credit_id === "string" && typeof body.draw_id === "string";
  const limits = hasBinding ? mandateLimits(prepared) : undefined;
  if (!approval) {
    if (limits) body.mandate = limits;
    return body;
  }
  if (!limits || body.credit_id !== approval.credit.creditId)
    throw approvedMandateUnavailable(prepared.unavailable ?? "The approved credit could not carry a mandate.",
      "Check the credit balance and the live upfront quote before trying again.");
  const maxTotal = Math.min(limits.max_total_micro, approval.max_total_micro);
  if (prepared.upfront !== undefined && maxTotal < prepared.upfront)
    throw approvedMandateUnavailable(
      `The upfront price is ${formatMandateAmount(prepared.upfront, prepared.currency)}, above the approved total of ${formatMandateAmount(maxTotal, prepared.currency)}.`,
      "Confirm a new limit that covers the upfront price, or decline the request.");
  body.mandate = { max_total_micro: maxTotal, max_ask_micro: Math.min(limits.max_ask_micro, approval.max_ask_micro, maxTotal),
    expires_at_ms: approval.expires_at_ms } satisfies MandateLimits;
  return body;
}

export function previewStandingMandate(prepared: PreparedStandingMandate | undefined, price: unknown, credit: MandateCreditBinding) {
  if (!prepared) throw new DvmError("invalid_arguments", "A mandate preview requires --budget and --auto-pay-below with mandates enabled.");
  if (!prepared.supported && !prepared.unavailable) throw new DvmError("mandate_duration_unsupported", PAYER_NEEDED,
    "Check back to pay later asks.", undefined, PAYER_NEEDED);
  // Info advertises the upfront ceiling. A lower live amount can narrow the signed terms.
  if (price && typeof price === "object" && "currency" in price && price.currency === prepared.currency &&
      "amount" in price && typeof price.amount === "number") {
    const ratio = decimalRatio(String(price.amount));
    if (ratio) {
      const [numerator, denominator] = ratio;
      const micro = numerator * 1_000_000n;
      if (micro % denominator === 0n && Number.isSafeInteger(Number(micro / denominator)))
        prepared.upfront = Number(micro / denominator);
    }
  }
  const limits = mandateLimits(prepared);
  if (!limits) throw new DvmError("mandate_preview_unavailable", prepared.unavailable ?? "Could not resolve standing mandate terms.",
    "Review the budget and payment limits, or check back to pay later asks.");
  const approval = Buffer.from(JSON.stringify([limits.expires_at_ms, limits.max_total_micro, limits.max_ask_micro,
    credit.endpoint, credit.callerPubkey, credit.creditId, credit.currency])).toString("base64url");
  return { ...mandateOutput(limits, prepared.currency), status: "preview", credit_id: credit.creditId, approval };
}

export function signJobData(signing: JobSigner, data: Record<string, unknown>, human?: boolean): Record<string, unknown> {
  const body = mandateJobData(signing, data);
  if (human && body.mandate && signing.standingMandate)
    info(mandateChargeDisplay(body.mandate as MandateLimits, signing.standingMandate.currency, signing.standingMandate.approval));
  return signDvmRequestData(signing.privkey, body, signing.domain);
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
    ...(prepared.approval ? { approvedCaps: {
      max_total_micro: prepared.approval.max_total_micro, max_ask_micro: prepared.approval.max_ask_micro,
    } } : {}),
    currency: prepared.currency, signed_data: envelope.data as Record<string, unknown> };
  return { mandate };
}

function formatMandateAmount(micro: number, currency: string): string {
  const amount = micro / 1_000_000;
  const formatted = formatFiat(amount, currency);
  // Keep the usual currency label while preserving any sub-cent authority.
  if (micro % (currency === "jpy" ? 1_000_000 : 10_000) === 0) return formatted;
  const whole = Math.floor(micro / 1_000_000);
  const fraction = String(micro % 1_000_000).padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return formatted.replace(/\d+(?:\.\d+)?/, `${whole}.${fraction}`);
}

function mandateChargeDisplay(mandate: MandateLimits, currency: string, approved?: MandateCaps): string {
  const total = formatMandateAmount(mandate.max_total_micro, currency);
  const ask = formatMandateAmount(mandate.max_ask_micro, currency);
  const until = new Date(mandate.expires_at_ms).toISOString();
  const summary = `The DVM can charge at most ${total} until ${until} for the whole job including the upfront payment. Later charges are paid automatically while the credit lasts, up to ${ask} per charge.`;
  const reduced = [
    ["max_total_micro", "total"],
    ["max_ask_micro", "per charge"],
  ] as const;
  const adjustments = approved ? reduced.flatMap(([key, label]) => mandate[key] < approved[key]
    ? [`Approved up to ${formatMandateAmount(approved[key], currency)} ${label}. Signed ${formatMandateAmount(mandate[key], currency)} under the live limits.`]
    : []) : [];
  return [summary, ...adjustments].join(" ");
}

function mandateOutput(m: MandateLimits, currency: string, approved?: MandateCaps) {
  return { currency, max_total_micro: m.max_total_micro, max_ask_micro: m.max_ask_micro,
    expires_at_ms: m.expires_at_ms, expires_at: new Date(m.expires_at_ms).toISOString(),
    max_total: { amount_micro: m.max_total_micro, currency, display: formatMandateAmount(m.max_total_micro, currency) },
    max_ask: { amount_micro: m.max_ask_micro, currency, display: formatMandateAmount(m.max_ask_micro, currency) },
    ...(approved ? { approved_max_total_micro: approved.max_total_micro, approved_max_ask_micro: approved.max_ask_micro } : {}),
    display: mandateChargeDisplay(m, currency, approved) };
}

export function standingMandateOutput(job: { mandate?: SignedStandingMandate; mandateUnavailable?: string } | null) {
  if (job?.mandate) return { mandate: { status: "active", ...mandateOutput(job.mandate, job.mandate.currency, job.mandate.approvedCaps) } };
  return job?.mandateUnavailable ? { mandate: { status: job.mandateUnavailable === PAYER_NEEDED ? "unsupported" : "skipped", display: job.mandateUnavailable } } : {};
}

export function creditTermsWithStandingMandate(raw: unknown) {
  const terms = parseCreditTerms(raw);
  if (!terms || !raw || typeof raw !== "object") return terms;
  const duration = "mandate_max_duration" in raw ? raw.mandate_max_duration : undefined;
  return { ...terms,
    ...("standing_mandate" in raw && raw.standing_mandate === true ? { standing_mandate: true as const } : {}),
    ...(duration === null || (typeof duration === "number" && Number.isFinite(duration) && duration >= 0)
      ? { mandate_max_duration: duration } : {}),
  };
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
