import {
  type CancelOptions,
  type CreditOpResult,
  decodePaymentRequiredHeader,
  type DescribeOptions,
  DvmError,
  fetchBtcUsdRate,
  type FundingReceipt,
  isAbortError,
  isFundingReceipt,
  isSignedJobReceipt,
  type JobEnvelope,
  type TransportJobReceipt as JobReceipt,
  type JobStatus,
  type LightningFundingOffer,
  type Message,
  type MessagePollOptions,
  type MppxChallenge,
  type OutboundMessage,
  parseCreditMenu,
  parseCreditTerms,
  parseJobIdentityHeader,
  parseTraceparent,
  type Payment,
  type PaymentRequired,
  type PaymentRequirementsV1,
  type ProviderInfo,
  providerProseSources,
  type ProviderRef,
  type Quote,
  type ReceiptParseError,
  ROUTER_FEEDBACK_CLAIM_HEADER,
  type SendMessageOptions,
  type JobReceipt as SignedJobReceipt,
  type StatusOptions,
  type StreamOptions,
  type StreamResult,
  type SubmitOptions,
  SUPPORTED_PROTOCOL_VERSION,
  type Transport,
  usdToMsats,
  X402_V1_VERSION,
  X402_VERSION,
} from "@dvmkit/sdk/internal";
import {
  setOutputTraceId,
} from "../output";

import { type ContentStatus, parseJobContent } from "../job-content";
import {
  identityError,
  isOpaqueJobToken,
  isParseableBodyJobId,
  jobIdentityHeaderValue,
  routerConflictObservation,
  settleJobIdentity,
  warnInvalidJobIdentityHeader,
} from "../job-identity";

import { dvmFetch } from "../http";
import { requestRecoveryPath } from "../request-recovery-path";
import { envelopeToPayload } from "../job-envelope";
import { assertConfiguredTempoChallengeNetwork } from "../tempo-network";

/**
 * build the `X-Job-Token` header object for a per-job opaque token,
 * or an empty object when none was issued (authenticated callers).
 */
function jobTokenHeader(jobToken: string | undefined): Record<string, string> {
  return jobToken ? { "X-Job-Token": jobToken } : {};
}

function messagePollUnreachable(jobId: string): DvmError {
  return new DvmError(
    "provider_unreachable",
    `Could not reach the provider to fetch messages for job ${jobId}.`,
    "The provider may be down or unreachable from this network. Retry once it is back."
  );
}

async function readMessagePollBody<T>(read: () => Promise<T>, jobId: string): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof TypeError && !isAbortError(err)) throw messagePollUnreachable(jobId);
    throw err;
  }
}

/**
 * Extract the `traceparent` response header and store the trace_id for
 * automatic injection into CLI JSON output via `setOutputTraceId`. Mirrors
 * the `platformFetch` pattern in `platform-client.ts`.
 */
function captureTraceId(res: Response): void {
  const tp = res.headers.get("traceparent");
  if (tp) {
    const parsed = parseTraceparent(tp);
    if (parsed) setOutputTraceId(parsed.traceId);
  }
}

export class HttpsTransport implements Transport {
  async describe(provider: ProviderRef, options?: DescribeOptions): Promise<ProviderInfo> {
    const url = `${provider.endpoint}/v1/info`;
    const signal =
      options?.timeoutMs && options.timeoutMs > 0
        ? AbortSignal.timeout(options.timeoutMs)
        : undefined;
    let res: Response;
    try {
      res = await dvmFetch(url, { signal });
    } catch (err) {
      if (isAbortError(err)) {
        throw new DvmError(
          "timeout",
          "Provider metadata read timed out.",
          "The provider may be starting up. Retry in a few seconds."
        );
      }
      throw err;
    }

    if (!res.ok) {
      throw providerResponseError(
        "provider_error",
        `Provider returned ${res.status}: ${await res.text()}`
      );
    }

    const data = (await res.json()) as Record<string, unknown>;
    const providerVersion = data.protocol_version as number | undefined;
    if (providerVersion !== undefined && providerVersion > SUPPORTED_PROTOCOL_VERSION) {
      throw new DvmError(
        "unsupported_version",
        `Provider requires protocol version ${providerVersion}, but this client only supports up to ${SUPPORTED_PROTOCOL_VERSION}.`,
        "Upgrade dvmkit to interact with this provider."
      );
    }
    const builder = parseTrustAnchor(data.builder);
    return {
      name: data.name as string | undefined,
      about: data.description as string | undefined,
      tags: data.tags as string[] | undefined,
      auth: data.auth as string[] | undefined,
      authAudience: data.auth_audience as ProviderInfo["authAudience"],
      pricing: data.pricing as ProviderInfo["pricing"],
      mints: data.mints as string[] | undefined,
      quote: data.quote as { schema: Record<string, unknown> } | undefined,
      inputSchema: data.input_schema as Record<string, unknown> | undefined,
      protocolVersion: providerVersion,
      paymentMethods: (data.payment as { methods?: string[] } | undefined)?.methods,
      credit: parseCreditTerms(data.credit),
      x402: data.x402 as ProviderInfo["x402"],
      tempo: data.tempo as ProviderInfo["tempo"],
      cashu: data.cashu as ProviderInfo["cashu"],
      sdkSha: data.sdk_sha as string | undefined,
      capabilities: data.capabilities as ProviderInfo["capabilities"],
      // the receipt trust anchor. `receipts` is emitted only when
      // true, so coerce rather than pass through — a DVM sending `false`
      // means the same thing as omitting it.
      ...(data.receipts === true ? { receipts: true } : {}),
      ...(data.request_recovery === true ? { requestRecovery: true } : {}),
      ...(builder ? { builder } : {}),
    };
  }

