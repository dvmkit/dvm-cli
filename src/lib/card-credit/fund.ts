/**
 * The card leg of credit funding: a top-up the caller's human approved in
 * Stripe Link, presented to the DVM as an MPP `method="stripe"` credential.
 *
 * The agent runs `link-cli` itself, because the human's approval can take up to
 * thirty minutes and a signed request lives five. So this leg never pays on its
 * own initiative: without a shared payment token (`spt_…`) it hands back the
 * `link-cli` steps, and with one it does a fresh signed discovery, builds the
 * credential for that challenge, binds its SHA-256 as `fund.commitment`, and
 * presents it once.
 *
 * Secrets: the token and the credential built from it are never written to
 * disk, logged or put into an outcome. The journal keeps only hashes and the
 * DVM's challenge (see ./journal).
 */

import { Challenge, Credential } from "mppx";
import {
  type CreditOpResult,
  DvmError,
  formatUsd,
  type Payment,
  shellQuoteArg,
  usdToMsats,
} from "@dvmkit/sdk/internal";

import { recordSpendOnce } from "../budget-ledger";
import { tryResolveBtcUsdRate } from "../btc-rate";
import type { CreditFundOutcome, FundCreditArgs } from "../credit-fund";
import { dvmLabelFromEndpoint } from "../../commands/wallet-history";
import {
  cardChallengeLive,
  clearPendingCardFunding,
  loadPendingCardFunding,
  type PendingCardFunding,
  recordPendingCardFunding,
  sha256Hex,
} from "./journal";

/** Stripe's smallest card charge, and the DVM's advertised floor for card credit. */
export const CARD_MIN_MICRO = 500_000;
const MICRO_PER_CENT = 10_000;
/** Resends of one credential inside a run, for answers that say the charge may yet book. */
const PRESENT_ATTEMPTS = 3;
const PRESENT_BACKOFF_MS = [2_000, 4_000];

/** Retryable card refusals: nothing was decided, and the same credential may still book. */
const RESENDABLE_REASONS = new Set(["unavailable", "indeterminate", "booking_failed"]);
/** Card refusals that will be the same on every resend of this credential. */
const FINAL_REASONS = new Set([
  "declined",
  "token_unusable",
  "invalid_credential",
  "requires_action",
  "mismatch",
]);

export interface CardFundDeps {
  post(body: Record<string, unknown>, payment?: Payment): Promise<CreditOpResult>;
  settled(base: CardFundBase, result: CreditOpResult): CreditFundOutcome;
  sleep?: (ms: number) => Promise<void>;
}

export interface CardFundBase {
  creditId: string;
  fundId: string;
  rail: "stripe";
}

/** The journalled card top-up for this credit, when one awaits confirmation. */
export function pendingCardFundingForCredit(args: FundCreditArgs): PendingCardFunding | undefined {
  return loadPendingCardFunding(args.ref.endpoint, args.signing.pubkey, args.creditId);
}

/**
 * Fund `args.creditId` by card. A journalled entry for the credit always wins
 * over a fresh attempt, under its own fund id: it may be a charge that already
 * happened.
 */
