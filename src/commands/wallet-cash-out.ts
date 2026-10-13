/**
 * `dvm wallet cash-out <ln-address>` — move value out of the agent wallet to a
 * Lightning address the operator controls.
 *
 * The mint operation this uses (NUT-05 melt)
 * is also the one a mint in recovery keeps serving after it has stopped
 * issuing, so this is frequently the only way to move a balance at all.
 *
 * The command is the multi-mint driver; the per-mint melt engine is
 * the SDK's wallet-agent cash-out engine. Each Cashu mint is a separate custodial
 * issuer, so a balance spanning mints cashes out as N Lightning payments, and
 * every mint reports its own outcome — one mint refusing does not fail the
 * command.
 */

import {
  type AgentWallet,
  DvmError,
  effectiveMints,
  loadAgentWallet,
  validateLnAddress,
} from "@dvmkit/sdk/internal";
import {
  info,
  json,
} from "../lib/output";
import {
  cashOutFromMint,
  type CashOutMintOutcome,
  type CashOutQuote,
  spendableAt,
} from "../lib/wallet-agent/cash-out";
import { loadConfiguredMints } from "../lib/wallet-agent/mint-inventory";
import { sweepPendingMelts } from "../lib/wallet-agent/recovery-melt";
import { sweepPendingMints } from "../lib/wallet-agent/recovery";

import {
  amountSourceFields,
  describeAmount,
  resolveFundingAmountSats,
} from "../lib/wallet-agent/amount";

export interface WalletCashOutOptions {
  /**
   * How much should arrive at the destination. Accepts sats (`1000`) or fiat
   * (`$5`, `£5`, `5eur`), same grammar as `dvm wallet fund`. Fees are drawn
   * from the wallet on top of this — the number is what the payee receives.
   */
  amount?: string;
  /** Treat the amount as sats even if it doesn't lead with a currency marker. */
  sats?: boolean;
  /** Empty the wallet (or the `--mint` mint) — fees come out of the balance. */
  all?: boolean;
  mint?: string;
  /** Refuse a mint whose routing reserve + input fee would exceed this many sats. */
  maxFee?: string;
  /** Quote and report the fee, then stop without paying anything. */
  dryRun?: boolean;
  human?: boolean;
}

/**
 * Melt agent-wallet proofs to a Lightning address or `lnurl1…` string.
 *
 * Mint order is largest balance first, so the fewest Lightning payments cover
 * the request. With `--amount`, each mint contributes what it can and the
 * driver moves on until the requested amount is covered; with `--all`, every
 * mint (or the one named by `--mint`) is emptied.
 */
