import type { PaymentApproval } from "./job-store";

/** A mid-job payment the job store has just booked into a job's totals. */
export interface PaymentBooking {
  jobId: string;
  requestSeq: number;
  approval?: PaymentApproval;
  rail: "cashu_p2pk" | "x402" | "tempo" | "credit";
  amountMsats: number;
  /** Exact signed x402 value in USDC microunits. */
  amountUsdcMicro?: string;
  /** The provider's ask reason recorded with the payment, when known. */
  reason?: string;
}

const listeners = new Set<(booking: PaymentBooking) => void>();

/**
 * Hear each payment booked from a held submission or a credit intent: the
 * paths that confirm a payment after its send returned without an answer.
 * Returns the function that stops listening.
 */
export function observePaymentBookings(listener: (booking: PaymentBooking) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyPaymentBooked(booking: PaymentBooking): void {
  for (const listener of listeners) listener(booking);
}
