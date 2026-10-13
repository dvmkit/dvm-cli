import type { Wallet } from "@cashu/cashu-ts";

/**
 * What the mint threw during SDK operations, bucketed by quote.
 * The SDK exposes bounded terminal errors after retry exhaustion, while the
 * CLI uses the original error only to preserve its established presentation
 * metadata (class name and mint-supplied Retry-After).
 */
export class MintFailureLog {
  private readonly byQuote = new Map<string, unknown[]>();

  open(): (err: unknown, quoteId?: string) => void {
    return (err, quoteId) => {
      if (quoteId === undefined) return;
      const bucket = this.byQuote.get(quoteId) ?? [];
      bucket.push(err);
      this.byQuote.set(quoteId, bucket);
    };
  }

  clear(quoteId?: string): void {
    if (quoteId !== undefined) this.byQuote.delete(quoteId);
  }

  claim(quoteId: string): unknown {
    const bucket = this.byQuote.get(quoteId);
    this.byQuote.delete(quoteId);
    return bucket !== undefined && bucket.length > 0 ? bucket[bucket.length - 1] : undefined;
  }
}

/**
 * Turn a failed wallet lookup into the same failure at the quote-read step.
 * The SDK still classifies and retries the original error, while the observer
 * can now associate it with the quote ID passed to the read.
 */
export function quoteFailureWallet(err: unknown): Wallet {
  const fail = async () => {
    throw err;
  };
  return {
    checkMintQuoteBolt11: fail,
    checkMeltQuoteBolt11: fail,
  } as unknown as Wallet;
}

/**
 * Passively observe failures from a mint wallet. This never retries, sleeps,
 * or changes an error; the SDK remains the sole owner of retry policy.
 */
export function observeMintFailures(
  wallet: Wallet,
  onError: (err: unknown, quoteId?: string) => void,
  onSuccess: (quoteId?: string) => void = () => undefined
): Wallet {
  return observe(wallet, onError, onSuccess, true, {}) as Wallet;
}

function observe(
  target: object,
  onError: (err: unknown, quoteId?: string) => void,
  onSuccess: (quoteId?: string) => void,
  descend: boolean,
  state: { quoteId?: string }
): object {
  const nested = new Map<PropertyKey, object>();
  return new Proxy(target, {
    get(obj, prop) {
      const value: unknown = Reflect.get(obj, prop, obj);
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          if (
            (prop === "checkMintQuoteBolt11" || prop === "checkMeltQuoteBolt11") &&
            typeof args[0] === "string"
          ) {
            state.quoteId = args[0];
          }
          try {
            const result: unknown = (value as (...a: unknown[]) => unknown).apply(obj, args);
            return isThenable(result)
              ? result.then(
                  (resolved) => {
                    onSuccess(state.quoteId);
                    return resolved;
                  },
                  (err: unknown) => {
                    onError(err, state.quoteId);
                    throw err;
                  }
                )
              : (onSuccess(state.quoteId), result);
          } catch (err) {
            onError(err, state.quoteId);
            throw err;
          }
        };
      }
      if (!descend || typeof value !== "object" || value === null) return value;
      const cached = nested.get(prop);
      if (cached) return cached;
      const proxy = observe(value, onError, onSuccess, false, state);
      nested.set(prop, proxy);
      return proxy;
    },
  });
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