  async quote(provider: ProviderRef, job: JobEnvelope): Promise<Quote[]> {
    const url = `${provider.endpoint}/v1/quote`;
    const body = JSON.stringify(envelopeToPayload(job));
    const res = await dvmFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    captureTraceId(res);

    if (!res.ok) {
      const text = await res.text();
      const structured = parseStructuredError(text);
      if (structured) throw structured;
      throw providerResponseError("provider_error", `Quote failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    // the new wire shape carries `upfront`, `description`, and
    // (optional) `hint`/`shape`/`rate`. Some old containers still emit
    // `{price_msats}` only — synthesize an upfront envelope from that for
    // forward-compat.
    const upfront = parseUpfront(data);
    const description = typeof data.description === "string" ? data.description : "";
    const advisorySats = await deriveAdvisorySats(upfront, data);
    const quote: Quote = {
      upfront,
      description,
      priceMsats: advisorySats ?? 0,
      mints: data.mints as string[] | undefined,
      expiresAt: data.expires_at as number | undefined,
    };
    if (typeof data.hint === "string") quote.hint = data.hint;
    if (data.shape === "fixed" || data.shape === "rate") quote.shape = data.shape;
    if (data.rate && typeof data.rate === "object") {
      quote.rate = data.rate as Quote["rate"];
    }
    // the nested `payment` envelope carries the rail list plus a
    // per-rail `refundable` map. Only surface it once `refundable` is present —
    // pre- providers emit `payment.methods` without it, and the caller
    // can't infer refundability, so we leave the field undefined.
    const payment = data.payment as { methods?: unknown; refundable?: unknown } | undefined;
    if (
      payment &&
      Array.isArray(payment.methods) &&
      payment.refundable &&
      typeof payment.refundable === "object"
    ) {
      quote.payment = {
        methods: payment.methods as string[],
        refundable: payment.refundable as Record<string, boolean>,
      };
    }
    const creditMenu = parseCreditMenu(data.credit);
    if (creditMenu) quote.credit = creditMenu;
    return [quote];
  }

  async submit(
    provider: ProviderRef,
    job: JobEnvelope,
    payment?: Payment,
    options?: SubmitOptions
  ): Promise<JobReceipt> {
    const url = `${provider.endpoint}/v1/job`;
    const body = JSON.stringify(envelopeToPayload(job));
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(await paymentHeaders(payment)),
    };

    const signal =
      options?.timeoutMs && options.timeoutMs > 0
        ? AbortSignal.timeout(options.timeoutMs)
        : undefined;

    let res: Response;
    try {
      res = await dvmFetch(url, { method: "POST", headers, body, signal });
    } catch (err) {
      if (err instanceof DvmError) throw err;
      if (isAbortError(err)) {
        throw new DvmError(
          "timeout",
          "Job submission timed out.",
          "The provider may be starting up. Retry in a few seconds or use a longer --timeout."
        );
      }
      // a submit can also die below the timeout — connection refused,
      // socket reset, DNS. `fetch` reports those as a bare `TypeError`, which
      // must become a DvmError: the paid path's retry-once keys on codes
      // (`timeout` / `provider_unreachable`) and `withSpentSpendContext` only
      // annotates a DvmError. Preserve both retry eligibility and the wallet-debit
      // signal when proofs were spent and the DVM never answered. Give it the
      // code the retry policy already whitelists.
      throw new DvmError(
        "provider_unreachable",
        `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
        "The provider may be down or unreachable from this network. Retry once it is back."
      );
    }
    captureTraceId(res);
    const tempoTransactionHash = await tempoTransactionHashFromResponse(res);

    if (res.status === 402) {
      let errorBody: Record<string, unknown>;
      try {
        errorBody = (await res.json()) as Record<string, unknown>;
      } catch {
        throw new DvmError("payment_insufficient", "Payment required (unparseable response).");
      }

      // Recoverable: the DVM is telling us what the call costs, not rejecting
      // a payment — surface as a payment-required receipt rather than throwing.
      const requiredMsats = errorBody.required_msats as number | undefined;
      const receivedMsats = errorBody.received_msats as number | undefined;
      if (requiredMsats !== undefined && isReceipt402(errorBody.error)) {
        // Synthetic quote derived from the 402's `required_msats`.
        //
        // the fiat side is the provider's own `price_micro` when it
        // states one — the exact integer its ledger pins, resolved against the
        // same fx snapshot as this 402's `required_msats`, so both halves of a
        // fund-and-draw's ratio come off one envelope. It is the *only* fiat
        // figure here that can be signed: the fallback below is a client-side
        // fx reconstruction quantized to four decimals, which is indicative for
        // the CLI's display layer and nothing more. Keep them apart —
        // `amount_micro` is set on the first branch only.
        // the SDK attaches the credit funding menu to every 402, and
        // the request path never calls /v1/quote — this synthetic quote is the
        // only place the menu can reach the caller's credit policy.
        const creditMenu = parseCreditMenu(errorBody.credit);
        const priceMicro = exactMicro(errorBody.price_micro);
        const rate = priceMicro === undefined ? await fetchBtcUsdRate().catch(() => null) : null;
        const usd = rate ? (requiredMsats / 100_000_000_000) * rate : 0;
        const upfront: Quote["upfront"] =
          priceMicro === undefined
            ? { amount: Math.round(usd * 10_000) / 10_000, currency: "usd" }
            : {
                amount: priceMicro / 1_000_000,
                // A provider stating `price_micro` should state
                // `price_currency` beside it, but the credit menu is a truer
                // fallback than the `usd` literal when it doesn't: it is
                // denominated in this DVM's own pricing currency by
                // construction, so a non-USD provider's price is labelled
                // correctly rather than mislabelled.
                currency:
                  typeof errorBody.price_currency === "string"
                    ? errorBody.price_currency
                    : (creditMenu?.currency ?? "usd"),
                amount_micro: priceMicro,
              };
        const x402PaymentRequired = parseX402PaymentRequired(res.headers, errorBody);
        const requiredUsdcMicro = x402RequiredUsdcMicro(x402PaymentRequired);
        return {
          jobId: "",
          status: "payment-required",
          quotes: [
            {
              upfront,
              description: receivedMsats
                ? `Received ${String(receivedMsats)} msats, need ${String(requiredMsats)} msats`
                : "Upfront payment required",
              priceMsats: requiredMsats,
              ...(requiredUsdcMicro !== undefined && { requiredUsdcMicro }),
              ...(x402PaymentRequired && { x402PaymentRequired }),
              ...(creditMenu ? { credit: creditMenu } : {}),
              mints: errorBody.mints as string[] | undefined,
            },
          ],
        };
      }

      throw withCreditErrorContext(buildPaymentError(errorBody), errorBody);
    }
    if (!res.ok && res.status !== 202) {
      let text: string | null;
      try {
        text = await res.text();
      } catch {
        text = null;
      }
      const structured = text === null ? null : parseStructuredError(text);
      // A paid 409 that names no error may be the router's identity conflict
      // with its body lost: the payment may have been taken, so it is held as
      // unresolved rather than surfaced as a refusal a retry could pay again.
      if (res.status === 409 && payment !== undefined && structured === null) {
        throw identityError({
          kind: "body_unreadable",
          ...(tempoTransactionHash ? { transactionHash: tempoTransactionHash } : {}),
        });
      }
      if (text === null) {
        throw providerResponseError(
          "provider_error",
          `Job submission failed (${res.status}); the response body could not be read.`
        );
      }
      const conflict = routerConflictObservation(res.status, parseJsonObject(text));
      if (conflict) {
        throw identityError(
          { ...conflict, ...(tempoTransactionHash ? { transactionHash: tempoTransactionHash } : {}) },
          structured ? routerProse(structured) : undefined
        );
      }
      if (structured) throw structured;
      throw providerResponseError(
        "provider_error",
        `Job submission failed (${res.status}): ${text}`
      );
    }

    // The field is read from the head before the body, so it survives a body
    // that fails or times out. A body failure here is never `timeout`: the
    // provider already answered 2xx, and `timeout` is in the paid retry set.
    const identityHeader = jobIdentityHeaderValue(res.headers);
    let parsedBody: Record<string, unknown> | null;
    try {
      parsedBody = parseJsonObject(await res.text());
    } catch {
      parsedBody = null;
    }
    const identity = settleJobIdentity(identityHeader, parsedBody);
    if (identity.kind === "unresolved") {
      throw identityError({
        ...identity.observation,
        ...(tempoTransactionHash ? { transactionHash: tempoTransactionHash } : {}),
      });
    }
    if (identity.headerInvalid) warnInvalidJobIdentityHeader();
    const data = parsedBody as Record<string, unknown>;
    const feedbackClaim = identity.claimAllowed
      ? (res.headers.get(ROUTER_FEEDBACK_CLAIM_HEADER) ?? undefined)
      : undefined;

    // capture the anonymous-flow per-job token. The CLI persists it
    // on the local job record and threads it into subsequent reads/writes via
    // the `X-Job-Token` header. Absent for bearer / signed-request callers.
    const jobToken = data.job_token as string | undefined;

    if (res.status === 202) {
      return {
        jobId: identity.jobId,
        status: (data.status as string) === "awaiting-input" ? "awaiting-input" : "processing",
        estimatedSeconds: data.estimated_seconds as number | undefined,
        jobToken,
        ...(tempoTransactionHash ? { transactionHash: tempoTransactionHash } : {}),
        ...(feedbackClaim ? { feedbackClaim } : {}),
        ...parseFundingResponse(data),
      };
    }

    return {
      jobId: identity.jobId,
      status: "completed",
      summary: data.summary as string | undefined,
      hasArtifacts: data.has_artifacts as boolean | undefined,
      artifactCount: data.artifact_count as number | undefined,
      payloadIn: data.payload_in as "summary" | "messages" | undefined,
      cashuChange: res.headers.get("X-Cashu-Change") ?? undefined,
      jobToken,
      ...(tempoTransactionHash ? { transactionHash: tempoTransactionHash } : {}),
      ...(feedbackClaim ? { feedbackClaim } : {}),
      ...parseSignedReceipt(data.receipt),
      ...parseFundingResponse(data),
    };
  }

