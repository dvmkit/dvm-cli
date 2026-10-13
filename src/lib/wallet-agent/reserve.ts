/**
 * Pre-fund-per-builder mint flow for the agent wallet.
 *
 * `dvm wallet reserve --builder <handle> $X --locktime Nd` mints proofs
 * P2PK-locked to the builder DVM's lock pubkey with a NUT-11 `locktime` +
 * `refund` tag. The refund pubkey is the agent's per-DVM refund subkey
 * derived from the wallet mnemonic + the DVM's
 * `cashu.canonical_id`. Pre-`t_expire`, only the builder can spend; post-
 * `t_expire`, the agent's refund subkey gains a parallel ability to spend
 * (driven by `dvm wallet release`).
 *
 * The flow mirrors {@link fundAgentWallet}'s persist-before-mint discipline
 * so a CLI crash mid-flow is recovered transparently by
 * {@link sweepPendingMints} on the next run — the only difference is the
 * outputs carry locktime + refund, and the persisted proofs carry
 * `reserved_for` + `t_expire`.
 */

import type { MintQuoteBolt11Response, Wallet } from "@cashu/cashu-ts";
import { MintQuoteState } from "@cashu/cashu-ts";

import { deriveAgentRefundSubkeyPubkey } from "@dvmkit/sdk/internal";
import { getWallet } from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";
import type { ProviderInfo } from "@dvmkit/sdk/internal";
import { readAgentMnemonic } from "@dvmkit/sdk/internal";
import { reservedForMarker } from "./builder-handle";
import { computeSmartDenominations } from "@dvmkit/sdk/internal";
import { fundTimeoutMs, pollUntilPaidOrTimeout } from "./fund";
import { maxKeysetDenomination, prepareP2PKMint } from "@dvmkit/sdk/internal";
import { DEFAULT_RESERVE_LOCKTIME_SECONDS } from "./locktime";
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

export interface ReserveResult {
  mint: string;
  /** Total reserve amount, in sats. */
  amount_sats: number;
  quote_id: string;
  /** Smart denomination split, in sats. */
  denominations: number[];
  proofs: AgentProof[];
  builder_handle: string;
  /** NUT-11 locktime expiry as wall-clock ms — when refund becomes spendable. */
  t_expire_ms: number;
  refund_pubkey: string;
  lock_pubkey: string;
}

export interface ReserveOptions {
  mintUrl: string;
  builderHandle: string;
  /** Locktime in seconds; defaults to {@link DEFAULT_RESERVE_LOCKTIME_SECONDS}. */
  locktimeSeconds?: number;
  /** Provider /v1/info — required for the lock pubkey + canonical_id + allowlist. */
  providerInfo: ProviderInfo;
  /** Override fund timeout (ms). */
  timeoutMs?: number;
  /** Override poll interval (ms). */
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onInvoice?: (invoice: string, quote: MintQuoteBolt11Response) => void | Promise<void>;
  onPoll?: (state: MintQuoteState, elapsedMs: number) => void;
  getWalletForMint?: (mintUrl: string) => Promise<Wallet>;
  readMnemonic?: () => string | null;
}

/**
 * Run the full Lightning → Cashu pre-fund-per-builder flow. Persists the
 * in-flight {@link PendingMint} before payment is observed and the
 * pre-built blinded outputs before the mint signs, so a CLI crash mid-flow
 * is recovered by {@link sweepPendingMints} on the next run.
 *
 * The outputs carry a NUT-11 locktime + refund tag (refund pubkey = the
 * agent's per-DVM refund subkey). The resulting proofs are persisted with
 * `reserved_for: "builder/<handle>"` and `t_expire: <unix_ms>` so the
 * spend-time path can auto-select them over per-call swap, and so
 * {@link releaseAgentReserve} can identify them after `t_expire`.
 */
