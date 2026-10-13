/**
 * `dvm wallet fund` and `dvm wallet show`. The fund flow lifts
 * Lightning into NUT-11 P2PK-locked Cashu proofs at the configured mint;
 * the show flow surfaces balance, recent spends, and per-mint fee profile.
 * Both commands sweep `pending_mints[]` first so a CLI crash mid-fund is
 * recovered transparently before the user sees stale state.
 */

import {
  amountBoundsVerdict,
  chainIdFromCaip2,
  DvmError,
  effectiveFundingMint,
  effectiveMints,
  ensureAddress,
  generateX402PrivateKey,
  loadAgentWallet,
  type MintHealthCheckResult,
  type PendingMint,
  receiveToAgentWallet,
  resolveTempoAsset,
  resolveTempoNetwork,
  resolveX402Asset,
  saveAgentWallet,
  type TempoAccount,
  withWalletLock,
  withX402ChannelLock,
  X402_DEFAULT_NETWORK,
} from "@dvmkit/sdk/internal";
import {
  connectedTempoAccount,
  generateTempoKey,
  tempoWrongAssetHint,
} from "../lib/payment-rails/tempo-wallet";
import {
  info,
  json,
} from "../lib/output";
import {
  loadConfig,
} from "../lib/identity";
import {
  loadX402Wallet,
  saveX402Wallet,
} from "../lib/x402/wallet";
import {
  buildDisplayMintInventory,
  loadConfiguredMints,
  type MintSource,
} from "../lib/wallet-agent/mint-inventory";
import { describeMintBounds, resolveFundMint } from "../lib/wallet-agent/mint-selection";
import { sweepPendingSubmissions } from "../lib/wallet-agent/recovery-submissions";
import { sweepStaleInFlight } from "../lib/wallet-agent/inflight";
import {
  assertFloatBudget,
  type FloatPayment,
  floatPaymentDisplay,
  floatPaymentJson,
  loadFloat,
  payViaFloat,
  recordFloatSpend,
  unrecordedFloatBudgetWarning,
} from "../lib/float";

import {
  buildErc681TokenTransferUri,
  parseStablecoinAmount,
  prepareStablecoinFundingHandoff,
  printStablecoinFundingHandoff,
  stablecoinFundingHandoffJson,
} from "../lib/funding-handoff";
import { dvmFetch } from "../lib/http";
import { defaultQrImagePath, renderQrPng, renderQrTerminal } from "../lib/qr";
import { getSpotRate } from "../lib/spot-rate";
import { fundTempoFromFaucet } from "../lib/tempo-faucet";
import { tempoAccountNetwork, tempoNetworkLabel } from "../lib/tempo-network";
import { getVerifiedTempoBalance } from "../lib/tempo-rpc";
import {
  amountSourceFields,
  describeAmount,
  resolveFundingAmountSats,
} from "../lib/wallet-agent/amount";
import { loadMintFeeProfiles, summarizeMints } from "../lib/wallet-agent/balance";
import { fundWithRecoverableWait } from "../lib/wallet-agent/fund-wait";
import {
  reconcilePendingMelts,
  type MeltReconcileResult,
} from "../lib/wallet-agent/melt-sweep";
import {
  reconcilePendingMints,
  type ReconcileResult,
  type UncheckedMint,
  uncheckedPendingNote,
} from "../lib/wallet-agent/mint-sweep";
import {
  describePendingSubmissions,
  describeReclaimedSubmissions,
  describeResumedSubmissions,
  describeSkippedReclaims,
  describeUnresolvedSubmissions,
  formatPendingSubmission,
} from "../lib/wallet-agent/submissions-view";

/**
 * Relayable warning surfaced by `dvm wallet show` when a balance spans more
 * than one Cashu mint. Each mint is a separate custodial issuer and
 * spend selection draws from a single mint per payment, so the aggregate total
 * is not a combined spendable pot.
 */
const NON_FUNGIBLE_MINT_NOTE =
  "Balances are per-mint: each mint is a separate custodial issuer and a single payment draws from one mint only — not a combined spendable pot.";

export interface WalletFundOptions {
  /** Treat the positional amount as sats even if it doesn't lead with `$`. */
  sats?: boolean;
  /** Override the mint URL for this fund call (Cashu only). */
  mint?: string;
  /** Override the fund timeout, in seconds. */
  timeout?: string;
  human?: boolean;
  /**
   * Which rail to fund. `cashu` (default) lifts Lightning into P2PK-locked
   * Cashu proofs. `tempo` and `x402` create an address handoff for an
   * out-of-band stablecoin deposit.
   */
  rail?: string;
  /**
   * Skip Lightning — for test mints (e.g. the local FakeWallet mint) that
   * auto-settle their own invoices. Cashu rail only. Suppresses the
   * "pay this invoice" prompt; the proofs still mint once the mint settles.
   */
  testSkipLightning?: boolean;
  /**
   * Write the funding QR PNG to this path instead of an OS-tmpdir default. In
   * JSON mode a PNG is always generated; in `--human` mode it is only written
   * when this flag is set (the terminal QR is always rendered for humans).
   */
  qrImage?: string;
  /**
   * Set to `false` via commander's `--no-float` to relay the invoice for a
   * human to pay even when a Lightning float is connected. Defaults
   * to `true`, which is what makes funding autonomous.
   */
  float?: boolean;
}

export interface WalletShowOptions {
  human?: boolean;
}

/**
 * Lift sats from Lightning into Cashu proofs P2PK-locked to the agent
 * wallet's lock pubkey. Persists `pending_mints[]` before payment is
 * observed so a crash mid-flow is recoverable on the next run.
 *
 * With `--rail tempo`, routes to {@link fundTempoRail} instead:
 * generates a fresh EVM keypair if none is connected, persists it, and
 * surfaces the deposit address + USD target so the user can fund out-of-band.
 */
