import { autoPayWarnings } from "../lib/auto-pay-warning";
import { addOutputWarnings, withOutputWarnings } from "../lib/output";
import { providerFields, providerJobJson as json } from "../lib/provider-output";
import { buildTempoCredential } from "../lib/payment-rails/tempo-credential";
import { isTerminalJobStatus, pollNextAction } from "../lib/next-action";
import { parseBudget } from "../lib/currency";
import { buildPolicy } from "../lib/policy";
import {
  buildCompletionHintFields,
  completionSnapshot,
  nextStepHint,
} from "../lib/completion-hints";
import { SIGNED_REQUEST_AUTH_ID, type SignedRequestDomain } from "@dvmkit/sdk";
import {
  type AgentWallet,
  type AttestedDvmIdentity,
  type CreditMenu,
  DvmError,
  ensureProvisionalCredit,
  formatUsd,
  fundWireAmountMicro,
  isPublicRequestId,
  type JobEnvelope,
  type JobPolicy,
  type TransportJobReceipt as JobReceipt,
  type JobStatus,
  loadAgentWallet,
  loadCredit,
  loadImplicitCredits,
  loadReceipts,
  markCredit,
  markImplicitCreditLost,
  type Message,
  type MppxCredential,
  msatsToMicro,
  msatsToUsdc,
  type ProviderInfo,
  type ProviderRef,
  type Quote,
  readFundValuation,
  receiveToAgentWallet,
  recordFundResponse,
  recordRefusedDrawBalance,
  resolveTempoAsset,
  resolveTempoNetwork,
  resolveX402Asset,
  signDvmRequestData,
  signedRequestDomain,
  type StoredCredit,
  type TempoAccount,
  tempoCredentialAmountMicro,
  type Transport,
  unsignRequestData,
  usdcToMsats,
  type X402Wallet,
} from "@dvmkit/sdk/internal";
import {
  recordUpfrontRailPayment,
  loadJob,
  markJobTerminal,
  saveJob,
  saveSubmittedJob,
  recordUpfrontCreditPayment,
  updateJob,
} from "../lib/job-store";
import {
  captureFundingReceipt,
  captureTransportReceipt,
  fetchMissingJobReceipt,
  receiptJsonFields,
  receiptTrustFields,
  renderReceiptHuman,
} from "../lib/receipt-capture";
import {
  type Config,
  loadConfig,
} from "../lib/identity";
import {
  connectedTempoAccount,
  tempoWrongAssetHint,
} from "../lib/payment-rails/tempo-wallet";
import {
  getOutputTraceId,
  info,
} from "../lib/output";
import {
  loadX402Wallet,
} from "../lib/x402/wallet";
import {
  resolveSigningIdentity,
} from "../lib/cli-identity-resolve";
import {
  tryX402Payment,
  type X402PaymentProof,
} from "../lib/x402/client";
import {
  abandonPendingSubmission,
  commitAgentSpend,
  correctPendingFundAmount,
  markPendingSubmissionUnresolved,
  prepareAgentSpend,
  type PreparedAgentSpend,
} from "../lib/wallet-agent/spend";
import { sweepPendingSubmissions } from "../lib/wallet-agent/recovery-submissions";
import { identityDataFields, isIdentityFailure } from "../lib/job-identity";
import {
  journalMarkerFor,
  recordIdentityFailure,
  type SubmissionEvidenceInput,
} from "../lib/submission-evidence";
import {
  automaticCreditBoundRail,
  type CreditPlan,
  type DrawCeilingSource,
  effectiveCreditPosture,
  planCreditForQuote,
  planProbeDraw,
} from "../lib/credit-policy";
import { enforceGlobalBudget, recordSpend, recordSpendOnce } from "../lib/budget-ledger";
import { loadFloat } from "../lib/float";
import { resolveBtcUsdRate, tryResolveBtcUsdRate } from "../lib/btc-rate";
import { createHash, randomUUID } from "crypto";

import { withAgentWalletPaymentRetry } from "../lib/agent-wallet-retry";
import { drainStdin, StdinTimeoutError } from "../lib/byte-source";
import { noteDeferredFunding } from "../lib/credit-defer";
import { computeHeadroom, withHeadroom } from "../lib/credit-headroom";
import {
  buildCreditDrawSkipped,
  buildCreditFundingReport,
  buildCreditFundingSkipped,
  buildCreditSuggestion,
  buildSiblingCreditAvailable,
  noteCreditDrawSkipped,
  noteCreditFunding,
  noteCreditFundingSkipped,
  noteCreditSuggestion,
  noteSiblingCreditAvailable,
  type SiblingCreditAvailable,
  takeCreditNoticeFields,
} from "../lib/credit-notice";
import { providerDvmIdentity, reconcilePerDvmIdentity } from "../lib/credit-per-dvm";
import { localCreditRouteAvailability } from "../lib/credit-route-availability";
import { settleCreditAfterJob } from "../lib/credit-topup";
import { resolveDataFlag } from "../lib/data-flag";
import { formatIdentifier, resolveCapability, resolveDvmReference } from "../lib/dvm-identifier";
import { resolveEndpoint } from "../lib/favorites";
import { takeFeedbackNoticeFields } from "../lib/feedback-notice";
import { noteFeedbackAfterTerminal } from "../lib/feedback-nudges";
import { parseForcedRail } from "../lib/forced-rail";
import { dvmFetch } from "../lib/http";
import { withInputSchemaHint } from "../lib/input-schema-hint";
import { buildJobEnvelope, envelopeToPayload, paramsToData } from "../lib/job-envelope";
import {
  localCorrelationJobFields,
  normalizeLocalCorrelationId,
  prepareLocalCorrelationId,
} from "../lib/local-correlation";
import { appendMessages, createMessageAppendSession } from "../lib/messages";
import { applyMintPin } from "../lib/mint-pin";
import { selectRailOrder } from "../lib/payment-rails/select";
import { finalizeProgressLine } from "../lib/progress-bar";
import { progressNotice } from "../lib/progress-notice";
import { quoteWithinDeclaredLimit } from "../lib/quote-limit";
import { refundJsonField } from "../lib/refund-claim";
import { saveRequestIntent, recordRequestRailPayment } from "../lib/request-intent-store";
import { createArtifactSaveSession } from "../lib/save-artifact";
import { applyJsonSchemaDefaults, formatAppliedDefaults } from "../lib/schema-defaults";
import { streamLoop, type StreamLoopOptions, type StreamLoopResult } from "../lib/stream-loop";
import {
  persistStreamOutcome,
  streamTerminalStatus,
  type TerminalExtra,
} from "../lib/stream-outcome";
import { createDvmTransport } from "../lib/transport";
import {
  assertTempoChallengeNetwork,
  tempoAccountNetwork,
  tempoNetworkLabel,
} from "../lib/tempo-network";
import { groupProofsByMint } from "../lib/wallet-agent/balance";
import { warmupProvider } from "../lib/warmup-provider";
import { type DvmIdentity, dvmIdentity } from "./dvm-identity";
import { serializeMessageForOutput } from "./messages";
import { formatMessageHuman } from "../lib/message-human";
import { printNextActionHuman } from "../lib/next-action-human";
import {
  cheapestQuote,
  type NoEligibleMintDetail,
  outputCollectedQuotes,
  outputOverBudget,
  outputQuotesNoEligibleMint,
  outputQuotesNoWallet,
  quoteAmountLabel,
} from "./request-output";
import { buildResubmitAction } from "./request-resubmit";

export interface RequestOptions {
  /** Input text for the job; if omitted, reads from stdin */
  input?: string;
  /** Structured data for inputSchema DVMs (JSON string — parsed and sent as `body.data`). */
  data?: string;
  /**
   * DVM or DVM/capability identifier. One of `dvm` or `endpoint`
   * must be set. The slash form pins the capability explicitly; otherwise it
   * auto-fills against a single-capability DVM or errors when ambiguous.
   */
  dvm?: string;
  endpoint?: string;
  param?: string[];
  /** Bid amount in millisats or "$X.XX" in USD */
  budget?: string;
  /**
   * Require one exact already-selected prepaid credit and refuse every fresh
   * payment path. The explicit pin bypasses only the historical-price proxy;
   * the request's declared budget still rides on the job envelope.
   */
  creditOnly?: string;
  /**
   * Auto-pay threshold — payments at or below this don't need confirmation,
   * on both the upfront and mid-job legs. Passing it is itself bounded consent:
   * it implies `autoPay`, so a caller needn't set both. Carries the
   * CLI flag only — the `config.autoPayThreshold` fallback is resolved
   * separately, precisely so a standing default can't imply consent.
   */
  autoPayBelow?: string;
  maxIncrement?: string;
  /** Max number of payments to honour for this job. Required — agents must declare expectations. */
  maxPayments?: string;
  outputType?: string;
  /** Whether to stream results (default: true). Set to false by --no-stream. */
  stream?: boolean;
  /**
   * Bare consent to pay without prompting; the bound then derives from
   * `autoPayBelow`, `--budget` (20% of it), or config. Redundant when
   * `autoPayBelow` is set, which implies consent on its own.
   */
  autoPay?: boolean;
  human?: boolean;
  /** Timeout in seconds for waiting on a result */
  timeout?: string;
  /**
   * Force the upfront payment to use a specific rail. Overrides
   * the issue-spec order and any persisted `defaultRail`. When the DVM
   * doesn't advertise the rail or no local wallet covers it, the call
   * fails with a precise hint rather than silently falling back.
   */
  rail?: string;
  /**
   * Pin the Cashu spend mint for this job. Validated against the
   * DVM's `/v1/info` allowlist; the spend draws only from this mint (restrict
   * semantics — no fallback). Persisted per-job so the upfront leg, any mid-job
   * `payment-request`, and `dvm pay` all honour it.
   */
  mint?: string;
  /**
   * Refuse a Cashu swap when its selected inputs' swap-send reserve exceeds
   * this exact non-negative sat amount. The wallet enforces it before proofs
   * are marked in flight or submitted to the mint.
   */
  maxCashuFeeSats?: string;
  /** Approved SHA-256 over the exact strict Cashu request, signer, mint, and policy. */
  cashuBindingFingerprint?: string;
  /** Fail-closed direct Cashu mode: one pinned payment, no credit, fallback, reserve, or broad recovery. */
  strictPerCall?: boolean;
  /**
   * Caller signing identity to use when the DVM advertises descriptor auth.
   * When unset, the resolver walks `DVM_IDENTITY_KEY` → default
   * → sole-entry → error. Ignored on DVMs that don't require signed requests.
   */
  as?: string;
  /** Caller-generated id for server-backed lost-response recovery. */
  requestId?: string;
  /** UUID stored only on the local job record for lost-command-output correlation. */
  localCorrelationId?: string;
}

export async function request(opts: RequestOptions): Promise<void> {
  return withOutputWarnings(() => requestWithWarnings(opts));
}