export async function fundOverStripe(
  args: FundCreditArgs,
  fundId: string,
  deps: CardFundDeps
): Promise<CreditFundOutcome> {
  const journalled = pendingCardFundingForCredit(args);
  if (journalled) return resumeCardFunding(args, journalled, deps);

  const base: CardFundBase = { creditId: args.creditId, fundId, rail: "stripe" };
  if (args.menu && !args.menu.funding.includes("stripe")) {
    return {
      ...base,
      status: "unavailable",
      display: `${dvmLabelFromEndpoint(args.ref.endpoint)} doesn't take card top-ups, so nothing was charged.`,
    };
  }
  const local = localAmountRefusal(base, args.amountMicro);
  if (local) return local;

  const spt = args.cardSpt;
  if (spt === undefined) {
    if (!args.cardApprovalSteps) return approvalNeededOutcome(args, base);
    return approvalSteps(args, base, deps);
  }
  if (!/^spt_[A-Za-z0-9_]+$/.test(spt)) {
    return refused(
      base,
      new DvmError(
        "invalid_argument",
        "The value passed as --spt is not a shared payment token.",
        "Pass the spt_… value from 'link-cli spend-request retrieve <id> --include shared_payment_token'. Nothing was charged."
      ),
      "That isn't a shared payment token, so nothing was charged.",
      "Pass the spt_… value link-cli returned once your human approved the top-up."
    );
  }

  let challenge: Challenge.Challenge;
  try {
    const discovered = await discover(args, base, deps);
    if ("outcome" in discovered) return discovered.outcome;
    challenge = discovered.challenge;
  } catch (err) {
    return definiteOrUnknown(args, base, err, undefined);
  }

  const credential = Credential.serialize(Credential.from({ challenge, payload: { spt } }));
  const pending: PendingCardFunding = {
    v: 1,
    endpoint: args.ref.endpoint,
    callerPubkey: args.signing.pubkey,
    creditId: args.creditId,
    fundId,
    amountMicro: args.amountMicro,
    targetMicro: args.targetMicro ?? args.amountMicro,
    challenge: Challenge.serialize(challenge),
    ...(challenge.expires ? { challengeExpires: challenge.expires } : {}),
    sptSha256: sha256Hex(spt),
    commitment: sha256Hex(credential),
    presentedAt: Date.now(),
  };
  recordPendingCardFunding(pending);
  return present(args, pending, credential, deps);
}

/**
 * Finish a journalled top-up. With the same token, the credential is rebuilt
 * byte for byte and resent inside its challenge window; Stripe's idempotency
 * on (challenge, token) makes that resend book the original charge rather
 * than make a second one. Without it, the unpaid probe under the same fund id
 * is the only question that can be asked: did the DVM book it?
 */
async function resumeCardFunding(
  args: FundCreditArgs,
  pending: PendingCardFunding,
  deps: CardFundDeps
): Promise<CreditFundOutcome> {
  const resumedArgs: FundCreditArgs = {
    ...args,
    amountMicro: pending.amountMicro,
    targetMicro: pending.targetMicro,
  };
  const base: CardFundBase = { creditId: pending.creditId, fundId: pending.fundId, rail: "stripe" };
  const spt = args.cardSpt;
  if (spt !== undefined && sha256Hex(spt) === pending.sptSha256 && cardChallengeLive(pending)) {
    const credential = Credential.serialize(
      Credential.from({ challenge: Challenge.deserialize(pending.challenge), payload: { spt } })
    );
    if (sha256Hex(credential) === pending.commitment) {
      return present(resumedArgs, pending, credential, deps, true);
    }
  }

  try {
    const replay = await deps.post(stripeFundBody(resumedArgs, pending.fundId, sha256Hex("")));
    return booked(resumedArgs, pending, deps.settled(base, replay));
  } catch (err) {
    if (!(err instanceof DvmError) || !stripeChallenge(err)) {
      return definiteOrUnknown(resumedArgs, base, err, pending, true);
    }
  }

  if (cardChallengeLive(pending)) {
    return {
      ...base,
      status: "refused",
      display: `An earlier card top-up of $${usd(pending.amountMicro)} (fund ${pending.fundId}) was sent but not confirmed, so this run did not start another.`,
      hint: `Re-run this command with the same --spt before ${pending.challengeExpires ?? "its window closes"}: it resends the same card approval, which books the earlier charge if it happened and charges once if it didn't. Do not ask your human for a new approval yet.`,
    };
  }
  clearPendingCardFunding(pending);
  return {
    ...base,
    status: "refused",
    display: `An earlier card top-up of $${usd(pending.amountMicro)} (fund ${pending.fundId}) was never confirmed by the DVM, and its five-minute window to finish has passed. No credit was added for it.`,
    hint: "If the card was charged for it, the DVM finds the unbooked charge and refunds it to the card on its own. Check 'dvm credit balance' and the card statement before asking your human to approve a new top-up.",
  };
}

