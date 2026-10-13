import { prepareP2PKMint, maxKeysetDenomination } from "@dvmkit/sdk/internal";
/**
 * NUT-20 quotes bind issuance to the wallet key. Persist the quote before
 * payment and its blinded outputs before issuance so a crash can resume or
 * restore the mint without losing funds.
 */

import type { MintQuoteBolt11Response, Wallet } from "@cashu/cashu-ts";
import { MintQuoteState } from "@cashu/cashu-ts";

import { getWallet } from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";
import { type FloatPayment, floatPaymentJson } from "../float";
import { computeSmartDenominations } from "@dvmkit/sdk/internal";
import {
  createMintQuoteRetryState,
  retryMintQuoteOperation,
} from "@dvmkit/sdk/internal";
import { serializeOutputData } from "@dvmkit/sdk/internal";
import { toAgentProof } from "@dvmkit/sdk/internal";
import {
  type AgentProof,
  type AgentWallet,
  loadAgentWallet,
  type PendingMint,
  type PendingMintMintingState,
  saveAgentWallet,
  withWalletLock,
} from "@dvmkit/sdk/internal";

export interface FundResult {
  mint: string;
  amount_sats: number;
  quote_id: string;
  denominations: number[];
  proofs: AgentProof[];
  /** Set when the invoice was paid autonomously from the Lightning float. */
  float_payment?: FloatPayment;
}

