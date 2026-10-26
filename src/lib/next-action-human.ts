import { shellQuoteArg } from "@dvmkit/sdk/internal";
import { pollNextAction, type NextAction } from "./next-action";
import { type RefundClaim, refundSummaryHuman } from "./refund-claim";
import { info } from "./output";

export function nextActionHuman(action: NextAction): string | null {
  if (!action) return null;

  switch (action.type) {
    case "respond":
    case "pay": {
      const display = action.display.replace(/`dvm status '<job_id>'`/g, () => `\`dvm status ${shellQuoteArg(action.job_id)}\``);
      const template = action.hint.match(/`(dvm[\s\S]*)`/)?.[1]
        ?.replace(/^(dvm (?:message|pay|status)) '<job_id>'/, (_, prefix: string) => `${prefix} ${shellQuoteArg(action.job_id)}`);
      const command = action.type === "respond"
        ? template?.replace("--prompt-id '<prompt_id>'", () => `--prompt-id ${shellQuoteArg(action.prompt_id)}`)
        : template;
      if (command?.startsWith("dvm status ")) return `Next: ${action.type === "pay" ? "the provider's charge of " : ""}${display}`;
      if (action.type === "respond") {
        return `Next: ${display} Provider is waiting for your input. ${command ? `Run \`${command}\`.` : action.hint}`;
      }
      return `Next: Payment required to continue: ${display}${display.endsWith(".") ? "" : "."} Run \`${command ?? `dvm pay ${shellQuoteArg(action.job_id)}`}\`.`;
    }
    case "poll": {
      const hint = typeof action.hint === "string" ? action.hint : action.hint.text;
      const detail = hint === pollNextAction(action.job_id).hint || hint === "Job submitted, check back for updates"
        ? "" : hint.trim();
      const sentence = detail
        ? `Provider is still working: ${detail}${/[.!?]$/.test(detail) ? "" : "."}`
        : "Provider is still working.";
      return `Next: ${sentence} Keep watching with \`dvm messages ${shellQuoteArg(action.job_id)}\`.`;
    }
    case "refund":
      return action.claimed ? null : `Next: ${refundSummaryHuman(action)}`;
    case "approve":
      return `Next: ${action.hint}`;
  }
}

export function printNextActionHuman(
  action: NextAction,
  options: { refunds?: RefundClaim[]; terminal?: boolean } = {}
): void {
  const line = nextActionHuman(options.terminal ? null : action);
  const refunds = options.refunds ?? [];
  for (const [index, claim] of refunds.entries()) {
    // The last unclaimed refund is already the final recovery instruction.
    if (line && action?.type === "refund" && !action.claimed && index === refunds.length - 1) continue;
    info(refundSummaryHuman(claim));
  }
  if (line) info(line);
}
