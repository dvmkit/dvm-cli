import { formatFiat } from "@dvmkit/sdk";
import { listCredits, type JobReceipt, type Message } from "@dvmkit/sdk/internal";
import type { JobRecord } from "./job-store";

type ReceiptSettlement = NonNullable<JobReceipt["settlement"]>;

/** A piece-charging receipt's settlement, in integer micro-units of `currency`. */
export interface PieceSettlement {
  held_micro: number;
  charged_micro: number;
  released_micro: number;
  /** What a caller's cancel charged for the piece of work it stopped. */
  stopped_micro: number;
  /** `null` when no local record names the credit's currency. */
  currency: string | null;
  /**
   * The most this ending may charge, from this CLI's own payments and the asks
   * it saw. Absent when a needed price is not recorded locally.
   */
  ceiling_micro?: number;
  /**
   * What set {@link ceiling_micro}: this CLI's own payments and the asks it saw,
   * or, when those cannot be trusted, the pieces the receipt itself lists.
   */
  ceiling_basis?: CeilingBasis;
  /** The receipt charges more than {@link ceiling_micro}. */
  overcharged: boolean;
  display: string;
}

export interface PieceContext {
  job?: JobRecord | null;
  messages?: Message[];
  /** The provider's credit currency, for reads with no local record of the job's prices. */
  currency?: string;
}

/**
 * Summarise a receipt's piece settlement and check it against what this CLI
 * paid. Undefined for receipts without `settlement`, which older DVMs issue.
 *
 * Every payment buys one piece; an ask finishes the piece in progress. A
 * completed job, or this caller's cancel, may charge every paid piece. Any
 * other ending (a decline, failure, expiry, or provider cancel) releases the
 * piece in progress, so it may charge only the pieces finished by the latest
 * ask this CLI saw (`charged_if_declined_micro`). Pieces paid after that ask
 * are allowed too unless the local log is provably whole through the job's end,
 * because an ask this CLI never saw could have finished them. Those payments are
 * trusted only when every piece the receipt lists was bought by a payment in the
 * local log; otherwise the receipt is checked against itself alone. Either way the
 * charge may not exceed what the receipt's own finished and stopped pieces sum to.
 */
export function pieceSettlement(receipt: JobReceipt, context: PieceContext = {}): PieceSettlement | undefined {
  const settlement = receipt.settlement;
  if (!isSettlement(settlement)) return undefined;
  const job = context.job ?? undefined;
  const messages = [...(context.messages ?? [])].sort((a, b) => a.seq - b.seq);
  const currency = settlementCurrency(receipt, job, messages, context.currency);
  const stopped = settlement.pieces
    .filter((piece) => piece.state === "stopped")
    .reduce((sum, piece) => sum + piece.charged, 0);
  const ending = receipt.outcome === "completed" ? "finish"
    : receipt.outcome === "cancelled" && job?.callerCancelled && !job.callerDeclined ? "stop" : "release";
  // Without the message log there are no seen payments or asks to check against.
  const paid = currency && job && context.messages !== undefined && settlement.pieces.length > 0
    ? paidCeiling(job, messages, settlement, currency, ending) : undefined;
  // The receipt's own pieces must account for its charge.
  const listed = settlement.pieces.length > 0 ? settlement.pieces
    .filter((piece) => piece.state === "finished" || piece.state === "stopped")
    .reduce((sum, piece) => sum + Math.min(piece.charged, piece.amount), 0) : undefined;
  const basis = paid !== undefined && (listed === undefined || paid <= listed) ? "payments"
    : listed !== undefined ? "receipt_pieces" : undefined;
  const ceiling = basis === "payments" ? paid : listed;
  const overcharged = ceiling !== undefined && settlement.charged > ceiling;
  const money = (micro: number) => formatMicro(micro, currency);
  let display = `Charged ${money(settlement.charged)} of ${money(settlement.held)} held, ${money(settlement.released)} released.`;
  if (overcharged) display += ` ${overchargeClause(basis!, money(ceiling!))}`;
  return {
    held_micro: settlement.held,
    charged_micro: settlement.charged,
    released_micro: settlement.released,
    stopped_micro: stopped,
    currency,
    ...(ceiling !== undefined ? { ceiling_micro: ceiling, ceiling_basis: basis! } : {}),
    overcharged,
    display,
  };
}

export type CeilingBasis = "payments" | "receipt_pieces";

/** Why a charge above its ceiling is wrong, worded for the basis that set it. */
export function overchargeClause(basis: CeilingBasis, ceiling: string): string {
  return basis === "payments"
    ? `This charge exceeds the finished pieces this CLI paid for (at most ${ceiling}).`
    : `This charge exceeds what the receipt's own pieces add up to (${ceiling}).`;
}