export async function walletFund(amount: string, opts: WalletFundOptions): Promise<void> {
  const rail = (opts.rail ?? "cashu").toLowerCase();
  if (rail === "tempo" || rail === "x402") {
    if (
      opts.mint !== undefined ||
      opts.timeout !== undefined ||
      opts.sats ||
      opts.testSkipLightning ||
      opts.float === false
    ) {
      throw new DvmError(
        "invalid_flags_for_rail",
        "--mint, --timeout, --sats, --test-skip-lightning, and --no-float only apply to --rail cashu.",
        `Drop these flags when running \`dvm wallet fund --rail ${rail}\`.`
      );
    }
    if (rail === "tempo") await fundTempoRail(amount, opts);
    else await fundX402Rail(amount, opts);
    return;
  }
  if (rail !== "cashu") {
    throw new DvmError(
      "invalid_rail",
      `Unknown rail: ${rail}.`,
      "Supported rails: cashu (default), tempo, x402."
    );
  }

  // Trigger any one-shot legacy `config.cashuMints` migration before reading
  // `wallet.mints` so a legacy user's chosen mint flows into the fund pick
  // instead of being clobbered by the implicit default.
  await loadConfiguredMints();

  const wallet = loadAgentWallet();
  if (!wallet) {
    throw new DvmError(
      "wallet_missing",
      "No agent wallet found.",
      "Run `dvm wallet init` first to generate a lock keypair."
    );
  }

  // Sweep first — catches a crash from the prior run before we open another
  // flow. Melts sweep too: a cash-out the mint never confirmed is money in
  // motion, and funding on top of an unreconciled one hides it.
  const sweep = await reconcilePendingMints();
  const meltSweep = await reconcilePendingMelts().catch(emptyMeltSweep);
  const funding = effectiveFundingMint(wallet.mints);
  const preferredMint = opts.mint ?? funding.url;
  const amt = await resolveFundingAmountSats(amount, opts.sats);
  const sats = amt.sats;
  const amountPhrase = describeAmount(amt);
  const timeoutMs = parseTimeout(opts.timeout);

  const human = opts.human ?? false;

  // A connected float turns funding autonomous. Resolve it before the mint
  // quote exists so the CLI knows which story it's telling, and check the
  // spend against the local caps *before* opening a quote — a cap refusal
  // should leave no pending state behind.
  const float = opts.float === false || opts.testSkipLightning ? null : loadFloat();
  const btcRate = float ? await assertFloatBudget(sats * 1000) : null;
  /** Set once the float path opens a quote, so the ledger row can name it. */
  let fundedQuoteId: string | undefined;

  // probe the preferred mint before committing the Lightning quote.
  // With `--mint`, an unhealthy explicit choice is an error (with alternatives
  // in the hint). Without `--mint`, fall back to the next healthy mint from
  // the wallet's configured list so an outage on the default doesn't strand
  // an agent mid-fund. Either branch surfaces the substitution to the caller.
  const selection = await resolveFundMint({
    preferred: preferredMint,
    explicit: opts.mint !== undefined,
    configured: effectiveMints(wallet),
    sats,
  });
  const mintUrl = selection.url;

  if (selection.fallback) {
    const { preferred, selected, reason } = selection.fallback;
    const phrase = describeFundRefusal(preferred, reason, sats, selection.preferredProbe);
    if (human) {
      info(`Preferred mint ${phrase} — falling back to ${selected}.`);
    } else {
      json({
        status: "fallback_mint",
        preferred,
        selected,
        reason,
        amount_sats: sats,
        display: `Preferred mint ${phrase}; using ${selected}.`,
      });
    }
  }
  if (opts.mint !== undefined) {
    warnIfOutOfBounds(preferredMint, sats, selection.preferredProbe, human);
  }

  // Why this mint was picked, so the output names it unambiguously:
  // a substitution overrides everything (and says whether the preferred mint
  // was down or just not issuing); otherwise an explicit `--mint`; otherwise
  // the funding default's provenance (first configured vs built-in).
  const mintSelection: MintSelection =
    selection.fallbackKind === "capability"
      ? "capability_fallback"
      : selection.fallbackKind === "bounds"
        ? "bounds_fallback"
        : selection.fallbackKind === "health"
          ? "health_fallback"
          : opts.mint !== undefined
            ? "explicit"
            : funding.source;
  const selectionPhrase = describeMintSelection(mintSelection);

  if (human) {
    if (sweep.recovered_proofs.length > 0) {
      const recovered = sweep.recovered_proofs.reduce((sum, p) => sum + p.amount, 0);
      info(
        `Recovered ${recovered} sats from ${sweep.recovered_proofs.length} pending mint(s) before this run.`
      );
    }
    reportUncheckedMints(sweep.unchecked);
    reportUncheckedMints(meltSweep.unchecked);
    if (meltSweep.settled_sats > 0) {
      info(`Confirmed ${meltSweep.settled_sats} sats cashed out to Lightning before this run.`);
    }
    if (meltSweep.returned_sats > 0) {
      info(
        `An earlier cash-out never paid — ${meltSweep.returned_sats} sats are back in the spendable balance.`
      );
    }
    info(`Funding ${amountPhrase} at ${mintUrl} (${selectionPhrase})…`);
    if (opts.testSkipLightning) {
      info("Test mode — waiting for mint to auto-pay invoice…");
    } else if (float) {
      info(`Paying from your Lightning wallet${float.alias ? ` (${float.alias})` : ""}…`);
    }
  }

  const result = await fundWithRecoverableWait(sats, {
    mintUrl,
    timeoutMs,
    testSkipLightning: opts.testSkipLightning,
    payInvoice: float
      ? async (invoice, quote) => {
          fundedQuoteId = quote.quote;
          const expiresAt =
            quote.expiry !== null ? new Date(quote.expiry * 1000).toISOString() : null;
          if (!human) {
            const budgetWarning = unrecordedFloatBudgetWarning(float);
            json({
              status: "float_paying",
              mint: mintUrl,
              amount_sats: sats,
              ...amountSourceFields(amt),
              wallet: float.alias ?? null,
              principal_sats: sats,
              routing_fee_ceiling_sats: null,
              ...(budgetWarning ? { warning: budgetWarning } : {}),
              expires_at: expiresAt,
              display: `Paying ${sats} sats from your Lightning wallet to fund ${amountPhrase} into the agent wallet at ${mintUrl}. No action needed.`,
              hint: "dvm checks this invoice principal against its local budget. The wallet controls route selection, any connection budget, and the routing fee; NIP-47 carries no caller-supplied fee ceiling.",
            });
          } else {
            const budgetWarning = unrecordedFloatBudgetWarning(float);
            if (budgetWarning) info(`Warning: ${budgetWarning}`);
          }
          return payViaFloat({ bolt11: invoice, amountMsats: sats * 1000, float });
        }
      : undefined,
    onFloatPayment: (payment) => {
      // Record against the shared spend ledger only once the money has actually
      // left the wallet. `btcRate` is the rate the cap check above priced with,
      // so the check and the debit can't disagree.
      //
      // Deliberate gap: a `float_payment_unknown` never reaches here, so a
      // top-up that *did* settle after a lost response goes unrecorded and the
      // local caps under-count it. That's the lesser error — recording a spend
      // that may never have happened would over-count every network blip, and
      // the caps would then refuse funding the wallet never paid for. The
      // the error tells the caller to check the wallet's history, which is the
      // only authoritative record of whether it moved. The recorded wallet
      // policy cannot fill that gap: NIP-47 does not say whether it counts fees.
      recordFloatSpend({
        principalMsats: payment.principalMsats,
        routingFeeMsats: payment.routingFeeMsats,
        totalWalletFeeMsats: payment.totalWalletFeeMsats,
        unitemizedWalletFeeMsats: payment.unitemizedWalletFeeMsats,
        walletDebitMsats: payment.walletDebitMsats,
        btcRate: btcRate ?? 0,
        // The mint quote is the unique handle for this top-up — the same id
        // `wallet show` reports for a pending mint, so a ledger row and a
        // stuck quote can be matched up by eye.
        reference: fundedQuoteId ?? `float:${mintUrl}`,
        counterparty: mintUrl,
        label: `float top-up · ${mintUrl}`,
      });
      if (human) {
        info(
          `Lightning payment sent (${describeFloatOutcome(payment.outcome)}). ${floatPaymentDisplay(payment)}`
        );
      } else {
        json({
          status: "float_paid",
          mint: mintUrl,
          amount_sats: sats,
          ...floatPaymentJson(payment),
          display: `Your Lightning wallet paid the invoice for ${sats} sats to ${mintUrl}${
            payment.outcome === "paid" ? "" : ` (${describeFloatOutcome(payment.outcome)})`
          }. ${floatPaymentDisplay(payment)}`,
          hint: "Minting the Cashu proofs next; the balance lands in ~/.dvm/wallet.json.",
        });
      }
    },
    onInvoice: async (invoice, quote) => {
      const expiresAt = quote.expiry !== null ? new Date(quote.expiry * 1000).toISOString() : null;
      if (human) {
        info("");
        info("Pay this Lightning invoice from any Lightning wallet:");
        info("");
        info(invoice);
        info("");
        const ascii = await renderQrTerminal(invoice.toUpperCase());
        info(ascii);
        // Human mode only writes a PNG when --qr-image is set explicitly; the
        // terminal QR above already serves the in-shell use case.
        if (opts.qrImage !== undefined) {
          await writeInvoicePng(invoice, opts.qrImage);
          info(`QR PNG written to ${opts.qrImage}`);
        }
        info(
          "Polling for payment every 2s; press Ctrl-C to bail (the quote will be recoverable on next run)."
        );
      } else {
        // JSON mode always writes a PNG — agents typically relay it through
        // image channels. Default to a tmpdir path; --qr-image overrides.
        const qrImagePath = opts.qrImage ?? defaultQrImagePath();
        await writeInvoicePng(invoice, qrImagePath);
        // Agent-friendly: emit the invoice as a single-line JSON event so a
        // wrapping agent can relay it to its user without juggling stderr/stdout.
        json({
          status: "awaiting_payment",
          mint: mintUrl,
          mint_selection: mintSelection,
          amount_sats: sats,
          ...amountSourceFields(amt),
          invoice,
          qr_image_path: qrImagePath,
          relay: { copy_text: invoice, standalone: true },
          expires_at: expiresAt,
          lock_pubkey: wallet.lock_pubkey,
          display: `Pay ${sats} sats to the Lightning invoice to fund ${amountPhrase} into the agent wallet at ${mintUrl} (${selectionPhrase}). Scannable QR at ${qrImagePath}.`,
          hint: "Forward the QR PNG (or raw invoice) to a human; the CLI will mint P2PK-locked Cashu proofs into ~/.dvm/wallet.json once paid.",
        });
      }
    },
  });

  const totalProofSats = result.proofs.reduce((sum, p) => sum + p.amount, 0);

  if (human) {
    info("");
    info(
      `Minted ${totalProofSats} sats at ${mintUrl} (${selectionPhrase}) across ${result.proofs.length} P2PK-locked proofs.`
    );
    info(`Smart denomination split: ${formatDenominations(result.denominations)}.`);
    info(`Locked to lock pubkey: ${wallet.lock_pubkey}`);
  } else {
    json({
      status: "minted",
      mint: mintUrl,
      mint_selection: mintSelection,
      amount_sats: sats,
      ...amountSourceFields(amt),
      sats_minted: totalProofSats,
      proof_count: result.proofs.length,
      denominations: result.denominations,
      lock_pubkey: wallet.lock_pubkey,
      quote_id: result.quote_id,
      sweep: summarizeSweep(sweep),
      melt_sweep: summarizeMeltSweep(meltSweep),
      ...(result.float_payment ? { float_payment: floatPaymentJson(result.float_payment) } : {}),
      display: result.float_payment
        ? `Topped up ${totalProofSats} sats from your Lightning wallet into the agent wallet at ${mintUrl} (${selectionPhrase}). ${floatPaymentDisplay(result.float_payment)} No action needed.`
        : `Minted ${totalProofSats} sats at ${mintUrl} (${selectionPhrase}), locked to lock pubkey.`,
      hint: "Inspect the resulting balance with `dvm wallet show`.",
    });
  }
}

