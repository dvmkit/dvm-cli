import { fundingRailLabel } from "../lib/rail-labels";
/**
 * Stable Commander adapters for `dvm credit`. Policy/list commands remain local;
 * balance, funding, and recovery delegate to cohesive application workflows.
 */

import {
  formatFiat,
} from "@dvmkit/sdk";
import {
  type AttestedDvmIdentity,
  clearCreditSelection,
  CREDIT_FUND_RAILS,
  type CreditFundRail,
  DvmError,
  findX402Channel,
  isCreditFundRail,
  listCredits,
  listFundingMenuSnapshots,
  listImplicitCredits,
  listPendingFundings,
  loadTempoChannelAssociation,
  normalizeCreditEndpoint,
  pendingDrainFor,
  type PendingFunding,
  shellQuoteArg,
  type StoredCredit,
  type StoredFundingMenuSnapshot,
  type StoredImplicitCredit,
  type StoredSiblingCredit,
  X402_BATCH_SETTLEMENT_SCHEME,
  x402CreditChannelNetworks,
  x402CreditExactNetworks,
  x402FlavourForInstrument,
} from "@dvmkit/sdk/internal";
import {
  type Config,
  CREDIT_POSTURES,
  type CreditConfig,
  type CreditPosture,
  isCreditPosture,
  loadConfig,
  updateConfig,
} from "../lib/identity";
import {
  info,
  json,
} from "../lib/output";
import {
  loadX402Wallet,
} from "../lib/x402/wallet";
import {
  resolveSigningIdentity,
} from "../lib/cli-identity-resolve";
import {
  automaticCreditBoundRail,
  DEFAULT_CREDIT_POSTURE,
  effectiveCreditPosture,
  effectiveFundingRail,
  type EffectiveFundingRail,
} from "../lib/credit-policy";
import { availableRails } from "../lib/credit-fund";
import {
  type CreditHeadroom,
  headroomDisplay,
  headroomJson,
} from "../lib/credit-headroom";
import {
  buildCreditRefillInstrumentUnavailable,
  buildCreditRefillUnavailable,
  buildCreditRefillWalletNetworkMismatch,
  type CreditRefillUnavailable,
} from "../lib/credit-notice";
import {
  creditDrainCommand,
} from "../lib/credit-reclaim";
import {
  dvmLabelFromEndpoint,
} from "./wallet-history";
import { runCreditBalance } from "../lib/credit/balance";
import { runCreditDrain, runCreditReceipts } from "../lib/credit/drain";
import { runCreditFund } from "../lib/credit/funding";
import type {
  CreditBalanceOptions,
  CreditDeselectOptions,
  CreditDrainOptions,
  CreditFundOptions,
  CreditListOptions,
  CreditPostureOptions,
  CreditRailOptions,
  CreditReceiptsOptions,
} from "../lib/credit/options";
export type { CreditBalanceOptions, CreditDeselectOptions, CreditDrainOptions, CreditFundOptions, CreditListOptions, CreditPostureOptions, CreditRailOptions, CreditReceiptsOptions } from "../lib/credit/options";
import {
  discoverCreditDvmIdentity,
  resolveCreditEndpoint,
  implicitCreditJson,
  CreditCurrencyTotals,
  currencyTotal,
  sortedCurrencyTotals,
  creditCurrencyTotalsJson,
  currencyTotalsDisplay,
  headroomReader,
  HeadroomReader,
  HeadroomInputs,
  otherCreditDrains,
  pendingDrainJson,
} from "../lib/credit/shared";

/**
 * Set the consent posture for automatic credit purchases, or clear one DVM's
 * override back to its inherited posture.
 *
 * The write is the whole command; the read-back afterwards is what `dvm credit
 * list` shows, so this echoes the resulting effective posture rather than
 * making the caller run a second verb to learn what it did.
 */