/** Money in the credit's currency; bare micro-units only when no record names it. */
export function formatMicro(micro: number, currency: string | null): string {
  return currency ? formatFiat(micro / 1_000_000, currency) : `${micro.toLocaleString("en-US")} micro-units`;
}

function paidCeiling(
  job: JobRecord,
  messages: Message[],
  settlement: ReceiptSettlement,
  currency: string,
  ending: "finish" | "stop" | "release"
): number | undefined {
  let upfront = 0;
  if (job.upfrontPayment?.amount_micro !== undefined) {
    if (!sameCurrency(job.upfrontPayment.currency, currency)) return undefined;
    upfront = job.upfrontPayment.amount_micro;
  } else if (job.upfrontPayment || settlement.pieces.some((piece) => piece.paid_seq === 0)) {
    // An upfront piece exists, but its price is not recorded here.
    return undefined;
  }
  // A payment missing from the local log (a stream that died before its echo)
  // would understate what was paid; only the receipt's own pieces are checked then.
  const logged = new Set(messages.filter((message) => message.from === "requester" && message.type === "payment")
    .map((message) => message.seq));
  if (settlement.pieces.some((piece) => piece.paid_seq !== 0 && !logged.has(piece.paid_seq))) return undefined;
  let paid = upfront;
  let finished: number | undefined;
  let afterAsk = upfront;
  const asks = new Map<number, Extract<Message, { type: "payment-request" }>["content"]>();
  let latestAsk: number | undefined;
  for (const message of messages) {
    if (message.from === "provider" && message.type === "payment-request") {
      asks.set(message.seq, message.content);
      latestAsk = message.seq;
      const declined = message.content.charged_if_declined_micro;
      if (validMicro(declined) && sameCurrency(message.content.credit?.currency, currency)) {
        finished = declined;
        afterAsk = 0;
      }
    } else if (message.from === "requester" && message.type === "payment") {
      const credit = message.content.credit;
      const ask = asks.get(credit?.request_seq ?? latestAsk ?? -1)?.credit;
      const price = credit ? credit : ask;
      if (!price || !validMicro(price.amount_micro) || !sameCurrency(price.currency, currency)) return undefined;
      paid += price.amount_micro;
      afterAsk += price.amount_micro;
    }
  }
  if (ending !== "release") return paid;
  return wholeThroughEnd(messages) ? (finished ?? 0) : (finished ?? 0) + afterAsk;
}

/** Contiguous from the first seq and ending in a terminal message: no ask went unseen. */
function wholeThroughEnd(messages: Message[]): boolean {
  if (messages.length === 0 || messages[0].seq > 1) return false;
  if (!messages.every((message, index) => index === 0 || message.seq === messages[index - 1].seq + 1)) return false;
  return messages.some((message) => message.type === "complete" || message.type === "cancel" || message.type === "decline");
}

/**
 * The receipt names no currency, so take it from local records of this job's
 * prices. Only a plain ISO code is used: it reaches relayed display text.
 */
function settlementCurrency(receipt: JobReceipt, job: JobRecord | undefined, messages: Message[], hint?: string): string | null {
  const candidates: (string | undefined)[] = [job?.upfrontPayment?.currency];
  for (const message of [...messages].reverse()) {
    if (message.type === "payment-request" && message.from === "provider") candidates.push(message.content.credit?.currency);
    if (message.type === "payment" && message.from === "requester") candidates.push(message.content.credit?.currency);
  }
  candidates.push(hint);
  const creditId = receipt.credit?.credit_id;
  if (creditId) candidates.push(safeCredits().find((credit) => credit.creditId === creditId)?.currency);
  const found = candidates.find((currency) => typeof currency === "string" && currency.length > 0);
  return found && /^[a-z]{3}$/i.test(found) ? found.toLowerCase() : null;
}

function safeCredits(): ReturnType<typeof listCredits> {
  try {
    return listCredits();
  } catch {
    return [];
  }
}

function sameCurrency(a: string | undefined, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b;
}

function validMicro(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSettlement(value: unknown): value is ReceiptSettlement {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<ReceiptSettlement>;
  return validMicro(s.held) && validMicro(s.charged) && validMicro(s.released) && Array.isArray(s.pieces) &&
    s.pieces.every((piece) => piece && typeof piece === "object" && validMicro(piece.amount) &&
      validMicro(piece.charged) && typeof piece.state === "string");
}
