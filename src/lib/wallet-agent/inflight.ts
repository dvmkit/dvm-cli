import {
  type AgentProof,
  type AgentRecentSpend,
  type AgentWallet,
  RECENT_SPENDS_CAP,
} from "@dvmkit/sdk/internal";

/** Default in-flight proof timeout, in seconds. */
export const DEFAULT_INFLIGHT_PROOF_TIMEOUT_SEC = 60;

export const INFLIGHT_TIMEOUT_ENV = "DVM_INFLIGHT_PROOF_TIMEOUT_SEC";

/**
 * Read the in-flight proof timeout from `DVM_INFLIGHT_PROOF_TIMEOUT_SEC`
 * or fall back to {@link DEFAULT_INFLIGHT_PROOF_TIMEOUT_SEC}. Invalid /
 * non-positive values fall back silently — the env knob is an operator
 * convenience, not a strict gate.
 */
export function inFlightTimeoutSeconds(): number {
  const raw = process.env[INFLIGHT_TIMEOUT_ENV];
  if (!raw) return DEFAULT_INFLIGHT_PROOF_TIMEOUT_SEC;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_INFLIGHT_PROOF_TIMEOUT_SEC;
  }
  return parsed;
}

/**
 * Grace period before an unpaid melt is abandoned, in seconds.
 * Deliberately much longer than {@link DEFAULT_INFLIGHT_PROOF_TIMEOUT_SEC}: a
 * per-call swap either returns or doesn't within seconds, but a melt hands the
 * mint a Lightning payment that can sit `PENDING` for minutes.
 *
 * Nothing concludes a melt from this window alone — `sweepPendingMelts` asks
 * the mint. It only stops one CLI run's sweep from reclaiming proofs another
 * run is still submitting, in the window where the mint hasn't yet seen them.
 */
export const DEFAULT_MELT_INFLIGHT_TIMEOUT_SEC = 900;

export const MELT_INFLIGHT_TIMEOUT_ENV = "DVM_MELT_INFLIGHT_TIMEOUT_SEC";

/**
 * Read the melt grace period from `DVM_MELT_INFLIGHT_TIMEOUT_SEC` or fall back
 * to {@link DEFAULT_MELT_INFLIGHT_TIMEOUT_SEC}. Invalid / non-positive values
 * fall back silently, matching {@link inFlightTimeoutSeconds}.
 */
export function meltInFlightTimeoutSeconds(): number {
  const raw = process.env[MELT_INFLIGHT_TIMEOUT_ENV];
  if (!raw) return DEFAULT_MELT_INFLIGHT_TIMEOUT_SEC;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MELT_INFLIGHT_TIMEOUT_SEC;
  }
  return parsed;
}

/** Stable per-proof key built from `(mint, secret)`. Secrets are unique per mint. */
export function proofKey(p: Pick<AgentProof, "mint" | "secret">): string {
  return `${p.mint}\x00${p.secret}`;
}

/**
 * Mark the proofs identified by `proofKeys` as `in_flight` with
 * `in_flight_until_ms = untilMs`. Proofs not present in the wallet are
 * ignored. Pure: returns a new wallet object with mutated `proofs`.
 */
export function markProofsInFlight(
  wallet: AgentWallet,
  proofKeys: Set<string>,
  untilMs: number
): AgentWallet {
  const next = wallet.proofs.map((p) =>
    proofKeys.has(proofKey(p))
      ? { ...p, status: "in_flight" as const, in_flight_until_ms: untilMs }
      : p
  );
  return { ...wallet, proofs: next };
}

/**
 * Settle a successful spend: remove the spent proofs from the wallet
 * entirely and append `recentSpend` to `recent_spends`, truncated to
 * the most-recent {@link RECENT_SPENDS_CAP}.
 */
export function settleSpendSuccess(
  wallet: AgentWallet,
  proofKeys: Set<string>,
  recentSpend: AgentRecentSpend
): AgentWallet {
  const remaining = wallet.proofs.filter((p) => !proofKeys.has(proofKey(p)));
  const recents = [...wallet.recent_spends, recentSpend].slice(-RECENT_SPENDS_CAP);
  return { ...wallet, proofs: remaining, recent_spends: recents };
}

/**
 * Roll back a spend whose DVM submit was rejected before mint-side
 * consumption: flip `in_flight` proofs identified by `proofKeys` back
 * to `valid` and clear `in_flight_until_ms`.
 */
export function revertInFlight(wallet: AgentWallet, proofKeys: Set<string>): AgentWallet {
  const next = wallet.proofs.map((p) => {
    if (!proofKeys.has(proofKey(p))) return p;
    if (p.status !== "in_flight") return p;
    const { in_flight_until_ms: _drop, ...rest } = p;
    return { ...rest, status: "valid" as const };
  });
  return { ...wallet, proofs: next };
}

export interface InFlightSweepResult {
  wallet: AgentWallet;
  reverted: number;
}

/**
 * Revert any `in_flight` proof whose `in_flight_until_ms` has passed
 * (`< nowMs`) back to `valid`. Idempotent — proofs already `valid` are
 * left alone, proofs without `in_flight_until_ms` (defensive) are also
 * reverted because their lifecycle is unrecoverable.
 *
 * Run at the start of every wallet-touching command so a CLI killed
 * mid-`dvm request` heals on next invocation, modulo the in-flight
 * timeout.
 *
 * Proofs committed to an open melt or a prepared swap are exempt no matter
 * how old they are. A timeout says nothing about whether a mint paid a
 * Lightning invoice or committed a swap whose response was interrupted;
 * only the mint's NUT-06 / NUT-09 / NUT-07 state does. Returning those proofs
 * to spendable on a timer would offer the wallet proofs the mint may already
 * have consumed.
 */
export function sweepStaleInFlight(wallet: AgentWallet, nowMs: number): InFlightSweepResult {
  const mintCommitted = new Set(
    [
      ...wallet.pending_melts.flatMap((m) => m.input_proofs),
      ...wallet.pending_submissions.flatMap((submission) =>
        submission.swapping
          ? [...submission.swapping.input_proofs, ...submission.swapping.unselected_proofs]
          : []
      ),
    ].map((proof) => proofKey(proof))
  );
  let reverted = 0;
  const next = wallet.proofs.map((p) => {
    if (p.status !== "in_flight") return p;
    if (mintCommitted.has(proofKey(p))) return p;
    const stale = p.in_flight_until_ms === undefined || p.in_flight_until_ms < nowMs;
    if (!stale) return p;
    reverted += 1;
    const { in_flight_until_ms: _drop, ...rest } = p;
    return { ...rest, status: "valid" as const };
  });
  return { wallet: { ...wallet, proofs: next }, reverted };
}