  async requestResult(
    provider: ProviderRef,
    requestId: string,
    signedJob: JobEnvelope
  ): Promise<JobReceipt> {
    const url = `${provider.endpoint}/${requestRecoveryPath("request-result", requestId)}`;
    const res = await dvmFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelopeToPayload(signedJob)),
    });
    captureTraceId(res);

    if (!res.ok && res.status !== 202) {
      const text = await res.text();
      const structured = parseStructuredError(text);
      const conflict = routerConflictObservation(res.status, parseJsonObject(text));
      if (conflict) {
        throw identityError(conflict, structured ? routerProse(structured) : undefined);
      }
      if (structured) throw structured;
      throw providerResponseError(
        "provider_error",
        `Request lookup failed (${res.status}): ${text}`
      );
    }

    const identityHeader = parseJobIdentityHeader(jobIdentityHeaderValue(res.headers));
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw malformedRequestResult(requestId, "response_not_json");
    }
    const receipt = parseRequestResultResponse(data, requestId, res.status);
    if (identityHeader.kind === "valid" && identityHeader.jobId !== receipt.jobId) {
      throw malformedRequestResult(requestId, "job_identity_mismatch");
    }
    if (identityHeader.kind === "invalid") warnInvalidJobIdentityHeader();
    return receipt;
  }

  async requestResume(
    provider: ProviderRef,
    requestId: string,
    signedJob: JobEnvelope,
    options?: SubmitOptions
  ): Promise<void> {
    const url = `${provider.endpoint}/${requestRecoveryPath("request-resume", requestId)}`;
    const signal =
      options?.timeoutMs && options.timeoutMs > 0
        ? AbortSignal.timeout(options.timeoutMs)
        : undefined;
    let res: Response;
    try {
      res = await dvmFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelopeToPayload(signedJob)),
        signal,
      });
    } catch (err) {
      if (err instanceof DvmError) throw err;
      if (isAbortError(err)) {
        throw new DvmError(
          "timeout",
          "Request recovery timed out.",
          "Run request-result before retrying recovery."
        );
      }
      throw new DvmError(
        "provider_unreachable",
        `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
        "Run request-result before retrying recovery."
      );
    }
    captureTraceId(res);
    if (!res.ok && res.status !== 202) {
      const text = await res.text();
      const structured = parseStructuredError(text);
      if (structured) throw structured;
      throw providerResponseError(
        "provider_error",
        `Request recovery failed (${res.status}): ${text}`
      );
    }
  }

  async credit(
    provider: ProviderRef,
    signedBody: Record<string, unknown>,
    payment?: Payment,
    options?: SubmitOptions
  ): Promise<CreditOpResult> {
    const url = `${provider.endpoint}/v1/credit`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(await paymentHeaders(payment)),
    };
    const signal =
      options?.timeoutMs && options.timeoutMs > 0
        ? AbortSignal.timeout(options.timeoutMs)
        : undefined;

    let res: Response;
    try {
      res = await dvmFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(signedBody),
        signal,
      });
    } catch (err) {
      if (err instanceof DvmError) throw err;
      if (isAbortError(err)) {
        throw new DvmError(
          "timeout",
          "Credit operation timed out.",
          "The provider may be starting up. Retry in a few seconds."
        );
      }
      throw new DvmError(
        "provider_unreachable",
        `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
        "The provider may be down or unreachable from this network. Retry once it is back."
      );
    }
    captureTraceId(res);
    const tempoTransactionHash = await tempoTransactionHashFromResponse(res);

    if (!res.ok) {
      const mppChallenges =
        res.status === 402 && res.headers.get("WWW-Authenticate")
          ? (await import("mppx")).Challenge.fromHeadersList(res.headers)
          : [];
      assertConfiguredTempoChallengeNetwork(mppChallenges, ["charge", "session"]);
      const text = await res.text();
      const parsed = parseJsonObject(text);
      const structured = parseStructuredError(text);
      if (structured) {
        const contextual = withCreditErrorContext(structured, parsed ?? {});
        const x402PaymentRequired = parseX402PaymentRequired(res.headers, parsed ?? {});
        if (x402PaymentRequired) {
          contextual.data = {
            ...contextual.data,
            x402_payment_required: x402PaymentRequired,
          };
        }
        if (tempoTransactionHash) {
          contextual.data = {
            ...contextual.data,
            transaction_hash: tempoTransactionHash,
          };
        }
        throw mppChallenges.length > 0
          ? new DvmError(
              contextual.code,
              contextual.message,
              contextual.hint,
              {
                ...contextual.data,
                tempo_challenges: mppChallenges,
              },
              contextual.display,
              contextual.proseSources
            )
          : contextual;
      }
      throw providerResponseError(
        "provider_error",
        `Credit operation failed (${res.status}): ${text}`
      );
    }
    const result = (await res.json()) as Record<string, unknown>;
    const { menu: rawMenu, funding_receipt: rawFundingReceipt, ...creditResult } = result;
    const menu = parseCreditMenu(rawMenu);
    const x402PaymentResponse =
      res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE") ?? undefined;
    const enriched = {
      ...(creditResult as unknown as CreditOpResult),
      ...parseFundingReceipt(rawFundingReceipt),
      ...(x402PaymentResponse ? { x402PaymentResponse } : {}),
      ...(tempoTransactionHash ? { transactionHash: tempoTransactionHash } : {}),
    };
    return menu ? { ...enriched, menu } : enriched;
  }

  async status(jobId: string, provider?: ProviderRef, options?: StatusOptions): Promise<ContentStatus> {
    const endpoint = provider?.endpoint;
    if (!endpoint) {
      throw new DvmError(
        "not_supported",
        "HTTPS status check requires a provider with an endpoint."
      );
    }
    const url = `${endpoint}/v1/job/${jobId}`;
    const signal =
      options?.timeoutMs && options.timeoutMs > 0
        ? AbortSignal.timeout(options.timeoutMs)
        : undefined;

    try {
      const res = await dvmFetch(url, { headers: jobTokenHeader(options?.jobToken), signal });
      captureTraceId(res);

      if (res.status === 404) {
        throw new DvmError("job_not_found", `Job ${jobId} not found.`);
      }
      if (!res.ok) {
        const credentialErr = jobCredentialError(res.status, await res.text());
        if (credentialErr) throw credentialErr;
        throw new DvmError("provider_error", `Status check failed (${res.status})`);
      }

      const data = (await res.json()) as Record<string, unknown>;
      return {
        jobId,
        status: data.status as JobStatus["status"],
        ...parseJobContent(data),
        summary: data.summary as string | undefined,
        hasArtifacts: data.has_artifacts as boolean | undefined,
        artifactCount: data.artifact_count as number | undefined,
        payloadIn: data.payload_in as "summary" | "messages" | undefined,
        message: data.message as string | undefined,
        cashuChange: res.headers.get("X-Cashu-Change") ?? undefined,
        ...parseSignedReceipt(data.receipt),
        ...parseFundingResponse(data),
      };
    } catch (err) {
      if (err instanceof DvmError) throw err;
      if (isAbortError(err)) {
        throw new DvmError(
          "timeout",
          "Status check timed out.",
          `The provider may still be working. Retry with 'dvm status ${jobId}'.`
        );
      }
      throw err;
    }
  }

  async getMessages(
    jobId: string,
    after: number,
    provider?: ProviderRef,
    options?: MessagePollOptions
  ): Promise<Message[]> {
    const endpoint = provider?.endpoint;
    if (!endpoint) {
      throw new DvmError(
        "not_supported",
        "HTTPS getMessages requires a provider with an endpoint."
      );
    }
    const url = `${endpoint}/v1/job/${jobId}/messages?after=${after}`;
    const signal =
      options?.timeoutMs && options.timeoutMs > 0
        ? AbortSignal.timeout(options.timeoutMs)
        : undefined;

    try {
      let res: Response;
      try {
        res = await dvmFetch(url, {
          headers: jobTokenHeader(options?.jobToken),
          signal,
        });
      } catch (err) {
        if (err instanceof DvmError || isAbortError(err)) throw err;
        throw messagePollUnreachable(jobId);
      }

      if (!res.ok) {
        const text = await readMessagePollBody(() => res.text(), jobId);
        const credentialErr = jobCredentialError(res.status, text);
        if (credentialErr) throw credentialErr;
        throw providerResponseError("provider_error", `getMessages failed (${res.status}): ${text}`);
      }

      const data = (await readMessagePollBody(() => res.json(), jobId)) as { messages: Message[] };
      return data.messages;
    } catch (err) {
      if (err instanceof DvmError) throw err;
      if (isAbortError(err)) {
        throw new DvmError(
          "timeout",
          "Message poll timed out.",
          `The provider may still be working. Retry with 'dvm messages ${jobId}'.`
        );
      }
      throw err;
    }
  }

  async sendMessage(
    jobId: string,
    message: OutboundMessage,
    provider?: ProviderRef,
    options?: SendMessageOptions
  ): Promise<void> {
    const endpoint = provider?.endpoint;
    if (!endpoint) {
      throw new DvmError(
        "not_supported",
        "HTTPS sendMessage requires a provider with an endpoint."
      );
    }
    const url = `${endpoint}/v1/job/${jobId}/messages`;
    const body = JSON.stringify({ type: message.type, content: message.content });
    let res: Response;
    try {
      res = await dvmFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jobTokenHeader(options?.jobToken) },
        body,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new DvmError("timeout", "sendMessage timed out.");
      }
      throw err;
    }

    if (res.status === 402) {
      // Parse the structured 402 body so the agent-wallet retry policy
      // can key on `wrong_lock_pubkey` and the transient
      // codes for mid-job pays the same way it does upfront.
      let errorBody: Record<string, unknown>;
      try {
        errorBody = (await res.json()) as Record<string, unknown>;
      } catch {
        throw new DvmError("payment_insufficient", "Payment required (unparseable response).");
      }
      throw buildPaymentError(errorBody);
    }

    if (res.status === 409) {
      const body = parseJsonObject(await res.text());
      // the accumulator answers a replayed mid-job payment with a
      // 409 while the job is still live and still waiting to be paid. Mapping
      // that to `job_terminal` told the agent to walk away from a running job —
      // surface the DVM's own code and copy instead.
      if (body?.error === "replay_rejected") throw buildPaymentError(body);
      // the job went terminal (completed/cancelled) before this POST
      // landed — the mid-job-payment race. Map it to a structured error with a
      // hint so an agent following a stale next_action self-recovers in one
      // step instead of surfacing a raw HTTP 409.
      throw new DvmError(
        "job_terminal",
        "Job is no longer active.",
        `The job has already completed or been cancelled, so it can't accept more messages. Fetch the final result with 'dvm messages ${jobId}'.`
      );
    }

    if (!res.ok) {
      const text = await res.text();
      const structured = parseStructuredError(text);
      if (structured) throw structured;
      throw providerResponseError("provider_error", `sendMessage failed (${res.status}): ${text}`);
    }
  }

  async stream(
    jobId: string,
    afterSeq: number,
    provider?: ProviderRef,
    options?: StreamOptions
  ): Promise<StreamResult> {
    const endpoint = provider?.endpoint;
    if (!endpoint) {
      throw new DvmError("not_supported", "HTTPS stream requires a provider with an endpoint.");
    }
    const url = `${endpoint}/v1/job/${jobId}/messages?after=${afterSeq}`;
    const res = await dvmFetch(url, {
      headers: { Accept: "text/event-stream", ...jobTokenHeader(options?.jobToken) },
      signal: options?.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      const credentialErr = jobCredentialError(res.status, text);
      if (credentialErr) throw credentialErr;
      throw providerResponseError("provider_error", `stream failed (${res.status}): ${text}`);
    }

    // Defence in depth: if the server responded with JSON instead of SSE
    // (e.g. job already flushed to store), parse the snapshot directly rather
    // than feeding it to the SSE parser where it would hang until timeout.
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = (await res.json()) as { messages?: Message[] };
      const messages = body.messages ?? [];
      const last = messages.at(-1);
      const reason: StreamResult["reason"] =
        last?.type === "complete" ? "complete" : last?.type === "cancel" ? "cancel" : "yield";
      for (const msg of messages) options?.onMessage?.(msg);
      return { messages, reason };
    }

    return parseSSEStream(res, options);
  }

  async cancel(
    jobId: string,
    reason?: string,
    provider?: ProviderRef,
    options?: CancelOptions
  ): Promise<void> {
    const endpoint = provider?.endpoint;
    if (!endpoint) {
      throw new DvmError("not_supported", "HTTPS cancel requires a provider with an endpoint.");
    }
    const url = `${endpoint}/v1/job/${jobId}`;
    const body = reason ? JSON.stringify({ reason }) : undefined;
    const tokenHeader = jobTokenHeader(options?.jobToken);
    const headers: Record<string, string> = body
      ? { "Content-Type": "application/json", ...tokenHeader }
      : tokenHeader;
    const res = await dvmFetch(url, { method: "DELETE", headers, body });

    if (!res.ok) {
      const text = await res.text();
      const credentialErr = jobCredentialError(res.status, text);
      if (credentialErr) throw credentialErr;
      throw providerResponseError("provider_error", `Cancel failed (${res.status}): ${text}`);
    }
  }

  /**
   * Issue a no-payment POST to `/v1/job` and parse the
   * `WWW-Authenticate: Payment` headers from the 402 response.
   * Used by the Tempo upfront-payment path to surface live mppx challenges
   * before signing. Returns an empty array when the DVM responds 2xx
   * (no payment required) or 402 without MPP headers.
   */
  async probeMppChallenges(provider: ProviderRef, job: JobEnvelope): Promise<MppxChallenge[]> {
    const url = `${provider.endpoint}/v1/job`;
    const body = JSON.stringify(envelopeToPayload(job));
    const res = await dvmFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (res.status !== 402) {
      // Either the DVM didn't require payment (2xx) or it returned an error
      // we should surface so the caller can react. Drain the body so the
      // socket can close.
      await res.text().catch(() => undefined);
      if (res.ok || res.status === 202) return [];
      throw new DvmError(
        "provider_error",
        `MPP probe expected 402 but got ${res.status}.`,
        "Check the DVM's `/v1/info` for advertised payment methods."
      );
    }
    const { Challenge } = await import("mppx");
    return Challenge.fromHeadersList(res.headers);
  }

  close(): void {
  }
}