async function requestWithWarnings(opts: RequestOptions): Promise<void> {
  const artifactSession = opts.human ? createArtifactSaveSession() : undefined;
  const timeout = opts.timeout ? Number(opts.timeout) * 1000 : 30000;
  // Validate the money cap before warmup or quote I/O. The wallet repeats the
  // numeric invariant at its public boundary; this pass gives CLI callers the
  // option-specific error even when the job is free or uses another rail.
  const requestedMaxCashuFeeSats = parseMaxCashuFeeSats(opts.maxCashuFeeSats);
  const localCorrelationId = prepareLocalCorrelationId(opts.localCorrelationId);
  validateStrictPerCallOptions(opts, requestedMaxCashuFeeSats);
  validateCreditOnlyOptions(opts);
  if (opts.requestId && !isPublicRequestId(opts.requestId)) {
    throw new DvmError(
      "invalid_request_id",
      "Invalid value for --request-id.",
      "Use 1–128 characters: letters, digits, dot, underscore, colon, or hyphen."
    );
  }

  // callers pick exactly one addressing mode — `-d <identifier>`
  // (slash-form, capability auto-fills via /v1/info) or `--endpoint <url>`
  // (explicit URL, capability resolved against /v1/info post-warmup).
  if (!opts.dvm && !opts.endpoint) {
    throw new DvmError(
      "endpoint_required",
      "A DVM identifier or endpoint is required.",
      "Use -d <handle>--<slug>[/capability] (e.g. `dvmkit--cast/add-episode`) or --endpoint <url>."
    );
  }
  if (opts.dvm && opts.endpoint) {
    throw new DvmError(
      "invalid_argument",
      "Pass either -d <identifier> or --endpoint <url>, not both.",
      "Drop --endpoint; -d resolves a favorite or the `<handle>--<slug>.dvmkit.ai` endpoint."
    );
  }

  // The literal user input, before resolution — `@alias`, a URL, or a
  // `-d <handle>--<slug>[/cap]>` identifier. Threaded into `withInputSchemaHint` so the
  // error path suggests `dvm describe <ref>` against what the caller typed,
  // not the resolved upstream URL.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const callerRef = opts.dvm ?? opts.endpoint!;

  let requestedCapability: string | undefined;
  let canonicalDvmId: string | undefined;
  let endpoint: string;
  if (opts.dvm) {
    const resolved = resolveDvmReference(opts.dvm);
    canonicalDvmId = resolved.qualified?.dvmId;
    requestedCapability = resolved.capability;
    endpoint = resolved.endpoint;
  } else {
    // The exactly-one-of guard above eliminated the both-null case; whatever
    // remains is the `--endpoint` form.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    endpoint = resolveEndpoint(opts.endpoint!);
  }

  // Parse --data into a JSON object up-front so the input guard knows
  // whether structured input was provided. Mirrors `dvm quote`.
  let data: Record<string, unknown> | undefined;
  // `--data @-` drains stdin for the JSON payload — track it so the
  // stdin fallback for `--input` below doesn't try to read the same pipe twice.
  let dataConsumedStdin = false;
  if (opts.data) {
    const resolved = await resolveDataFlag(opts.data);
    data = resolved.data;
    dataConsumedStdin = resolved.consumedStdin;
  } else if (opts.param && opts.param.length > 0) {
    // synthesise `data` from `--param` up-front so schema-default
    // application and request signing both see the agent-friendly form.
    // Keeps the on-the-wire shape unchanged — `buildJobEnvelope` still emits
    // `envelope.params` separately when --param is set.
    data = paramsToData(opts.param);
  }

  // For structured-input DVMs, `--param k=v` or `--data` carry the input —
  // `--input` is no longer mandatory in those cases. Stdin is still consumed
  // when piped.
  const hasParams = !!opts.param && opts.param.length > 0;
  const hasStructured = hasParams || data !== undefined;
  const inputText =
    opts.input ??
    (process.stdin.isTTY
      ? hasStructured
        ? ""
        : (() => {
            throw new DvmError(
              "no_input",
              "No input provided.",
              "Use --input, --param k=v (repeatable), --data <json>, or pipe via stdin."
            );
          })()
      : dataConsumedStdin
        ? ""
        : await readStdin());

  const noStream = opts.stream === false;

  const config = loadConfig();
  const effectiveBudget = opts.budget ?? config?.defaultBudget;
  const effectiveAutoPayBelow = opts.autoPayBelow ?? config?.autoPayThreshold;

  // an explicit `--auto-pay-below` is bounded consent on its own — the
  // same signal that already authorises mid-job surcharges (stream-loop.ts and
  // payment-responder.ts gate on policy.autoPayBelowMsats alone).
  //
  // Read `opts.autoPayBelow`, never `effectiveAutoPayBelow`: only the CLI flag may
  // imply consent. A standing default doing so — the config fallback above, or the
  // 20%-of-budget buildPolicy derives when unset — would silently authorise every
  // upfront charge on every request. The emptiness check keeps consent in lockstep
  // with the bound, since buildPolicy treats a falsy value as unset too.
  const autoPayConsent =
    !opts.creditOnly && (opts.autoPay === true || (opts.autoPayBelow !== undefined && opts.autoPayBelow.trim() !== ""));

  // Resolve --max-payments: flag → config default → hardcoded default of 5
  const DEFAULT_MAX_PAYMENTS = 5;
  let maxPaymentsN: number;
  if (opts.maxPayments !== undefined) {
    const trimmed = opts.maxPayments.trim();
    const parsed = Number(trimmed);
    if (trimmed === "" || !Number.isInteger(parsed) || parsed < 0) {
      throw new DvmError(
        "invalid_max_payments",
        "Invalid value for --max-payments.",
        "Pass a non-negative integer (e.g. --max-payments 1)."
      );
    }
    maxPaymentsN = parsed;
  } else {
    maxPaymentsN = config?.defaultMaxPayments ?? DEFAULT_MAX_PAYMENTS;
  }

  let budgetMsats: number | undefined;
  let btcRate = 0;
  if (effectiveBudget ?? effectiveAutoPayBelow ?? opts.maxIncrement) {
    const needsRate = [effectiveBudget, effectiveAutoPayBelow, opts.maxIncrement].some((s) =>
      s?.startsWith("$")
    );
    // A dollar-denominated budget can't be parsed without a rate: degrade to the
    // last-known cached one, and throw a typed `rate_unavailable` when there is
    // none rather than letting a provider 429 surface as `internal`.
    if (needsRate) btcRate = (await resolveBtcUsdRate("payment")).rate;
    if (effectiveBudget) {
      budgetMsats = effectiveBudget.startsWith("$")
        ? parseBudget(effectiveBudget, btcRate)
        : parseInt(effectiveBudget, 10);
    }
  }

  const transport = createDvmTransport();
  const ref: ProviderRef = { endpoint };

  // Wake the machine if auto-stopped (Fly auto-start). On warm machines this
  // completes in <50ms; on cold starts it absorbs the boot latency so the
  // job's --timeout budget starts fresh afterward.  The result is stashed so
  // handleAutoPayQuotes can reuse it without a second round-trip.
  const WARMUP_TIMEOUT_MS = 30_000;
  const warmupStart = Date.now();
  // Retry the pre-payment /v1/info probe on transient failures. The first-party
  // fleet runs Fly autostop=suspend, so this probe can land mid-resume
  // and come back truncated / non-JSON / 502. warmupProvider retries within
  // the same budget (safe —
  // GET, no money at stake).
  const providerInfo: ProviderInfo = await warmupProvider(transport, ref, {
    budgetMs: WARMUP_TIMEOUT_MS,
  });
  if (opts.requestId && providerInfo.requestRecovery !== true) {
    transport.close();
    throw new DvmError(
      "request_recovery_unsupported",
      "This DVM does not advertise durable request recovery.",
      "Do not pay with --request-id unless /v1/info reports request_recovery: true. Upgrade the DVM or omit the flag."
    );
  }
  const warmupMs = Date.now() - warmupStart;
  if (opts.human && warmupMs > 1000) {
    info(`Provider woke up in ${(warmupMs / 1000).toFixed(1)}s.`);
  }

  // pin the capability now that /v1/info is in hand. Single-cap DVMs
  // auto-fill; ambiguous multi-cap DVMs throw with a slash-form list. Preserve
  // owner-qualified caller input instead of turning provider metadata (which
  // may be a bare display name) into a callable identifier.
  const dvmId = canonicalDvmId;
  const capability = resolveCapability(providerInfo, requestedCapability, dvmId);
  const identity: DvmIdentity = { dvmId, capability };
  const identifier = dvmId ? formatIdentifier(dvmId, capability) : endpoint;
  if (opts.human) info(`Targeting ${identifier}.`);

  // every per-DVM rule below — posture, rail pin, trust ladder — is
  // resolved against this DVM's attested identity rather than the hostname the
  // caller happened to type, so a rule written under one spelling governs a job
  // that names another. Teach the config the link first, and clear any pins two
  // spellings disagree on, before anything reads one.
  const attestedIdentity = providerDvmIdentity(providerInfo);
  await reconcilePerDvmIdentity({
    endpoint: ref.endpoint,
    identity: attestedIdentity,
    config: loadConfig()?.credit,
    dvm: dvmId ?? ref.endpoint,
    ...(opts.human ? { human: true } : {}),
  });

  // fill top-level JSON-Schema `default` values from the DVM's
  // advertised input schema so a minimal call doesn't require the caller
  // to spell out every defaulted field. Mirrors `dvm quote`. Must fill
  // BEFORE `signRequestData` below — the server canonicalises the full
  // wire body when verifying, so any field added after signing would
  // break signature verification.
  const inputSchema =
    providerInfo.capabilities?.[capability]?.input_schema ?? providerInfo.inputSchema;
  let appliedDefaults: Record<string, unknown> = {};
  let normalizedInput: Record<string, unknown> | undefined;
  if (data && inputSchema) {
    const merged = applyJsonSchemaDefaults(inputSchema, data);
    if (Object.keys(merged.applied).length > 0) {
      data = merged.data;
      appliedDefaults = merged.applied;
      normalizedInput = merged.data;
      if (opts.human) {
        info(`Applied schema defaults: ${formatAppliedDefaults(merged.applied)}`);
      }
    }
  }

  // Build the job policy before the probe (hoisted for ): the
  // draw-first gate needs `autoPayBelowMsats` before the first submit.
  // maxPaymentsN always defined (defaulted to 5).
  const policy = buildPolicy(
    {
      budget: effectiveBudget,
      autoPayBelow: effectiveAutoPayBelow,
      maxIncrement: opts.maxIncrement,
      maxPayments: maxPaymentsN,
    },
    btcRate
  );
  if (
    opts.strictPerCall &&
    (policy.maxPayments !== 1 ||
      policy.maxTotalMsats !== policy.autoPayBelowMsats ||
      policy.maxTotalMsats !== policy.maxIncrementMsats)
  )
    throw new DvmError(
      "strict_per_call_policy_invalid",
      "Strict per-call mode requires identical explicit budget, auto-pay, and increment ceilings with exactly one payment.",
      "Pass the same millisat value to --budget, --auto-pay-below, and --max-increment, plus --max-payments 1."
    );

  // auto-sign when the DVM advertises descriptor auth. Resolver
  // walks --as → DVM_IDENTITY_KEY → defaultIdentity → sole-entry → error,
  // then we replace `data` with the signed envelope so the wire body carries
  // `(pubkey, timestamp, nonce, signature, ...data)`.
  //
  // the unsigned base is retained — every credit leg (draw-first
  // probe, fund-and-draw, per-call fallback) re-signs it with different
  // credit fields merged in, and a signature is only good for ~5 minutes.
  let signing: RequestSigningContext | undefined;
  let probePlan: CreditPlan = { mode: "none" };
  // Generated for a draw-first probe to a recovery-capable provider. Kept
  // apart from `opts.requestId`: a user-supplied ID disables credit planning,
  // a generated one must not.
  let drawRequestId: string | undefined;
  if (opts.requestId && !providerInfo.auth?.includes(SIGNED_REQUEST_AUTH_ID)) {
    transport.close();
    throw new DvmError(
      "request_recovery_auth_required",
      "Public request recovery requires a signed caller identity.",
      "Use a descriptor-auth DVM and select the same identity later with dvm request-result."
    );
  }
  if (
    providerInfo.auth?.includes(SIGNED_REQUEST_AUTH_ID) ||
    providerInfo.auth?.includes("secp256k1-schnorr")
  ) {
    const authDomain = signedRequestDomain({
      provider: providerInfo,
      endpoint,
      method: "POST",
      path: "v1/job",
      capability,
    });
    const signer = resolveSigningIdentity({ as: opts.as, config });
    const unsignedData = {
      ...(data ?? {}),
      ...(opts.requestId ? { request_id: opts.requestId } : {}),
    };
    signing = { privkey: signer.privkey, pubkey: signer.pubkey, unsignedData, domain: authDomain };
    // Draw-first: when a live credit is held at this DVM, the
    // initial signed submit carries {credit_id, draw_id} and the job clears
    // in one round trip with no payment attach.
    const storedRecord = opts.strictPerCall
      ? undefined
      : loadCredit(endpoint, signer.pubkey, attestedIdentity);
    const storedCredit = storedRecord?.selectionCleared ? undefined : storedRecord;
    if (opts.creditOnly && storedCredit?.creditId !== opts.creditOnly) {
      transport.close();
      throw new DvmError(
        "credit_only_unavailable",
        `Prepaid credit ${opts.creditOnly} is not the selected credit at this DVM.`,
        "Select that exact credit with 'dvm credit balance <dvm> --credit-id <id>', then retry the same approved request.",
        { credit_id: opts.creditOnly, selected_credit_id: storedCredit?.creditId ?? null }
      );
    }
    const implicitCredits =
      opts.strictPerCall || opts.creditOnly
        ? []
        : loadImplicitCredits(endpoint, signer.pubkey, attestedIdentity);
    if (storedCredit?.lastPriceMicro !== undefined && btcRate === 0) {
      // The price proxy compares the last drawn amount against the caller's
      // ceiling in fiat — resolve a rate best-effort when none was needed for
      // flag parsing. Without one the proxy stands down, never blocks.
      btcRate = (await tryResolveBtcUsdRate())?.rate ?? 0;
    }
    // The ceiling for a draw is what the caller declared for the whole job: an
    // explicit auto-pay threshold when they set one, otherwise the budget
    // itself. `policy.autoPayBelowMsats` is the per-call *increment* bound and
    // falls back to 20% of budget, which as a draw ceiling refused every draw
    // after the first one recorded its price.
    //
    // The flag and the standing config resolve to the same number but are
    // raised by different commands, so which one bound rides along — otherwise
    // the skip hint can only guess, and it guessed --budget, which moves
    // neither. The gate stays on `effectiveAutoPayBelow`, so that
    // which-msats decision is untouched; only the label branches, and it can
    // read `opts.autoPayBelow` directly because the flag wins the `??` whenever
    // it is set.
    const drawCeiling: { msats: number; source: DrawCeilingSource } =
      effectiveAutoPayBelow !== undefined && effectiveAutoPayBelow.trim() !== ""
        ? {
            msats: policy.autoPayBelowMsats,
            source: opts.autoPayBelow !== undefined ? "auto_pay_below" : "config_threshold",
          }
        : { msats: policy.maxTotalMsats, source: "budget" };
    const drawStored =
      opts.creditOnly && storedCredit
        ? (({ lastPriceMicro: _lastPriceMicro, ...credit }) => credit)(storedCredit)
        : storedCredit;
    probePlan = opts.strictPerCall
      ? { mode: "none" }
      : planProbeDraw({
          stored: drawStored,
          implicit: implicitCredits,
          drawCeilingMsats: drawCeiling.msats,
          drawCeilingSource: drawCeiling.source,
          btcRate,
          config: config?.credit,
          ...(attestedIdentity ? { identity: attestedIdentity } : {}),
        });
    if (opts.creditOnly && (probePlan.mode !== "draw" || probePlan.creditId !== opts.creditOnly)) {
      transport.close();
      throw new DvmError(
        "credit_only_unavailable",
        `Prepaid credit ${opts.creditOnly} is not drawable under the current caller state.`,
        "Reconcile that exact credit with 'dvm credit balance <dvm> --credit-id <id>'; this request did not fall back to a wallet payment.",
        {
          credit_id: opts.creditOnly,
          ...(probePlan.mode === "none" && probePlan.drawSkipped
            ? { reason: probePlan.drawSkipped.reason }
            : {}),
        }
      );
    }
    if (probePlan.mode === "draw" && opts.requestId) {
      probePlan = { ...probePlan, drawId: opts.requestId };
    }
    // A draw-first probe is this leg's paid POST: it clears the job in one
    // round trip, so it is the request a lost response must be read back by.
    // A plain probe is unpaid and never carries an ID.
    if (
      probePlan.mode === "draw" &&
      submitCanCarryGeneratedRequestId({ opts, providerInfo, signing })
    ) {
      drawRequestId = randomUUID();
    }
    const probeData =
      probePlan.mode === "draw"
        ? {
            ...unsignedData,
            credit_id: probePlan.creditId,
            draw_id: probePlan.drawId,
            ...(drawRequestId ? { request_id: drawRequestId } : {}),
          }
        : unsignedData;
    data = signDvmRequestData(signer.privkey, probeData, authDomain);
    if (opts.human) info(`Signed as ${signer.pubkey}.`);
    if (opts.human && probePlan.mode === "draw") {
      info(
        probePlan.source === "implicit"
          ? `Applying a released per-call balance at ${identity.dvmId ?? endpoint}.`
          : `Drawing on prepaid credit at ${identity.dvmId ?? endpoint}.`
      );
    }
    // A balance held here that this job won't spend is stated before the job
    // runs, not left for the caller to infer from an upfront quote.
    if (probePlan.mode === "none" && probePlan.drawSkipped) {
      noteCreditDrawSkipped(
        buildCreditDrawSkipped({
          dvm: identity.dvmId ?? endpoint,
          endpoint,
          skip: probePlan.drawSkipped,
        }),
        opts.human
      );
    }
  }

  // Start the job clock AFTER warmup so cold-start latency doesn't eat the budget.
  const deadlineMs = Date.now() + timeout;

  let envelope = buildJobEnvelope({
    capability,
    input: inputText,
    params: opts.param,
    data,
    outputType: opts.outputType,
    bidMsats: budgetMsats,
  });

  // Quote before a free or credit-draw submit can start the job without a 402.
  // Advisory pricing must not turn quote availability into a submit requirement.
  let previewQuotes: Quote[] = [];
  if (policy.maxTotalMsats > 0 || policy.autoPayBelowMsats > 0) {
    try {
      const quoteData = signing
        ? signDvmRequestData(signing.privkey, signing.unsignedData, signedRequestDomain({
            provider: providerInfo, endpoint, method: "POST", path: "v1/quote", capability,
          }))
        : data;
      previewQuotes = await transport.quote(ref, { ...envelope, data: quoteData });
    } catch { /* Older providers may support submit without a quote endpoint. */ }
  }
  const pricing = providerInfo.capabilities?.[capability]?.pricing as { max?: unknown } | undefined;
  const warningLimits = { budget: effectiveBudget, autoPayBelow: effectiveAutoPayBelow };
  const previewWarnings = autoPayWarnings(previewQuotes, warningLimits, pricing?.max ?? providerInfo.pricing?.max, btcRate);
  addOutputWarnings(previewWarnings, opts.human);

  // The ID the submitted job is recorded and reported under: the caller's own,
  // else the one generated for the draw leg that ends up accepted.
  let jobRequestId = opts.requestId ?? drawRequestId;
  if (jobRequestId) {
    persistRequestIntent({
      requestId: jobRequestId,
      transport,
      envelope,
      signing,
      endpoint,
      identity,
      policy,
      opts,
      providerInfo,
    });
  }

  progressNotice("Publishing job request...", opts.human);
  const usedPrimitiveInput = !!opts.input && !opts.data && !hasParams;
  const submitProbe = async (env: JobEnvelope) => {
    try {
      return await withInputSchemaHint(
        transport,
        ref,
        {
          capability,
          identifier,
          command: "request",
          usedPrimitiveInput,
          primitiveInput: opts.input,
          callerRef,
          callerFlag: opts.dvm ? "dvm" : "endpoint",
        },
        () =>
          transport.submit(ref, env, undefined, {
            timeoutMs: noStream ? 0 : timeout,
          })
      );
    } catch (err) {
      if (!isIdentityFailure(err)) throw err;
      // A probe can be accepted outright (a free job, or a draw on credit), so
      // its identity failure is recorded like a paid one. The public ID comes
      // from the envelope sent: a draw-conflict resubmit carries a fresh one
      // and a clean resubmit none, while the refused draw's ID is still the
      // one this command holds.
      const publicRequestId = opts.requestId ?? envelopeRequestId(env);
      throw recordIdentityFailure(err, {
        endpoint,
        ...(dvmId ? { dvmId } : {}),
        capability,
        ...(publicRequestId ? { publicRequestId } : {}),
        ...probeRailEvidence(env),
      }).error;
    }
  };

  let receipt;
  try {
    receipt = await submitProbe(envelope);
  } catch (err) {
    if (opts.requestId) {
      transport.close();
      throw requestOutcomeUnknown(opts.requestId, err);
    }
    // A draw the provider may have accepted is read back by its generated ID;
    // a defined refusal keeps its recovery below.
    if (drawRequestId && outcomeUnknownAfterSubmit(err)) {
      transport.close();
      throw requestOutcomeUnknown(drawRequestId, err);
    }
    if (opts.creditOnly) throw err;
    // a draw-carrying probe can be refused where the plain probe
    // cannot — the local credit record was stale, or the balance ran short.
    // Each refusal has a defined recovery; anything else rethrows.
    if (probePlan.mode !== "draw" || !signing || !(err instanceof DvmError)) throw err;
    // Pinned outside the closure below: the narrowing the guard just proved
    // doesn't survive into a nested function.
    const drawPlan = probePlan;
    const recovered = await withCreditHeadroom(
      () =>
        recoverDrawProbe(err, {
          transport,
          ref,
          envelope,
          signing,
          probePlan: drawPlan,
          submitProbe,
          endpoint,
          deadlineMs,
          budgetMsats,
          opts,
          identity,
          policy,
          providerInfo,
          autoPayConsent,
        }),
      { endpoint, callerPubkey: signing.pubkey, dvmId: identity.dvmId, providerInfo, config }
    );
    if (recovered.done) return;
    receipt = recovered.receipt;
    envelope = recovered.envelope;
    probePlan = recovered.plan;
    // The refused draw's ID stays bound to the data it refused; the resubmit
    // carries its own, or none when it went out unpaid.
    jobRequestId = recovered.requestId;
  }

  // Upfront payment required — handle before saving (no job exists yet)
  if (receipt.status === "payment-required") {
    const quotes = receipt.quotes ?? [];
    if (opts.creditOnly) {
      transport.close();
      throw new DvmError("credit_only_unavailable", "The selected prepaid credit did not cover this submission; no fresh payment was attempted.");
    }
    if (!previewWarnings.length) addOutputWarnings(autoPayWarnings(quotes, warningLimits, undefined, btcRate), opts.human);
    if (autoPayConsent && quotes.length > 0) {
      const pay = () =>
        handleAutoPayQuotes(
          transport,
          ref,
          envelope,
          receipt.jobId,
          deadlineMs,
          quotes,
          budgetMsats,
          opts,
          identity,
          policy,
          providerInfo,
          signing ? { signing } : undefined
        );
      try {
        if (opts.strictPerCall) await pay();
        else
          await withCreditHeadroom(pay, {
            endpoint,
            ...(signing ? { callerPubkey: signing.pubkey } : {}),
            dvmId: identity.dvmId,
            providerInfo,
            config,
          });
      } catch (error) {
        if (opts.requestId) throw requestOutcomeUnknown(opts.requestId, error);
        throw error;
      }
      return;
    }
    transport.close();
    const minMaxPayments = opts.maxPayments === "0" ? 1 : undefined;
    let action;
    if (quotes.length > 0) {
      const cheapest = cheapestQuote(quotes);
      const adjustmentNote = minMaxPayments ? " Bumps --max-payments from 0 to 1." : "";
      action = buildResubmitAction(
        opts,
        { forceAutoPay: true, minMaxPayments },
        `Upfront payment required: ${quoteAmountLabel(cheapest)}. Re-run with --auto-pay to approve.${adjustmentNote}`
      );
    }
    outputCollectedQuotes(receipt.jobId || null, quotes, opts, identity, undefined, action);
    return;
  }

  saveSubmittedJob({
    id: receipt.jobId,
    ...transactionRecordFields(receipt),
    endpoint,
    dvmId,
    feedbackClaim: receipt.feedbackClaim,
    capability,
    requestId: jobRequestId,
    status: "submitted",
    submittedAt: Date.now(),
    policy,
    pinnedMint: opts.mint,
    ...(opts.creditOnly ? { creditOnly: opts.creditOnly } : {}),
    ...(opts.strictPerCall ? { strictPerCall: true as const } : {}),
    ...(requestedMaxCashuFeeSats !== undefined
      ? { maxCashuFeeSats: requestedMaxCashuFeeSats }
      : {}),
    // the job cleared by drawing on a prepaid credit — no payment
    // attach, no budget-ledger entry (the funding already counted).
    ...(probePlan.mode === "draw" ? { paymentMethod: "credit" as const } : { upfrontRailPayment: "free" as const }),
    ...(signing ? { creditBinding: probePlan.mode === "draw"
      ? { creditId: probePlan.creditId, drawId: probePlan.drawId, callerPubkey: signing.pubkey }
      : { unbound: true as const, callerPubkey: signing.pubkey } } : {}),
    // persist the anonymous-flow per-job token so subsequent
    // status/messages/pay/cancel commands can present it as `X-Job-Token`.
    jobToken: receipt.jobToken,
    // snapshot the platform trace_id captured from the submit
    // response so `dvm feedback --job <id>` can derive it locally.
    traceId: getOutputTraceId() ?? undefined,
    // snapshot the receipt trust anchor so verification stays
    // offline and pins what this DVM advertised when the job ran.
    ...receiptTrustFields(providerInfo),
    ...localCorrelationJobFields(localCorrelationId),
  });
  recordUpfrontCreditPayment(receipt.jobId, receipt.upfrontPayment);

  if (noStream) {
    transport.close();
    if (opts.human) {
      info(`Job published: ${receipt.jobId}`);
      echoTraceIdHuman();
      if (!isTerminalJobStatus(receipt.status)) {
        printNextActionHuman(pollNextAction(receipt.jobId, "Job submitted, check back for updates"));
      }
    } else {
      json({
        jobId: receipt.jobId,
        ...requestIdOutputFields(jobRequestId),
        ...transactionOutputFields(receipt),
        ...dvmIdentity(dvmId, capability),
        // mirror `dvm quote`'s post-defaults diagnostic on the
        // noStream branch (closest analog — one shot, no live stream).
        // Streaming paths surface the actual job result, which already
        // tells the agent what the server processed.
        ...(normalizedInput && Object.keys(appliedDefaults).length > 0
          ? providerFields({ normalized_input: providerFields(normalizedInput, Object.keys(appliedDefaults)), applied_defaults: appliedDefaults }, ["applied_defaults"])
          : {}),
        // This branch returns before the job has an outcome, so it is the only
        // JSON the caller gets — a credit notice stashed during the probe has
        // nowhere else to land. The feedback sink deliberately does
        // NOT drain here: nothing may stash a feedback notice before a
        // terminal, so there is nothing to carry.
        ...takeCreditNoticeFields(),
        next_action: {
          type: "poll",
          job_id: receipt.jobId,
          hint: "Job submitted, check back for updates",
        },
      });
    }
    return;
  }

  switch (receipt.status) {
    case "completed": {
      markJobTerminal(receipt.jobId, "completed", completionSnapshot(receipt));
      const captured = captureTransportReceipt(receipt.jobId, receipt);
      // settle the credit projection (and refill at this healthy
      // moment) before the transport goes away.
      if (!opts.strictPerCall)
        await settleCreditAfterJob({
          capture: captured,
          transport,
          ref,
          dvmId,
          providerInfo,
          signing,
          allowTopup: !opts.creditOnly,
          human: opts.human,
        });
      // the job is over and this emission is terminal — the one
      // moment a feedback nudge may ride out.
      noteFeedbackAfterTerminal({
        jobId: receipt.jobId,
        dvmId,
        endpoint,
        status: "completed",
        human: opts.human,
      });
      transport.close();
      if (opts.human) {
        console.log(receipt.summary);
        const hint = nextStepHint(receipt.jobId, receipt.payloadIn, receipt.artifactCount, true);
        if (hint) info(`📎 ${hint}`);
        renderReceiptHuman(captured);
        echoTraceIdHuman();
      } else {
        json({
          jobId: receipt.jobId,
          ...requestIdOutputFields(jobRequestId),
          ...transactionOutputFields(receipt),
          ...dvmIdentity(dvmId, capability),
          summary: receipt.summary,
          _provider_fields: ["summary"],
          ...buildCompletionHintFields(receipt.jobId, receipt),
          ...receiptJsonFields(captured),
          ...takeCreditNoticeFields(),
          ...takeFeedbackNoticeFields(),
          next_action: null,
        });
      }
      return;
    }

    case "awaiting-input":
    case "processing": {
      // Stream until the provider yields, then keep polling through any
      // next_action: poll responses until we hit a terminal or human-input
      // action (or until --timeout expires).
      updateJob(receipt.jobId, {
        status: receipt.status === "awaiting-input" ? "awaiting-input" : "processing",
      });
      const result = await streamToCompletion(
        {
          jobId: receipt.jobId,
          transport,
          provider: ref,
          policy,
          ...(opts.human && {
            onMessage: (msg: Message) => {
              if (msg.type === "progress") formatMessageHuman(msg);
            },
          }),
        },
        deadlineMs
      );
      const completion = persistStreamOutcome(streamOutcome(receipt.jobId, result));
      // the streamed arc learns the job is over from the message log,
      // and the receipt only rides on the job read — so collect it with one
      // extra GET, spent only when the job actually finished (`nextAction ===
      // null`) and only against a DVM that advertised receipts.
      const captured =
        result.nextAction === null
          ? captureTransportReceipt(
              receipt.jobId,
              await fetchMissingJobReceipt(receipt.jobId, transport, ref)
            )
          : undefined;
      if (captured && !opts.strictPerCall) {
        await settleCreditAfterJob({
          capture: captured,
          transport,
          ref,
          dvmId,
          providerInfo,
          signing,
          allowTopup: !opts.creditOnly,
          human: opts.human,
        });
      }
      // this arc learns the job is over from the streamed log, so
      // the terminal it reports is where the nudge attaches. Cancelled streams
      // reach the same call and nudge nothing.
      const streamedTerminal =
        result.nextAction === null ? streamTerminalStatus(result.messages) : undefined;
      if (streamedTerminal) {
        noteFeedbackAfterTerminal({
          jobId: receipt.jobId,
          dvmId,
          endpoint,
          status: streamedTerminal,
          human: opts.human,
        });
      }
      transport.close();

      if (opts.human) {
        for (const msg of result.messages) {
          if (msg.type === "progress") continue; // already rendered live
          formatMessageHuman(msg, receipt.jobId, artifactSession);
        }
        if (completion) {
          const hint = nextStepHint(receipt.jobId, completion.payloadIn, completion.artifactCount, true);
          if (hint) info(`📎 ${hint}`);
        }
        if (captured) renderReceiptHuman(captured);
        finalizeProgressLine();
        echoTraceIdHuman();
        printNextActionHuman(result.nextAction, { refunds: result.refunds, terminal: isTerminalJobStatus(receipt.status) || !!streamTerminalStatus(result.messages) });
      } else {
        json({
          jobId: receipt.jobId,
          ...requestIdOutputFields(jobRequestId),
          ...transactionOutputFields(receipt),
          ...dvmIdentity(dvmId, capability),
          messages: result.messages.map(serializeMessageForOutput),
          // A job that streams to `complete` — including one auto-paid through a
          // mid-job `requestPayment` — has no receipt carrying the outcome, so
          // these come off the streamed log instead. Without them this arc
          // returned `next_action: null` and nothing else: no summary, and no
          // signal that a payload was waiting in artifacts.
          ...(completion?.summary !== undefined ? { summary: completion.summary, _provider_fields: ["summary"] } : {}),
          ...(completion ? buildCompletionHintFields(receipt.jobId, completion) : {}),
          ...(captured ? receiptJsonFields(captured) : {}),
          ...takeCreditNoticeFields(),
          ...takeFeedbackNoticeFields(),
          next_action: result.nextAction,
          ...(result.autoPayments.length > 0 ? { auto_payments: result.autoPayments } : {}),
          ...(await refundJsonField(result.refunds)),
        });
      }
      return;
    }

    case "failed": {
      markJobTerminal(receipt.jobId, "failed", completionSnapshot(receipt));
      // A synchronous terminal response carries status + receipt, not the
      // provider's message log. Fetch it before closing so recovery artifacts
      // reach default JSON on the prepaid-credit path too. This is
      // best-effort: a failed diagnostic read must not hide the job failure.
      const failureMessages = await transport
        .getMessages(receipt.jobId, 0, ref, { jobToken: receipt.jobToken })
        .catch(() => [] as Message[]);
      appendMessages(receipt.jobId, failureMessages);
      // "Took the money and the job failed" is exactly the case a receipt is
      // evidence for, so it rides out on the error rather than only landing in
      // the store — `DvmError.data` is spread into the error payload, and this
      // is the arc where the caller least wants to go looking for the proof.
      const captured = captureTransportReceipt(receipt.jobId, receipt);
      // a failed draw is released — the receipt's `balance_after`
      // restores the projection. No top-up from a failure.
      if (!opts.strictPerCall)
        await settleCreditAfterJob({
          capture: captured,
          transport,
          ref,
          dvmId,
          providerInfo,
          signing,
          allowTopup: false,
          human: opts.human,
        });
      // a failed job is the highest-signal feedback moment. This arc
      // reports the failure by throwing, and the error terminal drains the
      // feedback sink beside the credit one (see `handleError`).
      noteFeedbackAfterTerminal({
        jobId: receipt.jobId,
        dvmId,
        endpoint,
        status: "failed",
        human: opts.human,
      });
      transport.close();
      if (opts.human) {
        for (const msg of failureMessages) {
          formatMessageHuman(msg, receipt.jobId, artifactSession);
        }
        renderReceiptHuman(captured);
      }
      throw new DvmError("job_failed", "Job failed.", undefined, {
        ...receiptJsonFields(captured),
        ...(failureMessages.length > 0
          ? { messages: failureMessages.map(serializeMessageForOutput) }
          : {}),
      });
    }
  }
}

