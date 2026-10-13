
import {
  asProviderTextOpt,
  authenticatedBuilderPubkey,
  CREDIT_FUND_RAILS,
  CREDIT_FUNDING_MODES,
  type CreditFundingMode,
  type CreditFundRail,
  type CreditMenu,
  DvmError,
  formatUsd,
  isCreditFundingMode,
  isCreditFundRail,
  isStablecoinFundRail,
  listResumableTempoChargeFundings,
  listResumableX402ExactFundings,
  listResumableX402Fundings,
  loadCredit,
  loadPendingFunding,
  loadReceipts,
  msatsToUsd,
  type PendingFunding,
  type ProviderInfo,
  signDvmRequestData,
  signedRequestDomain,
  type StoredCredit,
} from "@dvmkit/sdk/internal";
import {
  type Config,
  loadConfig,
} from "../identity";
import {
  resolveSigningIdentity,
} from "../cli-identity-resolve";
import { type CreditFundOutcome, type CreditRailSource, fundCredit } from "../credit-fund";
import { effectiveCreditPosture, effectiveFundingRail } from "../credit-policy";
import { statusSnapshot } from "../budget-ledger";
import { tryResolveBtcUsdRate } from "../btc-rate";
import {
  randomUUID,
} from "crypto";
import {
  computeHeadroom,
  type CreditHeadroom,
  type CreditRouteAvailability,
  withHeadroom,
} from "../credit-headroom";
import {
  takeCreditNoticeFields,
} from "../credit-notice";
import {
  providerDvmIdentity,
  reconcilePerDvmIdentity,
} from "../credit-per-dvm";
import {
  adoptWedgedChannelDrain,
} from "../credit-reclaim";
import {
  localCreditRouteAvailability,
} from "../credit-route-availability";
import {
  createDvmTransport,
} from "../transport";
import {
  dvmLabelFromEndpoint,
} from "../../commands/wallet-history";
import { renderCreditFunding } from "../../commands/credit/render";
import {
  providerCopyHint,
  describeCreditProvider,
  resolveCreditEndpoint,
  creditOp,
  advisoryBtcRate,
} from "./shared";
import type { CreditFundOptions } from "./options";

/**
 * Load a prepaid balance at one DVM, deliberately.
 *
 * The rail is picked by {@link fundCredit}, off this DVM's advertised menu:
 * small from the pocket, large direct to the float. The Lightning
 * branch is why this verb exists — the job path funds a credit by attaching a
 * proof to the request, and a bolt11 has no header to attach to, so an
 * all-Lightning caller could otherwise never open a credit at all. The menu is
 * fetched here when nothing local carries one, so the pick and the floor
 * pre-check hold on first contact too.
 */