function describeFloatOutcome(outcome: FloatPayment["outcome"]): string {
  switch (outcome) {
    case "paid":
      return "confirmed";
    case "reconciled":
      return "confirmed on a second check — the wallet's first reply was lost, but it had already paid";
    case "republished":
      return "confirmed after re-sending the same request — the wallet hadn't received the first one";
  }
}

export interface WalletReceiveTokenOptions {
  human?: boolean;
}

/**
 * Claim an external Cashu token into the agent wallet. Re-locks the
 * proofs to the wallet's own lock pubkey so they're spendable, and adds the
 * token's mint to the wallet's mint list. Rejects a token locked to a third
 * party with `cashu_not_claimable` (no silent loss).
 */
export async function walletReceiveToken(
  token: string,
  opts: WalletReceiveTokenOptions
): Promise<void> {
  const result = await receiveToAgentWallet(token);

  if (opts.human) {
    info("");
    info(`Claimed ${result.claimedSats} sats across ${result.proofCount} proofs.`);
    info(`From mint: ${result.mintUrl}`);
    info("Locked to your wallet's lock pubkey — spendable on the next paid call.");
  } else {
    json({
      status: "received",
      mint: result.mintUrl,
      claimed_sats: result.claimedSats,
      proof_count: result.proofCount,
      display: `Claimed ${result.claimedSats} sats from ${result.mintUrl} into your wallet.`,
      hint: "Inspect the resulting balance with `dvm wallet show`.",
    });
  }
}

/**
 * Surface the agent wallet's balance, recent spends, per-mint distribution,
 * and per-mint `input_fee_ppk` so the user (or a relaying agent) can reason
 * about cost profile and fund availability before submitting jobs.
 */
