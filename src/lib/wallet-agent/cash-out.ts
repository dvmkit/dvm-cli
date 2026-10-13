/**
 * Cash out one mint at a time without a preparatory swap, including mints in
 * melt-only recovery. Persist selected inputs and blank change outputs before
 * the melt; after an ambiguous failure only the mint can authorize rollback.
 */

import { type MeltPreview, type MeltQuoteBolt11Response, type Wallet } from "@cashu/cashu-ts";

import { meltAmountBounds, type MintAmountBounds } from "@dvmkit/sdk/internal";
import { fetchMeltQuote, getInputFeesForProofs, type MeltQuoteInfo } from "@dvmkit/sdk/internal";
import { getWallet } from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";
import { fetchLnurlPayInvoice } from "@dvmkit/sdk/internal";
import {
  markProofsInFlight,
  meltInFlightTimeoutSeconds,
  proofKey,
  revertInFlight,
  sweepStaleInFlight,
} from "./inflight";
import { serializeOutputData } from "@dvmkit/sdk/internal";
import { toAgentProof, toCashuProofs } from "@dvmkit/sdk/internal";
import {
  type AgentProof,
  loadAgentWallet,
  type PendingMelt,
  saveAgentWallet,
  withWalletLock,
} from "@dvmkit/sdk/internal";

export type CashOutTarget = { kind: "exact"; sats: number } | { kind: "all" };

/**
 * The melt as quoted, before it commits. `amount_sats` is what actually
 * arrives at the destination; the two fee fields are drawn from the wallet on
 * top of it, and `debit_sats` is the proof value committed in total.
 */
export interface CashOutQuote {
  mint: string;
  quote_id: string;
  /** Invoice amount — the sats that land at the destination. */
  amount_sats: number;
  /** Mint-reserved Lightning routing buffer. Whatever routing doesn't use comes back as change. */
  fee_reserve_sats: number;
  /** NUT-12 per-input fee the mint charges for the committed proofs. */
  input_fee_sats: number;
  /** Total proof value committed: `amount + fee_reserve + input_fees`, rounded up to whole proofs. */
  debit_sats: number;
  /** Quote expiry as unix seconds, when the mint supplied one. */
  expires_at: number | null;
}

export type CashOutSkipReason =
  | "no_balance"
  | "fees_exceed_balance"
  | "fee_cap_exceeded"
  | "amount_out_of_range";

/**
 * What happened to the melt at one mint. `failed` carries a `settlement` that
 * says where the committed proofs stand — the difference between "try again"
 * and "don't touch it, the sweep owns this now".
 */
export type CashOutMintOutcome =
  | {
      kind: "sent";
      mint: string;
      quote: CashOutQuote;
      preimage: string | null;
      /** Unused fee reserve the mint handed back, re-locked to the wallet. */
      change_sats: number;
      /**
       * The mint's advertised NUT-05 `max_amount`, set only when it sized this
       * leg below what was asked for. A balance is left behind at
       * this mint when it appears, and the caller should say so.
       */
      mint_max_sats?: number;
    }
  | {
      kind: "quoted";
      mint: string;
      quote: CashOutQuote;
      /** See the `sent` variant — set when the mint's advertised NUT-05 max sized this leg. */
      mint_max_sats?: number;
    }
  | {
      kind: "skipped";
      mint: string;
      reason: CashOutSkipReason;
      message: string;
      quote?: CashOutQuote;
    }
  | {
      kind: "failed";
      mint: string;
      message: string;
      /**
       * `reverted` — the mint confirms the invoice is unpaid and the proofs are
       * back in the spendable balance. `unresolved` — the melt's fate is not
       * established, the `pending_melt` entry stands, and `sweepPendingMelts`
       * settles it on a later run. Never claim the first without asking the mint.
       */
      settlement: "reverted" | "unresolved";
      quote?: CashOutQuote;
    };

export interface CashOutMintOptions {
  /** Mint to melt at. Only proofs issued here are considered. */
  mintUrl: string;
  target: CashOutTarget;
  /** Payee as the operator typed it — a Lightning address or `lnurl1…` string. */
  destination: string;
  /** Refuse the melt when `fee_reserve + input_fees` exceeds this, in sats. */
  maxFeeSats?: number;
  /** Quote and report, then stop without committing. */
  dryRun?: boolean;
  /** Called with the quote before the melt commits — the caller's chance to show the fee. */
  onQuote?: (quote: CashOutQuote) => void;
  now?: () => number;
  getWalletForMint?: (mintUrl: string) => Promise<Wallet>;
  fetchInvoice?: (destination: string, amountMsats: number) => Promise<string>;
  /** Override the melt in-flight window, in seconds. */
  inFlightTimeoutSec?: number;
}