export async function walletCashOut(
  destination: string,
  opts: WalletCashOutOptions
): Promise<void> {
  const human = opts.human ?? false;

  if ((opts.amount === undefined) === (opts.all !== true)) {
    throw new DvmError(
      "invalid_flags",
      "Pass exactly one of --amount <amount> or --all.",
      "`--amount 1000` sends 1000 sats and draws the fees on top; `--all` empties the wallet, with fees coming out of the balance."
    );
  }

  await loadConfiguredMints();
  const wallet = loadAgentWallet();
  if (!wallet) {
    throw new DvmError(
      "wallet_missing",
      "No agent wallet found.",
      "Run `dvm wallet init` first to generate a lock keypair."
    );
  }

  // Reconcile anything a previous run left in motion before reading balances —
  // a cash-out sized against proofs another melt already committed would be
  // refused by the mint at best.
  await sweepPendingMints().catch(() => undefined);
  await sweepPendingMelts().catch(() => undefined);
  const fresh = loadAgentWallet() ?? wallet;

  const requested = opts.amount ? await resolveFundingAmountSats(opts.amount, opts.sats) : null;
  const maxFeeSats = parseMaxFee(opts.maxFee);

  // Fail on a typo'd destination before any proof is committed. LNURL-pay
  // metadata is a cheap GET; a melt quote is not.
  await validateLnAddress(destination);

  const mints = resolveMints(fresh, opts.mint);
  if (mints.length === 0) {
    throw new DvmError(
      "no_spendable_balance",
      opts.mint
        ? `No spendable balance at ${opts.mint}.`
        : "The agent wallet holds no spendable Cashu balance.",
      "Check what's there with `dvm wallet show`. Reserve proofs are excluded — reclaim those with `dvm wallet release` first."
    );
  }

  if (human) {
    const what = requested ? describeAmount(requested) : "everything";
    info(
      `Cashing out ${what} to ${destination} across ${mints.length} mint(s)${opts.dryRun ? " (dry run — nothing will be paid)" : ""}…`
    );
  }

  const outcomes: CashOutMintOutcome[] = [];
  let remaining = requested?.sats ?? 0;
  for (const mintUrl of mints) {
    if (requested && remaining <= 0) break;
    const outcome = await cashOutFromMint({
      mintUrl,
      target: requested ? { kind: "exact", sats: remaining } : { kind: "all" },
      destination,
      maxFeeSats,
      dryRun: opts.dryRun,
      onQuote: (quote) => {
        emitQuote(quote, destination, human);
      },
    });
    outcomes.push(outcome);
    if (requested && (outcome.kind === "sent" || outcome.kind === "quoted")) {
      remaining -= outcome.quote.amount_sats;
    }
  }

  const sentSats = outcomes.reduce(
    (sum, o) => sum + (o.kind === "sent" ? o.quote.amount_sats : 0),
    0
  );
  // What the cash-out actually cost: the committed proof value, less what
  // arrived and less the change the mint handed back. `debit_sats` is the whole
  // input set — on a widened selection most of it returns as change, so
  // `debit - amount` would report a fee several times the real one, and this is
  // the number an agent relays.
  const feeSats = outcomes.reduce((sum, o) => sum + (o.kind === "sent" ? netFeeSats(o) : 0), 0);
  const changeSats = outcomes.reduce((sum, o) => sum + (o.kind === "sent" ? o.change_sats : 0), 0);
  const quotedSats = outcomes.reduce(
    (sum, o) => sum + (o.kind === "quoted" ? o.quote.amount_sats : 0),
    0
  );
  const unresolved = outcomes.filter((o) => o.kind === "failed" && o.settlement === "unresolved");
  const shortfall = requested && remaining > 0 ? remaining : 0;
  // A mint's per-melt cap only leaves the caller short of what they asked for
  // under `--all`, or when the other mints didn't cover the rest. With
  // `--amount` satisfied elsewhere, the balance left behind is money they never
  // asked to move — telling them to re-run would send more than requested.
  const moreToSend = opts.all === true || shortfall > 0;
  const rows = outcomes.map((o) => toRow(o, moreToSend));

  const status = opts.dryRun ? "quoted" : sentSats > 0 ? "cashed_out" : "nothing_sent";
  const display = opts.dryRun
    ? `Quoted ${quotedSats} sats to ${destination} across ${rows.length} mint(s). Nothing was paid.`
    : sentSats > 0
      ? `Sent ${sentSats} sats to ${destination}${feeSats > 0 ? `, plus ${feeSats} sats in fees` : ""}${shortfall > 0 ? ` — ${shortfall} sats short of what you asked for` : ""}.`
      : `Nothing was sent to ${destination}.`;
  const cappedCount = moreToSend ? rows.filter((r) => r.mint_max_sats !== undefined).length : 0;
  const hint = buildHint({
    unresolvedCount: unresolved.length,
    shortfall,
    cappedCount,
    dryRun: opts.dryRun,
  });

  if (human) {
    info("");
    for (const row of rows) {
      info(`  ${row.display}`);
    }
    info("");
    info(display);
    info(hint);
  } else {
    json({
      status,
      destination,
      ...(requested ? amountSourceFields(requested) : { source_currency: "sats" }),
      requested_sats: requested?.sats ?? null,
      sats_sent: sentSats,
      fee_sats: feeSats,
      change_sats: changeSats,
      shortfall_sats: shortfall,
      mints: rows,
      display,
      hint,
    });
  }

  // Exit non-zero when the operator asked to move money and none moved — the
  // per-mint report above is already on stdout, so the error line adds the exit
  // code without swallowing the detail.
  if (!opts.dryRun && sentSats === 0) {
    throw new DvmError(
      "cash_out_failed",
      `No mint could pay ${destination}.`,
      unresolved.length > 0
        ? "At least one melt's outcome is unknown — run `dvm wallet show` to reconcile it against the mint before retrying."
        : "See the per-mint reasons above. `dvm wallet mint-health` reports whether a mint is currently able to melt."
    );
  }
}

