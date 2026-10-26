import { providerFields } from "../lib/provider-output";
import { fundingRailLabel, isPaymentRailKey, paymentRailLabel } from "../lib/rail-labels";
import { formatFiat, SIGNED_REQUEST_AUTH_ID } from "@dvmkit/sdk";
import {
  asProviderText,
  DvmError,
  fetchBtcUsdRate,
  isCreditFundRail,
  loadCredit,
  loadReceipts,
  signDvmRequestData,
  signedRequestDomain,
} from "@dvmkit/sdk/internal";
import {
  info,
  json,
} from "../lib/output";
import {
  loadConfig,
} from "../lib/identity";
import {
  resolveSigningIdentity,
} from "../lib/cli-identity-resolve";
import { automaticCreditBoundRail, planProbeDraw } from "../lib/credit-policy";

import { repeatUseCreditHint } from "../lib/credit-guidance";
import { computeHeadroom, headroomDisplay, headroomJson } from "../lib/credit-headroom";
import {
  buildCreditDrawSkipped,
  noteCreditDrawSkipped,
  takeCreditNoticeFields,
} from "../lib/credit-notice";
import { providerDvmIdentity } from "../lib/credit-per-dvm";
import { localCreditRouteAvailability } from "../lib/credit-route-availability";
import { resolveDataFlag } from "../lib/data-flag";
import { formatIdentifier, resolveCapability, resolveDvmReference } from "../lib/dvm-identifier";
import { resolveEndpoint } from "../lib/favorites";
import { withInputSchemaHint } from "../lib/input-schema-hint";
import { buildJobEnvelope, paramsToData } from "../lib/job-envelope";
import { progressNotice } from "../lib/progress-notice";
import { applyJsonSchemaDefaults, formatAppliedDefaults } from "../lib/schema-defaults";
import { createDvmTransport } from "../lib/transport";
import { warmupProvider } from "../lib/warmup-provider";
import { dvmIdentity } from "./dvm-identity";

export interface QuoteOptions {
  input?: string;
  data?: string;
  /**
   * DVM or DVM/capability identifier. One of `dvm` or `endpoint`
   * must be set. The slash form pins the capability; otherwise it auto-fills
   * against a single-capability DVM or errors when ambiguous.
   */
  dvm?: string;
  endpoint?: string;
  param?: string[];
  outputType?: string;
  human?: boolean;
  /**
   * Caller signing identity to use when the DVM advertises descriptor auth
   * Same resolution chain as `dvm request`. Ignored on DVMs that
   * don't require signed requests.
   */
  as?: string;
}