async function present(
  args: FundCreditArgs,
  pending: PendingCardFunding,
  credential: string,
  deps: CardFundDeps,
  resumed = false
): Promise<CreditFundOutcome> {
  const base: CardFundBase = { creditId: pending.creditId, fundId: pending.fundId, rail: "stripe" };
  const sleep = deps.sleep ?? defaultSleep;
  let last: unknown;
  let uncertain = resumed;
  for (let attempt = 0; attempt < PRESENT_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(PRESENT_BACKOFF_MS[attempt - 1] ?? 4_000);
    try {
      // Freshly signed per attempt by `post`: a signature lives 300 s and the
      // DVM burns its nonce, while the credential is what must stay identical.
      const result = await deps.post(stripeFundBody(args, pending.fundId, pending.commitment), {
        mppCredentialRaw: credential,
      });
      return booked(args, pending, deps.settled(base, result));
    } catch (err) {
      last = err;
      if (!resendable(err) || !cardChallengeLive(pending)) break;
      uncertain = true;
    }
  }
  return definiteOrUnknown(args, base, last, pending, uncertain);
}

/** Record the outflow and retire the journal. Each step is safe to repeat after a crash. */
async function booked(
  args: FundCreditArgs,
  pending: PendingCardFunding,
  outcome: CreditFundOutcome
): Promise<CreditFundOutcome> {
  await recordCardSpend(args, pending);
  clearPendingCardFunding(pending);
  return {
    ...outcome,
    chargedMicro: pending.amountMicro,
    display: `${outcome.display} $${usd(pending.amountMicro)} was charged to the card your human approved in Stripe Link.`,
    hint: `${outcome.hint ?? ""} Unspent credit goes back to that card, less its share of Stripe's processing fee: 'dvm credit drain ${shellQuoteArg(args.ref.endpoint)} --method stripe'.`.trim(),
  };
}

/**
 * Card spend is approved by a human per top-up, so it is not gated on the
 * agent's global budget; it is still recorded so the ledger's history and
 * windows see the money that left. A missing rate skips the record rather than
 * refuse a charge the human already approved.
 */
async function recordCardSpend(args: FundCreditArgs, pending: PendingCardFunding): Promise<void> {
  const rate = (await tryResolveBtcUsdRate())?.rate;
  if (!rate || rate <= 0) return;
  recordSpendOnce({
    msats: usdToMsats(pending.amountMicro / 1_000_000, rate),
    btcRate: rate,
    kind: "credit_fund",
    jobId: `fund:${pending.fundId}`,
    providerEndpoint: args.ref.endpoint,
    label: "Card credit top-up",
  });
}

async function discover(
  args: FundCreditArgs,
  base: CardFundBase,
  deps: CardFundDeps
): Promise<{ challenge: Challenge.Challenge } | { outcome: CreditFundOutcome }> {
  try {
    const replay = await deps.post(stripeFundBody(args, base.fundId, sha256Hex("")));
    // A 200 on the unpaid request is this fund id replaying a booked top-up.
    return { outcome: deps.settled(base, replay) };
  } catch (err) {
    const challenge = err instanceof DvmError ? stripeChallenge(err) : undefined;
    if (!challenge) throw err;
    const cents = Number(challenge.request.amount);
    if (
      String(challenge.request.currency).toLowerCase() !== "usd" ||
      cents * MICRO_PER_CENT !== args.amountMicro
    ) {
      return {
        outcome: refused(
          base,
          new DvmError(
            "card_amount_mismatch",
            `The DVM asked for a card charge of ${String(challenge.request.amount)} ${String(challenge.request.currency)} minor units, not the $${usd(args.amountMicro)} this top-up is for.`,
            "Nothing was charged. Fund again; if the DVM keeps asking for a different amount, tell its operator."
          ),
          `The DVM asked for a different card charge than the $${usd(args.amountMicro)} requested, so nothing was charged.`,
          "Nothing was charged and your human's approval is unused. Try again; if it repeats, tell the DVM's operator."
        ),
      };
    }
    return { challenge };
  }
}

