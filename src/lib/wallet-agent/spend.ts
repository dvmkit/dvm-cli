import {
  getEncodedToken,
  MintOperationError,
  type Proof,
  type SwapPreview,
  type Token,
  type Wallet,
} from "@cashu/cashu-ts";
import { randomUUID } from "crypto";

import { deriveAgentRefundSubkeyPubkey } from "@dvmkit/sdk/internal";
import { canSwap } from "@dvmkit/sdk/internal";
import { type SwapSendReserve, swapSendReserve } from "@dvmkit/sdk/internal";
import { getWallet } from "@dvmkit/sdk/internal";
import { readAgentMnemonic } from "@dvmkit/sdk/internal";
import { reservedForMarker } from "./builder-handle";
import {
  inFlightTimeoutSeconds,
  markProofsInFlight,
  proofKey,
  revertInFlight,
  sweepStaleInFlight,
} from "./inflight";
import { perCallLocktimeSeconds } from "./locktime";
import { serializeOutputData } from "@dvmkit/sdk/internal";
import { toAgentProof, toCashuProofs } from "@dvmkit/sdk/internal";
import {
  coveringMintsForSpend,
  type SelectError,
  selectProofsForSpend,
} from "@dvmkit/sdk/internal";
import {
  type AgentProof,
  type AgentRecentSpend,
  type AgentWallet,
  loadAgentWallet,
  type PendingSubmission,
  type PendingSubmissionAcceptedUnresolved,
  type PendingSubmissionContext,
  RECENT_SPENDS_CAP,
  saveAgentWallet,
  withWalletLock,
} from "@dvmkit/sdk/internal";
import {
  cashuSubmissionBindingFingerprint,
  cashuSubmissionBindingFromContext,
} from "@dvmkit/sdk/internal";
import { bindCashuTokenToSubmissionContext } from "@dvmkit/sdk/internal";

export type AgentSpendMode = "standard" | "strict_per_call";

export interface CashuP2pkOffer {
  mints: string[];
  /** The DVM's current `cashu.lock_pubkeys[0]` to lock per-call outputs to. */
  lock_pubkey: string;
  /**
   * The DVM's `cashu.canonical_id`. Names the per-DVM refund subkey
   * the outputs' NUT-11 `refund` tag carries, so the wallet can reclaim them if
   * the DVM never redeems. A DVM that advertises none (legacy) gets
   * clause-less outputs, exactly as before.
   */
  canonical_id?: string | null;
  /**
   * The DVM's advertised `cashu.min_locktime`, in seconds. The per-call
   * locktime clamps up to it — see {@link perCallLocktimeSeconds}.
   */
  min_locktime?: number;
}

export interface PreparedAgentSpend {
  /** Encoded Cashu token (DVM-locked outputs) for the `X-Cashu` header. */
  cashuToken: string;
  /** UUIDv4 for the `X-Cashu-Request-Id` header. */
  requestId: string;
  mint: string;
  /** Total spend in sats (exactly the requested amount; the swap fee comes off inputs). */
  totalSats: number;
  endpoint: string;
  /** The DVM lock pubkey the outputs are locked to. Used by the retry-with-refetch path. */
  intendedLockPubkey: string;
  /** Exact public request-binding hash persisted with a strict per-call submission. */
  submissionBindingFingerprint?: string;
}

/**
 * Why one mint in the DVM's allowlist didn't work out on this call.
 *
 * A per-call observation and nothing more: it is reported to the caller, never
 * written to disk and never carried into the next call, so a mint that comes
 * back is used again immediately with no operator action.
 */
export interface SpendMintAttempt {
  mint: string;
  /**
   * What stopped this mint. `unreachable` — the mint didn't load;
   * `keys_unavailable` — it loaded but wouldn't name an active keyset;
   * `swap_disabled` — it advertises swaps switched off (NUT-3), so no swap was
   * attempted; `fee_cap_exceeded` — the selected proofs' exact swap-send
   * reserve exceeds the caller's approved cap; `insufficient_balance` — the
   * wallet's balance here doesn't cover the price once this mint's own fee is
   * known; `no_eligible_mint` — the balance that made this mint a candidate is
   * gone by the time the spend selects (spent by a concurrent call, or swept
   * between locks); `swap_rejected` — `/v1/swap` itself failed.
   */
  reason:
    | "unreachable"
    | "keys_unavailable"
    | "swap_disabled"
    | "fee_cap_exceeded"
    | "insufficient_balance"
    | "no_eligible_mint"
    | "swap_rejected";
  message: string;
}

/**
 * Failure result. The error is always already structured for output.
 *
 * `attempts` is present whenever the swap path walked the DVM's mints — one
 * entry per mint tried, in the order tried.
 */
export interface PrepareAgentSpendFailure {
  error: (
    | SelectError
    | { code: "no_agent_wallet"; message: string; hint: string }
    | { code: "missing_lock_pubkey"; message: string; hint: string }
    | { code: "invalid_max_cashu_principal"; message: string; hint: string }
    | { code: "invalid_max_cashu_fee"; message: string; hint: string }
    | { code: "strict_per_call_unsafe"; message: string; hint: string }
    | { code: "cashu_principal_cap_exceeded"; message: string; hint: string }
    | { code: "cashu_fee_cap_exceeded"; message: string; hint: string }
    | { code: "swap_failed"; message: string; hint: string }
  ) & { attempts?: SpendMintAttempt[] };
}

/**
 * Wallet locks cover local selection and journal updates, never mint network I/O.
 * Persist the exact blinded outputs before a swap: NUT-09/NUT-07 then resolve
 * an ambiguous outcome rather than returning inputs based on elapsed time.
 *
 * Each covering mint is tried once. Definite protocol rejection rolls back
 * before failover; an unknown transport outcome stops failover and protects
 * the inputs. Successful outputs remain journaled until the DVM accepts them.
 */