export async function quote(opts: QuoteOptions): Promise<void> {
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

  // --param (and --data) are the agent-friendly forms for structured-input
  // DVMs; --input is only required when neither is provided.
  if (!opts.input && !opts.data && !(opts.param && opts.param.length > 0)) {
    throw new DvmError(
      "no_input",
      "No input provided.",
      "Use --input <text>, --data <json>, or --param k=v (repeatable) to describe the job."
    );
  }

  let data: Record<string, unknown> | undefined;
  if (opts.data) {
    data = (await resolveDataFlag(opts.data)).data;
  } else if (opts.param && opts.param.length > 0) {
    // synthesise `data` from `--param` up-front so schema-default
    // application and request signing both see the agent-friendly form.
    // Keeps the on-the-wire shape unchanged — `buildJobEnvelope` still emits
    // `envelope.params` separately when --param is set.
    data = paramsToData(opts.param);
  }

  const transport = createDvmTransport();
  const ref = { endpoint };

  // fetch /v1/info to pin the capability before quoting. /v1/quote
  // rejects requests without `capability`, so the CLI must resolve it the
  // same way `dvm request` does — bare-DVM → auto-fill, slash form → validate.
  // Wrap the probe in the same warmup timeout / observability shape that
  // `dvm request` uses so cold-start providers fail with `endpoint_unreachable`
  // instead of wedging on fetch's default 0-timeout.
  const WARMUP_TIMEOUT_MS = 30_000;
  const warmupStart = Date.now();
  // Retry the pre-payment /v1/info probe on transient failures. The first-party
  // fleet runs Fly autostop=suspend, so this probe can land mid-resume
  // and come back truncated / non-JSON / 502. warmupProvider retries within
  // the same budget (safe — GET, no money).
  let providerInfo;
  try {
    providerInfo = await warmupProvider(transport, ref, { budgetMs: WARMUP_TIMEOUT_MS });
  } catch (err) {
    transport.close();
    throw err;
  }
  const warmupMs = Date.now() - warmupStart;
  if (opts.human && warmupMs > 1000) {
    info(`Provider woke up in ${(warmupMs / 1000).toFixed(1)}s.`);
  }
  const dvmId = canonicalDvmId;
  const capability = resolveCapability(providerInfo, requestedCapability, dvmId);
  const identifier = dvmId ? formatIdentifier(dvmId, capability) : endpoint;
  if (opts.human) info(`Quoting ${identifier}...`);

  // fill top-level JSON-Schema `default` values from the DVM's
  // advertised input schema so a minimal call (e.g. `--data '{"url":"..."}'`)
  // doesn't require the caller to spell out every defaulted field. Capability-
  // scoped schema wins; falls back to the top-level `inputSchema` for the
  // legacy single-capability shape. Defaults must fill BEFORE `signRequestData`
  // below — the server canonicalises the full wire body when verifying, so
  // any field added after signing would break signature verification.
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

  // auto-sign when the DVM advertises descriptor auth. Mirrors
  // `dvm request`. The quote path verifies but does not consume the nonce
  // server-side (see `verifyForQuote` in server SDK signed-request.ts).
  const config = loadConfig();
  let signerPubkey: string | undefined;
  if (
    providerInfo.auth?.includes(SIGNED_REQUEST_AUTH_ID) ||
    providerInfo.auth?.includes("secp256k1-schnorr")
  ) {
    const signer = resolveSigningIdentity({ as: opts.as, config });
    signerPubkey = signer.pubkey;
    data = signDvmRequestData(
      signer.privkey,
      data ?? {},
      signedRequestDomain({
        provider: providerInfo,
        endpoint,
        method: "POST",
        path: "v1/quote",
        capability,
      })
    );
    if (opts.human) info(`Signed as ${signer.pubkey}.`);
  }

  const envelope = buildJobEnvelope({
    capability,
    input: opts.input ?? "",
    params: opts.param,
    data,
    outputType: opts.outputType,
  });

  progressNotice("Requesting quote...", opts.human);
  const usedPrimitiveInput = !!opts.input && !opts.data && !(opts.param && opts.param.length > 0);
  const quotes = await withInputSchemaHint(
    transport,
    ref,
    {
      capability,
      identifier,
      command: "quote",
      usedPrimitiveInput,
      primitiveInput: opts.input,
      callerRef,
      callerFlag: opts.dvm ? "dvm" : "endpoint",
    },
    () => transport.quote(ref, envelope)
  );

  if (quotes.length === 0) {
    throw new DvmError("no_quotes", "No quotes received from provider.");
  }

  // JSON output relays the wire envelope verbatim (no sats —
  // binding settlement lands via the 402 handshake at `/v1/job`). The
  // `--human` branch derives an advisory sats line client-side from the
  // transport-populated `priceMsats` (current fx × upfront amount).
  const q = quotes[0];
  const attestedIdentity = providerDvmIdentity(providerInfo);
  const stored = signerPubkey ? loadCredit(endpoint, signerPubkey, attestedIdentity) : undefined;
  // The transport already derived `priceMsats` from this quote's fiat amount.
  // Recover that same advisory rate for a local proof-coverage check instead
  // of adding another network/cache read to a read-only quote.
  const routeBtcRate =
    q.priceMsats > 0 && q.upfront.amount > 0
      ? (q.upfront.amount * 100_000_000_000) / q.priceMsats
      : undefined;
  // A quote declares no request budget, so the probe's documented zero-ceiling
  // posture leaves the last-price proxy unenforced. The status/posture checks
  // still tell the caller whether this held balance would be drawn at all.
  const probePlan = planProbeDraw({
    stored,
    drawCeilingMsats: 0,
    drawCeilingSource: "budget",
    btcRate: routeBtcRate ?? 0,
    config: config?.credit,
    ...(attestedIdentity ? { identity: attestedIdentity } : {}),
  });
  if (probePlan.mode === "none" && probePlan.drawSkipped) {
    noteCreditDrawSkipped(
      buildCreditDrawSkipped({
        dvm: dvmId ?? endpoint,
        endpoint,
        skip: probePlan.drawSkipped,
      }),
      opts.human
    );
  }
  const receipts = q.credit ? loadReceipts() : [];
  const boundRail = automaticCreditBoundRail(stored);
  const headroomBase = q.credit
    ? computeHeadroom({
        endpoint,
        receipts,
        signingPubkey: signerPubkey,
        ...(attestedIdentity ? { identity: attestedIdentity } : {}),
        menu: q.credit,
        config: config?.credit,
        builderPubkey: providerInfo.builder?.pubkey ?? stored?.builderPubkey,
        balanceMicro: q.credit.remaining_micro ?? stored?.remainingMicro ?? 0,
        ...(boundRail ? { boundRail } : {}),
      })
    : undefined;
  const creditHeadroom =
    q.credit && headroomBase
      ? computeHeadroom({
          endpoint,
          receipts,
          signingPubkey: signerPubkey,
          ...(attestedIdentity ? { identity: attestedIdentity } : {}),
          menu: q.credit,
          config: config?.credit,
          builderPubkey: providerInfo.builder?.pubkey ?? stored?.builderPubkey,
          balanceMicro: q.credit.remaining_micro ?? stored?.remainingMicro ?? 0,
          routeAmountMicro: headroomBase.routeAmountMicro,
          ...(boundRail ? { boundRail } : {}),
          routeAvailability: localCreditRouteAvailability({
            menu: q.credit,
            providerInfo,
            config,
            amountMicro: headroomBase.routeAmountMicro,
            btcRate: routeBtcRate,
          }),
        })
      : undefined;

  if (opts.human) {
    await fetchBtcUsdRate().catch(() => null);
    const advisorySats = q.priceMsats;
    const advisorySatsDisplay =
      advisorySats > 0 ? `${Math.round(advisorySats / 1000).toLocaleString("en-US")} sats` : null;
    const fiatDisplay = formatFiat(q.upfront.amount, q.upfront.currency);
    info(`Quote: ${q.description}`);
    info(
      `  ${fiatDisplay}${advisorySatsDisplay ? ` (~${advisorySatsDisplay} — advisory; binding sats settles at job submission)` : ""}`
    );
    if (q.hint) info(`  ${q.hint}`);
    if (q.expiresAt) {
      const remaining = q.expiresAt - Math.floor(Date.now() / 1000);
      info(remaining > 0 ? `  Expires in ${String(remaining)}s` : "  Expired");
    }
    // lead with the question a caller actually asks — "if this job
    // fails, am I out the money?" — and keep the per-rail map beneath it as the
    // narrower supporting fact. Since a failed job releases its draw
    // rather than settling it, so no debit lands either way and the rail's
    // inability to reverse stopped being the whole answer. What decides whether
    // the caller can reach the released value is the funding menu riding on this
    // quote (`q.credit`) — that block is what exposes `POST /v1/credit` op
    // `drain`. Deliberately two-state: at an auth-declaring DVM with no menu the
    // balance is the caller's per the protocol, but `dvm` can't reach it yet
    // — revisit this copy when that ships.
    const payment = q.payment;
    if (payment && payment.methods.length > 0) {
      const reversible = railList(
        payment.methods.filter((m) => payment.refundable[m]),
        isPaymentRailKey,
        paymentRailLabel
      );
      const final = railList(
        payment.methods.filter((m) => !payment.refundable[m]),
        isPaymentRailKey,
        paymentRailLabel
      );
      info("  If this job fails:");
      info(
        q.credit
          ? "    You are not debited — the payment stays as credit here, spendable on your next job or reclaimable with 'dvm credit drain <dvm>'."
          : "    The payment is not recoverable here — no prepaid credit is on offer to reclaim from."
      );
      if (reversible.length > 0) {
        info(
          `    ${reversible.join(", ")} — reverses at the rail on failure (operator's discretion)`
        );
      }
      if (final.length > 0) {
        info(`    ${final.join(", ")} — settles finally: no rail hands value back`);
      }
    }
    if (q.credit) {
      const min = formatFiat(q.credit.min_micro / 1_000_000, q.credit.currency);
      const max = formatFiat(q.credit.max_micro / 1_000_000, q.credit.currency);
      // The funding menu is a *funding*-rail list, not a per-call one — it
      // legitimately carries `lightning`, which the old private table had no
      // case for and printed raw.
      const funding = railList(q.credit.funding, isCreditFundRail, fundingRailLabel);
      info(
        `  Prepaid credit offered: fund ${min}–${max}${funding.length > 0 ? ` over ${funding.join("/")}` : ""}`
      );
      if (typeof q.credit.remaining_micro === "number") {
        info(
          `  Your balance here: ${formatFiat(q.credit.remaining_micro / 1_000_000, q.credit.currency)}${probePlan.mode === "draw" ? " spendable" : ""}`
        );
      }
      info(`  ${repeatUseCreditHint(callerRef)}`);
      if (creditHeadroom) info(`  ${headroomDisplay(creditHeadroom)}`);
    }
  } else {
    json({
      ...dvmIdentity(dvmId, capability),
      upfront: q.upfront,
      description: asProviderText(q.description),
      ...(q.hint ? { hint: asProviderText(q.hint) } : {}),
      ...(q.shape ? { shape: q.shape } : {}),
      ...(q.rate ? { rate: q.rate } : {}),
      ...(q.mints ? { mints: q.mints } : {}),
      ...(q.expiresAt ? { expiresAt: q.expiresAt } : {}),
      ...(q.payment ? { payment: q.payment } : {}),
      // the prepaid-credit funding menu + balance echo, verbatim
      // wire shape — an agent holding a credit sees cost and remaining
      // balance in one round trip.
      ...(q.credit
        ? {
            credit: q.credit,
            credit_hint: repeatUseCreditHint(callerRef),
            ...(creditHeadroom ? { credit_headroom: headroomJson(creditHeadroom) } : {}),
          }
        : {}),
      // show the post-defaults payload so an agent that called with
      // a minimal `--data` can see (and cache) what the server actually
      // validated against. Only emitted when defaults were filled — keeps
      // existing JSON output unchanged for callers that already pass the
      // full payload. Uses pre-sign merged data so signature material
      // doesn't leak into the diagnostic.
      ...(normalizedInput && Object.keys(appliedDefaults).length > 0
        ? providerFields({ normalized_input: providerFields(normalizedInput, Object.keys(appliedDefaults)), applied_defaults: appliedDefaults }, ["applied_defaults"])
        : {}),
      ...takeCreditNoticeFields(),
    });
  }

  transport.close();
}

/**
 * Gloss a rail list that arrived off the wire.
 *
 * `payment.methods` and `credit.funding` are `string[]`: the provider chose
 * those strings, not this build. Narrow before glossing, so a rail we don't
 * carry is dropped rather than printed as a raw wire key that reads like a
 * product name — and dedupe, because more than one key can gloss to one noun.
 */
function railList<T extends string>(
  keys: string[],
  isKnown: (value: unknown) => value is T,
  label: (rail: T) => string
): string[] {
  return [...new Set(keys.filter(isKnown).map(label))];
}
