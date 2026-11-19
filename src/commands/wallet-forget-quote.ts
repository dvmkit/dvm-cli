/**
 * `dvm wallet forget-quote <quote-id>`: deliberately stop tracking one pending
 * funding invoice.
 *
 * The reconcile sweep never drops an unpaid quote on a local timer, because the
 * quote ID is the only handle that can mint a late payment. That leaves a quote
 * whose mint named no expiry pending until someone decides to forget it.
 * Paid quotes, unchecked quotes, and entries with saved outputs require
 * `--force` because a wallet sweep may still recover a payment.
 */

import { createInterface } from "node:readline";

import { MintQuoteState } from "@cashu/cashu-ts";
import {
  DvmError,
  getWallet,
  loadAgentWallet,
  type PendingMint,
  saveAgentWallet,
  shellQuoteArg,
  withWalletLock,
} from "@dvmkit/sdk/internal";

import { info, json } from "../lib/output";
import { classifyMintError, type MintFailureCause } from "../lib/wallet-agent/fund-wait";
import { mintQuoteRefusal, readPendingMint, withPendingMintLock } from "../lib/wallet-agent/recovery";

export interface WalletForgetQuoteOptions {
  /** Skip the confirmation prompt. Required to forget non-interactively. */
  yes?: boolean;
  /**
   * Forget a paid quote, a quote with saved outputs, or an unchecked quote.
   * Separate from `--yes` on purpose: `--yes` waives a prompt, this waives the
   * only record that can collect a payment.
   */
  force?: boolean;
  human?: boolean;
}

/** What the mint said about the quote when asked just before forgetting it. */
type QuoteStanding =
  | { state: "unpaid" | "paid" | "issued" | "gone" }
  | { state: "unchecked"; cause: MintFailureCause };

export async function walletForgetQuote(
  quoteId: string,
  opts: WalletForgetQuoteOptions
): Promise<void> {
  const wallet = loadAgentWallet();
  if (!wallet) {
    throw new DvmError(
      "wallet_missing",
      "No agent wallet found.",
      "Run `dvm wallet init` first to generate a lock keypair."
    );
  }
  const entry = wallet.pending_mints.find((p) => p.quote_id === quoteId);
  if (!entry) throw quoteNotFound(quoteId);

  if (!opts.yes) {
    const preview = await quoteStanding(entry);
    refuseIfCollectable(entry, preview, opts);
    await confirmForget(entry, preview, opts);
  }

  const { standing, hadSavedOutputs } = await withPendingMintLock(entry, async () => {
    const current = readPendingMint(entry, wallet.lock_pubkey);
    if (!current) throw quoteNotFound(quoteId);
    const checked = await quoteStanding(current.entry);
    return withWalletLock(() => {
      const fresh = readPendingMint(entry, wallet.lock_pubkey);
      if (!fresh) throw quoteNotFound(quoteId);
      refuseIfCollectable(fresh.entry, checked, opts);
      saveAgentWallet({
        ...fresh.wallet,
        pending_mints: fresh.wallet.pending_mints.filter((pending) => pending !== fresh.entry),
      });
      return { standing: checked, hadSavedOutputs: fresh.entry.minting !== undefined };
    });
  });

  const display = `Forgot mint quote ${quoteId} (${entry.amount_sats} sats at ${entry.mint}). ${forgottenConsequence(standing, hadSavedOutputs)}`;
  if (opts.human) {
    info(display);
    return;
  }
  json({
    status: "forgotten",
    quote_id: quoteId,
    mint: entry.mint,
    amount_sats: entry.amount_sats,
    mint_state: standing.state,
    display,
    hint: "The quote is gone from the wallet. This cannot be undone.",
  });
}

function quoteNotFound(quoteId: string): DvmError {
  return new DvmError(
    "mint_quote_not_found",
    `No pending mint quote with ID "${quoteId}".`,
    "List pending quotes with: dvm wallet show"
  );
}