/**
 * Shape a `streamToCompletion` result for `persistStreamOutcome`. Every stream on
 * this path starts at seq 0, so the result carries the job's whole message log and
 * the terminal snapshot can be derived from it directly.
 */
function streamOutcome(jobId: string, result: StreamLoopResult, extra?: TerminalExtra) {
  return { jobId, messages: result.messages, cursor: result.cursor, afterSeq: 0, extra };
}

function echoTraceIdHuman(): void {
  const traceId = getOutputTraceId();
  if (traceId) info(`Trace: ${traceId}`);
}

/**
 * Signing context retained for the credit legs: the key plus the
 * unsigned base body every re-sign starts from. A signed envelope is only
 * valid for ~5 minutes and each leg merges different credit fields, so the
 * legs never reuse the probe's signature.
 */
interface RequestSigningContext {
  privkey: string;
  pubkey: string;
  unsignedData: Record<string, unknown>;
  domain: SignedRequestDomain;
}

interface RequestCreditContext {
  signing: RequestSigningContext;
  /**
   * Set by the `insufficient_credit` recovery: any fund plan must run as a
   * top-up of this credit under this SAME draw id, so the retried
   * fund-and-draw is idempotent end-to-end (`UNIQUE(credit_id, draw_id)`).
   */
  forcedTopup?: { creditId: string; drawId: string };
}

function identityArgs(identity: AttestedDvmIdentity | undefined): {
  identity?: AttestedDvmIdentity;
} {
  return identity ? { identity } : {};
}

/** sha256 hex over the verbatim payment-header string — the funding commitment (spec §2). */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The server's own fiat price for this job, in micro-units — `/v1/quote`'s
 * `upfront` envelope, the same surface `resolvePriceFiat` pins server-side.
 * Undefined when the quote is unreachable or carries no usable fiat price
 * (legacy servers), in which case a fund plan must stand down.
 *
 * Only reached when the 402 stated no `price_micro` of its own —
 * this hop's price comes from a *different* `onQuote` invocation than the 402's
 * `required_msats`, so the two halves of the ratio are pinned against two fx
 * snapshots and the figure is strictly weaker than the one on the 402.
 */
async function fetchServerPriceMicro(
  transport: Transport,
  ref: ProviderRef,
  envelope: JobEnvelope
): Promise<number | undefined> {
  try {
    const quotes = await transport.quote(ref, envelope);
    return quotePriceMicro(quotes[0]);
  } catch {
    return undefined;
  }
}

/**
 * The exact micro price stated on a quote, preferring the provider's own
 * integer over a reconstruction from its decimal.
 *
 * `amount × 1e6` is what a caller had to do before `amount_micro` existed, and
 * it is exact only for a provider that renders its price at full micro
 * precision. A provider that quantizes — the isolate tier advertises at four
 * decimals — hands back a figure it never charges, and the fund-and-draw signed
 * from it is refused `funding_commitment_mismatch`. Keep the fallback: it is
 * right for every provider that predates the field, and a corrective
 * re-sign catches it when it isn't.
 */
function quotePriceMicro(quote: Quote | undefined): number | undefined {
  const stated = statedPriceMicro(quote);
  if (stated !== undefined) return stated;
  const amount = quote?.upfront.amount;
  if (typeof amount !== "number" || amount <= 0) return undefined;
  const micro = Math.round(amount * 1_000_000);
  return micro > 0 ? micro : undefined;
}

/**
 * The exact integer a quote states for itself, or `undefined` — no fallback,
 * no reconstruction.
 *
 * Re-checked here rather than trusted from the type: the value ultimately signs
 * a `fund.amount_micro`, and `Quote` is a parsed shape, not a validated one, so
 * a `0`, a fraction or a `1e21` reaching this would price a funding commitment.
 * A malformed field reads as *not stated*, matching how the transport's own
 * `exactMicro` drops it, so whatever fallback the caller has still gets its turn.
 */
function statedPriceMicro(quote: Quote | undefined): number | undefined {
  const stated = quote?.upfront.amount_micro;
  return stated !== undefined && Number.isSafeInteger(stated) && stated > 0 ? stated : undefined;
}

/**
 * Run a credit-engaging leg, attaching this caller's funding headroom to a
 * shortfall that escapes it.
 *
 * `insufficient_credit` states what the balance couldn't cover; on its own it
 * leaves the agent to guess how much it may load in response. The headroom
 * block answers that in the same payload — the trust tier in force, the
 * builder's bounds, the per-rail minimums — so the decision doesn't need a
 * second command the agent has to know to run.
 */
async function withCreditHeadroom<T>(
  run: () => Promise<T>,
  ctx: {
    endpoint: string;
    callerPubkey?: string;
    dvmId?: string;
    providerInfo: ProviderInfo;
    config: Config | null;
  }
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof DvmError) || err.code !== "insufficient_credit") throw err;
    const identity = providerDvmIdentity(ctx.providerInfo);
    const stored = ctx.callerPubkey
      ? loadCredit(ctx.endpoint, ctx.callerPubkey, identity)
      : undefined;
    // a short fund-and-draw commits its deposit before refusing the
    // draw, so the error can be fresher than the provisional projection the
    // fund leg just wrote. The server-stated id is the only pin this wrapper
    // has; accept it only when it names the credit already tracked for this
    // DVM. The store repeats that identity check under its own mutation, so a
    // concurrent re-point between this read and the write is still a no-op.
    const refusedCreditId = err.data?.credit_id;
    if (
      ctx.callerPubkey &&
      stored &&
      typeof refusedCreditId === "string" &&
      refusedCreditId === stored.creditId
    ) {
      recordRefusedDrawBalance({
        endpoint: ctx.endpoint,
        ...(identity ? { identity } : {}),
        callerPubkey: ctx.callerPubkey,
        creditId: refusedCreditId,
        remainingMicro: err.data?.remaining_micro,
        balanceMicro: err.data?.balance_micro,
      });
    }
    // The 402's own menu is the freshest statement of the builder's bounds;
    // the stored snapshot is whatever the last one said.
    const menu = (err.data?.credit as CreditMenu | undefined) ?? stored?.menu;
    const remaining = err.data?.remaining_micro;
    const builderPubkey = ctx.providerInfo.builder?.pubkey ?? stored?.builderPubkey;
    const balanceMicro = typeof remaining === "number" ? remaining : (stored?.remainingMicro ?? 0);
    const routeAmountMicro =
      typeof err.data?.shortfall_micro === "number" ? err.data.shortfall_micro : undefined;
    const boundRail = automaticCreditBoundRail(stored);
    const receipts = loadReceipts();
    const base = computeHeadroom({
      endpoint: ctx.endpoint,
      receipts,
      signingPubkey: ctx.callerPubkey,
      ...(identity ? { identity } : {}),
      balanceMicro,
      ...(menu ? { menu } : {}),
      ...(ctx.config?.credit ? { config: ctx.config.credit } : {}),
      ...(builderPubkey ? { builderPubkey } : {}),
      ...(routeAmountMicro !== undefined ? { routeAmountMicro } : {}),
      ...(boundRail ? { boundRail } : {}),
    });
    const decorated = withHeadroom(
      err,
      computeHeadroom({
        endpoint: ctx.endpoint,
        receipts,
        signingPubkey: ctx.callerPubkey,
        ...(identity ? { identity } : {}),
        balanceMicro,
        ...(menu ? { menu } : {}),
        ...(ctx.config?.credit ? { config: ctx.config.credit } : {}),
        ...(builderPubkey ? { builderPubkey } : {}),
        ...(routeAmountMicro !== undefined ? { routeAmountMicro } : {}),
        ...(boundRail ? { boundRail } : {}),
        ...(menu
          ? {
              routeAvailability: localCreditRouteAvailability({
                menu,
                providerInfo: ctx.providerInfo,
                config: ctx.config,
                amountMicro: base.routeAmountMicro,
              }),
            }
          : {}),
      })
    );
    const sibling = siblingCreditNotice(err, stored, ctx.dvmId ?? ctx.endpoint, ctx.endpoint);
    if (!sibling) throw decorated;
    throw new DvmError(
      decorated.code,
      decorated.message,
      `${decorated.hint ? `${decorated.hint} ` : ""}${sibling.hint}`,
      { ...(decorated.data ?? {}), credit_sibling: sibling },
      decorated.display ? `${decorated.display} ${sibling.display}` : sibling.display
    );
  }
}

function siblingCreditNotice(
  err: DvmError,
  stored: StoredCredit | undefined,
  dvm: string,
  endpoint: string
): SiblingCreditAvailable | undefined {
  const remaining = err.data?.remaining_micro;
  const shortfall = err.data?.shortfall_micro;
  if (
    !stored ||
    !Number.isSafeInteger(remaining) ||
    !Number.isSafeInteger(shortfall) ||
    (remaining as number) < 0 ||
    (shortfall as number) <= 0
  ) {
    return undefined;
  }
  const requiredMicro = (remaining as number) + (shortfall as number);
  const sibling = [...(stored.siblingCredits ?? [])]
    .filter(
      (credit) =>
        !credit.expired &&
        credit.currency === stored.currency &&
        credit.remainingMicro >= requiredMicro
    )
    .sort((left, right) => left.remainingMicro - right.remainingMicro)
    .at(0);
  if (!sibling) return undefined;
  return buildSiblingCreditAvailable({
    dvm,
    endpoint,
    trackedCreditId: stored.creditId,
    siblingCreditId: sibling.creditId,
    siblingBalanceMicro: sibling.remainingMicro,
    requiredMicro,
    currency: sibling.currency,
  });
}

interface DrawProbeRecoveryArgs {
  transport: Transport;
  ref: ProviderRef;
  envelope: JobEnvelope;
  signing: RequestSigningContext;
  probePlan: Extract<CreditPlan, { mode: "draw" }>;
  submitProbe: (env: JobEnvelope) => Promise<Awaited<ReturnType<Transport["submit"]>>>;
  endpoint: string;
  deadlineMs: number;
  budgetMsats: number | undefined;
  opts: RequestOptions;
  identity: DvmIdentity;
  policy: JobPolicy;
  providerInfo: ProviderInfo;
  autoPayConsent: boolean;
}

type DrawProbeRecovery =
  | { done: true }
  | {
      done: false;
      receipt: Awaited<ReturnType<Transport["submit"]>>;
      envelope: JobEnvelope;
      plan: CreditPlan;
      /** Generated ID the resubmitted draw carries; absent for an unpaid resubmit. */
      requestId?: string;
    };

/**
 * Recover a refused draw-first probe. The error→recovery table:
 *
 * - `credit_not_found` → mark the local record gone, resubmit per-call.
 * - `credit_expired` → mark expired (stays visible for `dvm credit drain`),
 *   resubmit per-call.
 * - `draw_conflict` (409) → regenerate the draw id once and resubmit; the
 *   original draw was recorded under different terms, so replaying its id
 *   can only conflict again.
 * - `insufficient_credit` → ONE fund-and-draw retry under the SAME draw id
 *   (the refused draw was never recorded, and `UNIQUE(credit_id, draw_id)`
 *   makes the retry idempotent), sized to the refill target and routed
 *   through the ordinary auto-pay gates via a synthetic quote.
 *
 * Anything else rethrows untouched.
 */