export async function runCreditFund(dvm: string, opts: CreditFundOptions): Promise<void> {
  const endpoint = resolveCreditEndpoint(dvm);
  const config = loadConfig();
  const signer = resolveSigningIdentity({ as: opts.as, config });

  if (opts.amount && opts.targetJobs !== undefined) {
    throw new DvmError(
      "invalid_argument",
      "Pass either --amount or --target-jobs, not both.",
      "--amount states the figure; --target-jobs derives it from this DVM's price. Pick the one you actually know.",
      {
        display: `Two different sizings were asked for at once. Say how much to load (--amount '$2') or how much work to cover (--target-jobs 500) — not both.`,
      }
    );
  }
  const fundingMode = parseFundingMode(opts.fundingMode);
  const flagRail = parseFundRail(opts.rail);
  // Both Bitcoin rails pay once and have no reusable form, so naming one
  // alongside a mode is a contradiction rather than a preference to resolve —
  // and it is knowable here, before `/v1/info` is even asked. A
  // *bound* or pinned Bitcoin rail is not knowable until the store is read, so
  // `fundCredit` refuses that one with copy that can name the binding.
  if (fundingMode && flagRail && !isStablecoinFundRail(flagRail)) {
    throw new DvmError(
      "invalid_argument",
      `--funding-mode does not apply to --rail ${flagRail}.`,
      `Funding over ${flagRail} is always a single payment. Drop --funding-mode, or ask for --rail x402 or --rail tempo.`,
      {
        display: `Loading a balance over ${flagRail} is always one payment, so there is no one-shot-versus-reusable choice to make there. That choice exists on the stablecoin rails — x402 and Tempo.`,
      }
    );
  }
  const targetJobs = parseTargetJobs(opts.targetJobs);
  const explicitMicro = opts.amount ? parseAmountMicro(opts.amount) : undefined;
  const maxCashuPrincipalSats = parseCashuSats(
    opts.maxCashuPrincipalSats,
    "--max-cashu-principal-sats"
  );
  const maxCashuFeeSats = parseCashuSats(opts.maxCashuFeeSats, "--max-cashu-fee-sats");

  // Identity has to be known before the first store read: the same DVM may be
  // addressed through an origin this record has never seen, and treating that
  // as an empty store would open a second credit instead of refilling the one
  // already held. Funding requires `/v1/info` later anyway, so read it once up
  // front and carry the result into the operation.
  const providerInfo = await describeCreditProvider(endpoint);
  const attestedIdentity = providerDvmIdentity(providerInfo);

  // `off` doesn't just stop purchases, it stops *draws* — so a
  // balance funded under it could never be spent, only drained back. Refusing
  // is the honest answer; funding into a hole would not be a favour.
  //
  // Gated after `/v1/info` rather than on the bare hostname: the
  // caller may have switched credit off under this DVM's other spelling, and
  // reading only the one they typed here is how that opt-out went missing.
  if (effectiveCreditPosture(config?.credit, endpoint, attestedIdentity).posture === "off") {
    throw new DvmError(
      "credit_posture_off",
      `Prepaid credit is switched off for ${dvmLabelFromEndpoint(endpoint)}, so a balance funded here could not be drawn on.`,
      `Run 'dvm credit posture suggest --dvm ${dvm}' (or 'auto') first, then fund.`,
      {
        display: `Nothing was funded: prepaid credit is switched off for ${dvmLabelFromEndpoint(endpoint)}, and a balance you can't draw on is worse than none.`,
        anchor: "credit_posture_off",
      }
    );
  }
  // Same reconciliation the request path runs, and it matters most
  // here: this verb is about to pick a rail, and two spellings of one DVM
  // pinned to different rails have to be cleared and named before it does.
  await reconcilePerDvmIdentity({
    endpoint,
    identity: attestedIdentity,
    config: config?.credit,
    dvm,
    ...(opts.human ? { human: true } : {}),
  });
  const stored = loadCredit(endpoint, signer.pubkey, attestedIdentity);
  const pending = loadPendingFunding(endpoint, signer.pubkey, opts.creditId);
  // The x402 journal is the other durable intent this verb can walk into, and
  // it has to be found the same way. `fundCredit` resumes only an exact credit
  // match, and a crash before the first response leaves no stored
  // credit to derive that id from — so without this lookup a re-run mints a
  // fresh uuid, opens a second credit, and orphans a signature only the balance
  // sweep would ever touch again — a channel voucher, or on the exact flavour an
  // ERC-3009 authorization the DVM may already have settled, or a
  // Tempo charge in the same position.
  const signedPending = pendingSignedResume({
    endpoint,
    signer,
    opts,
    stored,
    journalled: pending,
  });
  // Topping up an existing credit has no rail choice to make: `/v1/credit`
  // binds a credit to the rail it was opened on. An already-persisted intent
  // wins over fresh flags: resolving it first is what prevents a re-invocation
  // from minting a second payable invoice. With no pending intent, `--rail`
  // still wins so a caller can deliberately force a fresh credit onto another
  // rail.
  //
  // The persisted `fundingRail` pin sits below the credit's binding
  // on purpose: the binding is the DVM's refusal to blend two rails' native
  // value, which no caller preference can talk it out of. With no binding and
  // no flag, the pin forces; with none of the three, the amount rule decides.
  const configPin = effectiveFundingRail(config?.credit, endpoint, attestedIdentity);
  const boundRail = pinnedRail(stored, opts.creditId);
  const railSource: CreditRailSource | undefined = flagRail
    ? "flag"
    : boundRail
      ? "credit_bound"
      : configPin.source === "per_dvm" || configPin.source === "global"
        ? configPin.source
        : undefined;
  const rail = pending?.rail ?? flagRail ?? boundRail ?? configPin.rail;

  // `--target-jobs` needs this DVM's price, so its figure lands after
  // `/v1/info`; everything else is knowable here.
  let amountMicro =
    pending?.amountMicro ??
    signedPending?.amountMicro ??
    explicitMicro ??
    (targetJobs === undefined ? defaultFundMicro(stored) : undefined);
  if (amountMicro === undefined && targetJobs === undefined) {
    throw new DvmError(
      "invalid_argument",
      `No prepaid credit is tracked at ${endpoint}, so there is no refill amount to infer.`,
      "Pass the amount to load, e.g. --amount '$2', or the workload to cover, e.g. --target-jobs 500.",
      {
        display: `This agent holds no prepaid balance at ${endpoint} yet, so it can't guess how much to load. Say how much, e.g. --amount '$2', or how much work you have, e.g. --target-jobs 500.`,
      }
    );
  }

  const transport = createDvmTransport();
  try {
    // The menu is what makes this verb amount-aware. Every
    // menu-keyed rule below — the Lightning floor pre-check, the rail pick,
    // the sizing bounds — reads the snapshot the *request* path records off a
    // quote or a 402, so a caller whose first contact with a DVM is this verb
    // had none of them. `/v1/info` carries no credit block, so the menu is
    // fetched on its own hop; a stored snapshot skips it, and so does a
    // resumed intent, whose invoice is already issued and whose rail is
    // already pinned.
    const menu =
      stored?.menu ??
      ((pending ?? signedPending)
        ? undefined
        : await discoverCreditMenu(transport, endpoint, signer));

    // A persisted intent already names its figure — re-sizing it would mint a
    // second payable invoice for the same funding, which is the one thing the
    // pending record exists to prevent.
    let sizing: TargetJobsSizing | undefined;
    if (targetJobs !== undefined && !pending && !signedPending) {
      sizing = await sizeForTargetJobs({ endpoint, targetJobs, stored, menu, providerInfo });
      amountMicro = sizing.amountMicro;
    }
    // Narrowed by the two guards above: either a figure resolved, or the
    // `--target-jobs` sizing just produced one.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const fundMicro = amountMicro!;

    // The trust ladder bounds what the *auto* path chooses; an explicit figure
    // is never hard-capped. It is, however, marked: a funding that would leave
    // more on deposit here than earned trust warrants has to name itself, so a
    // confused agent following an injected "fund $200 at this machine" leaves a
    // greppable trace rather than a silent transfer.
    if (!pending && !signedPending && (explicitMicro !== undefined || targetJobs !== undefined)) {
      await enforceTrustTier({
        endpoint,
        amountMicro: fundMicro,
        signingPubkey: signer.pubkey,
        stored,
        menu,
        providerInfo,
        opts,
        config,
      });
    }

    const outcome = await fundCredit({
      transport,
      ref: { endpoint },
      signing: signer,
      creditId:
        pending?.creditId ??
        opts.creditId ??
        (canRefillStoredCredit(stored)
          ? stored.creditId
          : (signedPending?.creditId ?? randomUUID())),
      amountMicro: fundMicro,
      human: opts.human,
      providerInfo,
      ...(menu ? { menu } : {}),
      ...(stored ? { targetMicro: Math.max(stored.targetMicro, fundMicro) } : {}),
      ...(rail ? { rail } : {}),
      ...(rail && railSource ? { railSource } : {}),
      ...(fundingMode ? { fundingMode } : {}),
      ...(opts.cashuMint ? { cashuMint: opts.cashuMint } : {}),
      ...(maxCashuPrincipalSats !== undefined ? { maxCashuPrincipalSats } : {}),
      ...(maxCashuFeeSats !== undefined ? { maxCashuFeeSats } : {}),
    });

    // The verb was asked for a funding. `refused` and `unavailable` both mean
    // it didn't happen, so both are a non-zero exit — unlike the post-job
    // auto-refill, where an opportunistic skip is the correct silent outcome.
    //
    // Re-wrapped rather than rethrown: the outcome's `display`/`hint` are the
    // composed story (a budget refusal appends "nothing was charged, and any
    // prepaid balance already at this DVM keeps working"; a post-payment
    // refusal names the sats that left), and the underlying error carries
    // neither. Its code and structured fields are kept so the shape an agent
    // branches on doesn't change.
    if (outcome.status === "refused" || outcome.status === "unavailable") {
      const err = outcome.error;
      // A wedged channel refuses this top-up and names the one drain id that
      // still reclaims the balance already on it. Adopting it here is what makes
      // the reclaim a no-argument command. The post-job auto-refill
      // meets the same refusal and runs the same adoption.
      const adopted =
        err?.code === "settlement_pending"
          ? adoptWedgedChannelDrain({
              endpoint,
              ...(attestedIdentity ? { identity: attestedIdentity } : {}),
              // The handle as typed, so both doors quote the same command for
              // one hold — the resolved endpoint would be a second spelling of
              // the reclaim the refill already named.
              handle: dvm,
              callerPubkey: signer.pubkey,
              creditId: outcome.creditId,
              data: err.data,
            })
          : undefined;
      const baseHint = outcome.hint ?? err?.hint;
      throw new DvmError(
        err?.code ?? "credit_funding_unavailable",
        outcome.display,
        adopted ? `${baseHint ? `${baseHint} ` : ""}${adopted.advice}` : baseHint,
        {
          ...(err?.data ?? {}),
          display: outcome.display,
          endpoint,
          credit_id: outcome.creditId,
          fund_id: outcome.fundId,
          ...(adopted ? { drain_recorded: true, drain_command: adopted.command } : {}),
          ...(outcome.rail ? { rail: outcome.rail } : {}),
          ...(outcome.fundingMode ? { funding_mode: outcome.fundingMode } : {}),
          ...(fundingInstrumentOf(outcome)
            ? { funding_instrument: fundingInstrumentOf(outcome) }
            : {}),
          ...(outcome.spentSats !== undefined ? { spent_sats: outcome.spentSats } : {}),
          ...(outcome.principalSats !== undefined ? { principal_sats: outcome.principalSats } : {}),
          ...(outcome.routingFeeSats !== undefined
            ? { routing_fee_sats: outcome.routingFeeSats }
            : {}),
          ...(outcome.totalWalletFeeSats !== undefined
            ? { total_wallet_fee_sats: outcome.totalWalletFeeSats }
            : {}),
          ...(outcome.unitemizedWalletFeeSats !== undefined
            ? { unitemized_wallet_fee_sats: outcome.unitemizedWalletFeeSats }
            : {}),
          ...(outcome.walletDebitSats !== undefined
            ? { wallet_debit_sats: outcome.walletDebitSats }
            : {}),
          ...(outcome.spentMicro !== undefined ? { spent_micro: outcome.spentMicro } : {}),
          ...(outcome.paymentOutcome ? { payment_outcome: outcome.paymentOutcome } : {}),
        }
      );
    }

    // A resume answers the funding the journal holds, not the one that was just
    // typed — so when the two differ, say so rather than reporting a $2 replay
    // as if it were the $5 that was asked for.
    const resumedNote = signedPending
      ? `Resumed the funding already signed for credit ${signedPending.creditId} ($${formatUsd(signedPending.amountMicro / 1_000_000)}) instead of opening a new one.${
          explicitMicro !== undefined && explicitMicro !== signedPending.amountMicro
            ? ` The $${formatUsd(explicitMicro / 1_000_000)} you asked for was not sent — run this again once the resume settles.`
            : ""
        }`
      : undefined;

    const modeSentence = fundingModeSentence(outcome);
    // The DVM's own copy about this funding, marked rather than merged into the
    // CLI's. Only the repair sends any today.
    const providerDisplay = asProviderTextOpt(outcome.providerDisplay);
    const providerHint = asProviderTextOpt(outcome.providerHint);
    const humanLines = [
      sizing?.display,
      resumedNote,
      outcome.display,
      providerDisplay || providerHint
        ? `The DVM says: ${[providerDisplay?.text, providerHint?.text].filter(Boolean).join(" ")}`
        : undefined,
      modeSentence,
      outcome.hint,
    ].filter((line): line is string => line !== undefined);
    renderCreditFunding({
      human: opts.human === true,
      humanLines,
      json: {
        op: "fund",
        endpoint,
        status: outcome.status,
        credit_id: outcome.creditId,
        fund_id: outcome.fundId,
        ...(resumedNote ? { resumed: resumedNote } : {}),
        ...(sizing ? { sizing: sizingJson(sizing) } : {}),
        ...(outcome.rail ? { rail: outcome.rail } : {}),
      // The customer-level choice, and the wire instrument under it. Present
      // only on the stablecoin rails, which are the only ones that have one
      // — and present whether or not `--funding-mode` asked for it,
      // so an agent reads what happened rather than what it requested.
        ...(outcome.fundingMode ? { funding_mode: outcome.fundingMode } : {}),
        ...(fundingInstrumentOf(outcome)
          ? { funding_instrument: fundingInstrumentOf(outcome) }
          : {}),
        ...(modeSentence ? { funding_mode_display: modeSentence } : {}),
        ...(outcome.fundedMicro !== undefined ? { funded_micro: outcome.fundedMicro } : {}),
        ...(outcome.spentSats !== undefined ? { spent_sats: outcome.spentSats } : {}),
        ...(outcome.principalSats !== undefined ? { principal_sats: outcome.principalSats } : {}),
        ...(outcome.routingFeeSats !== undefined
          ? { routing_fee_sats: outcome.routingFeeSats }
          : {}),
        ...(outcome.totalWalletFeeSats !== undefined
          ? { total_wallet_fee_sats: outcome.totalWalletFeeSats }
          : {}),
        ...(outcome.unitemizedWalletFeeSats !== undefined
          ? { unitemized_wallet_fee_sats: outcome.unitemizedWalletFeeSats }
          : {}),
        ...(outcome.walletDebitSats !== undefined
          ? { wallet_debit_sats: outcome.walletDebitSats }
          : {}),
        ...(outcome.spentMicro !== undefined ? { spent_micro: outcome.spentMicro } : {}),
        ...(outcome.paymentOutcome ? { payment_outcome: outcome.paymentOutcome } : {}),
        ...(outcome.transactionHash ? { transaction_hash: outcome.transactionHash } : {}),
      // `credit_id` above is already the credit the balance landed on. This
      // flags that it is not the one the funding was requested against, so an
      // agent tracking the original id knows to follow it.
        ...(outcome.reconciled ? { reconciled: true } : {}),
        ...(outcome.credit ? { credit: outcome.credit } : {}),
      // Whatever the run accumulated on the way here — today the rail-pin
      // conflict this verb's own reconcile clears. It is said once
      // and there is nothing left to re-derive afterwards, so dropping it on
      // the success path would lose it outright for the agent audience.
      // `error-handler.ts` covers the throw path.
        ...takeCreditNoticeFields(),
        ...(providerDisplay ? { provider_display: providerDisplay } : {}),
        ...(providerHint ? { provider_hint: providerHint } : {}),
        display: outcome.display,
        hint:
          (outcome.hint ??
            "Prepaid balances are drawn down job by job with no payment per call. See them with 'dvm credit list'.") +
          providerCopyHint("funding", Boolean(providerDisplay ?? providerHint)),
      },
    });
  } finally {
    transport.close();
  }
}