/** The `link-cli` steps a human-approved card top-up needs, read off a live challenge. */
async function approvalSteps(
  args: FundCreditArgs,
  base: CardFundBase,
  deps: CardFundDeps
): Promise<CreditFundOutcome> {
  let challenge: Challenge.Challenge;
  try {
    const discovered = await discover(args, base, deps);
    if ("outcome" in discovered) return discovered.outcome;
    challenge = discovered.challenge;
  } catch (err) {
    return definiteOrUnknown(args, base, err, undefined);
  }
  const methodDetails = challenge.request.methodDetails as { networkId?: unknown } | undefined;
  const networkId = methodDetails?.networkId;
  if (typeof networkId !== "string" || networkId.length === 0) {
    return {
      ...base,
      status: "unavailable",
      display: "The DVM's card challenge named no Stripe network profile, so Link can't be asked to approve a top-up for it. Nothing was charged.",
      hint: "Tell the DVM's operator their card-credit setup is incomplete.",
    };
  }
  const cents = args.amountMicro / MICRO_PER_CENT;
  const dvm = dvmLabelFromEndpoint(args.ref.endpoint);
  // No apostrophes: the command is quoted for a POSIX shell, and an agent
  // copying it should not have to read past escape sequences.
  const context = `Prepaid credit top-up of $${usd(args.amountMicro)} for the ${dvm} service, paid by card to the operator of that service. Unspent credit can be refunded to this card, less its share of the Stripe processing fee.`;
  const create = [
    "link-cli spend-request create",
    "--credential-type shared_payment_token",
    `--network-id ${shellQuoteArg(networkId)}`,
    `--amount ${String(cents)}`,
    "--currency usd",
    `--context ${shellQuoteArg(context)}`,
    "--request-approval",
    "--format json",
  ].join(" ");
  const retrieve =
    "link-cli spend-request retrieve <spend_request_id> --include shared_payment_token --interval 2 --max-attempts 900 --format json";
  const fund = [
    "dvm credit fund",
    shellQuoteArg(args.ref.endpoint),
    "--rail stripe",
    `--amount ${shellQuoteArg(`$${usd(args.amountMicro)}`)}`,
    "--spt -",
  ].join(" ");
  const display = `This is a card top-up of $${usd(args.amountMicro)}, so your human has to approve it in Stripe Link first. Nothing has been charged. Once it's approved the card is charged right away, and any credit left unspent can be refunded to the card later, less its share of Stripe's processing fee.`;
  const hint = `Run '${create}', ask your human to approve it in Link (they have 30 minutes), then run '${retrieve}' with the spend request id it returned. Pipe the spt_… value it returns into '${fund}'. Never pay this with 'link-cli mpp pay': a signed dvm request expires long before an approval arrives.`;
  return {
    ...base,
    status: "unavailable",
    display,
    hint,
    error: new DvmError("card_approval_required", display, hint, {
      rail: "stripe",
      amount_micro: args.amountMicro,
      amount_usd: `$${usd(args.amountMicro)}`,
      amount_cents: cents,
      currency: "usd",
      network_id: networkId,
      link_cli: { create, retrieve },
      next_command: fund,
    }),
  };
}

function approvalNeededOutcome(args: FundCreditArgs, base: CardFundBase): CreditFundOutcome {
  return {
    ...base,
    status: "unavailable",
    display: `A card top-up needs your human's approval in Stripe Link every time, so the $${usd(args.amountMicro)} top-up at ${dvmLabelFromEndpoint(args.ref.endpoint)} was not made automatically. Nothing was charged.`,
    hint: `Run 'dvm credit fund ${shellQuoteArg(args.ref.endpoint)} --rail stripe --amount ${shellQuoteArg(`$${usd(args.amountMicro)}`)}' for the approval steps.`,
  };
}