export async function walletShow(opts: WalletShowOptions): Promise<void> {
  const wallet = loadAgentWallet();
  if (!wallet) {
    throw new DvmError(
      "wallet_missing",
      "No agent wallet found.",
      "Run `dvm wallet init` first to generate a lock keypair."
    );
  }

  // Migrate any legacy `config.cashuMints` into `wallet.mints` before the
  // inventory walk so configured mints aren't misclassified as historical or
  // shadowed by the implicit default.
  await loadConfiguredMints();

  const sweep = await reconcilePendingMints();
  const expiredMints = describeExpiredMints(sweep);
  // reconcile cash-outs the mint never confirmed before the in-flight
  // sweep runs — the melt sweep is the authority on those proofs, and letting
  // the generic timeout sweep reach them first would offer the wallet proofs a
  // mint may already have spent.
  const meltSweep = await reconcilePendingMelts().catch(emptyMeltSweep);
  const inFlightSweepReverted = await sweepStaleInFlightUnderLock();
  // Reconcile spends the DVM never confirmed. Best-effort — a DVM that's
  // still down leaves its entry for
  // the next pass, and the block below reports what remains either way.
  const submissionSweep = await sweepPendingSubmissions({ fetchImpl: dvmFetch }).catch(() => ({
    outcomes: [],
  }));
  const resumed = submissionSweep.outcomes.filter(
    (o) => o.kind === "shipped" || o.kind === "already_accepted"
  );

  const resumedViews = describeResumedSubmissions(submissionSweep.outcomes);
  // payments that expired unclaimed and came back to spendable on
  // this call. Distinct from `resumed` in the one way that matters to the
  // caller: nothing was delivered for these, the money simply returned.
  const reclaimedViews = describeReclaimedSubmissions(submissionSweep.outcomes);
  // reclaims that came due on this call and didn't go through. The
  // sweep swallows these so a mint outage can't take `wallet show` down, which
  // is exactly why they have to be reported — otherwise a wallet that can never
  // reclaim (no mnemonic, wrong mnemonic, a mint that stays down) reads as one
  // patiently waiting, forever.
  const skippedReclaimViews = describeSkippedReclaims(submissionSweep.outcomes);
  const unresolvedViews = describeUnresolvedSubmissions(submissionSweep.outcomes);
  const post = loadAgentWallet() ?? wallet;
  const submissions = describePendingSubmissions(post);
  const lockedToProviderSubmissions = submissions.entries.filter(
    (entry) => entry.state === "stale" || entry.state === "unresumable"
  );
  const unreclaimableSubmissions = submissions.entries.filter(
    (entry) => entry.state === "unreclaimable"
  );
  // a pending mint this pass couldn't check is neither
  // paid nor unpaid as far as the wallet knows, so its row must not claim
  // either — keyed by quote so both branches can name the reason inline.
  const unchecked = new Map(sweep.unchecked.map((u) => [u.quote_id, u]));
  const inventory = buildDisplayMintInventory(post);
  const mintsToProbe = inventory.map((e) => e.url);
  const sources = new Map<string, MintSource>(inventory.map((e) => [e.url, e.source]));
  const fees = await loadMintFeeProfiles(mintsToProbe);
  const mintsCheckedAt = new Date().toISOString();
  const rows = summarizeMints(post.proofs, fees, sources);
  const totalSats = rows.reduce((sum, r) => sum + r.balance_sats, 0);
  const recentSpends = post.recent_spends.slice(-10).reverse();

  // Per-mint balances are the primary unit: each Cashu mint is a separate
  // custodial issuer and a single spend draws proofs from one mint only, so
  // the aggregate is not a combined spendable pot. When >1 mint
  // holds a balance, surface that explicitly so an agent doesn't treat the
  // sum as fungible.
  const fundedMintCount = rows.filter((r) => r.balance_sats > 0).length;
  const cashuSplit = fundedMintCount > 1;

  // a cash-out the mint hasn't confirmed is sats committed to a
  // Lightning payment that may or may not have landed. Their proofs are still
  // in `wallet.proofs` (in-flight, so excluded from spendable selection), so
  // without this block a balance that looks intact is partly already gone.
  const pendingMelts = post.pending_melts.map((m) => ({
    mint: m.mint,
    quote_id: m.quote_id,
    destination: m.destination,
    amount_sats: m.amount_sats,
    committed_sats: m.input_proofs.reduce((sum, p) => sum + p.amount, 0),
    created_at: m.created_at,
    display: `${m.amount_sats} sats to ${m.destination} via ${m.mint} — the mint hasn't confirmed this payment yet.`,
  }));
  const pendingMeltSats = pendingMelts.reduce((sum, m) => sum + m.committed_sats, 0);

  // Probe the per-rail snapshot (Cashu derived from the wallet file above,
  // Tempo via live USDC balanceOf on the connected EVM account if any).
  const railsSnapshot = await collectRailSnapshots({
    cashuTotalSats: totalSats,
    cashuMintCount: fundedMintCount,
  });

  if (opts.human) {
    if (sweep.recovered_proofs.length > 0) {
      const recovered = sweep.recovered_proofs.reduce((sum, p) => sum + p.amount, 0);
      info(`Recovered ${recovered} sats from ${sweep.recovered_proofs.length} pending mint(s).`);
    }
    for (const expired of expiredMints) {
      info(
        `Unpaid mint quote expired: ${expired.amount_sats} sats at ${expired.mint} (quote ID ${expired.quote_id}) — local recovery entry removed.`
      );
    }
    reportUncheckedMints(sweep.unchecked);
    reportUncheckedMints(meltSweep.unchecked);
    if (inFlightSweepReverted > 0) {
      info(
        `Recovered ${inFlightSweepReverted} stale in-flight proof(s) back to spendable (DVM_INFLIGHT_PROOF_TIMEOUT_SEC).`
      );
    }
    if (meltSweep.settled_sats > 0) {
      info(`Confirmed ${meltSweep.settled_sats} sats cashed out to Lightning.`);
    }
    if (meltSweep.returned_sats > 0) {
      info(
        `A cash-out never paid — ${meltSweep.returned_sats} sats are back in the spendable balance.`
      );
    }
    for (const outcome of resumed) {
      const jobSuffix =
        outcome.kind === "shipped" && outcome.jobId ? ` — job ${outcome.jobId}` : "";
      info(
        `Reconciled a ${outcome.entry.amount_sats} sat payment to ${outcome.entry.endpoint}${jobSuffix}.`
      );
    }
    for (const view of unresolvedViews) info(view.display);
    for (const view of reclaimedViews) {
      info(
        `A ${view.amount_sats} sat payment to ${view.endpoint} expired unclaimed — ${view.reclaimed_sats} sats are back in your balance.`
      );
    }
    for (const view of skippedReclaimViews) {
      info(
        view.terminal
          ? `A ${view.amount_sats} sat payment to ${view.endpoint} expired unclaimed and is not worth taking back: ${view.reason}. Retrying will not change that.`
          : `A ${view.amount_sats} sat payment to ${view.endpoint} expired unclaimed, but could not be taken back: ${view.reason}`
      );
    }
    info("Balance:");
    for (const r of railsSnapshot) {
      info(`  ${r.human}`);
      // A row-level remedy (e.g. a Tempo rail holding none of its settlement
      // asset) belongs next to the number it explains, not in the trailing hint.
      if (r.json.hint) info(`    ↳ ${r.json.hint}`);
    }
    // An unconfirmed submission is money that left the wallet, so a zero
    // balance alongside one is not an empty wallet — don't short-circuit past
    // the block that explains where the sats went.
    if (
      totalSats === 0 &&
      post.pending_mints.length === 0 &&
      submissions.entries.length === 0 &&
      pendingMelts.length === 0 &&
      railsSnapshot.length <= 1
    ) {
      info("");
      info("Agent wallet is empty.");
      info("Fund it with: dvm wallet fund <amount> [--rail cashu|tempo]");
      return;
    }
    info("");
    info("Per-mint distribution:");
    for (const row of rows) {
      const tag = formatMintSourceTag(row.source);
      info(`  ${row.url}${tag}`);
      info(`    balance: ${row.balance_sats} sats (${row.proof_count} proofs)`);
      info(`    input_fee_ppk: ${formatFeePpk(fees.get(row.url) ?? null)}`);
      // say it plainly and say it's a snapshot — a mint that didn't
      // answer just now is skipped by the next spend and picked back up the
      // moment it does. Nothing is remembered about it between calls.
      if (!row.reachable) {
        info(`    reachable: no (probed just now — payments route to another mint meanwhile)`);
      }
    }
    if (cashuSplit) {
      info("");
      info(`  Note: ${NON_FUNGIBLE_MINT_NOTE}`);
    }
    if (post.pending_mints.length > 0) {
      info("");
      info(`Pending mints: ${post.pending_mints.length}`);
      for (const p of post.pending_mints) {
        info(`  ${formatPending(p, unchecked.get(p.quote_id))}`);
      }
    }
    if (pendingMelts.length > 0) {
      info("");
      info(
        `Unconfirmed cash-outs: ${pendingMelts.length} (${pendingMeltSats} sats committed, not yet confirmed)`
      );
      for (const m of pendingMelts) {
        info(`  ${m.display} (quote ${m.quote_id}, committed ${m.created_at})`);
      }
    }
    if (submissions.entries.length > 0) {
      info("");
      info(
        `Unconfirmed payments: ${submissions.entries.length} (${submissions.at_risk_sats} sats spent, not yet confirmed)`
      );
      for (const entry of submissions.entries) {
        info(`  ${formatPendingSubmission(entry)}`);
      }
      if (lockedToProviderSubmissions.length > 0) {
        info("");
        info(
          `  ${
            unreclaimableSubmissions.length > 0
              ? `${lockedToProviderSubmissions.length} of these are`
              : "These are"
          } no longer retried automatically. The sats were paid to the DVM; quote the request id above to its operator to find out whether the job ran.`
        );
      }
      if (unreclaimableSubmissions.length > 0) {
        info("");
        info(
          `  ${unreclaimableSubmissions.length} of these expired unclaimed, but the mint charges more to take the sats back than they are worth. Retrying will not change that — treat the sats as spent. Remove the record with: dvm wallet submissions --forget <request_id>`
        );
      }
      if (submissions.reclaimable_count > 0) {
        info("");
        info(
          `  ${submissions.reclaimable_count} of these expire if the DVM never takes them — the wallet returns those sats to your balance on its own. Nothing to do.`
        );
      }
      if (submissions.reclaim_failed_count > 0) {
        info("");
        info(
          `  ${submissions.reclaim_failed_count} of these have expired and the wallet keeps failing to take the sats back — see each entry's reason above. They are still recoverable; fix the cause and the next call retries.`
        );
      }
    }
    info("");
    if (recentSpends.length === 0) {
      info("Recent spends: none yet.");
    } else {
      info(`Recent spends (last ${recentSpends.length}):`);
      for (const spend of recentSpends) {
        info(`  ${formatRecentSpend(spend)}`);
      }
    }
  } else {
    const totalUsd = railsSnapshot.reduce((sum, r) => sum + (r.json.balance_usd ?? 0), 0);
    const baseHint =
      pendingMeltSats > 0
        ? `${pendingMeltSats} sats are committed to a cash-out the mint hasn't confirmed — see pending_melts. They stay unspendable until it resolves.`
        : submissions.at_risk_sats > 0
          ? `${submissions.at_risk_sats} sats were paid to a DVM that never confirmed — see pending_submissions.`
          : railsSnapshot.length === 0
            ? "Fund with: dvm wallet fund <amount> [--rail cashu|tempo]"
            : cashuSplit
              ? `${NON_FUNGIBLE_MINT_NOTE} Fund more with: dvm wallet fund <amount> [--rail cashu|tempo]`
              : "Fund more with: dvm wallet fund <amount> [--rail cashu|tempo]";
    // lead the hint with what the sweep just recovered — the newly
    // actionable thing on this call — then fall through to the standing hint.
    // A failed reclaim outranks both: it is the only one of the three
    // that needs the caller to do something. A reclaim that can never pay for
    // itself needs nothing, so it goes last — and must not claim the sats are
    // still recoverable, because they aren't.
    //
    // A mint that wouldn't answer outranks every hint below it: until
    // it does, the wallet cannot say whether that invoice was paid, and the one
    // thing the caller must not do is fund the same money again.
    const uncheckedHint =
      sweep.unchecked.length > 0
        ? `${sweep.unchecked.length} pending mint(s) could not be checked against their mint on this call — see sweep.unchecked for the cause and how long to wait. They keep their pending state; don't fund the same invoice again.`
        : null;
    const stuckReclaims = skippedReclaimViews.filter((v) => !v.terminal);
    const deadReclaims = skippedReclaimViews.filter((v) => v.terminal);
    const unresolvedHint =
      unresolvedViews.length > 0
        ? `${unresolvedViews.length} paid call(s) need attention: the provider accepted them without a clear job ID — see accepted_unresolved. Do not pay for them again.`
        : null;
    const resumedHint =
      stuckReclaims.length > 0
        ? `${stuckReclaims.reduce((sum, v) => sum + v.amount_sats, 0)} sats from ${stuckReclaims.length} expired payment(s) could not be taken back on this call — see reclaim_skipped for why. The sats are still recoverable.`
        : resumedViews.length > 0
          ? `Reconciled ${resumedViews.length} unconfirmed payment(s) on this call — see resumed for the job id(s).`
          : reclaimedViews.length > 0
            ? `${reclaimedViews.reduce((sum, v) => sum + v.reclaimed_sats, 0)} sats came back from ${reclaimedViews.length} expired payment(s) the provider never took — see reclaimed.`
            : deadReclaims.length > 0
              ? `${deadReclaims.reduce((sum, v) => sum + v.amount_sats, 0)} sats from ${deadReclaims.length} expired payment(s) are too small to be worth taking back — see reclaim_skipped. Retrying will not change that; treat them as spent.`
              : null;
    json({
      status: "ok",
      rails: railsSnapshot.map((r) => r.json),
      total_sats: totalSats,
      lock_pubkey: post.lock_pubkey,
      recent_spends: recentSpends,
      mints: rows,
      // each row's `reachable` was observed on this run and nowhere
      // else — the timestamp is here so an agent reads it as a live snapshot
      // rather than durable state about the mint.
      mints_checked_at: mintsCheckedAt,
      pending_mints: post.pending_mints,
      // sats that left the wallet but no DVM has confirmed. Excluded
      // from `total_sats` by construction (the proofs are locked to the DVM),
      // so without this block the balance just drops with nothing to point at.
      pending_submissions: submissions.entries,
      pending_submission_sats: submissions.at_risk_sats,
      // cash-outs the mint hasn't confirmed. Their proofs are still
      // counted in `total_sats` but are in-flight and unspendable, so the two
      // numbers only reconcile with this block in view.
      pending_melts: pendingMelts,
      pending_melt_sats: pendingMeltSats,
      // submissions this call's sweep re-shipped and cleared, each with
      // the job id (or an honest null) the DVM handed back.
      resumed: resumedViews,
      // payments that expired unclaimed and were swapped back to
      // spendable on this call. No service was rendered for them.
      reclaimed: reclaimedViews,
      // reclaims that were due on this call and didn't happen, each
      // with the reason. Empty is the normal case; a repeating entry here means
      // the self-heal needs a human.
      reclaim_skipped: skippedReclaimViews,
      // paid calls the provider accepted without a settled job identity,
      // detected on this call or missing their evidence record.
      accepted_unresolved: unresolvedViews,
      sweep: summarizeSweep(sweep),
      melt_sweep: summarizeMeltSweep(meltSweep),
      display:
        railsSnapshot.length === 0
          ? "Agent wallet is empty."
          : `${railsSnapshot.map((r) => r.json.display).join(" — ")} (~$${totalUsd.toFixed(2)} total)`,
      hint: [uncheckedHint, unresolvedHint, resumedHint, baseHint].filter(Boolean).join(" "),
    });
  }
}