/**
 * The signed-payment journal entry this invocation should adopt as its credit,
 * if any.
 *
 * Only fills the slot the derivation would otherwise hand a fresh uuid: an
 * explicit `--credit-id`, a resumable funding intent on another rail and a refillable stored
 * credit all name the credit themselves, and a journal entry for some *other*
 * credit is `fundCredit`'s to refuse honestly rather than this verb's to
 * silently substitute. A refused entry is nobody's to adopt: it names a credit
 * this DVM will never accept, so this invocation gets a fresh one.
 *
 * Three journals feed it — the reusable x402 channel's, the exact flavour's
 * and the Tempo one-shot charge's. They are separate
 * stores because the records are, but the question this verb asks is the same
 * one either way: is there money already signed at this DVM that a fresh credit
 * id would orphan?
 */
function pendingSignedResume(args: {
  endpoint: string;
  signer: { pubkey: string };
  opts: CreditFundOptions;
  stored: StoredCredit | undefined;
  journalled: PendingFunding | undefined;
}): { creditId: string; amountMicro: number } | undefined {
  if (args.opts.creditId || args.journalled || canRefillStoredCredit(args.stored)) return undefined;
  const scope = { endpoint: args.endpoint, callerPubkey: args.signer.pubkey };
  return [
    ...listResumableX402Fundings(scope),
    ...listResumableX402ExactFundings(scope),
    ...listResumableTempoChargeFundings(scope),
  ].sort((a, b) => a.requestedAt - b.requestedAt)[0];
}