export async function prepareAgentSpend(args: {
  amountSats: number;
  endpoint: string;
  cashuP2pk: CashuP2pkOffer;
  /**
   * Maximum principal carried by the Cashu token, in sats. The requested amount
   * and a reserve-direct token's exact selected total are both checked before
   * proofs are marked in flight or a swap reaches the mint.
   */
  maxCashuPrincipalSats?: number;
  /**
   * Maximum total Cashu swap-send reserve in sats. This covers both the
   * selected inputs' NUT-02 swap fee and the receiver-fee outputs added by
   * `includeFees(true)`. The selected proof set is checked before it is marked
   * in flight or any swap preview is submitted to the mint.
   */
  maxCashuFeeSats?: number;
  /** Strict mode refuses pending state and disables reserve-direct selection and implicit recovery. */
  mode?: AgentSpendMode;
  /**
   * Canonical builder handle (hostname) for spend-time reserve preference
   * When set, `prepareAgentSpend` first looks for unexpired
   * reserve proofs at this builder; if sufficient, it ships them directly
   * with no swap call and no swap fee. Falls through to per-call swap when
   * the reserve doesn't cover the price.
   */
  builderHandle?: string;
  /**
   * What a resume needs to re-POST this call. Set by the upfront
   * `POST /v1/job` path; omitted by the mid-job `payment` path, whose spend
   * ships over `sendMessage` and so isn't resumable by the submission sweep.
   *
   * A fund context may carry an empty `fund.commitment`; the spend binds the
   * token hash before the context becomes shippable. Keeping the pre-token
   * context serializable also lets NUT-09 recovery rebuild it after a crash.
   */
  submitContext?: PendingSubmissionContext;
  /**
   * Per-call NUT-11 locktime in seconds. Defaults to
   * {@link perCallLocktimeSeconds}, which is also what clamps this up to the
   * DVM's advertised `min_locktime`.
   */
  locktimeSeconds?: number;
  getWalletForMint?: (mintUrl: string) => Promise<Wallet>;
  now?: () => number;
  uuid?: () => string;
  inFlightTimeoutSec?: number;
  readMnemonic?: () => string | null;
}): Promise<PreparedAgentSpend | PrepareAgentSpendFailure> {
  if (
    args.maxCashuPrincipalSats !== undefined &&
    (!Number.isSafeInteger(args.maxCashuPrincipalSats) || args.maxCashuPrincipalSats < 0)
  ) {
    return {
      error: {
        code: "invalid_max_cashu_principal",
        message: "The Cashu principal limit must be an exact non-negative integer number of sats.",
        hint: "Pass --max-cashu-principal-sats with a value such as 20 or 100.",
      },
    };
  }
  if (args.maxCashuPrincipalSats !== undefined && args.amountSats > args.maxCashuPrincipalSats) {
    return principalCapFailure(args.amountSats, args.maxCashuPrincipalSats);
  }
  if (
    args.maxCashuFeeSats !== undefined &&
    (!Number.isSafeInteger(args.maxCashuFeeSats) || args.maxCashuFeeSats < 0)
  ) {
    return {
      error: {
        code: "invalid_max_cashu_fee",
        message: "The Cashu fee limit must be an exact non-negative integer number of sats.",
        hint: "Pass --max-cashu-fee-sats with a value such as 1 or 2.",
      },
    };
  }
  const strict = args.mode === "strict_per_call";
  let submitContext = args.submitContext;
  if (strict) {
    const strictError = strictSpendInputError(args);
    if (strictError) return strictError;
    if (!submitContext)
      return strictSpendFailure("The strict Cashu request has no recovery context.");
    const binding = cashuSubmissionBindingFromContext(submitContext);
    if (!binding)
      return strictSpendFailure("The strict Cashu request has no complete recovery binding.");
    const bindingFingerprint = cashuSubmissionBindingFingerprint(binding);
    if (submitContext.binding_fingerprint !== bindingFingerprint)
      return strictSpendFailure(
        "The strict Cashu request binding does not match its request body."
      );
    submitContext = { ...submitContext, binding_fingerprint: bindingFingerprint };
  }
  const now = args.now ?? (() => Date.now());
  const uuid = args.uuid ?? (() => randomUUID());
  const timeoutSec = args.inFlightTimeoutSec ?? inFlightTimeoutSeconds();
  const getWalletForMint = args.getWalletForMint ?? getWallet;
  const refundClause = resolveRefundClause(args.cashuP2pk, args.locktimeSeconds, now(), {
    readMnemonic: args.readMnemonic,
  });

  interface PreparedInner {
    lockPrivkey: string;
    lockPubkey: string;
    selectedProofs: AgentProof[];
    selectedKeys: Set<string>;
    mint: string;
    requestId: string;
    submission: PendingSubmission;
    /** When true, the selected proofs are already DVM-locked reserve — no mint swap needed. */
    fromReserve: boolean;
  }

  type Lock1Result =
    | PrepareAgentSpendFailure
    | { kind: "reserve"; inner: PreparedInner }
    | {
        kind: "swap-candidates";
        /** Allowlisted mints with a covering balance, in the DVM's own order. */
        candidateMints: string[];
        lockPrivkey: string;
        lockPubkey: string;
      };

  const lock1 = await withWalletLock<Lock1Result>(() => {
    const initial = loadAgentWallet();
    if (!initial) {
      return {
        error: {
          code: "no_agent_wallet",
          message: "No agent wallet found at ~/.dvm/wallet.json.",
          hint: "Run: dvm wallet init",
        },
      };
    }

    if (!args.cashuP2pk.lock_pubkey) {
      return {
        error: {
          code: "missing_lock_pubkey",
          message: "DVM did not advertise a lock pubkey.",
          hint: "Ask the DVM operator to set DVMKIT_CASHU_LOCK_PUBKEY.",
        },
      };
    }

    if (strict) {
      const pending = strictWalletStateReason(initial);
      if (pending) return strictSpendFailure(pending);
    }
    const swept = strict ? { wallet: initial, reverted: 0 } : sweepStaleInFlight(initial, now());

    // prefer an unexpired reserve at this builder. Reserve proofs
    // are already P2PK-locked to the DVM's lock pubkey, so we skip the
    // mint swap entirely — no fee buffer, no `/v1/swap` round-trip.
    if (!strict && args.builderHandle) {
      const reserveSelection = selectReserveProofs({
        proofs: swept.wallet.proofs,
        builderHandle: args.builderHandle,
        lockPubkey: args.cashuP2pk.lock_pubkey,
        mintAllowlist: args.cashuP2pk.mints,
        nowMs: now(),
        amountSats: args.amountSats,
      });
      if (reserveSelection) {
        if (
          args.maxCashuPrincipalSats !== undefined &&
          reserveSelection.totalSats > args.maxCashuPrincipalSats
        ) {
          return principalCapFailure(reserveSelection.totalSats, args.maxCashuPrincipalSats);
        }
        const proofKeys = new Set(reserveSelection.selected.map((p) => proofKey(p)));
        const untilMs = now() + timeoutSec * 1000;
        const requestId = uuid();
        // The reserve proofs ARE the token — encode before persisting so the
        // token-bound context and verbatim token land in the same write.
        const reserveToken = getEncodedToken({
          mint: reserveSelection.mint,
          proofs: toCashuProofs(reserveSelection.selected),
        });
        const reserveContext = bindCashuTokenToSubmissionContext(
          contextWithInitialCashuFee(submitContext, args.maxCashuFeeSats, 0),
          reserveToken
        );
        const submission: PendingSubmission = {
          endpoint: args.endpoint,
          request_id: requestId,
          intended_lock_pubkey: args.cashuP2pk.lock_pubkey,
          mint: reserveSelection.mint,
          amount_sats: reserveSelection.totalSats,
          ...(args.maxCashuFeeSats !== undefined
            ? { max_cashu_fee_sats: args.maxCashuFeeSats }
            : {}),
          initial_cashu_fee_sats: 0,
          output_proofs: reserveSelection.selected,
          created_at: new Date(now()).toISOString(),
          cashu_token: reserveToken,
          ...(reserveContext ? { context: reserveContext } : {}),
        };
        const marked = markProofsInFlight(swept.wallet, proofKeys, untilMs);
        saveAgentWallet({
          ...marked,
          pending_submissions: [...marked.pending_submissions, submission],
        });
        return {
          kind: "reserve",
          inner: {
            lockPrivkey: initial.lock_privkey,
            lockPubkey: initial.lock_pubkey,
            selectedProofs: reserveSelection.selected,
            selectedKeys: proofKeys,
            mint: reserveSelection.mint,
            requestId,
            submission,
            fromReserve: true,
          },
        };
      }
    }

    // Candidate enumeration (no fee) — purely to learn which mints could
    // cover the call. The fee-aware pass runs per candidate in Lock 2, after
    // that mint is loaded and its own swap cost is known. Doing this
    // under Lock 1 also lets us persist swept-if-reverted on selection
    // failure without holding a second lock for the error path.
    const covering = coveringMintsForSpend({
      proofs: swept.wallet.proofs,
      mintAllowlist: args.cashuP2pk.mints,
      amountSats: args.amountSats,
    });
    if ("error" in covering) {
      if (swept.reverted > 0) saveAgentWallet(swept.wallet);
      return { error: covering.error };
    }

    return {
      kind: "swap-candidates",
      candidateMints: covering.mints,
      lockPrivkey: initial.lock_privkey,
      lockPubkey: initial.lock_pubkey,
    };
  });

  if ("error" in lock1) return lock1;

  // Reserve-direct path: the selected proofs are already locked
  // to the DVM. Ship them as-is — no mint swap, no fee. `commitAgentSpend`
  // removes them on DVM 2xx (they're filtered by `in_flight` status).
  if (lock1.kind === "reserve") {
    const inner = lock1.inner;
    const cashuToken =
      inner.submission.cashu_token ??
      getEncodedToken({
        mint: inner.mint,
        proofs: toCashuProofs(inner.selectedProofs),
      });
    return {
      cashuToken,
      requestId: inner.requestId,
      mint: inner.mint,
      totalSats: inner.submission.amount_sats,
      endpoint: args.endpoint,
      intendedLockPubkey: args.cashuP2pk.lock_pubkey,
      ...(inner.submission.context?.binding_fingerprint
        ? { submissionBindingFingerprint: inner.submission.context.binding_fingerprint }
        : {}),
    };
  }

  // One `request_id` for the whole call, minted before the loop. A failed
  // attempt's entry is dropped before the next one writes, so `request_id`
  // stays one-per-call however many mints were tried.
  const requestId = uuid();
  const attempts: SpendMintAttempt[] = [];
  let lastSelectError: SelectError | undefined;
  let lastFeeCapError:
    | Extract<PrepareAgentSpendFailure["error"], { code: "cashu_fee_cap_exceeded" }>
    | undefined;
  let inputsLeftInFlight = false;
  let inner: PreparedInner | undefined;
  let sendProofs: Proof[] = [];
  let keepProofs: Proof[] = [];

  for (const [index, mint] of lock1.candidateMints.entries()) {
    const hasNextCandidate = index < lock1.candidateMints.length - 1;

    // Load this candidate to price its own swap. `swapSendReserve` reads
    // `Wallet.getKeyset()`, the bound (cheapest active) keyset for the
    // wallet's unit — exactly the keyset the swap issues against.
    let candidateWallet: Wallet;
    try {
      candidateWallet = await getWalletForMint(mint);
    } catch (err) {
      attempts.push({ mint, reason: "unreachable", message: errorText(err) });
      continue;
    }
    let reserveSats: SwapSendReserve;
    try {
      reserveSats = swapSendReserve(candidateWallet, args.amountSats);
    } catch (err) {
      attempts.push({ mint, reason: "keys_unavailable", message: errorText(err) });
      continue;
    }
    // A mint in melt-only recovery advertises swaps switched off. Asking
    // costs nothing here — the mint info is already loaded — and skipping
    // saves a round-trip that can only fail.
    if (!swapEnabled(candidateWallet)) {
      attempts.push({
        mint,
        reason: "swap_disabled",
        message: "Mint advertises swaps switched off (NUT-3 disabled).",
      });
      continue;
    }

    const lock2 = await withWalletLock<PrepareAgentSpendFailure | PreparedInner>(() => {
      const fresh = loadAgentWallet();
      if (!fresh) {
        return {
          error: {
            code: "no_agent_wallet",
            message: "Agent wallet vanished between locks.",
            hint: "Run: dvm wallet init",
          },
        };
      }
      if (strict) {
        const pending = strictWalletStateReason(fresh);
        if (pending) return strictSpendFailure(pending);
      }
      const swept = strict ? { wallet: fresh, reverted: 0 } : sweepStaleInFlight(fresh, now());
      const selection = selectProofsForSpend({
        proofs: swept.wallet.proofs,
        mintAllowlist: [mint],
        amountSats: args.amountSats,
        swapReserveSats: reserveSats,
      });
      if ("error" in selection) {
        if (swept.reverted > 0) saveAgentWallet(swept.wallet);
        return { error: selection.error };
      }

      // This is the last policy gate before any proof-store write or swap
      // construction. `reserveSats` prices this exact selected proof set, so an
      // over-cap refusal leaves the wallet byte-for-byte unchanged and never
      // reaches `prepare()` / `completeSwap()` or the mint's `/v1/swap`.
      const selectedFeeSats = reserveSats(selection.selected);
      if (args.maxCashuFeeSats !== undefined && selectedFeeSats > args.maxCashuFeeSats) {
        return {
          error: {
            code: "cashu_fee_cap_exceeded",
            message: `Cashu fees at ${mint} would be ${selectedFeeSats} sats, over the ${args.maxCashuFeeSats}-sat --max-cashu-fee-sats limit.`,
            hint: "Raise --max-cashu-fee-sats only after approval, or fund an accepted mint with a lower swap fee.",
          },
        };
      }

      const proofKeys = new Set(selection.selected.map((p) => proofKey(p)));
      const untilMs = now() + timeoutSec * 1000;
      const feeContext = contextWithInitialCashuFee(
        submitContext,
        args.maxCashuFeeSats,
        selectedFeeSats
      );
      const submission: PendingSubmission = {
        endpoint: args.endpoint,
        request_id: requestId,
        intended_lock_pubkey: args.cashuP2pk.lock_pubkey,
        mint: selection.mint,
        amount_sats: args.amountSats,
        ...(args.maxCashuFeeSats !== undefined ? { max_cashu_fee_sats: args.maxCashuFeeSats } : {}),
        initial_cashu_fee_sats: selectedFeeSats,
        output_proofs: [],
        created_at: new Date(now()).toISOString(),
        ...(feeContext ? { context: feeContext } : {}),
        ...(refundClause
          ? {
              canonical_id: refundClause.canonicalId,
              refund_pubkey: refundClause.refundPubkey,
              t_expire: refundClause.tExpireSec * 1000,
            }
          : {}),
      };
      const marked = markProofsInFlight(swept.wallet, proofKeys, untilMs);
      saveAgentWallet({
        ...marked,
        pending_submissions: [...marked.pending_submissions, submission],
      });

      return {
        lockPrivkey: fresh.lock_privkey,
        lockPubkey: fresh.lock_pubkey,
        selectedProofs: selection.selected,
        selectedKeys: proofKeys,
        mint: selection.mint,
        requestId,
        submission,
        fromReserve: false,
      };
    });

    if ("error" in lock2) {
      // `no_agent_wallet` says the wallet file is gone, not that this mint is
      // bad — no other candidate can do better, so stop here.
      if (lock2.error.code === "no_agent_wallet") return lock2;
      if (lock2.error.code === "cashu_fee_cap_exceeded") {
        lastFeeCapError = lock2.error;
        attempts.push({ mint, reason: "fee_cap_exceeded", message: lock2.error.message });
        continue;
      }
      const selectError = lock2.error as SelectError;
      lastSelectError = selectError;
      // Carry the selection's own code: proofs that covered under Lock 1 can be
      // gone entirely by Lock 2 (a concurrent call spent them), and calling that
      // "insufficient_balance" tells an operator a mint is short when it's empty.
      attempts.push({ mint, reason: selectError.code, message: selectError.message });
      continue;
    }

    // Prepare locally, then persist the exact blinded outputs before the mint
    // sees them. If the response is lost after the mint commits, NUT-09 can
    // restore the signatures (and therefore their DLEQ) on the next sweep.
    const swapBuilder = candidateWallet.ops
      .send(lock2.submission.amount_sats, toCashuProofs(lock2.selectedProofs))
      .asP2PK({
        pubkey: args.cashuP2pk.lock_pubkey,
        ...(refundClause
          ? { locktime: refundClause.tExpireSec, refundKeys: [refundClause.refundPubkey] }
          : {}),
      })
      .keepAsP2PK({ pubkey: lock2.lockPubkey })
      .privkey(lock2.lockPrivkey)
      .includeFees(true);

    let preview: SwapPreview;
    try {
      preview = await swapBuilder.prepare();
    } catch (err) {
      attempts.push({ mint, reason: "swap_rejected", message: errorText(err) });
      await rollbackAttempt(requestId, lock2.selectedKeys);
      if (hasNextCandidate) continue;
      break;
    }

    // Selection gates the conservative fee for every proof handed to cashu-ts.
    // `prepare()` may narrow that set, so persist the reserve for the exact
    // inputs the mint will consume. Recovery subtracts this value from the
    // job-wide allowance before it considers a reclaim swap.
    const initialCashuFeeSats = reserveSats(preview.inputs);
    const preparedContext = contextWithInitialCashuFee(
      lock2.submission.context,
      args.maxCashuFeeSats,
      initialCashuFeeSats
    );
    const preparedSubmission: PendingSubmission = {
      ...lock2.submission,
      initial_cashu_fee_sats: initialCashuFeeSats,
      ...(preparedContext ? { context: preparedContext } : {}),
    };
    const inputSecrets = new Set(preview.inputs.map((proof) => proof.secret));
    const swapping = {
      keyset_id: preview.keysetId,
      input_proofs: lock2.selectedProofs.filter((proof) => inputSecrets.has(proof.secret)),
      unselected_proofs: lock2.selectedProofs.filter((proof) => !inputSecrets.has(proof.secret)),
      send_outputs: serializeOutputData(preview.sendOutputs ?? []),
      keep_outputs: serializeOutputData(preview.keepOutputs ?? []),
    };
    await withWalletLock(() => {
      const fresh = loadAgentWallet();
      if (!fresh) return;
      saveAgentWallet({
        ...fresh,
        pending_submissions: fresh.pending_submissions.map((submission) =>
          submission.request_id === requestId
            ? {
                ...submission,
                initial_cashu_fee_sats: initialCashuFeeSats,
                ...(preparedContext ? { context: preparedContext } : {}),
                swapping,
              }
            : submission
        ),
      });
    });

    // Swap (network I/O — no lock). `.asP2PK` locks outputs to the DVM;
    // `.keepAsP2PK` locks change to the agent's own pubkey so it stays
    // spendable on later calls. `.privkey()` signs the input P2PK
    // witnesses. `.includeFees(true)` makes the agent cover the fee the DVM
    // will pay to redeem these outputs, so the DVM banks `amountSats` whole —
    // that fee, plus this swap's own per-input fee, is what the selection
    // above reserved.
    //
    // The `locktime` + `refund` tags are the caller's escape hatch:
    // without them, outputs a DVM never redeems are spendable by nobody but
    // that DVM, forever. Privacy cost, accepted by the operator: the refund
    // pubkey is stable per (agent, DVM), so a DVM can link an agent's repeat
    // calls to it. Cross-DVM correlation stays blocked — the subkey is derived
    // per canonical DVM id.
    try {
      const result = await candidateWallet.completeSwap(preview, lock2.lockPrivkey);
      inner = { ...lock2, submission: preparedSubmission };
      sendProofs = result.send;
      keepProofs = result.keep;
      break;
    } catch (err) {
      attempts.push({ mint, reason: "swap_rejected", message: errorText(err) });
      if (err instanceof MintOperationError) {
        // A protocol-level 4xx says the mint did not commit the swap, so these
        // inputs are safe to return and another mint may be tried.
        await rollbackAttempt(requestId, lock2.selectedKeys);
        if (hasNextCandidate) continue;
        break;
      }
      // A transport/runtime failure is ambiguous: the mint may have committed
      // even though the response never arrived. Never fail over or age these
      // inputs back into circulation. The persisted preview lets the next
      // sweep restore signed outputs or prove the inputs remained UNSPENT.
      inputsLeftInFlight = true;
      break;
    }
  }

  if (!inner)
    return {
      error: exhaustedError(attempts, lastSelectError, lastFeeCapError, inputsLeftInFlight),
    };

  // Lock 3: remove spent inputs, capture the P2PK-locked `keep` change
  // into `wallet.proofs`, and write `output_proofs` — plus the verbatim
  // token and token-bound context — into the
  // pending_submission. Atomic so a crash cannot lose change, and so an
  // entry never holds populated outputs without the body a resume re-ships.
  const cashuToken = getEncodedToken({ mint: inner.mint, proofs: sendProofs });
  const boundContext = bindCashuTokenToSubmissionContext(inner.submission.context, cashuToken);
  const agentOutputs = sendProofs.map((p) =>
    toAgentProof(p, inner.mint, args.cashuP2pk.lock_pubkey)
  );
  const agentKeep = keepProofs.map((p) => toAgentProof(p, inner.mint, inner.lockPubkey));
  await withWalletLock(() => {
    const fresh = loadAgentWallet();
    if (!fresh) return;
    const next: AgentWallet = {
      ...fresh,
      proofs: [...fresh.proofs.filter((p) => !inner.selectedKeys.has(proofKey(p))), ...agentKeep],
      pending_submissions: fresh.pending_submissions.map((s) =>
        s.request_id === inner.requestId
          ? {
              ...s,
              output_proofs: agentOutputs,
              swapping: undefined,
              cashu_token: cashuToken,
              ...(boundContext ? { context: boundContext } : {}),
              // What a later reclaim needs. Only the swap path
              // writes these: reserve-direct entries ship proofs that still
              // live in `wallet.proofs[]`, and `release` / the in-flight
              // revert already own their recovery.
              ...(refundClause
                ? {
                    canonical_id: refundClause.canonicalId,
                    refund_pubkey: refundClause.refundPubkey,
                    t_expire: refundClause.tExpireSec * 1000,
                  }
                : {}),
            }
          : s
      ),
    };
    saveAgentWallet(next);
  });

  return {
    cashuToken,
    requestId: inner.requestId,
    mint: inner.mint,
    totalSats: inner.submission.amount_sats,
    endpoint: args.endpoint,
    intendedLockPubkey: args.cashuP2pk.lock_pubkey,
    ...(boundContext?.binding_fingerprint
      ? { submissionBindingFingerprint: boundContext.binding_fingerprint }
      : {}),
  };
}

