import type { Message } from "@dvmkit/sdk/internal";
import { formatAmountBestEffort, formatPaymentAmount } from "./currency";
import { info } from "./output";
import { finalizeProgressLine, renderProgressLine } from "./progress-bar";
import { type ArtifactSaveSession, createArtifactSaveSession, saveArtifact } from "./save-artifact";

export function paymentAmount(msg: Extract<Message, { type: "payment" }>): string {
  if (msg.from === "requester" && msg.content.credit) {
    const credit = msg.content.credit;
    const digits = String(credit.amount_micro).padStart(7, "0");
    const fraction = digits.slice(-6).replace(/0+$/, "");
    const amount = digits.slice(0, -6) + (fraction ? `.${fraction}` : "");
    return `${amount} ${credit.currency.toUpperCase()} from prepaid balance`;
  }
  return formatAmountBestEffort(msg.content.amount_msats);
}

export function formatMessageHuman(
  msg: Message,
  jobId?: string,
  artifactSession?: ArtifactSaveSession
): void {
  const { seq, type } = msg;
  const prefix = msg.from === "provider" ? "Provider" : "You";

  // Progress redraws a single line in TTY mode; every other type prints a
  // standalone line, so flush the bar's trailing position first.
  if (msg.type !== "progress") finalizeProgressLine();

  switch (msg.type) {
    case "text":
      info(`[${msg.seq}] ${prefix}: ${msg.content.text}`);
      break;
    case "prompt":
      info(`[${msg.seq}] ${prefix} asks: ${msg.content.text}`);
      if (msg.content.options) {
        for (const opt of msg.content.options) {
          info(`  - ${opt}`);
        }
      }
      break;
    case "response":
      info(msg.content.text
        ? `[${msg.seq}] ${prefix} answered: ${msg.content.text}${msg.content.data ? " (with structured data)" : ""}`
        : `[${msg.seq}] ${prefix} sent a structured answer.`);
      break;
    case "approval":
      info(`[${msg.seq}] ${prefix} approved${msg.content.ref_seq !== undefined ? ` message ${msg.content.ref_seq}` : " the job"}${msg.content.comment ? `: ${msg.content.comment}` : ""}`);
      break;
    case "artifact": {
      const label = msg.content.name ?? msg.content.mime_type ?? "unknown type";
      if (jobId) {
        const saved = saveArtifact(msg.content, artifactSession ?? createArtifactSaveSession());
        if (saved) {
          info(
            `[${msg.seq}] ${prefix} sent artifact: ${label} (${saved.bytes.toLocaleString()} bytes → ${saved.path})`
          );
          break;
        }
      }
      info(`[${msg.seq}] ${prefix} sent artifact: ${label}`);
      break;
    }
    case "payment-request":
      info(
        `[${msg.seq}] ${prefix} requests ${formatPaymentAmount(msg.content.amount_msats, msg.content.fiat_amount, { anchor: false })}${msg.content.reason ? `: ${msg.content.reason}` : ""}`
      );
      break;
    case "payment": {
      const amount = paymentAmount(msg);
      if (msg.from === "provider") {
        const noun = msg.content.reason === "change" ? "change" : "refund";
        info(`[${msg.seq}] ${prefix} sent ${noun}: ${amount}`);
      } else {
        info(`[${msg.seq}] ${prefix} paid: ${amount}`);
      }
      break;
    }
    case "complete":
      info(`[${msg.seq}] Job complete${msg.content.summary ? `: ${msg.content.summary}` : ""}`);
      break;
    case "working":
      info(
        `[${msg.seq}] Provider is working${msg.content.estimate_seconds ? ` (est. ${String(msg.content.estimate_seconds)}s)` : ""}${msg.content.hint ? `: ${msg.content.hint}` : ""}`
      );
      break;
    case "progress":
      renderProgressLine(msg.content, msg.seq);
      break;
    case "cancel":
      info(`[${msg.seq}] Job ended${msg.content.reason ? `: ${msg.content.reason}` : ""}`);
      break;
    default:
      info(`[${seq}] ${prefix} sent a message of type "${type}".`);
  }
}

