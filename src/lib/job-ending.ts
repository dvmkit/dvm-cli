import { DvmError, type ProviderRef, type Transport } from "@dvmkit/sdk/internal";
import { settleCreditAfterRead } from "./credit-topup";
import type { ContentStatus } from "./job-content";
import { observeJobContent } from "./job-content";
import { type JobSettlement, terminalSettlementFields } from "./job-settlement";
import { loadJob } from "./job-store";
import { isTerminalJobStatus } from "./next-action";
import { formatMicro } from "./piece-settlement";
import { progressNotice } from "./progress-notice";
import { providerCurrency } from "./provider-currency";
import { captureTransportReceipt } from "./receipt-capture";

/** A cancel or decline landing while a payment is verified is retried this many times in all. */
export const PAYMENT_IN_PROGRESS_ATTEMPTS = 5;
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Send a job-ending write, waiting out `payment_in_progress` refusals. The DVM
 * changed nothing on that 409, so resending the same write is safe; it names
 * its wait in `Retry-After`. Any other error, or the last refusal, is thrown.
 */
export async function retryWhilePaymentInProgress<T>(
  send: () => Promise<T>,
  options: { human?: boolean; sleep?: (ms: number) => Promise<void> } = {}
): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (!(error instanceof DvmError) || error.code !== "payment_in_progress" ||
          attempt >= PAYMENT_IN_PROGRESS_ATTEMPTS) throw error;
      const requested = error.data?.retry_after_ms;
      const delay = typeof requested === "number" && Number.isFinite(requested)
        ? Math.min(Math.max(requested, 0), MAX_RETRY_DELAY_MS) : 2000;
      progressNotice(`A payment for this job is being verified; retrying in ${Math.ceil(delay / 1000)} s...`, options.human);
      await sleep(delay);
    }
  }
}

export interface EndingRead {
  status?: ContentStatus;
  /** Present only when a sound receipt carried a piece settlement. */
  settlement?: JobSettlement;
}

/**
 * Read the job once after the caller ended it, and keep the receipt when it
 * carries a piece settlement. Receipts without one (older DVMs) are left for
 * the next `dvm status`, as before. A failed read returns nothing.
 */
export async function readEnding(args: {
  jobId: string;
  transport: Transport;
  ref: ProviderRef;
  jobToken?: string;
  persistLocalState: boolean;
  human?: boolean;
}): Promise<EndingRead> {
  const status = await observeJobContent(args.jobId, args.transport, args.ref, { timeoutMs: 5000, jobToken: args.jobToken });
  if (!status || !isTerminalJobStatus(status.status) || !status.receipt?.settlement) return { status };
  if (args.persistLocalState) {
    const capture = captureTransportReceipt(args.jobId, status);
    const job = loadJob(args.jobId);
    if (job) await settleCreditAfterRead({ job, capture, transport: args.transport, human: args.human });
  }
  const currency = args.persistLocalState ? undefined
    : await providerCurrency({ receipt: status.receipt, status, transport: args.transport, ref: args.ref });
  const { settlement } = terminalSettlementFields(args.jobId, {
    status: status.status, receipt: status.receipt, persistLocalState: args.persistLocalState, currency,
  });
  return { status, ...(settlement?.charged_micro !== undefined ? { settlement } : {}) };
}

/** "Stopped. The $0.36 USD paid for the work in progress is not refunded." */
export function cancelledDisplay(settlement: JobSettlement): string {
  const stopped = settlement.stopped_micro ?? 0;
  const lead = stopped > 0
    ? `Stopped. The ${formatMicro(stopped, settlement.currency ?? null)} paid for the work in progress is not refunded.`
    : "Stopped. No work was in progress, so only finished work is charged.";
  return `${lead} ${settlement.display}`;
}