async function recoverDrawProbe(
  err: DvmError,
  args: DrawProbeRecoveryArgs
): Promise<DrawProbeRecovery> {
  const { signing } = args;
  const reSign = (fields?: Record<string, unknown>): JobEnvelope => ({
    ...args.envelope,
    data: signDvmRequestData(
      signing.privkey,
      fields ? { ...signing.unsignedData, ...fields } : signing.unsignedData,
      signing.domain
    ),
  });

  if (err.code === "credit_not_found" || err.code === "credit_expired") {
    const status = err.code === "credit_expired" ? "expired" : "gone";
    const attested = providerDvmIdentity(args.providerInfo);
    if (args.probePlan.source === "implicit") {
      markImplicitCreditLost({
        endpoint: args.endpoint,
        ...(attested ? { identity: attested } : {}),
        callerPubkey: signing.pubkey,
        creditId: args.probePlan.creditId,
        reason: err.code === "credit_expired" ? "expired" : "not_found",
      });
    } else if (attested) {
      markCredit(args.endpoint, signing.pubkey, status, { identity: attested });
    } else {
      markCredit(args.endpoint, signing.pubkey, status);
    }
    if (args.opts.human) {
      info(
        args.probePlan.source === "implicit"
          ? err.code === "credit_expired"
            ? "The released per-call balance expired and is lost; this DVM has no reclaim path. Paying per-call."
            : "The DVM no longer recognises this released per-call balance, so it is lost. Paying per-call."
          : err.code === "credit_expired"
            ? "The prepaid credit here has expired (its balance stays yours — see 'dvm credit drain'). Paying per-call."
            : "The DVM no longer recognises the prepaid credit. Paying per-call."
      );
    }
    const clean = reSign();
    const receipt = await args.submitProbe(clean);
    return { done: false, receipt, envelope: clean, plan: { mode: "none" } };
  }

  if (err.code === "draw_conflict") {
    const plan: CreditPlan = {
      mode: "draw",
      creditId: args.probePlan.creditId,
      drawId: randomUUID(),
      ...(args.probePlan.source ? { source: args.probePlan.source } : {}),
    };
    // New draw ID, new `data`: the refused probe's request ID is bound to the
    // data it refused, so this draw gets its own.
    const requestId = submitCanCarryGeneratedRequestId({
      opts: args.opts,
      providerInfo: args.providerInfo,
      signing,
    })
      ? randomUUID()
      : undefined;
    const env = reSign({
      credit_id: plan.creditId,
      draw_id: plan.drawId,
      ...(requestId ? { request_id: requestId } : {}),
    });
    if (requestId) {
      persistRequestIntent({
        requestId,
        transport: args.transport,
        envelope: env,
        signing,
        endpoint: args.endpoint,
        identity: args.identity,
        policy: args.policy,
        opts: args.opts,
        providerInfo: args.providerInfo,
      });
    }
    let receipt;
    try {
      receipt = await args.submitProbe(env);
    } catch (retryErr) {
      if (requestId && outcomeUnknownAfterSubmit(retryErr)) {
        args.transport.close?.();
        throw requestOutcomeUnknown(requestId, retryErr);
      }
      throw retryErr;
    }
    return { done: false, receipt, envelope: env, plan, ...(requestId ? { requestId } : {}) };
  }

  if (err.code === "insufficient_credit") {
    if (args.probePlan.source === "implicit") {
      // This single-use balance cannot be topped up through `/v1/credit` on
      // the no-menu DVMs that create it. Keep it for a cheaper later job and
      // let this request take the ordinary per-call path.
      const clean = reSign();
      const receipt = await args.submitProbe(clean);
      return { done: false, receipt, envelope: clean, plan: { mode: "none" } };
    }
    // the refusal is proof the projection was wrong — the draw would
    // not have been attempted otherwise. Adopt the balances the DVM just stated
    // BEFORE the re-probe, so the refill `planCreditForQuote` sizes off
    // `loadCredit` answers the real gap instead of the figure it contradicted.
    // Pinned to the credit the draw named: a record that has since re-pointed
    // is a different credit and this says nothing about it.
    recordRefusedDrawBalance({
      endpoint: args.endpoint,
      ...identityArgs(providerDvmIdentity(args.providerInfo)),
      callerPubkey: signing.pubkey,
      creditId: args.probePlan.creditId,
      remainingMicro: err.data?.remaining_micro,
      balanceMicro: err.data?.balance_micro,
    });
    const stored = loadCredit(
      args.endpoint,
      signing.pubkey,
      providerDvmIdentity(args.providerInfo)
    );
    const sibling = siblingCreditNotice(
      err,
      stored,
      args.identity.dvmId ?? args.endpoint,
      args.endpoint
    );
    if (sibling) noteSiblingCreditAvailable(sibling, args.opts.human);
    // Re-probe with a clean body: the fund-and-draw retry must be sized and
    // wire-matched against **server-authored** figures (`required_msats` off
    // the fresh 402, the fiat price off `/v1/quote`) — the refused draw's
    // error carries micro amounts but not the msats ratio the signed fund
    // block must reproduce exactly (`funding_commitment_mismatch` otherwise,
    // after the spend has already committed).
    const clean = reSign();
    const receipt = await args.submitProbe(clean);
    if (
      args.autoPayConsent &&
      receipt.status === "payment-required" &&
      (receipt.quotes?.length ?? 0) > 0
    ) {
      if (args.opts.human) {
        info("Prepaid balance can't cover this job — funding a top-up with it.");
      }
      await handleAutoPayQuotes(
        args.transport,
        args.ref,
        clean,
        receipt.jobId,
        args.deadlineMs,
        receipt.quotes ?? [],
        args.budgetMsats,
        args.opts,
        args.identity,
        args.policy,
        args.providerInfo,
        {
          signing,
          // Same draw id end-to-end: the refused draw was never recorded, and
          // the ledger's UNIQUE(credit_id, draw_id) makes the retry idempotent.
          forcedTopup: { creditId: args.probePlan.creditId, drawId: args.probePlan.drawId },
        }
      );
      return { done: true };
    }
    return { done: false, receipt, envelope: clean, plan: { mode: "none" } };
  }

  throw err;
}

async function handleAutoPayQuotes(
  transport: Transport,
  ref: ProviderRef,
  envelope: JobEnvelope,
  jobId: string,
  deadlineMs: number,
  quotes: Quote[],
  budgetMsats: number | undefined,
  opts: RequestOptions,
  identity: DvmIdentity,
  policy: JobPolicy,
  providerInfo: ProviderInfo,
  creditCtx?: RequestCreditContext
): Promise<void> {
  const configuredLimits = loadConfig();
  const declaredBudget = opts.budget ?? configuredLimits?.defaultBudget;
  const declaredAutoPayBelow = opts.autoPayBelow ?? configuredLimits?.autoPayThreshold;
  const chosen = budgetMsats
    ? quotes.find((quote) =>
        quoteWithinDeclaredLimit(quote, budgetMsats, declaredBudget, opts.rail)
      )
    : quotes[0];

  if (!chosen) {
    transport.close?.();
    const cheapest = cheapestQuote(quotes);
    // Raise --auto-pay-below alongside --budget: a rerun that fits the budget
    // still stops at the auto-pay threshold, which the caller never bumped.
    const action = buildResubmitAction(
      opts,
      { minBudgetMsats: cheapest.priceMsats, minAutoPayBelowMsats: cheapest.priceMsats },
      `Cheapest quote (${quoteAmountLabel(cheapest)}) exceeds your --budget. Re-run with --budget at or above the quote price.`
    );
    outputOverBudget(jobId || null, quotes, opts, identity, action);
    return;
  }

  // Check auto-pay threshold (mirrors payment-responder.ts for mid-job payments)
  if (
    !quoteWithinDeclaredLimit(chosen, policy.autoPayBelowMsats, declaredAutoPayBelow, opts.rail)
  ) {
    transport.close?.();
    const action = buildResubmitAction(
      opts,
      { minAutoPayBelowMsats: chosen.priceMsats },
      `Price (${quoteAmountLabel(chosen)}) exceeds your --auto-pay-below threshold. Re-run with --auto-pay-below at or above the quote price.`
    );
    outputCollectedQuotes(
      jobId || null,
      quotes,
      opts,
      identity,
      "Price exceeds your --auto-pay-below threshold. Increase it or pass a higher --budget.",
      action
    );
    return;
  }

  // Pre-check the payment count cap — upfront payment counts toward the cap
  if (policy.maxPayments < 1) {
    transport.close?.();
    const action = buildResubmitAction(
      opts,
      { forceAutoPay: true, minMaxPayments: 1 },
      `--max-payments is 0 but a payment is required to proceed (${quoteAmountLabel(chosen)}). Re-run with --max-payments 1 (or higher) and --auto-pay to authorise it.`
    );
    outputCollectedQuotes(
      jobId || null,
      quotes,
      opts,
      identity,
      "--max-payments is 0 but a payment is required to proceed. Resubmit with --max-payments 1 (or higher) and --auto-pay if you wish to authorise it.",
      action
    );
    return;
  }

  // fail fast on a `--mint` that the DVM doesn't accept, before any
  // rail is attempted, so the error names the allowed mints regardless of which
  // rail selection picks. The narrowing itself happens per-rail below.
  if (opts.mint) {
    try {
      applyMintPin(providerInfo.cashu?.mints ?? [], opts.mint);
    } catch (err) {
      transport.close?.();
      throw err;
    }
  }

  // decide how this payment engages the credit ledger BEFORE the
  // budget gate — an open/top-up charges the caps with the funding amount,
  // not the job price. The per-job auto-pay threshold above gated the job
  // price (operator ruling 2026-07-28); funding size is bounded by the
  // trust-tier caps and the budget-ledger caps.
  let plan: CreditPlan = { mode: "none" };
  let planRate = 0;
  const attestedIdentity = providerDvmIdentity(providerInfo);
  if (creditCtx?.signing && !opts.strictPerCall && !opts.requestId) {
    planRate = (await tryResolveBtcUsdRate())?.rate ?? 0;
    const x402Wallet = loadX402Wallet();
    plan = planCreditForQuote({
      // Attached-payment 402s carry the price but not the funding menu. The
      // authenticated `/v1/info` read already supplied that menu; retaining it
      // here lets the normal request path plan deferred Lightning/MPP funding
      // just like an explicit `/v1/quote` response does.
      menu: chosen.credit ?? providerInfo.credit,
      endpoint: ref.endpoint,
      ...(attestedIdentity ? { identity: attestedIdentity } : {}),
      signingPubkey: creditCtx.signing.pubkey,
      priceMsats: chosen.priceMsats,
      btcRate: planRate,
      receipts: loadReceipts(),
      stored: loadCredit(ref.endpoint, creditCtx.signing.pubkey, attestedIdentity),
      config: loadConfig()?.credit,
      // whether the float can carry a funding is half the rail rule,
      // and it is caller-side state the planner is deliberately kept pure of.
      floatConnected: floatUsable(),
      // The chain rides along with the connection: a channel on a network this
      // wallet isn't pinned to is one it cannot sign a voucher against.
      x402Connected: x402Wallet !== null,
      ...(x402Wallet ? { x402Network: x402Wallet.network } : {}),
      // A Tempo credit menu qualifies when this caller can sign its advertised
      // charge or session; channel persistence is needed only for the latter.
      tempoConnected: (await connectedTempoAccount()) !== null,
    });
    // The insufficient_credit recovery pins the credit + draw ids: whatever
    // the policy sized, the retry must run as a top-up of THAT credit under
    // THAT draw id (idempotency), never a fresh open.
    if (creditCtx.forcedTopup && (plan.mode === "open" || plan.mode === "topup")) {
      plan = {
        ...plan,
        mode: "topup",
        creditId: creditCtx.forcedTopup.creditId,
        drawId: creditCtx.forcedTopup.drawId,
      };
    }
    // Same pin on the deferred route: the DVM named the credit that
    // came up short, and the local record can be pointing elsewhere. No draw id
    // travels with it — nothing is drawn on this path — but funding the wrong
    // credit would leave the one the retry needs still short.
    if (creditCtx.forcedTopup && plan.mode === "none" && plan.deferred) {
      plan = {
        ...plan,
        deferred: { ...plan.deferred, creditId: creditCtx.forcedTopup.creditId },
      };
    }
    // the sizing stands, but its rail can't ride a job request — hand
    // it to the post-job healthy moment, where `credit-fund.ts` can spend a
    // `/v1/credit` round trip on it. This job pays per-call meanwhile, exactly
    // as it would have with no credit planned at all.
    if (plan.mode === "none" && plan.deferred) noteDeferredFunding(plan.deferred);
    if (plan.mode === "none" && plan.fundingSkipped) {
      noteCreditFundingSkipped(
        buildCreditFundingSkipped({
          dvm: identity.dvmId ?? ref.endpoint,
          endpoint: ref.endpoint,
          skipped: plan.fundingSkipped,
        }),
        opts.human
      );
    }
    // the posture held a purchase back. Say so here, where it was
    // suppressed — never on jobs that had nothing to suppress.
    if (plan.mode === "none" && plan.suppressed) {
      const posture = effectiveCreditPosture(loadConfig()?.credit, ref.endpoint, attestedIdentity);
      const priceMicro = planRate > 0 ? msatsToMicro(chosen.priceMsats, planRate) : 0;
      noteCreditSuggestion(
        buildCreditSuggestion({
          dvm: identity.dvmId ?? ref.endpoint,
          endpoint: ref.endpoint,
          posture: posture.posture,
          postureSource: posture.source,
          suppressed: plan.suppressed,
          // Derived from the amount that was actually sized, not the ratified
          // 20× — the tier cap and the builder's floor both bind before this,
          // and quoting a figure the deposit wouldn't have bought is the kind
          // of small lie an agent relays to a human verbatim.
          ...(priceMicro > 0
            ? { coversJobs: Math.floor(plan.suppressed.fundMicro / priceMicro) }
            : {}),
        }),
        opts.human
      );
    }
  }

  // The signed `fund.amount_micro` must reproduce the server's own valuation
  // of the token (`fundedMicroFor` over its quote-pinned fiat ↔ msats ratio)
  // or the fund-and-draw is refused after the spend committed.
  //
  // the fiat side rides the 402 as `price_micro`, beside the
  // `required_msats` this ratio's other half comes from — so first contact
  // costs no extra round trip and both inputs are pinned against one server-side
  // fx snapshot. `/v1/quote` is the fallback for providers that predate the
  // field. No usable fiat price → per-call.
  //
  // Only the provider's own integer short-circuits the hop. `chosen` is
  // routinely the synthetic quote `HttpsTransport.submit` builds from a 402,
  // whose `upfront.amount` is a client-fx reconstruction rounded to four
  // decimals — signing a fund amount off *that* is the mismatch
  // itself, so it must reach `fundWireAmountMicro` through no path at all.
  if (plan.mode === "open" || plan.mode === "topup") {
    const priceMicroServer =
      statedPriceMicro(chosen) ?? (await fetchServerPriceMicro(transport, ref, envelope));
    if (priceMicroServer === undefined) {
      info("Credit funding skipped — the DVM's fiat price is unavailable. Paying per-call.");
      plan = { mode: "none" };
    } else {
      plan = {
        ...plan,
        wireAmountMicro: fundWireAmountMicro(
          priceMicroServer,
          plan.fundSats * 1000,
          chosen.priceMsats
        ),
      };
    }
  }

  // Pre-check the global budget ledger — the money leaving the wallet (the
  // funding when opening/topping up, the job price otherwise) counts toward
  // daily/weekly/monthly caps.
  let upfrontBtcRate: number;
  try {
    upfrontBtcRate = await enforceGlobalBudget({
      plannedMsats:
        plan.mode === "open" || plan.mode === "topup" ? plan.fundMsats : chosen.priceMsats,
      ...(planRate > 0 ? { btcRate: planRate } : {}),
    });
  } catch (budgetErr) {
    if (
      !(budgetErr instanceof DvmError) ||
      budgetErr.code !== "budget_exceeded" ||
      plan.mode === "none" ||
      plan.mode === "draw"
    ) {
      throw budgetErr;
    }
    // Buffer semantics (spec §11): a blocked credit funding never blocks the
    // job. Surface the structured budget refusal, degrade to per-call, and
    // let the job price face the cap on its own.
    const budgetDisplay =
      typeof budgetErr.data?.display === "string" ? budgetErr.data.display : budgetErr.message;
    info(`Credit funding skipped — ${budgetDisplay} Paying this job per-call.`);
    plan = { mode: "none" };
    upfrontBtcRate = await enforceGlobalBudget({ plannedMsats: chosen.priceMsats });
  }

  // Every entry path hands this function a clean envelope (the
  // insufficient_credit recovery re-signs before re-probing), so the rails
  // below use it as-is; only the cashu fund factory re-signs with credit
  // fields merged in.
  const plainEnvelope: JobEnvelope = envelope;

  // Resolve rail preferences via the pure `selectRailOrder` so the
  // selector is the single source of truth — both the issue-spec preference
  // and `--rail` / `defaultRail` enforcement live in one place.
  const railFlag = parseForcedRail(opts.rail);
  const config = loadConfig();
  const agentWallet = loadAgentWallet();
  const tempoAccount = await connectedTempoAccount();
  const x402Wallet = loadX402Wallet();
  // providerInfo was already fetched by the warmup probe — reuse it to
  // avoid a redundant round-trip.

  const selection = selectRailOrder({
    flagRail: railFlag,
    defaultRail: config?.defaultRail,
    providerInfo,
    quote: chosen,
    // Cashu still owns its proof-bearing pending-submission journal. A public
    // request id adds the server-side job lookup/acceptance binding around it;
    // it does not replace or absorb that private wallet recovery regime.
    hasAgentWallet: agentWallet !== null,
    hasTempoWallet: tempoAccount !== null,
    hasX402Wallet: x402Wallet !== null,
  });

  if (selection.unsatisfiableFlag) {
    transport.close?.();
    throw new DvmError(
      "rail_unsatisfiable",
      `Cannot pay via --rail ${selection.unsatisfiableFlag.rail}: ${selection.unsatisfiableFlag.reason}`,
      selection.unsatisfiableFlag.hint
    );
  }

  if (selection.rails.length === 0) {
    transport.close?.();
    outputQuotesNoWallet(jobId, quotes, opts, identity);
    return;
  }

  // `--mint` pins a *Cashu* mint, so honour it only via a Cashu rail.
  // If selection lands on a non-Cashu rail (e.g. no local Cashu wallet, or an
  // explicit `--rail tempo`/`--rail x402`), don't silently bill a different
  // rail behind the caller's pin — fail with an actionable error instead.
  if (opts.mint && !selection.rails.some((r) => r === "cashu_p2pk")) {
    transport.close?.();
    throw new DvmError(
      "mint_pin_unsatisfiable",
      `--mint ${opts.mint} pins a Cashu mint, but no Cashu rail is available to honour it (selected: ${selection.rails.join(", ")}).`,
      "Fund a Cashu wallet at the pinned mint (`dvm wallet fund`), or drop --mint to pay via the available rail.",
      {
        anchor: "mint_pin_unsatisfiable",
        display: `Can't pay from mint ${opts.mint} — no Cashu wallet is set up to honour the pin for this job.`,
        pinned_mint: opts.mint,
        available_rails: selection.rails,
      }
    );
  }

  // credit funding is Cashu-only in v1 (Tempo challenges are
  // job-priced; x402 is final-settlement with no resume machinery). When
  // selection put a non-Cashu rail first, the credit plan stands down and
  // the call stays per-call implicit N=1.
  if ((plan.mode === "open" || plan.mode === "topup") && selection.rails[0] !== "cashu_p2pk") {
    info("Credit funding is Cashu-only for now — paying per-call on the selected rail.");
    plan = { mode: "none" };
  }

  // A per-call submit to a recovery-capable provider carries a generated
  // request ID, so a lost or unreadable response stays readable. Every rail
  // below sends the same signed `data`, which keeps the provider's fingerprint
  // for that ID stable across rails and retries.
  let railEnvelope = plainEnvelope;
  let railOpts = opts;
  let railSigning = creditCtx?.signing;
  let generatedRequestId: string | undefined;
  if (
    plan.mode === "none" &&
    railSigning &&
    submitCanCarryGeneratedRequestId({ opts, providerInfo, signing: railSigning })
  ) {
    generatedRequestId = randomUUID();
    railSigning = {
      ...railSigning,
      unsignedData: { ...railSigning.unsignedData, request_id: generatedRequestId },
    };
    railEnvelope = {
      ...plainEnvelope,
      data: signDvmRequestData(railSigning.privkey, railSigning.unsignedData, railSigning.domain),
    };
    railOpts = { ...opts, requestId: generatedRequestId };
    persistRequestIntent({
      requestId: generatedRequestId,
      transport,
      envelope: railEnvelope,
      signing: railSigning,
      endpoint: ref.endpoint,
      identity,
      policy,
      opts: railOpts,
      providerInfo,
    });
  }

  // Set when the Cashu rail soft-fell-through on a balance-related reason
  // (funds present, but not at an accepted mint / not enough). Lets the
  // post-loop code surface an accurate mint-mismatch diagnostic instead of the
  // generic "No wallet connected" when no rail ends up covering the call.
  let cashuFellThroughCode: "no_eligible_mint" | "insufficient_balance" | undefined;

  try {
    for (const rail of selection.rails) {
      if (rail === "cashu_p2pk") {
        const outcome = await tryAgentWalletPayment(
          transport,
          ref,
          railEnvelope,
          jobId,
          deadlineMs,
          chosen,
          railOpts,
          identity,
          policy,
          upfrontBtcRate,
          providerInfo,
          plan,
          railSigning
        );
        if (outcome.handled) return;
        cashuFellThroughCode = outcome.fellThroughCode ?? cashuFellThroughCode;
      } else if (rail === "tempo" && tempoAccount) {
        const handled = await tryTempoPayment({
          transport,
          ref,
          envelope: railEnvelope,
          jobId,
          deadlineMs,
          chosen,
          quotes,
          opts: railOpts,
          identity,
          policy,
          btcRate: upfrontBtcRate,
          account: tempoAccount,
          providerInfo,
          signing: railSigning,
        });
        if (handled) return;
      } else if (rail === "x402" && x402Wallet) {
        const handled = await tryX402UpfrontPayment({
          transport,
          ref,
          envelope: railEnvelope,
          jobId,
          deadlineMs,
          chosen,
          opts: railOpts,
          identity,
          policy,
          btcRate: upfrontBtcRate,
          wallet: x402Wallet,
          providerInfo,
          signing: railSigning,
        });
        if (handled) return;
      }
    }
  } catch (error) {
    // A refusal keeps its own code; only an outcome the provider may have
    // accepted points the caller at the generated ID.
    if (generatedRequestId && leavesOutcomeUnknown(error)) {
      throw requestOutcomeUnknown(generatedRequestId, error);
    }
    throw error;
  }

  // Selector returned a non-empty order but every rail soft-fell-through.
  transport.close?.();
  // The agent wallet is connected and funded but its balance doesn't cover this
  // call at any accepted mint — name the mismatch and hand back a fund action
  // rather than the misleading "No wallet connected".
  if (cashuFellThroughCode && agentWallet) {
    outputQuotesNoEligibleMint(
      jobId,
      quotes,
      opts,
      identity,
      buildNoEligibleMintDetail(cashuFellThroughCode, providerInfo, agentWallet, chosen)
    );
    return;
  }
  outputQuotesNoWallet(jobId, quotes, opts, identity);
}

