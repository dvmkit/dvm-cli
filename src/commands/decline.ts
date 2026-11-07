import { readTerminalCompletion, terminalCompletionOutput } from "../lib/terminal-completion";
import { DvmError } from "@dvmkit/sdk/internal";
import { settlementCurrencyHint } from "../lib/piece-settlement";
import { formatIdentifier } from "../lib/dvm-identifier";
import {
  type JobAccessOptions,
  type ResolvedJobAccess,
  resolveJobAccess,
  withJobTokenRedaction,
} from "../lib/job-access";
import { readEnding, retryWhilePaymentInProgress } from "../lib/job-ending";
import { clearAskPaymentBlocks, markJobTerminal } from "../lib/job-store";
import { isTerminalJobStatus, pollNextAction } from "../lib/next-action";
import { info, withOutputWarnings } from "../lib/output";
import { guidanceJobArg, providerJobJson } from "../lib/provider-output";
import { progressNotice } from "../lib/progress-notice";
import { createDvmTransport } from "../lib/transport";
import { dvmIdentity } from "./dvm-identity";

export interface DeclineOptions extends JobAccessOptions {
  reason?: string;
  human?: boolean;
}

/**
 * Decline a job's open ask or prompt. The job ends; the caller is charged for
 * the finished pieces of work, and nothing is in progress at an open ask.
 */
export async function decline(jobId: string, opts: DeclineOptions): Promise<void> {
  const access = resolveJobAccess(jobId, opts);
  return withJobTokenRedaction(access.jobToken, () => withOutputWarnings(() => declineWithAccess(jobId, opts, access), opts.human));
}

async function declineWithAccess(jobId: string, opts: DeclineOptions, access: ResolvedJobAccess): Promise<void> {
  const { stored, ref, jobToken } = access;
  const json = (data: Record<string, unknown>) => providerJobJson(data, !!stored);
  const job = guidanceJobArg(jobId);
  const transport = createDvmTransport();

  progressNotice("Declining...", opts.human);
  const content = opts.reason !== undefined ? { reason: opts.reason } : {};
  await retryWhilePaymentInProgress(
    () => transport.sendMessage(jobId, { type: "decline", content }, ref, { jobToken }),
    { human: opts.human }
  );
  // A confirmed decline releases the piece in progress; the receipt is checked with that recorded.
  const ending = await readEnding({ jobId, transport, ref, jobToken,
    persistLocalState: !access.endpointOverridden, human: opts.human,
    onTerminal: (status) => {
      if (!access.endpointOverridden && isTerminalJobStatus(status.status)) {
        markJobTerminal(jobId, status.status,
          { ...(stored?.status === status.status ? stored.completion : {}),
            ...(opts.reason !== undefined ? { message: opts.reason } : {}) }, { callerCancelled: true, callerDeclined: true });
        clearAskPaymentBlocks(jobId);
      }
    } });
  const observed = ending.status?.status;
  // A DVM that predates decline accepts the message as ordinary conversation.
  if (observed !== undefined && !isTerminalJobStatus(observed)) {
    transport.close();
    throw new DvmError(
      "decline_unsupported",
      `The provider accepted the decline, but the job is still ${observed}.`,
      `This DVM does not end a job at a decline. Pay with \`dvm pay ${job}\`, let the ask expire, or stop the work now with \`dvm cancel ${job}\`.`,
      { jobId, status: observed }
    );
  }

  const completion = ending.status ? await readTerminalCompletion({
    jobId, status: ending.status, transport, ref, jobToken,
    saved: stored && stored.status === observed ? stored.completion : undefined,
  }) : {};
  if (observed && isTerminalJobStatus(observed) && !access.endpointOverridden) {
    const saved = stored?.status === observed ? stored.completion : undefined;
    markJobTerminal(jobId, observed, {
      ...(ending.status?.content_available === false && saved ? saved : completion),
      ...(opts.reason !== undefined ? { message: opts.reason } : {}),
    });
  }
  const artifacts = terminalCompletionOutput(jobId, observed ?? "unknown", completion, {
    human: opts.human, contentAvailable: ending.status?.content_available,
  });
  transport.close();

  const identifier = stored?.dvmId ? formatIdentifier(stored.dvmId, stored.capability) : undefined;
  const { settlement } = ending;
  const endingDisplay = observed === undefined
    ? `Decline sent, but the job's status could not be read. Check it with \`dvm status ${job}\`.`
    : settlement
      ? `Declined; the job has ended. ${settlement.display}`
      : `Declined; the job has ended. Its receipt is not available yet; \`dvm status ${job}\` shows the final charge once it is.`;

  const display = [endingDisplay, artifacts.display].filter(Boolean).join(" ");
  const hint = settlementCurrencyHint(settlement, ref.endpoint);

  if (opts.human) {
    info(`Job ${jobId}${identifier ? ` [${identifier}]` : ""}: ${display}`);
    if (hint) info(`  ${hint}`);
    return;
  }
  json({
    jobId,
    ...dvmIdentity(stored?.dvmId, stored?.capability),
    status: observed ?? "unknown",
    declined: true,
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    ...(settlement ? { settlement } : {}),
    display,
    ...artifacts.fields,
    ...(hint ? { hint } : {}),
    next_action: observed === undefined ? pollNextAction(jobId, display) : null,
  });
}
