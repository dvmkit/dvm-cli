/**
 * The hand-off between the planner and the post-job healthy moment.
 *
 * `planCreditForQuote` decides a sizing belongs on the float while the 402 is
 * being answered, several call frames below the terminal where
 * `settleCreditAfterJob` runs — and there are six of those call sites, on
 * three different arcs (stream, poll, paid submit). Threading a parameter
 * through all of them would put a credit concern in every signature between
 * the two, so the decision is stashed here and taken there, the same
 * deferred-field pattern `credit-notice.ts` uses to get its structured blocks
 * to the one emission that carries them.
 *
 * `take` clears. The funding must fire at most once per command: it moves real
 * money, and an intent left behind would be re-read by whatever ran next.
 */

import { type DeferredFunding } from "./credit-policy";

export function noteDeferredFunding(funding: DeferredFunding): void {
  pending = funding;
}

/**
 * Take the deferred funding, clearing it. Returns undefined when the planner
 * routed nothing here — which is every job on the in-request Cashu path.
 */
export function takeDeferredFunding(): DeferredFunding | undefined {
  const taken = pending;
  pending = undefined;
  return taken;
}

export function resetDeferredFunding(): void {
  pending = undefined;
}


let pending: DeferredFunding | undefined;