export async function reserveAgentWallet(
  amountSats: number,
  opts: ReserveOptions
): Promise<ReserveResult> {
  if (!Number.isFinite(amountSats) || amountSats <= 0) {
    throw new DvmError(
      "invalid_amount",
      "Amount must be a positive integer number of sats.",
      "Pass a positive sats amount, e.g. `dvm wallet reserve --builder scrape.dvmkit.ai 1000`, or a USD amount, e.g. `dvm wallet reserve --builder scrape.dvmkit.ai $5`."
    );
  }
  const sats = Math.floor(amountSats);

  const cashu = opts.providerInfo.cashu;
  if (!cashu) {
    throw new DvmError(
      "missing_cashu_info",
      "DVM does not advertise a `cashu` object on /v1/info.",
      "Reserve requires the builder to expose lock_pubkeys, mints, and canonical_id. Check the builder is running an SDK that supports pre-fund."
    );
  }
  const lockPubkey = cashu.lock_pubkeys[0];
  if (!lockPubkey) {
    throw new DvmError(
      "missing_lock_pubkey",
      "DVM advertised no current lock pubkey.",
      "Ask the builder operator to deploy with DVMKIT_CASHU_LOCK_PUBKEY set."
    );
  }
  if (cashu.mints.length === 0) {
    throw new DvmError(
      "missing_dvm_mints",
      "DVM advertises no accepted Cashu mints.",
      "Ask the builder operator to set DVMKIT_CASHU_MINTS on the DVM machine."
    );
  }
  if (!cashu.canonical_id) {
    throw new DvmError(
      "missing_canonical_id",
      "DVM advertises no `cashu.canonical_id` on /v1/info.",
      "Pre-fund requires canonical_id so the agent can derive a per-DVM refund subkey. Upgrade the builder SDK to one that advertises it."
    );
  }
  if (!cashu.mints.includes(opts.mintUrl)) {
    throw new DvmError(
      "mint_not_accepted",
      `Mint ${opts.mintUrl} is not in the builder's allowlist (${cashu.mints.join(", ")}).`,
      `Re-run with --mint set to one of the builder's accepted mints, or top up at one of them first.`
    );
  }
  const locktimeSeconds = opts.locktimeSeconds ?? DEFAULT_RESERVE_LOCKTIME_SECONDS;
  if (cashu.min_locktime && locktimeSeconds < cashu.min_locktime) {
    throw new DvmError(
      "locktime_too_short",
      `Requested locktime ${locktimeSeconds}s is below the builder's minimum ${cashu.min_locktime}s.`,
      `Re-run with --locktime at or above the builder's minimum (${cashu.min_locktime}s).`
    );
  }

  const initial = loadAgentWallet();
  if (!initial) {
    throw new DvmError(
      "wallet_missing",
      "No agent wallet found.",
      "Run `dvm wallet init` first to generate a wallet."
    );
  }

  const readMnemonic = opts.readMnemonic ?? readAgentMnemonic;
  const mnemonic = readMnemonic();
  if (!mnemonic) {
    throw new DvmError(
      "mnemonic_required",
      "Reserve requires a BIP-39 mnemonic at ~/.dvm/wallet.mnemonic.",
      "The per-DVM refund subkey is derived from the mnemonic, so `dvm wallet release` post-expire requires it. Run `dvm wallet init` (fresh wallet) or `dvm wallet recover --force --file <path>` (or pipe the mnemonic via stdin) to attach the mnemonic file."
    );
  }
  const refundPubkey = deriveAgentRefundSubkeyPubkey(mnemonic, cashu.canonical_id);

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

  if (opts.onInvoice) await opts.onInvoice(quote.request, quote);

  const finalState = await pollUntilPaidOrTimeout(cashuWallet, quote.quote, {
    timeoutMs: opts.timeoutMs ?? fundTimeoutMs(),
    pollIntervalMs: opts.pollIntervalMs,
    now: opts.now,
    sleep: opts.sleep,
    onPoll: opts.onPoll,
  });
  if (finalState === MintQuoteState.ISSUED) {
    throw new DvmError(
      "reserve_already_issued",
      `Mint quote ${quote.quote} was already collected by a concurrent run.`,
      "Inspect wallet state with `dvm wallet show` — the proofs should be persisted by the other instance."
    );
  }
  if (finalState !== MintQuoteState.PAID) {
    throw new DvmError(
      "reserve_timeout",
      `Mint quote ${quote.quote} was not paid within the reserve timeout.`,
      "Pay the invoice from a Lightning wallet, then run `dvm wallet show` to recover the pending mint, or `dvm wallet reserve` to start a new flow."
    );
  }

  const denominations = computeSmartDenominations(sats, {
    maxDenomination: maxKeysetDenomination(cashuWallet),
  });
  const nowMs = (opts.now ?? Date.now)();
  const tExpireSeconds = Math.floor(nowMs / 1000) + locktimeSeconds;
  const tExpireMs = tExpireSeconds * 1000;
  const preview = await prepareP2PKMint(
    cashuWallet,
    sats,
    quote,
    initial.lock_privkey,
    lockPubkey,
    denominations,
    { locktimeUnixSec: tExpireSeconds, refundKeys: [refundPubkey] }
  );
  const minting: PendingMintMintingState = {
    keyset_id: preview.keysetId,
    outputs: serializeOutputData(preview.outputData),
  };
  await withWalletLock(() => {
    const fresh = loadAgentWallet() ?? initial;
    saveAgentWallet(upsertPending(fresh, { ...pending, minting }));
  });

  const reservedFor = reservedForMarker(opts.builderHandle);
  const proofs = await cashuWallet.completeMint(preview);
  const agentProofs = proofs.map((p) =>
    toAgentProof(p, opts.mintUrl, lockPubkey, {
      reservedFor,
      tExpireMs,
    })
  );
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
    builder_handle: opts.builderHandle,
    t_expire_ms: tExpireMs,
    refund_pubkey: refundPubkey,
    lock_pubkey: lockPubkey,
  };
}

function upsertPending(wallet: AgentWallet, entry: PendingMint): AgentWallet {
  const others = wallet.pending_mints.filter((p) => p.quote_id !== entry.quote_id);
  return { ...wallet, pending_mints: [...others, entry] };
}