function principalCapFailure(
  principalSats: number,
  maxCashuPrincipalSats: number
): PrepareAgentSpendFailure {
  return {
    error: {
      code: "cashu_principal_cap_exceeded",
      message: `Cashu principal of ${principalSats} sats is over the ${maxCashuPrincipalSats}-sat --max-cashu-principal-sats limit.`,
      hint: "Raise --max-cashu-principal-sats only after approval, or retry when the approved dollar amount needs fewer sats.",
    },
  };
}

function contextWithInitialCashuFee(
  context: PendingSubmissionContext | undefined,
  maxCashuFeeSats: number | undefined,
  initialCashuFeeSats: number
): PendingSubmissionContext | undefined {
  if (!context) return undefined;
  return {
    ...context,
    ...(maxCashuFeeSats !== undefined ? { max_cashu_fee_sats: maxCashuFeeSats } : {}),
    initial_cashu_fee_sats: initialCashuFeeSats,
  };
}

function strictSpendInputError(
  args: Parameters<typeof prepareAgentSpend>[0]
): PrepareAgentSpendFailure | null {
  if (args.maxCashuFeeSats === undefined)
    return strictSpendFailure("Strict Cashu per-call mode requires an explicit fee ceiling.");
  if (args.builderHandle)
    return strictSpendFailure("Strict Cashu per-call mode cannot use builder reserve proofs.");
  if (args.cashuP2pk.mints.length !== 1)
    return strictSpendFailure("Strict Cashu per-call mode requires exactly one pinned mint.");
  const context = args.submitContext;
  if (
    context?.strict_per_call !== true ||
    context.route === "credit" ||
    context.max_cashu_fee_sats !== args.maxCashuFeeSats ||
    context.pinned_mint !== args.cashuP2pk.mints[0]
  )
    return strictSpendFailure("Strict Cashu per-call mode requires one matching job context.");
  return null;
}

