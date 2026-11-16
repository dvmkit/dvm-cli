import { Amount, HttpResponseError, MintOperationError, type Wallet } from "@cashu/cashu-ts";
import {
  fetchMeltQuote,
  getInputFeesForProofs,
  toCashuProofs,
  type AgentProof,
  type MeltQuoteInfo,
  type MintAmountBounds,
} from "@dvmkit/sdk/internal";
import type { CashOutMintOptions, CashOutMintOutcome } from "./cash-out";
import { invoiceAmountSats, invoiceDestination } from "./invoice";
import type { PreparedCashOut } from "./cash-out-prepare";
import { forgetMeltQuote, rememberMeltQuote, storedMeltQuote } from "./melt-quotes";

type QuoteLookup = Pick<Wallet, "checkMeltQuoteBolt11">;

/** How a mint words its refusal to quote an invoice it has already quoted. */
function isDuplicateQuoteRefusal(err: unknown): boolean {
  return /already has a (melt )?quote/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * Whether the mint itself answered and rejected the request, as opposed to a
 * timeout, a dropped connection, or a server fault that says nothing about it.
 */
function isMintRejection(err: unknown): boolean {
  if (err instanceof MintOperationError) return true;
  return err instanceof HttpResponseError && err.status >= 400 && err.status < 500
    && err.status !== 408 && err.status !== 429;
}

/**
 * The melt quote for a fixed invoice. Some mints issue one quote per invoice
 * and refuse a second, so a quote an earlier run left unpaid is reused rather
 * than requested again. Only the mint's own answer makes a stored quote usable:
 * `UNPAID` and unexpired. A `PENDING` or `PAID` quote never leads to a new one.
 */
async function resolveInvoiceQuote(
  mint: string,
  invoice: string,
  nowMs: number,
  cashuWallet: QuoteLookup
): Promise<MeltQuoteInfo | CashOutMintOutcome> {
  const held = storedMeltQuote(mint, invoice, nowMs);
  if (held) {
    let current;
    try {
      current = await cashuWallet.checkMeltQuoteBolt11(held.quote_id);
    } catch (err) {
      // Only the mint's own answer means the quote is gone. Anything else
      // leaves its state unknown, and an unknown quote may be paid or pending.
      if (!isMintRejection(err)) {
        return {
          kind: "failed", mint, settlement: "reverted", reason: "quote_state_unknown",
          message: `Could not check this wallet's saved melt quote for the invoice at ${mint}: ${err instanceof Error ? err.message : String(err)}. No money moved and the quote is still saved. Run \`dvm wallet mint-health\`, then retry \`dvm wallet cash-out <invoice>\`; do not pay this invoice from another mint until the quote's state is known.`,
        };
      }
      forgetStored(mint, invoice, held.quote_id);
      current = undefined;
    }
    if (current && current.state === "PAID") {
      return {
        kind: "failed", mint, settlement: "reverted", reason: "quote_already_in_progress",
        message: `${mint} reports this invoice as already paid with this wallet's saved quote. No money moved in this run and nothing is left to pay; do not pay this invoice again. \`dvm wallet show\` shows the current balance.`,
      };
    }
    if (current && current.state === "PENDING") {
      return {
        kind: "failed", mint, settlement: "reverted", reason: "quote_already_in_progress",
        message: `${mint} reports this invoice's melt quote as being paid. No money moved in this run. Run \`dvm wallet show\` to reconcile it; do not pay this invoice again.`,
      };
    }
    const sameInvoice = current !== undefined
      && (typeof current.request !== "string" || invoiceDestination(current.request) === invoiceDestination(invoice));
    const live = current !== undefined && current.state === "UNPAID" && sameInvoice
      && !(typeof current.expiry === "number" && current.expiry * 1000 <= nowMs);
    if (current && live) {
      return {
        amountSats: Amount.from(current.amount).toNumber(),
        feeReserveSats: Amount.from(current.fee_reserve).toNumber(),
        rawQuote: current,
      };
    }
    if (current) forgetStored(mint, invoice, held.quote_id);
  }

  let quote: MeltQuoteInfo;
  try {
    quote = await fetchMeltQuote(mint, invoice);
  } catch (err) {
    if (!isDuplicateQuoteRefusal(err)) throw err;
    return {
      kind: "failed", mint, settlement: "reverted", reason: "quote_already_exists",
      message: `${mint} already holds a melt quote for this invoice and will not issue another, and this wallet has no usable record of that quote. No money moved. Ask for a new invoice, or run \`dvm wallet cash-out <invoice> --mint <url>\` to pay this one from a different mint.`,
    };
  }
  // Recorded before any fee, balance, or dry-run decision, so every way of
  // stopping short of the melt leaves the quote findable. Best effort: losing
  // the record costs a retry at such a mint, never money.
  try {
    rememberMeltQuote({
      mint, bolt11: invoice, quote_id: quote.rawQuote.quote,
      amount_sats: quote.amountSats, fee_reserve_sats: quote.feeReserveSats,
      expires_at: typeof quote.rawQuote.expiry === "number" ? quote.rawQuote.expiry : null,
    }, nowMs);
  } catch { /* see above */ }
  return quote;
}

function forgetStored(mint: string, invoice: string, quoteId: string): void {
  try { forgetMeltQuote(mint, invoice, quoteId); } catch { /* a stale record is rechecked at the mint before any reuse */ }
}

export async function prepareInvoice(
  opts: CashOutMintOptions,
  candidates: AgentProof[],
  bounds: MintAmountBounds,
  cashuWallet: QuoteLookup
): Promise<PreparedCashOut | CashOutMintOutcome> {
  const mint = opts.mintUrl;
  const refuse = (reason: "quote_amount_mismatch" | "quote_expired", message: string): CashOutMintOutcome => ({
    kind: "skipped", mint, reason,
    message: `${message} No money moved. Run \`dvm wallet mint-health\`, then retry \`dvm wallet cash-out <invoice>\`.`,
  });
  const invoice = opts.bolt11!;
  const amount = invoiceAmountSats(invoice, (opts.now ?? Date.now)());
  try {
    // Compare the mint's sat quote with the locally decoded payment amount.
    const quote = await resolveInvoiceQuote(mint, invoice, (opts.now ?? Date.now)(), cashuWallet);
    if ("kind" in quote) return quote;
    if (quote.amountSats !== amount) {
      return refuse("quote_amount_mismatch", `The mint quoted ${quote.amountSats} sats for a ${amount} sat invoice.`);
    }
    if (typeof quote.rawQuote.expiry === "number" && quote.rawQuote.expiry * 1000 <= (opts.now ?? Date.now)()) {
      return refuse("quote_expired", "The invoice's melt quote has expired.");
    }
    const inBounds = (bounds.minSats === null || amount >= bounds.minSats) && (bounds.maxSats === null || amount <= bounds.maxSats);
    const selected: AgentProof[] = [];
    let selectedTotal = 0;
    let inputFees = 0;
    for (const proof of candidates) {
      selected.push(proof);
      selectedTotal += proof.amount;
      inputFees = await getInputFeesForProofs(mint, toCashuProofs(selected));
      if (inBounds && selectedTotal >= quote.amountSats + quote.feeReserveSats + inputFees) break;
    }
    let largest = Math.max(0, Math.min(selectedTotal - quote.feeReserveSats - inputFees, bounds.maxSats ?? Infinity));
    if (largest < (bounds.minSats ?? 1)) largest = 0;
    const fits = largest > 0
      ? `The largest invoice amount that fits at the quoted fees is ${largest} sats. No money moved. Ask for an invoice of at most ${largest} sats, then run \`dvm wallet cash-out <invoice>\`.`
      : "No invoice can be paid from this balance at the quoted fees and mint limits. No money moved. Run `dvm wallet show` to check your balance, or `dvm wallet fund` to add funds.";
    if (selectedTotal < quote.amountSats + quote.feeReserveSats + inputFees) {
      return { kind: "skipped", mint, reason: "fees_exceed_balance",
        message: `The ${quote.amountSats} sat invoice plus fees exceeds the ${selectedTotal} sat balance at ${mint}. ${fits}` };
    }
    if ((bounds.minSats !== null && amount < bounds.minSats) || (bounds.maxSats !== null && amount > bounds.maxSats)) {
      return { kind: "skipped", mint, reason: "amount_out_of_range",
        message: `The ${amount} sat invoice is outside this mint's payout limits. ${fits}` };
    }
    return { invoice, quote, selected, selectedTotal, inputFees };
  } catch (err) {
    return { kind: "failed", mint, settlement: "reverted",
      message: `Could not obtain a cash-out quote or input fees at ${mint}: ${err instanceof Error ? err.message : String(err)}. No money moved. Run \`dvm wallet mint-health\`, then retry \`dvm wallet cash-out <invoice>\`.` };
  }
}