function localAmountRefusal(base: CardFundBase, amountMicro: number): CreditFundOutcome | undefined {
  if (amountMicro < CARD_MIN_MICRO) {
    return refused(
      base,
      new DvmError(
        "below_rail_minimum",
        `A card top-up must be at least $${usd(CARD_MIN_MICRO)}; $${usd(amountMicro)} is below Stripe's minimum card charge.`,
        `Fund at least $${usd(CARD_MIN_MICRO)} by card, or use another rail for smaller amounts.`,
        { rail: "stripe", min_micro: CARD_MIN_MICRO }
      ),
      `Card top-ups start at $${usd(CARD_MIN_MICRO)}, so $${usd(amountMicro)} can't be paid by card. Nothing was charged.`,
      `Fund at least $${usd(CARD_MIN_MICRO)} by card.`
    );
  }
  if (amountMicro % MICRO_PER_CENT !== 0) {
    return refused(
      base,
      new DvmError(
        "invalid_argument",
        `A card top-up must be a whole number of cents; $${String(amountMicro / 1_000_000)} is not.`,
        "Round the amount to whole cents."
      ),
      "Cards are charged in whole cents, so this amount can't be paid by card. Nothing was charged.",
      "Round the amount to whole cents and fund again."
    );
  }
  return undefined;
}

/**
 * The refusal side. A definite answer from the DVM retires the journal; an
 * unknown one keeps it, because the card may have been charged and only a
 * resend of the same credential can book that charge without a second one.
 */
function definiteOrUnknown(
  args: FundCreditArgs,
  base: CardFundBase,
  err: unknown,
  pending: PendingCardFunding | undefined,
  /** An earlier presentation of this credential went unanswered, in this run or a previous one. */
  uncertain = false
): CreditFundOutcome {
  const mapped = err instanceof DvmError ? err : undefined;
  const reason = typeof mapped?.data?.reason === "string" ? mapped.data.reason : undefined;
  const required = typeof mapped?.data?.credit_rail === "string" ? mapped.data.credit_rail : undefined;

  // `token_unusable` after an unanswered send can mean that send consumed the
  // token: only the resend of that same credential can tell, so it stays open.
  const final = reason !== undefined && FINAL_REASONS.has(reason);
  if (mapped && reason && final && !(reason === "token_unusable" && uncertain)) {
    if (pending) clearPendingCardFunding(pending);
    return refused(base, mapped, cardRefusalDisplay(mapped, reason), cardRefusalHint(reason));
  }
  if (!pending) {
    // Nothing was presented: whatever the DVM said, no card was charged.
    if (mapped?.code === "credit_closed") {
      return refused(
        base,
        mapped,
        "This prepaid balance is closed, so it can't be topped up. Nothing was charged.",
        "Fund a new credit with --credit-id <new id>, or check it with 'dvm credit balance'."
      );
    }
    if (required && required !== "stripe") {
      return {
        ...base,
        status: "unavailable",
        error: mapped,
        display: `This credit was opened over ${required}, so a card top-up can't be added to it. Nothing was charged.`,
      };
    }
    const providerDisplay = typeof mapped?.data?.display === "string" ? mapped.data.display : undefined;
    return {
      ...base,
      status: mapped && isTransient(mapped) ? "unavailable" : "refused",
      ...(mapped ? { error: mapped } : {}),
      display: `${providerDisplay ?? mapped?.message ?? "The DVM could not start a card top-up."} Nothing was charged.`,
      ...(mapped?.hint ? { hint: mapped.hint } : {}),
    };
  }
  if (mapped?.code === "replay_rejected") {
    clearPendingCardFunding(pending);
    return refused(
      base,
      mapped,
      "This card payment was already used to add credit, so it wasn't charged or added again.",
      "Check the balance with 'dvm credit balance' before asking your human to approve another top-up."
    );
  }
  if (mapped && chargedNothing(mapped)) {
    // Refused before any charge: the DVM checks these before it calls Stripe.
    clearPendingCardFunding(pending);
    return refused(
      base,
      mapped,
      `${typeof mapped.data?.display === "string" ? mapped.data.display : mapped.message} Nothing was charged.`,
      mapped.hint ?? "Fund again once the cause is fixed."
    );
  }
  return {
    ...base,
    status: "refused",
    ...(mapped ? { error: mapped } : {}),
    display: `The card top-up of $${usd(args.amountMicro)} was sent, but the DVM didn't confirm it, so the card may or may not have been charged. No credit has been confirmed yet.`,
    hint: cardChallengeLive(pending)
      ? `Re-run this same command with the same --spt before ${pending.challengeExpires ?? "the five-minute window closes"}. It resends the same approval under fund ${pending.fundId}: a charge that happened is booked once, and one that didn't is charged once. Don't ask your human for a new approval.`
      : `Re-run 'dvm credit fund ${shellQuoteArg(args.ref.endpoint)}' to ask the DVM whether fund ${pending.fundId} was booked. If the card was charged and never booked, the DVM refunds it to the card on its own.`,
  };
}