export async function creditPosture(
  mode: string | undefined,
  opts: CreditPostureOptions
): Promise<void> {
  if (opts.clear && mode !== undefined) {
    throw new DvmError(
      "invalid_argument",
      "Pass a credit posture or --clear, not both.",
      `Set an override with 'dvm credit posture <${CREDIT_POSTURES.join("|")}> --dvm <dvm>' or remove one with 'dvm credit posture --clear --dvm <dvm>'.`
    );
  }
  if (opts.clear && !opts.dvm) {
    throw new DvmError(
      "invalid_argument",
      "Credit posture --clear requires --dvm.",
      "Name the one DVM whose override should be removed. A global posture is changed explicitly with 'dvm credit posture <suggest|auto|off>'."
    );
  }

  const posture = mode?.trim().toLowerCase();
  if (!opts.clear && !posture) {
    throw new DvmError(
      "invalid_argument",
      "Missing credit posture.",
      `Pass one of ${CREDIT_POSTURES.join(", ")}, or pass --clear with --dvm to inherit the global or default posture.`
    );
  }
  if (posture && !isCreditPosture(posture)) {
    throw new DvmError(
      "invalid_argument",
      `Unknown credit posture '${mode}'.`,
      `Pass one of ${CREDIT_POSTURES.join(", ")} — 'suggest' offers a credit and buys nothing, 'auto' buys within the trust-tier caps, 'off' never uses multi-job credit at all.`
    );
  }
  const requestedPosture = posture as CreditPosture | undefined;
  const change = opts.clear
    ? ({ kind: "clear" } as const)
    : ({ kind: "set", posture: requireCreditPosture(requestedPosture) } as const);

  const endpoint = opts.dvm ? resolveCreditEndpoint(opts.dvm) : undefined;
  // Stamp the DVM's attested identity onto the entry as it is written, so this
  // posture governs the DVM rather than the spelling. Best-effort: a DVM that
  // serves no identity stays hostname-keyed, exactly as before.
  const identity = endpoint ? await discoverCreditDvmIdentity(endpoint) : undefined;
  let resolvedIdentity = identity;
  const clearedOverrides: string[] = [];
  const { config: committed } = await updateConfig({
    reason: "credit_posture",
    patch: (current) => {
      clearedOverrides.length = 0;
      if (change.kind === "clear" && current?.credit === undefined) return {};
      const credit = { ...(current?.credit ?? {}) };
      if (endpoint) {
        const perDvm = { ...(credit.perDvm ?? {}) };
        if (change.kind === "clear") {
          // A transient `/v1/info` failure must not turn an identity-scoped
          // override into an origin-only clear. Only the exact endpoint entry
          // is trusted as the offline fallback: it is the entry this command
          // previously stamped from an authenticated builder attestation.
          const storedIdentity = configDvmIdentity(perDvm[endpoint] ?? {});
          resolvedIdentity = identity ?? storedIdentity;
          if (
            resolvedIdentity === undefined &&
            hasStoredIdentityBookkeepingAtEndpoint(perDvm, endpoint)
          ) {
            throw new DvmError(
              "credit_posture_identity_unavailable",
              `Cannot safely clear the credit posture for ${dvmLabelFromEndpoint(endpoint)} while its identity is unavailable.`,
              "Retry while the DVM is reachable so the CLI can authenticate every saved alias. No posture was changed."
            );
          }
          const next: typeof perDvm = {};
          for (const [key, entry] of Object.entries(perDvm)) {
            const entryIdentity = configDvmIdentity(entry);
            const sameDvm =
              normalizeCreditEndpoint(key) === endpoint ||
              (resolvedIdentity !== undefined &&
                entryIdentity?.dvmId === resolvedIdentity.dvmId &&
                entryIdentity.builderPubkey === resolvedIdentity.builderPubkey);
            if (!sameDvm || entry.posture === undefined) {
              next[key] = entry;
              continue;
            }
            clearedOverrides.push(key);
            const { posture: _cleared, ...rest } = entry;
            if (hasPerDvmPolicy(rest)) next[key] = rest;
          }
          if (Object.keys(next).length === 0) delete credit.perDvm;
          else credit.perDvm = next;
        } else {
          perDvm[endpoint] = {
            ...(perDvm[endpoint] ?? {}),
            posture: change.posture,
            ...(identity ? { dvmId: identity.dvmId, builderPubkey: identity.builderPubkey } : {}),
          };
          credit.perDvm = perDvm;
        }
      } else {
        if (change.kind === "clear") throw scopedPostureClearError();
        credit.posture = change.posture;
      }
      return { set: { credit } };
    },
  });

  const scope = endpoint ? dvmLabelFromEndpoint(endpoint) : "every DVM";
  // Echo what now governs, not what was typed. A DVM answering on two
  // hostnames can hold a stricter posture under the other spelling, and
  // most-restrictive is what a job will meet.
  const effective = endpoint
    ? effectiveCreditPosture(committed.credit, endpoint, resolvedIdentity)
    : change.kind === "set"
      ? { posture: change.posture, source: "global" as const }
      : (() => {
          throw scopedPostureClearError();
        })();
  const overriddenAt =
    change.kind === "set" && effective.posture === change.posture
      ? []
      : change.kind === "clear"
        ? []
        : siblingPostureKeys(committed.credit, endpoint, resolvedIdentity, effective.posture);
  const overrideDisplay =
    overriddenAt.length > 0
      ? `the same DVM also answers at ${overriddenAt.join(" and ")}, where you set '${effective.posture}', and the stricter of the two governs`
      : `another entry for the same DVM sets '${effective.posture}', and the stricter of the two governs`;
  const inherited =
    effective.source === "default"
      ? `The default '${effective.posture}' posture now applies.`
      : `The global '${effective.posture}' posture now applies.`;
  const display =
    change.kind === "clear"
      ? `Credit posture override cleared at ${scope}. ${inherited}`
      : effective.posture === change.posture
        ? `Automatic credit purchases at ${scope} are now '${change.posture}' — ${postureSentence(change.posture)}`
        : `Recorded '${change.posture}' at ${scope}, but '${effective.posture}' still applies there: ${overrideDisplay}. ${postureSentence(effective.posture)}`;
  const hint =
    change.kind === "clear"
      ? "Effective posture and its provenance for every DVM are in 'dvm credit list'."
      : effective.posture === change.posture
        ? "Effective posture and its provenance for every DVM are in 'dvm credit list'."
        : overriddenAt.length > 0
          ? `Set the same posture there too — 'dvm credit posture ${change.posture} --dvm ${shellQuoteArg(overriddenAt[0])}' — or see every DVM's effective posture with 'dvm credit list'.`
          : "Find the entry holding it in 'dvm credit list', which shows every DVM's effective posture and where it came from.";
  if (opts.human) {
    info(display);
    info(hint);
    return;
  }
  json({
    posture: effective.posture,
    posture_source: effective.source,
    ...(change.kind === "clear" ? { status: "cleared" } : {}),
    ...(change.kind === "set" && effective.posture !== change.posture
      ? { requested_posture: change.posture }
      : {}),
    ...(overriddenAt.length > 0 ? { overridden_at: overriddenAt } : {}),
    ...(clearedOverrides.length > 1 ? { cleared_endpoints: clearedOverrides } : {}),
    scope: endpoint ? "per_dvm" : "global",
    ...(endpoint ? { endpoint } : {}),
    display,
    hint,
  });
}

/**
 * The other config keys governing this DVM whose entry carries `posture`, in
 * config order — what a most-restrictive resolution just overrode the caller
 * with.
 *
 * The exclusion is the literal key this command wrote, not every key that
 * normalizes to it: a hand-written duplicate spelling (`https://x.example/`
 * beside `https://x.example`) is a different key holding a different posture,
 * and the resolver folds it in, so a caller told to go lift it has to be told
 * where. Matching otherwise mirrors the resolver — origin *or* stamped
 * identity — because an entry it counted but this can't name is exactly the
 * case that produced an empty list.
 */
function siblingPostureKeys(
  credit: CreditConfig | undefined,
  endpoint: string | undefined,
  identity: AttestedDvmIdentity | undefined,
  posture: CreditPosture
): string[] {
  if (!endpoint) return [];
  return Object.entries(credit?.perDvm ?? {})
    .filter(
      ([origin, entry]) =>
        origin !== endpoint &&
        entry.posture === posture &&
        (normalizeCreditEndpoint(origin) === endpoint ||
          (identity !== undefined &&
            entry.dvmId === identity.dvmId &&
            entry.builderPubkey?.trim().toLowerCase() === identity.builderPubkey))
    )
    .map(([origin]) => origin);
}

