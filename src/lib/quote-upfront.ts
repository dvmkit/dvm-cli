import type { Quote } from "@dvmkit/sdk/internal";

// Keep synthetic zeroes distinct without changing serialized quote output.
const unknownPrices = new WeakSet<Quote["upfront"]>();

export function unknownUpfrontPrice(): Quote["upfront"] {
  const upfront = { amount: 0, currency: "usd" };
  unknownPrices.add(upfront);
  return upfront;
}

export function hasKnownUpfrontPrice(quote: Quote): boolean {
  return !unknownPrices.has(quote.upfront);
}