/**
 * Parse `--rail`, refusing anything that isn't a funding rail we can drive.
 *
 * Enumerated from {@link CREDIT_FUND_RAILS} rather than a hand-written list, so
 * a rail added to the registry is accepted here — and named in the refusal —
 * with no edit.
 */
function parseFundRail(raw: string | undefined): CreditFundRail | undefined {
  if (!raw) return undefined;
  const rail = raw.trim().toLowerCase();
  if (isCreditFundRail(rail)) return rail;
  throw new DvmError(
    "invalid_argument",
    `Unknown funding rail: "${raw}".`,
    `Use ${CREDIT_FUND_RAILS.map((r) => `--rail ${r}`).join(" or ")}.`,
    {
      display: `"${raw}" isn't a way to load a prepaid balance. The options are ${CREDIT_FUND_RAILS.join(" and ")}.`,
    }
  );
}

/**
 * Parse `--funding-mode`, refusing anything that isn't a mode we can drive.
 *
 * Enumerated from {@link CREDIT_FUNDING_MODES} for the same reason
 * {@link parseFundRail} enumerates the rail registry: the refusal names what
 * this build accepts rather than a hand-written list that can drift.
 */
function parseFundingMode(raw: string | undefined): CreditFundingMode | undefined {
  if (!raw) return undefined;
  const mode = raw.trim().toLowerCase();
  if (isCreditFundingMode(mode)) return mode;
  throw new DvmError(
    "invalid_argument",
    `Unknown funding mode: "${raw}".`,
    `Use ${CREDIT_FUNDING_MODES.map((m) => `--funding-mode ${m}`).join(" or ")}.`,
    {
      display: `"${raw}" isn't a way to fund a prepaid balance. Both options load prepaid credit: 'one-shot' pays once, 'reusable' puts up channel collateral later top-ups draw against.`,
    }
  );
}

