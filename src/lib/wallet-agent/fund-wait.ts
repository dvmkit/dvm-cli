import { MintQuoteState } from "@cashu/cashu-ts";
import { DvmError, getWallet, loadAgentWallet } from "@dvmkit/sdk/internal";
import { fundAgentWallet } from "./fund";

import { unknownErrorDiagnostic } from "../error-handler";
import { observeMintFailures } from "./mint-failure-observer";

type FundOptions = Parameters<typeof fundAgentWallet>[1];
type FundResult = Awaited<ReturnType<typeof fundAgentWallet>>;

/** Wait to suggest to a caller that will retry between runs, when the mint named none itself. */
const SUGGESTED_RATE_LIMIT_WAIT_MS = 60_000;
const SUGGESTED_TRANSIENT_WAIT_MS = 30_000;
/** Floor and ceiling on a mint-supplied wait, so a broken Retry-After can't park an agent for a day. */
const SUGGESTED_WAIT_FLOOR_MS = 2_000;
const SUGGESTED_WAIT_CAP_MS = 300_000;

/** Why a mint request failed, in words bounded by this CLI rather than the mint. */
export type MintFailureCause =
  | "rate_limited"
  | "mint_server_error"
  | "mint_unreachable"
  | "unexpected";

/**
 * {@link fundAgentWallet} with CLI-specific recovery shaping. The SDK owns
 * quote polling, transient retry, and the deadline. If that deadline expires
 * after the invoice was recorded, this layer preserves the CLI's established
 * pending-quote fields and recovery command. The passive wallet observer keeps
 * only the original failure metadata needed for that presentation contract.
 */
export async function fundWithRecoverableWait(
  amountSats: number,
  opts: FundOptions,
  fund: typeof fundAgentWallet = fundAgentWallet
): Promise<FundResult> {
  const getWalletForMint = opts.getWalletForMint ?? getWallet;
  const before = new Set((loadAgentWallet()?.pending_mints ?? []).map((p) => p.quote_id));
  // The payment wait ends where the SDK starts building the blinded outputs,
  // so a failure past that point is a collection failure, not a wait that
  // never ended — they need different words for the same recovery.
  let minting = false;
  let terminalPollError: unknown;
  const onPoll = opts.onPoll;
  try {
    return await fund(amountSats, {
      ...opts,
      getWalletForMint: async (url) => {
        try {
          const wallet = await getWalletForMint(url);
          terminalPollError = undefined;
          return observeMintFailures(
            wallet,
            (err) => (terminalPollError = err),
            () => (terminalPollError = undefined)
          );
        } catch (err) {
          terminalPollError = err;
          throw err;
        }
      },
      onPoll: (state, elapsedMs) => {
        if (state === MintQuoteState.PAID) minting = true;
        onPoll?.(state, elapsedMs);
      },
    });
  } catch (err) {
    // Preserve SDK recovery errors except its bounded quote-poll terminal: this CLI has already
    // persisted the quote and keeps its established pending-fund recovery contract for that case.
    if (err instanceof DvmError && err.code !== "mint_quote_poll_unavailable") throw err;
    const pending = (loadAgentWallet()?.pending_mints ?? []).find(
      (p) => p.mint === opts.mintUrl && !before.has(p.quote_id)
    );
    if (!pending) throw err;
    const presentedError =
      err instanceof DvmError && err.code === "mint_quote_poll_unavailable"
        ? (terminalPollError ?? err)
        : err;
    throw fundInterruptedError(presentedError, {
      mint: opts.mintUrl,
      quoteId: pending.quote_id,
      amountSats: pending.amount_sats,
      minting,
    });
  }
}

/**
 * Classify a mint request failure. Duck-typed on cashu-ts's error `name` and
 * `status` rather than `instanceof`: the shipped bundle minifies constructor
 * names and can carry more than one copy of the classes.
 */
export function classifyMintError(err: unknown): MintFailureCause {
  if (typeof err !== "object" || err === null) return "unexpected";
  const { name, status, code, data } = err as {
    name?: unknown;
    status?: unknown;
    code?: unknown;
    data?: { cause?: unknown };
  };
  if (code === "mint_quote_poll_unavailable") {
    const cause = data?.cause;
    if (
      cause === "rate_limited" ||
      cause === "mint_server_error" ||
      cause === "mint_unreachable"
    ) {
      return cause;
    }
  }
  if (name === "RateLimitError" || status === 429) return "rate_limited";
  if (typeof status === "number" && status >= 500) return "mint_server_error";
  if (name === "NetworkError") return "mint_unreachable";
  // A mint that never loaded doesn't reach cashu-ts's own error classes: the
  // SDK's `getWallet` maps the connection failure to this code first, and a
  // mint that isn't answering is the most retryable case there is.
  if (code === "cashu_mint_unreachable") return "mint_unreachable";
  return "unexpected";
}

