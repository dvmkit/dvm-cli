/**
 * The reclaim a wedged x402 channel's refusal points at, and the command that
 * posts it.
 *
 * A settlement channel whose earlier refund is stuck between chain and ledger
 * refuses every deposit `settlement_pending`, and names the one drain id that
 * still reclaims the balance already on it. Two doors meet that refusal while
 * trying to *add* money — the explicit `dvm credit fund` and the
 * post-job auto-refill — and both have to leave the caller with a
 * reclaim they can run rather than an id to re-type.
 *
 * One adoption serves both funding paths so they record the same reclaim.
 */

import {
  type AttestedDvmIdentity,
  clearPendingDrain,
  ensureProvisionalCredit,
  loadCredit,
  pendingDrainFor,
  recordCreditX402Instrument,
  recordPendingDrain,
  shellQuoteArg,
  type StoredCredit,
} from "@dvmkit/sdk/internal";

export interface AdoptedWedgedDrain {
  drainId: string;
  command: string;
  /**
   * The one sentence both doors append to the refusal they relay. Shared for
   * the same reason the adoption is: a caller who meets this hold through the
   * refill and then through an explicit fund must not be told two things.
   */
  advice: string;
}

/**
 * Adopt the drain id a wedged channel's top-up refusal names, so the reclaim it
 * points at is a no-argument command .
 *
 * The same adoption `dvm credit drain` makes, read from the doors of
 * one hold whose callers are least likely to hold a drain record at all: they
 * were adding money, not reclaiming it. Without it the refusal's advice is an id
 * to re-type, and the next plain `dvm credit drain` mints a fresh one into the
 * same gate, which admits exactly the one the wedged settlement is recorded
 * under.
 *
 * Recording a drain this caller never posted is the deliberate difference from
 * the drain path, and it is not an invention: the wedged settlement *is* a drain
 * that reached the chain, on this caller's own credit — the channel↔credit
 * binding is unique and ownership is checked above the gate — so the entry
 * points at a reclaim that is genuinely in flight server-side. What must stay
 * uninvented is `drain_registered`, which answers whether the id *this request*
 * posted was registered; these doors post none, the server withholds the field,
 * and keying the adoption on `settlement_drain_id` alone is what keeps the two
 * apart.
 *
 * An absent id is the written-off hold, where `x402SettlementPending` withholds
 * it on purpose because a *fresh* drain reclaims from then on — so
 * the guard below is that case too, and nothing is recorded.
 *
 * `method`/`payout` are the channel shape rather than a guess: this refusal only
 * fires on a channel-bound credit, and `drainPayout` keeps a channel drain's
 * payout empty because the payer is fixed in the channel config. The next run's
 * `reusableDrain` re-states both verbatim.
 */
export function adoptWedgedChannelDrain(args: {
  /** Where the credit lives — half the store key, and the reclaim's fallback handle. */
  endpoint: string;
  /** The attested identity the record is keyed under, where the DVM proved one. */
  identity?: AttestedDvmIdentity;
  /**
   * The handle the reclaim command names, when it is not the endpoint: the
   * qualified id the caller resolved against, which is what the command takes
   * and what every other notice in this arc quotes. Store keying is unaffected.
   */
  handle?: string;
  callerPubkey: string;
  creditId: string;
  data: Record<string, unknown> | undefined;
}): AdoptedWedgedDrain | undefined {
  const drainId = args.data?.settlement_drain_id;
  if (typeof drainId !== "string" || drainId === "") return undefined;
  const identityArg: [] | [identity: AttestedDvmIdentity] = args.identity ? [args.identity] : [];
  // Re-read rather than reuse the pre-funding load: a funding can re-point the
  // record mid-command, and `recordPendingDrain` is a silent no-op without one.
  const stored = loadCredit(args.endpoint, args.callerPubkey, args.identity);
  if (!stored) {
    ensureProvisionalCredit({
      endpoint: args.endpoint,
      ...(args.identity ? { identity: args.identity } : {}),
      callerPubkey: args.callerPubkey,
      creditId: args.creditId,
      currency: "usd",
      targetMicro: 0,
    });
  }
  // Two drains on one credit is a shape nothing reads: `pendingDrainFor` takes
  // the first entry stamped for the credit, so leaving the old one is how the
  // next plain drain posts the id the gate refuses. Safe to drop — any other id
  // recorded here met this same gate and was never registered, and
  // `clearPendingDrain` leaves `drainEvidence` alone.
  const recorded = pendingDrainFor(stored, args.creditId);
  if (recorded && recorded.drainId !== drainId) {
    clearPendingDrain(args.endpoint, args.callerPubkey, recorded, ...identityArg);
  }
  recordPendingDrain(
    args.endpoint,
    args.callerPubkey,
    {
      drainId,
      creditId: args.creditId,
      method: "x402",
      payout: {},
      requestedAt: Date.now(),
    },
    ...identityArg
  );
  // The hold is only reachable through a settlement channel, so the refusal has
  // named this credit's instrument as surely as it named the drain — and
  // `creditDrain` reads that pin to know the payout is the channel's own.
  recordCreditX402Instrument(
    args.endpoint,
    args.callerPubkey,
    args.creditId,
    "x402_channel",
    args.identity
  );
  const command = reclaimCommand(args.handle ?? args.endpoint, stored, args.creditId);
  return {
    drainId,
    command,
    // Written to be appended to the server's own refusal, never to replace it:
    // that copy is the one saying nothing was charged and that paying per call
    // still works, which is what a human needs to hear. What it cannot know is
    // that this CLI just recorded the id, so the reclaim no longer carries it.
    advice: `Drain ${drainId} is now this credit's recorded reclaim here, so '${command}' posts it — no --drain-id needed.`,
  };
}

/**
 * The command that posts this credit's recorded drain.
 *
 * The bare verb resolves its credit from the tracked record, so it reclaims
 * *this* credit only when the record names it — which a `--credit-id` run
 * against a record tracking a sibling does not. Naming the credit there is the
 * difference between posting the drain just recorded and minting a fresh one
 * against a live balance nobody asked to touch. An absent record is the bare
 * form too: the caller that has none creates it under this credit id.
 */
export function reclaimCommand(
  handle: string,
  tracked: StoredCredit | undefined,
  creditId: string
): string {
  return !tracked || tracked.creditId === creditId
    ? `dvm credit drain ${shellQuoteArg(handle)}`
    : creditDrainCommand(handle, creditId);
}

export function creditDrainCommand(handle: string, creditId: string): string {
  return `dvm credit drain ${shellQuoteArg(handle)} --credit-id ${shellQuoteArg(creditId)}`;
}