async function tempoTransactionHashFromResponse(res: Response): Promise<string | undefined> {
  const encoded = res.headers.get("Payment-Receipt");
  if (!encoded) return undefined;
  try {
    const { Receipt } = await import("mppx");
    const receipt = Receipt.deserialize(encoded);
    if (receipt.method !== "tempo") return undefined;
    const extension = receipt as typeof receipt & { intent?: unknown; txHash?: unknown };
    const candidate =
      extension.intent === "session"
        ? typeof extension.txHash === "string"
          ? extension.txHash
          : undefined
        : receipt.reference;
    return candidate && /^0x[a-f0-9]{64}$/i.test(candidate) ? candidate.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse the `receipt` block off a `/v1/job` response without collapsing a
 * malformed offered value into absence. The guard remains the transport
 * boundary: callers receive either a safe signed-receipt shape or a parse
 * error, never the provider's untrusted raw block.
 */
function parseSignedReceipt(value: unknown): {
  receipt?: SignedJobReceipt;
  receiptParseError?: ReceiptParseError;
} {
  if (value === undefined) return {};
  return isSignedJobReceipt(value) ? { receipt: value } : { receiptParseError: "shape_invalid" };
}

function parseFundingReceipt(value: unknown): {
  fundingReceipt?: FundingReceipt;
  fundingReceiptParseError?: ReceiptParseError;
} {
  if (value === undefined) return {};
  return isFundingReceipt(value)
    ? { fundingReceipt: value }
    : { fundingReceiptParseError: "shape_invalid" };
}

function parseFundingResponse(
  data: Record<string, unknown>
): Pick<JobReceipt, "fundingReceipt" | "fundingReceiptParseError" | "fundedMicro" | "credit"> {
  return {
    ...parseFundingReceipt(data.funding_receipt),
    ...(typeof data.funded_micro === "number" ? { fundedMicro: data.funded_micro } : {}),
    ...(data.credit && typeof data.credit === "object" && !Array.isArray(data.credit)
      ? { credit: data.credit as JobReceipt["credit"] }
      : {}),
  };
}

function parseRequestResultResponse(
  value: unknown,
  requestId: string,
  httpStatus: number
): JobReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw malformedRequestResult(requestId, "response_not_object");
  }
  const data = value as Record<string, unknown>;
  if (data.request_id !== requestId) {
    throw malformedRequestResult(requestId, "request_id_mismatch");
  }
  if (!isParseableBodyJobId(data.job_id)) {
    throw malformedRequestResult(requestId, "job_id_invalid");
  }
  const allowedStatuses = new Set<JobReceipt["status"]>([
    "processing",
    "awaiting-input",
    "completed",
    "failed",
    "cancelled",
  ]);
  if (!allowedStatuses.has(data.status as JobReceipt["status"])) {
    throw malformedRequestResult(requestId, "status_invalid");
  }
  const status = data.status as JobReceipt["status"];
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  if ((httpStatus === 202 && terminal) || (httpStatus === 200 && !terminal)) {
    throw malformedRequestResult(requestId, "http_status_mismatch");
  }
  if (data.job_token !== undefined && !isOpaqueJobToken(data.job_token)) {
    throw malformedRequestResult(requestId, "job_token_invalid");
  }
  if (
    data.transaction_hash !== undefined &&
    (typeof data.transaction_hash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(data.transaction_hash))
  ) {
    throw malformedRequestResult(requestId, "transaction_hash_invalid");
  }
  if (data.summary !== undefined && typeof data.summary !== "string") {
    throw malformedRequestResult(requestId, "summary_invalid");
  }
  if (data.has_artifacts !== undefined && typeof data.has_artifacts !== "boolean") {
    throw malformedRequestResult(requestId, "has_artifacts_invalid");
  }
  if (
    data.artifact_count !== undefined &&
    (!Number.isSafeInteger(data.artifact_count) || (data.artifact_count as number) < 0)
  ) {
    throw malformedRequestResult(requestId, "artifact_count_invalid");
  }
  if (
    data.payload_in !== undefined &&
    data.payload_in !== "summary" &&
    data.payload_in !== "messages"
  ) {
    throw malformedRequestResult(requestId, "payload_in_invalid");
  }

  let receipt: SignedJobReceipt | undefined;
  if (data.receipt !== undefined) {
    if (
      !isSignedJobReceipt(data.receipt) ||
      data.receipt.job_id !== data.job_id ||
      !/^[0-9a-fA-F]{64}$/.test(data.receipt.receipt_pubkey) ||
      !/^[0-9a-fA-F]{128}$/.test(data.receipt.signature) ||
      (terminal && data.receipt.outcome !== status)
    ) {
      throw malformedRequestResult(requestId, "receipt_invalid");
    }
    receipt = data.receipt;
  }

  return {
    jobId: data.job_id,
    status,
    ...(typeof data.transaction_hash === "string"
      ? { transactionHash: data.transaction_hash }
      : {}),
    ...(typeof data.summary === "string" ? { summary: data.summary } : {}),
    ...(typeof data.has_artifacts === "boolean" ? { hasArtifacts: data.has_artifacts } : {}),
    ...(typeof data.artifact_count === "number" ? { artifactCount: data.artifact_count } : {}),
    ...(data.payload_in === "summary" || data.payload_in === "messages"
      ? { payloadIn: data.payload_in }
      : {}),
    ...(typeof data.job_token === "string" ? { jobToken: data.job_token } : {}),
    ...(receipt ? { receipt } : {}),
    ...parseFundingResponse(data),
  };
}

