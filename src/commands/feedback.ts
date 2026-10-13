import {
  DvmError,
  loadReceipt,
  type JobReceipt,
  normalizeFeedbackEndpointHost,
  signRequestData,
} from "@dvmkit/sdk/internal";
import {
  FEEDBACK_POSTURES,
  type FeedbackPosture,
  isFeedbackPosture,
  loadConfig,
  updateConfig,
} from "../lib/identity";
import {
  findSigningIdentityByPubkey,
  resolveSigningIdentity,
} from "../lib/cli-identity-resolve";
import {
  info,
  json,
} from "../lib/output";
import {
  loadJob,
} from "../lib/job-store";

import { resolveBodyFlag } from "../lib/body-flag";
import { submitFeedback } from "../lib/caller-platform-client";
import { effectiveFeedbackPosture, recordFeedbackSent } from "../lib/feedback-nudges";
import { getPlatformUrl } from "../lib/platform";

export interface FeedbackOptions {
  /** Target a specific DVM by immutable ID. Mutually exclusive with `--job`. */
  dvm?: string;
  /** Target a specific previously-submitted job; resolves local receipt, router claim and trace context. */
  job?: string;
  verdict?: string;
  as?: string;
  /** Human-readable output mode (stderr); default is JSON on stdout. */
  human?: boolean;
  /** Feedback text: literal, `@path/to/file`, or `@-` for stdin. Mutually exclusive with positional body args. */
  body?: string;
  /**
   * Set the global feedback-nudge posture (a value), or print the effective
   * one (bare flag, arriving as `true`). Mutually exclusive with submitting
   * feedback.
   */
  posture?: string | boolean;
}

type Scope = "platform" | "dvm" | "job";

/**
 * Submit caller feedback to the dvmkit platform. One of three
 * shapes: platform-level (no flags), DVM-level (`--dvm <dvm-id>`), or
 * job-level (`--job <jobId>`), with an optional receipt-backed verdict.
 */
