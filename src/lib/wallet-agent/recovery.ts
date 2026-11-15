/**
 * Pending quotes are reconciled before returning the wallet balance. An
 * ISSUED quote with persisted blinded outputs is restored through NUT-09,
 * covering a crash after issuance but before proofs reached disk.
 */

import type { Wallet } from "@cashu/cashu-ts";
import { MintQuoteState } from "@cashu/cashu-ts";

import { getWallet } from "@dvmkit/sdk/internal";
import { computeSmartDenominations } from "@dvmkit/sdk/internal";
import { maxKeysetDenomination, prepareP2PKMint } from "@dvmkit/sdk/internal";
import { retryMintQuoteOperation } from "@dvmkit/sdk/internal";
import { restoreProofsFromOutputs, serializeOutputData } from "@dvmkit/sdk/internal";
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

export type SweepEntryOutcome =
  | { kind: "minted"; entry: PendingMint; proofs: AgentProof[] }
  | { kind: "restored"; entry: PendingMint; proofs: AgentProof[] }
  | { kind: "already_issued"; entry: PendingMint }
  | { kind: "expired"; entry: PendingMint; reason: MintQuoteDropReason }
  | { kind: "still_pending"; entry: PendingMint; past_expiry?: PastExpiry }
  | { kind: "paid_refused"; entry: PendingMint; reason: "quote_expired" }
  | { kind: "error"; entry: PendingMint; error: string };

/**
 * Why an unpaid quote left the pending list. Each needs the mint's own answer:
 * `grace_elapsed` is a mint that still said UNPAID a full grace period after
 * the quote expired, not a local timer alone.
 */
export type MintQuoteDropReason = "mint_unknown" | "mint_expired" | "grace_elapsed";

/** An unpaid quote kept after its expiry, in unix milliseconds. */
export interface PastExpiry {
  expired_at_ms: number;
  drop_after_ms: number;
}

export interface SweepResult {
  outcomes: SweepEntryOutcome[];
  recovered_proofs: AgentProof[];
  still_pending: PendingMint[];
  /** Paid quotes the mint refuses to issue for. Kept, and retried on every sweep. */
  refused: PendingMint[];
  errors: { quote_id: string; error: string }[];
}