function strictWalletStateReason(wallet: AgentWallet): string | null {
  if (wallet.pending_mints.length > 0) return "The Cashu wallet has a pending mint.";
  if (wallet.pending_melts.length > 0) return "The Cashu wallet has a pending melt.";
  if (wallet.pending_submissions.length > 0)
    return "The Cashu wallet has another pending submission.";
  if (wallet.proofs.some((proof) => proof.status === "in_flight"))
    return "The Cashu wallet has in-flight proofs.";
  return null;
}

function strictSpendFailure(message: string): PrepareAgentSpendFailure {
  return {
    error: {
      code: "strict_per_call_unsafe",
      message,
      hint: "Resolve the existing wallet operation, then rebuild and re-approve the strict request.",
    },
  };
}

/**
 * Accepted output proofs belong to the DVM. Reserve-direct outputs are still
 * tracked locally, so commit removes them as well as the submission journal
 * and records the spend; swapped outputs were never in the free proof store.
 */
export async function commitAgentSpend(args: {
  requestId: string;
  recentSpend: AgentRecentSpend;
}): Promise<void> {
  await withWalletLock(() => {
    const wallet = loadAgentWallet();
    if (!wallet) return;
    const submission = wallet.pending_submissions.find((s) => s.request_id === args.requestId);
    const shippedKeys = new Set(submission?.output_proofs.map((p) => `${p.secret}:${p.C}`) ?? []);
    const next: AgentWallet = {
      ...wallet,
      proofs: wallet.proofs.filter((p) => !shippedKeys.has(`${p.secret}:${p.C}`)),
      pending_submissions: wallet.pending_submissions.filter(
        (s) => s.request_id !== args.requestId
      ),
      recent_spends: [...wallet.recent_spends, args.recentSpend].slice(-RECENT_SPENDS_CAP),
    };
    saveAgentWallet(next);
  });
}

