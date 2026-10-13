import { DvmError, type ProviderInfo } from "@dvmkit/sdk/internal";

/** Exponential backoff schedule for transient payment-rejection retries. */
export const TRANSIENT_PAYMENT_BACKOFF_MS = [250, 500, 1000, 2000, 4000] as const;

/**
 * Payment rejections that clear on their own given a moment — the proofs are
 * fine, the mint just hasn't settled or answered yet. Safe to replay
 * — the DVM's accumulator is keyed on `(dvm_id, request_id)`.
 *
 * Deliberately not `err.data.retryable`: the server marks `payment_insufficient`
 * retryable (top up and pay the difference), which must never become an
 * automatic re-send of the same short payment.
 */
const TRANSIENT_PAYMENT_CODES = new Set(["proof_pending", "mint_unreachable"]);

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Transport-level failure codes that survive a retry unchanged — the request
 * either never reached the DVM or its response never got back.
 */
const TRANSPORT_FAILURE_CODES = new Set(["timeout", "provider_unreachable"]);

/**
 * Run an agent-wallet payment-submission against a DVM with the per-call
 * retry policy specified in
 *
 *   - {@link TRANSIENT_PAYMENT_CODES} → exponential backoff
 *     [250, 500, 1000, 2000, 4000] ms.
 *   - `wrong_lock_pubkey` → force-refetch `/v1/info`; retry once if the
 *     refreshed `lock_pubkeys` still advertises the intended target.
 *   - `timeout` / `provider_unreachable`, when `retryTransportFailureOnce` is
 *     set → one immediate retry.
 *
 * Both the upfront submit (`request.ts`) and the mid-job `sendMessage`
 * (`payment-responder.ts`) wrap their transport call in `attempt` so the
 * retry orchestration stays in one place.
 *
 * Other failures (`payment_invalid`, exhausted transient retries,
 * `payment_lock_pubkey_stale`) propagate. The caller decides whether to
 * `commitAgentSpend` (success), `abandonPendingSubmission` (permanent
 * reject), or leave the `pending_submission` on disk (transient).
 */
export async function withAgentWalletPaymentRetry<T>(args: {
  attempt: () => Promise<T>;
  intendedLockPubkey: string;
  refetchInfo: () => Promise<ProviderInfo>;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Retry once when the transport gives up (timeout / unreachable) rather than
   * propagating. Set by the upfront paid submit, where the proofs are already
   * spent at the mint: a failure that leaves the caller unsure whether the DVM
   * took the payment is worth one more round-trip to resolve. Safe to replay —
   * the DVM's accumulator is keyed on `(dvm_id, request_id)`, so a duplicate
   * that does land is rejected as a replay rather than charged twice.
   */
  retryTransportFailureOnce?: boolean;
}): Promise<T> {
  const { attempt, intendedLockPubkey, refetchInfo } = args;
  const sleep = args.sleep ?? defaultSleep;
  let rotationRetried = false;
  let transportRetried = false;
  let pendingAttempt = 0;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof DvmError)) throw err;

      if (
        args.retryTransportFailureOnce &&
        TRANSPORT_FAILURE_CODES.has(err.code) &&
        !transportRetried
      ) {
        transportRetried = true;
        continue;
      }

      if (TRANSIENT_PAYMENT_CODES.has(err.code)) {
        if (pendingAttempt >= TRANSIENT_PAYMENT_BACKOFF_MS.length) {
          throw err;
        }
        await sleep(TRANSIENT_PAYMENT_BACKOFF_MS[pendingAttempt]);
        pendingAttempt += 1;
        continue;
      }

      if (err.code === "wrong_lock_pubkey") {
        if (rotationRetried) {
          throw new DvmError(
            "payment_lock_pubkey_stale",
            "DVM rejected proofs after a rotation refetch — the swap target is no longer advertised.",
            "Wallet retains the locked outputs as a pending_submission for manual recovery."
          );
        }
        let refreshed: ProviderInfo;
        try {
          refreshed = await refetchInfo();
        } catch {
          throw err;
        }
        const target = intendedLockPubkey.toLowerCase();
        const matches = (refreshed.cashu?.lock_pubkeys ?? []).some(
          (pk) => pk.toLowerCase() === target
        );
        if (!matches) {
          throw new DvmError(
            "payment_lock_pubkey_stale",
            "DVM has rotated past the lock pubkey our outputs were swapped to.",
            "Wallet retains the locked outputs as a pending_submission for manual recovery."
          );
        }
        rotationRetried = true;
        continue;
      }

      throw err;
    }
  }
}
