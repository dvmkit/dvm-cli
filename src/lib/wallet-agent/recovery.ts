/**
 * Pending quotes are reconciled before returning the wallet balance. An
 * ISSUED quote with persisted blinded outputs is restored through NUT-09,
 * covering a crash after issuance but before proofs reached disk.
 */

import type { Wallet } from "@cashu/cashu-ts";
import { MintQuoteState } from "@cashu/cashu-ts";

import { getWallet } from "@dvmkit/sdk/internal";
import { computeSmartDenominations } from "@dvmkit/sdk/internal";
import { fundTimeoutMs } from "./fund";
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
  | { kind: "expired"; entry: PendingMint }
  | { kind: "still_pending"; entry: PendingMint }
  | { kind: "error"; entry: PendingMint; error: string };

export interface SweepResult {
  outcomes: SweepEntryOutcome[];
  recovered_proofs: AgentProof[];
  still_pending: PendingMint[];
  errors: { quote_id: string; error: string }[];
}

export interface SweepOptions {
  now?: () => number;
  /** Override the bounded fallback for legacy entries without a quote expiry. */
  expirationMs?: number;
  getWalletForMint?: (mintUrl: string) => Promise<Wallet>;
  /** Maximum time spent retrying one transient quote-status read. Default 10 seconds. */
  quoteRetryTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_SWEEP_QUOTE_RETRY_TIMEOUT_MS = 10_000;

/**
 * Reconcile every entry in `wallet.pending_mints[]` against its mint and
 * persist any state changes. Returns a structured summary so callers can
 * surface what was recovered. Network errors are non-fatal — affected
 * entries are kept on the pending list for the next sweep.
 */
export async function sweepPendingMints(opts: SweepOptions = {}): Promise<SweepResult> {
  const wallet = loadAgentWallet();
  if (!wallet || wallet.pending_mints.length === 0) {
    return { outcomes: [], recovered_proofs: [], still_pending: [], errors: [] };
  }

  const now = opts.now ?? (() => Date.now());
  const expirationMs = opts.expirationMs ?? fundTimeoutMs();
  const getWalletForMint = opts.getWalletForMint ?? getWallet;
  const quoteRetryTimeoutMs =
    opts.quoteRetryTimeoutMs ?? DEFAULT_SWEEP_QUOTE_RETRY_TIMEOUT_MS;

  const outcomes: SweepEntryOutcome[] = [];
  for (const entry of wallet.pending_mints) {
    const outcome = await processEntry(wallet, entry, now(), expirationMs, getWalletForMint, {
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
    errors: outcomes
      .filter((o): o is Extract<SweepEntryOutcome, { kind: "error" }> => o.kind === "error")
      .map((o) => ({ quote_id: o.entry.quote_id, error: o.error })),
  };
}

async function processEntry(
  wallet: AgentWallet,
  entry: PendingMint,
  nowMs: number,
  expirationMs: number,
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
      return { kind: "error", entry, error: errorMessage(err) };
    }
  }

  // UNPAID: the quote's own expiry is authoritative when recorded. Wallets
  // predating schema v9 (and mints that return no expiry) retain the bounded
  // fund-timeout fallback so an unreachable quote cannot live forever.
  const quoteExpiry = entry.expires_at;
  if (quoteExpiry !== undefined && Number.isFinite(quoteExpiry)) {
    if (nowMs > quoteExpiry * 1000) {
      return { kind: "expired", entry };
    }
    return { kind: "still_pending", entry };
  }

  const requestedAtMs = Date.parse(entry.requested_at);
  const ageMs = Number.isFinite(requestedAtMs) ? nowMs - requestedAtMs : Infinity;
  if (ageMs > expirationMs) {
    return { kind: "expired", entry };
  }
  return { kind: "still_pending", entry };
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
  if (outcome.kind === "still_pending" || outcome.kind === "error") {
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
