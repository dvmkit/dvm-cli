import {
  DvmError,
  formatUsd,
  recordPendingFunding,
  shellQuoteArg,
  type CreditOpResult,
  type LightningFundingOffer,
  type PendingFunding,
} from "@dvmkit/sdk/internal";
import type { CreditFundOutcome, FundCreditArgs } from "./credit-fund";

// The SDK journal preserves additive fields. Keeping the mode beside the intent
// prevents a later invocation with a connected wallet from paying it automatically.
export interface InvoicePendingFunding extends PendingFunding {
  lightningPaymentMode: "invoice";
}

type PayableFunding = InvoicePendingFunding & {
  bolt11: string;
  amountMsats: number;
  expiresAtMs: number;
};

export function isInvoiceFunding(pending: PendingFunding): pending is InvoicePendingFunding {
  return pending.rail === "lightning" &&
    (pending as Partial<InvoicePendingFunding>).lightningPaymentMode === "invoice";
}

export function creditInvoiceCommand(args: {
  endpoint: string;
  amountMicro: number;
  creditId?: string;
  identity?: string;
}): string {
  const amount = (args.amountMicro / 1_000_000).toFixed(6).replace(/(\.\d{2,}?)0+$/, "$1");
  return `dvm credit fund ${shellQuoteArg(args.endpoint)} --rail lightning --invoice --amount ${shellQuoteArg(`$${amount}`)}` +
    (args.creditId ? ` --credit-id ${shellQuoteArg(args.creditId)}` : "") +
    (args.identity ? ` --as ${shellQuoteArg(args.identity)}` : "");
}

function handoff(pending: PayableFunding, identity?: string): Record<string, unknown> {
  return {
    status: "awaiting_payment",
    rail: "lightning",
    credit_id: pending.creditId,
    fund_id: pending.fundId,
    bolt11: pending.bolt11,
    amount_micro: pending.amountMicro,
    amount_msats: pending.amountMsats,
    amount_sats: pending.amountMsats / 1000,
    expires_at_ms: pending.expiresAtMs,
    expires_at: new Date(pending.expiresAtMs).toISOString(),
    relay: { copy_text: pending.bolt11, standalone: true },
    next_step: creditInvoiceCommand({
      endpoint: pending.endpoint, amountMicro: pending.amountMicro,
      creditId: pending.creditId, identity,
    }),
    display: `Pay this invoice from any Lightning wallet to load $${formatUsd(pending.amountMicro / 1_000_000)} of prepaid credit. The CLI confirms funding with the DVM; the invoice alone is not proof of payment.`,
  };
}

export async function fundOverInvoice(
  args: FundCreditArgs,
  pending: InvoicePendingFunding,
  deps: {
    post: () => Promise<CreditOpResult>;
    settled: (result: CreditOpResult, pending: InvoicePendingFunding) => CreditFundOutcome;
    terminal: (err: unknown, pending: PendingFunding) => boolean;
    clear: (pending: PendingFunding) => void;
  }
): Promise<CreditFundOutcome> {
  const base = { creditId: pending.creditId, fundId: pending.fundId, rail: "lightning" as const };
  let announced = false;
  let delay = 1000;
  for (;;) {
    let result: CreditOpResult;
    try {
      result = await deps.post();
    } catch (err) {
      const error = err instanceof DvmError ? err : new DvmError("provider_error", "Could not confirm the Lightning funding.");
      const offer = error.code === "lightning_settlement_pending"
        ? error.data?.lightning as LightningFundingOffer | undefined : undefined;
      if (!offer || typeof offer.invoice !== "string" || !offer.invoice ||
        !Number.isSafeInteger(offer.amount_msats) || offer.amount_msats <= 0 ||
        !Number.isSafeInteger(offer.expires_at_ms) || offer.expires_at_ms <= 0 || offer.expires_at_ms > 8_640_000_000_000_000) {
        const terminal = deps.terminal(error, pending);
        if (terminal) deps.clear(pending);
        return { ...base, status: "refused", error,
          display: terminal
            ? `The DVM refused this Lightning funding (${error.code}). No credit was recorded.`
            : `This Lightning funding is unresolved (${error.code}). Its original funding id is saved; payment may already have happened.`,
          hint: terminal
            ? `If you already paid, quote funding id ${pending.fundId} to the DVM operator before funding again.`
            : `Re-run the same command to check this funding before paying again. ${creditInvoiceCommand({ endpoint: pending.endpoint, amountMicro: pending.amountMicro, creditId: pending.creditId, identity: args.invoiceIdentity })}` };
      }
      // A payable invoice already shown to a human must never be replaced under
      // the same intent, even if a misbehaving provider returns a different one.
      if (pending.bolt11 && pending.bolt11 !== offer.invoice) {
        throw new DvmError("provider_error", "The DVM changed the invoice for an unresolved funding.",
          "Do not pay another invoice. Check the original funding with the DVM operator.");
      }
      const payable: PayableFunding = { ...pending, bolt11: offer.invoice, paymentHash: offer.payment_hash,
        amountMsats: offer.amount_msats, expiresAtMs: offer.expires_at_ms };
      pending = payable;
      recordPendingFunding(pending);
      // Reconcile first: a payment made before expiry may only be observed on
      // this call. A local clock cannot prove that no money was sent.
      if (Date.now() >= payable.expiresAtMs) {
        const expired = new DvmError("lightning_invoice_expired", "The Lightning invoice expired before funding was confirmed.",
          "Do not pay this expired invoice. Re-run to reconcile the saved funding before starting another.");
        return { ...base, status: "refused", error: expired, display: expired.message, hint: expired.hint };
      }
      if (pending.paymentOutcome !== undefined) {
        if (args.invoiceWait !== true) {
          return { ...base, status: "settlement_pending",
            display: "The connected wallet's payment is already recorded, but the DVM has not confirmed the credit yet.",
            hint: "Do not pay this invoice again. Re-run this funding or check 'dvm credit balance' to reconcile it." };
        }
      } else {
        const output = handoff(payable, args.invoiceIdentity);
        if (args.invoiceWait !== true) {
          return { ...base, status: "invoice_pending", invoiceHandoff: output,
            display: args.invoiceWait === false
              ? String(output.display)
              : "The original Lightning funding is still pending. Its invoice and funding id are saved; no new payment was made.",
            hint: "Re-run the original 'dvm credit fund --invoice' command to finish this funding before starting another payment." };
        }
        if (!announced) {
          await args.invoiceProgress?.(output);
          announced = true;
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, Math.min(delay, payable.expiresAtMs - Date.now()))));
      delay = Math.min(delay * 2, 10_000);
      continue;
    }
    if (!result.credit || result.funded_micro === undefined) {
      throw new DvmError("provider_error", "The DVM returned no confirmed Lightning credit.",
        "Re-run the same command to reconcile the saved funding before paying again.");
    }
    return deps.settled(result, pending);
  }
}