/** Pin prepaid-credit funding to one rail, or clear that pin. */
export async function creditRail(
  rawRail: string | undefined,
  opts: CreditRailOptions
): Promise<void> {
  if (opts.clear && rawRail !== undefined) {
    throw new DvmError(
      "invalid_argument",
      "Pass a funding rail or --clear, not both.",
      `Set a pin with 'dvm credit rail <${CREDIT_FUND_RAILS.join("|")}>' or remove one with 'dvm credit rail --clear'.`
    );
  }

  const rail = rawRail?.trim().toLowerCase();
  if (!opts.clear && !rail) {
    throw new DvmError(
      "invalid_argument",
      "Missing credit funding rail.",
      `Pass one of ${CREDIT_FUND_RAILS.join(", ")}, or pass --clear to return to the amount rule.`
    );
  }
  if (rail && !isCreditFundRail(rail)) {
    throw new DvmError(
      "invalid_argument",
      `Unknown credit funding rail '${rawRail}'.`,
      `Pass one of ${CREDIT_FUND_RAILS.join(", ")}, or pass --clear to return to the amount rule.`
    );
  }

  const endpoint = opts.dvm ? resolveCreditEndpoint(opts.dvm) : undefined;
  const identity = endpoint ? await discoverCreditDvmIdentity(endpoint) : undefined;
  // Every other spelling of this DVM that carries a pin. The pin the
  // caller is typing now is their latest word on the subject, so those go —
  // leaving them would either contradict this one or, if the two disagreed,
  // resolve to no pin at all and quietly eat the instruction they just gave.
  const supersededPins: string[] = [];
  const { config: committed } = await updateConfig({
    reason: "credit_rail",
    patch: (current) => {
      supersededPins.length = 0;
      const credit = { ...(current?.credit ?? {}) };
      if (endpoint) {
        const perDvm = { ...(credit.perDvm ?? {}) };
        const per = { ...(perDvm[endpoint] ?? {}) };
        if (opts.clear) delete per.fundingRail;
        else per.fundingRail = rail as CreditFundRail;
        if (identity) {
          per.dvmId = identity.dvmId;
          per.builderPubkey = identity.builderPubkey;
        }
        const next: Record<string, (typeof perDvm)[string]> = {};
        for (const [key, entry] of Object.entries(perDvm)) {
          if (key === endpoint) continue;
          if (
            identity &&
            entry.dvmId === identity.dvmId &&
            entry.builderPubkey?.trim().toLowerCase() === identity.builderPubkey &&
            entry.fundingRail !== undefined
          ) {
            supersededPins.push(key);
            const { fundingRail: _superseded, ...rest } = entry;
            if (hasPerDvmPolicy(rest)) next[key] = rest;
            continue;
          }
          next[key] = entry;
        }
        // A stamped identity is bookkeeping, not policy: an entry left holding
        // nothing else is noise the caller never asked for.
        if (hasPerDvmPolicy(per)) next[endpoint] = per;
        if (Object.keys(next).length === 0) delete credit.perDvm;
        else credit.perDvm = next;
      } else if (opts.clear) {
        delete credit.fundingRail;
      } else {
        credit.fundingRail = rail as CreditFundRail;
      }

      return { set: { credit } };
    },
  });
  const effective = effectiveFundingRail(committed.credit ?? {}, endpoint, identity);

  const scope = endpoint ? dvmLabelFromEndpoint(endpoint) : "every DVM";
  const effectiveLabel = effective.rail ? fundingRailLabel(effective.rail) : "automatic";
  const fallback =
    effective.source === "default"
      ? "The amount rule now chooses the rail."
      : `The ${effective.source === "global" ? "global" : "per-DVM"} ${effectiveLabel} pin remains in force.`;
  const superseded =
    supersededPins.length > 0
      ? ` The pins this DVM also carried under ${supersededPins.join(" and ")} were dropped, so one DVM keeps one pin.`
      : "";
  const display = `${
    opts.clear
      ? `Credit funding rail pin cleared at ${scope}. ${fallback}`
      : `Credit funding at ${scope} is now pinned to ${effectiveLabel}.`
  }${superseded}`;
  const output = {
    status: opts.clear ? "cleared" : "set",
    funding_rail: effective.rail ?? null,
    funding_rail_source: effective.source,
    scope: endpoint ? "per_dvm" : "global",
    ...(endpoint ? { endpoint } : {}),
    ...(supersededPins.length > 0 ? { superseded_endpoints: supersededPins } : {}),
    display,
    hint: "Effective funding-rail pins and their provenance for every DVM are in 'dvm credit list'.",
  };
  if (opts.human) {
    info(display);
    info(output.hint);
    return;
  }
  json(output);
}