/**
 * Generate-and-instruct fund flow for the Tempo rail. Generates a
 * fresh EVM keypair if `config.tempo` doesn't already hold a Tempo wallet,
 * prints the deposit address + USD target, and exits. Funding happens
 * out-of-band by the user sending USDC to the printed address on the
 * Tempo chain (`dvm wallet show` will surface the live balance once funded).
 */
async function fundTempoRail(amount: string, opts: WalletFundOptions): Promise<void> {
  const target = parseStablecoinAmount(amount);
  const existing = await connectedTempoAccount();
  const isNew = existing === null;
  const account = existing ?? (await generateTempoKey());

  const network = tempoAccountNetwork(account);
  const chain = resolveTempoNetwork(network);
  const chainLabel = tempoNetworkLabel(network);
  const asset = resolveTempoAsset(process.env, network);
  if (network === "moderato") {
    const faucet = await fundTempoFromFaucet(account);
    if (opts.human) {
      info(
        `Tempo faucet · ${chainLabel} (chain ${chain.chainId}) · ${asset.label} · contract ${asset.address}`
      );
      info(`Wallet: ${account.address}`);
      info(
        `Faucet confirmed ${faucet.granted.toFixed(6)} ${asset.unit} (${faucet.grantedBaseUnits.toString()} base units); balance is now ${faucet.after.usdc.toFixed(6)} ${asset.unit}.`
      );
      info(
        `The command's $${target.usd.toFixed(2)} amount selected the funding workflow; Tempo's faucet chose the test grant amount and also funds other test assets.`
      );
      info("No real funds were used. `dvm wallet balance` confirms this same token and chain.");
    } else {
      json({
        status: "faucet_funded",
        rail: "tempo",
        network,
        network_label: chainLabel,
        chain_id: chain.chainId,
        address: account.address,
        asset: asset.symbol,
        token: asset.address,
        requested_usd: target.usd,
        requested_amount_role: "workflow_selection_only",
        faucet_granted_atomic: faucet.grantedBaseUnits.toString(),
        faucet_granted_amount: faucet.granted,
        balance_before_atomic: faucet.before.rawBaseUnits.toString(),
        balance_after_atomic: faucet.after.rawBaseUnits.toString(),
        balance_after: faucet.after.usdc,
        poll_attempts: faucet.attempts,
        wallet_generated: isNew,
        display: `Tempo's Moderato faucet funded ${faucet.granted.toFixed(6)} ${asset.unit}; the wallet now holds ${faucet.after.usdc.toFixed(6)} ${asset.unit} on chain ${chain.chainId}.`,
        hint: `The $${target.usd.toFixed(2)} command amount did not size the faucet grant; Tempo chose the fixed test amount reported above and also grants other test assets. No real funds were used.`,
      });
    }
    return;
  }

  const depositAddress = account.address;
  const handoff = await prepareStablecoinFundingHandoff({
    address: depositAddress,
    rail: "tempo",
    human: opts.human ?? false,
    qrImagePath: opts.qrImage,
  });

  if (opts.human) {
    info(`Tempo funding · ${chainLabel} (chain ${chain.chainId}) · ${asset.label} · contract ${asset.address}`);
    printStablecoinFundingHandoff(handoff);
    info("");
    info(`Send $${target.usd.toFixed(2)} of ${asset.label} to the address above.`);
    info(
      `Send only ${asset.label} — another Tempo dollar such as USDT0 is a different token and will not be spendable here.`
    );
    info("After the on-chain deposit confirms, `dvm wallet show` will surface the live balance.");
  } else {
    json({
      status: isNew ? "generated" : "connected",
      rail: "tempo",
      network,
      network_label: chainLabel,
      chain_id: chain.chainId,
      // `token` is the contract; `asset` is the word an agent can
      // relay to a human deciding which dollar to buy. Null when an operator
      // override points at a contract we can't name.
      asset: asset.symbol,
      token: asset.address,
      target_usd: target.usd,
      amount_atomic: target.atomic.toString(),
      ...stablecoinFundingHandoffJson(handoff),
      display: `Tempo wallet ${isNew ? "generated" : "already connected"}. Deposit $${target.usd.toFixed(2)} of ${asset.label} on ${chainLabel} (chain ${chain.chainId}); relay the address standalone and attach the QR separately.`,
      hint: `Send only ${asset.label} (${asset.address}) — another Tempo dollar such as USDT0 is a different token and will not be spendable here. Once the deposit confirms on-chain, \`dvm wallet show\` will surface the live balance and \`dvm request --rail tempo\` can pay DVMs.`,
    });
  }
}

