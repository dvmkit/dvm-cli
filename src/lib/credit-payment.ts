import { randomUUID } from "node:crypto";
import { createFxFetcher, fxRateFor, type FxFetcher, type PaymentContent } from "@dvmkit/sdk";
import {
  DvmError,
  loadCredit,
  loadImplicitCredits,
  recordRefusedDrawBalance,
  signDvmRequestData,
  signedRequestDomain,
  msatsToMicro,
  usdToMsats,
  withinAdvertisedTolerance,
  type JobPolicy,
  type PaymentRequestContent,
  type ProviderRef,
  type Transport,
} from "@dvmkit/sdk/internal";
import { dvmFetch } from "./http";
import { tryResolveBtcUsdRate } from "./btc-rate";
import { findSigningIdentityByPubkey } from "./cli-identity-resolve";
import { effectiveCreditPosture } from "./credit-policy";
import { providerDvmIdentity } from "./credit-per-dvm";
import { loadConfig } from "./identity";
import {
  bookCreditPayment,
  loadJob,
  mutateCreditPayment,
  type CreditPaymentIntent,
} from "./job-store";

type Authorization = NonNullable<PaymentContent["credit"]>;

const currencyFetchers = new Map<string, FxFetcher>();
const MAX_CURRENCY_FETCHERS = 8;

async function balanceCurrencyRate(currency: string): Promise<number | undefined> {
  if (currency === "usd") return (await tryResolveBtcUsdRate())?.rate;
  let fetcher = currencyFetchers.get(currency);
  if (!fetcher) {
    const source = new URL("https://api.coingecko.com/api/v3/simple/price");
    source.searchParams.set("ids", "bitcoin");
    source.searchParams.set("vs_currencies", `usd,${currency}`);
    fetcher = createFxFetcher({
      source: source.href,
      currencies: ["usd", currency],
      fetchFn: (input, init) => dvmFetch(input, { ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)])
          : AbortSignal.timeout(5000),
      }),
    });
    if (currencyFetchers.size >= MAX_CURRENCY_FETCHERS)
      currencyFetchers.delete(currencyFetchers.keys().next().value!);
    currencyFetchers.set(currency, fetcher);
  }
  try {
    const snapshot = await fetcher.fetch();
    // A partial refresh must not quietly price this spend with an older rate.
    if (snapshot.carried_forward?.includes(currency) || snapshot.unavailable?.includes(currency)) return undefined;
    return fxRateFor(snapshot, currency);
  } catch { return undefined; }
}

export function bookedCreditPayment(jobId: string, requestSeq: number | undefined): CreditPaymentIntent | undefined {
  return loadJob(jobId)?.bookedCreditPayments?.find((entry) => entry.authorization.request_seq === requestSeq);
}

/** A pending intent is already consented to; recovery never chooses a replacement rail. */
export async function sendCreditPayment(
  jobId: string,
  intent: CreditPaymentIntent,
  transport: Transport,
  provider: ProviderRef,
  jobToken?: string,
): Promise<boolean> {
  // Renew only the envelope. The owner, audience and complete monetary intent
  // stay pinned even if the selected identity or provider advertisement changed.
  if (intent.authorization.timestamp < Math.floor(Date.now() / 1000) - 120) {
    const signer = findSigningIdentityByPubkey(intent.authorization.pubkey);
    if (signer) {
      const { credit_id, draw_id, payment_id, request_seq, amount_micro, currency, auth_statement } = intent.authorization;
      const renewed = signDvmRequestData(signer.privkey,
        { credit_id, draw_id, payment_id, request_seq, amount_micro, currency },
        { audience: auth_statement.audience, method: auth_statement.method, path: auth_statement.path, capability: null });
      intent = mutateCreditPayment(jobId, (job) => {
        if (job.bookedCreditPayments?.some((entry) => entry.authorization.payment_id === payment_id)) return intent;
        if (job.pendingCreditPayment?.authorization.payment_id !== payment_id)
          throw new DvmError("credit_payment_pending", "Another balance payment needs recovery first.");
        job.pendingCreditPayment = { ...intent, authorization: renewed as Authorization };
        return job.pendingCreditPayment;
      });
    }
  }
  try {
    await transport.sendMessage(jobId, { type: "payment", content: { credit: intent.authorization } }, provider, { jobToken });
  } catch (error) {
    if (error instanceof DvmError && error.code === "insufficient_credit" && error.data?.http_status === 402 &&
        Number.isSafeInteger(error.data?.remaining_micro) && Number(error.data?.remaining_micro) >= 0 &&
        Number.isSafeInteger(error.data?.shortfall_micro) && Number(error.data?.shortfall_micro) > 0) {
      recordRefusedDrawBalance({ endpoint: provider.endpoint!, callerPubkey: intent.authorization.pubkey,
        creditId: intent.authorization.credit_id, remainingMicro: error.data?.remaining_micro });
      mutateCreditPayment(jobId, (job) => {
        if (job.pendingCreditPayment?.authorization.payment_id === intent.authorization.payment_id) {
          delete job.pendingCreditPayment;
          if (intent.selectedUnbound) job.creditBinding = { unbound: true, callerPubkey: intent.authorization.pubkey };
        }
      });
      return false;
    }
    // HTTP failures, malformed bodies and network loss do not establish whether
    // the server committed. Keep the exact intent and let the original error through.
    throw error;
  }
  bookCreditPayment(jobId, intent);
  return true;
}

