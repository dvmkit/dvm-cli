import { guidanceJobArg, providerFields } from "./provider-output";
import { type NextAction, type NextActionRefund } from "./next-action";
import { formatAmountBestEffort, monetaryJson } from "./currency";
import {
  fetchBtcUsdRate,
  getLastKnownBtcRate,
  type Message,
  receiveToAgentWallet,
} from "@dvmkit/sdk/internal";
import {
  info,
} from "./output";
import {
  loadJob,
  updateJob,
} from "./job-store";

/**
 * Outcome of attempting to claim an inbound provider `payment` message's Cashu
 * proofs into the local wallet. `claimed: false` means the swap could not
 * complete (e.g. mint outage); `cashu_token` is then retained for manual recovery.
 */
export interface RefundClaim {
  seq: number;
  /** Amount claimed (or, when unclaimed, the provider-declared amount), in msats. */
  amount_msats: number;
  reason: "refund" | "change";
  mint?: string;
  claimed: boolean;
  /** Raw Cashu token from the message (spent once claimed; the recovery vehicle when not). */
  cashu_token: string;
}

/**
 * Claim the proofs from inbound provider `payment` messages (refund/change) into
 * the local Cashu wallet. Idempotent: each message's `seq` is recorded on the job
 * record after a successful claim, so replay / re-poll never double-claims (the
 * mint's atomic burn is the ultimate double-spend gate; this avoids surfacing a
 * spurious failure on the second pass). Best-effort — a failed claim is reported
 * with `claimed: false` and the token retained, never thrown.
 */
export async function claimInboundPayments(
  jobId: string,
  messages: Message[]
): Promise<RefundClaim[]> {
  const job = loadJob(jobId);
  const claimedSeqs = new Set(job?.claimedPaymentSeqs ?? []);
  const results: RefundClaim[] = [];

  for (const msg of messages) {
    if (msg.type !== "payment" || msg.from !== "provider") continue;
    const c = msg.content;
    if (!c.cashu_token) continue;

    const reason = c.reason ?? "refund";
    const declaredMsats = c.amount_msats ?? 0;

    if (claimedSeqs.has(msg.seq)) {
      results.push({
        seq: msg.seq,
        amount_msats: declaredMsats,
        reason,
        mint: c.mint,
        claimed: true,
        cashu_token: c.cashu_token,
      });
      continue;
    }

    // Best-effort claim into the agent wallet. A failed/unclaimable token
    // (mint outage, third-party lock) is reported with `claimed: false` and
    // retained for manual recovery — never thrown.
    let claimedMsats = 0;
    try {
      const received = await receiveToAgentWallet(c.cashu_token);
      claimedMsats = received.claimedSats * 1000;
    } catch {
      // Unclaimable (mint outage / third-party lock) — retained for manual recovery.
    }
    if (claimedMsats > 0) {
      claimedSeqs.add(msg.seq);
      updateJob(jobId, { claimedPaymentSeqs: [...claimedSeqs] });
      results.push({
        seq: msg.seq,
        amount_msats: claimedMsats,
        reason,
        mint: c.mint,
        claimed: true,
        cashu_token: c.cashu_token,
      });
    } else {
      results.push({
        seq: msg.seq,
        amount_msats: declaredMsats,
        reason,
        mint: c.mint,
        claimed: false,
        cashu_token: c.cashu_token,
      });
    }
  }

  return results;
}

/**
 * Build a `NextActionRefund` from the most recent claim, or null when there are
 * none. A failed claim yields an actionable retry (with the token + manual
 * recovery command); a successful claim is informational. USD is best-effort
 * from the cached BTC rate, falling back to a sats-only display.
 */
export function refundNextAction(jobId: string, claims: RefundClaim[]): NextActionRefund | null {
  if (claims.length === 0) return null;
  const claim = claims[claims.length - 1];
  const amount = formatAmountBestEffort(claim.amount_msats);
  const noun = claim.reason === "change" ? "change" : "refund";

  if (!claim.claimed) {
    return providerFields({
      type: "refund" as const,
      job_id: jobId,
      amount_msats: claim.amount_msats,
      display: `${cap(noun)} of ${amount} could not be auto-claimed`,
      reason: claim.reason,
      claimed: false,
      cashu_token: claim.cashu_token,
      hint: `The provider sent a ${noun} but the auto-claim into your wallet failed (the mint may be unreachable). Claim it manually with 'dvm wallet receive-token <cashu_token>' — the token is in this action's 'cashu_token' field, don't lose it. Or retry the auto-claim with 'dvm messages ${guidanceJobArg(jobId)} --no-stream' (re-running plain 'dvm messages' won't retry — its cursor has already advanced past this message).`,
    }, ["amount_msats", "reason", "cashu_token"]);
  }

  return providerFields({
    type: "refund" as const,
    job_id: jobId,
    amount_msats: claim.amount_msats,
    display: `Received ${noun} of ${amount}`,
    reason: claim.reason,
    claimed: true,
    hint: `The provider ${noun === "refund" ? "refunded" : "returned change of"} ${amount}, now added to your wallet. Relay to your human: they got ${amount} back.`,
  }, ["reason"]);
}

/**
 * Build the structured top-level `refund` JSON field from the most recent claim,
 * or `{}` when there are none. Carries amount (with USD for agent relay), reason,
 * claim outcome, and the token (the recovery vehicle when the claim failed).
 */
export async function refundJsonField(
  claims: RefundClaim[]
): Promise<{ refund: Record<string, unknown> } | Record<string, never>> {
  if (claims.length === 0) return {};
  const claim = claims[claims.length - 1];
  const rate = await fetchBtcUsdRate().catch(() => getLastKnownBtcRate()?.rate ?? null);
  const amount =
    rate !== null
      ? monetaryJson(claim.amount_msats, rate)
      : { msats: claim.amount_msats, display: `${Math.round(claim.amount_msats / 1000)} sats` };
  return {
    refund: providerFields({
      seq: claim.seq,
      reason: claim.reason,
      claimed: claim.claimed,
      amount,
      ...(claim.mint ? { mint: claim.mint } : {}),
      cashu_token: claim.cashu_token,
    }, ["seq", "reason", "mint", "cashu_token", ...(!claim.claimed ? ["amount"] : [])]),
  };
}

export function refundSummaryHuman(
  claim: Pick<NextActionRefund, "reason" | "claimed" | "amount_msats" | "cashu_token">
): string {
  const noun = claim.reason === "change" ? "change" : "refund";
  if (claim.claimed) {
    return `Claimed ${noun} of ${formatAmountBestEffort(claim.amount_msats)} into your wallet.`;
  }
  return `${cap(noun)} of ${formatAmountBestEffort(claim.amount_msats)} could not be auto-claimed (the mint may be down). Recover with: dvm wallet receive-token ${claim.cashu_token}`;
}

export function printRefundSummaryHuman(claims: RefundClaim[]): void {
  for (const claim of claims) info(refundSummaryHuman(claim));
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function withRefundNextAction(jobId: string, action: NextAction, claims: RefundClaim[]): NextAction {
  if (action?.type === "respond" || action?.type === "pay") return action;
  return refundNextAction(jobId, claims) ?? action;
}
