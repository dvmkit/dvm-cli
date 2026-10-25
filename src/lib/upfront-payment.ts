import type { UpfrontPayment } from "@dvmkit/sdk";
import type { PendingSubmissionContext } from "@dvmkit/sdk/internal";

export interface UpfrontRailPayment {
  method: "cashu" | "x402" | "tempo";
  amountMsats: number;
}

export interface PricedSubmissionContext extends PendingSubmissionContext {
  /** Selected job price, independent of token rounding, fees and credit funding. */
  upfront_rail_payment?: UpfrontRailPayment;
}

export function parseUpfrontRailPayment(value: unknown): UpfrontRailPayment | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as UpfrontRailPayment;
  if (!["cashu", "x402", "tempo"].includes(raw.method) ||
      !Number.isSafeInteger(raw.amountMsats) || raw.amountMsats < 0) return undefined;
  return { method: raw.method, amountMsats: raw.amountMsats };
}

/** Missing or malformed evidence is unknown, never a zero-price payment. */
export function parseUpfrontPayment(value: unknown): UpfrontPayment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.amount_msats) || Number(raw.amount_msats) < 0) return undefined;
  for (const key of ["amount_micro", "native_amount"] as const) {
    if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < 0)) return undefined;
  }
  if ((raw.amount_micro === undefined) !== (raw.currency === undefined) ||
      (raw.currency !== undefined && (typeof raw.currency !== "string" || !/^[a-z]{3}$/.test(raw.currency)))) return undefined;
  if ((raw.credit_id === undefined) !== (raw.draw_id === undefined)) return undefined;
  for (const key of ["credit_id", "draw_id", "native_asset"] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== "string" || raw[key].trim().length === 0)) return undefined;
  }
  if (raw.rail !== undefined && !["cashu", "x402", "tempo", "lightning"].includes(String(raw.rail))) return undefined;
  return {
    amount_msats: raw.amount_msats as number,
    ...(raw.amount_micro !== undefined ? { amount_micro: raw.amount_micro as number, currency: raw.currency as string } : {}),
    ...(raw.rail !== undefined ? { rail: raw.rail as UpfrontPayment["rail"] } : {}),
    ...(raw.native_amount !== undefined ? { native_amount: raw.native_amount as number } : {}),
    ...(raw.native_asset !== undefined ? { native_asset: raw.native_asset as string } : {}),
    ...(raw.credit_id !== undefined ? { credit_id: raw.credit_id as string, draw_id: raw.draw_id as string } : {}),
  };
}
