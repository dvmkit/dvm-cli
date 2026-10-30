import {
  DvmError,
  isAbortError,
  type ProviderInfo,
  type ProviderRef,
  type Transport,
} from "@dvmkit/sdk/internal";

export interface WarmupProviderOptions {
  /** Overall wall-clock budget across all attempts, in ms. Default 30_000. */
  budgetMs?: number;
  /** Maximum number of `/v1/info` attempts before giving up. Default 4. */
  maxAttempts?: number;
  /** Base delay between attempts, in ms; doubles each retry. Default 400. */
  baseBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BUDGET_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 4_000;

/**
 * Wake a possibly auto-stopped DVM and fetch its `/v1/info`, retrying transient
 * failures within a bounded time budget.
 *
 * The first `/v1/info` probe against a scale-to-zero DVM (the whole first-party
 * fleet runs Fly `autostop=suspend`) can land mid-resume and come
 * back as a truncated / non-JSON body, a dropped socket, or a 502 — all of which
 * {@link Transport.describe} surfaces as a throw. This retries with
 * exponential backoff so a resume race is transparent to the caller.
 *
 * Retrying is always safe here: this is the pre-payment probe (`GET /v1/info`,
 * idempotent) with no money at stake. A protocol mismatch or missing descriptor
 * is terminal; retrying cannot resolve either. A genuinely dead endpoint
 * still fails fast (attempts are bounded) with the same `endpoint_unreachable`.
 * The wrapped error messages match the single-shot behaviour they replace.
 */
export async function warmupProvider(
  transport: Transport,
  ref: ProviderRef,
  options: WarmupProviderOptions = {}
): Promise<ProviderInfo> {
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const sleep = options.sleep ?? defaultSleep;
  const { endpoint } = ref;
  const deadline = Date.now() + budgetMs;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const attemptsLeft = maxAttempts - attempt + 1;
    const timeoutMs = Math.max(1, Math.floor(remaining / attemptsLeft));
    try {
      return await transport.describe(ref, { timeoutMs });
    } catch (err) {
      lastErr = err;
      if (err instanceof DvmError && ["unsupported_version", "not_a_dvm_endpoint"].includes(err.code)) throw err;
      const budgetLeft = deadline - Date.now();
      if (attempt >= maxAttempts || budgetLeft <= 0) break;
      const futureAttempts = maxAttempts - attempt;
      // A zero timeout disables transport cancellation, so retain at least one
      // millisecond for each later attempt before spending budget on backoff.
      const backoff = Math.min(
        baseBackoffMs * 2 ** (attempt - 1),
        MAX_BACKOFF_MS,
        Math.max(0, budgetLeft - futureAttempts)
      );
      if (backoff > 0) await sleep(backoff);
    }
  }

  if (isAbortError(lastErr) || (lastErr instanceof DvmError && lastErr.code === "timeout")) {
    throw new DvmError(
      "endpoint_unreachable",
      `Provider at ${endpoint} did not respond within ${budgetMs / 1000}s.`,
      "The endpoint may be down or the address may be incorrect. Check with 'dvm info <endpoint>'."
    );
  }
  throw new DvmError(
    "endpoint_unreachable",
    `Could not reach provider at ${endpoint}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    "Check the endpoint URL and your network connection."
  );
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
