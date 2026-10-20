import type { CreditFundRail } from "@dvmkit/sdk/internal";
import type {
  RailProbe,
} from "./wallet-probe";
type ProbeRail = RailProbe["rail"];

/**
 * Rail keys that appear on a per-call payment surface. A superset of the rails
 * a payment can actually settle on: `cashu` is how a provider advertises the
 * ecash rail on the wire, `cashu_p2pk` how a completed spend names itself.
 */
export const PAYMENT_RAIL_KEYS = ["cashu", "cashu_p2pk", "x402", "tempo"] as const;

/** {@link PAYMENT_RAIL_KEYS} as a union. */
export type PaymentRailKey = (typeof PAYMENT_RAIL_KEYS)[number];

/**
 * True when `value` is a per-call payment rail this build recognizes.
 *
 * The narrowing a wire-supplied rail list goes through before it can be
 * glossed: `payment.methods` on a quote is `string[]`, and a provider naming
 * a rail this build doesn't carry must not have that raw key printed into
 * prose as if it were a product name. Twin of `isCreditFundRail`.
 */
export function isPaymentRailKey(value: unknown): value is PaymentRailKey {
  return typeof value === "string" && (PAYMENT_RAIL_KEYS as readonly string[]).includes(value);
}

/** Caller wording remains exhaustive over the shared funding rail registry. */
export function fundingRailLabel(rail: CreditFundRail): string {
  switch (rail) {
    case "cashu":
      return "ecash";
    case "lightning":
      return "Lightning";
    case "x402":
      return "x402 stablecoin";
    case "tempo":
      return "Tempo stablecoin";
  }
}

/** {@link fundingRailLabel}'s twin for the per-call payment rails. */
export function paymentRailLabel(rail: PaymentRailKey | "credit"): string {
  switch (rail) {
    case "credit":
      return "prepaid balance";
    case "cashu":
    case "cashu_p2pk":
      return "ecash";
    case "x402":
      return "x402 stablecoin";
    case "tempo":
      return "Tempo stablecoin";
  }
}

/**
 * {@link fundingRailLabel}'s wallet-status register, for the `dvm wallet` and
 * `dvm doctor` surfaces that describe what a caller *holds* rather than what a
 * payment rides.
 *
 * Exactly one rail reads differently there, and it is the reason this register
 * exists rather than a second table: a connected Lightning wallet is a funding
 * float, and calling it plain "Lightning" beside a balance invites the reading
 * that a job can be paid straight off it. Every other rail delegates, so the
 * two registers cannot drift apart.
 */
export function probeRailLabel(rail: ProbeRail): string {
  return rail === "lightning" ? "Lightning float" : fundingRailLabel(rail);
}

/**
 * A rail gloss capitalized to open a sentence.
 *
 * Only `ecash` moves. It is a common noun, so left as-is it opens a `--human`
 * line with "ecash rail reachable…", which reads as a dropped shift key rather
 * than as a name — and "Ecash" at a sentence start is already what the rest of
 * the surface does (the caller CLI's headroom prose, the published wallet
 * docs). `x402 stablecoin` deliberately stays lowercase: that rail is styled
 * lowercase everywhere it appears, so capitalizing it would be wrong rather
 * than merely unusual.
 *
 * Takes the gloss rather than the rail key so one function serves all three
 * registers above; a rail whose noun needs no change passes straight through.
 */
export function railLabelAtSentenceStart(label: string): string {
  return label === "ecash" ? "Ecash" : label;
}