interface CashOutRow {
  mint: string;
  status: CashOutMintOutcome["kind"];
  sats_sent: number;
  fee_reserve_sats: number | null;
  input_fee_sats: number | null;
  debit_sats: number | null;
  change_sats: number | null;
  preimage: string | null;
  /** Present on `failed`: whether the committed proofs came back or are still in play. */
  settlement?: "reverted" | "unresolved";
  reason?: string;
  /**
   * The mint's advertised NUT-05 per-melt maximum, present only when it sized
   * this leg below what was asked for. A balance is left at this
   * mint when it appears; whether that balance is still owed to the caller
   * depends on the mode, which is what `shortfall_sats` reports.
   */
  mint_max_sats?: number;
  error: string | null;
  display: string;
}

/**
 * What a settled melt actually cost. `debit_sats` is the whole committed input
 * set, and on a widened selection most of it comes straight back as change —
 * so the fee is what neither arrived at the destination nor returned to the
 * wallet. This is the headline number an agent relays; both the per-mint row
 * and the summary read it from here so they can't drift apart.
 */
function netFeeSats(outcome: Extract<CashOutMintOutcome, { kind: "sent" }>): number {
  return outcome.quote.debit_sats - outcome.quote.amount_sats - outcome.change_sats;
}

/**
 * Say when a mint's own per-melt ceiling — not the balance, not the fees —
 * decided the size of this leg, because the leftover sitting at that mint would
 * otherwise look like money that went missing.
 *
 * `moreToSend` is what turns that into an instruction. Under `--all`, or when
 * the other mints left the request short, re-running moves the next chunk; when
 * `--amount` was already covered elsewhere, re-running would send money the
 * caller never asked for, so the note stays a statement of fact.
 */
function capNote(mintMaxSats: number | undefined, moreToSend: boolean): string {
  if (mintMaxSats === undefined) return "";
  const cap = `This mint caps a single cash-out at ${mintMaxSats} sats`;
  return moreToSend
    ? ` ${cap}, so the rest of its balance stays put — run the command again to send the next chunk.`
    : ` ${cap}, so this leg was sized to that cap; the rest of its balance stays in the wallet.`;
}

function toRow(outcome: CashOutMintOutcome, moreToSend: boolean): CashOutRow {
  const base = {
    mint: outcome.mint,
    status: outcome.kind,
    sats_sent: 0,
    fee_reserve_sats: null as number | null,
    input_fee_sats: null as number | null,
    debit_sats: null as number | null,
    change_sats: null as number | null,
    preimage: null as string | null,
    error: null as string | null,
  };

  switch (outcome.kind) {
    case "sent":
      return {
        ...base,
        sats_sent: outcome.quote.amount_sats,
        fee_reserve_sats: outcome.quote.fee_reserve_sats,
        input_fee_sats: outcome.quote.input_fee_sats,
        debit_sats: outcome.quote.debit_sats,
        change_sats: outcome.change_sats,
        preimage: outcome.preimage,
        ...(outcome.mint_max_sats !== undefined ? { mint_max_sats: outcome.mint_max_sats } : {}),
        display: `${outcome.mint}: sent ${outcome.quote.amount_sats} sats (${netFeeSats(outcome)} sats in fees).${capNote(outcome.mint_max_sats, moreToSend)}`,
      };
    case "quoted":
      return {
        ...base,
        fee_reserve_sats: outcome.quote.fee_reserve_sats,
        input_fee_sats: outcome.quote.input_fee_sats,
        debit_sats: outcome.quote.debit_sats,
        ...(outcome.mint_max_sats !== undefined ? { mint_max_sats: outcome.mint_max_sats } : {}),
        // A dry run sent nothing, so "run it again" would be the wrong advice
        // whatever the mode — the cap is reported as fact and the summary hint
        // already says to re-run without --dry-run.
        display: `${outcome.mint}: would send ${outcome.quote.amount_sats} sats for up to ${outcome.quote.fee_reserve_sats + outcome.quote.input_fee_sats} sats in fees.${capNote(outcome.mint_max_sats, false)}`,
      };
    case "skipped":
      return {
        ...base,
        reason: outcome.reason,
        fee_reserve_sats: outcome.quote?.fee_reserve_sats ?? null,
        input_fee_sats: outcome.quote?.input_fee_sats ?? null,
        display: `${outcome.mint}: skipped — ${outcome.message}`,
      };
    case "failed":
      return {
        ...base,
        settlement: outcome.settlement,
        error: outcome.message,
        display: `${outcome.mint}: failed — ${outcome.message}`,
      };
  }
}