/**
 * Assemble the {@link NoEligibleMintDetail} that explains a Cashu mint mismatch:
 * the mints the DVM currently accepts, where the caller's spendable balance
 * actually sits, and a fund command pinning an accepted mint. Reserve proofs
 * (builder-locked) are excluded — they aren't part of the free spendable pool,
 * matching `selectProofsForSpend`.
 */
function buildNoEligibleMintDetail(
  code: "no_eligible_mint" | "insufficient_balance",
  providerInfo: ProviderInfo,
  agentWallet: AgentWallet,
  chosen: Quote
): NoEligibleMintDetail {
  const acceptedMints = providerInfo.cashu?.mints ?? [];
  const heldMints = [
    ...groupProofsByMint(
      agentWallet.proofs.filter((p) => p.status === "valid" && p.reserved_for === undefined)
    ),
  ]
    .map(([mint, list]) => ({ mint, sats: list.reduce((sum, p) => sum + p.amount, 0) }))
    .filter((m) => m.sats > 0)
    .sort((a, b) => b.sats - a.sats);
  const heldSats = heldMints.reduce((sum, m) => sum + m.sats, 0);
  const amountSats = Math.ceil(chosen.priceMsats / 1000);
  const fundMint = acceptedMints[0];
  const fundCommand = fundMint
    ? `dvm wallet fund ${amountSats} --mint ${fundMint}`
    : "dvm wallet fund <amount>";
  return { code, acceptedMints, heldMints, heldSats, fundCommand };
}

/**
 * Whether a Lightning float stands ready to carry a credit funding.
 *
 * `loadFloat` throws on an `nwcUri` it can't parse, and this sits on the 402
 * path: a corrupt wallet entry must not fail a job that would otherwise just
 * pay per-call. A float that can't be read is a float that can't fund, so the
 * rail rule hears "no" and the funding goes to ecash or waits. `dvm doctor`
 * and every wallet verb still report the config as broken.
 */
function floatUsable(): boolean {
  try {
    return loadFloat() !== null;
  } catch {
    return false;
  }
}

interface RailAttemptArgs {
  transport: Transport;
  ref: ProviderRef;
  envelope: JobEnvelope;
  jobId: string;
  deadlineMs: number;
  chosen: Quote;
  quotes: Quote[];
  opts: RequestOptions;
  identity: DvmIdentity;
  policy: JobPolicy;
  btcRate: number;
  account: TempoAccount;
  providerInfo: ProviderInfo;
  signing?: RequestSigningContext;
}

/**
 * CLI-authored spend label recorded in the budget ledger for an upfront
 * payment, rendered by `dvm wallet history` (e.g. `narrate · 4,812 chars`).
 * The capability, plus the input size when there is input text. Free to derive
 * — both are already in scope at every upfront `recordSpend` call site.
 */
function buildSpendLabel(capability: string, input: string): string {
  return input.length > 0
    ? `${capability} · ${input.length.toLocaleString("en-US")} chars`
    : capability;
}

function parseMaxCashuFeeSats(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (trimmed === "" || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DvmError(
      "invalid_max_cashu_fee",
      `Invalid --max-cashu-fee-sats value: "${raw}".`,
      "Pass an exact non-negative integer number of sats, e.g. --max-cashu-fee-sats 2."
    );
  }
  return parsed;
}

function validateStrictPerCallOptions(
  opts: RequestOptions,
  maxCashuFeeSats: number | undefined
): void {
  if (!opts.strictPerCall) {
    if (opts.cashuBindingFingerprint !== undefined)
      throw new DvmError(
        "cashu_binding_requires_strict",
        "--cashu-binding-fingerprint is valid only with --strict-per-call.",
        "Use the strict one-payment contract or omit the binding fingerprint."
      );
    return;
  }
  if (!opts.dvm)
    throw new DvmError(
      "strict_per_call_dvm_required",
      "Strict per-call mode requires --dvm with an immutable DVM identifier.",
      "Use the approved <handle>--<slug>/<capability> identifier instead of --endpoint."
    );
  if (opts.rail?.toLowerCase() !== "cashu" || !opts.mint || maxCashuFeeSats === undefined)
    throw new DvmError(
      "strict_per_call_options_required",
      "Strict per-call mode requires --rail cashu, --mint, and --max-cashu-fee-sats.",
      "Pin one accepted mint and explicit service and fee ceilings; strict mode never chooses a fallback."
    );
  if (
    opts.budget === undefined ||
    opts.autoPayBelow === undefined ||
    opts.maxIncrement === undefined ||
    opts.maxPayments !== "1"
  )
    throw new DvmError(
      "strict_per_call_options_required",
      "Strict per-call mode requires explicit --budget, --auto-pay-below, --max-increment, and --max-payments 1.",
      "Use one identical service ceiling for the three amount flags."
    );
  if (!opts.cashuBindingFingerprint || !/^[a-f0-9]{64}$/.test(opts.cashuBindingFingerprint))
    throw new DvmError(
      "strict_per_call_binding_required",
      "Strict per-call mode requires --cashu-binding-fingerprint with a lowercase SHA-256 value.",
      "Freeze the exact DVM id, capability, request body, mint, signer, and policy before approval."
    );
}

function validateCreditOnlyOptions(opts: RequestOptions): void {
  if (opts.creditOnly === undefined) return;
  const containsControlCharacter = Array.from(opts.creditOnly).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  if (!opts.creditOnly || opts.creditOnly.length > 128 || containsControlCharacter)
    throw new DvmError(
      "invalid_credit_only",
      "--credit-only must name one non-empty public credit id of at most 128 characters."
    );
  if (opts.strictPerCall || opts.autoPay === true)
    throw new DvmError(
      "credit_only_payment_conflict",
      "--credit-only cannot be combined with a fresh-payment consent mode.",
      "Omit --auto-pay and --strict-per-call; the selected prepaid balance is the only allowed payment source."
    );
  if (opts.budget === undefined || !opts.requestId)
    throw new DvmError(
      "credit_only_recovery_required",
      "--credit-only requires an explicit --budget and --request-id.",
      "Bind both the service ceiling and authenticated lost-response recovery before submitting the draw."
    );
}

/**
 * Upfront Tempo payment via mppx. Probes the DVM for a fresh
 * `WWW-Authenticate: Payment` challenge, signs it with the locally-held EVM
 * key, retries the POST with `Authorization: Payment <credential>`. Returns
 * true when the rail handled the payment (success or terminating failure).
 * Returns false when the DVM doesn't actually advertise Tempo at probe time —
 * i.e. the selector's `/v1/info` and the live 402 response disagree — or when
 * there is no BTC/USD rate to check the DVM's advertised dollar figure against.
 */
async function tryTempoPayment(args: RailAttemptArgs): Promise<boolean> {
  if (!args.transport.probeMppChallenges) return false;

  const challenges = await args.transport.probeMppChallenges(args.ref, args.envelope);
  assertTempoChallengeNetwork(challenges, tempoAccountNetwork(args.account), ["charge"]);
  const hasTempo = challenges.some((c) => c.method === "tempo" && c.intent === "charge");
  if (!hasTempo) return false;

  // The rate that priced the cap, else a freshly resolved (or last-cached) one.
  // A zero is fine for a display label but useless here: with no rate the caller
  // has no dollar figure of its own, so it cannot tell an honest conversion from
  // an over-charge. x402 answers the same way — skip the rail rather than sign
  // blind.
  const rate = args.btcRate > 0 ? args.btcRate : ((await tryResolveBtcUsdRate())?.rate ?? 0);
  if (rate <= 0) {
    info(
      "Skipping the Tempo rail: it prices in USDC and the BTC/USD rate is unavailable (no cached rate on this machine). Trying the remaining rails."
    );
    return false;
  }

  let credential: MppxCredential | null;
  try {
    credential = await buildTempoCredential({
      challenges,
      privateKey: args.account.privateKey,
      // The accepted quote, restated in the DVM's own unit: this is what every
      // local cap was applied to, so it is what the signed figure is held to.
      basisMicro: msatsToUsdc(args.chosen.priceMsats, rate),
      onError: "throw",
    });
  } catch (err) {
    args.transport.close?.();
    throw err;
  }
  if (!credential) return false;

  // The cross-job ceiling binds to the amount actually signed, which the
  // tolerance allows to sit a little above the quote the first check used.
  // Nothing has moved yet — the credential is only spend authority once the
  // submit below lands — so refusing here strands nothing.
  await enforceGlobalBudget({
    plannedMsats: usdcToMsats(Number(tempoCredentialAmountMicro(credential)) / 1e6, rate),
    btcRate: rate,
  });

  await payWithTempo({ ...args, btcRate: rate }, credential);
  return true;
}

async function payWithTempo(args: RailAttemptArgs, credential: MppxCredential): Promise<void> {
  const { transport, ref, envelope, chosen, opts, identity, policy, account, btcRate } = args;
  const dvmFields = dvmIdentity(identity.dvmId, identity.capability);
  // USDC is dollar-pegged; render the spend in USD/USDC, not sats — sats has
  // no business showing up on a Tempo surface.
  // Every figure below is the one the credential authorizes rather than the
  // quote it answers: `tryTempoPayment` holds the two within a tolerance, and
  // the ledger, the job record and the caller's own display should all name the
  // money that moves. The rate is `tryTempoPayment`'s, always > 0.
  const usdcMicroUnits = Number(tempoCredentialAmountMicro(credential));
  const paidMsats = usdcToMsats(usdcMicroUnits / 1e6, btcRate);
  if (opts.requestId) recordRequestRailPayment(opts.requestId, { method: "tempo", amountMsats: paidMsats });
  const usd = usdcMicroUnits / 1e6;
  const priceLabel = `$${formatUsd(usd)} USDC`;
  const accountShort = `${account.address.slice(0, 6)}…${account.address.slice(-4)}`;

  if (opts.human) {
    info(`Paying ${priceLabel} via Tempo (account ${accountShort})...`);
  } else {
    json({
      ...dvmFields,
      ...requestIdOutputFields(opts.requestId),
      status: "paying",
      rail: "tempo",
      account: account.address,
      price_usd: Math.round(usd * 100) / 100,
      price_usdc_microunits: usdcMicroUnits,
      display: `Paying ${priceLabel} via Tempo (account ${accountShort}).`,
    });
  }

  // the credential is signed and single-use — the money is committed
  // the moment this POST lands. Never abort it on a deadline sliver.
  let receipt;
  try {
    receipt = await transport.submit(
      ref,
      envelope,
      { mppCredential: credential },
      { timeoutMs: paidSubmitTimeoutMs(args.deadlineMs) }
    );
  } catch (err) {
    const unconfirmed = (key: string | undefined) =>
      recordUnconfirmedSpend({
        msats: paidMsats,
        btcRate,
        key,
        endpoint: ref.endpoint,
        capability: identity.capability,
      });
    if (!isIdentityFailure(err)) {
      if (leavesOutcomeUnknown(raisedAfterPayment(err))) {
        unconfirmed(unconfirmedSpendKey(opts, err as DvmError));
      }
      throw err;
    }
    transport.close?.();
    const { error } = recordIdentityFailure(err, {
      endpoint: ref.endpoint,
      ...(identity.dvmId ? { dvmId: identity.dvmId } : {}),
      capability: identity.capability,
      ...(opts.requestId ? { publicRequestId: opts.requestId } : {}),
      rail: "tempo",
      railCorrelation: {
        account: account.address,
        amount_usdc_micro: usdcMicroUnits,
        ...(err.observation.transactionHash
          ? { transaction_hash: err.observation.transactionHash }
          : {}),
      },
    });
    unconfirmed(unconfirmedSpendKey(opts, error));
    throw error;
  }

  const effectiveJobId = args.jobId || receipt.jobId;
  if (!args.jobId && receipt.jobId) {
    saveJob({
      id: effectiveJobId,
      ...transactionRecordFields(receipt),
      endpoint: ref.endpoint,
      dvmId: identity.dvmId,
      feedbackClaim: receipt.feedbackClaim,
      capability: identity.capability,
      requestId: opts.requestId,
      status: "submitted",
      submittedAt: Date.now(),
      policy,
      // persist the anonymous-flow per-job token returned by the
      // paid submit so the follow-up SSE GET carries `X-Job-Token` and the
      // SDK's `isJobOwner` check succeeds.
      jobToken: receipt.jobToken,
      // snapshot the platform trace_id captured from the submit
      // response so `dvm feedback --job <id>` can derive it locally.
      traceId: getOutputTraceId() ?? undefined,
      ...receiptTrustFields(args.providerInfo),
      ...localCorrelationJobFields(normalizedLocalCorrelationId(opts)),
    });
  }

  if (receipt.status === "payment-required") {
    transport.close?.();
    // this is the one wrong-asset surface that fires mid-loop rather
    // than at setup — a caller holding the wrong Tempo dollar signed fine and
    // was rejected here. Name the asset and the swap remedy.
    const network = tempoAccountNetwork(account);
    const chain = resolveTempoNetwork(network);
    let asset: ReturnType<typeof resolveTempoAsset> | null = null;
    try {
      asset = resolveTempoAsset(process.env, network);
    } catch {
      // Keep the payment failure actionable even when the local asset override is invalid.
    }
    throw new DvmError(
      "payment_insufficient",
      "Tempo credential accepted at sign time but rejected at submit.",
      `Verify the Tempo account has at least the quoted amount in ${asset?.label ?? "the rail's settlement token"} on ${tempoNetworkLabel(network)} (chain ${String(chain.chainId)}).${asset ? ` ${tempoWrongAssetHint(asset)}` : ""}`
    );
  }

  recordUpfrontRailPayment(effectiveJobId, { method: "tempo", amountMsats: paidMsats }, true);
  recordSpend({
    msats: paidMsats,
    btcRate: args.btcRate,
    jobId: effectiveJobId,
    providerEndpoint: ref.endpoint,
    label: buildSpendLabel(identity.capability, envelope.input),
  });

  if (receipt.status === "completed" && receipt.summary) {
    markJobTerminal(effectiveJobId, "completed", completionSnapshot(receipt), {
      costMsats: paidMsats,
      paymentMethod: "tempo",
    });
    const captured = captureTransportReceipt(effectiveJobId, receipt);
    await settleCreditAfterJob({
      capture: captured,
      transport,
      ref,
      dvmId: identity.dvmId,
      providerInfo: args.providerInfo,
      signing: args.signing,
      human: opts.human,
    });
    noteFeedbackAfterTerminal({
      jobId: effectiveJobId,
      dvmId: identity.dvmId,
      endpoint: ref.endpoint,
      status: "completed",
      human: opts.human,
    });
    transport.close?.();
    if (opts.human) {
      console.log(receipt.summary);
      const hint = nextStepHint(effectiveJobId, receipt.payloadIn, receipt.artifactCount, true);
      if (hint) info(`📎 ${hint}`);
      renderReceiptHuman(captured);
    } else {
      json({
        jobId: effectiveJobId,
        ...requestIdOutputFields(opts.requestId),
        ...transactionOutputFields(receipt),
        ...dvmFields,
        summary: receipt.summary,
        _provider_fields: ["summary"],
        ...buildCompletionHintFields(effectiveJobId, receipt),
        ...receiptJsonFields(captured),
        paidWith: "tempo",
        account: account.address,
        ...takeCreditNoticeFields(),
        ...takeFeedbackNoticeFields(),
        next_action: null,
      });
    }
    return;
  }

  updateJob(effectiveJobId, {
    status: "processing",
    paymentMethod: "tempo",
  });
  await streamAfterPayment({
    jobId: effectiveJobId,
    transport,
    ref,
    policy,
    chosen: { ...chosen, priceMsats: paidMsats },
    deadlineMs: args.deadlineMs,
    paymentMethod: "tempo",
    paymentFields: {
      paidWith: "tempo",
      account: account.address,
      ...requestIdOutputFields(opts.requestId),
      ...transactionOutputFields(receipt),
    },
    dvmFields,
    paidTimeoutMessage: "Tempo payment sent but timed out waiting for result.",
    human: opts.human,
    dvmId: identity.dvmId,
    providerInfo: args.providerInfo,
    signing: args.signing,
  });
}

/**
 * Outcome of the agent-wallet (Cashu P2PK) rail attempt. `handled` is `true`
 * when the rail terminated the call (paid, or hard-failed with output already
 * emitted); `false` when it soft-fell-through and the caller should try the
 * next rail. `fellThroughCode` is set only on a balance-related fall-through
 * (`no_eligible_mint` / `insufficient_balance`) so the caller can surface an
 * accurate mint-mismatch diagnostic when no rail ends up covering the call.
 */
interface AgentWalletRailOutcome {
  handled: boolean;
  fellThroughCode?: "no_eligible_mint" | "insufficient_balance";
}

function transactionRecordFields(receipt: JobReceipt): { transactionHash?: string } {
  return {
    ...(receipt.transactionHash ? { transactionHash: receipt.transactionHash } : {}),
  };
}

function transactionOutputFields(receipt: JobReceipt): { transaction_hash?: string } {
  return {
    ...(receipt.transactionHash ? { transaction_hash: receipt.transactionHash } : {}),
  };
}

/**
 * Save the local intent `dvm request-result` reads, before any payment. Throws
 * when the envelope is not signed by the caller identity or the ID is taken.
 */
function persistRequestIntent(args: {
  requestId: string;
  transport: Transport;
  envelope: JobEnvelope;
  signing: RequestSigningContext | undefined;
  endpoint: string;
  identity: DvmIdentity;
  policy: JobPolicy;
  opts: RequestOptions;
  providerInfo: ProviderInfo;
}): void {
  const { requestId, transport, signing, opts } = args;
  const unsigned = unsignRequestData(args.envelope.data);
  if (!signing || unsigned?.pubkey !== signing.pubkey) {
    transport.close?.();
    throw new DvmError(
      "request_intent_invalid",
      "Could not persist an authenticated recovery intent.",
      "No payment was attempted. Check the selected caller identity and retry with a fresh request id."
    );
  }
  const body = envelopeToPayload(args.envelope);
  body.data = unsigned.body;
  const maxCashuFeeSats = parseMaxCashuFeeSats(opts.maxCashuFeeSats);
  const saved = saveRequestIntent({
    v: 2,
    requestId,
    endpoint: args.endpoint,
    ...(args.identity.dvmId ? { dvmId: args.identity.dvmId } : {}),
    capability: args.identity.capability,
    body,
    callerPubkey: signing.pubkey,
    policy: args.policy,
    ...(opts.mint ? { pinnedMint: opts.mint } : {}),
    ...(opts.creditOnly ? { creditOnly: opts.creditOnly } : {}),
    ...(opts.strictPerCall ? { strictPerCall: true as const } : {}),
    ...(maxCashuFeeSats !== undefined ? { maxCashuFeeSats } : {}),
    ...receiptTrustFields(args.providerInfo),
    authAudience: signing.domain.audience,
    createdAt: Date.now(),
  });
  if (!saved) {
    transport.close?.();
    throw new DvmError(
      "request_id_exists",
      `Request id ${requestId} already has a local intent.`,
      `Run 'dvm request-result ${requestId}'. Never submit or pay for a replacement under the same id.`,
      { request_id: requestId, status: "unknown" }
    );
  }
}

