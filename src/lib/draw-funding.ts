import {
  isDrawFundingReceipt, verifyDrawFundingReceiptChain,
  type DrawFundingReceipt, type ReceiptCredit,
} from "@dvmkit/sdk/internal";
import { sameEndpoint } from "./job-access";
import { loadJob, mutateCreditPayment, type JobRecord } from "./job-store";
import { info } from "./output";

function verifiedFunding(job: JobRecord, receipt: unknown, fundId?: string): DrawFundingReceipt | undefined {
  const binding = job.creditBinding;
  if (!binding || "unbound" in binding || !isDrawFundingReceipt(receipt)) return;
  const verdict = verifyDrawFundingReceiptChain({
    receipt, builder: job.builderAnchor,
    expectedJobId: job.id, expectedCreditId: binding.creditId,
    expectedDrawId: binding.drawId, expectedCallerPubkey: binding.callerPubkey,
    ...(fundId ? { expectedFundId: fundId } : {}),
  });
  if (verdict.status === "verified" || verdict.status === "verified_unattested") return receipt;
}

export function captureDrawFundingReceipts(
  jobId: string,
  receipts: unknown[] | undefined,
  opts?: { endpoint?: string; fundId?: string; paymentSeq?: number }
): void {
  if (!receipts?.length || !loadJob(jobId)) return;
  try {
    // Bind and deduplicate against the current job under the same lock as its
    // payment booking, so a concurrent recovery cannot overwrite either fact.
    mutateCreditPayment(jobId, (job) => {
      if (opts?.endpoint && !sameEndpoint(job.endpoint, opts.endpoint)) return;
      for (const raw of receipts) {
        const receipt = verifiedFunding(job, raw, opts?.fundId);
        if (!receipt || (opts?.paymentSeq !== undefined && receipt.payment_seq !== undefined &&
            receipt.payment_seq !== opts.paymentSeq)) {
          info("Warning: mid-job funding evidence did not verify; credit comparisons remain unchanged.");
          continue;
        }
        const held = (Array.isArray(job.drawFundingReceipts) ? job.drawFundingReceipts : [])
          .filter((entry) => verifiedFunding(job, entry) !== undefined);
        if (!held.some((entry) => entry.fund_id === receipt.fund_id)) {
          held.push(receipt);
          job.drawFundingReceipts = held;
        }
      }
    });
  } catch (error) {
    info(`Warning: could not store mid-job funding evidence: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function jobDrawFundings(jobId: string, endpoint: string, callerPubkey: string, credit: ReceiptCredit) {
  const job = loadJob(jobId);
  const binding = job?.creditBinding;
  if (!job || !sameEndpoint(job.endpoint, endpoint) || !binding || "unbound" in binding ||
      binding.callerPubkey !== callerPubkey || binding.creditId !== credit.credit_id ||
      binding.drawId !== credit.draw_id) return [];
  // jobs.json is editable; re-verify before handing facts to the SDK's atomic
  // admission/comparison boundary, which also enforces the stored DVM identity.
  return (Array.isArray(job.drawFundingReceipts) ? job.drawFundingReceipts : [])
    .filter((receipt) => verifiedFunding(job, receipt) !== undefined)
    .map((receipt) => ({ receipt, builder: job.builderAnchor }));
}