export interface FundOptions {
  mintUrl: string;
  /** Total ms before polling gives up. Default `DVM_FUND_TIMEOUT_SEC` × 1000. */
  timeoutMs?: number;
  /** Poll interval in ms. Default 2000. */
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called once with the bolt11 string after persistence so the CLI can render the QR. */
  onInvoice?: (invoice: string, quote: MintQuoteBolt11Response) => void | Promise<void>;
  /**
   * Pay the mint's invoice from the caller's Lightning float.
   *
   * When supplied, funding is autonomous: no invoice is relayed and no human is
   * asked. When absent — no float connected, or `--no-float` — the flow falls
   * back to {@link onInvoice} and waits for someone to pay.
   *
   * Called *after* the `PendingMint` is persisted, so a crash between the
   * Lightning payment and the mint's issuance is recoverable by the NUT-09
   * sweep rather than losing the sats.
   */
  payInvoice?: (invoice: string, quote: MintQuoteBolt11Response) => Promise<FloatPayment>;
  /** Called after the float settles the invoice, so the CLI can report it. */
  onFloatPayment?: (payment: FloatPayment) => void | Promise<void>;
  /**
   * Skip the Lightning payment step — for test mints (e.g. the local FakeWallet
   * mint) that auto-settle their own invoices. The minting flow is unchanged:
   * the existing {@link pollUntilPaidOrTimeout} loop observes the mint's
   * auto-settlement. The flag exists so the CLI can suppress the
   * "pay this invoice" prompt and signal test intent. Never set this
   * against a production mint — the quote will never settle.
   */
  testSkipLightning?: boolean;
  onPoll?: (state: MintQuoteState, elapsedMs: number) => void;
  getWalletForMint?: (mintUrl: string) => Promise<Wallet>;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_SEC = 600;

/**
 * Run the full Lightning → Cashu fund flow for the agent wallet. Persists
 * the in-flight `PendingMint` before payment is observed and the
 * pre-built blinded outputs (`PendingMint.minting`) before the mint signs
 * them, so a CLI crash mid-flow can be recovered by {@link sweepPendingMints}
 * on the next run.
 */
export async function fundAgentWallet(amountSats: number, opts: FundOptions): Promise<FundResult> {
  if (!Number.isFinite(amountSats) || amountSats <= 0) {
    throw new DvmError(
      "invalid_amount",
      "Amount must be a positive integer number of sats.",
      "Pass a positive sats amount, e.g. `dvm wallet fund 1000`, or a USD amount, e.g. `dvm wallet fund $5`."
    );
  }
  const sats = Math.floor(amountSats);

  const initial = loadAgentWallet();
  if (!initial) {
    throw new DvmError(
      "wallet_missing",
      "No agent wallet found.",
      "Run `dvm wallet init` first to generate a lock keypair."
    );
  }

  const cashuWallet = await (opts.getWalletForMint ?? getWallet)(opts.mintUrl);
  const quote = await cashuWallet.createLockedMintQuote(sats, initial.lock_pubkey);

  const pending: PendingMint = {
    mint: opts.mintUrl,
    quote_id: quote.quote,
    amount_sats: sats,
    requested_at: new Date().toISOString(),
    ...(quote.expiry === null ? {} : { expires_at: quote.expiry }),
  };
  await withWalletLock(() => {
    const fresh = loadAgentWallet() ?? initial;
    saveAgentWallet({
      ...fresh,
      pending_mints: [...fresh.pending_mints, pending],
    });
  });

  // Three ways this invoice gets paid, in priority order:
  //
  // 1. `testSkipLightning` — a test mint settles its own invoices, so
  // nobody pays anything and the poll loop just observes it.
  // 2. A connected Lightning float pays it, with no human in the loop. The
  // `PendingMint` above is already on disk, so a crash between this payment
  // and the mint's issuance is recovered by `sweepPendingMints`, not lost.
  // 3. Nothing configured — relay the invoice and wait for a human.
  let floatPayment: FloatPayment | undefined;
  if (opts.testSkipLightning) {
  } else if (opts.payInvoice) {
    floatPayment = await opts.payInvoice(quote.request, quote);
    if (opts.onFloatPayment) await opts.onFloatPayment(floatPayment);
  } else if (opts.onInvoice) {
    await opts.onInvoice(quote.request, quote);
  }

  const finalState = await pollUntilPaidOrTimeout(cashuWallet, quote.quote, opts);
  if (finalState === MintQuoteState.ISSUED) {
    // Rare race: a concurrent `dvm wallet …` invocation against the same
    // wallet file already collected this quote's proofs. Distinguish from a
    // timeout so the operator/agent doesn't think they need to (re)pay.
    throw new DvmError(
      "fund_already_issued",
      `Mint quote ${quote.quote} was already collected by a concurrent run.`,
      "Inspect wallet state with `dvm wallet show` — the proofs should be persisted by the other instance."
    );
  }
  if (finalState !== MintQuoteState.PAID) {
    // A float payment that settled but never reached the mint is money in
    // flight, not money lost — say so, because the recovery move differs from
    // "nobody paid the invoice".
    throw new DvmError(
      "fund_timeout",
      floatPayment
        ? `Your Lightning wallet paid mint quote ${quote.quote}, but the mint has not credited it yet.`
        : `Mint quote ${quote.quote} was not paid within the fund timeout.`,
      floatPayment
        ? "Run `dvm wallet show` — the pending mint is on disk and will be collected once the mint catches up."
        : "Pay the invoice from a Lightning wallet, then run `dvm wallet show` to recover the pending mint, or `dvm wallet fund <amount>` to start a new flow.",
      floatPayment
        ? {
            display:
              "Your Lightning wallet sent the payment but the mint hasn't credited it yet. The sats aren't lost — run 'dvm wallet show' and they'll be collected once the mint catches up.",
            float_payment: floatPaymentJson(floatPayment),
          }
        : undefined
    );
  }

  const denominations = computeSmartDenominations(sats, {
    maxDenomination: maxKeysetDenomination(cashuWallet),
    includeTinyTail: false,
  });
  const preview = await prepareP2PKMint(
    cashuWallet,
    sats,
    quote,
    initial.lock_privkey,
    initial.lock_pubkey,
    denominations
  );
  const minting: PendingMintMintingState = {
    keyset_id: preview.keysetId,
    outputs: serializeOutputData(preview.outputData),
  };
  // Persist the blinded outputs before posting to the mint so a crash
  // here is recoverable on the next sweep via the ISSUED+minting branch.
  // Wrapped in `withWalletLock` and `upsertPending` re-adds our
  // entry if a concurrent run dropped it — preserves the recovery handle.
  await withWalletLock(() => {
    const fresh = loadAgentWallet() ?? initial;
    saveAgentWallet(upsertPending(fresh, { ...pending, minting }));
  });

  const proofs = await cashuWallet.completeMint(preview);
  const agentProofs = proofs.map((p) => toAgentProof(p, opts.mintUrl, initial.lock_pubkey));
  await withWalletLock(() => {
    const post = loadAgentWallet() ?? initial;
    saveAgentWallet({
      ...post,
      proofs: [...post.proofs, ...agentProofs],
      pending_mints: post.pending_mints.filter((p) => p.quote_id !== quote.quote),
    });
  });

  return {
    mint: opts.mintUrl,
    amount_sats: sats,
    quote_id: quote.quote,
    denominations,
    proofs: agentProofs,
    ...(floatPayment ? { float_payment: floatPayment } : {}),
  };
}

/** Read `DVM_FUND_TIMEOUT_SEC` from process.env, falling back to 10 minutes. */
export function fundTimeoutMs(): number {
  const raw = process.env.DVM_FUND_TIMEOUT_SEC;
  if (!raw) return DEFAULT_TIMEOUT_SEC * 1_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_SEC * 1_000;
  return Math.floor(n) * 1_000;
}

export function withoutPendingMint(wallet: AgentWallet, quoteId: string): AgentWallet {
  return { ...wallet, pending_mints: wallet.pending_mints.filter((p) => p.quote_id !== quoteId) };
}

function upsertPending(wallet: AgentWallet, entry: PendingMint): AgentWallet {
  const others = wallet.pending_mints.filter((p) => p.quote_id !== entry.quote_id);
  return { ...wallet, pending_mints: [...others, entry] };
}

export interface PollUntilPaidOptions {
  /** Override the total timeout (ms). */
  timeoutMs?: number;
  /** Override the poll interval (ms). */
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onPoll?: (state: MintQuoteState, elapsedMs: number) => void;
}

export async function pollUntilPaidOrTimeout(
  cashuWallet: Wallet,
  quoteId: string,
  opts: PollUntilPaidOptions
): Promise<MintQuoteState> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const intervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? fundTimeoutMs();

  const start = now();
  const deadline = start + timeoutMs;
  const retryState = createMintQuoteRetryState();
  let lastState: MintQuoteState = MintQuoteState.UNPAID;
  while (now() < deadline) {
    const checked = await retryMintQuoteOperation(
      () => cashuWallet.checkMintQuoteBolt11(quoteId),
      {
        deadlineMs: deadline,
        quoteId,
        state: retryState,
        now,
        sleep,
      }
    );
    lastState = checked.state;
    if (opts.onPoll) opts.onPoll(lastState, now() - start);
    if (lastState === MintQuoteState.PAID || lastState === MintQuoteState.ISSUED) {
      return lastState;
    }
    const remainingMs = deadline - now();
    if (remainingMs > 0) await sleep(Math.min(intervalMs, remainingMs));
  }
  return lastState;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