export async function feedback(bodyParts: string[], opts: FeedbackOptions): Promise<void> {
  if (opts.posture !== undefined) {
    // The posture verb is a config read/write, not a submission — mixing the
    // two would leave it ambiguous whether feedback was sent. `--as` is
    // rejected too: the posture is one global setting, not per-identity.
    if (
      opts.dvm != null ||
      opts.job != null ||
      opts.body != null ||
      opts.as != null ||
      opts.verdict != null ||
      bodyParts.length > 0
    ) {
      throw new DvmError(
        "bad_arguments",
        "`--posture` cannot be combined with submitting feedback.",
        "Run 'dvm feedback --posture [ask|auto|off]' on its own — with a value to set the posture, without one to read it."
      );
    }
    await feedbackPosture(opts.posture, opts.human);
    return;
  }

  if (opts.dvm != null && opts.job != null) {
    throw new DvmError(
      "bad_arguments",
      "`--dvm` and `--job` are mutually exclusive.",
      "Pick one: target a DVM directly with `--dvm <dvm-id>`, or a specific job with `--job <jobId>`."
    );
  }

  if (opts.verdict !== undefined) {
    if (opts.job == null) {
      throw new DvmError(
        "verdict_requires_job",
        "`--verdict` requires `--job`.",
        "Run 'dvm feedback --job <job-id> --verdict up|down [note]'."
      );
    }
    if (opts.verdict !== "up" && opts.verdict !== "down") {
      throw new DvmError(
        "invalid_argument",
        `Unknown feedback verdict '${opts.verdict}'.`,
        "Pass '--verdict up' or '--verdict down'."
      );
    }
  }

  if (opts.body != null && bodyParts.length > 0) {
    throw new DvmError(
      "bad_arguments",
      "Positional body text and `--body` are mutually exclusive.",
      `Pick one: dvm feedback "short text" for interactive use, or dvm feedback --body @- / --body @file for longer or programmatic feedback.`
    );
  }

  let body: string;
  if (opts.body != null) {
    body = await resolveBodyFlag(opts.body);
  } else {
    body = bodyParts.join(" ").trim();
    if (body.length === 0 && opts.verdict === undefined) {
      throw new DvmError(
        "bad_arguments",
        "Feedback body is required.",
        `Run: dvm feedback "what you want to say", or dvm feedback --body @- for piped input.`
      );
    }
  }

  let receipt: JobReceipt | undefined;
  let jobPubkey: string | undefined;

  let dvmId: string | undefined;
  let feedbackClaim: string | undefined;
  let feedbackEndpointHost: string | undefined;
  let traceId: string | undefined;
  let scope: Scope;
  let warnMissingTrace = false;
  // the handle a successful send is recorded under, quieting the
  // nudges for that DVM. For `--job` it is the job record's own `dvmId` — the
  // same key the nudge triggers use — so the nudge → send → quiet loop closes.
  let nudgeQuietKey: string | undefined;

  if (opts.job != null) {
    const stored = loadJob(opts.job);
    if (!stored) {
      throw new DvmError(
        "job_not_found",
        `Job ${opts.job} not found in local state.`,
        "Submit it first with `dvm request` (or pass `--dvm <dvm-id>` for DVM-level feedback)."
      );
    }
    if (opts.verdict !== undefined) {
      receipt = loadReceipt(opts.job)?.receipt ?? stored.receipt;
      jobPubkey = receipt?.requester_pubkey ?? undefined;
    }
    if (!stored.feedbackClaim && !receipt) {
      throw new DvmError(
        "platform_dvm_id_unavailable",
        `Job ${opts.job} does not contain a routed feedback claim.`,
        "Feedback for a job requires one submitted through the dvmkit platform router. Submit DVM-level feedback with --dvm <dvm-id> instead."
      );
    }
    feedbackClaim = stored.feedbackClaim;
    if (feedbackClaim) {
      feedbackEndpointHost = normalizeFeedbackEndpointHost(stored.endpoint) ?? undefined;
    }
    if (feedbackClaim && !feedbackEndpointHost) {
      throw new DvmError(
        "platform_dvm_id_unavailable",
        `Job ${opts.job} does not contain a valid submitted endpoint.`,
        "Feedback for a job requires one submitted through the dvmkit platform router. Submit DVM-level feedback with --dvm <dvm-id> instead."
      );
    }
    if (stored.traceId) {
      traceId = stored.traceId;
    } else {
      warnMissingTrace = true;
    }
    nudgeQuietKey = stored.dvmId;
    scope = "job";
  } else if (opts.dvm != null) {
    dvmId = opts.dvm;
    // No quiet-key here: `--dvm` takes the immutable dvm_id while nudge state
    // is keyed by the caller's handle, so a record under it would never match.
    scope = "dvm";
  } else {
    scope = "platform";
  }

  const explicitIdentity = opts.as !== undefined || Boolean(process.env.DVM_IDENTITY_KEY);
  const signer = jobPubkey && !explicitIdentity
    ? findSigningIdentityByPubkey(jobPubkey)
    : resolveSigningIdentity({ as: opts.as, config: loadConfig() });
  if (!signer) {
    throw new DvmError(
      "auth_required",
      "The identity that submitted this job is no longer configured.",
      "Restore that signing identity before rating the job. A different identity cannot prove ownership of its receipt."
    );
  }
  const identityWarning = receipt && jobPubkey && signer.pubkey !== jobPubkey
    ? "The selected identity differs from the job's requester. The platform will refuse this receipt."
    : undefined;
  if (identityWarning) info(`Warning: ${identityWarning}`);

  const payload: Record<string, unknown> = { body };
  if (opts.job !== undefined) payload.job_id = opts.job;
  if (opts.verdict !== undefined) payload.verdict = opts.verdict;
  // The receipt signature covers unknown fields too; forward the stored object intact.
  if (receipt !== undefined) payload.receipt = receipt;
  if (dvmId !== undefined) payload.dvm_id = dvmId;
  if (feedbackClaim !== undefined) payload.feedback_claim = feedbackClaim;
  if (feedbackEndpointHost !== undefined) payload.feedback_endpoint_host = feedbackEndpointHost;
  if (traceId !== undefined) payload.trace_id = traceId;

  const envelope = signRequestData(signer.privkey, payload);
  const platformUrl = getPlatformUrl();
  const result = await submitFeedback(platformUrl, envelope);
  // A successful send quiets the full nudges for this DVM for 30 days.
  if (nudgeQuietKey) recordFeedbackSent(nudgeQuietKey);
  const attributedDvmId = result.dvm_id ?? dvmId;
  const attributedJobId = result.job_id ?? null;

  const unverifiedHint = opts.verdict !== undefined && !receipt
    ? "No receipt is stored for this job, so the verdict was recorded as an unverified claim and does not count toward the provider's public record."
    : undefined;
  const warning = [
    ...(warnMissingTrace ? ["no local trace_id for the referenced job"] : []),
    ...(identityWarning ? [identityWarning] : []),
  ].join(" ");

  if (opts.human) {
    info(`Feedback received (id=${result.id}).`);
    info(`Scope: ${scope}${attributedDvmId ? ` — ${attributedDvmId}` : ""}.`);
    if (opts.verdict !== undefined) info(`Verdict: ${opts.verdict}. Tier: ${result.tier ?? "unknown"}.`);
    if (unverifiedHint) info(unverifiedHint);
    if (warnMissingTrace) {
      info("Warning: no local trace_id for that job — submitted without trace context.");
    }
  } else {
    json({
      id: result.id,
      created_at: result.created_at,
      scope,
      dvm_id: attributedDvmId ?? null,
      job_id: attributedJobId,
      trace_id: traceId ?? null,
      verdict: opts.verdict ?? null,
      tier: opts.verdict !== undefined ? result.tier ?? null : null,
      ...(unverifiedHint ? { hint: unverifiedHint } : {}),
      ...(warning ? { warning } : {}),
    });
  }
}


