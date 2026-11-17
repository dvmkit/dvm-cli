import { recordSpendOnce } from "./budget-ledger";
import { formatFiat } from "@dvmkit/sdk";
import { DvmError, asProviderText, pendingDrainFor, clearCreditSelection, ensureProvisionalCredit, loadCredit, recordFundResponse,
  shellQuoteArg, signDvmRequestData, signedRequestDomain, loadAgentWallet, type PaymentRequestContent, type ProviderText, type SendMessageResult, type Transport, type ProviderRef } from "@dvmkit/sdk/internal";
import { findSigningIdentityByPubkey } from "./cli-identity-resolve";
import { loadRequestIntent } from "./request-intent-store";
import { loadJob, recordPaymentCreditLanding } from "./job-store";
import { providerDvmIdentity } from "./credit-per-dvm";
import { sameEndpoint } from "./job-access";
import { notePaymentCreditLanding } from "./credit-notice";
import { answeredYieldSeqs, pendingPaymentRequest, loadAnsweredYieldSeqs } from "./yield-state";
import { isTerminalJobStatus, type NextActionPay } from "./next-action";
import { commitHeldSubmission } from "./wallet-agent/spend";

export interface PaymentCredit {
  credit_id: string;
  credited_micro: number;
  credit_currency: string;
  provider_display?: ProviderText;
  provider_hint?: ProviderText;
}
export type CreditMessageResult = SendMessageResult & { credit?: PaymentCredit };
export interface PaymentCreditLanding extends PaymentCredit {
  endpoint: string;
  rail: "cashu_p2pk" | "x402" | "tempo";
  amount_msats: number;
  fund_id: string;
  debit_msats: number;
  btc_rate: number;
  amount_sats?: number;
  job_id: string;
  request_seq?: number;
  caller_pubkey?: string;
  cashu_request_id?: string;
  ask_answered?: boolean;
  ask_open?: boolean;
  job_terminal?: boolean;
  balance_unheld?: boolean;
  credit_payment_unavailable?: boolean;
  drainable: boolean;
  display: string;
  reclaim_command?: string;
}
export interface CreditedPaymentResult {
  status: "credited";
  rail: PaymentCreditLanding["rail"];
  amountMsats: number;
  credit: PaymentCreditLanding;
}

export function parsePaymentCredit(value: unknown): PaymentCredit | undefined {
  if (value === undefined) return undefined;
  const credit = value as Partial<PaymentCredit> | null;
  if (!credit || typeof credit.credit_id !== "string" || !credit.credit_id.length || credit.credit_id.length > 512 ||
      !Number.isSafeInteger(credit.credited_micro) || Number(credit.credited_micro) <= 0 ||
      typeof credit.credit_currency !== "string" || !/^[a-z]{3}$/.test(credit.credit_currency))
    throw new DvmError("payment_unconfirmed", "The provider accepted the payment but returned unreadable credit details. Do not send another payment.");
  const prose = value as { display?: unknown; hint?: unknown };
  return { credit_id: credit.credit_id, credited_micro: credit.credited_micro!, credit_currency: credit.credit_currency,
    ...(typeof prose.display === "string" ? { provider_display: asProviderText(prose.display) } : {}),
    ...(typeof prose.hint === "string" ? { provider_hint: asProviderText(prose.hint) } : {}) };
}