/**
 * The wire instrument behind a funded outcome — the protocol detail under the
 * mode, reported so an agent can name what actually settled without having to
 * map it back from the rail.
 */
function fundingInstrumentOf(outcome: CreditFundOutcome): string | undefined {
  return outcome.tempoIntent ?? outcome.x402Flavour;
}

function fundingModeSentence(outcome: CreditFundOutcome): string | undefined {
  if (!outcome.fundingMode) return undefined;
  const instrument = fundingInstrumentOf(outcome);
  const mode =
    outcome.fundingMode === "reusable"
      ? "Reusable funding: the payment puts up channel collateral that later top-ups draw against"
      : "One-shot funding: the payment settles once and opens no channel";
  return `${mode}${instrument ? ` (${outcome.rail} '${instrument}')` : ""}. Either way what it bought is prepaid credit.`;
}

/**
 * The rail a tracked credit is bound to, when this funding targets that credit.
 * A `--credit-id` naming something else is a different credit with its own
 * binding, so the pin doesn't carry across.
 */
function pinnedRail(
  stored: StoredCredit | undefined,
  creditId: string | undefined
): CreditFundRail | undefined {
  if (!canRefillStoredCredit(stored)) return undefined;
  if (creditId && creditId !== stored.creditId) return undefined;
  return isCreditFundRail(stored.rail) ? stored.rail : undefined;
}

/** Active and expired credits retain one server identity and funding rail. */
function canRefillStoredCredit(stored: StoredCredit | undefined): stored is StoredCredit {
  return stored?.status === "active" || stored?.status === "expired";
}

function parseAmountMicro(raw: string): number {
  const match = /^\$?(\d+(?:\.\d{1,6})?)$/.exec(raw.trim());
  const micro = match ? Math.round(Number(match[1]) * 1_000_000) : 0;
  if (micro <= 0) {
    throw new DvmError(
      "invalid_argument",
      `Invalid funding amount: "${raw}".`,
      "Pass a positive amount in the credit's currency, e.g. --amount '$2'.",
      { display: `"${raw}" isn't an amount we can read. Try something like --amount '$2'.` }
    );
  }
  return micro;
}

function parseTargetJobs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const jobs = Number(raw.trim());
  if (!Number.isSafeInteger(jobs) || jobs <= 0) {
    throw new DvmError(
      "invalid_argument",
      `Invalid --target-jobs value: "${raw}".`,
      "Pass a whole number of jobs to cover, e.g. --target-jobs 500.",
      {
        display: `"${raw}" isn't a number of jobs. Try something like --target-jobs 500.`,
      }
    );
  }
  return jobs;
}

function parseCashuSats(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== raw) {
    throw new DvmError(
      "invalid_argument",
      `Invalid ${flag} value: "${raw}".`,
      `Pass ${flag} as a whole non-negative number of sats.`,
      { display: `"${raw}" is not a whole non-negative sat amount for ${flag}.` }
    );
  }
  return value;
}

interface TargetJobsSizing {
  targetJobs: number;
  amountMicro: number;
  priceMicro: number;
  /** `tracked` = this caller's last draw here; `advertised` = the DVM's own `/v1/info` price. */
  priceSource: "tracked" | "advertised";
  /** What pulled the figure below `targetJobs × price`, if anything. */
  clampedBy?: "menu-max" | "budget";
  display: string;
}