/**
 * Melt free-balance proofs at one mint to a Lightning destination. Returns a
 * structured per-mint outcome rather than throwing for expected conditions
 * (empty mint, fees larger than the balance, a mint that refuses the quote) —
 * a cash-out spanning several mints must not abort because one of them
 * declined.
 *
 * Only proofs the wallet can actually sign are eligible: `status: "valid"` and
 * no `reserved_for` marker. Reserve proofs are locked to a builder's pubkey
 * and belong to `dvm wallet release`, not here.
 */
export async function cashOutFromMint(opts: CashOutMintOptions): Promise<CashOutMintOutcome> {
  const mintUrl = opts.mintUrl;
  const now = opts.now ?? (() => Date.now());
  const getWalletForMint = opts.getWalletForMint ?? getWallet;
  const fetchInvoice = opts.fetchInvoice ?? fetchLnurlPayInvoice;

  const initial = loadAgentWallet();
  if (!initial) {
    throw new DvmError(
      "wallet_missing",
      "No agent wallet found.",
      "Run `dvm wallet init` first to generate a lock keypair."
    );
  }

  const candidates = spendableAt(initial.proofs, mintUrl);
  if (candidates.length === 0) {
    return {
      kind: "skipped",
      mint: mintUrl,
      reason: "no_balance",
      message: `No spendable proofs at ${mintUrl}.`,
    };
  }

  let cashuWallet: Wallet;
  try {
    cashuWallet = await getWalletForMint(mintUrl);
  } catch (err) {
    return { kind: "failed", mint: mintUrl, message: errorMessage(err), settlement: "reverted" };
  }

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

  const quoteView: CashOutQuote = {
    mint: mintUrl,
    quote_id: quote.rawQuote.quote,
    amount_sats: quote.amountSats,
    fee_reserve_sats: quote.feeReserveSats,
    input_fee_sats: inputFees,
    debit_sats: selectedTotal,
    expires_at: typeof quote.rawQuote.expiry === "number" ? quote.rawQuote.expiry : null,
  };

  const totalFees = quote.feeReserveSats + inputFees;
  if (opts.maxFeeSats !== undefined && totalFees > opts.maxFeeSats) {
    return {
      kind: "skipped",
      mint: mintUrl,
      reason: "fee_cap_exceeded",
      message: `Fees at ${mintUrl} would be up to ${totalFees} sats, over the ${opts.maxFeeSats} sat cap.`,
      quote: quoteView,
    };
  }

  opts.onQuote?.(quoteView);
  if (opts.dryRun) {
    return {
      kind: "quoted",
      mint: mintUrl,
      quote: quoteView,
      ...(cappedByMintMax !== undefined ? { mint_max_sats: cappedByMintMax } : {}),
    };
  }

  // Blank outputs for the mint's change, built before anything is committed.
  // `.asP2PK` locks that change to the wallet's own pubkey so it stays
  // spendable; `.privkey` signs the NUT-11 witnesses on the inputs. The key
  // never leaves this process.
  let preview: MeltPreview<MeltQuoteBolt11Response>;
  try {
    preview = await cashuWallet.ops
      .meltBolt11(quote.rawQuote, toCashuProofs(selected))
      .asP2PK({ pubkey: initial.lock_pubkey })
      .privkey(initial.lock_privkey)
      .prepare();
  } catch (err) {
    return {
      kind: "failed",
      mint: mintUrl,
      message: errorMessage(err),
      settlement: "reverted",
      quote: quoteView,
    };
  }

  const untilMs = now() + (opts.inFlightTimeoutSec ?? meltInFlightTimeoutSeconds()) * 1000;
  const selectedKeys = new Set(selected.map((p) => proofKey(p)));
  const entry: PendingMelt = {
    mint: mintUrl,
    quote_id: quote.rawQuote.quote,
    bolt11: invoice,
    destination: opts.destination,
    amount_sats: quote.amountSats,
    fee_reserve_sats: quote.feeReserveSats,
    input_fee_sats: inputFees,
    input_proofs: selected,
    melting: {
      keyset_id: preview.keysetId,
      outputs: serializeOutputData(preview.outputData),
    },
    created_at: new Date(now()).toISOString(),
    ...(quoteView.expires_at !== null ? { expires_at: quoteView.expires_at } : {}),
  };

  // Persist before the mint call. A crash from here on leaves an entry the
  // sweep can reconcile against the mint; a crash before it leaves proofs that
  // were never committed to anything.
  const committed = await withWalletLock(() => {
    const fresh = loadAgentWallet();
    if (!fresh) return false;
    const swept = sweepStaleInFlight(fresh, now());
    const available = new Set(spendableAt(swept.wallet.proofs, mintUrl).map((p) => proofKey(p)));
    if (![...selectedKeys].every((k) => available.has(k))) {
      // Another process moved these proofs between selection and here. Bail
      // before the melt rather than committing proofs we no longer own.
      if (swept.reverted > 0) saveAgentWallet(swept.wallet);
      return false;
    }
    const marked = markProofsInFlight(swept.wallet, selectedKeys, untilMs);
    saveAgentWallet({ ...marked, pending_melts: [...marked.pending_melts, entry] });
    return true;
  });
  if (!committed) {
    return {
      kind: "failed",
      mint: mintUrl,
      message: `Proofs at ${mintUrl} changed underneath the melt (another dvm run may have spent them). Nothing was sent.`,
      settlement: "reverted",
      quote: quoteView,
    };
  }

  let change;
  let preimage: string | null;
  try {
    const result = await cashuWallet.completeMelt(preview, initial.lock_privkey);
    change = result.change;
    preimage = result.quote.payment_preimage ?? null;
  } catch (err) {
    return resolveFailedMelt(cashuWallet, mintUrl, entry, selectedKeys, quoteView, err);
  }

  const changeProofs = change.map((p) => toAgentProof(p, mintUrl, initial.lock_pubkey));
  await withWalletLock(() => {
    const fresh = loadAgentWallet();
    if (!fresh) return;
    saveAgentWallet({
      ...fresh,
      proofs: [...fresh.proofs.filter((p) => !selectedKeys.has(proofKey(p))), ...changeProofs],
      pending_melts: fresh.pending_melts.filter((m) => m.quote_id !== entry.quote_id),
    });
  });

  return {
    kind: "sent",
    mint: mintUrl,
    quote: quoteView,
    preimage,
    change_sats: sumSats(changeProofs),
    ...(cappedByMintMax !== undefined ? { mint_max_sats: cappedByMintMax } : {}),
  };
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

export function spendableAt(proofs: AgentProof[], mintUrl: string): AgentProof[] {
  return proofs
    .filter((p) => p.mint === mintUrl && p.status === "valid" && p.reserved_for === undefined)
    .slice()
    .sort((a, b) => b.amount - a.amount);
}

/**
 * A melt threw. The mint is the only authority on whether the invoice was
 * paid, so ask it before touching the committed proofs: `UNPAID` means nothing
 * moved and the balance goes back; anything else — including a mint we can no
 * longer reach — leaves the entry standing for `sweepPendingMelts`.
 */
async function resolveFailedMelt(
  cashuWallet: Wallet,
  mintUrl: string,
  entry: PendingMelt,
  selectedKeys: Set<string>,
  quoteView: CashOutQuote,
  err: unknown
): Promise<CashOutMintOutcome> {
  let unpaid: boolean;
  try {
    const state = await cashuWallet.checkMeltQuoteBolt11(entry.quote_id);
    unpaid = state.state === "UNPAID";
  } catch {
    // Can't reach the mint to ask. Assume the worst — the melt may have landed.
    unpaid = false;
  }

  if (!unpaid) {
    return {
      kind: "failed",
      mint: mintUrl,
      message: `${errorMessage(err)} — ${entry.amount_sats} sats may still be in flight at ${mintUrl}. Run \`dvm wallet show\` to reconcile before retrying.`,
      settlement: "unresolved",
      quote: quoteView,
    };
  }

  await withWalletLock(() => {
    const fresh = loadAgentWallet();
    if (!fresh) return;
    const reverted = revertInFlight(fresh, selectedKeys);
    saveAgentWallet({
      ...reverted,
      pending_melts: reverted.pending_melts.filter((m) => m.quote_id !== entry.quote_id),
    });
  });

  return {
    kind: "failed",
    mint: mintUrl,
    message: `${errorMessage(err)} — the mint confirms the invoice is unpaid, so the ${quoteView.debit_sats} sats are back in the wallet.`,
    settlement: "reverted",
    quote: quoteView,
  };
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