async function fundX402Rail(amount: string, opts: WalletFundOptions): Promise<void> {
  const target = parseStablecoinAmount(amount);
  const config = loadConfig();
  if (!config) throw new DvmError("no_config", "No config found.", "Run `dvm init` first.");

  const { connected, isNew } = await withX402ChannelLock(async () => {
    const existing = loadX402Wallet();
    return existing
      ? { connected: await ensureAddress(existing), isNew: false }
      : {
          connected: await saveX402Wallet(await generateX402PrivateKey(), X402_DEFAULT_NETWORK),
          isNew: true,
        };
  });
  const asset = resolveX402Asset(connected.network);
  if (!asset) {
    throw new DvmError(
      "x402_unsupported_network",
      `The x402 wallet is configured for ${connected.network}, a chain this rail cannot fund.`,
      "Run 'dvm wallet x402-network eip155:8453' to select Base."
    );
  }
  const chainId = chainIdFromCaip2(connected.network);
  const erc681Uri = buildErc681TokenTransferUri({
    chainId,
    token: asset.address,
    recipient: connected.address,
    atomicAmount: target.atomic,
  });
  const handoff = await prepareStablecoinFundingHandoff({
    address: connected.address,
    rail: "x402",
    human: opts.human ?? false,
    qrImagePath: opts.qrImage,
    erc681Uri,
  });

  if (opts.human) {
    info(
      `x402 funding · ${asset.networkLabel} (${connected.network}; chain ${String(chainId)}) · ${asset.label} · contract ${asset.address}`
    );
    printStablecoinFundingHandoff(handoff);
    info("");
    info(`Send $${target.usd.toFixed(2)} of ${asset.label} to the address above.`);
    info(`ERC-681 (inspect only; the QR uses the raw address): ${erc681Uri}`);
    info(
      `Send native USDC, not ${asset.confusable ?? "a bridged stablecoin"}, and use ${asset.networkLabel} only.`
    );
  } else {
    json({
      status: isNew ? "generated" : "connected",
      rail: "x402",
      network: connected.network,
      chain_id: chainId,
      asset: asset.symbol,
      token: asset.address,
      target_usd: target.usd,
      amount_atomic: target.atomic.toString(),
      ...stablecoinFundingHandoffJson(handoff),
      display: `x402 wallet ${isNew ? "generated" : "already connected"}. Deposit $${target.usd.toFixed(2)} of ${asset.label} on ${asset.networkLabel} (${connected.network}); relay the address standalone and attach the QR separately.`,
      hint: `The QR encodes the raw address for broad wallet compatibility; inspect erc681_uri for the exact token transfer. Send ${asset.label} (${asset.address}), not ${asset.confusable ?? "a bridged stablecoin"}, on ${asset.networkLabel} only.`,
    });
  }
}

