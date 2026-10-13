/**
 * Post-job credit settlement + auto-top-up (; spec §6/§8/§11).
 *
 * Called after every terminal job on the request path. Two duties:
 *
 * 1. **Fold the countersigned receipt into the local projection** and surface
 *    a balance mismatch, citing both signed artifacts (the caller half of the
 *    evidence chain).
 * 2. **Refill at a healthy moment**: when the settled balance dropped below
 *    25 % of the refill target, fund a top-up via `POST /v1/credit` — right
 *    after a successful job, when the wallet demonstrably works. Failures
 *    delay the top-up; they never fail the job, never break the budget cap,
 *    and never lose money (a prepared spend that didn't land stays on the
 *    pending-submission list and resumes against `(credit_id, fund_id)`).
 *
 * This healthy moment also **opens** credits, not just deepens
 * them. The planner sizes an open while answering the 402 but cannot carry it:
 * a funding that belongs on the float needs a `/v1/credit` round trip, and
 * everything the planner returns rides the job request. So it hands the sizing
 * over through {@link ./credit-defer} and this module funds it once the job
 * has settled — the same healthy moment, the same
 * never-fail-the-job contract.
 *
 * Never throws. Everything here is stderr-and-bookkeeping.
 */

import {
  applyImplicitReceiptCredit,
  applyReceiptCredit,
  type AttestedDvmIdentity,
  clearRefillRailUnavailable,
  type CreditFundRail,
  type CreditMenu,
  formatUsd,
  isCreditFundRail,
  markRefillDrainNoticed,
  markRefillRailUnavailable,
  type PendingDrain,
  pendingDrainFor,
  type ProviderInfo,
  type ProviderRef,
  type StoredCredit,
  type Transport,
} from "@dvmkit/sdk/internal";
import {
  type CreditConfig,
  loadConfig,
} from "./identity";
import {
  info,
} from "./output";
import {
  type ReceiptCapture,
} from "./receipt-capture";
import {
  availableRails,
  type CreditFundOutcome,
  type CreditRailSource,
  fundCredit,
} from "./credit-fund";
import {
  type DeferredFunding,
  effectiveCreditPosture,
  effectiveFundingRail,
  needsTopup,
} from "./credit-policy";

import { takeDeferredFunding } from "./credit-defer";
import {
  buildCreditFundingIncomplete,
  buildCreditFundingReport,
  buildCreditRefillDrainPending,
  buildCreditRefillUnavailable,
  buildCreditSuggestion,
  type CreditFundingIncomplete,
  noteCreditFunding,
  noteCreditFundingIncomplete,
  noteCreditRefillUnavailable,
  noteCreditSuggestion,
} from "./credit-notice";
import { providerDvmIdentity } from "./credit-per-dvm";
import { type AdoptedWedgedDrain, adoptWedgedChannelDrain, reclaimCommand } from "./credit-reclaim";

export interface SettleCreditArgs {
  capture: ReceiptCapture | undefined;
  transport: Transport;
  ref: ProviderRef;
  /**
   * The owner-qualified handle the caller resolved this request against
   * (`DvmIdentity.dvmId`), absent for `--endpoint` calls and bare local
   * favorites. Names the DVM on every notice this settlement emits — see
   * {@link noticeDvm}. Deliberately not the `dvmId` inside the attested
   * identity {@link providerDvmIdentity} returns, which is what the DVM
   * asserts about itself — signed by the DVM, and so fit to key the
   * store, but still possibly a display name that resolves nowhere in
   * discovery. That one selects the row; this one names the DVM.
   */
  dvmId?: string;
  /** `/v1/info` as read at warmup — carries the Cashu offer a top-up spends against. */
  providerInfo?: ProviderInfo;
  /** The signing identity that owns the credit. Absent → projection update only. */
  signing?: { privkey: string; pubkey: string };
  /** Set false at degraded moments (e.g. SSE-drop recovery) to skip the refill. */
  allowTopup?: boolean;
  human?: boolean;
  /** Test seam for the request-signing dependency (avoids a hard cycle). */
  signBody?: (privkey: string, body: Record<string, unknown>) => Record<string, unknown>;
  refillPocket?: (opts?: { human?: boolean }) => Promise<void>;
  /** Caller credit policy. Read from `~/.dvm/config.json` when absent. */
  config?: CreditConfig;
  /**
   * A funding the planner routed to this moment. Taken from
   * {@link takeDeferredFunding} when absent, which is how the request path
   * hands it over; passing it explicitly is the test seam.
   */
  deferred?: DeferredFunding;
}

