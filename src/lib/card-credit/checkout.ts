import { DvmError, formatUsd, shellQuoteArg, type CreditOpResult } from "@dvmkit/sdk/internal";
import type { CreditFundOutcome, FundCreditArgs } from "../credit-fund";
import type { CardFundDeps } from "./fund";
import {
  clearPendingCardFunding,
  checkoutRetiredSince,
  listPendingCardFundings,
  loadPendingCardFunding,
  withCardFundingLock,
  recordPendingCardFunding,
  updatePendingCheckout,
  type PendingCheckoutFunding,
} from "./journal";

interface CheckoutResponse {
  status?: string;
  credit_id?: string;
  checkout?: { url: string; expires_at: number };
}

function checkoutHandoff(entry: PendingCheckoutFunding, identity?: string): Record<string, unknown> {
  const amount = `$${formatUsd(entry.amountMicro / 1_000_000)}`;
  const caller = identity ? ` --as ${shellQuoteArg(identity)}` : "";
  const balanceCommand = `dvm credit balance ${shellQuoteArg(entry.endpoint)}${caller}`;
  return {
    status: "awaiting_payment",
    credit_id: entry.creditId,
    fund_id: entry.fundId,
    rail: "stripe",
    amount_micro: entry.amountMicro,
    amount_usd: amount,
    checkout: entry.checkout,
    expires_at: entry.checkout ? new Date(entry.checkout.expires_at * 1_000).toISOString() : undefined,
    relay: { copy_text: entry.checkout?.url, standalone: true },
    next_step: `dvm credit fund ${shellQuoteArg(entry.endpoint)} --rail stripe --credit-id ${shellQuoteArg(entry.creditId)} --amount ${shellQuoteArg(amount)}${caller}`,
    balance_command: balanceCommand,
    display: `Pay ${amount} by card at ${entry.checkout?.url ?? "the checkout link"}, then confirm the balance with ${balanceCommand}. The link is not proof of payment.`,
  };
}

function checkoutExpiryDisplay(hint?: string): string {
  return `The card checkout expired. No credit was added. ${hint ?? "Start a new top-up."}`;
}