function malformedRequestResult(requestId: string, reason: string): DvmError {
  return new DvmError(
    "request_outcome_unknown",
    "The provider returned a malformed request recovery response.",
    "Do not submit or pay for a replacement. Retry the read-only lookup after the provider is fixed.",
    { request_id: requestId, status: "unknown", reason }
  );
}

/** Structural guard on `/v1/info`'s `builder` block — the receipt trust anchor. */
function parseTrustAnchor(value: unknown): ProviderInfo["builder"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const b = value as Record<string, unknown>;
  const attestation = b.attestation;
  const wellFormed =
    typeof b.pubkey === "string" &&
    typeof b.signature === "string" &&
    !!attestation &&
    typeof attestation === "object" &&
    !Array.isArray(attestation);
  return wellFormed ? (value as ProviderInfo["builder"]) : undefined;
}

function parseX402PaymentRequired(
  headers: Headers,
  body: Record<string, unknown>
): PaymentRequired | undefined {
  const v2 = headers.get("PAYMENT-REQUIRED");
  if (v2) {
    try {
      return decodePaymentRequiredHeader(v2);
    } catch {
      // A dual-serving server still supplied the legacy body. Falling through
      // keeps it payable without treating a damaged optional header as truth.
    }
  }
  if (body.x402Version !== X402_V1_VERSION || !Array.isArray(body.accepts)) return undefined;
  return {
    x402Version: X402_V1_VERSION,
    ...(typeof body.message === "string" ? { error: body.message } : {}),
    accepts: body.accepts as PaymentRequirementsV1[],
  };
}