/**
 * Settle a job's credit consequences: adopt the countersigned figures,
 * surface any mismatch with both artifacts referenced, and refill below the
 * threshold. See the module docblock for the contract.
 */
export async function settleCreditAfterJob(args: SettleCreditArgs): Promise<void> {
  // Taken unconditionally, so a degraded or failed job retires the intent
  // rather than leaving it for a later command to act on out of context.
  const deferred = args.deferred ?? takeDeferredFunding();
  try {
    await settle(args);
  } catch (err) {
    // Belt: nothing in here may fail the job.
    info(
      `Credit bookkeeping failed (job outcome unaffected): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (deferred) {
    try {
      await fundDeferred(args, deferred);
    } catch (err) {
      info(
        `Credit funding failed (job outcome unaffected): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  // The pocket shares the credit refill's healthy moment but not
  // its gates: in the wrapper, not `settle()`, because implicit N=1 jobs —
  // exactly the ones that drain the pocket — carry no credit receipt for
  // `settle()` to act on. Same degraded-moment opt-out; `refillPocketIfLow`
  // never throws, and the dynamic import keeps the wallet stack out of
  // credit-only callers.
  if (args.allowTopup !== false) {
    const refill = args.refillPocket ?? (await import("./pocket-refill")).refillPocketIfLow;
    await refill({ human: args.human }).catch(() => undefined);
  }
}


/**
 * The identity this DVM attested on the `/v1/info` this settlement already
 * read — the only key the credit store pools two hostnames on.
 *
 * Memoised over the parsed block by `providerDvmIdentity`, so the posture, the
 * rail pin and every store write this settlement makes verify the attestation
 * once between them.
 */
function settleIdentity(args: SettleCreditArgs): AttestedDvmIdentity | undefined {
  return providerDvmIdentity(args.providerInfo);
}

function settleIdentityArgs(args: SettleCreditArgs): { identity?: AttestedDvmIdentity } {
  const identity = settleIdentity(args);
  return identity ? { identity } : {};
}

function settleIdentityArg(args: SettleCreditArgs): [] | [identity: AttestedDvmIdentity] {
  const identity = settleIdentity(args);
  return identity ? [identity] : [];
}

/**
 * The typeable handle for this DVM — the qualified id the caller resolved
 * against, the endpoint otherwise — which is what the commands quoted in a
 * notice take.
 *
 * The same expression the request path uses, off the same input, on purpose
 *: both writers can land an entry in the same `credit_funding`
 * array, and an array that names one DVM two ways reads as two providers paid.
 * Reading provider-asserted metadata here instead would reintroduce that
 * disagreement from the other side, and would quote a command that resolves to
 * `https://<dvmId>.dvmkit.ai` — not where the credit lives when the caller
 * reached the DVM at a self-hosted, preview or localhost endpoint.
 */
function noticeDvm(args: SettleCreditArgs): string {
  return args.dvmId ?? args.ref.endpoint;
}

async function settle(args: SettleCreditArgs): Promise<void> {
  const receipt = args.capture?.receipt;
  const credit = receipt?.credit;
  if (!receipt || !credit || !args.signing) return;
  if (credit.credit_id.startsWith("imp:")) {
    // The spend authority is the signed caller identity, so never adopt an
    // anonymous or differently-owned balance merely because its receipt was
    // delivered on this process. The signature itself must also have passed:
    // an invalid receipt is visible evidence, not state worth spending from.
    if (
      (args.capture?.status !== "verified" && args.capture?.status !== "verified_unattested") ||
      receipt.requester_pubkey !== args.signing.pubkey
    ) {
      return;
    }
    const applied = applyImplicitReceiptCredit({
      endpoint: args.ref.endpoint,
      ...settleIdentityArgs(args),
      callerPubkey: args.signing.pubkey,
      jobId: receipt.job_id,
      outcome: receipt.outcome,
      credit,
      currency:
        args.providerInfo?.pricing?.max?.currency ?? args.providerInfo?.credit?.currency ?? "usd",
      issuedAtMs: receipt.issued_at * 1000,
    });
    if (applied.mismatch) renderBalanceMismatch(args.ref.endpoint, applied.mismatch);
    // An implicit credit has no funding menu or refill path. A non-zero signed
    // balance is kept for the next draw; a zero has already been pruned.
    return;
  }
  const applied = applyReceiptCredit({
    endpoint: args.ref.endpoint,
    ...settleIdentityArgs(args),
    callerPubkey: args.signing.pubkey,
    jobId: receipt.job_id,
    outcome: receipt.outcome,
    credit,
  });
  if (!applied.credit) return;

  if (applied.mismatch) {
    renderBalanceMismatch(args.ref.endpoint, applied.mismatch);
  }

  if (args.allowTopup === false) return;
  if (receipt.outcome !== "completed") return;
  const record = applied.credit;
  if (record.status !== "active") return;
  if (record.reconciliationPending) return;
  if (!needsTopup(record.remainingMicro, record.targetMicro)) return;

  // the refill is a purchase like any other, so it answers to the
  // consent posture. `off` never refills (the pre-posture `disabled` switch
  // gated the *planner* only, so a stored credit kept refilling under it —
  // that gap closes here); `suggest` sizes the refill and offers it instead.
  const posture = effectiveCreditPosture(
    args.config ?? loadConfig()?.credit,
    args.ref.endpoint,
    providerDvmIdentity(args.providerInfo)
  );
  if (posture.posture === "off") return;

  // Only a drain on *this* credit suppresses the refill — refilling what the
  // caller is reclaiming would be perverse. A drain stranded on a credit this
  // record has since re-pointed away from says nothing about the current one,
  // and gating on it would silently switch auto-top-up off here forever
  //
  // Read last of the three, and that ordering is the whole of what
  // changes: the hold is worth reporting only where a refill was genuinely due
  // and genuinely permitted. Above the refill mark nothing was suppressed, and
  // under posture `off` the caller's own choice is the reason — announcing the
  // drain in either place would name the wrong cause on a path that is quiet
  // today for good reason.
  const held = pendingDrainFor(record, record.creditId);
  if (held) {
    reportRefillHeldByDrain(args, record, held, args.signing.pubkey);
    return;
  }

  await fundTopup(args, record, posture);
}

function renderBalanceMismatch(
  endpoint: string,
  mismatch: {
    priorJobId?: string;
    jobId: string;
    drawId: string;
    ledgerSeq: number;
    reportedMicro: number;
    expectedMicro: number;
  }
): void {
  const prior = mismatch.priorJobId
    ? `the previous countersigned receipt (job ${mismatch.priorJobId})`
    : "the recorded balance projection";
  info(
    `Warning: credit balance mismatch at ${endpoint}. ` +
      `The DVM-signed receipt for job ${mismatch.jobId} (draw ${mismatch.drawId}, ledger seq ${String(mismatch.ledgerSeq)}) ` +
      `reports $${formatUsd(mismatch.reportedMicro / 1_000_000)} remaining, but ${prior} implies ` +
      `$${formatUsd(mismatch.expectedMicro / 1_000_000)}. Both signed artifacts are stored — ` +
      `inspect them with 'dvm receipts show <job-id>' and re-read the server with 'dvm credit balance'.`
  );
}

/**
 * Say once why a recorded reclaim is holding this credit's top-up.
 *
 * Once, not once per job: the condition is static until the caller posts the
 * reclaim, and the refill runs after every completed job, so a line per job
 * would bury the notice in the very JSON an agent parses to find it. The store
 * mark is the same mechanism the bound-rail outage uses one branch down.
 */
function reportRefillHeldByDrain(
  args: SettleCreditArgs,
  record: StoredCredit,
  held: PendingDrain,
  callerPubkey: string
): void {
  const identityArg = settleIdentityArg(args);
  if (
    !markRefillDrainNoticed(
      args.ref.endpoint,
      callerPubkey,
      record.creditId,
      held.drainId,
      ...identityArg
    )
  ) {
    return;
  }
  noteCreditRefillUnavailable(
    buildCreditRefillDrainPending({
      dvm: noticeDvm(args),
      endpoint: args.ref.endpoint,
      creditId: record.creditId,
      drainId: held.drainId,
      // The reclaim as the doors that record one spell it ,
      // rather than a third spelling of the same command.
      drainCommand: reclaimCommand(noticeDvm(args), record, record.creditId),
      balanceMicro: record.remainingMicro,
      currency: record.currency,
    }),
    args.human
  );
}

async function fundTopup(
  args: SettleCreditArgs,
  record: StoredCredit,
  posture: ReturnType<typeof effectiveCreditPosture>
): Promise<void> {
  const menu = record.menu;
  if (!menu) return;
  if (!args.transport.credit) return;
  const signing = args.signing;
  if (!signing) return;
  const identityArg = settleIdentityArg(args);

  // A binding is server-side physics, not a preference: if the one rail this
  // credit admits has disappeared locally, no fallback can refill it. This is
  // deliberately narrower than a generic empty eligibility set, which remains
  // the ordinary opportunistic skip and stays silent after every job.
  const boundRail = isCreditFundRail(record.rail) ? record.rail : undefined;
  const boundRailAvailable = boundRail
    ? availableRails({
        menu,
        ...(args.providerInfo ? { providerInfo: args.providerInfo } : {}),
      }).includes(boundRail)
    : undefined;
  if (boundRail && !boundRailAvailable) {
    if (
      !markRefillRailUnavailable(
        args.ref.endpoint,
        signing.pubkey,
        record.creditId,
        boundRail,
        ...identityArg
      )
    ) {
      return;
    }
    noteCreditRefillUnavailable(
      buildCreditRefillUnavailable({
        dvm: noticeDvm(args),
        endpoint: args.ref.endpoint,
        creditId: record.creditId,
        boundRail,
        balanceMicro: record.remainingMicro,
        currency: record.currency,
      }),
      args.human
    );
    return;
  }
  if (boundRail) {
    clearRefillRailUnavailable(args.ref.endpoint, signing.pubkey, record.creditId, ...identityArg);
  }

  // Refill to the target, clamped so the residual stays within the menu max
  // (`/v1/credit` enforces it per caller). A clamp that leaves less than the
  // floor means there is no fundable top-up right now.
  //
  // A refill whose rail is *forced* to Lightning floors at the rail's
  // advertised minimum too: its gap can easily be below the receive
  // floor, and sizing to the bare gap would mint an invoice that can never
  // route. `max(gap, floor)` deliberately funds past `targetMicro` — the floor
  // is the smallest refill the rail can carry, and the excess is spendable
  // balance, not waste. The global budget still gates it inside `fundCredit`.
  //
  // Forced, not merely likely: an unpinned refill the amount rule *might* send
  // to Lightning is left at its natural size, because the rule reads the size
  // rather than the other way round. So this
  // is the credit's server-side binding, or a `fundingRail: "lightning"` pin —
  // both of which mean no other rail can carry the refill at all.
  const forced = forcedRefillRail(args, record);
  const railFloorMicro =
    forced.rail === "lightning" && menu.lightning_min_micro !== undefined
      ? Math.max(menu.min_micro, menu.lightning_min_micro)
      : menu.min_micro;
  let fundMicro = Math.max(record.targetMicro - record.remainingMicro, railFloorMicro);
  fundMicro = Math.min(fundMicro, menu.max_micro - record.remainingMicro);
  if (fundMicro < railFloorMicro) {
    // Not silent for the lightning-bound case: a cashu credit's silent skip is
    // "no fundable gap yet", but here the caller's residual headroom refuses
    // the *floor*, which defers the refill indefinitely — say so once per
    // occurrence so the agent can act (spend down, or drain and reopen).
    if (railFloorMicro > menu.min_micro) {
      info(
        `Credit top-up at ${args.ref.endpoint} deferred: this credit refills over Lightning, ` +
          `which needs at least $${formatUsd(railFloorMicro / 1_000_000)} per funding, but only ` +
          `$${formatUsd(Math.max(0, menu.max_micro - record.remainingMicro) / 1_000_000)} of headroom ` +
          `remains under the DVM's balance ceiling. It retries after a later job.`
      );
    }
    return;
  }

  // Sized, fundable, and held back: offer it rather than buying it. Emitted
  // here rather than at the threshold check above so the figure the caller is
  // offered is the one that would actually have been spent — floor, residual
  // clamp and all.
  if (posture.posture === "suggest") {
    noteCreditSuggestion(
      buildCreditSuggestion({
        dvm: noticeDvm(args),
        endpoint: args.ref.endpoint,
        posture: posture.posture,
        postureSource: posture.source,
        suppressed: {
          reason: "refill",
          fundMicro,
          targetMicro: record.targetMicro,
          currency: record.currency,
        },
      }),
      args.human
    );
    return;
  }

  const outcome = await fundCredit({
    transport: args.transport,
    ref: args.ref,
    signing,
    creditId: record.creditId,
    amountMicro: fundMicro,
    menu,
    targetMicro: record.targetMicro,
    maxDepositMicro: fundMicro,
    human: args.human,
    ...(forced.rail ? { rail: forced.rail, railSource: forced.source } : {}),
    ...(args.providerInfo ? { providerInfo: args.providerInfo } : {}),
    ...(args.signBody ? { signBody: args.signBody } : {}),
  });

  reportFunding(args, outcome, {
    reason: "below_refill_target",
    fundMicro,
    currency: record.currency,
    menu,
  });
}

/**
 * Fund an open (or a refill) the planner routed to this moment.
 *
 * The sizing arrived intact from `planCreditForQuote` — this never re-sizes,
 * because the figure was already clamped against the tier cap, the builder's
 * bounds and the caller's `targetJobs` (and, on a forced Lightning rail,
 * floored at the advertised minimum), and a second opinion here could only
 * disagree with the one the suggestion machinery would have quoted.
 *
 * The rail arrives decided too, and a forced one is *passed on*: re-picking by
 * amount here would send a credit the DVM bound to Lightning down the Cashu
 * path first — a prepared spend swapped and then abandoned on `rail_mismatch`
 * — before falling back to the only rail that was ever going to work. All that
 * is left is to pay the figure, over the rail the pick already chose.
 */
async function fundDeferred(args: SettleCreditArgs, deferred: DeferredFunding): Promise<void> {
  if (args.allowTopup === false) return;
  // Only a job that actually completed is a healthy moment. A failure or a
  // degraded recovery says nothing good about the wallet, and the intent is
  // simply dropped — the next job re-plans it from scratch.
  if (args.capture?.receipt?.outcome !== "completed") return;
  if (!args.transport.credit) return;
  const signing = args.signing;
  if (!signing) return;
  // Re-read rather than trusting the plan: `off` must stop a purchase even if
  // the posture changed under us, and the check is free.
  const posture = effectiveCreditPosture(
    args.config ?? loadConfig()?.credit,
    args.ref.endpoint,
    providerDvmIdentity(args.providerInfo)
  );
  if (posture.posture !== "auto") return;

  const outcome = await fundCredit({
    transport: args.transport,
    ref: args.ref,
    signing,
    creditId: deferred.creditId,
    amountMicro: deferred.fundMicro,
    menu: deferred.menu,
    targetMicro: deferred.targetMicro,
    maxDepositMicro: deferred.maxDepositMicro ?? deferred.fundMicro,
    human: args.human,
    ...(deferred.pinnedRail
      ? { rail: deferred.pinnedRail, railSource: deferred.pinnedRailSource }
      : {}),
    ...(args.providerInfo ? { providerInfo: args.providerInfo } : {}),
    ...(args.signBody ? { signBody: args.signBody } : {}),
  });

  reportFunding(args, outcome, {
    reason: deferred.reason === "open" ? "no_credit_open" : "below_refill_target",
    fundMicro: deferred.fundMicro,
    currency: deferred.currency,
    menu: deferred.menu,
    label: deferred.reason === "open" ? "Credit opening" : "Credit top-up",
  });
}

/**
 * The rail a refill is *forced* onto, and by what.
 *
 * Binding beats pin, and both beat the amount rule. A credit is bound to the
 * rail it was opened on — `/v1/credit` refuses a cross-rail top-up, so this is
 * physics rather than preference, and passing it keeps the refill from
 * spending a round trip (and, on Cashu, a prepared spend) on a rail the DVM
 * will refuse. With no binding, a `fundingRail` pin forces instead; with
 * neither, nothing is forced and `pickCreditFundRail` reads the amount.
 */
function forcedRefillRail(
  args: SettleCreditArgs,
  record: StoredCredit
): { rail?: CreditFundRail; source?: CreditRailSource } {
  if (isCreditFundRail(record.rail)) return { rail: record.rail, source: "credit_bound" };
  const pin = effectiveFundingRail(
    args.config ?? loadConfig()?.credit,
    args.ref.endpoint,
    providerDvmIdentity(args.providerInfo)
  );
  return pin.rail && pin.source !== "default" ? { rail: pin.rail, source: pin.source } : {};
}

/**
 * Narrate one automatic funding. Shared by the refill and the deferred open
 * because the four outcomes mean the same thing on both, and because an agent
 * that learned to branch on this shape for a top-up must not meet a different
 * one for an open.
 */
function reportFunding(
  args: SettleCreditArgs,
  outcome: CreditFundOutcome,
  ctx: {
    reason: "no_credit_open" | "below_refill_target";
    fundMicro: number;
    currency: string;
    menu: CreditMenu;
    label?: string;
  }
): void {
  const what = ctx.label ?? "Credit top-up";
  // Every outcome below that reaches a caller carries its own next move, and
  // dropping it would discard the caller's next move: the hints here are local do-not-repeat
  // instructions ("a fresh funding id issues a second invoice"), not "take it
  // up with the DVM", so they ride on whatever sentence is printed.
  const hint = outcome.hint ? ` ${outcome.hint}` : "";
  // The structured half of the same fix. Built once because every not-as-asked
  // outcome fills it identically; each arm names its own code, since which case
  // this is follows from the branch rather than from the status alone.
  const incomplete = (
    code: CreditFundingIncomplete["code"],
    adoptedDrain?: AdoptedWedgedDrain
  ): void => {
    noteCreditFundingIncomplete(
      buildCreditFundingIncomplete({
        code,
        dvm: noticeDvm(args),
        endpoint: args.ref.endpoint,
        reason: ctx.reason,
        amountMicro: ctx.fundMicro,
        currency: ctx.currency,
        outcome,
        ...(adoptedDrain ? { adoptedDrain } : {}),
      }),
      args.human
    );
  };
  switch (outcome.status) {
    case "funded": {
      // The one funding whose balance landed somewhere the caller didn't ask
      // for: the provider's operator repaired a blocked invoice onto another
      // credit. The generic sentence below would report a top-up and
      // never say the money moved, so use the outcome's own copy — which names
      // the credit the balance actually landed on. It is the CLI's sentence,
      // not the DVM's: the provider's account of the repair stays on
      // `outcome.providerDisplay` / `providerHint` and is not relayed here
      // Same treatment for a funding that landed without naming its rail: the
      // structured report is built around the route, and inventing one to fill
      // the field would report ecash for money that may not have been ecash.
      // `fundCredit` always sets it on a success, so this is a type-level
      // possibility rather than a reachable state.
      if (outcome.reconciled || !outcome.rail) {
        info(`${what} at ${args.ref.endpoint} — ${outcome.display}${hint}`);
        // Money moved and the balance is on a credit the caller never named, so
        // the agent needs the id in a field it can follow, not only in prose.
        // Only the reconciled landing gets that block: the rail-less funding
        // above it landed exactly where it was asked to, and labelling it
        // `credit_funding_reconciled` to fill the field would say otherwise.
        if (outcome.reconciled) incomplete("credit_funding_reconciled");
        return;
      }
      // an automatic purchase reports amount, funding route and
      // reason — the transparency half of the consent bargain.  adds
      // *why that route*, which is what makes an unused float legible.
      noteCreditFunding(
        buildCreditFundingReport({
          dvm: noticeDvm(args),
          endpoint: args.ref.endpoint,
          reason: ctx.reason,
          amountMicro: outcome.fundedMicro ?? ctx.fundMicro,
          currency: ctx.currency,
          route: outcome.rail,
          // Every funding this module makes is a `/v1/credit` call of its own,
          // including the open — the job it followed paid per-call.
          ownRoundTrip: true,
          ...(outcome.railReason ? { routeReason: outcome.railReason } : {}),
          ...(outcome.railSource ? { routeReasonSource: outcome.railSource } : {}),
          ...(outcome.x402Flavour ? { x402Flavour: outcome.x402Flavour } : {}),
          ...(outcome.tempoIntent ? { tempoIntent: outcome.tempoIntent } : {}),
          outcome,
          ...(ctx.menu.lightning_min_micro !== undefined
            ? { lightningMinMicro: ctx.menu.lightning_min_micro }
            : {}),
          ...(outcome.credit ? { balanceMicro: outcome.credit.remaining_micro } : {}),
        }),
        args.human
      );
      return;
    }
    case "settlement_pending":
      // The money left the wallet and is recorded; crediting is pull-based, so
      // the next request to this DVM settles it. Both halves are the caller's
      // business — the spend, and that re-running the funding re-polls the
      // original id rather than minting a second invoice.
      info(`${what} at ${args.ref.endpoint} — ${outcome.display}${hint}`);
      incomplete("credit_funding_settlement_pending");
      return;
    case "refused": {
      // A wedged x402 channel refuses this refill and names the one drain id
      // that still reclaims the balance already on it. This is the likelier of
      // the two doors that meet the hold while adding money — nobody typed the
      // refill, and the credit is one the agent was mid-job against — so
      // dropping the id here leaves the reclaim behind an id nothing recorded
      // The adoption is `dvm credit fund`'s, verbatim.
      //
      // A consequence worth naming: the pending drain this leaves suppresses
      // every later refill of the credit at `settle()`'s own gate. While the
      // hold stands, the caller is reclaiming the balance, not deepening it.
      // Once an operator repairs the settlement, draws resume but only a real
      // `dvm credit drain` clears the record. The refill gate must name the hold
      // so this local record cannot silently suppress refills.
      const adopted =
        outcome.error?.code === "settlement_pending" && args.signing
          ? adoptWedgedChannelDrain({
              endpoint: args.ref.endpoint,
              // The store identity, which is `providerInfo`'s and not the
              // typeable handle below — the same key `applyReceiptCredit` and
              // `markRefillRailUnavailable` write this credit under.
              ...settleIdentityArgs(args),
              handle: noticeDvm(args),
              callerPubkey: args.signing.pubkey,
              creditId: outcome.creditId,
              data: outcome.error.data,
            })
          : undefined;
      const reclaim = adopted ? ` ${adopted.advice}` : "";
      // A refusal that carries a spend is not a skip: the money left the wallet
      // and the DVM declined to credit it. Only the Lightning rail can reach
      // that state (the Cashu rail drops or replays its prepared spend), and it
      // needs a different sentence — "skipped" would tell the agent nothing
      // happened right after something did.
      info(
        outcome.spentSats !== undefined || outcome.principalSats !== undefined
          ? `${what} paid but not credited — ${outcome.display}${hint}${reclaim}`
          : `${what} skipped — ${outcome.display}${hint}${reclaim}`
      );
      // Both branches get the block, spend or no spend: a refusal is a purchase
      // the caller never saw the end of either way. Which one this was is
      // `spent_sats` / `spent_micro` being there, so nothing downstream has to
      // infer a loss from the code alone.
      incomplete("credit_funding_refused", adopted);
      return;
    }
    case "unavailable": {
      // A sub-floor refusal breaks the silence: the funding is
      // *structurally* deferred — either the stored menu predates the DVM's
      // advertised floor, or a `fundingRail` pin is forcing a rail that can't
      // carry this size — and the outcome's hint names the way out. This is the
      // honest half of "force with honest refusal": a pinned rail below its
      // floor says so rather than quietly taking the other one.
      //
      // A stuck x402 voucher is the same class again, and the sharpest case:
      // an x402-bound credit has no other rail to fall to, so the silence below
      // would let its balance stop refilling after every job with no output at
      // all, until someone thought to look in the channel journal.
      // An outstanding exact authorization blocks the same way —
      // bounded by the header's own deadline rather than open-ended, but the
      // refill is still deferred on something only the caller can resolve. An
      // unanswered Tempo charge is the third of them.
      //
      // Those three are also the only `unavailable` outcomes with money at
      // stake: a signature the DVM holds and can still submit. Nothing moved on
      // *this* attempt, but the intent it is waiting on can still take the
      // money, and paying for the same top-up over another rail — what an agent
      // reading only a size-refusal would try — is then two payments for one
      // top-up. So they carry the structured block too, where a sub-floor
      // refusal (nothing signed, nothing outstanding) stays prose. The block's
      // `fund_id` is the outstanding intent's on all three — the key the retry
      // re-presents it under — except in the one x402 shape this attempt cannot
      // replay (a sibling credit's voucher, or this credit's own refused one),
      // where `fundOverX402` answers with the fresh attempt's key and only the
      // outcome's `display` names the credit actually holding the block.
      const pendingIntent =
        outcome.error?.code === "x402_voucher_pending" ||
        outcome.error?.code === "x402_exact_authorization_pending" ||
        outcome.error?.code === "tempo_charge_pending";
      if (outcome.error?.code === "below_rail_minimum" || pendingIntent) {
        info(`${what} at ${args.ref.endpoint} deferred — ${outcome.display}${hint}`);
        if (pendingIntent) incomplete("credit_funding_deferred");
        return;
      }
      // A forced rail that isn't usable at all is the same class of thing: the
      // caller pinned it, so the silence below would leave them believing the
      // amount rule simply chose otherwise.
      if (outcome.railReason === "forced" && outcome.railSource !== "credit_bound") {
        info(`${what} at ${args.ref.endpoint} skipped — ${outcome.display}${hint}`);
        return;
      }
      // Nothing was attempted and nothing moved. Silent by design: the refill
      // is opportunistic, and a caller with no fundable rail sees this after
      // every single job otherwise.
      return;
    }
  }
}
