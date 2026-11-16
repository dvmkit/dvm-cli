import type { CreditMenu } from "@dvmkit/sdk/internal";

/** Stripe's smallest USD card charge, in micro-units. */
export const STRIPE_CARD_FLOOR_MICRO = 500_000;

export function cardMinimumMicro(menu: CreditMenu | undefined): number {
  return Math.max(STRIPE_CARD_FLOOR_MICRO, menu?.min_micro ?? 0, menu?.stripe?.min_micro ?? 0);
}
