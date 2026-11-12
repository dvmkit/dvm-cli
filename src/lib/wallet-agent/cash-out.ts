/**
 * Cash out one mint at a time without a preparatory swap, including mints in
 * melt-only recovery. Persist selected inputs and blank change outputs before
 * the melt; after an ambiguous failure only the mint can authorize rollback.
 */

import { type MeltPreview, type MeltQuoteBolt11Response, type Wallet } from "@cashu/cashu-ts";

import { getWallet } from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";
import { assertInvoiceNotPending, invoiceAmountSats } from "./invoice";
import { prepareCashOut } from "./cash-out-prepare";
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
  | "amount_out_of_range"
  | "quote_amount_mismatch"
  | "quote_expired";

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
  /** A fixed invoice; never resize or resolve it through LNURL. */
  bolt11?: string;
  /** Payee as the operator typed it — an address, `lnurl1…` string, or invoice. */
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

  const initial = loadAgentWallet();
  if (!initial) {
    throw new DvmError(
      "wallet_missing",
      "No agent wallet found.",
      "Run `dvm wallet init` first to generate a lock keypair."
    );
  }

  if (opts.bolt11) assertInvoiceNotPending(initial, opts.bolt11);

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

  const prepared = await prepareCashOut(opts, candidates, cashuWallet);
  if ("kind" in prepared) return prepared;
  const { invoice, quote, selected, selectedTotal, inputFees, cappedByMintMax } = prepared;

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
      message: `Fees at ${mintUrl} would be up to ${totalFees} sats, over the ${opts.maxFeeSats} sat cap.${opts.bolt11 ? " No money moved. Run `dvm wallet cash-out <invoice> --max-fee <sats>` with a sufficient cap if you accept these fees." : ""}`,
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
    if (opts.bolt11) {
      assertInvoiceNotPending(fresh, opts.bolt11);
      invoiceAmountSats(opts.bolt11, now());
    }
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

function sumSats(proofs: { amount: number }[]): number {
  return proofs.reduce((sum, p) => sum + p.amount, 0);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