export async function fundOverCheckout(
  args: FundCreditArgs,
  fundId: string,
  deps: CardFundDeps,
  prior: PendingCheckoutFunding | undefined,
  booked: (entry: PendingCheckoutFunding, result: CreditOpResult) => Promise<CreditFundOutcome>
): Promise<CreditFundOutcome> {
  if (!prior && args.amountMicro % 10_000 !== 0) {
    const error = new DvmError("invalid_argument", "Card top-ups must be whole USD cents.");
    return { creditId: args.creditId, fundId, rail: "stripe", status: "refused", error, display: error.message };
  }
  const minimum = Math.max(args.menu?.stripe?.min_micro ?? 500_000, args.menu?.min_micro ?? 0);
  const amountMicro = prior?.amountMicro ?? Math.max(args.amountMicro, minimum);
  const startedAt = args.cardInvocationStartedAt ?? Date.now();
  const reserved = await withCardFundingLock({ endpoint: args.ref.endpoint, callerPubkey: args.signing.pubkey }, () => {
    const retired = args.cardCreditIdExplicit ? undefined : checkoutRetiredSince(
      { endpoint: args.ref.endpoint, callerPubkey: args.signing.pubkey }, startedAt);
    if (retired) return { retired };
    const existing = listPendingCardFundings({ endpoint: args.ref.endpoint, callerPubkey: args.signing.pubkey })
      .find((entry): entry is PendingCheckoutFunding => entry.v === 2 &&
        (!args.cardCreditIdExplicit || entry.creditId === args.creditId));
    if (existing) return { entry: existing, created: false };
    // Another process may already have booked and retired this known intent. Replay it.
    if (prior) return { entry: prior, created: false };
    const entry: PendingCheckoutFunding = {
      v: 2, endpoint: args.ref.endpoint, callerPubkey: args.signing.pubkey,
      creditId: args.creditId, fundId, amountMicro,
      targetMicro: args.targetMicro ?? amountMicro, presentedAt: Date.now(),
    };
    // Reserve before creation too: a lost first response must retain the same session id.
    return recordPendingCardFunding(entry) ? { entry, created: true } : undefined;
  });
  if (!reserved) {
    return { creditId: args.creditId, fundId, rail: "stripe", status: "refused",
      display: "Another card top-up is already in progress. Re-run to resume it." };
  }
  if (reserved.retired) {
    const caller = args.cardIdentity ? ` --as ${shellQuoteArg(args.cardIdentity)}` : "";
    const balance = `dvm credit balance ${shellQuoteArg(args.ref.endpoint)}${caller}`;
    return { creditId: reserved.retired.creditId, fundId: reserved.retired.fundId, rail: "stripe", status: "refused",
      display: `A card top-up for this DVM completed while this command was starting. Check the balance with ${balance}. Re-run this command to start another top-up.` };
  }
  const { entry } = reserved;
  const raised = reserved.created && entry.amountMicro > args.amountMicro
    ? `Raised the requested $${formatUsd(args.amountMicro / 1_000_000)} to this DVM's card minimum of $${formatUsd(entry.amountMicro / 1_000_000)}.`
    : undefined;
  const base = { creditId: entry.creditId, fundId: entry.fundId, rail: "stripe" as const };
  const body = {
    op: "fund", credit_id: entry.creditId,
    fund: { method: "stripe", via: "checkout", fund_id: entry.fundId, amount_micro: entry.amountMicro },
  };
  let announced = false;
  let delay = 1_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    try {
      // post signs anew on every call; only the fund block is replayed.
      const result = await deps.post(body);
      const pending = result as CreditOpResult & CheckoutResponse;
      if (pending.status !== "pending") {
        if (!result.credit || result.funded_micro === undefined) {
          throw new DvmError("provider_error", "The DVM returned no confirmed card credit.");
        }
        const outcome = await booked(entry, result);
        return { ...outcome, display: [raised, outcome.display].filter(Boolean).join(" "),
          hint: `${outcome.hint ?? ""} Confirm the balance with ${String(checkoutHandoff(entry, args.cardIdentity).balance_command)}.`.trim() };
      }
      if (!pending.checkout || typeof pending.checkout.url !== "string" ||
        !Number.isFinite(pending.checkout.expires_at) || pending.credit_id !== entry.creditId) {
        throw new DvmError("provider_error", "The DVM returned an invalid checkout hand-off.");
      }
      entry.checkout = { url: pending.checkout.url, expires_at: pending.checkout.expires_at };
      updatePendingCheckout(entry);
      const handoff = checkoutHandoff(entry, args.cardIdentity);
      const display = [raised, handoff.display].filter(Boolean).join(" ");
      if (args.cardWait === false || Date.now() >= entry.checkout.expires_at * 1_000) {
        return { ...base, status: "checkout_pending", checkoutHandoff: { ...handoff, display }, display };
      }
      if (!announced) {
        args.cardCheckoutProgress?.({ ...handoff, display });
        announced = true;
      }
    } catch (err) {
      const error = err instanceof DvmError ? err : new DvmError("provider_error", "Could not confirm the card top-up.");
      // A failed read says nothing about a possibly paid session. Only expiry closes it.
      const terminal = await withCardFundingLock(entry, () => {
        const latest = loadPendingCardFunding(entry.endpoint, entry.callerPubkey, entry.creditId);
        if (latest?.v === 2 && latest.checkout) entry.checkout = latest.checkout;
        const closed = error.code === "checkout_expired" || (!entry.checkout &&
          (error.code === "checkout_not_supported" || error.data?.retryable === false));
        if (closed) clearPendingCardFunding(entry);
        return closed;
      });
      const unresolved = entry.checkout !== undefined && !terminal;
      const recovery = "Re-run the same command to resume this unresolved top-up before starting another payment. The server keeps a paid session bookable for 24 hours and refunds it to the card after that if it was never booked.";
      const display = error.code === "checkout_expired"
        ? checkoutExpiryDisplay(error.hint)
        : unresolved
          ? `The card top-up is unresolved (${String(error.data?.cause ?? error.code)}). ${recovery}`
          : error.code === "checkout_unavailable"
          ? `Card checkout is unavailable (${String(error.data?.cause ?? "unknown cause")}). ${terminal
            ? "Use another rail."
            : "Re-run the same command to resume this top-up before starting another payment."}`
          : error.message;
      if (terminal || error.data?.retryable === false || error.code === "checkout_not_supported" || args.cardWait === false || !entry.checkout || Date.now() >= entry.checkout.expires_at * 1_000) {
        return { ...base, status: "refused", error, display,
          hint: unresolved ? recovery : terminal ? (error.code === "checkout_unavailable" ? "Use another funding rail." : error.hint)
            : "Re-run the same command to resume this top-up before starting another payment." };
      }
    }
    await sleep(Math.max(0, Math.min(delay, entry.checkout!.expires_at * 1_000 - Date.now())));
    delay = Math.min(delay * 2, 10_000);
  }
}