function x402RequiredUsdcMicro(required: PaymentRequired | undefined): string | undefined {
  if (!required) return undefined;
  if (required.x402Version === X402_VERSION) {
    return required.accepts.at(0)?.amount;
  }
  return required.accepts.at(0)?.maxAmountRequired;
}

/** Message types that signal the end of a provider's turn (yield points). */
const YIELD_TYPES = new Set(["prompt", "payment-request", "working", "complete", "cancel"]);

async function parseSSEStream(res: Response, options?: StreamOptions): Promise<StreamResult> {
  const messages: Message[] = [];

  if (!res.body) {
    return { messages, reason: "error" };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastReason: StreamResult["reason"] = "yield";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on double-newline (SSE event boundary). Drain all buffered
      // events in this chunk before deciding to break — a fast DVM can emit
      // `working` immediately followed by `complete` in a single SSE write,
      // and stopping at the first yield would lose the terminal `complete`.
      let hitYield = false;
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
        if (!dataLine) continue;

        const json = dataLine.slice("data:".length).trim();
        try {
          const msg = JSON.parse(json) as Message;
          messages.push(msg);
          options?.onMessage?.(msg);

          if (YIELD_TYPES.has(msg.type)) {
            if (msg.type === "complete") lastReason = "complete";
            else if (msg.type === "cancel") lastReason = "cancel";
            else lastReason = "yield";
            hitYield = true;
          }
        } catch {
        }
      }
      if (hitYield) {
        // Server keeps the connection open on non-terminal yields
        // (working/payment-request/prompt) waiting for the caller to act —
        // cancel the reader so the connection closes promptly.
        reader.cancel().catch(() => undefined);
        return { messages, reason: lastReason };
      }
    }
  } catch {
    lastReason = "error";
  } finally {
    reader.releaseLock();
  }

  return { messages, reason: lastReason };
}

/**
 * Parse a DVM's structured error envelope from a non-2xx (non-402) body and
 * surface it as a `DvmError` carrying the DVM's own `code`, plus `display` and
 * `retryable` on `data`, with explicit provider origin for every prose field so
 * the JSON boundary marks it while preserving the machine fields. Returns
 * `null` for genuinely unstructured bodies
 * (HTML, plain text, JSON without a usable `error` code) — the caller falls
 * back to the generic `provider_error`.
 *
 * Recognises both wire shapes:
 * - nested `{ error: { code, display, hint } }` (from `/v1/quote` and the
 *   dynamic-price `/v1/job` path)
 * - flat `{ error: "<code>", message, hint, display, retryable }` (the payment
 *   rails' 503)
 *
 * The `invalid_input` / `invalid_quote_data` codes keep their existing
 * mapping — both collapse to `DvmError("invalid_input", ...)` with the
 * message/details fallback so callers can layer a `--param` / `-d` hint —
 * different endpoints, same root cause.
 */