/** Show every locally-tracked credit — the caller's own projection, no network. */
export function creditList(opts: CreditListOptions): void {
  const credits = listCredits();
  const implicitCredits = listImplicitCredits();
  const snapshots = listFundingMenuSnapshots();
  const pending = listPendingFundings();
  const creditConfig = loadConfig()?.credit;
  // Loaded once for the whole listing: the ladder re-verifies every receipt it
  // counts, and re-reading the file per credit would repeat that work.
  const headroomOf = headroomReader();
  const identityOf = (endpoint: string) => offlineDvmIdentity(creditConfig, endpoint, headroomOf);
  const postureOf = (endpoint: string) =>
    effectiveCreditPosture(creditConfig, endpoint, identityOf(endpoint));
  const fundingRailOf = (endpoint: string) =>
    effectiveFundingRail(creditConfig, endpoint, identityOf(endpoint));
  const globalPosture = isCreditPosture(creditConfig?.posture)
    ? { posture: creditConfig.posture, source: "global" as const }
    : { posture: DEFAULT_CREDIT_POSTURE, source: "default" as const };
  const globalRail = effectiveFundingRail(creditConfig);
  const siblingCredits = credits.flatMap((credit) => credit.siblingCredits ?? []);
  const totals = localCreditCurrencyTotals(credits, implicitCredits);

  if (opts.human) {
    info(humanPostureLine(globalPosture));
    for (const [endpoint, per] of postureOverrides(creditConfig)) {
      info(`  At ${dvmLabelFromEndpoint(endpoint)}: ${per} (overrides the global setting).`);
    }
    info(humanFundingRailLine(globalRail));
    for (const [endpoint, rail] of fundingRailOverrides(creditConfig)) {
      info(
        `  At ${dvmLabelFromEndpoint(endpoint)}: ${fundingRailLabel(rail)} (overrides the global setting).`
      );
    }
    if (
      credits.length === 0 &&
      implicitCredits.length === 0 &&
      pending.length === 0 &&
      snapshots.length === 0
    ) {
      info("No prepaid credits tracked yet.");
      info(postureAdoptionSentence(globalPosture.posture));
      return;
    }
    for (const c of credits) {
      info(`  ${humanCreditRow(c)}`);
      for (const sibling of c.siblingCredits ?? []) {
        info(`    ${humanSiblingCreditRow(c, sibling)}`);
      }
      info(`    ${headroomDisplay(headroomOf.of(headroomInputsFor(c, identityOf(c.endpoint))))}`);
    }
    for (const row of humanImplicitCreditRows(implicitCredits)) info(`  ${row}`);
    for (const snapshot of snapshots) {
      const machine = cachedDvmJson(snapshot, credits, headroomOf, identityOf(snapshot.endpoint));
      info(`  ${String(machine.display)}`);
      const headroom = machine.headroom as { display?: unknown };
      if (typeof headroom.display === "string") info(`    ${headroom.display}`);
    }
    for (const funding of pending) {
      info(`  ${pendingFundingDisplay(funding)}`);
    }
    info("");
    info(
      "Credits are a local projection from signed receipts; funding bounds are cached guidance. 'dvm credit balance <dvm>' re-polls pending fundings and re-reads the server."
    );
    return;
  }

  json({
    // this is already the caller's policy projection surface, so the
    // consent posture is inspected here rather than through a verb of its own.
    posture: {
      effective: globalPosture.posture,
      source: globalPosture.source,
      per_dvm: Object.fromEntries(postureOverrides(creditConfig)),
      display: humanPostureLine(globalPosture),
      hint: "Change it with 'dvm credit posture <suggest|auto|off>', or scope it to one DVM with --dvm <dvm>.",
    },
    funding_rail: {
      effective: globalRail.rail ?? null,
      source: globalRail.source,
      per_dvm: Object.fromEntries(fundingRailOverrides(creditConfig)),
      display: humanFundingRailLine(globalRail),
      hint: `Pin it with 'dvm credit rail <${CREDIT_FUND_RAILS.join("|")}>' or return to the amount rule with 'dvm credit rail --clear'; add --dvm <dvm> to scope either operation.`,
    },
    credits: credits.map((c) => ({
      ...storedCreditJson(c, headroomOf.of(headroomInputsFor(c, identityOf(c.endpoint)))),
      ...postureFields(postureOf(c.endpoint)),
      ...fundingRailFields(fundingRailOf(c.endpoint)),
    })),
    count: credits.length,
    implicit_credits: implicitCredits.map(implicitCreditJson),
    implicit_count: implicitCredits.length,
    credit_count: credits.length + siblingCredits.length + implicitCredits.length,
    sibling_count: siblingCredits.length,
    totals_by_currency: totals.map((total) => creditCurrencyTotalsJson(total, "local")),
    dvms: snapshots.map((snapshot) => ({
      ...cachedDvmJson(snapshot, credits, headroomOf, identityOf(snapshot.endpoint)),
      ...postureFields(postureOf(snapshot.endpoint)),
      ...fundingRailFields(fundingRailOf(snapshot.endpoint)),
    })),
    dvm_count: snapshots.length,
    pending_fundings: pending.map(pendingFundingJson),
    pending_count: pending.length,
    display:
      credits.length > 0 || implicitCredits.length > 0
        ? currencyTotalsDisplay(totals, "local")
        : pending.length > 0
          ? pendingFundingsDisplay(pending)
          : snapshots.length > 0
            ? `${String(snapshots.length)} cached DVM funding menu${snapshots.length === 1 ? " is" : "s are"} available; no prepaid credits are held.`
            : "No prepaid credits tracked yet.",
    hint:
      credits.length === 0 &&
      implicitCredits.length === 0 &&
      pending.length === 0 &&
      snapshots.length === 0
        ? `${postureAdoptionSentence(globalPosture.posture)} This view is local; nothing was queried.`
        : "This is the caller's local projection from signed receipts and signed balance reads. `implicit_credits` are released per-call balances spent automatically before prepaid credit; an expired row is lost because it has no drain path. `sibling_credits` are server-confirmed at `observed_at_ms`, but draws use only the tracked row; each drainable sibling names the exact reclaim command. Cached `dvms` entries are funding guidance, not a fresh balance. Reconcile again with 'dvm credit balance <dvm>'.",
  });
}

/** Clear an exact local draw selection while retaining all credit and drain evidence. */
export function creditDeselect(dvm: string, opts: CreditDeselectOptions): void {
  const endpoint = resolveCreditEndpoint(dvm);
  const signer = resolveSigningIdentity({ as: opts.as, config: loadConfig() });
  clearCreditSelection(endpoint, signer.pubkey, opts.creditId);
  const display = `Credit ${opts.creditId} remains recorded at ${endpoint}, but is no longer selected for job draws.`;
  if (opts.human) {
    info(display);
    return;
  }
  json({
    op: "deselect",
    endpoint,
    credit_id: opts.creditId,
    selected_credit_id: null,
    display,
  });
}

function requireCreditPosture(posture: CreditPosture | undefined): CreditPosture {
  if (posture !== undefined) return posture;
  throw new DvmError(
    "invalid_argument",
    "Missing credit posture.",
    `Pass one of ${CREDIT_POSTURES.join(", ")}, or pass --clear with --dvm to inherit the global or default posture.`
  );
}

function scopedPostureClearError(): DvmError {
  return new DvmError(
    "invalid_argument",
    "Credit posture --clear requires --dvm.",
    "Name the one DVM whose override should be removed. A global posture is changed explicitly with 'dvm credit posture <suggest|auto|off>'."
  );
}

function postureSentence(posture: CreditPosture): string {
  switch (posture) {
    case "auto":
      return "credit is bought within the trust-tier caps without asking, and every purchase reports its amount, route and reason.";
    case "off":
      return "no multi-job credit is opened, refilled, or drawn on; every job pays per-call.";
    case "suggest":
      return "nothing is ever bought automatically; where a credit would have helped, the job output says so and names how to fund it.";
  }
}

function humanPostureLine(effective: { posture: CreditPosture; source: string }): string {
  const provenance = effective.source === "global" ? "set in config" : "the default";
  return `Automatic credit purchases: ${effective.posture} (${provenance}) — ${postureSentence(effective.posture)}`;
}