/**
 * Persist a server-corrected `fund.amount_micro` into a pending submission's
 * resumable context. A `funding_commitment_mismatch` refusal states
 * the server's own valuation of the attached token; the in-flight retry
 * re-signs with that figure, and this write makes the resume sweep do the
 * same — without it, a transient failure on the corrected retry would leave
 * the sweep re-shipping the refused figure forever, deterministically
 * abandoning the funded spend. The token and its commitment are unchanged;
 * only the fund block's valuation moves. No-op when the entry or its fund
 * block is gone.
 */
export async function correctPendingFundAmount(args: {
  requestId: string;
  amountMicro: number;
}): Promise<void> {
  await withWalletLock(() => {
    const wallet = loadAgentWallet();
    if (!wallet) return;
    const next: AgentWallet = {
      ...wallet,
      pending_submissions: wallet.pending_submissions.map((s) => {
        if (s.request_id !== args.requestId || !s.context) return s;
        const data = s.context.submit_body.data as Record<string, unknown> | undefined;
        const fund = data?.fund as Record<string, unknown> | undefined;
        if (!fund) return s;
        // The refused POST bound any public request ID to the data it refused;
        // the corrected block is a different request and goes out without one.
        const { request_id: _requestId, ...rest } = data ?? {};
        return {
          ...s,
          context: {
            ...s.context,
            submit_body: {
              ...s.context.submit_body,
              data: { ...rest, fund: { ...fund, amount_micro: args.amountMicro } },
            },
          },
        };
      }),
    };
    saveAgentWallet(next);
  });
}

