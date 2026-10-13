/**
 * What a finished job says about telling the builder how it went.
 *
 * Two payloads, one deferred-field sink, mirroring `credit-notice.ts`: both
 * are produced at the moment the CLI learns a job is over, and both have to
 * reach the *terminal* output, which is emitted several call frames later and
 * in one of many places. The full nudge's prose goes to stderr at that moment
 * in both output modes, and the structured block is stashed here for the
 * terminal emission to spread in with {@link takeFeedbackNoticeFields}. The
 * micro-nudge is agent-facing only, so it gets no stderr line — it must not
 * nag a human reading `--human` output.
 *
 * `take` clears: the fields land on exactly one output line, so every terminal
 * emission can spread them without any of them having to know whether another
 * one already did.
 *
 * Copy rules, all load-bearing and all pinned by test: the nudge **offers**
 * rather than instructs, carries no CLI persona, and names the concrete
 * destination — it reaches the builder — without promising what a third party
 * does with it. The `ask` hint tells the agent to describe the substance of
 * its feedback to its human and get a yes before sending; every hint coaches
 * actionability (expected versus got, concrete detail, versions where they
 * matter); and the failed-job hint says to skip sending when the failure was
 * the request's own bad input.
 */

import {
  shellQuoteArg,
} from "@dvmkit/sdk/internal";
import {
  type FeedbackPosture,
} from "./identity";
import {
  info,
} from "./output";

export interface FeedbackNudge {
  code: "feedback_job_failed" | "feedback_first_success";
  dvm_id: string;
  job_id: string;
  /**
   * Mirrors the effective posture: `ask` means summarize the feedback's
   * substance to the human and get a yes before sending; `auto` means send
   * without asking.
   */
  approval: Exclude<FeedbackPosture, "off">;
  /** Where that posture came from. Global-only, so never `per_dvm`. */
  posture_source: "default" | "global";
  command: string;
  display: string;
  hint: string;
  /**
   * First-nudge-ever orientation: nudges are on by default, `dvm feedback
   * --posture ask|auto|off` changes that, and under `ask` the options belong
   * in the first approval request. Present only once, ever.
   */
  intro?: string;
}

/**
 * The deferred feedback fields for one terminal JSON emission. Both absent
 * when nothing was recorded, which is what lets every terminal emission
 * spread the sink in blind.
 */
export interface FeedbackNoticeFields {
  feedback_nudge?: FeedbackNudge;
  feedback_hint?: string;
}

/**
 * Build the full nudge for one high-signal terminal. `intro: true` attaches
 * the once-ever orientation block; the caller owns knowing whether this is
 * the first nudge this machine has ever emitted.
 */
export function buildFeedbackNudge(args: {
  code: FeedbackNudge["code"];
  dvmId: string;
  jobId: string;
  approval: Exclude<FeedbackPosture, "off">;
  postureSource: "default" | "global";
  intro?: boolean;
}): FeedbackNudge {
  const command = feedbackCommand(args.jobId, args.code === "feedback_job_failed" ? "down" : undefined);
  const display =
    args.code === "feedback_job_failed"
      ? `Job ${args.jobId} at ${args.dvmId} failed. A short note through '${command}' reaches the builder.`
      : `This was the first completed job with ${args.dvmId}. A first impression through '${command}' reaches the builder.`;
  const coach =
    args.code === "feedback_job_failed"
      ? "Worth sending unless the failure was this request's own bad input — then skip it. Say what was expected and what came back instead, with concrete detail: the input shape, the error text, versions where they matter."
      : "After evaluating the output, add '--verdict up' if it met what was asked, or '--verdict down' if it fell short. If you cannot judge that, append a concrete note to the command for free-text feedback. Say what was expected versus what came back, with versions where they matter.";
  const approval =
    args.approval === "ask"
      ? "Describe the substance of that feedback to your user at a high level and get a yes before running the command."
      : "The feedback posture is 'auto', so sending needs no approval first.";

  return {
    code: args.code,
    dvm_id: args.dvmId,
    job_id: args.jobId,
    approval: args.approval,
    posture_source: args.postureSource,
    command,
    display,
    hint: `${coach} ${approval}`,
    ...(args.intro ? { intro: buildFeedbackIntro(args.approval) } : {}),
  };
}

export function buildFeedbackHint(jobId: string): string {
  return `Fell short? '${feedbackCommand(jobId, "down")}' reaches the builder.`;
}

/**
 * Surface a full nudge. The prose goes to stderr in **both** modes, per the
 * credit-notice convention (stderr is human-visible and ignored by JSON
 * consumers), and the structured block is stashed for the JSON emission. A
 * second nudge in one command replaces the first — the cooldown rules make
 * that unreachable, but the block describes one moment, not a spend, so
 * replacing is the right degradation.
 */
export function noteFeedbackNudge(nudge: FeedbackNudge, human?: boolean): void {
  info(`${nudge.display} ${nudge.hint}`);
  if (!human) pending.feedback_nudge = nudge;
}

/**
 * Stash the micro-nudge for the JSON emission. No stderr line, deliberately:
 * it fires on every successful terminal, and a standing per-job line printed
 * at a human would be a nag rather than an offer.
 */
export function noteFeedbackHint(hint: string, human?: boolean): void {
  if (!human) pending.feedback_hint = hint;
}

/**
 * Take whatever feedback notices this command accumulated, clearing them.
 * Spread into a terminal JSON emission; safe to call from every one of them
 * because only the first call after a notice was recorded returns anything.
 */
export function takeFeedbackNoticeFields(): FeedbackNoticeFields {
  const taken = { ...pending };
  pending = {};
  return taken;
}

export function resetFeedbackNotices(): void {
  pending = {};
}


function feedbackCommand(jobId: string, verdict?: "up" | "down"): string {
  return `dvm feedback --job ${shellQuoteArg(jobId)}${verdict ? ` --verdict ${verdict}` : ""}`;
}

/**
 * The once-ever orientation block. Under `ask` it also says the options
 * belong in the first approval request, so the human learns the knob exists
 * the first time they are asked to use it.
 */
function buildFeedbackIntro(approval: Exclude<FeedbackPosture, "off">): string {
  const options =
    "Feedback nudges like this one are on by default. 'dvm feedback --posture ask' keeps the ask-first default, '--posture auto' sends without asking, and '--posture off' turns nudges off.";
  return approval === "ask"
    ? `${options} Relay these options to your user as part of this first approval request.`
    : options;
}

let pending: FeedbackNoticeFields = {};
