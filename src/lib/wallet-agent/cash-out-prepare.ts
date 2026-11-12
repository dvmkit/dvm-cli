import type { Wallet } from "@cashu/cashu-ts";
import { type AgentProof, type MeltQuoteInfo, fetchMeltQuote, getInputFeesForProofs, fetchLnurlPayInvoice, toCashuProofs, meltAmountBounds, type MintAmountBounds, DvmError } from "@dvmkit/sdk/internal";
import type { CashOutMintOptions, CashOutMintOutcome, CashOutTarget } from "./cash-out";
import { proofKey } from "./inflight";
import { prepareInvoice } from "./cash-out-invoice";

export interface PreparedCashOut {
  invoice: string;
  quote: MeltQuoteInfo;
  selected: AgentProof[];
  selectedTotal: number;
  inputFees: number;
  cappedByMintMax?: number;
}

export async function prepareCashOut(opts: CashOutMintOptions, candidates: AgentProof[], cashuWallet: Wallet): Promise<PreparedCashOut | CashOutMintOutcome> {
  const mintUrl = opts.mintUrl;
  const fetchInvoice = opts.fetchInvoice ?? fetchLnurlPayInvoice;
  if (opts.bolt11 !== undefined) return prepareInvoice(opts, candidates, meltBoundsOf(cashuWallet));
  // Cost has three components and only two of them come back in the quote:
  // the invoice `amount`, the mint's Lightning `fee_reserve`, and the NUT-12
  // per-input fee, which is never surfaced by NUT-05 and has to be computed
  // from the keyset locally. The mint requires
  // `inputs >= amount + fee_reserve + input_fees` and rejects with "not enough
  // inputs provided" otherwise.
  // NUT-05 lets a mint cap what it will pay out in one melt, and both
  // mints in the default rotation do. Narrow the target *before* selecting
  // inputs — capping the invoice alone would commit the whole proof set to a
  // small melt. The bounds come off the info the wallet already loaded, so this
  // costs no extra round trip.
  const meltBounds = meltBoundsOf(cashuWallet);
  let target = opts.target;
  let cappedByMintMax: number | undefined;
  if (meltBounds.maxSats !== null) {
    const wanted = opts.target.kind === "all" ? sumSats(candidates) : opts.target.sats;
    if (wanted > meltBounds.maxSats) {
      target = { kind: "exact", sats: meltBounds.maxSats };
      cappedByMintMax = meltBounds.maxSats;
    }
  }

  let selected = selectInputs(candidates, target);
  let inputFees: number;
  try {
    inputFees = await getInputFeesForProofs(mintUrl, toCashuProofs(selected));
  } catch (err) {
    return { kind: "failed", mint: mintUrl, message: errorMessage(err), settlement: "reverted" };
  }

  let selectedTotal = sumSats(selected);

  // A stated payout has the fees drawn on top, so the initial pick — sized
  // against the payout alone — can come up short once the input fee is known.
  // Widen before deciding the invoice amount, or the payout silently shrinks
  // while the mint still holds proofs that would have covered it.
  if (target.kind === "exact" && selectedTotal - inputFees < target.sats) {
    const widened = widenSelection(candidates, selected, target.sats, inputFees);
    if (widened) {
      selected = widened.selected;
      selectedTotal = sumSats(selected);
      try {
        inputFees = await getInputFeesForProofs(mintUrl, toCashuProofs(selected));
      } catch (err) {
        return {
          kind: "failed",
          mint: mintUrl,
          message: errorMessage(err),
          settlement: "reverted",
        };
      }
    }
  }

  const desired =
    target.kind === "all"
      ? selectedTotal - inputFees
      : Math.min(target.sats, selectedTotal - inputFees);
  if (desired <= 0) {
    return {
      kind: "skipped",
      mint: mintUrl,
      reason: "fees_exceed_balance",
      message: `The mint's per-input fee (${inputFees} sats) meets or exceeds the ${selectedTotal} sats available at ${mintUrl}.`,
    };
  }

  // The other end of the NUT-05 range. Refuse here rather than at the melt: the
  // mint would reject the quote anyway, and asking the payee for an invoice it
  // can never be paid against wastes their side of the exchange too.
  if (meltBounds.minSats !== null && desired < meltBounds.minSats) {
    return {
      kind: "skipped",
      mint: mintUrl,
      reason: "amount_out_of_range",
      message: `${mintUrl} won't pay out less than ${meltBounds.minSats} sats in one go, and only ${desired} sats can be sent from here after fees.`,
    };
  }

  // The full fee cap can only be judged once the mint has quoted a routing
  // reserve, and quoting needs an invoice — so a cap refusal normally leaves an
  // unpaid invoice sitting at the payee (harmless; LNURL invoices expire). The
  // input fee is knowable now, though, so a cap that's already broken by that
  // alone never asks the payee for an invoice at all.
  if (opts.maxFeeSats !== undefined && inputFees > opts.maxFeeSats) {
    return {
      kind: "skipped",
      mint: mintUrl,
      reason: "fee_cap_exceeded",
      message: `The per-input fee at ${mintUrl} is ${inputFees} sats on its own, over the ${opts.maxFeeSats} sat cap.`,
    };
  }

  let invoice: string;
  let quote: MeltQuoteInfo;
  try {
    invoice = await fetchInvoice(opts.destination, desired * 1000);
    quote = await fetchMeltQuote(mintUrl, invoice);
  } catch (err) {
    return classifyPreCommitError(mintUrl, err);
  }

  // The fee reserve is only knowable once the mint has quoted. If the
  // committed proofs no longer cover it, prefer widening the input set — that
  // keeps the payout at what the operator asked for. Only when the mint has
  // nothing more to give does the payout shrink, which needs a fresh invoice
  // and a re-quote.
  if (selectedTotal < quote.amountSats + quote.feeReserveSats + inputFees) {
    const widened = widenSelection(
      candidates,
      selected,
      quote.amountSats + quote.feeReserveSats,
      inputFees
    );
    if (widened) {
      selected = widened.selected;
      selectedTotal = sumSats(selected);
      try {
        inputFees = await getInputFeesForProofs(mintUrl, toCashuProofs(selected));
      } catch (err) {
        return {
          kind: "failed",
          mint: mintUrl,
          message: errorMessage(err),
          settlement: "reverted",
        };
      }
    }

    if (selectedTotal < quote.amountSats + quote.feeReserveSats + inputFees) {
      const target = selectedTotal - quote.feeReserveSats - inputFees;
      if (target <= 0) {
        return {
          kind: "skipped",
          mint: mintUrl,
          reason: "fees_exceed_balance",
          message: `Fees at ${mintUrl} (${quote.feeReserveSats} sats routing reserve + ${inputFees} sats input fee) meet or exceed the ${selectedTotal} sats available.`,
        };
      }
      try {
        invoice = await fetchInvoice(opts.destination, target * 1000);
        quote = await fetchMeltQuote(mintUrl, invoice);
      } catch (err) {
        return classifyPreCommitError(mintUrl, err);
      }
      if (selectedTotal < quote.amountSats + quote.feeReserveSats + inputFees) {
        return {
          kind: "skipped",
          mint: mintUrl,
          reason: "fees_exceed_balance",
          message: `${mintUrl} quoted a routing reserve (${quote.feeReserveSats} sats) the ${selectedTotal} sats available can't cover.`,
        };
      }
    }
  }

  return { invoice, quote, selected, selectedTotal, inputFees, cappedByMintMax };
}