/**
 * Size a funding to a workload rather than a figure. Agents know
 * "500 jobs tonight" far more often than they know "$18" — the 20×/40× policy
 * prior is a guess at exactly this number.
 *
 * Price comes from what this caller last actually paid here; failing that, from
 * what the DVM advertises. The advertised figure is a ceiling rather than the
 * exact per-job price, so the sizing can run a little large — bounded either way
 * by the builder's own residual ceiling and the caller's budget, and still
 * subject to the trust-tier speed bump.
 */
async function sizeForTargetJobs(args: {
  endpoint: string;
  targetJobs: number;
  stored: StoredCredit | undefined;
  menu: CreditMenu | undefined;
  providerInfo: ProviderInfo;
}): Promise<TargetJobsSizing> {
  const tracked = args.stored?.lastPriceMicro;
  const advertised =
    tracked && tracked > 0 ? undefined : await advertisedPriceMicro(args.providerInfo);
  const priceMicro = tracked && tracked > 0 ? tracked : advertised;
  const priceSource: "tracked" | "advertised" = tracked && tracked > 0 ? "tracked" : "advertised";
  if (priceMicro === undefined || priceMicro <= 0) {
    throw new DvmError(
      "credit_price_unknown",
      `No job price is derivable for ${args.endpoint}, so --target-jobs can't be sized.`,
      "Pass the amount directly with --amount '$2', or run one job here first — the price it draws becomes the basis for --target-jobs.",
      {
        display: `This agent doesn't know what a job costs at ${args.endpoint}: it has never paid one, and the DVM doesn't advertise a fixed price. Say how much to load instead, e.g. --amount '$2'.`,
        endpoint: args.endpoint,
        target_jobs: args.targetJobs,
      }
    );
  }

  const wanted = args.targetJobs * priceMicro;
  const menu = args.menu;
  const held = Math.max(args.stored?.remainingMicro ?? 0, 0);
  // The builder's `max` bounds the *residual* balance, so what's left of it is
  // what a funding may add. The global budget is the caller's own ceiling.
  const menuRoom = menu ? Math.max(menu.max_micro - held, 0) : Number.POSITIVE_INFINITY;
  const budget = budgetHeadroom();

  let amountMicro = Math.min(wanted, menuRoom, budget.roomMicro);
  let clampedBy: TargetJobsSizing["clampedBy"];
  if (amountMicro < wanted) clampedBy = budget.roomMicro < menuRoom ? "budget" : "menu-max";
  // The builder's floor binds last, exactly as the auto-path sizing has it: a
  // funding below `min` is one the DVM would refuse outright.
  if (menu) amountMicro = Math.max(amountMicro, menu.min_micro);
  // …but the floor can't push the figure back over the spending cap. Sizing to
  // the minimum and calling it "trimmed to the budget" would be a lie that dies
  // in `enforceGlobalBudget` a few frames later; refuse here, where the two
  // figures that don't fit are both in hand.
  if (amountMicro > budget.roomMicro) {
    throw new DvmError(
      "budget_exceeded",
      `The smallest credit ${args.endpoint} accepts ($${formatUsd(amountMicro / 1_000_000)}) is more than this agent's ${budget.window ?? "spending"} cap has left ($${formatUsd(budget.roomMicro / 1_000_000)}).`,
      `Raise the cap (e.g. 'dvm budget set --${budget.window ?? "daily"} "$10"'${budget.resetsAt ? `), or wait for the window to reset at ${new Date(budget.resetsAt).toISOString()}` : ")"}.`,
      {
        display: `This DVM won't open a credit smaller than $${formatUsd(amountMicro / 1_000_000)}, and only $${formatUsd(budget.roomMicro / 1_000_000)} is left of this agent's ${budget.window ?? "spending"} budget. Nothing was funded and nothing was charged.`,
        endpoint: args.endpoint,
        target_jobs: args.targetJobs,
        minimum_micro: amountMicro,
        budget_remaining_micro: budget.roomMicro,
        ...(budget.window ? { window: budget.window } : {}),
        ...(budget.resetsAt ? { resets_at: new Date(budget.resetsAt).toISOString() } : {}),
      }
    );
  }

  const basis =
    priceSource === "tracked"
      ? `the $${formatUsd(priceMicro / 1_000_000)} this agent last drew per job here`
      : `the $${formatUsd(priceMicro / 1_000_000)} this DVM advertises per job`;
  const clamp =
    clampedBy === "menu-max"
      ? " — trimmed to what this DVM will hold on deposit"
      : clampedBy === "budget"
        ? " — trimmed to what's left of this agent's spending cap"
        : "";
  return {
    targetJobs: args.targetJobs,
    amountMicro,
    priceMicro,
    priceSource,
    ...(clampedBy ? { clampedBy } : {}),
    display: `Sizing ${String(args.targetJobs)} jobs' worth of credit from ${basis}: $${formatUsd(amountMicro / 1_000_000)}${clamp}.`,
  };
}