/**
 * Show the fee before the melt commits. Fees are drawn on top of a stated
 * amount, so the operator sees the full debit rather than discovering it in
 * the balance afterwards.
 */
function emitQuote(quote: CashOutQuote, destination: string, human: boolean): void {
  const fees = quote.fee_reserve_sats + quote.input_fee_sats;
  const display = `${quote.mint}: sending ${quote.amount_sats} sats to ${destination} costs up to ${fees} sats in fees (${quote.fee_reserve_sats} routing reserve + ${quote.input_fee_sats} mint input fee), debiting up to ${quote.debit_sats} sats. Unused routing reserve comes back.`;
  if (human) {
    info(display);
  } else {
    json({
      status: "cash_out_quote",
      mint: quote.mint,
      quote_id: quote.quote_id,
      destination,
      amount_sats: quote.amount_sats,
      fee_reserve_sats: quote.fee_reserve_sats,
      input_fee_sats: quote.input_fee_sats,
      debit_sats: quote.debit_sats,
      expires_at: quote.expires_at,
      display,
    });
  }
}

/**
 * Mints to draw from, richest first — fewest Lightning payments for the
 * requested amount. An explicit `--mint` wins outright, including a mint the
 * wallet holds nothing at (the engine reports the empty balance per-mint
 * rather than the driver second-guessing the operator).
 */
function resolveMints(wallet: AgentWallet, explicit: string | undefined): string[] {
  if (explicit !== undefined) {
    return spendableAt(wallet.proofs, explicit).length > 0 ? [explicit] : [];
  }
  const candidates = new Set([...effectiveMints(wallet), ...wallet.proofs.map((p) => p.mint)]);
  return [...candidates]
    .map((url) => ({ url, sats: sumSats(spendableAt(wallet.proofs, url)) }))
    .filter((m) => m.sats > 0)
    .sort((a, b) => b.sats - a.sats || a.url.localeCompare(b.url))
    .map((m) => m.url);
}

function buildHint(args: {
  unresolvedCount: number;
  shortfall: number;
  cappedCount: number;
  dryRun?: boolean;
}): string {
  if (args.unresolvedCount > 0) {
    return "At least one melt's outcome is unknown — those sats stay committed until `dvm wallet show` reconciles them against the mint. Don't retry that mint until it does.";
  }
  if (args.dryRun) {
    return "Re-run without --dry-run to send. Quotes expire, so the fee is re-quoted at that point.";
  }
  // A capped leg is the one case where money still owed is left behind on a run
  // that otherwise succeeded outright — say to run it again, or it reads as
  // done. The caller counts only the legs that fell short of the request.
  if (args.cappedCount > 0) {
    return "At least one mint caps how much a single cash-out can move, so a balance is still sitting there — run the command again to send the next chunk.";
  }
  if (args.shortfall > 0) {
    return "The wallet's mints couldn't cover the full amount — `dvm wallet show` breaks the balance down per mint.";
  }
  return "Confirm the remaining balance with `dvm wallet show`.";
}

function parseMaxFee(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new DvmError(
      "invalid_max_fee",
      `Invalid --max-fee value: "${raw}".`,
      "Pass a non-negative integer number of sats, e.g. --max-fee 20."
    );
  }
  return Math.floor(n);
}

function sumSats(proofs: { amount: number }[]): number {
  return proofs.reduce((sum, p) => sum + p.amount, 0);
}