export interface SweepOptions {
  now?: () => number;
  /** How long an unpaid quote is kept, and still checked, after its expiry. Default 24 hours. */
  expiryGraceMs?: number;
  getWalletForMint?: (mintUrl: string) => Promise<Wallet>;
  /** Maximum time spent retrying one transient quote-status read. Default 10 seconds. */
  quoteRetryTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_SWEEP_QUOTE_RETRY_TIMEOUT_MS = 10_000;

/**
 * A payment can land after the quote's expiry, and NUT-04 lets a mint credit
 * it, so an expired quote is still checked for this long before it is dropped.
 */
export const MINT_QUOTE_EXPIRY_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Reconcile every entry in `wallet.pending_mints[]` against its mint and
 * persist any state changes. Returns a structured summary so callers can
 * surface what was recovered. Network errors are non-fatal — affected
 * entries are kept on the pending list for the next sweep.
 */
export async function sweepPendingMints(opts: SweepOptions = {}): Promise<SweepResult> {
  const wallet = loadAgentWallet();
  if (!wallet || wallet.pending_mints.length === 0) {
    return { outcomes: [], recovered_proofs: [], still_pending: [], refused: [], errors: [] };
  }

  const now = opts.now ?? (() => Date.now());
  const expiryGraceMs = opts.expiryGraceMs ?? MINT_QUOTE_EXPIRY_GRACE_MS;
  const getWalletForMint = opts.getWalletForMint ?? getWallet;
  const quoteRetryTimeoutMs =
    opts.quoteRetryTimeoutMs ?? DEFAULT_SWEEP_QUOTE_RETRY_TIMEOUT_MS;

  const outcomes: SweepEntryOutcome[] = [];
  for (const entry of wallet.pending_mints) {
    const outcome = await processEntry(wallet, entry, now(), expiryGraceMs, getWalletForMint, {
      now,
      sleep: opts.sleep,
      timeoutMs: quoteRetryTimeoutMs,
    });
    outcomes.push(outcome);
  }

  if (
    outcomes.some(
      (o) =>
        o.kind === "minted" ||
        o.kind === "restored" ||
        o.kind === "already_issued" ||
        o.kind === "expired"
    )
  ) {
    await withWalletLock(() => {
      const fresh = loadAgentWallet() ?? wallet;
      const updated = outcomes.reduce<AgentWallet>(applyOutcome, fresh);
      saveAgentWallet(updated);
    });
  }

  return {
    outcomes,
    recovered_proofs: outcomes.flatMap((o) =>
      o.kind === "minted" || o.kind === "restored" ? o.proofs : []
    ),
    still_pending: outcomes
      .filter(
        (o): o is Extract<SweepEntryOutcome, { kind: "still_pending" }> =>
          o.kind === "still_pending"
      )
      .map((o) => o.entry),
    refused: outcomes.filter((o) => o.kind === "paid_refused").map((o) => o.entry),
    errors: outcomes
      .filter((o): o is Extract<SweepEntryOutcome, { kind: "error" }> => o.kind === "error")
      .map((o) => ({ quote_id: o.entry.quote_id, error: o.error })),
  };
}

async function processEntry(
  wallet: AgentWallet,
  entry: PendingMint,
  nowMs: number,
  expiryGraceMs: number,
  getWalletForMint: (mintUrl: string) => Promise<Wallet>,
  retry: {
    now: () => number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs: number;
  }
): Promise<SweepEntryOutcome> {
  let cashuWallet: Wallet;
  let quoteResponse;
  try {
    ({ cashuWallet, quoteResponse } = await retryMintQuoteOperation(
      async () => {
        const candidate = await getWalletForMint(entry.mint);
        const quote = await candidate.checkMintQuoteBolt11(entry.quote_id);
        return { cashuWallet: candidate, quoteResponse: quote };
      },
      {
        deadlineMs: retry.now() + retry.timeoutMs,
        quoteId: entry.quote_id,
        now: retry.now,
        sleep: retry.sleep,
      }
    ));
  } catch (err) {
    const refusal = mintQuoteRefusal(err);
    if (refusal !== undefined) {
      return {
        kind: "expired",
        entry,
        reason: refusal === "unknown" ? "mint_unknown" : "mint_expired",
      };
    }
    return { kind: "error", entry, error: errorMessage(err) };
  }

  const state: MintQuoteState = quoteResponse.state;

  if (state === MintQuoteState.ISSUED) {
    if (!entry.minting) {
      // Earlier entry, or a true cross-process race where another CLI
      // run already collected and persisted these proofs. No replay material
      // available — drop the entry with the existing explanatory outcome.
      return { kind: "already_issued", entry };
    }
    try {
      const restoredProofs = await restoreFromMintingState(
        cashuWallet,
        entry.minting,
        wallet.lock_pubkey,
        entry.mint
      );
      if (restoredProofs.length === 0) {
        // Mint claims it never signed our outputs (e.g. quote was already
        // restored by a different machine that holds the same recovery
        // mnemonic). Fall back to the legacy drop path.
        return { kind: "already_issued", entry };
      }
      return { kind: "restored", entry, proofs: restoredProofs };
    } catch (err) {
      return { kind: "error", entry, error: errorMessage(err) };
    }
  }

  if (state === MintQuoteState.PAID) {
    try {
      const denominations = computeSmartDenominations(entry.amount_sats, {
        maxDenomination: maxKeysetDenomination(cashuWallet),
        includeTinyTail: false,
      });
      const preview = await prepareP2PKMint(
        cashuWallet,
        entry.amount_sats,
        quoteResponse,
        wallet.lock_privkey,
        wallet.lock_pubkey,
        denominations
      );
      // Persist the blinded outputs before completing the mint so a crash
      // here is recoverable on the next sweep via the ISSUED+minting branch
      // above. Mirrors the fund-flow ordering in `fundAgentWallet`. Lock-
      // wrapped so a concurrent CLI run doesn't clobber other in-flight
      // RMW cycles.
      const minting: PendingMintMintingState = {
        keyset_id: preview.keysetId,
        outputs: serializeOutputData(preview.outputData),
      };
      await withWalletLock(() => {
        const fresh = loadAgentWallet() ?? wallet;
        saveAgentWallet({
          ...fresh,
          pending_mints: fresh.pending_mints.map((p) =>
            p.quote_id === entry.quote_id ? { ...p, minting } : p
          ),
        });
      });

      const proofs = await cashuWallet.completeMint(preview);
      const agentProofs = proofs.map((p) => toAgentProof(p, entry.mint, wallet.lock_pubkey));
      return { kind: "minted", entry, proofs: agentProofs };
    } catch (err) {
      // The mint took the payment and will not issue for it. Keeping the entry
      // is the only record of that money, and a later sweep asks again.
      if (mintQuoteRefusal(err) === "expired") {
        return { kind: "paid_refused", entry, reason: "quote_expired" };
      }
      return { kind: "error", entry, error: errorMessage(err) };
    }
  }

  // Not a NUT-04 state, but a mint that names one has given its final answer.
  if ((state as string) === "EXPIRED") {
    return { kind: "expired", entry, reason: "mint_expired" };
  }

  // UNPAID. The quote ID is the only handle that can mint a late payment, so
  // no local timer drops it: a quote without an expiry stays until the mint
  // gives a final answer or the caller forgets it, and an expired one is kept
  // through the grace period while the mint keeps being asked.
  const quoteExpiry = entry.expires_at;
  if (quoteExpiry === undefined || !Number.isFinite(quoteExpiry)) {
    return { kind: "still_pending", entry };
  }
  const expiredAtMs = quoteExpiry * 1000;
  if (nowMs <= expiredAtMs) {
    return { kind: "still_pending", entry };
  }
  const dropAfterMs = expiredAtMs + expiryGraceMs;
  if (nowMs > dropAfterMs) {
    return { kind: "expired", entry, reason: "grace_elapsed" };
  }
  return {
    kind: "still_pending",
    entry,
    past_expiry: { expired_at_ms: expiredAtMs, drop_after_ms: dropAfterMs },
  };
}

/** NUT error code a mint returns for a quote past its expiry. */
const MINT_QUOTE_EXPIRED_CODE = 20007;
// Both name the quote: a bare "Not Found" is also what a moved or
// misconfigured mint API answers for every route, and that must not read as
// the mint disowning a quote.
const QUOTE_UNKNOWN_TEXT =
  /\bquote\b[^.]*\b(not found|unknown|does not exist)\b|\b(unknown|no such) quote\b/i;
const QUOTE_EXPIRED_TEXT = /\bquote\b[^.]*\bexpired\b|\bexpired quote\b/i;

/**
 * A mint's definite answer that a quote is gone, as opposed to a mint that
 * could not answer. Only a 4xx reply counts, so an outage, a rate limit or a
 * failure inside this CLI never reads as the quote being lost. Duck-typed on
 * cashu-ts's `name` and `status`: the bundle can carry more than one copy of
 * the error classes.
 */
export function mintQuoteRefusal(err: unknown): "unknown" | "expired" | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const { name, status, code, message } = err as {
    name?: unknown;
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const answered =
    name === "MintOperationError" ||
    (typeof status === "number" && status >= 400 && status < 500 && status !== 429);
  if (!answered) return undefined;
  const text = typeof message === "string" ? message : "";
  if (code === MINT_QUOTE_EXPIRED_CODE || QUOTE_EXPIRED_TEXT.test(text)) return "expired";
  if (QUOTE_UNKNOWN_TEXT.test(text)) return "unknown";
  return undefined;
}

async function restoreFromMintingState(
  cashuWallet: Wallet,
  minting: PendingMintMintingState,
  lockPubkey: string,
  mintUrl: string
): Promise<AgentProof[]> {
  const proofs = await restoreProofsFromOutputs(cashuWallet, minting.keyset_id, minting.outputs);
  return proofs.map((proof) => toAgentProof(proof, mintUrl, lockPubkey));
}

function applyOutcome(wallet: AgentWallet, outcome: SweepEntryOutcome): AgentWallet {
  if (
    outcome.kind === "still_pending" ||
    outcome.kind === "paid_refused" ||
    outcome.kind === "error"
  ) {
    return wallet;
  }
  const next: AgentWallet = {
    ...wallet,
    pending_mints: wallet.pending_mints.filter((p) => p.quote_id !== outcome.entry.quote_id),
  };
  if (outcome.kind === "minted" || outcome.kind === "restored") {
    next.proofs = [...wallet.proofs, ...outcome.proofs];
  }
  return next;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
