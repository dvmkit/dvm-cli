/**
 * Pending quotes are reconciled before returning the wallet balance. An
 * ISSUED quote with persisted blinded outputs is restored through NUT-09,
 * covering a crash after issuance but before proofs reached disk.
 */

import { createHash } from "node:crypto";
import { setTimeout as sleepFor } from "node:timers/promises";

import type { Wallet } from "@cashu/cashu-ts";
import { MintQuoteState } from "@cashu/cashu-ts";
import lockfile from "proper-lockfile";

import { DvmError } from "@dvmkit/sdk/internal";
import { getWallet } from "@dvmkit/sdk/internal";
import { computeSmartDenominations } from "@dvmkit/sdk/internal";
import { maxKeysetDenomination, prepareP2PKMint } from "@dvmkit/sdk/internal";
import { retryMintQuoteOperation } from "@dvmkit/sdk/internal";
import { rehydrateOutputData, restoreProofsFromOutputs, serializeOutputData } from "@dvmkit/sdk/internal";
import { toAgentProof } from "@dvmkit/sdk/internal";
import {
  type AgentProof,
  type AgentWallet,
  loadAgentWallet,
  type PendingMint,
  type PendingMintMintingState,
  saveAgentWallet,
  WALLET_FILE,
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

type PendingMintOutcome =
  | Exclude<SweepEntryOutcome, { kind: "error" }>
  | { kind: "error"; entry: PendingMint; cause: unknown }
  | { kind: "busy" }
  | { kind: "no_longer_pending" };

interface PendingMintOptions extends SweepOptions {
  /** Stop starting or retrying quote-status reads at this time. */
  pollDeadlineMs?: number;
  /** Bound wallet lock acquisition when collection has a caller deadline. */
  deadlineMs?: number;
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

  const outcomes: SweepEntryOutcome[] = [];
  for (const entry of wallet.pending_mints) {
    const outcome = await reconcilePendingMint(entry, opts);
    if (outcome.kind === "no_longer_pending") continue;
    if (outcome.kind === "busy") {
      outcomes.push({ kind: "error", entry, error: "Another command is checking this mint quote." });
    } else if (outcome.kind === "error") {
      outcomes.push({ kind: "error", entry: outcome.entry, error: errorMessage(outcome.cause) });
    } else {
      outcomes.push(outcome);
    }
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

export async function reconcilePendingMint(
  entry: PendingMint,
  opts: PendingMintOptions = {}
): Promise<PendingMintOutcome> {
  // A quote lock covers status, issuance and commit. Wallet writes still take
  // the wallet lock, which stays available while the mint is answering.
  const key = createHash("sha256").update(JSON.stringify([entry.mint, entry.quote_id])).digest("hex");
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(`${WALLET_FILE}.mint-${key}`, { realpath: false, stale: 30_000, retries: 0 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOCKED") return { kind: "busy" };
    return { kind: "error", entry, cause: err };
  }

  try {
    const wallet = loadAgentWallet();
    const current = wallet?.pending_mints.find((pending) => matchesPendingMint(pending, entry));
    if (!wallet || !current) return { kind: "no_longer_pending" };

    const outcome = await processEntry(wallet, current, opts);

    if (outcome.kind === "minted" || outcome.kind === "restored" ||
        outcome.kind === "already_issued" || outcome.kind === "expired") {
      const committed = await withMintWriteLock(opts.deadlineMs, () => {
        const fresh = currentMintWallet(wallet, current);
        if (!fresh) return false;
        const proofs = outcome.kind === "minted" || outcome.kind === "restored" ? outcome.proofs : [];
        saveAgentWallet({
          ...fresh,
          pending_mints: fresh.pending_mints.filter((pending) => !matchesPendingMint(pending, current)),
          proofs: [...fresh.proofs, ...proofs],
        });
        return true;
      });
      if (!committed) return { kind: "no_longer_pending" };
    }
    return outcome;
  } catch (err) {
    return { kind: "error", entry, cause: err };
  } finally {
    await release().catch(() => undefined);
  }
}

function matchesPendingMint(left: PendingMint, right: PendingMint): boolean {
  return left.mint === right.mint && left.quote_id === right.quote_id && left.requested_at === right.requested_at;
}

function currentMintWallet(wallet: AgentWallet, entry: PendingMint): AgentWallet | undefined {
  const fresh = loadAgentWallet();
  if (fresh?.lock_pubkey === wallet.lock_pubkey && fresh.pending_mints.some((pending) => matchesPendingMint(pending, entry))) {
    return fresh;
  }
}

async function withMintWriteLock<T>(deadlineMs: number | undefined, write: () => T): Promise<T> {
  if (deadlineMs === undefined) return withWalletLock(write);
  for (;;) {
    try {
      return await withWalletLock(write, { retries: 0 });
    } catch (err) {
      const remaining = deadlineMs - Date.now();
      if (!(err instanceof DvmError && err.code === "wallet_locked") || remaining <= 0) throw err;
      await sleepFor(Math.min(remaining, 50));
    }
  }
}

async function processEntry(
  wallet: AgentWallet,
  entry: PendingMint,
  opts: PendingMintOptions
): Promise<Exclude<PendingMintOutcome, { kind: "busy" }>> {
  const now = opts.now ?? Date.now;
  const nowMs = now();
  if (opts.pollDeadlineMs !== undefined && nowMs >= opts.pollDeadlineMs) {
    return { kind: "still_pending", entry };
  }
  const getWalletForMint = opts.getWalletForMint ?? getWallet;
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
        deadlineMs: Math.min(
          opts.pollDeadlineMs ?? Infinity,
          nowMs + (opts.quoteRetryTimeoutMs ?? DEFAULT_SWEEP_QUOTE_RETRY_TIMEOUT_MS)
        ),
        quoteId: entry.quote_id,
        now,
        sleep: opts.sleep,
      }
    ));
  } catch (err) {
    const refusal = mintQuoteRefusal(err);
    if (refusal !== undefined) {
      return finalAnswer(wallet, entry, refusal === "unknown" ? "mint_unknown" : "mint_expired", () =>
        getWalletForMint(entry.mint)
      );
    }
    return { kind: "error", entry, cause: err };
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
      return { kind: "error", entry, cause: err };
    }
  }

  if (state === MintQuoteState.PAID) {
    try {
      let savedMinting = entry.minting;
      if (savedMinting && cashuWallet.keyChain.getKeysets().some((keyset) =>
        keyset.id === savedMinting?.keyset_id && keyset.isActive === false
      )) {
        // A retired keyset cannot sign new outputs. Check whether it signed
        // the journaled ones before replacing them with active-keyset outputs.
        await cashuWallet.ensureOperableKeysets([savedMinting.keyset_id]);
        const proofs = await restoreFromMintingState(cashuWallet, savedMinting, wallet.lock_pubkey, entry.mint);
        if (proofs.length > 0) return { kind: "restored", entry, proofs };
        savedMinting = undefined;
      }
      // A prior attempt can still be in flight at the mint after a lost
      // response. Reuse its blinded outputs even if the quote still says PAID.
      const preview = savedMinting
        ? await cashuWallet.prepareMint(
            "bolt11", entry.amount_sats, quoteResponse,
            { privkey: wallet.lock_privkey, keysetId: savedMinting.keyset_id },
            { type: "custom", data: rehydrateOutputData(savedMinting.outputs) }
          )
        : await prepareP2PKMint(
            cashuWallet, entry.amount_sats, quoteResponse, wallet.lock_privkey, wallet.lock_pubkey,
            computeSmartDenominations(entry.amount_sats, {
              maxDenomination: maxKeysetDenomination(cashuWallet), includeTinyTail: false,
            })
          );
      if (!savedMinting) {
        const minting: PendingMintMintingState = {
          keyset_id: preview.keysetId,
          outputs: serializeOutputData(preview.outputData),
        };
        const saved = await withMintWriteLock(opts.deadlineMs, () => {
          const fresh = currentMintWallet(wallet, entry);
          if (!fresh) return false;
          saveAgentWallet({
            ...fresh,
            pending_mints: fresh.pending_mints.map((p) => matchesPendingMint(p, entry) ? { ...p, minting } : p),
          });
          return true;
        });
        if (!saved) return { kind: "no_longer_pending" };
      }

      const proofs = await cashuWallet.completeMint(preview);
      const agentProofs = proofs.map((p) => toAgentProof(p, entry.mint, wallet.lock_pubkey));
      return { kind: "minted", entry, proofs: agentProofs };
    } catch (err) {
      // The mint took the payment and will not issue for it. Keeping the entry
      // is the only record of that money, and a later sweep asks again.
      if (mintQuoteRefusal(err) === "expired") {
        return { kind: "paid_refused", entry, reason: "quote_expired" };
      }
      return { kind: "error", entry, cause: err };
    }
  }

  // Not a NUT-04 state, but a mint that names one has given its final answer.
  if ((state as string) === "EXPIRED") {
    return finalAnswer(wallet, entry, "mint_expired", async () => cashuWallet);
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
  const dropAfterMs = expiredAtMs + (opts.expiryGraceMs ?? MINT_QUOTE_EXPIRY_GRACE_MS);
  if (nowMs > dropAfterMs) {
    return finalAnswer(wallet, entry, "grace_elapsed", async () => cashuWallet);
  }
  return {
    kind: "still_pending",
    entry,
    past_expiry: { expired_at_ms: expiredAtMs, drop_after_ms: dropAfterMs },
  };
}