async function quoteStanding(entry: PendingMint): Promise<QuoteStanding> {
  try {
    const cashuWallet = await getWallet(entry.mint);
    const quote = await cashuWallet.checkMintQuoteBolt11(entry.quote_id);
    if (quote.state === MintQuoteState.PAID) return { state: "paid" };
    if (quote.state === MintQuoteState.ISSUED) return { state: "issued" };
    if (quote.state === MintQuoteState.UNPAID) return { state: "unpaid" };
    if ((quote.state as string) === "EXPIRED") return { state: "gone" };
    // A state this CLI cannot read is not an answer that the quote is dead.
    return { state: "unchecked", cause: "unexpected" };
  } catch (err) {
    if (mintQuoteRefusal(err) !== undefined) return { state: "gone" };
    return { state: "unchecked", cause: classifyMintError(err) };
  }
}

function refuseIfCollectable(
  entry: PendingMint,
  standing: QuoteStanding,
  opts: WalletForgetQuoteOptions
): void {
  if (opts.force) return;
  const forced = `dvm wallet forget-quote ${shellQuoteArg(entry.quote_id)} --yes --force`;

  if (standing.state === "unchecked") {
    throw new DvmError(
      "mint_quote_unchecked",
      `The mint did not say whether mint quote ${entry.quote_id} has been paid, so forgetting it could lose a payment.`,
      `Try again once the mint answers. To forget it without knowing, add --force: ${forced}`,
      { cause: standing.cause, retryable: standing.cause !== "unexpected" }
    );
  }
  // The mint may retain signatures after its quote record expires or disappears.
  if (standing.state === "paid" || entry.minting !== undefined) {
    throw new DvmError(
      "mint_quote_collectable",
      standing.state === "paid"
        ? `Mint quote ${entry.quote_id} is paid: ${entry.amount_sats} sats at ${entry.mint} are waiting to be collected.`
        : `Mint quote ${entry.quote_id} has saved outputs that may still recover proofs for ${entry.amount_sats} sats at ${entry.mint}.`,
      `Run \`dvm wallet show\` to collect the sats or restore any signed proofs. To discard the recovery record, run \`${forced}\`.`
    );
  }
}

async function confirmForget(
  entry: PendingMint,
  standing: QuoteStanding,
  opts: WalletForgetQuoteOptions
): Promise<void> {
  const consequence = forgetConsequence(standing, entry.minting !== undefined);
  if (opts.human && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        `Forgetting mint quote ${entry.quote_id} ${consequence}. Type the quote ID to confirm: `,
        (a) => {
          rl.close();
          resolve(a.trim());
        }
      );
    });
    if (answer !== entry.quote_id) {
      throw new DvmError("cancelled", "Forget cancelled.");
    }
    return;
  }

  throw new DvmError(
    "confirmation_required",
    "Pass --yes to forget in non-interactive mode.",
    `This ${consequence}. Use: dvm wallet forget-quote ${shellQuoteArg(entry.quote_id)} --yes${opts.force ? " --force" : ""}`
  );
}

function forgetConsequence(standing: QuoteStanding, hasSavedOutputs: boolean): string {
  if (hasSavedOutputs) {
    return "removes the saved outputs needed to recover any proofs the mint signed, so this cannot be undone";
  }
  switch (standing.state) {
    case "paid":
    case "issued":
      return "gives up the only record that can collect a payment the mint has already taken, so this cannot be undone";
    case "unchecked":
      return "removes the only record that can collect its payment, without knowing whether it was paid, so this cannot be undone";
    case "gone":
      return "clears a quote the mint no longer honors, so nothing collectable is lost, but this cannot be undone";
    case "unpaid":
      return "means a payment made to its invoice afterwards cannot be collected, so this cannot be undone";
  }
}

function forgottenConsequence(standing: QuoteStanding, hadSavedOutputs: boolean): string {
  if (hadSavedOutputs) {
    return "The saved outputs were removed. Any proofs the mint signed can no longer be recovered by this wallet.";
  }
  switch (standing.state) {
    case "paid":
      return "The mint reported it as paid; that payment can no longer be collected by this wallet.";
    case "issued":
      return "The mint reported it as already issued.";
    case "unchecked":
      return "The mint did not say whether it was paid; a payment for it can no longer be collected by this wallet.";
    case "gone":
      return "The mint no longer honors it, so nothing collectable was given up.";
    case "unpaid":
      return "It was unpaid. Do not pay its invoice now: that payment could not be collected.";
  }
}
