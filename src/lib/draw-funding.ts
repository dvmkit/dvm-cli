import {
  isDrawFundingReceipt, shellQuoteArg, verifyDrawFundingReceiptChain,
  type DrawFundingReceipt, type ReceiptCredit,
} from "@dvmkit/sdk/internal";
import { sameEndpoint } from "./job-access";
import { loadJob, mutateCreditPayment, type JobRecord } from "./job-store";
import { addOutputWarnings, info } from "./output";

type FundingCheck =
  | { kind: "verified"; receipt: DrawFundingReceipt }
  | { kind: "not_applicable" }
  | { kind: "invalid"; reason: string; hint: string };

/** Credits the provider opens itself for a rail-paid job; the caller never holds their draw. */
export function isImplicitCreditId(creditId: string): boolean {
  return creditId.startsWith("imp:");
}

const MISMATCH_FIELDS: Record<string, keyof DrawFundingReceipt> = {
  credit_id_mismatch: "credit_id",
  job_id_mismatch: "job_id",
  draw_id_mismatch: "draw_id",
  fund_id_mismatch: "fund_id",
  caller_pubkey_mismatch: "caller_pubkey",
};

// Receipt fields are provider-supplied and may be unverified, so they are
// quoted in prose and never reach the relayed command: `--credit-id` would
// also select that credit for later draws.
function nextAction(job: JobRecord): string {
  return "Nothing is owed or lost: the job's terminal receipt still decides the charge. " +
    `Refresh your credit balances with \`dvm credit balance ${shellQuoteArg(job.endpoint)}\` once the job ends; ` +
    `if this repeats, report job ${JSON.stringify(job.id)} and the reason to the provider.`;
}

function invalidFunding(
  job: JobRecord, receipt: DrawFundingReceipt, reason: string,
  expected: Partial<Record<keyof DrawFundingReceipt, string>>
): FundingCheck {
  const field: keyof DrawFundingReceipt | undefined = MISMATCH_FIELDS[reason];
  const detail = field
    ? `The provider signed ${field} ${JSON.stringify(String(receipt[field]))}; this job expects ${JSON.stringify(expected[field])}.`
    : "The provider's funding evidence failed verification.";
  return { kind: "invalid", reason, hint: `${detail} ${nextAction(job)}` };
}

function verdictReason(verdict: ReturnType<typeof verifyDrawFundingReceiptChain>): string | undefined {
  if (verdict.status === "verified" || verdict.status === "verified_unattested") return undefined;
  return (verdict.status === "invalid" ? verdict.reason : undefined) ?? verdict.status;
}

function checkFunding(job: JobRecord, receipt: unknown, fundId?: string): FundingCheck {
  // A value that is not a draw-funding receipt is reported by the transport's shape check.
  if (!isDrawFundingReceipt(receipt)) return { kind: "not_applicable" };
  const binding = job.creditBinding;
  if (!binding || "unbound" in binding) {
    if (isImplicitCreditId(receipt.credit_id)) {
      // A rail-paid job runs on an implicit credit the provider opened, and each
      // later payment tops up that credit's draw. The caller holds no binding to
      // compare it with, but the receipt must still be this payment's, signed.
      const expected = { job_id: job.id, ...(fundId ? { fund_id: fundId } : {}) };
      const reason = verdictReason(verifyDrawFundingReceiptChain({
        receipt, builder: job.builderAnchor, expectedJobId: job.id,
        ...(fundId ? { expectedFundId: fundId } : {}),
      }));
      return reason ? invalidFunding(job, receipt, reason, expected) : { kind: "not_applicable" };
    }
    return { kind: "invalid", reason: "no_bound_draw",
      hint: `The provider signed funding for credit ${JSON.stringify(receipt.credit_id)}, but this job records no draw on it, ` +
        `so the local balance of that credit was not reconciled. ${nextAction(job)}` };
  }
  const expected: Partial<Record<keyof DrawFundingReceipt, string>> = {
    job_id: job.id, credit_id: binding.creditId, draw_id: binding.drawId,
    caller_pubkey: binding.callerPubkey, ...(fundId ? { fund_id: fundId } : {}),
  };
  const reason = verdictReason(verifyDrawFundingReceiptChain({
    receipt, builder: job.builderAnchor,
    expectedJobId: job.id, expectedCreditId: binding.creditId,
    expectedDrawId: binding.drawId, expectedCallerPubkey: binding.callerPubkey,
    ...(fundId ? { expectedFundId: fundId } : {}),
  }));
  return reason ? invalidFunding(job, receipt, reason, expected) : { kind: "verified", receipt };
}

function verifiedFunding(job: JobRecord, receipt: unknown): DrawFundingReceipt | undefined {
  const check = checkFunding(job, receipt);
  return check.kind === "verified" ? check.receipt : undefined;
}

export function captureDrawFundingReceipts(
  jobId: string,
  receipts: unknown[] | undefined,
  opts?: { endpoint?: string; fundId?: string }
): void {
  if (!receipts?.length || !loadJob(jobId)) return;
  try {
    // Bind and deduplicate against the current job under the same lock as its
    // payment booking, so a concurrent recovery cannot overwrite either fact.
    mutateCreditPayment(jobId, (job) => {
      if (opts?.endpoint && !sameEndpoint(job.endpoint, opts.endpoint)) return;
      for (const raw of receipts) {
        const check = checkFunding(job, raw, opts?.fundId);
        if (check.kind === "not_applicable") continue;
        if (check.kind === "invalid") {
          const display = `mid-job funding evidence did not verify (${check.reason}); credit comparisons remain unchanged. Hint: ${check.hint}`;
          // One command can read the same evidence more than once; report it once.
          const added = addOutputWarnings([{ code: "draw_funding_unverified", job_id: job.id, reason: check.reason, hint: check.hint, display }]);
          if (added.length) info(`Warning: ${display}`);
          continue;
        }
        const { receipt } = check;
        const held = (Array.isArray(job.drawFundingReceipts) ? job.drawFundingReceipts : [])
          .filter((entry) => verifiedFunding(job, entry) !== undefined);
        if (!held.some((entry) => entry.fund_id === receipt.fund_id)) {
          held.push(receipt);
          job.drawFundingReceipts = held;
        }
      }
    }, true);
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
