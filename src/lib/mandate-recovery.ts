import { isPublicRequestId } from "@dvmkit/sdk/internal";
import { sameEndpoint } from "./job-access";
import { loadRequestIntent } from "./request-intent-store";
import type { JobRecord } from "./job-store";
import { loadAgentWallet, saveAgentWallet, withWalletLock,
  type PendingSubmission, type PendingSubmissionContext } from "@dvmkit/sdk/internal";

export const MANDATE_RECOVERY_DISPLAY = "The provider rejected the saved mandate, so recovery retried once without automatic future payments. Later charges need a payer attached or scheduled check-ins.";
export const MANDATE_SUBMIT_DISPLAY = "The provider refused the mandate, so the job was submitted without it, using the same payment. Later charges need a payer attached or scheduled check-ins.";

export function withoutMandate(data: Record<string, unknown>): Record<string, unknown> {
  const { mandate: _removed, ...rest } = data;
  return rest;
}

export function mandateRecoveryNotice(context: unknown): { mandateUnavailable?: string } {
  return context && typeof context === "object" && "mandate_unavailable" in context &&
    (context.mandate_unavailable === MANDATE_RECOVERY_DISPLAY || context.mandate_unavailable === MANDATE_SUBMIT_DISPLAY)
    ? { mandateUnavailable: context.mandate_unavailable } : {};
}

export async function dropPendingMandate(args: {
  requestId: string;
  context?: PendingSubmissionContext;
  display?: string;
}): Promise<PendingSubmission> {
  return withWalletLock(() => {
    const wallet = loadAgentWallet();
    const saved = wallet?.pending_submissions.find((candidate) => candidate.request_id === args.requestId);
    if (!wallet || !saved?.context) throw new Error("The pending payment journal is unavailable; recovery is held.");
    // The active context may contain a fund correction not reflected by this read.
    const active = args.context ?? saved.context;
    const data = active.submit_body.data as Record<string, unknown>;
    const context = { ...saved.context, ...active, mandate_unavailable: args.display ?? MANDATE_RECOVERY_DISPLAY,
      submit_body: { ...active.submit_body, data: withoutMandate(data) } };
    const reduced = { ...saved, context };
    saveAgentWallet({ ...wallet, pending_submissions: wallet.pending_submissions.map((candidate) =>
      candidate.request_id === args.requestId ? reduced : candidate) });
    return reduced;
  });
}


export function recoveredStandingMandate(entry: PendingSubmission): Pick<JobRecord, "mandate" | "mandateUnavailable"> {
  const context = entry.context;
  const notice = mandateRecoveryNotice(context);
  if (notice.mandateUnavailable) return { mandate: undefined, ...notice };
  const data = context?.submit_body.data as Record<string, unknown> | undefined;
  if (context?.route === "credit" || !isPublicRequestId(data?.request_id) || !data?.mandate) return {};
  const intent = loadRequestIntent(data.request_id);
  const mandate = intent?.mandate;
  if (!intent || !mandate || !sameEndpoint(intent.endpoint, entry.endpoint) || intent.callerPubkey !== context?.signing_pubkey ||
      mandate.credit_id !== data.credit_id || mandate.draw_id !== data.draw_id) return {};
  const limits = data.mandate as Record<string, unknown>;
  if (limits.max_total_micro !== mandate.max_total_micro || limits.max_ask_micro !== mandate.max_ask_micro ||
      limits.expires_at_ms !== mandate.expires_at_ms) return {};
  return { mandate };
}