/**
 * Abandon a pending submission whose DVM has hard-rejected it (e.g.
 * `payment_invalid`, or `wrong_lock_pubkey` where rotation has aged out the
 * lock target). Removes the entry; the output proofs are dead capital
 * locked to the DVM's pubkey.
 *
 * Distinct from {@link commitAgentSpend} in that no `recent_spend` is
 * appended — the call failed, no service was rendered.
 *
 * For reserve-direct submissions, the matching proofs in
 * `wallet.proofs[]` are reverted from `in_flight` to `valid` so the agent
 * can refund them post-`t_expire` via `dvm wallet release`. The swap path
 * has no such proofs in the wallet, so this is a no-op for it.
 */
export async function abandonPendingSubmission(args: { requestId: string }): Promise<void> {
  await withWalletLock(() => {
    const wallet = loadAgentWallet();
    if (!wallet) return;
    const submission = wallet.pending_submissions.find((s) => s.request_id === args.requestId);
    const shippedKeys = new Set(submission?.output_proofs.map((p) => `${p.secret}:${p.C}`) ?? []);
    const next: AgentWallet = {
      ...wallet,
      proofs: wallet.proofs.map((p) =>
        shippedKeys.has(`${p.secret}:${p.C}`) && p.status === "in_flight"
          ? { ...p, status: "valid" as const, in_flight_until_ms: undefined }
          : p
      ),
      pending_submissions: wallet.pending_submissions.filter(
        (s) => s.request_id !== args.requestId
      ),
    };
    saveAgentWallet(next);
  });
}

/**
 * Mark a pending submission as accepted with an unsettled job identity, so no
 * sweep or recovery POSTs it again. The evidence record it names must already
 * be written. The first marker wins; an entry that is gone is left alone.
 */