export async function tryCreditPayment(args: {
  jobId: string;
  request: PaymentRequestContent;
  requestSeq?: number;
  transport: Transport;
  provider: ProviderRef;
  jobToken?: string;
  policy: JobPolicy;
}): Promise<number | false> {
  const { jobId, request, requestSeq, transport, provider, jobToken } = args;
  const job = loadJob(jobId);
  const ask = request.credit;
  if (!job?.creditBinding || !ask || !Number.isSafeInteger(requestSeq) || requestSeq! < 0 ||
      !Number.isSafeInteger(ask.amount_micro) || ask.amount_micro <= 0 || !/^[a-z]{3}$/.test(ask.currency)) return false;
  const signer = findSigningIdentityByPubkey(job.creditBinding.callerPubkey);
  if (!signer) return false;
  const info = await transport.describe(provider);
  if (info.credit?.balance_payment !== true) return false;
  const identity = providerDvmIdentity(info);
  if (effectiveCreditPosture(loadConfig()?.credit, provider.endpoint!, identity).posture === "off") return false;
  const held = loadCredit(provider.endpoint!, signer.pubkey, identity);
  const released = loadImplicitCredits(provider.endpoint!, signer.pubkey, identity);
  let binding = job.creditBinding;
  if (!("unbound" in binding)) {
    const boundCreditId = binding.creditId;
    const owned = [held, ...(held?.siblingCredits ?? []), ...released].find((credit) => credit?.creditId === boundCreditId);
    if (!owned || owned.currency !== ask.currency) return false;
  }
  if ("unbound" in binding) {
    const stored = held;
    const implicit = released
      .find((credit) => credit.currency === ask.currency && credit.status === "active" &&
        credit.expiryMs > Date.now() && credit.remainingMicro >= ask.amount_micro);
    const eligible = stored && stored.currency === ask.currency && stored.status === "active" &&
      !stored.reconciliationPending && !stored.selectionCleared &&
      (stored.expiryMs === 0 || stored.expiryMs > Date.now()) && stored.remainingMicro >= ask.amount_micro;
    const creditId = implicit?.creditId ?? (eligible ? stored.creditId : undefined);
    if (!creditId) return false;
    binding = { creditId, drawId: randomUUID(), callerPubkey: signer.pubkey };
  }
  // The provider's msat proxy cannot authorize an unrelated native debit.
  // Use caller-selected currency units per BTC for both values; provider
  // metadata and server FX configuration cannot choose this rate source.
  if (!Number.isSafeInteger(request.amount_msats) || request.amount_msats <= 0) return false;
  const rate = await balanceCurrencyRate(ask.currency);
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) return false;
  const proxyMicro = msatsToMicro(request.amount_msats, rate);
  if (!Number.isSafeInteger(proxyMicro) || proxyMicro < 0 ||
      !withinAdvertisedTolerance(BigInt(ask.amount_micro), BigInt(proxyMicro)))
    throw new DvmError("credit_payment_amount_exceeds_limit",
      "The exact balance charge exceeds the caller's local price for this ask.",
      "Refresh the ask or have the provider correct its amount; no balance authorization was sent.");
  const amountMsats = Math.max(1, usdToMsats(ask.amount_micro / 1_000_000, rate));
  if (!Number.isSafeInteger(amountMsats)) return false;
  if ((args.policy.maxIncrementMsats > 0 && amountMsats > args.policy.maxIncrementMsats) ||
      (job.totalPaidMsats ?? 0) + amountMsats > args.policy.maxTotalMsats)
    throw new DvmError("over_budget", "The exact balance charge would exceed this job's budget.");
  if (amountMsats > args.policy.autoPayBelowMsats) return false;
  const selectedBinding = binding;
  const domain = signedRequestDomain({ provider: info, endpoint: provider.endpoint!, method: "POST",
    path: `v1/job/${jobId}/messages`, capability: null });
  const authorization = signDvmRequestData(signer.privkey, {
    credit_id: selectedBinding.creditId, draw_id: selectedBinding.drawId,
    payment_id: randomUUID(), request_seq: requestSeq, amount_micro: ask.amount_micro, currency: ask.currency,
  }, domain) as Authorization;
  const intent = mutateCreditPayment(jobId, (current) => {
    if (current.pendingCreditPayment) {
      if (current.pendingCreditPayment.authorization.request_seq !== requestSeq)
        throw new DvmError("credit_payment_pending", "Another balance payment needs recovery first.");
      return current.pendingCreditPayment;
    }
    const booked = current.bookedCreditPayments?.find((entry) => entry.authorization.request_seq === requestSeq);
    if (booked) return booked;
    if ((current.paymentsHonoured ?? 0) >= args.policy.maxPayments)
      throw new DvmError("payment_cap_exceeded", "Job has reached its maximum payment count.");
    if ((current.totalPaidMsats ?? 0) + amountMsats > args.policy.maxTotalMsats)
      throw new DvmError("over_budget", "The exact balance charge would exceed this job's budget.");
    current.creditBinding = selectedBinding;
    current.pendingCreditPayment = { authorization, request, amountMsats,
      ...("unbound" in job.creditBinding! ? { selectedUnbound: true as const } : {}) };
    return current.pendingCreditPayment;
  });
  return await sendCreditPayment(jobId, intent, transport, provider, jobToken) ? (intent.amountMsats ?? intent.request.amount_msats) : false;
}
