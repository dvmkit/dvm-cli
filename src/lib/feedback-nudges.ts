/**
 * When a finished job earns a feedback nudge: the posture that
 * governs nudging, the two triggers, and the cooldown state that keeps the
 * nudges rare enough to stay signal.
 *
 * Entirely caller-side. `feedback-notice.ts` owns the words and the deferred
 * sink; this module owns the decision — posture, trigger, cooldown — and the
 * `feedback-nudges.json` record under `CONFIG_DIR` that makes the cooldowns
 * hold across invocations. Nothing here may ever break a job that already
 * finished, so the terminal entry point swallows its own failures.
 *
 * One degradation is accepted by design, not an oversight: a DVM whose
 * first-ever job *failed* gets the failed nudge, and a success inside the next
 * 7 days is swallowed by the per-DVM cooldown — by the time it lifts, the
 * completed count has usually moved past one, so that DVM may never get a
 * first-success nudge. The failed nudge already covered the first impression.
 */

import {
  ensureConfigDir,
  FEEDBACK_NUDGES_FILE,
} from "@dvmkit/sdk/internal";
import {
  type Config,
  type FeedbackPosture,
  isFeedbackPosture,
  loadConfig,
} from "./identity";
import {
  loadAllJobs,
} from "./job-store";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";

import {
  buildFeedbackHint,
  buildFeedbackNudge,
  noteFeedbackHint,
  noteFeedbackNudge,
} from "./feedback-notice";

/** The posture a zero-config caller has: nudge, but ask the human first. */
export const DEFAULT_FEEDBACK_POSTURE: FeedbackPosture = "ask";

export interface EffectiveFeedbackPosture {
  posture: FeedbackPosture;
  source: "default" | "global";
}

/**
 * Resolve the feedback posture in force, modeled on
 * `effectiveCreditPosture`. A stored value that isn't one of the three
 * coerces to the default rather than throwing on a job terminal; `dvm doctor`
 * is the surface that names it as malformed.
 */
export function effectiveFeedbackPosture(
  config: Config | null | undefined
): EffectiveFeedbackPosture {
  const global = config?.feedback?.posture;
  if (isFeedbackPosture(global)) return { posture: global, source: "global" };
  return { posture: DEFAULT_FEEDBACK_POSTURE, source: "default" };
}

/** One DVM's cooldown row in {@link FeedbackNudgeState}. ISO timestamps. */
export interface FeedbackNudgeDvmState {
  /** Last full nudge about this DVM — 7-day cooldown. */
  lastNudgedAt?: string;
  /** Last recorded `dvm feedback` send to this DVM — 30-day nudge quiet. */
  lastSentAt?: string;
  /** The once-ever first-success nudge, when it has fired. */
  firstSuccessNudgedAt?: string;
}

export interface FeedbackNudgeState {
  /** When the once-ever intro block was emitted. Unset means never. */
  introShownAt?: string;
  /** Keyed by the caller's handle for the DVM — what job records carry as `dvmId`. */
  perDvm: Partial<Record<string, FeedbackNudgeDvmState>>;
}

/**
 * Read the cooldown store. Absent, unparseable, or wrong-shaped bytes yield an
 * empty state — a corrupt cooldown record must never block a job terminal, and
 * `dvm doctor`'s file sweep is the surface that names the bad bytes.
 *
 * The shape checks are load-bearing: an *array* at `perDvm` passes a bare
 * `typeof === "object"` guard, and string keys set on an array are dropped by
 * `JSON.stringify` — so every cooldown stamp would silently vanish on the next
 * write and the full nudges would fire on every terminal forever. Same for a
 * non-object per-DVM entry, which a spread would explode into characters.
 */
export function loadFeedbackNudgeState(): FeedbackNudgeState {
  if (!existsSync(FEEDBACK_NUDGES_FILE)) return { perDvm: {} };
  try {
    const parsed = JSON.parse(
      readFileSync(FEEDBACK_NUDGES_FILE, "utf-8")
    ) as Partial<FeedbackNudgeState>;
    return {
      ...(typeof parsed.introShownAt === "string" ? { introShownAt: parsed.introShownAt } : {}),
      perDvm: coercePerDvm(parsed.perDvm),
    };
  } catch {
    return { perDvm: {} };
  }
}

/**
 * Record that `dvm feedback` actually sent something to this DVM. A recorded
 * send quiets the full nudges there for 30 days — the caller has spoken, and
 * re-nudging right after is noise. Best-effort: a failed write must not fail
 * the send it records.
 */
export function recordFeedbackSent(dvmId: string, now: number = Date.now()): void {
  try {
    const state = loadFeedbackNudgeState();
    state.perDvm[dvmId] = {
      ...(state.perDvm[dvmId] ?? {}),
      lastSentAt: new Date(now).toISOString(),
    };
    saveState(state);
  } catch {
    // Cooldown bookkeeping only — the feedback row already landed.
  }
}

export interface TerminalFeedbackMoment {
  jobId: string;
  dvmId?: string;
  endpoint: string;
  /** The terminal status the CLI just learned. Only `completed` / `failed` nudge. */
  status: string;
  human?: boolean;
  now?: number;
}