interface RailSnapshot {
  human: string;
  json: {
    rail: "cashu_p2pk" | "tempo";
    status: "ok" | "rpc_unavailable" | "empty";
    /** Persisted Tempo network, absent for Cashu rows. */
    network?: "mainnet" | "moderato";
    /** Human-facing Tempo chain name, absent for Cashu rows. */
    network_label?: string;
    balance_usd?: number;
    native: Record<string, unknown>;
    display: string;
    /** Row-level remedy for a degraded or empty rail; rendered under the row in `--human`. */
    hint?: string;
  };
}

/**
 * Collect Cashu + Tempo balance rows for `dvm wallet show`. Always returns
 * the Cashu row when sats > 0; the Tempo row is only emitted when a Tempo
 * wallet is connected (`config.tempo.method === "tempo"`).
 */
async function collectRailSnapshots(args: {
  cashuTotalSats: number;
  cashuMintCount: number;
}): Promise<RailSnapshot[]> {
  const out: RailSnapshot[] = [];

  if (args.cashuTotalSats > 0) {
    const usd = await cashuSatsToUsd(args.cashuTotalSats);
    // The Cashu total spans `cashuMintCount` independent mints; flag the split
    // so the aggregate isn't mistaken for one fungible balance.
    const split = args.cashuMintCount > 1 ? ` across ${args.cashuMintCount} mints` : "";
    out.push({
      human:
        usd === null
          ? `Cashu agent wallet: ${args.cashuTotalSats} sats${split} (USD unavailable — FX lookup failed)`
          : `Cashu agent wallet: ~$${usd.toFixed(2)} (${args.cashuTotalSats} sats${split})`,
      json: {
        rail: "cashu_p2pk",
        status: "ok",
        balance_usd: usd ?? undefined,
        native: { unit: "sat", amount: args.cashuTotalSats, mint_count: args.cashuMintCount },
        display:
          usd === null
            ? `Cashu: ${args.cashuTotalSats} sats${split}`
            : `Cashu: ~$${usd.toFixed(2)}${split}`,
      },
    });
  }

  const tempo = await connectedTempoAccount();
  if (tempo) {
    out.push(await tempoRailSnapshot(tempo));
  }

  return out;
}

async function cashuSatsToUsd(sats: number): Promise<number | null> {
  try {
    const spot = await getSpotRate("btc_usd");
    return (sats / 100_000_000) * spot.rate;
  } catch {
    return null;
  }
}

async function tempoRailSnapshot(account: TempoAccount): Promise<RailSnapshot> {
  const network = tempoAccountNetwork(account);
  const chain = resolveTempoNetwork(network);
  const chainLabel = tempoNetworkLabel(network);
  try {
    const balance = await getVerifiedTempoBalance(account);
    // USDC is peg-proxy-anchored to USD; the tiny drift via `usdc_usd` only
    // matters at fund-size scales. Use the spot when available, fall back
    // to 1:1 on FX failure.
    let usd = balance.usdc;
    try {
      const spot = await getSpotRate("usdc_usd");
      usd = balance.usdc * spot.rate;
    } catch {
      // 1:1 fallback — USDC peg holds within fractions of a percent.
    }
    // a zero here is ambiguous — an unfunded wallet and a wallet
    // funded with the wrong Tempo dollar look identical, because the read only
    // ever queries the settlement contract. Say which asset that is rather than
    // reporting a bare $0.00. Copy branch only; no second balance query.
    const asset = resolveTempoAsset(process.env, network);
    const empty = balance.rawBaseUnits === 0n;
    return {
      human: `Tempo:              ~$${usd.toFixed(2)} (${balance.usdc.toFixed(6)} ${asset.unit} on ${chainLabel}, account ${shortAddr(account.address)})`,
      json: {
        rail: "tempo",
        status: empty ? "empty" : "ok",
        network,
        network_label: chainLabel,
        balance_usd: usd,
        native: {
          unit: "usdc",
          amount: balance.rawBaseUnits.toString(),
          decimals: 6,
          asset: asset.symbol,
          address: account.address,
          token: balance.tokenAddress,
          chain_id: balance.chainId,
        },
        display: empty
          ? `Tempo: no ${asset.label} on ${chainLabel} at ${shortAddr(account.address)}`
          : `Tempo: ~$${usd.toFixed(2)} ${asset.unit} on ${chainLabel}`,
        ...(empty ? { hint: tempoWrongAssetHint(asset) } : {}),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      human: `Tempo:              live balance unavailable (${msg}); account ${shortAddr(account.address)}`,
      json: {
        rail: "tempo",
        status: "rpc_unavailable",
        network,
        network_label: chainLabel,
        native: { unit: "usdc", amount: null, address: account.address, chain_id: chain.chainId },
        display: `Tempo: balance not queried on ${chainLabel} (account ${shortAddr(account.address)})`,
      },
    };
  }
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function sweepStaleInFlightUnderLock(): Promise<number> {
  return withWalletLock(() => {
    const w = loadAgentWallet();
    if (!w) return 0;
    const swept = sweepStaleInFlight(w, Date.now());
    if (swept.reverted > 0) saveAgentWallet(swept.wallet);
    return swept.reverted;
  });
}

function describeFundRefusal(
  mint: string,
  reason: string,
  sats: number,
  probe: MintHealthCheckResult
): string {
  if (reason === "minting_disabled") return `${mint} is not currently issuing ecash`;
  if (isBoundsRefusal(reason)) {
    return `${mint} won't issue ${sats} sats in one go (it takes ${describeMintBounds(probe.mintAmountBounds)})`;
  }
  return `${mint} is unhealthy`;
}

function isBoundsRefusal(reason: string): boolean {
  return reason === "amount_below_min" || reason === "amount_above_max";
}

/**
 * Name the bound on the way past an explicit `--mint` the amount doesn't fit.
 * The call still proceeds — the operator named the mint — but the mint's own
 * refusal is opaque, and this is the last moment we can say why it's coming.
 */
function warnIfOutOfBounds(
  mint: string,
  sats: number,
  probe: MintHealthCheckResult,
  human: boolean
): void {
  const verdict = amountBoundsVerdict(sats, probe.mintAmountBounds);
  if (verdict === "ok") return;
  const bounds = probe.mintAmountBounds ?? { minSats: null, maxSats: null };
  const display = `${mint} advertises a limit of ${describeMintBounds(bounds)} per fund — ${sats} sats is outside it, so the mint is likely to refuse. Attempting anyway because you named this mint.`;
  if (human) {
    info(display);
  } else {
    json({
      status: "mint_bounds_warning",
      mint,
      amount_sats: sats,
      min_sats: bounds.minSats,
      max_sats: bounds.maxSats,
      display,
      hint: `Drop --mint to let the fund pick a mint that can issue ${sats} sats, or fund ${describeMintBounds(bounds)}.`,
    });
  }
}

/**
 * Why `dvm wallet fund` picked the mint it funded .
 * `explicit` = the caller passed `--mint`; `configured` = first configured mint
 * (no `--mint`); `fallback` = the built-in {@link DEFAULT_AGENT_MINT_URL}
 * because no mints are configured; `health_fallback` = the preferred mint
 * failed its probe; `capability_fallback` = the preferred mint is
 * reachable but advertises minting switched off; `bounds_fallback` = the
 * preferred mint is reachable and issuing, but won't issue this amount
 * */
type MintSelection =
  | "explicit"
  | "configured"
  | "fallback"
  | "health_fallback"
  | "capability_fallback"
  | "bounds_fallback";

function describeMintSelection(selection: MintSelection): string {
  switch (selection) {
    case "explicit":
      return "explicit --mint";
    case "configured":
      return "first configured mint";
    case "fallback":
      return "built-in fallback mint — no mints configured";
    case "health_fallback":
      return "health fallback — preferred mint unhealthy";
    case "capability_fallback":
      return "capability fallback — preferred mint is not currently issuing ecash";
    case "bounds_fallback":
      return "amount fallback — preferred mint won't issue this amount in one go";
  }
}

function parseTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new DvmError(
      "invalid_timeout",
      `Invalid --timeout value: "${raw}".`,
      "Pass a positive integer number of seconds, e.g. --timeout 600."
    );
  }
  return Math.floor(n) * 1_000;
}