/**
 * Whether a paid submit may carry a request ID this command generated, so a
 * lost or unreadable response can be read back with `dvm request-result`.
 *
 * The provider binds a request ID, at the first POST that carries it, to a
 * fingerprint of the signed `data`, before it looks at the payment, and refuses
 * different `data` under the same ID with `request_id_exists`. So an ID rides
 * only the final signed `data` of the leg actually sent — the per-call
 * envelope, a fund-and-draw block once its token commitment is known, or a
 * draw-first probe — and never an unpaid probe. Every retry of that leg
 * re-sends the same unsigned `data`; a leg whose `data` must change (a new
 * draw ID, a corrected fund amount) is a different request.
 */
function submitCanCarryGeneratedRequestId(args: {
  opts: RequestOptions;
  providerInfo: ProviderInfo;
  signing: RequestSigningContext | undefined;
}): args is typeof args & { signing: RequestSigningContext } {
  return (
    args.opts.requestId === undefined &&
    args.opts.creditOnly === undefined &&
    args.providerInfo.requestRecovery === true &&
    args.providerInfo.auth?.includes(SIGNED_REQUEST_AUTH_ID) === true &&
    args.signing !== undefined
  );
}

/**
 * Whether a submit's failure leaves the provider possibly holding the request,
 * judged by the error alone: an identity failure, or a transport outcome that
 * never carried a verdict. Used where no payment marker exists, such as the
 * draw-first probe.
 */
function outcomeUnknownAfterSubmit(err: unknown): boolean {
  if (isIdentityFailure(err)) return true;
  return err instanceof DvmError && POST_PAYMENT_UNKNOWN_CODES.has(err.code);
}

/**
 * Errors after which a paid submit's outcome is unknown: the provider may
 * have accepted it. Only these are wrapped for a generated request ID. A
 * refusal keeps its own code, and so does a timeout raised before any payment
 * was presented, such as the Tempo challenge probe's.
 */
function leavesOutcomeUnknown(err: unknown): boolean {
  if (isIdentityFailure(err)) return true;
  return (
    err instanceof DvmError && postPaymentErrors.has(err) && POST_PAYMENT_UNKNOWN_CODES.has(err.code)
  );
}

/**
 * `request_id_exists` is here because a paid retry can meet the claim its own
 * first attempt made: the provider holds that request, and only reading it
 * back by ID says what became of it.
 */
const POST_PAYMENT_UNKNOWN_CODES = new Set(["timeout", "provider_unreachable", "request_id_exists"]);

/** Errors a paid submit raised after its payment was presented. */
const postPaymentErrors = new WeakSet<object>();

function raisedAfterPayment<T>(err: T): T {
  if (err !== null && typeof err === "object") postPaymentErrors.add(err);
  return err;
}

/**
 * Count a paid submit whose outcome is unknown against the budget. The payment
 * may have landed, and a ledger that skipped it would let later calls spend
 * past the caps. Keyed on the request's public ID, else the evidence record's
 * ambiguity ID, so recording the same request twice is a no-op.
 */
function recordUnconfirmedSpend(args: {
  msats: number;
  btcRate: number;
  key: string | undefined;
  endpoint: string;
  capability: string;
}): void {
  recordSpendOnce({
    msats: args.msats,
    btcRate: args.btcRate,
    jobId: args.key ?? `unconfirmed-${randomUUID()}`,
    providerEndpoint: args.endpoint,
    label: `unconfirmed · ${args.capability}`,
  });
}

function unconfirmedSpendKey(opts: RequestOptions, err: DvmError): string | undefined {
  if (opts.requestId) return opts.requestId;
  return typeof err.data?.ambiguity_id === "string" ? err.data.ambiguity_id : undefined;
}

/** Rail evidence for a probe, from the credit fields its signed body carries. */
function probeRailEvidence(
  env: JobEnvelope
): Pick<SubmissionEvidenceInput, "rail" | "railCorrelation"> {
  const body = unsignRequestData(env.data)?.body;
  const creditId = typeof body?.credit_id === "string" ? body.credit_id : undefined;
  const drawId = typeof body?.draw_id === "string" ? body.draw_id : undefined;
  if (!creditId) return { rail: "none" };
  return {
    rail: "credit",
    railCorrelation: { credit_id: creditId, ...(drawId ? { draw_id: drawId } : {}) },
  };
}

/** The public request ID a signed envelope carries, if any. */
function envelopeRequestId(env: JobEnvelope): string | undefined {
  const requestId = unsignRequestData(env.data)?.body?.request_id;
  return typeof requestId === "string" ? requestId : undefined;
}

function requestIdOutputFields(requestId: string | undefined): { request_id?: string } {
  return requestId ? { request_id: requestId } : {};
}

function normalizedLocalCorrelationId(opts: RequestOptions): string | undefined {
  return opts.localCorrelationId === undefined
    ? undefined
    : normalizeLocalCorrelationId(opts.localCorrelationId);
}

function requestOutcomeUnknown(requestId: string, cause: unknown): DvmError {
  const ambiguityId =
    isIdentityFailure(cause) && typeof cause.data?.ambiguity_id === "string"
      ? cause.data.ambiguity_id
      : undefined;
  return new DvmError(
    "request_outcome_unknown",
    `The provider did not return a definitive result for request ${requestId}.`,
    `Run 'dvm request-result ${requestId}'. This lookup cannot submit a job or repeat a payment.${ambiguityId ? ` Do not pay for this request again; 'dvm wallet submissions' shows the recorded evidence (${ambiguityId}).` : ""}`,
    {
      request_id: requestId,
      status: "unknown",
      cause: cause instanceof Error ? cause.message : String(cause),
      ...(cause instanceof DvmError ? { inner_code: cause.code } : {}),
      ...(isIdentityFailure(cause)
        ? {
            identity_kind: cause.observation.kind,
            ...identityDataFields(cause.observation),
            ...(ambiguityId ? { ambiguity_id: ambiguityId } : {}),
            ...(typeof cause.data?.cashu_request_id === "string"
              ? { cashu_request_id: cause.data.cashu_request_id }
              : {}),
            claim_stored: false,
          }
        : {}),
      // A Cashu payment already sent is held in the wallet journal under its
      // own request ID; keep that context rather than letting the public ID
      // replace it.
      ...(cause instanceof DvmError && cause.data?.spend_committed === true
        ? {
            spend_committed: true,
            ...(typeof cause.data.cashu_request_id === "string"
              ? { cashu_request_id: cause.data.cashu_request_id }
              : {}),
            ...(typeof cause.data.mint === "string" ? { mint: cause.data.mint } : {}),
            ...(typeof cause.data.amount_sats === "number"
              ? { amount_sats: cause.data.amount_sats }
              : {}),
            ...(typeof cause.data.display === "string" ? { display: cause.data.display } : {}),
          }
        : {}),
    }
  );
}

/**
 * Agent-wallet auto-spend gate. Returns `{ handled: true }` when the
 * spend was attempted (success or hard failure that already terminated output);
 * `{ handled: false }` when the path doesn't apply and the caller should fall
 * through to the next rail (tempo / Lightning).
 *
 * Soft fall-through reasons (`handled: false`):
 *   - no `~/.dvm/wallet.json` (user hasn't opted into the agent wallet)
 *   - DVM doesn't advertise `cashu` in /v1/info
 *   - selection failed with `no_eligible_mint` or `insufficient_balance`
 *     (surfaced via `fellThroughCode` so the caller can explain the mismatch)
 *
 * Hard failures (throw + exit non-zero):
 *   - mint `/v1/swap` rejected the swap (`swap_failed` — inputs are
 *     left `in_flight` and recovered after the in-flight timeout)
 *   - DVM advertised a `lock_pubkey` that doesn't match the wallet
 *   - DVM responded with payment_invalid / payment_insufficient on
 *     submit (proofs are reverted to spendable)
 */
async function tryAgentWalletPayment(
  transport: Transport,
  ref: ProviderRef,
  envelope: JobEnvelope,
  jobId: string,
  deadlineMs: number,
  chosen: Quote,
  opts: RequestOptions,
  identity: DvmIdentity,
  policy: JobPolicy,
  btcRate: number,
  providerInfo: ProviderInfo,
  plan: CreditPlan = { mode: "none" },
  signing?: RequestSigningContext
): Promise<AgentWalletRailOutcome> {
  if (!loadAgentWallet()) {
    if (opts.strictPerCall)
      throw new DvmError(
        "strict_per_call_unsafe",
        "Strict Cashu per-call mode requires an initialized agent wallet.",
        "Initialize and fund the pinned mint, then rebuild and re-approve the request."
      );
    return { handled: false };
  }

  // Drain any pending_submissions left by previous crashes. DVMs are
  // idempotent on (dvm_id, request_id); a successful re-ship clears the
  // entry. Best-effort — failures are kept on disk for the next sweep.
  if (!opts.strictPerCall)
    await sweepPendingSubmissions({ fetchImpl: dvmFetch }).catch(() => undefined);

  const lockPubkey = providerInfo.cashu?.lock_pubkeys[0];
  let mints = providerInfo.cashu?.mints;
  if (!lockPubkey || !mints || mints.length === 0) {
    if (opts.strictPerCall)
      throw new DvmError(
        "strict_per_call_unsafe",
        "The live DVM does not expose a complete Cashu per-call offer.",
        "Do not fall back to another rail; rebuild the approved plan from a complete descriptor."
      );
    return { handled: false };
  }

  // restrict the spend to the caller-pinned mint. Already validated
  // in `handleAutoPayQuotes`; this narrows to the matched canonical entry.
  if (opts.mint) mints = applyMintPin(mints, opts.mint);

  // a fund plan without the signing context or the server-matched
  // wire amount can't build the signed fund block — stand down to per-call
  // (shouldn't happen; belt only).
  let fundPlan =
    (plan.mode === "open" || plan.mode === "topup") && signing && plan.wireAmountMicro !== undefined
      ? plan
      : undefined;
  const priceSats = Math.ceil(chosen.priceMsats / 1000);
  const maxCashuFeeSats = parseMaxCashuFeeSats(opts.maxCashuFeeSats);
  const baseContext = {
    upfront_rail_payment: { method: "cashu" as const, amountMsats: chosen.priceMsats },
    dvm_id: identity.dvmId,
    capability: identity.capability,
    pinned_mint: opts.mint,
    policy,
    ...(signing ? { auth_domain: signing.domain } : {}),
    ...(providerInfo.builder ? { builder: providerInfo.builder } : {}),
    ...(maxCashuFeeSats !== undefined ? { max_cashu_fee_sats: maxCashuFeeSats } : {}),
    ...(opts.strictPerCall
      ? {
          strict_per_call: true as const,
          binding_fingerprint: opts.cashuBindingFingerprint,
        }
      : {}),
  };
  let builderHandle: string | undefined;
  if (!opts.strictPerCall)
    try {
      builderHandle = new URL(ref.endpoint).hostname.toLowerCase();
    } catch {
      builderHandle = undefined;
    }
  const spendStartedMs = Date.now();

  // The fund-and-draw signing inversion: the signed body embeds a
  // commitment over the token, and the token doesn't exist until the wallet
  // swap runs. Persist the unsigned body first; the wallet binds its token
  // hash after a normal swap or NUT-09 recovery, and the live request is signed
  // once `prepareAgentSpend` returns.
  //
  // A fund leg to a recovery-capable provider gets its generated request ID
  // here, before the journal context is written: the sweep re-signs that
  // context, so the ID must sit in it beside the credit and fund fields for a
  // re-ship to reproduce the provider's fingerprint. The per-call envelope
  // handed in already carries its own ID when one applies.
  const generatedRequestId =
    fundPlan && submitCanCarryGeneratedRequestId({ opts, providerInfo, signing })
      ? randomUUID()
      : undefined;
  const withGeneratedRequestId = (unsigned: Record<string, unknown>) =>
    generatedRequestId ? { ...unsigned, request_id: generatedRequestId } : unsigned;
  // The per-call envelope this leg falls back to when the wallet cannot cover
  // the funding. The ID minted above has not been sent, so it is reused.
  const perCallEnvelope: JobEnvelope =
    generatedRequestId && signing
      ? {
          ...envelope,
          data: signDvmRequestData(
            signing.privkey,
            withGeneratedRequestId(signing.unsignedData),
            signing.domain
          ),
        }
      : envelope;
  let finalEnvelope = perCallEnvelope;
  const buildPrepareArgs = () => {
    // Const snapshot pinned to the plan active when this prepare began.
    const activeFund = fundPlan;
    const fundData =
      activeFund && signing
        ? withGeneratedRequestId({
            ...signing.unsignedData,
            credit_id: activeFund.creditId,
            draw_id: activeFund.drawId,
            fund: {
              amount_micro: activeFund.wireAmountMicro ?? activeFund.fundMicro,
              commitment: "",
            },
          })
        : null;
    const payload = envelopeToPayload(envelope);
    return {
      amountSats: activeFund ? activeFund.fundSats : priceSats,
      endpoint: ref.endpoint,
      ...(maxCashuFeeSats !== undefined ? { maxCashuFeeSats } : {}),
      ...(opts.strictPerCall ? { mode: "strict_per_call" as const } : {}),
      cashuP2pk: {
        mints,
        lock_pubkey: lockPubkey,
        // names the per-DVM refund subkey the outputs' NUT-11
        // `refund` tag carries, and the locktime floor the DVM asked for.
        canonical_id: providerInfo.cashu?.canonical_id,
        min_locktime: providerInfo.cashu?.min_locktime,
      },
      ...(builderHandle ? { builderHandle } : {}),
      // persist what a resume needs to re-POST this exact call. The
      // sweep can then re-ship a real submit and write a `JobRecord` from the
      // job id it gets back, instead of stranding the spend with no handle.
      submitContext:
        activeFund && signing && fundData
          ? {
              submit_body: { ...payload, data: fundData },
              signing_pubkey: signing.pubkey,
              ...baseContext,
            }
          : { ...resumableSubmitBody(perCallEnvelope, providerInfo), ...baseContext },
    };
  };

  let prepared = await prepareAgentSpend(buildPrepareArgs());

  // Buffer semantics: a wallet that can't cover the credit funding but could
  // cover the job must not lose the job to the buffer — degrade to per-call
  // and prepare once more at the job price.
  if (
    "error" in prepared &&
    fundPlan &&
    prepared.error.code === "insufficient_balance" &&
    fundPlan.fundSats > priceSats
  ) {
    info("Wallet balance can't cover the credit funding — paying this job per-call.");
    fundPlan = undefined;
    finalEnvelope = perCallEnvelope;
    prepared = await prepareAgentSpend(buildPrepareArgs());
  }

  if ("error" in prepared) {
    if (
      !opts.mint &&
      (prepared.error.code === "no_eligible_mint" || prepared.error.code === "insufficient_balance")
    ) {
      // Soft fall-through to the next rail. Suppressed when a mint is pinned
      // — restrict semantics mean a shortfall at the pinned mint is a
      // hard error, no fallback. The code rides along so that if no rail covers
      // the call, the caller can name the mint mismatch instead of "no wallet".
      return { handled: false, fellThroughCode: prepared.error.code };
    }
    transport.close?.();
    throw new DvmError(
      prepared.error.code,
      prepared.error.message,
      prepared.error.hint,
      // name every mint the spend tried and why, so an agent reading
      // the JSON error can tell "all my mints are down" from "this one is".
      prepared.error.attempts ? { mint_attempts: prepared.error.attempts } : undefined
    );
  }

  if (opts.strictPerCall && !prepared.submissionBindingFingerprint) {
    transport.close?.();
    throw new DvmError(
      "strict_per_call_unsafe",
      "The strict Cashu payment was not durably bound to its exact request.",
      "Do not submit or recover this payment."
    );
  }

  if (fundPlan && signing) {
    finalEnvelope = {
      ...envelope,
      data: signDvmRequestData(
        signing.privkey,
        withGeneratedRequestId({
          ...signing.unsignedData,
          credit_id: fundPlan.creditId,
          draw_id: fundPlan.drawId,
          fund: {
            amount_micro: fundPlan.wireAmountMicro ?? fundPlan.fundMicro,
            commitment: sha256Hex(prepared.cashuToken),
          },
        }),
        signing.domain
      ),
    };
  }
  // Persisted against the exact `data` about to go on the wire, so a later
  // `request-result` reproduces the fingerprint the provider binds.
  if (generatedRequestId) {
    persistRequestIntent({
      requestId: generatedRequestId,
      transport,
      envelope: finalEnvelope,
      signing,
      endpoint: ref.endpoint,
      identity,
      policy,
      opts,
      providerInfo,
    });
  }

  const pricedRequestId = opts.requestId ?? generatedRequestId;
  if (pricedRequestId) recordRequestRailPayment(pricedRequestId, { method: "cashu", amountMsats: chosen.priceMsats });

  // The fund leg is on its way — record the credit locally as provisional so
  // the countersigned receipt (or a later balance op) can adopt the server's
  // figures. Done before the submit: a crash-resumed ship still funds it.
  if (fundPlan && signing) {
    ensureProvisionalCredit({
      endpoint: ref.endpoint,
      ...identityArgs(providerDvmIdentity(providerInfo)),
      callerPubkey: signing.pubkey,
      creditId: fundPlan.creditId,
      currency: fundPlan.currency,
      targetMicro: fundPlan.targetMicro,
      menu: chosen.credit,
    });
    // an automatic purchase names its amount, its funding route and
    // its reason. The reason comes from which branch of `planCreditForQuote`
    // produced this plan — `open` because nothing was open here, `topup`
    // because the stored balance came up short for *this* job — and not from
    // any guess about how many jobs the caller has run. This leg is always
    // ecash: a plan that rides the job request can only be Cashu, because a
    // bolt11 has no header to hang on — a sizing the float should
    // carry left as a `deferred` funding above and never became a `fundPlan`.
    // So `railReason` here is always a reason the float was *not* used.
    // Narrated `in_flight` because the paid submit below can still fail.
    noteCreditFunding(
      buildCreditFundingReport({
        dvm: identity.dvmId ?? ref.endpoint,
        endpoint: ref.endpoint,
        reason: fundPlan.mode === "open" ? "no_credit_open" : "short_for_job",
        amountMicro: fundPlan.fundMicro,
        currency: fundPlan.currency,
        route: "cashu",
        ...(fundPlan.railReason ? { routeReason: fundPlan.railReason } : {}),
        ...(chosen.credit?.lightning_min_micro !== undefined
          ? { lightningMinMicro: chosen.credit.lightning_min_micro }
          : {}),
      }),
      opts.human,
      "in_flight"
    );
  }

  // the Cashu swap is a mint round-trip, not provider work — against
  // a cold mint it can run 20s+. Charging it to `--timeout` left the paid POST
  // a sliver of the budget and `AbortSignal.timeout` guillotined it moments
  // after the proofs were spent: wallet debited, no job, no result. Hand the
  // spend's elapsed time back to the job clock.
  const paidDeadlineMs = deadlineMs + (Date.now() - spendStartedMs);

  await payWithAgentWallet(
    transport,
    ref,
    finalEnvelope,
    jobId,
    paidDeadlineMs,
    chosen,
    prepared,
    opts,
    identity,
    policy,
    providerInfo,
    btcRate,
    fundPlan,
    signing,
    generatedRequestId
  );
  return { handled: true };
}

/**
 * Minimum window a submit that has already spent money gets, no matter what's
 * left of the caller's deadline. Aborting a paid POST is uniquely
 * destructive — the proofs are gone at the mint and the caller has nothing to
 * show for them — so a short `--timeout` may bound how long we wait for the
 * *result*, but never how long we wait to find out whether the DVM took the
 * payment.
 */
export const PAID_SUBMIT_FLOOR_MS = 30_000;

