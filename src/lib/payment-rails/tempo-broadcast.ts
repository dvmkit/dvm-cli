import { DvmError } from "@dvmkit/sdk/internal";

/**
 * A provider whose Tempo charge broadcast failed reads the chain and, when it
 * cannot prove the transfer, answers 402 `payment_invalid` with `rail: "tempo"`
 * and one of these reasons. Both leave the signed transaction valid, so neither
 * may be answered with a new credential.
 */
export type TempoBroadcastRefusal = "not_broadcast" | "settlement_unconfirmed";

export function tempoBroadcastRefusal(err: unknown): TempoBroadcastRefusal | undefined {
  if (!(err instanceof DvmError) || err.code !== "payment_invalid") return undefined;
  if (err.data?.rail !== "tempo") return undefined;
  const reason = err.data.reason;
  return reason === "not_broadcast" || reason === "settlement_unconfirmed" ? reason : undefined;
}

interface TempoResendOptions {
  expires?: string;
  deadlineMs?: number;
  onPendingSettlement?: (refusal: DvmError) => void;
}

const MAX_RESENDS = 5;
const DEFAULT_SETTLEMENT_DELAY_MS = 2_000;
const MAX_SETTLEMENT_DELAY_MS = 10_000;

/** Every send must carry the original signed credential. */
export async function sendTempoCredential<T>(send: () => Promise<T>, options: TempoResendOptions = {}): Promise<T> {
  const expiresMs = Date.parse(options.expires ?? "");
  const resendBefore = Math.min(
    Number.isFinite(expiresMs) ? expiresMs : Infinity,
    options.deadlineMs ?? Infinity
  );
  let notBroadcastResent = false;

  for (let resends = 0; ; resends++) {
    try {
      return await send();
    } catch (error) {
      if (!(error instanceof DvmError)) throw error;
      const refusal = tempoBroadcastRefusal(error);
      if (refusal === "settlement_unconfirmed") options.onPendingSettlement?.(error);

      if (!refusal || error.data?.retryable !== true || resends >= MAX_RESENDS) throw error;
      if (refusal === "not_broadcast" && notBroadcastResent) throw error;

      const delay = refusal === "settlement_unconfirmed" ? settlementDelayMs(error.data.retry_after_ms) : 0;
      if (Date.now() + delay >= resendBefore) throw error;
      if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        if (Date.now() >= resendBefore) throw error;
      }
      if (refusal === "not_broadcast") notBroadcastResent = true;
    }
  }
}

function settlementDelayMs(delay: unknown): number {
  return typeof delay === "number" && Number.isFinite(delay)
    ? Math.min(MAX_SETTLEMENT_DELAY_MS, Math.max(0, delay))
    : DEFAULT_SETTLEMENT_DELAY_MS;
}

const TEMPO_BROADCAST_CODES: ReadonlySet<string> = new Set(["tempo_not_broadcast", "tempo_settlement_unconfirmed"]);

/** Whether an error is the terminal outcome built by {@link tempoBroadcastOutcome}. */
export function isTempoBroadcastOutcome(err: unknown): boolean {
  return err instanceof DvmError && TEMPO_BROADCAST_CODES.has(err.code);
}

/**
 * The terminal error for a broadcast refusal that no resend resolved, or
 * `err` itself when it is not one. It carries the provider's machine fields and
 * the CLI's own wording: the payment may still settle, so an agent must not
 * pay again.
 */
export function tempoBroadcastOutcome(err: unknown, pendingSettlement?: DvmError): unknown {
  // A plain or expired refusal cannot distinguish a transfer that settled
  // from one that expired while the provider was waiting for it.
  const ambiguousRefusal = err instanceof DvmError && err.code === "payment_invalid"
    && (err.data?.reason === undefined || err.data.reason === "expired");
  const source = pendingSettlement && ambiguousRefusal ? pendingSettlement : err;
  const refusal = tempoBroadcastRefusal(source);
  if (!refusal) return err;
  const data = (source as DvmError).data;
  const hash = data?.transaction_hash ?? pendingSettlement?.data?.transaction_hash;
  const transactionHash = typeof hash === "string" ? hash : undefined;
  const settlementUnconfirmed = refusal === "settlement_unconfirmed";
  return new DvmError(
    settlementUnconfirmed ? "tempo_settlement_unconfirmed" : "tempo_not_broadcast",
    settlementUnconfirmed
      ? "The provider could not confirm whether the Tempo payment settled."
      : "The provider could not broadcast the Tempo payment.",
    "Do not pay again: the signed transfer may still settle, and a second payment could be charged as well. " +
      `Contact the provider's operator with ${transactionHash ? `the transaction hash (${transactionHash})` : "the request id"}.`,
    {
      reason: refusal,
      rail: "tempo",
      ...(typeof data?.retryable === "boolean" ? { retryable: data.retryable } : {}),
      ...(transactionHash ? { transaction_hash: transactionHash } : {}),
      payment_state: "unknown",
    },
    "The Tempo payment may still settle. Do not pay again; contact the provider with the transaction hash."
  );
}