export async function markPendingSubmissionUnresolved(args: {
  requestId: string;
  marker: PendingSubmissionAcceptedUnresolved;
}): Promise<void> {
  await withWalletLock(() => {
    const wallet = loadAgentWallet();
    if (!wallet) return;
    const next = withAcceptedUnresolved(wallet, args.requestId, args.marker);
    if (next !== wallet) saveAgentWallet(next);
  });
}

/**
 * The marker write without the lock, for a caller that already holds it. The
 * wallet lock is not reentrant, so taking it again would wait out its retry
 * budget and fail.
 */
export function withAcceptedUnresolved(
  wallet: AgentWallet,
  requestId: string,
  marker: PendingSubmissionAcceptedUnresolved
): AgentWallet {
  const target = wallet.pending_submissions.find((s) => s.request_id === requestId);
  if (!target || target.accepted_unresolved) return wallet;
  return {
    ...wallet,
    pending_submissions: wallet.pending_submissions.map((s) =>
      s.request_id === requestId ? { ...s, accepted_unresolved: marker } : s
    ),
  };
}

interface RefundClause {
  /** Absolute NUT-11 `locktime`, in unix seconds. */
  tExpireSec: number;
  refundPubkey: string;
  canonicalId: string;
}

/**
 * Resolve the refund clause for this call, or `null` when one can't be built
 *
 * Two ways it comes back `null`, both of which degrade to the legacy
 * behaviour rather than failing the call: the DVM advertises no
 * `cashu.canonical_id` (nothing to derive a per-DVM subkey from), or the wallet
 * has no mnemonic on disk. `reserve` / `release` throw `mnemonic_required` in
 * that second case, but they are explicit one-off verbs — throwing here would
 * break every paid call on a mnemonic-less wallet to add a backstop.
 *
 * A derivation that throws is swallowed for the same reason: a payment must not
 * fail because a recovery affordance couldn't be attached.
 */
function resolveRefundClause(
  offer: CashuP2pkOffer,
  locktimeSecondsOverride: number | undefined,
  nowMs: number,
  opts: { readMnemonic?: () => string | null }
): RefundClause | null {
  const canonicalId = offer.canonical_id;
  if (!canonicalId) return null;
  const mnemonic = (opts.readMnemonic ?? readAgentMnemonic)();
  if (!mnemonic) return null;
  const locktimeSeconds = Math.max(
    locktimeSecondsOverride ?? perCallLocktimeSeconds(offer.min_locktime),
    offer.min_locktime ?? 0
  );
  try {
    return {
      tExpireSec: Math.floor(nowMs / 1000) + locktimeSeconds,
      refundPubkey: deriveAgentRefundSubkeyPubkey(mnemonic, canonicalId),
      canonicalId,
    };
  } catch {
    return null;
  }
}

/**
 * Undo an abandoned mint attempt before the next candidate runs:
 * revert its inputs from `in_flight` back to spendable and drop its
 * empty-output `pending_submission`.
 *
 * Both halves matter. Without the revert the balance at the failed mint is
 * frozen until the in-flight sweep even though the call went on to succeed
 * elsewhere; without the drop, two entries would exist under one `request_id`.
 */
async function rollbackAttempt(requestId: string, proofKeys: Set<string>): Promise<void> {
  await withWalletLock(() => {
    const wallet = loadAgentWallet();
    if (!wallet) return;
    const reverted = revertInFlight(wallet, proofKeys);
    saveAgentWallet({
      ...reverted,
      pending_submissions: reverted.pending_submissions.filter((s) => s.request_id !== requestId),
    });
  });
}

/**
 * Selection-only failures preserve their code so callers may use another rail.
 * Any mint failure yields swap_failed: calling held funds a shortfall would
 * prompt a second deposit. Only an ambiguous swap leaves protected inputs and
 * needs recovery guidance; other failures may be retried immediately.
 */
function exhaustedError(
  attempts: SpendMintAttempt[],
  lastSelectError: SelectError | undefined,
  lastFeeCapError:
    | Extract<PrepareAgentSpendFailure["error"], { code: "cashu_fee_cap_exceeded" }>
    | undefined,
  inputsLeftInFlight: boolean
): PrepareAgentSpendFailure["error"] {
  if (attempts.length === 0) {
    // Unreachable in practice — Lock 1 returns a SelectError when nothing
    // covers, so the loop always has at least one candidate.
    return {
      code: "no_eligible_mint",
      message: "No mint the DVM accepts could be attempted for this payment.",
      hint: "Fund the wallet at one of the DVM's accepted mints with: dvm wallet fund <amount>",
      attempts,
    };
  }

  if (lastSelectError && attempts.every((a) => isSelectionReason(a.reason))) {
    if (attempts.length === 1) return { ...lastSelectError, attempts };
    return {
      code: lastSelectError.code,
      message: `Agent wallet can't cover the price plus the per-call swap fee at any of the DVM's mints: ${describeAttempts(attempts)}.`,
      hint: lastSelectError.hint,
      attempts,
    };
  }

  if (
    lastFeeCapError &&
    attempts.every((attempt) =>
      ["fee_cap_exceeded", "insufficient_balance", "no_eligible_mint"].includes(attempt.reason)
    )
  ) {
    if (attempts.length === 1) return { ...lastFeeCapError, attempts };
    return {
      ...lastFeeCapError,
      message: `Every accepted mint that can cover this payment exceeds --max-cashu-fee-sats: ${describeAttempts(attempts)}.`,
      attempts,
    };
  }

  const message =
    attempts.length === 1
      ? `Mint swap failed at ${attempts[0].mint}: ${attempts[0].message}`
      : `Every mint the DVM accepts failed for this payment: ${describeAttempts(attempts)}.`;
  return {
    code: "swap_failed",
    message,
    hint: inputsLeftInFlight
      ? "The swap outcome is being recovered from the mint. Run `dvm wallet show` to restore signed outputs or return inputs once the mint confirms they stayed unspent."
      : "Nothing was spent and the balance is untouched. Retry now — a mint that's down now is tried again on the next call.",
    attempts,
  };
}