/** Deadline-derived timeout for a submit whose payment leg has committed. */
function paidSubmitTimeoutMs(deadlineMs: number): number {
  return Math.max(deadlineMs - Date.now(), PAID_SUBMIT_FLOOR_MS);
}

/**
 * The part of a `pending_submission`'s context that describes the call itself
 * *
 * Against a descriptor-auth DVM the wire body's `data` is a signed envelope
 * whose `timestamp` the DVM rejects once it drifts past ~5 minutes — before it
 * looks at the payment — so persisting it verbatim would give the resume a body
 * that can only 401. Store the unsigned body and the pubkey that signed it
 * instead; the sweep re-signs on each attempt. Payment idempotency keys on
 * `(dvm_id, request_id)`, not on the signature nonce, so a fresh envelope
 * replays safely.
 */
function resumableSubmitBody(
  envelope: JobEnvelope,
  providerInfo: ProviderInfo
): { submit_body: Record<string, unknown>; signing_pubkey?: string } {
  const payload = envelopeToPayload(envelope);
  if (!providerInfo.auth?.includes(SIGNED_REQUEST_AUTH_ID)) return { submit_body: payload };

  const signed = unsignRequestData(payload.data as Record<string, unknown> | undefined);
  if (!signed) return { submit_body: payload };
  return { submit_body: { ...payload, data: signed.body }, signing_pubkey: signed.pubkey };
}

/**
 * Annotate a paid-submit failure with the fact that the sats have already left
 * the wallet and is held against a request the DVM may yet accept.
 * `payment_invalid` is excluded: there the entry is
 * abandoned and no spend is outstanding.
 */
function withSpentSpendContext(
  err: unknown,
  prepared: PreparedAgentSpend,
  publicRequestId?: string
): unknown {
  if (!(err instanceof DvmError) || err.code === "payment_invalid") return err;
  const held = `${prepared.totalSats} sats`;
  const proseSources = {
    ...(err.proseSources?.message === "provider" ? { message: "provider" as const } : {}),
    ...(err.proseSources?.hint === "provider" ? { hint: "provider" as const } : {}),
  };
  // `request_id` is the ID the provider knows the request by, which is what
  // `dvm request-result` takes; the wallet journal holds the payment under
  // its own `cashu_request_id`.
  const requestId = publicRequestId ?? prepared.requestId;
  return raisedAfterPayment(
    new DvmError(
      err.code,
      `${err.message} The ${held} payment was already sent — it is held against request ${requestId}, not lost.`,
      err.hint,
      {
        ...err.data,
        spend_committed: true,
        request_id: requestId,
        cashu_request_id: prepared.requestId,
        endpoint: prepared.endpoint,
        mint: prepared.mint,
        amount_sats: prepared.totalSats,
        display: publicRequestId
          ? `Your wallet paid ${held} but the provider never confirmed. Your next call reads request ${publicRequestId} back from the provider without paying again — check 'dvm wallet show'.`
          : `Your wallet paid ${held} but the provider never confirmed. The payment is held against this request and will be retried automatically on your next call — check 'dvm wallet show'.`,
      },
      undefined,
      Object.keys(proseSources).length > 0 ? proseSources : undefined
    )
  );
}

/**
 * The server's own valuation of an attached funding token, off a
 * `funding_commitment_mismatch` refusal. Undefined for any other
 * error, and for the two refusals no re-sign can fix — a valuation the server
 * didn't state, and one it stated but we can't sign. See
 * {@link readFundValuation} for the structured-field-then-message ladder.
 */
function expectedFundMicro(err: unknown): number | undefined {
  if (!(err instanceof DvmError) || err.code !== "funding_commitment_mismatch") return undefined;
  const valuation = readFundValuation({
    expectedMicro: err.data?.expected_micro,
    message: err.message,
  });
  return valuation.kind === "figure" ? valuation.micro : undefined;
}

