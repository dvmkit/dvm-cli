import {
  fetchMeltQuote,
  getInputFeesForProofs,
  toCashuProofs,
  type AgentProof,
  type MintAmountBounds,
} from "@dvmkit/sdk/internal";
import type { CashOutMintOptions, CashOutMintOutcome } from "./cash-out";
import { invoiceAmountSats } from "./invoice";
import type { PreparedCashOut } from "./cash-out-prepare";

export async function prepareInvoice(
  opts: CashOutMintOptions,
  candidates: AgentProof[],
  bounds: MintAmountBounds
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
    const quote = await fetchMeltQuote(mint, invoice);
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