function cardRefusalDisplay(err: DvmError, reason: string): string {
  const detail = [
    typeof err.data?.decline_code === "string" ? `decline code ${err.data.decline_code}` : undefined,
    typeof err.data?.stripe_error_code === "string" ? `Stripe code ${err.data.stripe_error_code}` : undefined,
  ].filter(Boolean);
  const suffix = detail.length > 0 ? ` (${detail.join(", ")})` : "";
  switch (reason) {
    case "declined":
      return `The card was declined${suffix}, so nothing was charged and no credit was added.`;
    case "token_unusable":
      return `The approval from Stripe Link can't be used for this top-up${suffix}: it was already used, is for a smaller amount, or has lapsed. Nothing was charged.`;
    case "requires_action":
      return "The card needs an extra verification step that can't be done here, so nothing was charged.";
    case "mismatch":
      return "The card processor reported a charge that doesn't match this top-up, so no credit was added.";
    default:
      return `The card payment couldn't be verified${suffix}, so nothing was charged.`;
  }
}

function cardRefusalHint(reason: string): string {
  switch (reason) {
    case "declined":
      return "Ask your human to approve a new top-up in Link, ideally with a different card, then fund again with the new spt_… value.";
    case "requires_action":
      return "Ask your human to approve a new top-up in Link with a card that doesn't need an extra authentication step.";
    case "mismatch":
      return "Don't retry with this approval. Tell your human the top-up failed and give the DVM's operator the fund id so they can check the charge.";
    default:
      return "Ask your human to approve a new top-up in Link, then fund again with the new spt_… value. Each approval can be charged only once.";
  }
}

function refused(
  base: CardFundBase,
  error: DvmError,
  display: string,
  hint: string
): CreditFundOutcome {
  return { ...base, status: "refused", error, display, hint };
}

const PRE_CHARGE_CODES = new Set([
  "funding_commitment_mismatch",
  "credit_closed",
  "below_rail_minimum",
  "credit_over_max",
  "credit_below_min",
  "credit_not_supported",
  "invalid_request",
  "invalid_argument",
  "auth_invalid",
]);

/**
 * A refusal the DVM gives before it asks Stripe to charge. Every refusal
 * after the charge carries a `reason`, so a `payment_invalid` without one is
 * a pre-charge check (whole cents, card funding not offered). Anything not
 * recognised here is treated as possibly charged.
 */
function chargedNothing(err: DvmError): boolean {
  if (PRE_CHARGE_CODES.has(err.code)) return true;
  return err.code === "payment_invalid" && err.data?.reason === undefined && err.data?.retryable !== true;
}

function resendable(err: unknown): boolean {
  if (!(err instanceof DvmError)) return true;
  if (err.code === "timeout" || err.code === "provider_unreachable") return true;
  const reason = err.data?.reason;
  return typeof reason === "string" && RESENDABLE_REASONS.has(reason);
}

function isTransient(err: DvmError): boolean {
  return err.code === "timeout" || err.code === "provider_unreachable" || err.data?.retryable === true;
}

function stripeChallenge(err: DvmError): Challenge.Challenge | undefined {
  const challenges = err.data?.tempo_challenges;
  if (!Array.isArray(challenges)) return undefined;
  return (challenges as Challenge.Challenge[]).find(
    (candidate) => candidate.method === "stripe" && candidate.intent === "charge"
  );
}

function stripeFundBody(
  args: FundCreditArgs,
  fundId: string,
  commitment: string
): Record<string, unknown> {
  return {
    op: "fund",
    credit_id: args.creditId,
    fund: { amount_micro: args.amountMicro, fund_id: fundId, commitment, method: "stripe" },
  };
}

function usd(micro: number): string {
  return formatUsd(micro / 1_000_000);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