/**
 * Acts on the mint's answer that a quote is finished. Saved outputs mean an
 * earlier sweep saw the quote paid and may have crashed mid-mint, so that
 * entry is restored from them, and kept when nothing comes back: it is the
 * only record of a payment the mint took.
 */
async function finalAnswer(
  wallet: AgentWallet,
  entry: PendingMint,
  reason: MintQuoteDropReason,
  getCashuWallet: () => Promise<Wallet>
): Promise<Extract<PendingMintOutcome, { kind: "expired" | "restored" | "paid_refused" | "error" }>> {
  if (!entry.minting) return { kind: "expired", entry, reason };
  try {
    const restored = await restoreFromMintingState(
      await getCashuWallet(),
      entry.minting,
      wallet.lock_pubkey,
      entry.mint
    );
    if (restored.length > 0) return { kind: "restored", entry, proofs: restored };
  } catch (err) {
    return { kind: "error", entry, cause: err };
  }
  if (reason === "mint_expired") return { kind: "paid_refused", entry, reason: "quote_expired" };
  return {
    kind: "error",
    entry,
    cause:
      reason === "mint_unknown"
        ? "The mint reported this quote paid earlier and no longer knows it; nothing could be restored, so the quote is kept."
        : "The mint reported this quote paid earlier and now reports it unpaid; nothing could be restored, so the quote is kept.",
  };
}

/** NUT error code a mint returns for a quote past its expiry. */
const MINT_QUOTE_EXPIRED_CODE = 20007;
const QUOTE_UNKNOWN_TEXT =
  /\bquote\b[^.]*\b(not found|unknown|does not exist)\b|\b(unknown|no such) quote\b/i;
const QUOTE_EXPIRED_TEXT = /\bquote\b[^.]*\bexpired\b|\bexpired quote\b/i;

/**
 * A mint's definite answer that a quote is gone, as opposed to a mint that
 * could not answer. Only the mint's structured protocol error counts (HTTP 400
 * carrying a numeric `code` and a `detail`, which cashu-ts raises as
 * `MintOperationError`). Any other reply's message can be a proxy or web
 * server page, whose text echoes the request path and so names the quote
 * without the mint having said anything about it. Duck-typed on cashu-ts's
 * `name`: the bundle can carry more than one copy of the error classes.
 */
export function mintQuoteRefusal(err: unknown): "unknown" | "expired" | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const { name, status, code, message } = err as {
    name?: unknown;
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const answered = name === "MintOperationError" && status === 400 && typeof code === "number";
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