async function submitAgentWalletWithRetry(
  transport: Transport,
  ref: ProviderRef,
  envelope: JobEnvelope,
  prepared: PreparedAgentSpend,
  deadlineMs: number,
  opts: {
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<Awaited<ReturnType<Transport["submit"]>>> {
  return withAgentWalletPaymentRetry({
    attempt: () =>
      transport.submit(
        ref,
        envelope,
        {
          cashuToken: prepared.cashuToken,
          cashuRequestId: prepared.requestId,
        },
        { timeoutMs: paidSubmitTimeoutMs(deadlineMs) }
      ),
    intendedLockPubkey: prepared.intendedLockPubkey,
    refetchInfo: () => transport.describe(ref),
    sleep: opts.sleep,
    // one retry on a timeout/network failure, because the money has
    // already left. Idempotent by construction — the DVM keys the accumulator
    // on `(dvm_id, request_id)`, so a duplicate is a 409, never a second charge
    // or a second run of the job.
    retryTransportFailureOnce: true,
  });
}

async function payWithAgentWallet(
  transport: Transport,
  ref: ProviderRef,
  envelope: JobEnvelope,
  jobId: string,
  deadlineMs: number,
  chosen: Quote,
  prepared: PreparedAgentSpend,
  opts: RequestOptions,
  identity: DvmIdentity,
  policy: JobPolicy,
  providerInfo: ProviderInfo,
  btcRate = 0,
  fundPlan?: Extract<CreditPlan, { mode: "open" | "topup" }>,
  signing?: RequestSigningContext,
  generatedRequestId?: string
): Promise<void> {
  const dvmFields = dvmIdentity(identity.dvmId, identity.capability);
  // The ID the provider knows this request by. Dropped when a corrected fund
  // block is sent: the refused POST bound the generated ID to the data it
  // refused, and the correction is a different request.
  let publicRequestId = opts.requestId ?? generatedRequestId;
  // Anchor off, as on `dvm pay`'s twin of this line: the caller already
  // approved this charge, so "fraction of a cent" here is noise.
  info(
    `Paying ${quoteAmountLabel(chosen, { anchor: false })} via agent wallet (Cashu P2PK, mint: ${prepared.mint})...`
  );

  let receipt;
  let activeEnvelope = envelope;
  let correctedOnce = false;
  for (;;) {
    try {
      receipt = await submitAgentWalletWithRetry(
        transport,
        ref,
        activeEnvelope,
        prepared,
        deadlineMs
      );
      break;
    } catch (err) {
      // Accepted without a settled job identity: the spend may have landed, so
      // the entry is marked terminal rather than abandoned or left to resume.
      if (isIdentityFailure(err)) {
        transport.close?.();
        const { error, record } = recordIdentityFailure(err, {
          endpoint: ref.endpoint,
          ...(identity.dvmId ? { dvmId: identity.dvmId } : {}),
          capability: identity.capability,
          ...(publicRequestId ? { publicRequestId } : {}),
          cashuRequestId: prepared.requestId,
          rail: "cashu",
          railCorrelation: {
            mint: prepared.mint,
            amount_sats: prepared.totalSats,
            ...(fundPlan ? { credit_id: fundPlan.creditId, draw_id: fundPlan.drawId } : {}),
          },
        });
        if (record) {
          await markPendingSubmissionUnresolved({
            requestId: prepared.requestId,
            marker: journalMarkerFor(record),
          });
        }
        if (generatedRequestId && publicRequestId) {
          throw requestOutcomeUnknown(publicRequestId, error);
        }
        throw error;
      }
      // the server valued the attached token differently than we
      // did (its fiat price isn't always exactly reproducible from the wire —
      // fx rotation, or an msats-priced DVM whose quote rounds the fiat).
      // The refusal happens BEFORE any rail commit and states the server's
      // own valuation, so ONE re-sign of the SAME token with that figure
      // recovers the spend instead of stranding it.
      const signedMicro = fundPlan ? (fundPlan.wireAmountMicro ?? fundPlan.fundMicro) : undefined;
      const expected = !correctedOnce && fundPlan && signing ? expectedFundMicro(err) : undefined;
      // A server that refuses while stating back the figure we already signed
      // is disagreeing for a reason it isn't saying; re-shipping a byte-identical
      // fund block could only be refused again.
      if (expected !== undefined && expected !== signedMicro && fundPlan && signing) {
        correctedOnce = true;
        info(
          `Provider valued the funding at ${String(expected)} micro-units (we signed ${String(signedMicro)}) — re-signing with its figure.`
        );
        // Persist the corrected figure into the resumable context BEFORE
        // retrying: if this retry dies transiently, the sweep must re-sign
        // the server's valuation, not re-ship the one it already refused —
        // which would strand the funded spend as a permanent refusal.
        await correctPendingFundAmount({
          requestId: prepared.requestId,
          amountMicro: expected,
        });
        if (generatedRequestId) publicRequestId = undefined;
        activeEnvelope = {
          ...envelope,
          data: signDvmRequestData(
            signing.privkey,
            {
              ...signing.unsignedData,
              credit_id: fundPlan.creditId,
              draw_id: fundPlan.drawId,
              fund: { amount_micro: expected, commitment: sha256Hex(prepared.cashuToken) },
            },
            signing.domain
          ),
        };
        continue;
      }
      // The output proofs are SPENT at the mint (locked to the DVM's pubkey).
      // What happens to the pending_submission depends on the failure mode:
      //   - payment_invalid: DVM rejected the spend permanently — abandon
      //     the entry (operator can manually recover from the wallet file).
      //   - payment_lock_pubkey_stale: DVM has rotated past our lock target;
      //     the next sweep can't recover via /v1/info refetch either. We
      //     keep the entry so `dvm wallet show` can surface the dead capital
      //     for manual recovery — see error hint at the throw site.
      //   - everything else (5xx, network, exhausted transient-payment retries):
      //     leave the entry on disk so the next sweep can re-ship.
      if (!opts.strictPerCall && err instanceof DvmError && err.code === "payment_invalid") {
        await abandonPendingSubmission({ requestId: prepared.requestId });
      }
      transport.close?.();
      const spent = withSpentSpendContext(err, prepared, publicRequestId);
      // A refusal keeps its own code; only an outcome the provider may have
      // accepted points the caller at the generated ID.
      if (generatedRequestId && publicRequestId && leavesOutcomeUnknown(spent)) {
        throw requestOutcomeUnknown(publicRequestId, spent);
      }
      throw spent;
    }
  }

  if (receipt.status === "payment-required") {
    if (!opts.strictPerCall) await abandonPendingSubmission({ requestId: prepared.requestId });
    transport.close?.();
    throw new DvmError(
      "payment_insufficient",
      "Agent-wallet payment was not accepted by the provider.",
      "Check the DVM's quote — the spend may have undershot the required amount."
    );
  }

  if (fundPlan && signing && receipt.credit) {
    const fundingReceiptStatus = captureFundingReceipt({
      receipt: receipt.fundingReceipt,
      parseError: receipt.fundingReceiptParseError,
      endpoint: ref.endpoint,
      builder: providerInfo.builder,
      expectedCreditId: fundPlan.creditId,
      expectedFundId: prepared.requestId,
      expectedFundedMicro: receipt.fundedMicro,
      expectedBalanceAfterMicro: receipt.credit.remaining_micro,
      expectedLedgerSeq: receipt.credit.ledger_seq,
      expectedCallerPubkey: signing.pubkey,
    });
    if (fundingReceiptStatus === "verified" || fundingReceiptStatus === "verified_unattested") {
      recordFundResponse({
        endpoint: ref.endpoint,
        ...identityArgs(providerDvmIdentity(providerInfo)),
        callerPubkey: signing.pubkey,
        credit: receipt.credit,
        targetMicro: fundPlan.targetMicro,
        menu: chosen.credit,
        rail: "cashu",
        builderPubkey: providerInfo.builder?.pubkey,
        select: true,
      });
    }
  }

  const effectiveJobId = jobId || receipt.jobId;
  if (!jobId && receipt.jobId) {
    saveJob({
      id: effectiveJobId,
      ...transactionRecordFields(receipt),
      endpoint: ref.endpoint,
      dvmId: identity.dvmId,
      feedbackClaim: receipt.feedbackClaim,
      capability: identity.capability,
      requestId: publicRequestId,
      ...(fundPlan && signing ? { creditBinding: {
        creditId: fundPlan.creditId, drawId: fundPlan.drawId, callerPubkey: signing.pubkey,
      } } : {}),
      status: "submitted",
      submittedAt: Date.now(),
      policy,
      pinnedMint: opts.mint,
      ...(opts.strictPerCall ? { strictPerCall: true as const } : {}),
      ...(opts.maxCashuFeeSats !== undefined
        ? { maxCashuFeeSats: parseMaxCashuFeeSats(opts.maxCashuFeeSats) }
        : {}),
      // the paid submit returns the per-job token for anonymous callers.
      // Without persisting it here, the immediately-following SSE GET goes out
      // without `X-Job-Token`, the SDK's `isJobOwner` check fails, and the
      // caller sees `provider_error: stream failed (404)` despite the server
      // running the job to completion and billing it.
      jobToken: receipt.jobToken,
      // snapshot the platform trace_id captured from the submit
      // response so `dvm feedback --job <id>` can derive it locally.
      traceId: getOutputTraceId() ?? undefined,
      ...receiptTrustFields(providerInfo),
      ...localCorrelationJobFields(normalizedLocalCorrelationId(opts)),
    });
  }

  // Spend successful — clear the pending_submission and record the spend
  // in the recent-spends ring buffer.
  await commitAgentSpend({
    requestId: prepared.requestId,
    recentSpend: {
      request_id: prepared.requestId,
      dvm_endpoint: ref.endpoint,
      mint: prepared.mint,
      amount_sats: prepared.totalSats,
      signed_at_ms: Date.now(),
    },
  });

  await collectCashuChange(effectiveJobId, receipt.cashuChange);

  recordUpfrontRailPayment(effectiveJobId, { method: "cashu", amountMsats: chosen.priceMsats }, true);
  if (fundPlan) {
    // The funding is the spend (spec §10): the caps were charged with the
    // full funding, and the job's draw is consumption of it — visible via the
    // countersigned receipt in `dvm wallet history`, never double-counted.
    recordSpend({
      msats: fundPlan.fundMsats,
      btcRate,
      kind: "credit_fund",
      jobId: effectiveJobId,
      providerEndpoint: ref.endpoint,
      label: `credit fund · ${identity.dvmId ?? identity.capability}`,
    });
  } else {
    recordSpend({
      msats: chosen.priceMsats,
      btcRate,
      jobId: effectiveJobId,
      providerEndpoint: ref.endpoint,
      label: buildSpendLabel(identity.capability, envelope.input),
    });
  }

  if (receipt.status === "completed" && receipt.summary) {
    markJobTerminal(effectiveJobId, "completed", completionSnapshot(receipt), {
      costMsats: chosen.priceMsats,
      paymentMethod: "cashu",
    });
    const captured = captureTransportReceipt(effectiveJobId, receipt);
    if (!opts.strictPerCall)
      await settleCreditAfterJob({
        capture: captured,
        transport,
        ref,
        dvmId: identity.dvmId,
        providerInfo,
        signing,
        human: opts.human,
      });
    noteFeedbackAfterTerminal({
      jobId: effectiveJobId,
      dvmId: identity.dvmId,
      endpoint: ref.endpoint,
      status: "completed",
      human: opts.human,
    });
    transport.close?.();
    if (opts.human) {
      console.log(receipt.summary);
      const hint = nextStepHint(effectiveJobId, receipt.payloadIn, receipt.artifactCount, true);
      if (hint) info(`📎 ${hint}`);
      renderReceiptHuman(captured);
    } else {
      json({
        jobId: effectiveJobId,
        ...dvmFields,
        summary: receipt.summary,
        _provider_fields: ["summary"],
        ...buildCompletionHintFields(effectiveJobId, receipt),
        ...receiptJsonFields(captured),
        paidWith: "cashu_p2pk",
        mint: prepared.mint,
        amountSats: prepared.totalSats,
        requestId: prepared.requestId,
        ...(prepared.attempts?.length ? { mint_attempts: prepared.attempts } : {}),
        ...(prepared.submissionBindingFingerprint
          ? { submissionBindingFingerprint: prepared.submissionBindingFingerprint }
          : {}),
        ...takeCreditNoticeFields(),
        ...takeFeedbackNoticeFields(),
        next_action: null,
      });
    }
    return;
  }

  updateJob(effectiveJobId, {
    status: "processing",
    paymentMethod: "cashu",
  });
  await streamAfterPayment({
    jobId: effectiveJobId,
    transport,
    ref,
    policy,
    chosen,
    deadlineMs,
    paymentMethod: "cashu",
    paymentFields: {
      paidWith: "cashu_p2pk",
      mint: prepared.mint,
      amountSats: prepared.totalSats,
      requestId: prepared.requestId,
      ...(prepared.attempts?.length ? { mint_attempts: prepared.attempts } : {}),
      ...(prepared.submissionBindingFingerprint
        ? { submissionBindingFingerprint: prepared.submissionBindingFingerprint }
        : {}),
    },
    dvmFields,
    paidTimeoutMessage: "Agent-wallet payment sent but timed out waiting for result.",
    human: opts.human,
    dvmId: identity.dvmId,
    providerInfo,
    signing,
    strictPerCall: opts.strictPerCall,
  });
}

/**
 * Inputs to {@link tryX402UpfrontPayment}, packed to keep the dispatch tidy.
 * Mirrors {@link RailAttemptArgs} for the Tempo path.
 */
interface X402AttemptArgs {
  transport: Transport;
  ref: ProviderRef;
  envelope: JobEnvelope;
  jobId: string;
  deadlineMs: number;
  chosen: Quote;
  opts: RequestOptions;
  identity: DvmIdentity;
  policy: JobPolicy;
  btcRate: number;
  wallet: X402Wallet;
  providerInfo: ProviderInfo;
  signing?: RequestSigningContext;
}

/**
 * Upfront x402 payment. Signs an EIP-3009 `TransferWithAuthorization`
 * for the chosen quote's USDC equivalent, attaches it as the x402 `X-PAYMENT`
 * header on the retry POST. Returns true when the rail handled the payment
 * (success or terminating failure). Returns false only when the DVM doesn't
 * actually advertise x402 at probe time (selector and live state disagree)
 * or when the local wallet can't construct a payload for the requested
 * `(network, asset)` pair.
 */
async function tryX402UpfrontPayment(args: X402AttemptArgs): Promise<boolean> {
  const x402Advert = args.providerInfo.x402;
  if (!x402Advert?.pay_to) return false;

  let proof;
  try {
    proof = await tryX402Payment(
      {
        amountMsats: args.chosen.priceMsats,
        requiredUsdcMicro: args.chosen.requiredUsdcMicro,
        paymentRequired: args.chosen.x402PaymentRequired,
        payTo: x402Advert.pay_to,
        network: x402Advert.network,
        asset: x402Advert.asset,
        // Price the USDC against the rate `enforceGlobalBudget` resolved, so the
        // signed amount and the ledger entry can't disagree.
        btcRate: args.btcRate,
      },
      args.wallet
    );
  } catch (err) {
    // Treat x402_build_failed as soft fall-through to the next rail rather
    // than blowing up the request, preserving chained-fallback semantics.
    if (err instanceof DvmError && err.code === "x402_build_failed") return false;
    throw err;
  }
  if (!proof) return false;

  // The server's advertised USDC amount can convert to slightly more msats at
  // the caller's rate than the original sats quote. Re-run the global ceiling
  // against the amount that will actually be signed before committing it.
  await enforceGlobalBudget({ plannedMsats: proof.amountMsats, btcRate: proof.btcRate });

  await payWithX402(args, proof);
  return true;
}

async function payWithX402(args: X402AttemptArgs, proof: X402PaymentProof): Promise<void> {
  const { transport, ref, envelope, chosen, opts, identity, policy, wallet } = args;
  if (opts.requestId) recordRequestRailPayment(opts.requestId, { method: "x402", amountMsats: proof.amountMsats });
  const dvmFields = dvmIdentity(identity.dvmId, identity.capability);
  const usdcMicroUnits = Number(proof.amountUsdcMicro);
  const usd = usdcMicroUnits / 1e6;
  const priceLabel = `$${formatUsd(usd)} USDC`;
  const addressShort = wallet.address
    ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`
    : "(address pending)";

  if (opts.human) {
    info(`Paying ${priceLabel} via x402 (account ${addressShort})...`);
  } else {
    json({
      ...dvmFields,
      ...requestIdOutputFields(opts.requestId),
      status: "paying",
      rail: "x402",
      account: wallet.address,
      price_usd: Math.round(usd * 100) / 100,
      price_usdc_microunits: usdcMicroUnits,
      display: `Paying ${priceLabel} via x402 (account ${addressShort}).`,
    });
  }

  // same as the Tempo leg — the EIP-3009 authorization is committed
  // by this POST, so the paid submit gets a floor regardless of the deadline.
  let receipt;
  try {
    receipt = await transport.submit(
      ref,
      envelope,
      { x402Payment: proof.paymentHeader, x402Version: proof.x402Version },
      { timeoutMs: paidSubmitTimeoutMs(args.deadlineMs) }
    );
  } catch (err) {
    const unconfirmed = (key: string | undefined) =>
      recordUnconfirmedSpend({
        msats: proof.amountMsats,
        btcRate: proof.btcRate,
        key,
        endpoint: ref.endpoint,
        capability: identity.capability,
      });
    if (!isIdentityFailure(err)) {
      if (leavesOutcomeUnknown(raisedAfterPayment(err))) {
        unconfirmed(unconfirmedSpendKey(opts, err as DvmError));
      }
      throw err;
    }
    transport.close?.();
    const { error } = recordIdentityFailure(err, {
      endpoint: ref.endpoint,
      ...(identity.dvmId ? { dvmId: identity.dvmId } : {}),
      capability: identity.capability,
      ...(opts.requestId ? { publicRequestId: opts.requestId } : {}),
      rail: "x402",
      railCorrelation: {
        ...(wallet.address ? { account: wallet.address } : {}),
        amount_usdc_micro: usdcMicroUnits,
      },
    });
    unconfirmed(unconfirmedSpendKey(opts, error));
    throw error;
  }

  const effectiveJobId = args.jobId || receipt.jobId;
  if (!args.jobId && receipt.jobId) {
    saveJob({
      id: effectiveJobId,
      ...transactionRecordFields(receipt),
      endpoint: ref.endpoint,
      dvmId: identity.dvmId,
      feedbackClaim: receipt.feedbackClaim,
      capability: identity.capability,
      requestId: opts.requestId,
      status: "submitted",
      submittedAt: Date.now(),
      policy,
      jobToken: receipt.jobToken,
      traceId: getOutputTraceId() ?? undefined,
      ...receiptTrustFields(args.providerInfo),
      ...localCorrelationJobFields(normalizedLocalCorrelationId(opts)),
    });
  }

  if (receipt.status === "payment-required") {
    transport.close?.();
    // the mid-loop twin of the zero-balance surfaces. The signature
    // is built against the chain *this DVM advertises*, which need not be the
    // one the wallet reads — so a caller can watch a healthy balance in
    // `dvm wallet balance` and still be rejected here for holding nothing on
    // the advertised chain. Name the contract and chain that were signed
    // against; without them the caller has no way to tell which of the two
    // wrong-asset mistakes they made.
    const asset = resolveX402Asset(args.providerInfo.x402?.network);
    throw new DvmError(
      "payment_insufficient",
      "x402 payment signed but rejected by the facilitator.",
      asset
        ? `Verify the account ${addressShort} holds at least the quoted amount in ${asset.label} (${asset.address}) on ${asset.networkLabel} — the chain this DVM advertises, which is not necessarily the one 'dvm wallet balance' reads. A different dollar${asset.confusable ? ` such as ${asset.confusable}` : ""}, or the right one on another chain, cannot settle this payment.`
        : "Verify the x402 account holds the quoted USDC amount on the advertised network."
    );
  }

  recordUpfrontRailPayment(effectiveJobId, { method: "x402", amountMsats: proof.amountMsats }, true);
  recordSpend({
    msats: proof.amountMsats,
    btcRate: proof.btcRate,
    jobId: effectiveJobId,
    providerEndpoint: ref.endpoint,
    label: buildSpendLabel(identity.capability, envelope.input),
  });

  if (receipt.status === "completed" && receipt.summary) {
    markJobTerminal(effectiveJobId, "completed", completionSnapshot(receipt), {
      costMsats: proof.amountMsats,
      paymentMethod: "x402",
    });
    const captured = captureTransportReceipt(effectiveJobId, receipt);
    // The planner can defer an x402 channel open/refill until this healthy
    // moment. Keep the transport alive while that intent is consumed, just as
    // the Cashu and Tempo completion paths do.
    await settleCreditAfterJob({
      capture: captured,
      transport,
      ref,
      dvmId: identity.dvmId,
      providerInfo: args.providerInfo,
      signing: args.signing,
      human: opts.human,
    });
    noteFeedbackAfterTerminal({
      jobId: effectiveJobId,
      dvmId: identity.dvmId,
      endpoint: ref.endpoint,
      status: "completed",
      human: opts.human,
    });
    transport.close?.();
    if (opts.human) {
      console.log(receipt.summary);
      const hint = nextStepHint(effectiveJobId, receipt.payloadIn, receipt.artifactCount, true);
      if (hint) info(`📎 ${hint}`);
      renderReceiptHuman(captured);
    } else {
      json({
        jobId: effectiveJobId,
        ...requestIdOutputFields(opts.requestId),
        ...transactionOutputFields(receipt),
        ...dvmFields,
        summary: receipt.summary,
        _provider_fields: ["summary"],
        ...buildCompletionHintFields(effectiveJobId, receipt),
        ...receiptJsonFields(captured),
        paidWith: "x402",
        account: wallet.address,
        ...takeCreditNoticeFields(),
        ...takeFeedbackNoticeFields(),
        next_action: null,
      });
    }
    return;
  }

  updateJob(effectiveJobId, {
    status: "processing",
    paymentMethod: "x402",
  });
  await streamAfterPayment({
    jobId: effectiveJobId,
    transport,
    ref,
    policy,
    chosen: { ...chosen, priceMsats: proof.amountMsats },
    deadlineMs: args.deadlineMs,
    paymentMethod: "x402",
    paymentFields: {
      paidWith: "x402",
      account: wallet.address,
      ...requestIdOutputFields(opts.requestId),
      ...transactionOutputFields(receipt),
    },
    dvmFields,
    paidTimeoutMessage: "x402 payment sent but timed out waiting for result.",
    human: opts.human,
    dvmId: identity.dvmId,
    providerInfo: args.providerInfo,
    signing: args.signing,
  });
}

/** Minimum wait between polling re-enters to avoid connection churn against
 * providers that emit `working` without `estimate_seconds`. */
const MIN_POLL_WAIT_MS = 500;

/**
 * Stream the job to a terminal or human-input action, re-entering `streamLoop`
 * each time the provider yields a `next_action: poll`. Accumulates messages
 * and auto-payments across iterations. Bails with the last `poll` action if
 * `deadlineMs` elapses — an agent can resume via `dvm status`.
 */
async function streamToCompletion(
  baseOpts: Omit<StreamLoopOptions, "afterSeq" | "timeoutMs">,
  deadlineMs: number
): Promise<StreamLoopResult> {
  const budget = () => Math.max(1, deadlineMs - Date.now());
  const messageAppendSession =
    baseOpts.persistLocalState === false
      ? undefined
      : (baseOpts.messageAppendSession ?? createMessageAppendSession(baseOpts.jobId));
  const streamOpts = { ...baseOpts, messageAppendSession };
  let result = await streamLoop({ ...streamOpts, afterSeq: 0, timeoutMs: budget() });
  const allMessages: Message[] = [...result.messages];
  const allAutoPayments = [...result.autoPayments];
  const allRefunds = [...result.refunds];

  while (result.nextAction?.type === "poll") {
    if (Date.now() >= deadlineMs) break;
    const waitMs = Math.min(
      Math.max((result.nextAction.estimate_seconds ?? 0) * 1000, MIN_POLL_WAIT_MS),
      deadlineMs - Date.now()
    );
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
    if (Date.now() >= deadlineMs) break;
    const next = await streamLoop({
      ...streamOpts,
      afterSeq: result.cursor,
      timeoutMs: budget(),
    });
    // If the re-enter produced no new messages, the stream timed out mid-SSE
    // with nothing to report. Break without clobbering `result` (preserves
    // the prior poll action) and without accumulating from the empty batch.
    if (next.messages.length === 0) break;
    allMessages.push(...next.messages);
    allAutoPayments.push(...next.autoPayments);
    allRefunds.push(...next.refunds);
    result = next;
  }
  return {
    messages: allMessages,
    autoPayments: allAutoPayments,
    refunds: allRefunds,
    nextAction: result.nextAction,
    cursor: result.cursor,
  };
}

/**
 * After a paid `transport.submit` returns non-completed, stream the job until
 * the handler yields its next message (`complete` / `payment-request` /
 * `cancel`) or `--timeout` expires. Mirrors the post-payment streaming flow
 * already used by `payWithLightning`, so an `--auto-pay` caller whose handler
 * runs asynchronously after the SDK's 202 doesn't bail with a misleading
 * `paid-timeout` while the work is still in flight.
 *
 * Emits the `paid-timeout` JSON shape + throws `DvmError("timeout", ...)` only
 * when the provider yielded nothing within the deadline — i.e. when
 * `streamToCompletion` synthesises its `poll` fallback. Any provider activity
 * (working/progress/payment-request/complete/cancel) routes through the
 * regular streamed-output path and exits zero.
 */
async function streamAfterPayment(args: {
  jobId: string;
  transport: Transport;
  ref: ProviderRef;
  policy: JobPolicy;
  chosen: Quote;
  deadlineMs: number;
  paymentMethod: "cashu" | "tempo" | "x402";
  paymentFields: Record<string, unknown>;
  dvmFields: Record<string, string>;
  paidTimeoutMessage: string;
  human?: boolean;
  /**
   * The owner-qualified handle the caller resolved against, absent for
   * `--endpoint` calls. Names the DVM on the credit notices the settlement
   * below emits, so they agree with the ones the request path already stashed.
   */
  dvmId?: string;
  providerInfo?: ProviderInfo;
  signing?: RequestSigningContext;
  /** Suppress every prepaid-credit projection/refill path for strict direct Cashu. */
  strictPerCall?: boolean;
}): Promise<void> {
  const {
    jobId,
    transport,
    ref,
    policy,
    chosen,
    deadlineMs,
    paymentMethod,
    paymentFields,
    dvmFields,
    paidTimeoutMessage,
    human,
  } = args;
  const artifactSession = human ? createArtifactSaveSession() : undefined;

  const result = await streamToCompletion(
    {
      jobId,
      transport,
      provider: ref,
      policy,
      ...(human && {
        onMessage: (msg: Message) => {
          if (msg.type === "progress") formatMessageHuman(msg);
        },
      }),
    },
    deadlineMs
  );

  const completion = persistStreamOutcome(
    streamOutcome(jobId, result, { costMsats: chosen.priceMsats, paymentMethod })
  );
  // same as the unpaid streamed arc — the receipt only rides on a job
  // read, which this path never makes. One gated GET collects it, and only on a
  // job that actually finished. The SSE-drop branch below skips this entirely —
  // it captures off the status read it makes anyway.
  const captured =
    result.nextAction === null
      ? captureTransportReceipt(jobId, await fetchMissingJobReceipt(jobId, transport, ref))
      : undefined;
  // fold the countersigned credit block into the local projection
  // and refill at this healthy moment. Never throws, never changes outcome.
  if (captured && !args.strictPerCall) {
    await settleCreditAfterJob({
      capture: captured,
      transport,
      ref,
      dvmId: args.dvmId,
      providerInfo: args.providerInfo,
      signing: args.signing,
      human,
    });
  }
  // same as the unpaid streamed arc — the streamed log is where
  // this path learns the job is over.
  const streamedTerminal =
    result.nextAction === null ? streamTerminalStatus(result.messages) : undefined;
  if (streamedTerminal) {
    noteFeedbackAfterTerminal({
      jobId,
      dvmId: args.dvmId,
      endpoint: ref.endpoint,
      status: streamedTerminal,
      human,
    });
  }
  transport.close?.();

  // `streamToCompletion` returns `messages: []` when the SSE connection
  // aborted before any provider yield within the deadline. Before declaring
  // paid-timeout, poll the provider once — the job may have completed
  // server-side while the SSE was torn down.
  if (result.messages.length === 0) {
    const recovered = await recoverViaStatusPoll({
      jobId,
      transport,
      ref,
      chosen,
      paymentMethod,
      paymentFields,
      dvmFields,
      human,
      dvmId: args.dvmId,
      providerInfo: args.providerInfo,
      signing: args.signing,
      strictPerCall: args.strictPerCall,
    });
    if (recovered) return;

    const nextAction = pollNextAction(
      jobId,
      `Payment sent but the result stream timed out. ${pollNextAction(jobId).hint}`
    );
    if (human) {
      info(paidTimeoutMessage);
      printNextActionHuman(nextAction);
    } else {
      json({
        jobId,
        ...dvmFields,
        status: "paid-timeout",
        summary: null,
        ...paymentFields,
        // Paid, and the job is still live provider-side — the stream gave up,
        // not the job. `poll`, not `null`: the result is still coming.
        ...takeCreditNoticeFields(),
        ...takeFeedbackNoticeFields(),
        next_action: nextAction,
      });
    }
    throw new DvmError("timeout", paidTimeoutMessage);
  }

  if (human) {
    for (const msg of result.messages) {
      if (msg.type === "progress") continue; // already rendered live
      formatMessageHuman(msg, jobId, artifactSession);
    }
    if (completion) {
      const hint = nextStepHint(jobId, completion.payloadIn, completion.artifactCount, true);
      if (hint) info(`📎 ${hint}`);
    }
    if (captured) renderReceiptHuman(captured);
    finalizeProgressLine();
    printNextActionHuman(result.nextAction, { refunds: result.refunds, terminal: !!streamTerminalStatus(result.messages) });
  } else {
    json({
      jobId,
      ...dvmFields,
      messages: result.messages.map(serializeMessageForOutput),
      // Same as the unpaid arc above: the outcome is only knowable from the
      // streamed log here, so render it rather than leaving the agent to dig
      // the summary out of `messages` and guess about artifacts.
      ...(completion?.summary !== undefined ? { summary: completion.summary, _provider_fields: ["summary"] } : {}),
      ...(completion ? buildCompletionHintFields(jobId, completion) : {}),
      ...(captured ? receiptJsonFields(captured) : {}),
      ...takeCreditNoticeFields(),
      ...takeFeedbackNoticeFields(),
      next_action: result.nextAction,
      ...paymentFields,
      ...(result.autoPayments.length > 0 ? { auto_payments: result.autoPayments } : {}),
      ...(await refundJsonField(result.refunds)),
    });
  }
}

/**
 * When the SSE stream drops before delivering any messages, poll the provider
 * once to check if the job actually completed server-side.
 * Returns `true` if the job was recovered (rendered + job store updated),
 * `false` if it's genuinely still processing (caller should report paid-timeout).
 */
async function recoverViaStatusPoll(args: {
  jobId: string;
  transport: Transport;
  ref: ProviderRef;
  chosen: Quote;
  paymentMethod: "cashu" | "tempo" | "x402";
  paymentFields: Record<string, unknown>;
  dvmFields: Record<string, string>;
  human?: boolean;
  dvmId?: string;
  providerInfo?: ProviderInfo;
  signing?: RequestSigningContext;
  strictPerCall?: boolean;
}): Promise<boolean> {
  const { jobId, transport, ref, chosen, paymentMethod, paymentFields, dvmFields, human } = args;

  let status: JobStatus;
  try {
    // anonymous-flow per-job token threaded into the recovery poll
    // so the status check on a token-gated job doesn't 404. Pulled from the
    // locally-persisted job record (saveJob ran before this codepath).
    const jobToken = loadJob(jobId)?.jobToken;
    status = await transport.status(jobId, ref, { jobToken });
  } catch {
    return false;
  }

  if (status.status === "completed") {
    markJobTerminal(jobId, "completed", completionSnapshot(status), {
      costMsats: chosen.priceMsats,
      paymentMethod,
    });
    await collectCashuChange(jobId, status.cashuChange);
    // the SSE dropped, so the submit path never saw a receipt — this
    // read is the one that carries it.
    const captured = captureTransportReceipt(jobId, status);
    // projection update only — a degraded moment is not a healthy
    // one, so no top-up here.
    if (!args.strictPerCall)
      await settleCreditAfterJob({
        capture: captured,
        transport,
        ref,
        dvmId: args.dvmId,
        providerInfo: args.providerInfo,
        signing: args.signing,
        allowTopup: false,
        human,
      });
    // job-terminal moment — the recovery poll is where this arc
    // learns the job finished.
    noteFeedbackAfterTerminal({
      jobId,
      dvmId: args.dvmId,
      endpoint: ref.endpoint,
      status: "completed",
      human,
    });

    if (human) {
      info(status.summary ?? "Job completed (recovered via status check).");
      renderReceiptHuman(captured);
    } else {
      json({
        jobId,
        ...dvmFields,
        status: "completed",
        summary: status.summary ?? null,
        _provider_fields: ["summary"],
        recovered: true,
        ...paymentFields,
        ...receiptJsonFields(captured),
        ...takeCreditNoticeFields(),
        ...takeFeedbackNoticeFields(),
        next_action: null,
      });
    }
    return true;
  }

  if (status.status === "failed" || status.status === "cancelled") {
    markJobTerminal(jobId, status.status, completionSnapshot(status));
    await collectCashuChange(jobId, status.cashuChange);
    // A paid job that failed is precisely what a receipt is evidence for.
    const captured = captureTransportReceipt(jobId, status);
    // a recovered `failed` nudges like any other; `cancelled` never
    // nudges, and the call is a no-op there.
    noteFeedbackAfterTerminal({
      jobId,
      dvmId: args.dvmId,
      endpoint: ref.endpoint,
      status: status.status,
      human,
    });

    const errorMsg = status.message ?? `Job ${status.status}.`;
    if (human) {
      info(errorMsg);
      renderReceiptHuman(captured);
    } else {
      json({
        jobId,
        ...dvmFields,
        status: status.status,
        message: errorMsg,
        ...(status.message !== undefined ? { _provider_fields: ["message"] } : {}),
        ...paymentFields,
        ...receiptJsonFields(captured),
        ...takeCreditNoticeFields(),
        ...takeFeedbackNoticeFields(),
        next_action: null,
      });
    }
    throw new DvmError(status.status === "failed" ? "provider_error" : "cancelled", errorMsg, undefined, undefined, undefined,
      status.message !== undefined ? { message: "provider" } : undefined);
  }

  return false;
}

async function collectCashuChange(jobId: string, cashuChange?: string): Promise<void> {
  if (!cashuChange) return;
  const job = loadJob(jobId);
  if (job?.changeProcessed) return;
  // Claim the DVM's change token into the agent wallet. Best-effort — a mint
  // outage or unclaimable token leaves the change uncollected rather than
  // failing the request (the token is still in the job's messages for retry).
  let sats = 0;
  try {
    sats = (await receiveToAgentWallet(cashuChange)).claimedSats;
  } catch {
    // Unclaimable (mint outage / third-party lock) — leave change uncollected.
  }
  if (sats > 0) {
    updateJob(jobId, { changeProcessed: true });
    info(`Received ${sats} sats change.`);
  }
}

async function readStdin(): Promise<string> {
  try {
    return (await drainStdin(1000)).trim();
  } catch (err) {
    if (err instanceof StdinTimeoutError) {
      throw new DvmError(
        "no_input",
        "No input provided (stdin timed out).",
        "Use -i to specify job input, or pipe data via stdin."
      );
    }
    throw err;
  }
}