function postureAdoptionSentence(posture: CreditPosture): string {
  switch (posture) {
    case "auto":
      return "A credit opens automatically on your second paid call to a DVM that offers one (with auto-pay consent).";
    case "off":
      return "Multi-job credit is switched off; 'dvm credit posture suggest' or 'auto' turns it back on.";
    case "suggest":
      return "Credit is never bought automatically: a job that could have used one says so, and 'dvm credit fund <dvm>' opens it.";
  }
}

/**
 * The per-DVM posture overrides, endpoint-keyed, in config order.
 *
 * Each row carries the **resolved** posture rather than the literal one on the
 * entry: where two spellings of one DVM disagree, the strictest is
 * what a job will meet, and a listing that showed both raw values would
 * disagree with the CLI's own behaviour on the row beside it.
 */
function postureOverrides(credit: Config["credit"]): [string, CreditPosture][] {
  return Object.entries(credit?.perDvm ?? {}).flatMap(([endpoint, per]) => {
    if (!isCreditPosture(per.posture)) return [];
    const resolved = effectiveCreditPosture(credit, endpoint, configDvmIdentity(per));
    return [[endpoint, resolved.posture] as [string, CreditPosture]];
  });
}

/**
 * The per-DVM funding-rail overrides, endpoint-keyed, in config order.
 *
 * Same resolved-not-literal rule as {@link postureOverrides}, and here it also
 * *drops* a row: two spellings pinned to different rails resolve to no pin at
 * all, so printing either one would name a rail nothing routes onto.
 */
function fundingRailOverrides(credit: Config["credit"]): [string, CreditFundRail][] {
  return Object.entries(credit?.perDvm ?? {}).flatMap(([endpoint, per]) => {
    if (!isCreditFundRail(per.fundingRail)) return [];
    const resolved = effectiveFundingRail(credit, endpoint, configDvmIdentity(per));
    if (resolved.source !== "per_dvm" || !resolved.rail) return [];
    return [[endpoint, resolved.rail] as [string, CreditFundRail]];
  });
}

/**
 * The one-line funding-rail header `dvm credit list` carries. Always the global
 * layer — the per-DVM overrides print underneath it — so "set globally" is the
 * only provenance this line can describe.
 */
function humanFundingRailLine(effective: EffectiveFundingRail): string {
  return effective.rail
    ? `Credit funding rail: ${fundingRailLabel(effective.rail)} (set globally) — funding is forced onto this rail unless a per-DVM pin or --rail overrides it.`
    : "Credit funding rail: automatic (the default) — the amount and available wallets decide.";
}

function postureFields(effective: { posture: CreditPosture; source: string }): {
  posture: CreditPosture;
  posture_source: string;
} {
  return { posture: effective.posture, posture_source: effective.source };
}

function fundingRailFields(effective: EffectiveFundingRail): {
  funding_rail: CreditFundRail | null;
  funding_rail_source: string;
} {
  return {
    funding_rail: effective.rail ?? null,
    funding_rail_source: effective.source,
  };
}

function storedCreditJson(c: StoredCredit, headroom: CreditHeadroom): Record<string, unknown> {
  const channelId = storedCreditChannelId(c);
  return {
    endpoint: c.endpoint,
    dvm: dvmLabelFromEndpoint(c.endpoint),
    credit_id: c.creditId,
    currency: c.currency,
    remaining_micro: c.remainingMicro,
    ...(c.status === "unbacked" ? { former_balance_micro: c.balanceMicro } : {}),
    ledger_seq: c.ledgerSeq,
    expiry_ms: c.expiryMs || null,
    status: c.status,
    ...(channelId ? { channel_id: channelId } : {}),
    ...(c.reconciliationPending ? { reconciliation_pending: true } : {}),
    tracked: c.selectionCleared !== true,
    drawable: c.selectionCleared !== true && c.status === "active" && !c.reconciliationPending,
    ...(c.siblingCredits
      ? { sibling_credits: c.siblingCredits.map((sibling) => siblingCreditJson(c, sibling)) }
      : {}),
    ...(c.provisional ? { provisional: true } : {}),
    ...(c.pendingDrains?.length ? { pending_drains: c.pendingDrains.map(pendingDrainJson) } : {}),
    ...(drainReceiptCount(c) > 0 ? { drain_receipts: drainReceiptCount(c) } : {}),
    ...(c.discrepancy
      ? {
          discrepancy: {
            expected_micro: c.discrepancy.expectedMicro,
            reported_micro: c.discrepancy.reportedMicro,
            draw_id: c.discrepancy.drawId,
            ledger_seq: c.discrepancy.ledgerSeq,
            ...(c.discrepancy.priorJobId ? { prior_job_id: c.discrepancy.priorJobId } : {}),
            job_id: c.discrepancy.jobId,
          },
        }
      : {}),
    headroom: headroomJson(headroom),
    display: humanCreditRow(c),
  };
}

function storedCreditChannelId(credit: StoredCredit): string | undefined {
  const tempo = loadTempoChannelAssociation(credit.endpoint, credit.callerPubkey, credit.creditId);
  if (tempo) return tempo.channelId;
  return findX402Channel({
    endpoint: credit.endpoint,
    callerPubkey: credit.callerPubkey,
    creditId: credit.creditId,
  })?.channelId;
}

function siblingCreditJson(
  record: StoredCredit,
  sibling: StoredSiblingCredit
): Record<string, unknown> {
  const command = creditDrainCommand(record.endpoint, sibling.creditId);
  const amount = formatFiat(Math.max(sibling.remainingMicro, 0) / 1_000_000, sibling.currency);
  return {
    credit_id: sibling.creditId,
    status: sibling.status ?? "active",
    currency: sibling.currency,
    balance_micro: sibling.balanceMicro,
    remaining_micro: sibling.remainingMicro,
    ledger_seq: sibling.ledgerSeq,
    expiry_ms: sibling.expiryMs || null,
    expired: sibling.expired,
    drainable: sibling.drainable,
    observed_at_ms: sibling.observedAt,
    tracked: false,
    drawable: false,
    ...(sibling.reconciliationPending ? { reconciliation_pending: true } : {}),
    ...(sibling.drainable ? { drain_command: command } : {}),
    display:
      sibling.status === "unbacked"
        ? `${amount} was formerly recorded on sibling credit ${sibling.creditId}; its backing finalized before collection and no action is available.`
        : `${amount} on sibling credit ${sibling.creditId} is held here but is not used for draws.`,
    ...(sibling.drainable ? { hint: `Reclaim it with this command: ${command}` } : {}),
  };
}

