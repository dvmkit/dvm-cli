import type { UpfrontPayment } from "@dvmkit/sdk";
import type { PendingSubmissionContext } from "@dvmkit/sdk/internal";

export interface UpfrontRailPayment {
  method: "cashu" | "x402" | "tempo";
  amountMsats: number;
  /** Exact dollar price, in micro-dollars, when the quote or the signed charge carried one. */
  usdMicro?: number;
}

export interface PricedSubmissionContext extends PendingSubmissionContext {
  /** Selected job price, independent of token rounding, fees and credit funding. */
  upfront_rail_payment?: UpfrontRailPayment;
}

/** The rail price as booked, carrying its exact dollar figure when there is one. */
export function upfrontRailPayment(method: UpfrontRailPayment["method"], amountMsats: number, usdMicro: number | undefined): UpfrontRailPayment {
  return { method, amountMsats, ...(usdMicro !== undefined ? { usdMicro } : {}) };
}

export function parseUpfrontRailPayment(value: unknown): UpfrontRailPayment | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as UpfrontRailPayment;
  if (!["cashu", "x402", "tempo"].includes(raw.method) ||
      !Number.isSafeInteger(raw.amountMsats) || raw.amountMsats < 0) return undefined;
  return { method: raw.method, amountMsats: raw.amountMsats,
    ...(Number.isSafeInteger(raw.usdMicro) && raw.usdMicro! >= 0 ? { usdMicro: raw.usdMicro } : {}) };
}

type UpfrontRail = NonNullable<UpfrontPayment["rail"]>;

/**
 * Every rail the SDK can put on an `upfront_payment`, card (`stripe`) included.
 * `satisfies` makes the compiler reject this table when the SDK's rail type gains
 * or loses a member, so an SDK bump cannot silently stop booking a credit draw.
 */
const UPFRONT_RAILS = {
  cashu: true, x402: true, tempo: true, lightning: true, stripe: true,
} as const satisfies Record<UpfrontRail, true>;

function isUpfrontRail(value: unknown): value is UpfrontRail {
  return typeof value === "string" && Object.hasOwn(UPFRONT_RAILS, value);
}

export type UpfrontPaymentCheck = { payment: UpfrontPayment } | { reason: string };

/** Validate an `upfront_payment` body, saying why it is unusable instead of dropping it. */
export function checkUpfrontPayment(value: unknown): UpfrontPaymentCheck {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { reason: "upfront_payment is not an object" };
  const raw = value as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.amount_msats) || Number(raw.amount_msats) < 0)
    return { reason: "amount_msats is not a non-negative integer" };
  for (const key of ["amount_micro", "native_amount"] as const) {
    if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < 0))
      return { reason: `${key} is not a non-negative integer` };
  }
  if ((raw.amount_micro === undefined) !== (raw.currency === undefined))
    return { reason: "amount_micro and currency must be set together" };
  if (raw.currency !== undefined && (typeof raw.currency !== "string" || !/^[a-z]{3}$/.test(raw.currency)))
    return { reason: "currency is not a lowercase three-letter code" };
  if ((raw.credit_id === undefined) !== (raw.draw_id === undefined))
    return { reason: "credit_id and draw_id must be set together" };
  for (const key of ["credit_id", "draw_id", "native_asset"] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== "string" || raw[key].trim().length === 0))
      return { reason: `${key} is not a non-empty string` };
  }
  if (raw.rail !== undefined && !isUpfrontRail(raw.rail))
    return { reason: `rail ${JSON.stringify(String(raw.rail)).slice(0, 40)} is not a known funding rail` };
  return { payment: {
    amount_msats: raw.amount_msats as number,
    ...(raw.amount_micro !== undefined ? { amount_micro: raw.amount_micro as number, currency: raw.currency as string } : {}),
    ...(raw.rail !== undefined ? { rail: raw.rail as UpfrontRail } : {}),
    ...(raw.native_amount !== undefined ? { native_amount: raw.native_amount as number } : {}),
    ...(raw.native_asset !== undefined ? { native_asset: raw.native_asset as string } : {}),
    ...(raw.credit_id !== undefined ? { credit_id: raw.credit_id as string, draw_id: raw.draw_id as string } : {}),
  } };
}

/** Missing or malformed evidence is unknown, never a zero-price payment. */
export function parseUpfrontPayment(value: unknown): UpfrontPayment | undefined {
  const checked = checkUpfrontPayment(value);
  return "payment" in checked ? checked.payment : undefined;
}

/** Why a present `upfront_payment` is unusable; undefined when it is absent or valid. */
export function upfrontPaymentFault(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const checked = checkUpfrontPayment(value);
  return "reason" in checked ? checked.reason : undefined;
}

/** Receipt carrying why its `upfront_payment` was dropped (the SDK receipt type has no such field). */
export type WithUpfrontFault<T> = T & { upfrontPaymentFault?: string };

/** Fields a transport receipt carries for an `upfront_payment` body: the parsed value, or the reason it was refused. */
export function upfrontReceiptFields(value: unknown): { upfrontPayment: UpfrontPayment | undefined; upfrontPaymentFault?: string } {
  const fault = upfrontPaymentFault(value);
  return { upfrontPayment: parseUpfrontPayment(value), ...(fault ? { upfrontPaymentFault: fault } : {}) };
}

export function receiptUpfrontFault(receipt: object): string | undefined {
  return (receipt as WithUpfrontFault<object>).upfrontPaymentFault;
}