function parseStructuredError(body: string): DvmError | null {
  const parsed = parseJsonObject(body);
  if (!parsed) return null;

  const err = parsed.error;

  if (err && typeof err === "object" && !Array.isArray(err)) {
    const e = err as Record<string, unknown>;
    if (typeof e.code !== "string") return null;
    return buildStructuredError(e.code, e);
  }

  if (typeof err !== "string") return null;

  // Input-validation rejections keep their dedicated code + message fallback.
  if (err === "invalid_input" || err === "invalid_quote_data") {
    const fields = {
      ...parsed,
      ...(typeof parsed.message !== "string" && typeof parsed.details === "string"
        ? { message: parsed.details }
        : {}),
    };
    return buildStructuredError("invalid_input", fields);
  }

  return buildStructuredError(err, parsed);
}

/**
 * Surface a 401 on a job read/write as the DVM's own structured
 * error rather than a generic `provider_error`, so the provider's marked `hint`
 * and `display` survive beside the code. Reachable from a current CLI whenever local job
 * state carries no token — `loadJob(...)?.jobToken` is routinely `undefined`.
 *
 * Narrowed to 401 deliberately: the other refusal on these paths is the
 * 404, whose body is the prose `{"error":"Job not found"}` and would
 * parse into a `DvmError` with "Job not found" as its machine code.
 */
function jobCredentialError(status: number, body: string): DvmError | null {
  if (status !== 401) return null;
  return parseStructuredError(body);
}

/**
 * Build a `DvmError` from a structured envelope's `code` and the surrounding
 * fields (`message`, `display`, `hint`, `retryable`). `display` and
 * `retryable` ride on `data` — where the CLI error boundary spreads them into
 * the JSON error object — and are only included when present and well-typed.
 */
function buildStructuredError(code: string, fields: Record<string, unknown>): DvmError {
  const display = typeof fields.display === "string" ? fields.display : undefined;
  const providerMessage = typeof fields.message === "string" ? fields.message : undefined;
  const message =
    providerMessage ?? display ?? "The provider returned an error without explanatory prose.";
  const hint = typeof fields.hint === "string" ? fields.hint : undefined;

  const data: Record<string, unknown> = {};
  if (display !== undefined) data.display = display;
  if (typeof fields.retryable === "boolean") data.retryable = fields.retryable;
  if (fields.status === "unknown") data.status = fields.status;
  if (typeof fields.request_id === "string") data.request_id = fields.request_id;
  if (fields.server_acceptance === "absent") data.server_acceptance = fields.server_acceptance;
  if (fields.payment_state === "unknown") data.payment_state = fields.payment_state;

  const detectedSources = providerProseSources(fields, data);
  const proseSources =
    display !== undefined && providerMessage === undefined
      ? { ...detectedSources, message: "provider" as const }
      : detectedSources;
  return new DvmError(
    code,
    message,
    hint,
    Object.keys(data).length > 0 ? data : undefined,
    undefined,
    proseSources
  );
}

/** Mark a mixed local-status/provider-body fallback as provider prose end to end. */
function providerResponseError(code: string, message: string): DvmError {
  return new DvmError(code, message, undefined, undefined, undefined, { message: "provider" });
}

/**
 * The router's display for an identity conflict, marked as provider prose. Only
 * the display is the router's: the message and hint beside it are this CLI's.
 */
function routerProse(structured: DvmError): {
  display?: string;
  proseSources?: DvmError["proseSources"];
} {
  const display = typeof structured.data?.display === "string" ? structured.data.display : undefined;
  return display !== undefined ? { display, proseSources: { display: "provider" } } : {};
}

