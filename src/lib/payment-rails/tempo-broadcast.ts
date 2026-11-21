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

/**
 * Run `send`, and once more when the provider answers `not_broadcast` marked
 * retryable: it found the transaction neither mined nor pooled and released its
 * hash. `send` must carry the same signed credential both times, because a new
 * payment could settle beside the transaction that is still valid. A second
 * refusal is the caller's to surface.
 */
export async function sendTempoCredential<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (err) {
    if (tempoBroadcastRefusal(err) !== "not_broadcast" || (err as DvmError).data?.retryable !== true) throw err;
    return send();
  }
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
export function tempoBroadcastOutcome(err: unknown): unknown {
  const refusal = tempoBroadcastRefusal(err);
  if (!refusal) return err;
  const source = err as DvmError;
  const transactionHash = typeof source.data?.transaction_hash === "string" ? source.data.transaction_hash : undefined;
  const settlementUnconfirmed = refusal === "settlement_unconfirmed";
  return new DvmError(
    settlementUnconfirmed ? "tempo_settlement_unconfirmed" : "tempo_not_broadcast",
    settlementUnconfirmed
      ? "The provider could not confirm whether the Tempo payment settled."
      : "The provider could not broadcast the Tempo payment, even when the same credential was sent again.",
    "Do not pay again: the signed transfer may still settle, and a second payment could be charged as well. " +
      `Contact the provider's operator with ${transactionHash ? `the transaction hash (${transactionHash})` : "the request id"}.`,
    {
      reason: refusal,
      rail: "tempo",
      ...(typeof source.data?.retryable === "boolean" ? { retryable: source.data.retryable } : {}),
      ...(transactionHash ? { transaction_hash: transactionHash } : {}),
      payment_state: "unknown",
    },
    "The Tempo payment may still settle. Do not pay again; contact the provider with the transaction hash."
  );
}