function localCreditCurrencyTotals(
  credits: StoredCredit[],
  implicitCredits: StoredImplicitCredit[] = []
): CreditCurrencyTotals[] {
  const totals = new Map<string, CreditCurrencyTotals>();
  for (const credit of credits) {
    const tracked = currencyTotal(totals, credit.currency);
    tracked.trackedCount += 1;
    if (credit.status === "active" && !credit.reconciliationPending) {
      tracked.drawableMicro += Math.max(credit.remainingMicro, 0);
    }
    for (const sibling of credit.siblingCredits ?? []) {
      const siblingTotal = currencyTotal(totals, sibling.currency);
      siblingTotal.siblingCount += 1;
      if (!sibling.expired && sibling.status !== "unbacked" && sibling.drainable) {
        siblingTotal.siblingSpendableMicro += Math.max(sibling.remainingMicro, 0);
      }
    }
  }
  for (const credit of implicitCredits) {
    const total = currencyTotal(totals, credit.currency);
    total.trackedCount += 1;
    if (credit.status === "active") total.drawableMicro += Math.max(credit.remainingMicro, 0);
  }
  return sortedCurrencyTotals(totals);
}

function cachedDvmJson(
  snapshot: StoredFundingMenuSnapshot,
  credits: StoredCredit[],
  headroomOf: HeadroomReader,
  identity: AttestedDvmIdentity | undefined
): Record<string, unknown> {
  const held = credits.filter(
    (credit) =>
      credit.endpoint === snapshot.endpoint &&
      credit.callerPubkey === snapshot.callerPubkey &&
      credit.currency === snapshot.menu.currency
  );
  const heldMicro = held.reduce((sum, credit) => sum + Math.max(credit.remainingMicro, 0), 0);
  const boundRails = [
    ...new Set(
      held
        .filter((credit) => credit.status === "active")
        .map((credit) => credit.rail)
        .filter(isCreditFundRail)
    ),
  ];
  const headroom = headroomOf.of({
    endpoint: snapshot.endpoint,
    signingPubkey: snapshot.callerPubkey,
    balanceMicro: heldMicro,
    menu: snapshot.menu,
    ...(identity ? { identity } : {}),
    ...(snapshot.builderPubkey ? { builderPubkey: snapshot.builderPubkey } : {}),
    ...(boundRails.length === 1 ? { boundRail: boundRails[0] } : {}),
  });
  const label = dvmLabelFromEndpoint(snapshot.endpoint);
  return {
    endpoint: snapshot.endpoint,
    dvm: label,
    caller_pubkey: snapshot.callerPubkey,
    credit_count: held.length,
    cached: true,
    observed_at_ms: snapshot.observedAt,
    headroom: headroomJson(headroom),
    display: `Cached funding bounds for ${label}, observed ${new Date(snapshot.observedAt).toISOString()}. ${String(held.length)} credit${held.length === 1 ? " is" : "s are"} held locally there.`,
    hint: `This is local cached funding guidance, not a fresh server assertion. Re-read it with 'dvm credit balance ${snapshot.endpoint}' before relying on current bounds.`,
  };
}

/** Whether a `perDvm` entry still says something, once identity bookkeeping is set aside. */
function hasPerDvmPolicy(entry: NonNullable<CreditConfig["perDvm"]>[string]): boolean {
  // Config is caller-owned and may have been written by a newer CLI. An older
  // clear must preserve every policy field it does not understand rather than
  // deciding that the identity stamps are the entry's only remaining content.
  return Object.keys(entry).some((key) => key !== "dvmId" && key !== "builderPubkey");
}

/** Whether a target spelling carries identity state that is unsafe to trust partially. */
function hasStoredIdentityBookkeepingAtEndpoint(
  perDvm: NonNullable<CreditConfig["perDvm"]>,
  endpoint: string
): boolean {
  return Object.entries(perDvm).some(
    ([origin, entry]) =>
      normalizeCreditEndpoint(origin) === endpoint &&
      (Object.hasOwn(entry, "dvmId") || Object.hasOwn(entry, "builderPubkey"))
  );
}

/**
 * The attested identity a `perDvm` config entry carries, for the offline
 * surfaces.
 *
 * Both halves or nothing: `builderPubkey` is what makes a `dvm_id` cost
 * something to claim, and an entry that recorded only one of them
 * stays hostname-scoped rather than pooling on a bare id.
 *
 * Config entries only, though a store row's `dvmId` + `attestedBuilderPubkey`
 * now means the same thing and `dvmLocationIdentity` reads it. What
 * a row still carries unverified is `StoredCredit.builderPubkey`, which is
 * `/v1/info#builder.pubkey` copied verbatim for the trust-override
 * lookup — never an attestation. These config entries are written only by
 * `credit posture`, `credit rail` and `reconcilePerDvmIdentity`, each of which
 * stamps the output of `attestedDvmIdentity`. {@link offlineDvmIdentity} is
 * what the row-shaped surfaces use instead.
 */
function configDvmIdentity(entry: {
  dvmId?: string;
  builderPubkey?: string;
}): AttestedDvmIdentity | undefined {
  if (typeof entry.dvmId !== "string" || entry.dvmId.length === 0) return undefined;
  if (typeof entry.builderPubkey !== "string") return undefined;
  const builderPubkey = entry.builderPubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(builderPubkey)) return undefined;
  return { dvmId: entry.dvmId, builderPubkey };
}

/**
 * The attested identity an offline surface may use for one endpoint: what this
 * caller's own config recorded from a verified `/v1/info`, else what a receipt
 * collected there proves. Never `StoredCredit.builderPubkey`, which is copied
 * off `/v1/info` verbatim and verifies nothing.
 */
function offlineDvmIdentity(
  credit: CreditConfig | undefined,
  endpoint: string,
  headroomOf: HeadroomReader
): AttestedDvmIdentity | undefined {
  const key = normalizeCreditEndpoint(endpoint);
  for (const [origin, entry] of Object.entries(credit?.perDvm ?? {})) {
    if (normalizeCreditEndpoint(origin) !== key) continue;
    const identity = configDvmIdentity(entry);
    if (identity) return identity;
  }
  return headroomOf.identityAt(endpoint);
}

