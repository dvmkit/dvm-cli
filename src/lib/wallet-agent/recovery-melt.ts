/**
 * Mid-melt crash recovery for the agent wallet. Every entry in
 * `wallet.pending_melts[]` is a cash-out the wallet committed proofs to and
 * never saw finish: the mint may have paid the invoice, may have failed it, or
 * may still be routing. The sweep runs at the top of `dvm wallet cash-out`,
 * `fund` and `show`, so resuming after a crash always reconciles before anyone
 * reads a balance.
 *
 * The mint's melt-quote state is the only authority. Nothing here concludes
 * that money moved (or didn't) from local state alone — an entry survives every
 * ambiguous outcome, including an unreachable mint, because the entry is the
 * only local record that these proofs may already be spent.
 *
 * On `PAID`, the NUT-08 blank outputs persisted before the melt are replayed
 * against the mint's NUT-09 `/v1/restore` endpoint, so the unused Lightning fee
 * reserve comes back into the wallet instead of being silently burned — the
 * melt-side twin of the `ISSUED + minting` path in `recovery.ts`.
 */

import type { Wallet } from "@cashu/cashu-ts";

import { getWallet } from "@dvmkit/sdk/internal";
import { meltInFlightTimeoutSeconds, proofKey, revertInFlight } from "./inflight";
import { retryMintQuoteOperation } from "@dvmkit/sdk/internal";
import { rehydrateOutputData } from "@dvmkit/sdk/internal";
import { toAgentProof } from "@dvmkit/sdk/internal";
import {
  type AgentProof,
  type AgentWallet,
  loadAgentWallet,
  type PendingMelt,
  saveAgentWallet,
  withWalletLock,
} from "@dvmkit/sdk/internal";

export type MeltSweepOutcome =
  | { kind: "settled"; entry: PendingMelt; change: AgentProof[] }
  | { kind: "reverted"; entry: PendingMelt; returned_sats: number }
  | { kind: "still_pending"; entry: PendingMelt }
  | { kind: "error"; entry: PendingMelt; error: string };

export interface MeltSweepResult {
  outcomes: MeltSweepOutcome[];
  /** Sats confirmed paid out to Lightning by this pass. */
  settled_sats: number;
  /** Sats handed back to the spendable balance because the invoice was never paid. */
  returned_sats: number;
  still_pending: PendingMelt[];
  errors: { quote_id: string; error: string }[];
}

