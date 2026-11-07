import { readTerminalCompletion, terminalCompletionOutput } from "../lib/terminal-completion";
import { guidanceJobArg, providerJobJson } from "../lib/provider-output";
import {
  info,
  withOutputWarnings,
} from "../lib/output";
import {
  type JobRecord,
  clearAskPaymentBlocks,
  markJobTerminal,
} from "../lib/job-store";

import { formatIdentifier } from "../lib/dvm-identifier";
import {
  type JobAccessOptions,
  type ResolvedJobAccess,
  resolveJobAccess,
  withJobTokenRedaction,
} from "../lib/job-access";
import { cancelledDisplay, readEnding, retryWhilePaymentInProgress } from "../lib/job-ending";
import { settlementCurrencyHint } from "../lib/piece-settlement";
import { isTerminalJobStatus } from "../lib/next-action";
import { loadMessages } from "../lib/messages";
import { progressNotice } from "../lib/progress-notice";
import { createDvmTransport } from "../lib/transport";
import { dvmIdentity } from "./dvm-identity";

export interface CancelOptions extends JobAccessOptions {
  reason?: string;
  human?: boolean;
}

export async function cancel(jobId: string, opts: CancelOptions): Promise<void> {
  const access = resolveJobAccess(jobId, opts);
  return withJobTokenRedaction(access.jobToken, () => withOutputWarnings(() => cancelWithAccess(jobId, opts, access), opts.human));
}

async function cancelWithAccess(
  jobId: string,
  opts: CancelOptions,
  access: ResolvedJobAccess
): Promise<void> {
  const { stored, ref, jobToken } = access;
  const json = (data: Record<string, unknown>) => providerJobJson(data, !!stored);
  const transport = createDvmTransport();

  progressNotice("Cancelling job...", opts.human);
  // thread the anonymous-flow per-job token through the cancel POST
  // so anonymous callers' cancels don't 404 at the SDK gate.
  await retryWhilePaymentInProgress(() => transport.cancel(jobId, opts.reason, ref, { jobToken }), { human: opts.human });

  if (!access.endpointOverridden) markJobTerminal(jobId, "cancelled",
    { ...(stored?.status === "cancelled" ? stored.completion : {}),
      ...(opts.reason !== undefined ? { message: opts.reason } : {}) }, { callerCancelled: true });

  // A piece-charging DVM charges the work in progress on a cancel; its receipt says how much.
  // An accepted cancel can leave the ask open, so only a confirmed ending lifts its block.
  const { settlement, status } = await readEnding({ jobId, transport, ref, jobToken,
    persistLocalState: !access.endpointOverridden, human: opts.human,
    onTerminal: () => { if (!access.endpointOverridden) clearAskPaymentBlocks(jobId); } });
  const saved = stored?.status === "cancelled" ? stored.completion : undefined;
  const completion = await readTerminalCompletion({
    jobId, status: status ?? { status: "cancelled" }, saved, transport, ref, jobToken,
  });
  if (!access.endpointOverridden) markJobTerminal(jobId, "cancelled", {
    ...(status?.content_available === false && saved ? saved : completion),
    ...(opts.reason !== undefined ? { message: opts.reason } : {}),
  });
  const artifacts = terminalCompletionOutput(jobId, "cancelled", completion, {
    human: opts.human, contentAvailable: status?.content_available,
  });
  transport.close();

  const identifier = stored?.dvmId ? formatIdentifier(stored.dvmId, stored.capability) : undefined;
  // A receipt that is not signed yet still decides the charge; say where it will show.
  const receiptPending = !settlement && status !== undefined && isTerminalJobStatus(status.status) &&
    !status.receipt && !status.receiptParseError && !access.endpointOverridden && expectsReceipt(jobId, stored);
  const endingDisplay = settlement ? cancelledDisplay(settlement)
    : receiptPending ? `Stopped. Its receipt is not available yet; \`dvm status ${guidanceJobArg(jobId)}\` shows what was charged once it is.`
    : undefined;
  const display = [endingDisplay, artifacts.display].filter(Boolean).join(" ") || undefined;
  // The labelled "(currency not recorded)" amount in `display` needs its reason beside it.
  const hint = settlementCurrencyHint(settlement, ref.endpoint);

  if (opts.human) {
    info(`Job ${jobId}${identifier ? ` [${identifier}]` : ""} cancelled.`);
    if (display) info(display);
    if (hint) info(`  ${hint}`);
  } else {
    json({
      jobId,
      ...dvmIdentity(stored?.dvmId, stored?.capability),
      status: "cancelled",
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(settlement ? { settlement } : {}),
      ...(display ? { display } : {}),
      ...artifacts.fields,
      ...(hint ? { hint } : {}),
      next_action: null,
    });
  }
}

/** The DVM signs receipts, or this job's asks show it charges by the piece. */
function expectsReceipt(jobId: string, stored: JobRecord | null): boolean {
  return stored?.receiptsSupported === true || loadMessages(jobId).some((message) =>
    message.from === "provider" && message.type === "payment-request" &&
    typeof message.content.charged_if_declined_micro === "number");
}