/**
 * Evaluate the feedback triggers at the moment a job is learned to be over,
 * and stash whatever they produce for the terminal emission.
 *
 * Two full-nudge triggers: a job with a known DVM reaching terminal `failed`,
 * and the first completed job this caller has ever had with a DVM (per local
 * job history; once per DVM ever). Failed is checked first, so it wins where
 * both could apply. Cancelled and timed-out jobs never nudge. The full nudge
 * is rate-limited — at most one per CLI invocation, a 7-day per-DVM cooldown,
 * and a 30-day quiet after a recorded send — while the micro-nudge on every
 * other successful terminal is exempt from all cooldowns. Posture `off`
 * silences both.
 *
 * Never throws: the job already finished, and no nudge is worth failing it.
 */
export function noteFeedbackAfterTerminal(moment: TerminalFeedbackMoment): void {
  try {
    if (moment.status !== "completed" && moment.status !== "failed") return;
    const { posture, source } = effectiveFeedbackPosture(loadConfig());
    if (posture === "off") return;

    const now = moment.now ?? Date.now();
    const state = loadFeedbackNudgeState();
    const code = moment.dvmId
      ? evaluateFullNudge(state, moment.dvmId, moment.endpoint, moment.status, now)
      : undefined;

    if (code && moment.dvmId) {
      const intro = state.introShownAt === undefined;
      noteFeedbackNudge(
        buildFeedbackNudge({
          code,
          dvmId: moment.dvmId,
          jobId: moment.jobId,
          approval: posture,
          postureSource: source,
          intro,
        }),
        moment.human
      );
      // Latch before the save: a failed write may lose the on-disk cooldown,
      // but it must not also leave this invocation free to nudge again.
      nudgedThisInvocation = true;
      const stamp = new Date(now).toISOString();
      state.perDvm[moment.dvmId] = {
        ...(state.perDvm[moment.dvmId] ?? {}),
        lastNudgedAt: stamp,
        ...(code === "feedback_first_success" ? { firstSuccessNudgedAt: stamp } : {}),
      };
      if (intro) state.introShownAt = stamp;
      saveState(state);
      return;
    }

    // The micro-nudge rides only successful terminals — a failed job either
    // got the full nudge above or is inside a cooldown, and repeating the
    // invitation there would be nagging, not signal.
    if (moment.status === "completed") {
      noteFeedbackHint(buildFeedbackHint(moment.jobId), moment.human);
    }
  } catch {
    // A nudge is advisory; the terminal it rides on is not.
  }
}

export function resetFeedbackNudgeInvocation(): void {
  nudgedThisInvocation = false;
}


const NUDGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const SENT_QUIET_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Which full nudge this terminal earns, if any. Failed is decided before
 * first-success on purpose: where both could apply, the failure is the
 * higher-signal moment.
 */
function evaluateFullNudge(
  state: FeedbackNudgeState,
  dvmId: string,
  endpoint: string,
  status: "completed" | "failed",
  now: number
): "feedback_job_failed" | "feedback_first_success" | undefined {
  if (nudgedThisInvocation) return undefined;
  const per = state.perDvm[dvmId];
  if (withinMs(per?.lastNudgedAt, NUDGE_COOLDOWN_MS, now)) return undefined;
  if (withinMs(per?.lastSentAt, SENT_QUIET_MS, now)) return undefined;
  if (status === "failed") return "feedback_job_failed";
  if (per?.firstSuccessNudgedAt !== undefined) return undefined;
  // The terminal was persisted before this runs, so the just-finished job is
  // already in local history — "first success" is a completed count of one.
  // A count of zero means the record isn't visible (nothing persisted), and
  // this completion is still the first this caller can know about.
  const completed = loadAllJobs().filter(
    (job) => job.endpoint === endpoint && job.status === "completed"
  ).length;
  return completed <= 1 ? "feedback_first_success" : undefined;
}

function withinMs(iso: string | undefined, windowMs: number, now: number): boolean {
  if (!iso) return false;
  const at = Date.parse(iso);
  return Number.isFinite(at) && now - at < windowMs;
}

function coercePerDvm(perDvm: unknown): FeedbackNudgeState["perDvm"] {
  if (!perDvm || typeof perDvm !== "object" || Array.isArray(perDvm)) return {};
  return Object.fromEntries(
    Object.entries(perDvm).filter(
      ([, entry]) => !!entry && typeof entry === "object" && !Array.isArray(entry)
    )
  ) as FeedbackNudgeState["perDvm"];
}

/**
 * Atomic tmp+rename write, mode 0600 — the credit-store pattern, pid-suffixed
 * tmp included: this store is written under no lock, and a fixed sibling path
 * is what a concurrent invocation interleaves into, publishing a torn file
 * under the real name. A crash mid-write leaves the previous state
 * or the new one, never half a cooldown record.
 */
function saveState(state: FeedbackNudgeState): void {
  ensureConfigDir();
  const tmp = `${FEEDBACK_NUDGES_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  try {
    renameSync(tmp, FEEDBACK_NUDGES_FILE);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw err;
  }
}

let nudgedThisInvocation = false;