/**
 * The mint's advertised NUT-05 payout limits, read off the info the wallet
 * already loaded — `cashOutFromMint` never probes `/v1/info` itself.
 *
 * A mint that says nothing is unbounded, and so is one whose info this can't
 * read: falling back to "no limit" leaves behaviour exactly as it was before
 * rather than refusing a melt on a shape we didn't recognise.
 */
function meltBoundsOf(wallet: Wallet): MintAmountBounds {
  // Typed loosely on purpose: `Wallet` declares `getMintInfo` as always
  // present, but this runs against whatever `getWalletForMint` handed back.
  const reader = wallet as { getMintInfo?: () => { cache?: { nuts?: unknown } } };
  try {
    const nuts = reader.getMintInfo?.().cache?.nuts;
    if (nuts === undefined || nuts === null) return { minSats: null, maxSats: null };
    return meltAmountBounds(nuts as Record<string, unknown>);
  } catch {
    return { minSats: null, maxSats: null };
  }
}

/**
 * Largest-first, so the fewest proofs cover the payout and the mint's
 * per-input fee stays small. `all` takes everything; an exact target takes
 * just enough, falling back to everything when the mint can't cover it (the
 * command draws the remainder from another mint).
 */
function selectInputs(candidates: AgentProof[], target: CashOutTarget): AgentProof[] {
  if (target.kind === "all") return [...candidates];
  const selected: AgentProof[] = [];
  let total = 0;
  for (const p of candidates) {
    selected.push(p);
    total += p.amount;
    if (total >= target.sats) return selected;
  }
  return selected;
}

/** Add unselected proofs until the input set covers `needed + its own input fee`, or return null when there aren't any. */
function widenSelection(
  candidates: AgentProof[],
  selected: AgentProof[],
  needed: number,
  currentInputFees: number
): { selected: AgentProof[] } | null {
  const chosen = new Set(selected.map((p) => proofKey(p)));
  const rest = candidates.filter((p) => !chosen.has(proofKey(p)));
  if (rest.length === 0) return null;
  const next = [...selected];
  let total = sumSats(next);
  for (const p of rest) {
    if (total >= needed + currentInputFees) break;
    next.push(p);
    total += p.amount;
  }
  return next.length === selected.length ? null : { selected: next };
}

function classifyPreCommitError(mintUrl: string, err: unknown): CashOutMintOutcome {
  if (err instanceof DvmError && err.code === "lnurl_amount_out_of_range") {
    return {
      kind: "skipped",
      mint: mintUrl,
      reason: "amount_out_of_range",
      message: err.message,
    };
  }
  return { kind: "failed", mint: mintUrl, message: errorMessage(err), settlement: "reverted" };
}

function sumSats(proofs: { amount: number }[]): number {
  return proofs.reduce((sum, p) => sum + p.amount, 0);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