function formatDenominations(denoms: number[]): string {
  const counts = new Map<number, number>();
  for (const d of denoms) counts.set(d, (counts.get(d) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => a[0] - b[0]);
  return sorted.map(([amt, n]) => `${n}×${amt}`).join(", ");
}

function formatFeePpk(fee: number | null): string {
  if (fee === null) return "- (mint unreachable)";
  return `${fee} ppk`;
}

function formatPending(p: PendingMint, unchecked?: UncheckedMint): string {
  const row = `${p.amount_sats} sats at ${p.mint} (quote ${p.quote_id}, requested ${p.requested_at})`;
  // Without this the row reads as awaiting payment, which is the one thing the
  // mint just declined to confirm.
  return unchecked
    ? `${row}\n    ↳ ${uncheckedPendingNote(unchecked)}`
    : `${row} — awaiting payment`;
}

function reportUncheckedMints(unchecked: UncheckedMint[]): void {
  for (const entry of unchecked) {
    info(entry.display);
    info(`  ↳ ${entry.hint}`);
  }
}

function formatRecentSpend(spend: {
  request_id: string;
  dvm_endpoint: string;
  mint: string;
  amount_sats: number;
  signed_at_ms: number;
}): string {
  const when = new Date(spend.signed_at_ms).toISOString();
  const reqShort = `${spend.request_id.slice(0, 8)}…${spend.request_id.slice(-4)}`;
  return `${when}  ${spend.amount_sats} sats  ${spend.dvm_endpoint}  (req ${reqShort})`;
}

function formatMintSourceTag(source: MintSource): string {
  switch (source) {
    case "configured":
      return "";
    case "default":
      return "  [default — fund flow fallback; add explicitly with `dvm wallet mint-add`]";
    case "proofs":
      return "  [from proofs — no longer in configured mints]";
    case "pending":
      return "  [pending mint quote — not in configured mints]";
    case "ad_hoc":
      // `buildDisplayMintInventory` never emits ad_hoc (it's mint-health-only);
      // keep the switch exhaustive so a future inventory tweak surfaces here.
      return "";
  }
}

/** Melt sweep stand-in when the sweep itself threw — a sweep failure never fails the command it ran inside. */
function emptyMeltSweep(): MeltReconcileResult {
  return {
    outcomes: [],
    settled_sats: 0,
    returned_sats: 0,
    still_pending: [],
    errors: [],
    unchecked: [],
  };
}

/**
 * What this run's melt reconciliation moved. A cash-out the mint
 * never paid puts sats back into the spendable balance, and one it did pay
 * takes them out for good — either way the balance changes for a reason that
 * happened in a *previous* run, so the number needs naming rather than
 * appearing as an unexplained delta.
 */
function summarizeMeltSweep(sweep: MeltReconcileResult) {
  return {
    settled_sats: sweep.settled_sats,
    returned_sats: sweep.returned_sats,
    still_pending: sweep.still_pending.length,
    unchecked: sweep.unchecked,
  };
}

/**
 * What this run's mint reconciliation moved, and what it couldn't reach.
 * `unchecked` carries classified causes and retry waits, never the mint's
 * unbounded third-party prose.
 */
function summarizeSweep(sweep: ReconcileResult) {
  return {
    recovered_count: sweep.recovered_proofs.length,
    recovered_sats: sweep.recovered_proofs.reduce((s, p) => s + p.amount, 0),
    // Additive to `dropped`, which remains the compatibility field for callers
    // that expect expired and already-issued quote IDs in one list.
    expired: describeExpiredMints(sweep),
    dropped: sweep.outcomes
      .filter((o) => o.kind === "expired" || o.kind === "already_issued")
      .map((o) => o.entry.quote_id),
    unchecked: sweep.unchecked,
  };
}

/** Expired unpaid quotes removed from local recovery state by this sweep. */
function describeExpiredMints(sweep: ReconcileResult) {
  return sweep.outcomes
    .filter((outcome) => outcome.kind === "expired")
    .map(({ entry }) => ({
      quote_id: entry.quote_id,
      mint: entry.mint,
      amount_sats: entry.amount_sats,
    }));
}

/**
 * Wrap {@link renderQrPng} so a render failure surfaces as a structured
 * `qr_render_failed` DvmError instead of a stack-trace leak — and so an agent
 * never sees a JSON event pointing at a PNG that was never written.
 */
async function writeInvoicePng(invoice: string, outPath: string): Promise<void> {
  try {
    await renderQrPng(invoice.toUpperCase(), outPath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new DvmError(
      "qr_render_failed",
      `Failed to write invoice QR PNG to ${outPath}: ${detail}`,
      "Check that the path is writable, or omit --qr-image to use a tmpdir default."
    );
  }
}