/**
 * `dvm feedback --posture`: with a value, set the global
 * feedback-nudge posture; bare, print the effective posture and where it came
 * from. Mirrors `dvm credit posture`'s echo shape — the write is the whole
 * command, so it reports the resulting posture rather than making the caller
 * run a second read.
 */
async function feedbackPosture(value: string | boolean, human?: boolean): Promise<void> {
  // A bare `--posture` arrives as `true`; there is no negated form, so any
  // boolean means "read the effective posture".
  if (typeof value === "boolean") {
    const effective = effectiveFeedbackPosture(loadConfig());
    emitFeedbackPosture(
      effective.posture,
      effective.source,
      `Feedback nudges are '${effective.posture}'${effective.source === "default" ? " (the default; nothing is set in config)" : ""} — ${postureSentence(effective.posture)}`,
      human
    );
    return;
  }

  const posture = value.trim().toLowerCase();
  if (!isFeedbackPosture(posture)) {
    throw new DvmError(
      "invalid_argument",
      `Unknown feedback posture '${value}'.`,
      `Pass one of ${FEEDBACK_POSTURES.join(", ")} — 'ask' nudges and waits for your user's yes before anything is sent, 'auto' nudges and sends without asking, 'off' emits no nudges at all.`
    );
  }
  await updateConfig({
    reason: "feedback_posture",
    patch: (current) => ({ set: { feedback: { ...(current?.feedback ?? {}), posture } } }),
  });
  emitFeedbackPosture(
    posture,
    "global",
    `Feedback nudges are now '${posture}' — ${postureSentence(posture)}`,
    human
  );
}

function emitFeedbackPosture(
  posture: FeedbackPosture,
  source: "default" | "global",
  display: string,
  human?: boolean
): void {
  if (human) {
    info(display);
    return;
  }
  json({
    posture,
    source,
    display,
    hint: "Set it with 'dvm feedback --posture ask|auto|off'; bare '--posture' reads it back.",
  });
}

/** The clause after the posture name — what each setting actually does. */
function postureSentence(posture: FeedbackPosture): string {
  switch (posture) {
    case "ask":
      return "high-signal job terminals invite feedback, and sending waits for your user's yes.";
    case "auto":
      return "high-signal job terminals invite feedback, and it is sent without asking first.";
    case "off":
      return "no nudges at all. 'dvm feedback' still works when called directly.";
  }
}