function isSelectionReason(reason: SpendMintAttempt["reason"]): boolean {
  return reason === "insufficient_balance" || reason === "no_eligible_mint";
}

function describeAttempts(attempts: SpendMintAttempt[]): string {
  return attempts.map((a) => `${a.mint} — ${a.reason} (${a.message})`).join("; ");
}

/**
 * Whether this mint still serves `/v1/swap`, read from the `/v1/info` snapshot
 * the wallet already loaded. Unknown reads as capable: a mint surface that
 * doesn't expose its info (an older cashu-ts, a test double) says nothing about
 * the mint, and refusing to try it would be strictly worse than letting the
 * swap answer for itself.
 */
function swapEnabled(cashuWallet: Wallet): boolean {
  // Read structurally rather than through the `Wallet` type: a test double or
  // a partially-loaded mint may not carry the info surface at all, and the
  // point of this helper is to degrade to "try it" when it can't tell.
  const loose = cashuWallet as { getMintInfo?: () => { cache?: { nuts?: unknown } } };
  let nuts: unknown;
  try {
    if (typeof loose.getMintInfo !== "function") return true;
    nuts = loose.getMintInfo().cache?.nuts;
  } catch {
    return true;
  }
  if (typeof nuts !== "object" || nuts === null) return true;
  return canSwap(nuts as Record<string, unknown>);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Pick reserve proofs at a specific builder. Prefers an exact-cover subset
 * (sum equals `amountSats`); falls back to the **minimum-overshoot** subset
 * when no exact cover exists. With power-of-2 denominations a naive greedy
 * walk can overshoot — needing 6 from `[1,2,4,8]` would pick `[1,2,4]=7`
 * even though `[2,4]=6` is available — and surplus is the DVM's to keep
 * (reserve proofs are already DVM-locked: no swap, no swap fee, no
 * swap-for-change). The bounded subset-sum search here picks the tightest
 * sum at or above `amountSats`, so the worst case is overshoot bounded by
 * one denomination, not by the entire greedy tail. Returns `null` when the
 * reserve doesn't exist or doesn't cover the call — the caller then falls
 * through to per-call swap. Reserve proofs must:
 *
 * - carry `reserved_for === "builder/<handle>"`,
 * - come from the DVM's caller-restricted mint allowlist,
 * - lock to the DVM's currently-advertised `lock_pubkey` (mismatched
 * proofs are dead capital once rotation ages out the matching key),
 * - have `t_expire > now` (an expired reserve is for `dvm wallet release`
 * to handle, not for a fresh ship), and
 * - have `status === "valid"`.
 */
function selectReserveProofs(args: {
  proofs: AgentProof[];
  builderHandle: string;
  lockPubkey: string;
  mintAllowlist: string[];
  nowMs: number;
  amountSats: number;
}): { selected: AgentProof[]; mint: string; totalSats: number } | null {
  const marker = reservedForMarker(args.builderHandle);
  const candidates = args.proofs.filter(
    (p) =>
      p.reserved_for === marker &&
      args.mintAllowlist.includes(p.mint) &&
      p.locked_to_pubkey === args.lockPubkey &&
      p.status === "valid" &&
      typeof p.t_expire === "number" &&
      p.t_expire > args.nowMs
  );

  // Group by mint and try each in order — a reserve typically lives at one
  // mint, but we don't enforce that. First mint with a covering subset wins.
  const byMint = new Map<string, AgentProof[]>();
  for (const p of candidates) {
    const bucket = byMint.get(p.mint) ?? [];
    bucket.push(p);
    byMint.set(p.mint, bucket);
  }

  for (const [mint, mintProofs] of byMint) {
    // Smallest-amount-first + soonest-expiry-tiebreaker. The DP itself is
    // order-independent for the *min-overshoot guarantee*, but the iteration
    // order determines which subset reaches a given target first, so this
    // sort makes the chosen proofs deterministic and biases toward retiring
    // soon-to-expire reserves first.
    const sorted = mintProofs
      .slice()
      .sort((a, b) => a.amount - b.amount || (a.t_expire ?? 0) - (b.t_expire ?? 0));
    const subset = minOvershootSubset(sorted, args.amountSats);
    if (subset) {
      return { selected: subset.selected, mint, totalSats: subset.totalSats };
    }
  }
  return null;
}

/**
 * Bounded subset-sum search: returns the subset whose total is the smallest
 * value at or above `amountSats`, or `null` if no subset covers. Capped at
 * `amountSats + max(proof.amount)` — any reachable sum above that ceiling
 * is necessarily dominated by a sum ≤ ceiling (drop the largest proof). The
 * DP has |reachable| ≤ ceiling+1 distinct entries, so total work is
 * `O(proofs.length × (amountSats + maxProofAmount))` — trivial for realistic
 * reserves (a typical 100-sat reserve has ≤ 20 proofs).
 */
function minOvershootSubset(
  proofs: AgentProof[],
  amountSats: number
): { selected: AgentProof[]; totalSats: number } | null {
  if (proofs.length === 0) return null;
  const maxProof = proofs.reduce((m, p) => Math.max(m, p.amount), 0);
  const ceiling = amountSats + maxProof;

  // target -> indices of proofs summing to target (smallest set first reached).
  const reachable = new Map<number, number[]>();
  reachable.set(0, []);
  for (let i = 0; i < proofs.length; i++) {
    const v = proofs[i].amount;
    const snapshot = Array.from(reachable.entries());
    for (const [target, indices] of snapshot) {
      const next = target + v;
      if (next > ceiling) continue;
      if (reachable.has(next)) continue;
      reachable.set(next, [...indices, i]);
    }
  }

  let bestTarget = -1;
  for (const t of reachable.keys()) {
    if (t >= amountSats && (bestTarget === -1 || t < bestTarget)) bestTarget = t;
  }
  if (bestTarget === -1) return null;
  const indices = reachable.get(bestTarget) ?? [];
  return { selected: indices.map((i) => proofs[i]), totalSats: bestTarget };
}

export type { Token };
