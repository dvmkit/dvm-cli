import {
  info,
  json,
} from "../lib/output";
import {
  markJobTerminal,
} from "../lib/job-store";

import { formatIdentifier } from "../lib/dvm-identifier";
import {
  type JobAccessOptions,
  type ResolvedJobAccess,
  resolveJobAccess,
  withJobTokenRedaction,
} from "../lib/job-access";
import { progressNotice } from "../lib/progress-notice";
import { createDvmTransport } from "../lib/transport";
import { dvmIdentity } from "./dvm-identity";

export interface CancelOptions extends JobAccessOptions {
  reason?: string;
  human?: boolean;
}

export async function cancel(jobId: string, opts: CancelOptions): Promise<void> {
  const access = resolveJobAccess(jobId, opts);
  return withJobTokenRedaction(access.jobToken, () => cancelWithAccess(jobId, opts, access));
}

async function cancelWithAccess(
  jobId: string,
  opts: CancelOptions,
  access: ResolvedJobAccess
): Promise<void> {
  const { stored, ref, jobToken } = access;
  const transport = createDvmTransport();

  progressNotice("Cancelling job...", opts.human);
  // thread the anonymous-flow per-job token through the cancel POST
  // so anonymous callers' cancels don't 404 at the SDK gate.
  await transport.cancel(jobId, opts.reason, ref, { jobToken });
  transport.close();

  // A caller-initiated cancel carries no provider outcome to snapshot — the
  // empty snapshot is still what `dvm status` replays, so the job answers
  // `cancelled` locally forever rather than re-reading a dead job.
  if (!access.endpointOverridden) markJobTerminal(jobId, "cancelled", {});

  const identifier = stored?.dvmId ? formatIdentifier(stored.dvmId, stored.capability) : undefined;

  if (opts.human) {
    info(`Job ${jobId}${identifier ? ` [${identifier}]` : ""} cancelled.`);
  } else {
    json({
      jobId,
      ...dvmIdentity(stored?.dvmId, stored?.capability),
      status: "cancelled",
      ...(opts.reason ? { reason: opts.reason } : {}),
      next_action: null,
    });
  }
}