function headroomInputsFor(
  c: StoredCredit,
  identity: AttestedDvmIdentity | undefined
): HeadroomInputs {
  const refillUnavailable = offlineRefillUnavailable(c);
  const boundRail = automaticCreditBoundRail(c);
  return {
    endpoint: c.endpoint,
    signingPubkey: c.callerPubkey,
    balanceMicro: c.remainingMicro,
    ...(identity ? { identity } : {}),
    ...(c.menu ? { menu: c.menu } : {}),
    ...(c.builderPubkey ? { builderPubkey: c.builderPubkey } : {}),
    ...(refillUnavailable ? { refillUnavailable } : {}),
    ...(boundRail ? { boundRail } : {}),
  };
}

/**
 * Diagnose only a binding disappearance an offline listing can prove — at the
 * rail level, and at the x402 instrument level below it. The two are
 * mutually exclusive by construction: one keys on a Lightning binding, the
 * other on a recorded x402 instrument.
 */
function offlineRefillUnavailable(c: StoredCredit): CreditRefillUnavailable | undefined {
  if (c.status !== "active") return undefined;
  return offlineRailUnavailable(c) ?? offlineX402InstrumentUnavailable(c);
}

/**
 * A missing float is conclusive for Lightning. Cashu eligibility also needs
 * the DVM's current lock offer from `/v1/info`, which the local credit store
 * deliberately does not persist; its absence here is therefore unknown, not
 * evidence that an ecash-bound credit is stranded.
 */
function offlineRailUnavailable(c: StoredCredit): CreditRefillUnavailable | undefined {
  if (c.rail !== "lightning") return undefined;
  if (availableRails({ ...(c.menu ? { menu: c.menu } : {}) }).includes(c.rail)) return undefined;
  return buildCreditRefillUnavailable({
    dvm: c.endpoint,
    endpoint: c.endpoint,
    creditId: c.creditId,
    boundRail: c.rail,
    balanceMicro: c.remainingMicro,
    currency: c.currency,
  });
}

/**
 * The x402 rail can be fundable while this credit is not: `/v1/credit` binds a
 * credit to the *instrument* that opened it as firmly as to the rail, so a DVM
 * that has stopped advertising that flavour can only refuse every top-up.
 * The listing is the place to say so: the funding-time refusal only arrives once a
 * funding is attempted, and an unrefilled balance otherwise just drains.
 *
 * Every input is on the record already, so this stays as offline as the rail
 * diagnosis beside it. Each guard is a claim this listing cannot prove:
 *
 * - An absent instrument is **unknown**, never `exact` — a credit adopted from
 *   a balance read, or opened before the field existed, routes by menu.
 * - An absent menu snapshot is no evidence of what a DVM offers; refusing on
 *   silence would strand a credit it still funds. Same guard the funding path
 *   takes (`fundOverX402Rail`).
 * - With no x402 wallet connected there is nothing to fund from, and
 *   reconnecting one is not the same news as a binding that closed.
 *
 * A wallet pin is evidence only after the binding and stored menu establish a
 * chain the credit can still refill on. It never turns a healthy binding into
 * a strand: that temporary mismatch gets its own code and the opposite remedy,
 * re-pin rather than drain. The funding path splits the same cases:
 *
 * - The bound flavour is offered on **no** chain: the DVM dropped the
 *   instrument outright, which is true wherever the credit's own chain is.
 * - A channel whose chain is on the record, at a DVM that no longer
 *   opens channels there: `computeChannelId` folds the chain into the channel
 *   id, so a re-pin derives a different channel rather than reaching this
 *   balance, however many other chains the DVM opens channels on.
 *
 * A channel with no recorded chain stays unknown by that field's own contract.
 * An exact credit is bound to no chain of its own, so every chain where the
 * stored menu offers exact is a valid re-pin target.
 */
function offlineX402InstrumentUnavailable(c: StoredCredit): CreditRefillUnavailable | undefined {
  const instrument = c.x402Instrument;
  const bound = x402FlavourForInstrument(instrument);
  if (!instrument || !bound || !c.menu) return undefined;
  const wallet = loadX402Wallet();
  if (!wallet) return undefined;
  const channelBound = bound === X402_BATCH_SETTLEMENT_SCHEME;
  const boundNetworks = channelBound
    ? x402CreditChannelNetworks(c.menu)
    : x402CreditExactNetworks(c.menu);
  const otherNetworks = channelBound
    ? x402CreditExactNetworks(c.menu)
    : x402CreditChannelNetworks(c.menu);
  const channelNetwork = channelBound ? c.x402ChannelNetwork : undefined;
  const strandedChain =
    channelNetwork && !boundNetworks.includes(channelNetwork) ? channelNetwork : undefined;
  if (boundNetworks.length === 0 || strandedChain) {
    return buildCreditRefillInstrumentUnavailable({
      dvm: c.endpoint,
      endpoint: c.endpoint,
      creditId: c.creditId,
      instrument,
      ...(strandedChain ? { network: strandedChain } : {}),
      alternativeOffered: strandedChain
        ? otherNetworks.includes(strandedChain)
        : otherNetworks.length > 0,
      balanceMicro: c.remainingMicro,
      currency: c.currency,
    });
  }
  if (channelBound && !channelNetwork) return undefined;
  const refillNetworks = channelNetwork ? [channelNetwork] : boundNetworks;
  if (refillNetworks.includes(wallet.network)) return undefined;
  return buildCreditRefillWalletNetworkMismatch({
    dvm: c.endpoint,
    endpoint: c.endpoint,
    creditId: c.creditId,
    instrument,
    walletNetwork: wallet.network,
    refillNetworks,
    balanceMicro: c.remainingMicro,
    currency: c.currency,
  });
}

function pendingFundingJson(funding: PendingFunding): Record<string, unknown> {
  return {
    endpoint: funding.endpoint,
    dvm: dvmLabelFromEndpoint(funding.endpoint),
    caller_pubkey: funding.callerPubkey,
    credit_id: funding.creditId,
    fund_id: funding.fundId,
    amount_micro: funding.amountMicro,
    rail: funding.rail,
    requested_at_ms: funding.requestedAt,
    ...(funding.bolt11 ? { bolt11: funding.bolt11 } : {}),
    ...(funding.paymentHash ? { payment_hash: funding.paymentHash } : {}),
    ...(funding.amountMsats !== undefined ? { amount_msats: funding.amountMsats } : {}),
    ...(funding.expiresAtMs !== undefined ? { expires_at_ms: funding.expiresAtMs } : {}),
    // The Tempo rail's own figure: what the signed credential lets the DVM
    // capture if the funding is never resumed.
    ...(funding.authorizedMicro !== undefined ? { authorized_micro: funding.authorizedMicro } : {}),
    display: pendingFundingDisplay(funding),
    hint: pendingFundingHint(funding),
  };
}