function sizingJson(sizing: TargetJobsSizing): Record<string, unknown> {
  return {
    target_jobs: sizing.targetJobs,
    price_micro: sizing.priceMicro,
    price_source: sizing.priceSource,
    ...(sizing.clampedBy ? { clamped_by: sizing.clampedBy } : {}),
    display: sizing.display,
  };
}

/**
 * The per-job price a DVM advertises on `/v1/info`, micro-units of USD.
 *
 * Capabilities can price differently; the highest is the one that makes "N
 * jobs' worth" a figure that actually covers N jobs. Falls back to the
 * **top-level** `pricing` block — the pre-capabilities form old container
 * images and self-hosted DVMs still emit — including its sats-only `max_msats`,
 * which is converted at the cached BTC/USD rate. Dynamic (`quote`-only) pricing
 * yields nothing: there is no number to multiply.
 */
async function advertisedPriceMicro(providerInfo: ProviderInfo): Promise<number | undefined> {
  let best: number | undefined;
  for (const cap of Object.values(providerInfo.capabilities ?? {})) {
    const micro = usdPriceMicro(cap.pricing);
    if (micro !== undefined && (best === undefined || micro > best)) best = micro;
  }
  if (best !== undefined) return best;

  const legacy = providerInfo.pricing;
  const legacyUsd = usdPriceMicro(legacy);
  if (legacyUsd !== undefined) return legacyUsd;
  // A sats-denominated ceiling is still a price; it just has to be converted to
  // size a credit, which is denominated in the menu's currency. A missing rate
  // means no sizing basis, not a wrong one.
  const msats = legacy?.max_msats;
  if (typeof msats !== "number" || msats <= 0) return undefined;
  const resolved = await tryResolveBtcUsdRate();
  if (!resolved) return undefined;
  return Math.round(msatsToUsd(msats, resolved.rate) * 1_000_000);
}

/** A `{ max: { amount, currency } }` pricing block as USD micro-units, when it is one. */
function usdPriceMicro(pricing: unknown): number | undefined {
  if (!pricing || typeof pricing !== "object") return undefined;
  const max = (pricing as { max?: unknown }).max;
  if (!max || typeof max !== "object") return undefined;
  const { amount, currency } = max as { amount?: unknown; currency?: unknown };
  if (typeof amount !== "number" || amount <= 0) return undefined;
  if (typeof currency !== "string" || currency.toLowerCase() !== "usd") return undefined;
  return Math.round(amount * 1_000_000);
}

interface BudgetHeadroom {
  /** Micro-units still spendable. Unbounded when no cap is set (the default install). */
  roomMicro: number;
  window?: string;
  /** When that window resets, Unix ms. */
  resetsAt?: number;
}

/**
 * What's left of the caller's global spending caps — the tightest of the
 * configured windows, named so a refusal can say which one bit and when it
 * lifts.
 */
function budgetHeadroom(): BudgetHeadroom {
  const out: BudgetHeadroom = { roomMicro: Number.POSITIVE_INFINITY };
  for (const window of statusSnapshot().windows) {
    if (window.limitUsd === undefined) continue;
    // Rounded: the dollar subtraction is float, and a figure this ends up
    // funding has to be a whole micro-unit.
    const room = Math.round(Math.max(window.limitUsd - window.spentUsd, 0) * 1_000_000);
    if (room >= out.roomMicro) continue;
    out.roomMicro = room;
    out.window = window.window;
    out.resetsAt = window.resetsAt;
  }
  return out;
}

/**
 * The over-trust speed bump: refuse an explicit funding that would
 * leave more on deposit here than the trust tier permits, unless the caller
 * named `--over-trust` or pre-granted this builder in config.
 *
 * Not a ceiling — with either of those, any amount the menu and budget allow
 * still funds. The point is that the oversized path has to be *named*, so an
 * injected instruction has to name it too, and naming it leaves a record.
 *
 * Async for the refusal alone: the route table a refusal carries can only say
 * whether the caller's sats-denominated ecash pocket covers a fiat funding with
 * an advisory rate in hand. A funding that passes the bump resolves
 * nothing and reads no local wallet state.
 */