export function describePaymentCreditLanding(landing: PaymentCreditLanding, partial = false): PaymentCreditLanding {
  const job = loadJob(landing.job_id);
  const answered = landing.ask_answered || !!job && (isTerminalJobStatus(job.status) ||
    landing.request_seq !== undefined && loadAnsweredYieldSeqs(job.id).has(landing.request_seq));
  const open = !answered && landing.ask_open;
  const amount = formatFiat(landing.credited_micro / 1_000_000, landing.credit_currency);
  const owned = !!landing.caller_pubkey && !landing.credit_id.startsWith("imp:");
  const stored = owned ? loadCredit(landing.endpoint, landing.caller_pubkey!) : undefined;
  const pending = pendingDrainFor(stored, landing.credit_id);
  const balance = stored?.creditId === landing.credit_id ? stored : stored?.siblingCredits?.find((entry) => entry.creditId === landing.credit_id);
  const hasBalance = balance === undefined || balance.remainingMicro > 0;
  const terminal = landing.job_terminal === true || !!job && isTerminalJobStatus(job.status);
  const drainable = terminal && owned && !!answered && landing.balance_unheld === true && !pending && hasBalance;
  let command: string | undefined;
  if (drainable) {
    command = landingDrainCommand(landing);
  }
  return { ...landing, ...(answered ? { credit_payment_unavailable: undefined } : {}), ask_answered: !!answered, ask_open: !!open, drainable, reclaim_command: command,
    display: (partial ? `The unused part of the payment, ${amount}, became credit at ${landing.endpoint}. `
      : answered ? `The charge was already settled or is no longer payable; ${amount} became credit at ${landing.endpoint}. Some or all of that credit may since have paid job charges. `
      : `The payment landed as credit at ${landing.endpoint}: ${amount}. ` +
        (open ? "The charge is still open. This credit may still pay the charge; the provider may hold the credit until the job ends. " : "Whether the charge is settled has not been confirmed. ")) +
      (!owned ? (landing.credit_id.startsWith("imp:") ? "This is unsigned credit; no caller key can drain it. " : "No signed caller is recorded for this job. For an unsigned payment, no caller key can drain this credit. ") +
        "The amount and transfer are recorded; contact the provider about returning it."
        : pending ? "A drain is pending for this credit; wait for that reclaim rather than requesting another."
          : command ? `Reclaim it with \`${command}\` using the original caller identity.`
            : "Check the job and credit balance before reclaiming it.") };
}

function landingDrainCommand(landing: PaymentCreditLanding): string {
  let signer: ReturnType<typeof findSigningIdentityByPubkey> = null;
  try { signer = findSigningIdentityByPubkey(landing.caller_pubkey!); } catch { /* The balance remains owned when the identity store is unavailable. */ }
  const identity = signer && "name" in signer.source ? ` --as ${shellQuoteArg(signer.source.name)}` : "";
  return `dvm credit drain ${shellQuoteArg(landing.endpoint)} --credit-id ${shellQuoteArg(landing.credit_id)}${identity}`;
}

export function paymentCreditChoice(jobId: string, seq: number, request: PaymentRequestContent, requireCreditAttempt = true): NextActionPay | undefined {
  const job = loadJob(jobId);
  const landings = Object.values(job?.paymentCreditLandings ?? {}).filter((entry) => entry.request_seq === seq &&
    sameEndpoint(entry.endpoint, job!.endpoint));
  const creditMayPay = !!job?.creditBinding && !!request.credit;
  if (!landings.length || requireCreditAttempt && creditMayPay && !landings.some((entry) => entry.credit_payment_unavailable)) return undefined;
  const descriptions = landings.map((entry) => {
    const amount = formatFiat(entry.credited_micro / 1_000_000, entry.credit_currency);
    const owned = entry.caller_pubkey && !entry.credit_id.startsWith("imp:");
    return `${amount} is held as credit${owned ? ` (${entry.credit_id})` : entry.credit_id.startsWith("imp:") ? "; no caller key can drain this unsigned credit" : ""} at ${entry.endpoint}.`;
  });
  const reclaim = landings.map((entry) => entry.credit_id.startsWith("imp:")
    ? "Unsigned credit cannot be reclaimed by a caller key; contact the provider about returning it."
    : entry.caller_pubkey ? `After the job ends, check the remaining balance and reclaim available credit with \`${landingDrainCommand(entry)}\`.`
      : "No signed caller is recorded for this credit; contact the provider about returning it.");
  return { type: "pay", job_id: jobId, amount_msats: request.amount_msats, reason: asProviderText(request.reason), requires_approval: true,
    display: `${descriptions.join(" ")} The charge is still open. A human must choose what to do next.`,
    hint: `Automatic payment may use credit only. Ask your human to choose: pay with a different rail explicitly using \`dvm pay ${shellQuoteArg(jobId)} --rail <different-rail>\`, or stop the job with ` +
      `\`dvm decline ${shellQuoteArg(jobId)}\`. ${reclaim.join(" ")} Do not repeat a rail whose payment already landed as credit.` };
}

