/**
 * The card leg of `dvm credit drain`: card-funded credit is refunded to the
 * card that paid for it, less the refund's share of Stripe's processing fee.
 *
 * The DVM answers `pending` until Stripe has recorded that fee and the
 * refunds have finished, and re-posting the same drain id is what advances it.
 * So the leg polls a little within one run, then hands back an honest
 * `pending` with the id to poll again rather than waiting indefinitely.
 */

import { type CreditOpResult, DvmError, formatUsd, shellQuoteArg } from "@dvmkit/sdk/internal";

/**
 * The DVM bounds card refund drain ids. It also reserves the `expiry-` prefix
 * for the refund it makes itself when a card balance expires; that one is left
 * to the DVM to refuse, because polling the DVM's own expiry refund by its id
 * is legitimate and only the DVM knows whether the id already exists.
 */
export const MAX_CARD_DRAIN_ID_LENGTH = 128;

/**
 * Waits between re-posts of a pending card refund. Mutable so in-process tests
 * can shorten it; the sum bounds how long one run waits.
 */
export const cardDrainTiming = { delaysMs: [1_000, 2_000, 4_000] };

export interface CardRefund {
  refunded_usd?: string;
  stripe_fee_share_usd?: string;
  refunded_cents?: number;
  stripe_fee_share_cents?: number;
  sub_cent_micro?: number;
  refunds?: unknown[];
}

/** Refuse a drain id the DVM would refuse, before anything is recorded under it. */
export function assertCardDrainId(drainId: string): void {
  if (drainId.length > MAX_CARD_DRAIN_ID_LENGTH) {
    throw new DvmError(
      "invalid_argument",
      `A card refund's drain id can be at most ${String(MAX_CARD_DRAIN_ID_LENGTH)} characters.`,
      "Drop --drain-id to let dvm pick one, or choose a shorter id such as a UUID."
    );
  }
}

/**
 * Post a card refund drain, adopting the drain that already holds the credit
 * and polling a pending one a bounded number of times.
 *
 * `post` signs afresh on every call and reads the current drain id; `adopt`
 * re-points the caller's drain record at the blocking drain the DVM named.
 */
export async function postCardDrain(args: {
  drainId: () => string;
  post: () => Promise<CreditOpResult>;
  adopt: (drainId: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ result: CreditOpResult; adoptedFrom?: string; polls: number }> {
  const sleep = args.sleep ?? defaultSleep;
  let adoptedFrom: string | undefined;
  let result: CreditOpResult;
  for (;;) {
    try {
      result = await args.post();
      break;
    } catch (err) {
      const blocking =
        err instanceof DvmError && err.code === "drain_conflict" ? err.data?.blocking_drain_id : undefined;
      // One adoption only: a second conflict would mean the DVM named a drain
      // that is itself blocked, and chasing that is not this verb's job.
      if (typeof blocking !== "string" || blocking === args.drainId() || adoptedFrom !== undefined) {
        throw err;
      }
      adoptedFrom = args.drainId();
      args.adopt(blocking);
    }
  }
  let polls = 0;
  for (const delay of cardDrainTiming.delaysMs) {
    if (result.drain?.status !== "pending") break;
    await sleep(delay);
    result = await args.post();
    polls++;
  }
  return { result, ...(adoptedFrom ? { adoptedFrom } : {}), polls };
}

/** The `card_refund` block a card drain carries, when it carries one. */
export function cardRefundOf(drain: unknown): CardRefund | undefined {
  const block = isRecord(drain) ? drain.card_refund : undefined;
  return isRecord(block) ? (block as CardRefund) : undefined;
}

export function refundIdsOf(drain: unknown): string[] | undefined {
  const ids = isRecord(drain) ? drain.refund_ids : undefined;
  return Array.isArray(ids) && ids.every((id) => typeof id === "string") ? ids : undefined;
}

/** CLI-authored copy for a card refund, keyed off the drain's status. */
export function cardDrainCopy(args: {
  status: string;
  amountMicro: number;
  drain: unknown;
  endpoint: string;
  creditId: string;
  drainId: string;
  adoptedFrom?: string;
}): { display: string; hint: string } | undefined {
  const refund = cardRefundOf(args.drain);
  const ids = refundIdsOf(args.drain);
  const adopted = args.adoptedFrom
    ? ` This credit already had card refund ${args.drainId} under way, so it was followed instead of starting a second one.`
    : "";
  const poll = `dvm credit drain ${shellQuoteArg(args.endpoint)} --credit-id ${shellQuoteArg(args.creditId)} --method stripe`;
  if (args.status === "pending") {
    return {
      display: `A card refund of $${formatUsd(args.amountMicro / 1_000_000)} is under way (drain ${args.drainId}). Stripe hasn't finished it yet, so nothing is confirmed back on the card.${adopted}`,
      hint: `Check again in a minute with '${poll}': it polls the same drain and never starts a second refund. The refund goes back to the card that paid, less its share of Stripe's processing fee.`,
    };
  }
  if (args.status === "sent") {
    // The DVM's `*_usd` strings carry their own dollar sign.
    const refunded = refund?.refunded_usd ?? `$${formatUsd(args.amountMicro / 1_000_000)}`;
    const fee =
      refund?.stripe_fee_share_usd !== undefined
        ? ` ${refund.stripe_fee_share_usd} of the balance covered this refund's share of Stripe's card processing fee, which Stripe does not return on a refund.`
        : "";
    return {
      display: `${refunded} was refunded to the card that paid for this credit.${fee}${adopted}`,
      hint: `Card refunds usually take 5 to 10 business days to appear on the statement.${ids && ids.length > 0 ? ` Stripe refund ${ids.length === 1 ? "reference" : "references"}: ${ids.join(", ")}.` : ""}`,
    };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