async function enforceTrustTier(args: {
  endpoint: string;
  amountMicro: number;
  signingPubkey: string;
  stored: StoredCredit | undefined;
  menu: CreditMenu | undefined;
  providerInfo: ProviderInfo;
  opts: CreditFundOptions;
  config: Config | null;
}): Promise<void> {
  const receipts = loadReceipts();
  // A pre-grant is a money-policy bypass, so only the live builder block may
  // select it, and only after its attestation authenticates the advertised key.
  // Stored rows and receipts remain useful for offline display, not spending.
  const builderPubkey = authenticatedBuilderPubkey(args.providerInfo.builder);
  const identity = providerDvmIdentity(args.providerInfo);
  const boundRail = pinnedRail(args.stored, args.opts.creditId);
  // Menu bounds and the DVM's rail floors ride along so the refusal states
  // every bound at once, not just the one that bit.
  const headroomFor = (routeAvailability?: CreditRouteAvailability[]): CreditHeadroom =>
    computeHeadroom({
      endpoint: args.endpoint,
      receipts,
      signingPubkey: args.signingPubkey,
      ...(identity ? { identity } : {}),
      balanceMicro: Math.max(args.stored?.remainingMicro ?? 0, 0),
      ...(args.menu ? { menu: args.menu } : {}),
      ...(args.config?.credit ? { config: args.config.credit } : {}),
      ...(builderPubkey ? { builderPubkey } : {}),
      routeAmountMicro: args.amountMicro,
      ...(boundRail ? { boundRail } : {}),
      ...(routeAvailability ? { routeAvailability } : {}),
    });

  // The cap decision reads none of the caller's local wallet state, so the
  // funding that passes the bump never pays for a route table nobody sees.
  const cap = headroomFor().effectiveCapMicro;
  // Tier 2 with no menu snapshot: the cap is the builder's own maximum, which
  // the server enforces anyway. Nothing local to check against.
  if (cap === undefined || args.opts.overTrust) return;

  // Exposure, not the amount alone: a cap on how much sits at one machine is
  // only a cap if twenty small fundings can't quietly walk past it.
  const fundsTracked =
    args.stored !== undefined &&
    (args.opts.creditId === undefined || args.opts.creditId === args.stored.creditId);
  const exposureMicro =
    args.amountMicro + (fundsTracked ? Math.max(args.stored?.remainingMicro ?? 0, 0) : 0);
  if (exposureMicro <= cap) return;

  // The refusal is the moment this caller is told what they could fund instead,
  // so its route table is worth the price read the happy path never makes — an
  // ecash pocket is sats, and only a rate can say whether it covers a fiat
  // funding. Resolved once, and only where it could change the
  // answer: a menu that names no ecash rail, or a DVM that echoed no mint
  // offer, reaches its verdict without one.
  const btcRate =
    args.menu?.funding.includes("cashu") && args.providerInfo.cashu
      ? await advisoryBtcRate()
      : undefined;
  const headroom = headroomFor(
    args.menu
      ? localCreditRouteAvailability({
          menu: args.menu,
          providerInfo: args.providerInfo,
          config: args.config,
          amountMicro: args.amountMicro,
          ...(btcRate !== undefined ? { btcRate } : {}),
        })
      : undefined
  );

  const amountUsd = `$${formatUsd(args.amountMicro / 1_000_000)}`;
  const capUsd = `$${formatUsd(cap / 1_000_000)}`;
  const held = fundsTracked ? Math.max(args.stored?.remainingMicro ?? 0, 0) : 0;
  const heldClause =
    held > 0
      ? ` On top of the $${formatUsd(held / 1_000_000)} already on deposit, that would leave $${formatUsd(exposureMicro / 1_000_000)} here.`
      : "";
  throw withHeadroom(
    new DvmError(
      "amount_exceeds_trust_tier",
      `Funding ${amountUsd} at ${args.endpoint} would exceed this DVM's ${capUsd} trust-tier cap.`,
      `Nothing moved. Re-run with --over-trust to fund it anyway, or pre-grant every DVM signed by this builder with 'dvm credit trust ${args.endpoint} <builder-max|$amount>'. Or fund ${capUsd} or less.`,
      {
        display:
          `This agent has only earned ${capUsd} of credit at ${args.endpoint} so far, and ${amountUsd} was asked for.${heldClause} No money moved. ` +
          `Loading more than the earned amount is allowed, but it has to be asked for explicitly — re-run with --over-trust, or pre-grant every DVM signed by this builder with 'dvm credit trust ${args.endpoint} <builder-max|$amount>'.`,
        endpoint: args.endpoint,
        amount_micro: args.amountMicro,
        exposure_micro: exposureMicro,
        cap_micro: cap,
      }
    ),
    headroom
  );
}

/**
 * The refill gap on a tracked credit — what an auto-top-up would have loaded.
 * Undefined when nothing is tracked: there is no honest default for a DVM this
 * caller has never funded, and guessing would spend real money on a guess.
 */
function defaultFundMicro(stored: StoredCredit | undefined): number | undefined {
  if (!stored) return undefined;
  const gap = stored.targetMicro - stored.remainingMicro;
  const floor = stored.menu?.min_micro ?? 0;
  const micro = Math.max(gap, floor);
  return micro > 0 ? micro : undefined;
}

/**
 * Fetch the funding menu on its own hop, for a caller who has never quoted
 * this DVM.
 *
 * The signed `op: "balance"` is the one read that answers "what may I add"
 * without a capability and without an input — `/v1/quote` needs a job
 * envelope, and `/v1/info` carries no credit block at all. The caller holding
 * nothing is exactly the expected case here; the server echoes its menu
 * regardless.
 *
 * Best-effort by design: this hop is what makes the floor pre-check and the
 * amount-aware rail pick universal, not what makes a funding possible. A DVM
 * that offers no credit, an older server, a read that times out — all of them
 * fall through to the menu-less order the verb ran before, where the funding
 * still lands and the server still refuses what it must.
 */
async function discoverCreditMenu(
  transport: ReturnType<typeof createDvmTransport>,
  endpoint: string,
  signer: { privkey: string; pubkey: string }
): Promise<CreditMenu | undefined> {
  try {
    const provider = await transport.describe({ endpoint });
    const result = await creditOp(
      transport,
      endpoint,
      signDvmRequestData(
        signer.privkey,
        { op: "balance" },
        signedRequestDomain({
          provider,
          endpoint,
          method: "POST",
          path: "v1/credit",
          capability: null,
        })
      )
    );
    return result.menu;
  } catch {
    return undefined;
  }
}