export async function refreshPaymentCredit(landing: PaymentCreditLanding, transport: Transport, provider: ProviderRef, jobToken?: string): Promise<PaymentCreditLanding> {
  // A 201 confirms the deposit, not satisfaction of the ask. Require positive
  // current job evidence before suppressing a future payment for that ask.
  const options = { jobToken, timeoutMs: 5000 };
  const [status, history] = await Promise.allSettled([
    transport.status(landing.job_id, provider, options),
    transport.getMessages(landing.job_id, 0, provider, options),
  ]);
  const terminal = status.status === "fulfilled" && isTerminalJobStatus(status.value.status);
  let answered = terminal;
  let open = false;
  if (history.status === "fulfilled" && landing.request_seq !== undefined) {
    const messages = history.value;
    const ask = messages.find((message) => message.seq === landing.request_seq && message.type === "payment-request");
    open = status.status === "fulfilled" && status.value.status === "awaiting-input" &&
      pendingPaymentRequest(messages)?.seq === landing.request_seq;
    answered ||= answeredYieldSeqs(messages).has(landing.request_seq) ||
      messages.some((message) => message.from === "provider" && message.seq > landing.request_seq! &&
        ["complete", "cancel"].includes(message.type)) ||
      !!ask && (pendingPaymentRequest(messages)?.seq !== landing.request_seq ||
        // SDK v0.41.0 allows 30 seconds of payment arrival grace after expiry.
        (ask.type === "payment-request" && ask.content.expires_at_ms !== undefined && Date.now() > ask.content.expires_at_ms + 30_000));
  }
  const updated = describePaymentCreditLanding({ ...landing, ask_answered: answered, ask_open: !answered && open, job_terminal: terminal });
  if (landing.request_seq !== undefined) recordPaymentCreditLanding(landing.job_id, landing.request_seq, updated);
  return updated;
}

export async function finishPaymentCredit(landing: PaymentCreditLanding): Promise<CreditedPaymentResult> {
  landing = describePaymentCreditLanding(landing);
  notePaymentCreditLanding(landing);
  // This is wallet outflow into provider credit, not consumption by the job.
  // Reuse deposit accounting so retries count it once against global caps.
  recordSpendOnce({ kind: "credit_fund", jobId: `fund:${landing.fund_id}`, providerEndpoint: landing.endpoint,
    msats: landing.debit_msats, btcRate: landing.btc_rate, label: "late payment credited as balance" });
  if (landing.cashu_request_id) await commitHeldSubmission(landing.cashu_request_id);
  return { status: "credited", rail: landing.rail, amountMsats: landing.amount_msats, credit: landing };
}