function parseJsonObject(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The two 402 codes that mean "here is what the call costs" rather than "your
 * payment was rejected" — the only ones the SDK ever attaches `required_msats`
 * to (`payment.ts`'s upfront challenge and its short-pay body). A 402 matching
 * one of these becomes a `payment-required` receipt; everything else throws.
 * An `error`-less body (very old DVMs sent bare `{ required_msats }`) counts.
 *
 * Deliberately an allowlist rather than a denylist of rejection codes, because
 * the two errors cost very different amounts: mistaking a rejection for a quote
 * hands the agent a payable receipt for a payment the DVM has already refused,
 * while mistaking an off-spec quote for a rejection just surfaces the DVM's own
 * code and copy and stops. The trade-off is that a non-SDK DVM quoting under
 * its own code (`{ error: "insufficient_funds", required_msats }`) throws where
 * a denylist would have kept it payable; no such DVM exists pre-launch, and the
 * fix when one appears is to widen this list.
 */
function isReceipt402(code: unknown): boolean {
  return code === undefined || code === "payment_required" || code === "payment_insufficient";
}

/**
 * Turn a payment-error body (402, or the 409 replay rejection) into a
 * `DvmError` carrying the DVM's own machine `code` plus its `display`/`hint`/
 * `retryable`.
 *
 * Whatever code the DVM names is passed through without an allowlist.
 * Servers that predate enriched bodies keep absent prose absent rather than
 * selecting trusted copy from an untrusted code.
 */
function buildPaymentError(errorBody: Record<string, unknown>): DvmError {
  const code = typeof errorBody.error === "string" ? errorBody.error : "payment_insufficient";
  return buildStructuredError(code, errorBody);
}

/**
 * Build the rail payment headers for a `/v1/job` or `/v1/credit` POST. Async
 * only for the lazy `mppx` import on the credential path.
 */
async function paymentHeaders(payment?: Payment): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (payment?.cashuToken) {
    headers["X-Cashu"] = payment.cashuToken;
  }
  if (payment?.cashuRequestId) {
    headers["X-Cashu-Request-Id"] = payment.cashuRequestId;
  }
  if (payment?.x402Payment) {
    headers[payment.x402Version === X402_VERSION ? "PAYMENT-SIGNATURE" : "X-PAYMENT"] =
      payment.x402Payment;
  }
  if (payment?.mppCredentialRaw) {
    headers.Authorization = payment.mppCredentialRaw;
  } else if (payment?.mppCredential) {
    const { Credential } = await import("mppx");
    // `Credential.serialize` already returns the full `Payment <credential>`
    // Authorization value (scheme token + base64url payload). Do not re-prefix.
    headers.Authorization = Credential.serialize(payment.mppCredential);
  }
  return headers;
}

/**
 * Micro-denominated context fields a credit-ledger refusal carries
 * (`insufficient_credit`'s shortfall, `credit_over_max`'s fundable ceiling,
 * `funding_commitment_mismatch`'s own valuation of the attached artifact, …).
 * `buildStructuredError` deliberately drops unknown fields; the credit
 * recovery path needs these numbers, so they are re-attached here — on the
 * 402/`/v1/credit` error paths only, leaving every other error surface as-is.
 */
const CREDIT_CONTEXT_FIELDS = [
  "remaining_micro",
  "shortfall_micro",
  "balance_micro",
  "expiry_ms",
  "fundable_micro",
  // without this the fund-and-draw correction belt is left regexing
  // a `message` the protocol declares non-contractual.
  "expected_micro",
  // `below_rail_minimum` states the rail's floor here — the number
  // the caller resizes against or falls back to another rail over.
  "min_micro",
] as const;

/**
 * Re-attach credit context (micro fields + the funding menu) from a payment
 * error body onto the `DvmError` about to be thrown, so the caller's
 * `insufficient_credit` fund-and-retry can size a top-up without a second
 * round trip. No-op for bodies carrying none of the fields.
 *
 * The Lightning funding leg rides the same channel: its bolt11
 * arrives on a `lightning_settlement_pending` **402**, so without this the
 * invoice the float exists to pay would be dropped by `buildStructuredError`
 * along with every other unknown field.
 */
function withCreditErrorContext(err: DvmError, body: Record<string, unknown>): DvmError {
  const extra: Record<string, unknown> = {};
  for (const key of CREDIT_CONTEXT_FIELDS) {
    if (typeof body[key] === "number") extra[key] = body[key];
  }
  const menu = parseCreditMenu(body.credit);
  if (menu) extra.credit = menu;
  const lightning = parseLightningOffer(body.lightning);
  if (lightning) extra.lightning = lightning;
  // The ids the retry must re-state verbatim: a funding is idempotent on
  // `(credit_id, fund_id)`, and the server derives `credit_id` when the caller
  // didn't name one — so its answer is the only place that pairing exists.
  // The credit binding fields name the rail, instrument and reusable channel
  // an existing credit is bound to. A caller whose local record lost the pin
  // heals from them in one hop; `bound_credit_id` identifies a channel owner.
  // `rail` names which rail a `below_rail_minimum` refusal is about.
  // `settlement_drain_id` is the drain id a wedged channel's `settlement_pending`
  // admits — the one id that finishes the reclaim, which the CLI adopts rather
  // than minting another into the same gate.
  for (const key of [
    "credit_id",
    "fund_id",
    "drain_id",
    "credit_rail",
    "credit_instrument",
    "credit_channel_id",
    "bound_credit_id",
    "rail",
    "settlement_drain_id",
  ] as const) {
    if (typeof body[key] === "string") extra[key] = body[key];
  }
  // `drain_registered` says whether the caller keeps a drain id on record for
  // this credit — usually because the server holds the id just posted in a
  // `credit_drains` row, but equally because a wedged settlement row holds one as
  // its `effect_id`, which is what the operator repair books the drain under: the
  // posted id itself on an x402 payout-floor refusal, and the id in
  // `settlement_drain_id` on `settlement_pending`. `drain_id_retired`
  // says the posted id will never be taken again, whatever the answer to the
  // first. Two questions, two fields — a refusal can register nothing
  // and still want an id kept. `credential_refresh_required` is the server's
  // explicit authorization to replace only an expired Tempo close credential
  // while preserving the registered drain and channel.
  for (const key of [
    "drain_registered",
    "drain_id_retired",
    "credential_refresh_required",
  ] as const) {
    if (typeof body[key] === "boolean") extra[key] = body[key];
  }
  // `lightning_unavailable` names the rails that do work, so a caller can fall
  // back without re-reading the menu; `below_rail_minimum` does the same as
  // `alternatives`.
  for (const key of ["funding", "alternatives"] as const) {
    const rails = body[key];
    if (Array.isArray(rails) && rails.every((r) => typeof r === "string")) {
      extra[key] = rails;
    }
  }
  if (Object.keys(extra).length === 0) return err;
  return new DvmError(
    err.code,
    err.message,
    err.hint,
    { ...err.data, ...extra },
    err.display,
    err.proseSources
  );
}

/**
 * Parse the `lightning` block off a credit-funding 402. Gated on the
 * two fields a payment cannot proceed without — the invoice itself and the
 * amount the budget check prices — so a malformed block never reaches the float
 * as a bolt11 with an `undefined` amount.
 */
function parseLightningOffer(raw: unknown): LightningFundingOffer | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const block = raw as Record<string, unknown>;
  if (typeof block.invoice !== "string" || block.invoice.length === 0) return undefined;
  if (typeof block.amount_msats !== "number" || block.amount_msats <= 0) return undefined;
  return block as unknown as LightningFundingOffer;
}

/**
 * Parse the `upfront` envelope from a `/v1/quote` response. New servers send
 * `{ upfront: { amount, currency } }`; some older servers send
 * `{ price_msats }` only — we synthesise an upfront
 * via the local fx fetcher when the new field is missing. When neither is
 * available, returns `{ amount: 0, currency: "usd" }` so the CLI can still
 * render something meaningful.
 *
 * `amount_micro` rides through verbatim when the provider states it
 * — the exact integer a fund-and-draw must value against, which is not always
 * recoverable from `amount`. Snake_case like the rest of this block: `upfront`
 * is relayed to `dvm quote --json` unmodified, so it has to read as the wire.
 */
function parseUpfront(data: Record<string, unknown>): Quote["upfront"] {
  const raw = data.upfront;
  if (raw && typeof raw === "object") {
    const u = raw as { amount?: unknown; currency?: unknown; amount_micro?: unknown };
    if (typeof u.amount === "number" && typeof u.currency === "string") {
      const amountMicro = exactMicro(u.amount_micro);
      return {
        amount: u.amount,
        currency: u.currency,
        ...(amountMicro && { amount_micro: amountMicro }),
      };
    }
  }
  // Legacy fallback — recompute USD from price_msats locally. The CLI uses
  // this for display only; the binding sats arrives via the 402 handshake.
  return { amount: 0, currency: "usd" };
}

/**
 * Narrow a provider-stated exact micro price. Anything that isn't a
 * positive safe integer is treated as absent rather than coerced — a bad figure
 * here signs a `fund.amount_micro` the provider will refuse, so the rounded
 * decimal is the better fallback.
 */
function exactMicro(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
}

/**
 * Derive the advisory sats display for a quote. Prefers the upfront × current
 * fx; falls back to legacy `price_msats` when present (for the lower-level
 * shim). Returns `undefined` when neither is available — display layer renders
 * `~? sats`.
 */
async function deriveAdvisorySats(
  upfront: Quote["upfront"],
  data: Record<string, unknown>
): Promise<number | undefined> {
  if (typeof data.price_msats === "number") return data.price_msats;
  if (upfront.currency !== "usd" || upfront.amount <= 0) return undefined;
  try {
    const rate = await fetchBtcUsdRate();
    return usdToMsats(upfront.amount, rate);
  } catch {
    return undefined;
  }
}