/**
 * The wait a mint named for itself, as cashu-ts carries it on a `RateLimitError`.
 * Shared with the reconcile sweep so both paths honour the same header.
 */
export function mintRetryAfterMs(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const candidate = err as {
    retryAfterMs?: unknown;
    code?: unknown;
    data?: { retry_after_ms?: unknown };
  };
  const value =
    candidate.code === "mint_quote_poll_unavailable"
      ? candidate.data?.retry_after_ms
      : candidate.retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * How long to wait before running the recovery command. Unlike the in-flight
 * backoff above this is spent *between* CLI runs, so it is sized for an agent
 * that will come back rather than for a poll loop. A mint that names a
 * Retry-After is telling us its cadence, so honour it over the default —
 * clamped, because the value is the mint's to set and this one reaches an
 * agent as an instruction to sleep. Shared with the reconcile sweep so both
 * name the same wait for the same refusal.
 */
export function suggestedRetryAfterMs(
  cause: MintFailureCause,
  err: unknown
): number | undefined {
  switch (cause) {
    case "rate_limited": {
      const named = mintRetryAfterMs(err);
      return named !== undefined
        ? Math.min(Math.max(named, SUGGESTED_WAIT_FLOOR_MS), SUGGESTED_WAIT_CAP_MS)
        : SUGGESTED_RATE_LIMIT_WAIT_MS;
    }
    case "mint_server_error":
    case "mint_unreachable":
      return SUGGESTED_TRANSIENT_WAIT_MS;
    case "unexpected":
      return undefined;
  }
}

export function formatWait(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

function describeCause(cause: MintFailureCause, minting: boolean): string {
  const requests = minting ? "the request for the sats" : "status checks";
  switch (cause) {
    case "rate_limited":
      return `the mint refused ${requests} as too frequent`;
    case "mint_server_error":
      return `the mint failed ${requests}`;
    case "mint_unreachable":
      return `the mint stopped answering ${requests}`;
    case "unexpected":
      return `an unexpected error interrupted ${requests}`;
  }
}

interface InterruptedFund {
  mint: string;
  quoteId: string;
  amountSats: number;
  /** The invoice was already paid and the SDK had moved on to issuing proofs. */
  minting: boolean;
}

function fundInterruptedError(err: unknown, fund: InterruptedFund): DvmError {
  const { mint, quoteId, amountSats, minting } = fund;
  const cause = classifyMintError(err);
  const reason = describeCause(cause, minting);
  const command = "dvm wallet show";
  // Same recovery fields the reconcile sweep's `unchecked` view publishes, so
  // an agent branches on one shape whichever terminal reported the mint's
  // refusal.
  const retryAfterMs = suggestedRetryAfterMs(cause, err);
  const wait = retryAfterMs !== undefined ? ` Wait ${formatWait(retryAfterMs)} first.` : "";
  const hint = `The invoice is still recorded as pending.${wait} Once it is paid (or if it already was), run \`${command}\` to mint the sats — don't start a new fund for the same money.`;
  // Keep the bounded class/code fingerprint the generic `internal` terminal
  // would have published, so a structured error never reports less than it did.
  const diagnostic =
    err instanceof DvmError && err.code === "mint_quote_poll_unavailable"
      ? { name: mintErrorName(cause), label: mintErrorName(cause) }
      : unknownErrorDiagnostic(err);
  return new DvmError(
    minting ? "fund_mint_interrupted" : "fund_wait_interrupted",
    minting
      ? `Mint quote ${quoteId} was paid, but collecting the sats failed: ${reason}.`
      : `Stopped waiting for payment of mint quote ${quoteId}: ${reason}.`,
    hint,
    {
      cause,
      retryable: cause !== "unexpected",
      mint,
      quote_id: quoteId,
      amount_sats: amountSats,
      pending: true,
      ...(retryAfterMs !== undefined ? { retry_after_ms: retryAfterMs } : {}),
      error_name: diagnostic.name,
      ...(diagnostic.code ? { error_code: diagnostic.code } : {}),
      display: minting
        ? `Funding ${amountSats} sats was paid but not collected (${reason}). The invoice is still recorded, so 'dvm wallet show' collects the sats.`
        : `Funding ${amountSats} sats stopped before the payment was seen (${reason}). The invoice is still recorded, so a payment made before it expires is collected by 'dvm wallet show'.`,
      next_action: {
        type: "run_command",
        command,
        ...(retryAfterMs !== undefined ? { retry_after_ms: retryAfterMs } : {}),
        hint,
      },
    }
  );
}

function mintErrorName(cause: MintFailureCause): string {
  switch (cause) {
    case "rate_limited":
      return "RateLimitError";
    case "mint_server_error":
      return "HttpResponseError";
    case "mint_unreachable":
      return "NetworkError";
    case "unexpected":
      return "Error";
  }
}