export interface MeltSweepOptions {
  now?: () => number;
  /** Grace period before an `UNPAID` entry is abandoned, in ms. Defaults to the melt in-flight window. */
  abandonAfterMs?: number;
  getWalletForMint?: (mintUrl: string) => Promise<Wallet>;
  /** Maximum time spent retrying one transient quote-status read. Default 10 seconds. */
  quoteRetryTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_SWEEP_QUOTE_RETRY_TIMEOUT_MS = 10_000;

/**
 * Reconcile every entry in `wallet.pending_melts[]` against its mint and
 * persist the result. Network errors are non-fatal — the affected entry stays
 * for the next pass.
 */
export async function sweepPendingMelts(opts: MeltSweepOptions = {}): Promise<MeltSweepResult> {
  const wallet = loadAgentWallet();
  if (!wallet || wallet.pending_melts.length === 0) {
    return { outcomes: [], settled_sats: 0, returned_sats: 0, still_pending: [], errors: [] };
  }

  const now = opts.now ?? (() => Date.now());
  const abandonAfterMs = opts.abandonAfterMs ?? meltInFlightTimeoutSeconds() * 1000;
  const getWalletForMint = opts.getWalletForMint ?? getWallet;
  const quoteRetryTimeoutMs =
    opts.quoteRetryTimeoutMs ?? DEFAULT_SWEEP_QUOTE_RETRY_TIMEOUT_MS;

  const outcomes: MeltSweepOutcome[] = [];
  for (const entry of wallet.pending_melts) {
    outcomes.push(
      await processEntry(wallet, entry, now(), abandonAfterMs, getWalletForMint, {
        now,
        sleep: opts.sleep,
        timeoutMs: quoteRetryTimeoutMs,
      })
    );
  }

  if (outcomes.some((o) => o.kind === "settled" || o.kind === "reverted")) {
    await withWalletLock(() => {
      const fresh = loadAgentWallet() ?? wallet;
      saveAgentWallet(outcomes.reduce<AgentWallet>(applyOutcome, fresh));
    });
  }

  return {
    outcomes,
    settled_sats: outcomes
      .filter((o) => o.kind === "settled")
      .reduce((sum, o) => sum + o.entry.amount_sats, 0),
    returned_sats: outcomes
      .filter((o): o is Extract<MeltSweepOutcome, { kind: "reverted" }> => o.kind === "reverted")
      .reduce((sum, o) => sum + o.returned_sats, 0),
    still_pending: outcomes
      .filter(
        (o): o is Extract<MeltSweepOutcome, { kind: "still_pending" }> => o.kind === "still_pending"
      )
      .map((o) => o.entry),
    errors: outcomes
      .filter((o): o is Extract<MeltSweepOutcome, { kind: "error" }> => o.kind === "error")
      .map((o) => ({ quote_id: o.entry.quote_id, error: o.error })),
  };
}

async function processEntry(
  wallet: AgentWallet,
  entry: PendingMelt,
  nowMs: number,
  abandonAfterMs: number,
  getWalletForMint: (mintUrl: string) => Promise<Wallet>,
  retry: {
    now: () => number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs: number;
  }
): Promise<MeltSweepOutcome> {
  let cashuWallet: Wallet;
  let state: string;
  try {
    ({ cashuWallet, state } = await retryMintQuoteOperation(
      async () => {
        const candidate = await getWalletForMint(entry.mint);
        const quote = await candidate.checkMeltQuoteBolt11(entry.quote_id);
        return { cashuWallet: candidate, state: quote.state };
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

  if (state === "PAID") {
    // The Lightning payment settled, so the inputs are spent whatever happens
    // next. Try to recover the change the mint signed onto our blank outputs;
    // a restore failure still settles the entry — losing the unused fee
    // reserve is a smaller error than leaving spent proofs on the books.
    let change: AgentProof[];
    try {
      change = await restoreChange(cashuWallet, entry, wallet.lock_pubkey);
    } catch {
      change = [];
    }
    return { kind: "settled", entry, change };
  }

  if (state === "UNPAID") {
    // Nothing left the mint. Hand the proofs back — but only once the entry is
    // past the melt window, so a sweep from a second CLI run can't yank proofs
    // out from under a melt that is still being submitted.
    const createdAtMs = Date.parse(entry.created_at);
    const ageMs = Number.isFinite(createdAtMs) ? nowMs - createdAtMs : Infinity;
    if (ageMs <= abandonAfterMs) return { kind: "still_pending", entry };
    return {
      kind: "reverted",
      entry,
      returned_sats: entry.input_proofs.reduce((sum, p) => sum + p.amount, 0),
    };
  }

  return { kind: "still_pending", entry };
}

async function restoreChange(
  cashuWallet: Wallet,
  entry: PendingMelt,
  lockPubkey: string
): Promise<AgentProof[]> {
  if (!entry.melting || entry.melting.outputs.length === 0) return [];
  const data = rehydrateOutputData(entry.melting.outputs);
  const keyset = cashuWallet.keyChain.getKeyset(entry.melting.keyset_id);
  // As in `recovery.ts`, this path skips cashu-ts's DLEQ verification. Every
  // restored proof is P2PK-locked to `lockPubkey`, so a forged signature is
  // unspendable by anyone else — the worst case is a junk proof that fails at
  // spend time, not loss of funds.
  const restored = await cashuWallet.mint.restore({
    outputs: data.map((d) => d.blindedMessage),
  });
  if (restored.outputs.length !== restored.signatures.length) {
    throw new Error(
      `mint returned mismatched outputs (${restored.outputs.length}) and signatures (${restored.signatures.length}) — NUT-09 requires parallel arrays`
    );
  }
  const byB = new Map<string, (typeof data)[number]>(data.map((d) => [d.blindedMessage.B_, d]));
  const proofs: AgentProof[] = [];
  for (let i = 0; i < restored.signatures.length; i++) {
    const owner = byB.get(restored.outputs[i].B_);
    if (!owner) continue;
    proofs.push(
      toAgentProof(owner.toProof(restored.signatures[i], keyset), entry.mint, lockPubkey)
    );
  }
  return proofs;
}

function applyOutcome(wallet: AgentWallet, outcome: MeltSweepOutcome): AgentWallet {
  if (outcome.kind === "still_pending" || outcome.kind === "error") return wallet;

  const inputKeys = new Set(outcome.entry.input_proofs.map((p) => proofKey(p)));
  const next: AgentWallet = {
    ...wallet,
    pending_melts: wallet.pending_melts.filter((m) => m.quote_id !== outcome.entry.quote_id),
  };

  if (outcome.kind === "settled") {
    next.proofs = [...next.proofs.filter((p) => !inputKeys.has(proofKey(p))), ...outcome.change];
    return next;
  }
  return revertInFlight(next, inputKeys);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