function pendingFundingDisplay(funding: PendingFunding): string {
  const identity = `funding ${funding.fundId} for credit ${funding.creditId} at ${funding.endpoint}`;
  if (funding.rail === "tempo") {
    return `Pending ${fundingRailLabel(funding.rail)} ${identity}: its channel credential has not been confirmed.`;
  }
  return funding.bolt11
    ? `Pending ${fundingRailLabel(funding.rail)} ${identity}: invoice issued, awaiting confirmation.`
    : `Pending ${fundingRailLabel(funding.rail)} ${identity}: invoice not yet issued.`;
}

function pendingFundingHint(funding: PendingFunding): string {
  const base = `Reconcile this exact funding with 'dvm credit balance ${funding.endpoint}', or resume it with 'dvm credit fund ${funding.endpoint}'.`;
  return funding.rail === "tempo"
    ? `${base} There is no invoice to pay on this rail: a resume replays the credential this wallet already signed rather than authorizing a second one.`
    : base;
}

function pendingFundingsDisplay(pending: PendingFunding[]): string {
  const rails = [...new Set(pending.map((funding) => fundingRailLabel(funding.rail)))];
  const count = String(pending.length);
  return rails.length === 1
    ? `${count} ${rails[0]} credit funding${pending.length === 1 ? " is" : "s are"} awaiting confirmation.`
    : `${count} credit fundings across ${rails.join(" and ")} are awaiting confirmation.`;
}

function drainReceiptCount(c: StoredCredit): number {
  return (c.drainEvidence ?? []).reduce((sum, e) => sum + e.receipts.length, 0);
}

function humanCreditRow(c: StoredCredit): string {
  const label = dvmLabelFromEndpoint(c.endpoint).padEnd(12);
  const amount = formatFiat(
    Math.max(c.status === "unbacked" ? c.balanceMicro : c.remainingMicro, 0) / 1_000_000,
    c.currency
  );
  const others = otherCreditDrains(c, c.creditId);
  // Split, because the two say different things to whoever reclaims them: one
  // names the credit to pass, the other is a drain whose credit nothing here
  // knows — calling that "a previous credit" would assert what it can't.
  const stranded = others.filter((d) => d.creditId !== undefined).length;
  const unattributed = others.length - stranded;
  const flags = [
    c.status !== "active" ? c.status : undefined,
    c.reconciliationPending ? "backing reconciliation pending" : undefined,
    c.provisional ? "syncing" : undefined,
    pendingDrainFor(c, c.creditId) ? "drain pending" : undefined,
    stranded > 0
      ? `${String(stranded)} unclaimed drain${stranded === 1 ? "" : "s"} on a previous credit`
      : undefined,
    unattributed > 0
      ? `${String(unattributed)} unattributed drain${unattributed === 1 ? "" : "s"}`
      : undefined,
    drainReceiptCount(c) > 0 ? "reclaim evidence held" : undefined,
    c.discrepancy ? "⚠ balance mismatch — see 'dvm credit balance'" : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const expiry =
    c.expiryMs > 0 ? ` · expires ${new Date(c.expiryMs).toISOString().slice(0, 10)}` : "";
  return `${label}  ${amount}${expiry}${flags ? ` · ${flags}` : ""}`;
}

/** Compact released-balance summary: one line per DVM/currency/state, never one per failed job. */
function humanImplicitCreditRows(credits: StoredImplicitCredit[]): string[] {
  const groups = new Map<string, StoredImplicitCredit[]>();
  for (const credit of credits) {
    const key = `${credit.endpoint}\u0000${credit.currency}\u0000${credit.status}`;
    const group = groups.get(key) ?? [];
    group.push(credit);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const first = group[0];
    const amount = formatFiat(
      group.reduce((sum, credit) => sum + Math.max(credit.remainingMicro, 0), 0) / 1_000_000,
      first.currency
    );
    const label = dvmLabelFromEndpoint(first.endpoint).padEnd(12);
    const count = `${String(group.length)} released per-call balance${group.length === 1 ? "" : "s"}`;
    if (first.status === "lost") {
      return `${label}  ${amount} across ${count} · lost; no drain path is available`;
    }
    const expiry = Math.min(...group.map((credit) => credit.expiryMs));
    return `${label}  ${amount} across ${count} · next request uses the earliest expiry first · expires by ${new Date(expiry).toISOString().slice(0, 10)}`;
  });
}

function humanSiblingCreditRow(record: StoredCredit, sibling: StoredSiblingCredit): string {
  const amount = formatFiat(
    Math.max(sibling.status === "unbacked" ? sibling.balanceMicro : sibling.remainingMicro, 0) /
      1_000_000,
    sibling.currency
  );
  if (sibling.status === "unbacked") {
    return `Sibling ${sibling.creditId}: ${amount} former balance · unbacked and closed; no action is available.`;
  }
  const state = sibling.expired ? "expired, reclaimable" : "not used for draws";
  return sibling.drainable
    ? `Sibling ${sibling.creditId}: ${amount} · ${state}. Reclaim with this command: ${creditDrainCommand(record.endpoint, sibling.creditId)}`
    : `Sibling ${sibling.creditId}: ${amount} · ${state}; no reclaim is currently available.`;
}

/** Query and reconcile signed prepaid-credit balances. */
export async function creditBalance(
  dvm: string | undefined,
  opts: CreditBalanceOptions
): Promise<void> {
  await runCreditBalance(dvm, opts);
}

export async function creditFund(dvm: string, opts: CreditFundOptions): Promise<void> {
  await runCreditFund(dvm, opts);
}

export async function creditDrain(dvm: string, opts: CreditDrainOptions): Promise<void> {
  await runCreditDrain(dvm, opts);
}

export async function creditReceipts(dvm: string, opts: CreditReceiptsOptions): Promise<void> {
  await runCreditReceipts(dvm, opts);
}