export async function receivePaymentCredit(args: { jobId: string; requestSeq?: number; credit: PaymentCredit;
  rail: PaymentCreditLanding["rail"]; amountMsats: number; fundId: string; btcRate: number; cashuRequestId?: string; partial?: boolean; transport: Transport; provider: ProviderRef }): Promise<CreditedPaymentResult> {
  const { jobId, credit, transport, provider } = args;
  const job = loadJob(jobId);
  const matching = job && provider.endpoint && sameEndpoint(job.endpoint, provider.endpoint);
  const intent = matching && job.requestId ? loadRequestIntent(job.requestId) : undefined;
  const caller = matching ? job.creditBinding?.callerPubkey ??
    (intent && sameEndpoint(intent.endpoint, job.endpoint) ? intent.callerPubkey : undefined) : undefined;
  let signer: ReturnType<typeof findSigningIdentityByPubkey> = null;
  try { if (caller) signer = findSigningIdentityByPubkey(caller); } catch { /* Acceptance survives an unavailable identity store. */ }
  const owned = !!caller && !credit.credit_id.startsWith("imp:");
  const cashuSats = args.cashuRequestId ? loadAgentWallet()?.pending_submissions.find((entry) => entry.request_id === args.cashuRequestId)?.amount_sats : undefined;
  let landing: PaymentCreditLanding = { ...credit, endpoint: provider.endpoint!, rail: args.rail, amount_msats: args.amountMsats, fund_id: args.fundId, btc_rate: args.btcRate,
    debit_msats: cashuSats === undefined ? args.amountMsats : cashuSats * 1000, job_id: jobId, request_seq: args.requestSeq,
    ...(cashuSats !== undefined ? { amount_sats: cashuSats } : {}),
    ...(caller ? { caller_pubkey: caller } : {}), ...(args.cashuRequestId ? { cashu_request_id: args.cashuRequestId } : {}),
    ask_answered: false, drainable: false, display: "" };
  landing.display = describePaymentCreditLanding(landing, args.partial).display;
  // Persist acceptance before a balance read or wallet save can fail. The money
  // is at the provider; recovery must never resend or book it against the ask.
  if (!args.partial && matching && args.requestSeq !== undefined) recordPaymentCreditLanding(jobId, args.requestSeq, landing);
  if (owned) {
    let prior = loadCredit(provider.endpoint!, caller);
    let identity: ReturnType<typeof providerDvmIdentity>;
    try {
      if (!signer) throw new Error("Original caller identity is unavailable");
      const description = await transport.describe(provider, { timeoutMs: 5000 });
      identity = providerDvmIdentity(description);
      prior = loadCredit(provider.endpoint!, caller, identity);
      const body = signDvmRequestData(signer.privkey, { op: "balance", credit_id: credit.credit_id },
        signedRequestDomain({ provider: description, endpoint: provider.endpoint!, method: "POST", path: "v1/credit", capability: null }));
      if (!transport.credit) throw new Error("Credit reads are unavailable");
      const response = await transport.credit(provider, body, undefined, { timeoutMs: 5000 });
      const balance = response.credit ?? response.credits?.find((entry) => entry.credit_id === credit.credit_id);
      if (!balance || balance.credit_id !== credit.credit_id || balance.currency !== credit.credit_currency)
        throw new Error("The balance read did not name the accepted credit");
      // remaining_micro excludes reservations; equal totals mean no job holds funds.
      landing.balance_unheld = balance.drainable === true && balance.remaining_micro === balance.balance_micro;
      recordFundResponse({ endpoint: provider.endpoint!, identity, callerPubkey: caller, credit: balance,
        targetMicro: prior?.targetMicro ?? 0 });
      // A late deposit must not silently select a different credit for draws.
      if (prior?.creditId !== credit.credit_id) clearCreditSelection(provider.endpoint!, caller, credit.credit_id, identity);
    } catch {
      try {
        if (!prior || prior.creditId === credit.credit_id) ensureProvisionalCredit({ endpoint: provider.endpoint!, identity, callerPubkey: caller,
          creditId: credit.credit_id, currency: credit.credit_currency, targetMicro: prior?.targetMicro ?? 0 });
      } catch { /* The durable landing remains the recovery record if projection storage fails. */ }
      // The durable landing retains the exact credited amount even if the live
      // balance cannot be read; it is also visible in the offline credit list.
    }
  }
  if (args.partial) {
    landing = describePaymentCreditLanding(landing, true);
    notePaymentCreditLanding(landing);
    return { status: "credited", rail: landing.rail, amountMsats: landing.amount_msats, credit: landing };
  }
  landing = await refreshPaymentCredit(landing, transport, provider, job?.jobToken);
  return finishPaymentCredit(landing);
}
