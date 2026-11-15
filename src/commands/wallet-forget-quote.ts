/**
 * `dvm wallet forget-quote <quote-id>`: deliberately stop tracking one pending
 * funding invoice.
 *
 * The reconcile sweep never drops an unpaid quote on a local timer, because the
 * quote ID is the only handle that can mint a late payment. That leaves a quote
 * whose mint named no expiry pending until someone decides it is dead, and this
 * is the verb for that decision. It asks the mint first: forgetting a quote the
 * mint reports as paid, or one it could not report on, gives up money that
 * `dvm wallet show` could still collect, so both take a separate `--force`.
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
import { withoutPendingMint } from "../lib/wallet-agent/fund";
import { classifyMintError, type MintFailureCause } from "../lib/wallet-agent/fund-wait";
import { mintQuoteRefusal } from "../lib/wallet-agent/recovery";

export interface WalletForgetQuoteOptions {
  /** Skip the confirmation prompt. Required to forget non-interactively. */
  yes?: boolean;
  /**
   * Forget a quote that is paid, or whose state the mint did not report.
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
  if (!entry) {
    throw new DvmError(
      "mint_quote_not_found",
      `No pending mint quote with ID "${quoteId}".`,
      "List pending quotes with: dvm wallet show"
    );
  }

  const standing = await quoteStanding(entry);
  refuseIfCollectable(entry, standing, opts);
  await confirmForget(entry, standing, opts);

  await withWalletLock(() => {
    const fresh = loadAgentWallet() ?? wallet;
    saveAgentWallet(withoutPendingMint(fresh, quoteId));
  });

  const display = `Forgot mint quote ${quoteId} (${entry.amount_sats} sats at ${entry.mint}). ${forgottenConsequence(standing)}`;
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

async function quoteStanding(entry: PendingMint): Promise<QuoteStanding> {
  try {
    const cashuWallet = await getWallet(entry.mint);
    const quote = await cashuWallet.checkMintQuoteBolt11(entry.quote_id);
    if (quote.state === MintQuoteState.PAID) return { state: "paid" };
    if (quote.state === MintQuoteState.ISSUED) return { state: "issued" };
    if (quote.state === MintQuoteState.UNPAID) return { state: "unpaid" };
    return { state: "gone" };
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

  // An issued quote with no saved outputs has nothing left to recover; one
  // with them is a crash the next sweep restores from.
  const collectable =
    standing.state === "paid" || (standing.state === "issued" && entry.minting !== undefined);
  if (collectable) {
    throw new DvmError(
      "mint_quote_collectable",
      `Mint quote ${entry.quote_id} is paid: ${entry.amount_sats} sats at ${entry.mint} are waiting to be collected.`,
      `Run \`dvm wallet show\` to collect them. Forgetting the quote gives up the only record that can; if the mint keeps refusing to issue and you accept that, add --force: ${forced}`
    );
  }
  if (standing.state === "unchecked") {
    throw new DvmError(
      "mint_quote_unchecked",
      `The mint did not say whether mint quote ${entry.quote_id} has been paid, so forgetting it could lose a payment.`,
      `Try again once the mint answers. To forget it without knowing, add --force: ${forced}`,
      { cause: standing.cause, retryable: standing.cause !== "unexpected" }
    );
  }
}

async function confirmForget(
  entry: PendingMint,
  standing: QuoteStanding,
  opts: WalletForgetQuoteOptions
): Promise<void> {
  if (opts.yes) return;

  const consequence = forgetConsequence(standing);
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

function forgetConsequence(standing: QuoteStanding): string {
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

function forgottenConsequence(standing: QuoteStanding): string {
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
