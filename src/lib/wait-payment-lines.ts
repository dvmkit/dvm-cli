import { asProviderText, type Message } from "@dvmkit/sdk/internal";
import { loadMessages } from "./messages";
import { observePaymentBookings, type PaymentBooking } from "./payment-bookings";
import { paidConfirmationDisplay } from "./payment-copy";
import type { AutoPayment, StreamLoopOptions } from "./stream-loop";

/**
 * Orders a waiting command's auto-payment reports against its message reports.
 * Each confirmed auto-payment is reported once per ask seq, whether the stream
 * loop sent it or a reconciliation booked a payment whose send returned no
 * answer; a booking is reported as it is booked, in the same shape. A report
 * waits for its ask's message when that ask is newer than the command's
 * starting cursor, so the ask always comes first; anything still waiting is
 * reported when the command finishes, including on an error.
 */
export function createWaitPaymentLines(opts: StreamLoopOptions) {
  const report = opts.onAutoPayment;
  const emitted = new Set<number>();
  const reported = new Set<number>();
  const waiting = new Map<number, AutoPayment>();

  function write(payment: AutoPayment, seq: number, force = false): void {
    if (reported.has(seq)) return;
    if (!force && seq > opts.afterSeq && !emitted.has(seq)) {
      waiting.set(seq, payment);
      return;
    }
    waiting.delete(seq);
    reported.add(seq);
    report?.(payment, seq);
  }
  const stop = report ? observePaymentBookings((booking) => {
    if (booking.jobId === opts.jobId && booking.approval === "auto") write(bookedPayment(booking), booking.requestSeq);
  }) : () => undefined;

  return {
    onMessage(message: Message): void {
      opts.onMessage?.(message);
      emitted.add(message.seq);
      const pending = waiting.get(message.seq);
      if (pending) write(pending, message.seq);
    },
    onAutoPayment: write,
    finish(): void {
      stop();
      for (const seq of [...waiting.keys()].sort((a, b) => a - b)) write(waiting.get(seq)!, seq, true);
    },
  };
}

// The same fields and wording the stream loop reports for a payment it sent.
function bookedPayment(booking: PaymentBooking): AutoPayment {
  const ask = loadMessages(booking.jobId).find((message) =>
    message.seq === booking.requestSeq && message.type === "payment-request");
  const content = ask?.type === "payment-request" ? ask.content : undefined;
  const paid = { status: "paid" as const, rail: booking.rail, amountMsats: booking.amountMsats,
    ...(booking.amountUsdcMicro !== undefined ? { amountUsdcMicro: booking.amountUsdcMicro } : {}) };
  return {
    amount_msats: booking.amountMsats,
    rail: booking.rail,
    reason: asProviderText(booking.reason ?? content?.reason ?? ""),
    ...(booking.amountUsdcMicro !== undefined ? { amount_usdc_microunits: booking.amountUsdcMicro } : {}),
    display: paidConfirmationDisplay(paid, content?.fiat_amount),
  };
}
