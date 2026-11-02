import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stateRoot = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "dvm-card-fund-"));
  // The SDK reads this when it loads, so it is set before any import below.
  process.env.DVM_CONFIG_DIR = root;
  return root;
});

vi.mock("../budget-ledger", () => ({ recordSpendOnce: vi.fn() }));
vi.mock("../btc-rate", () => ({ tryResolveBtcUsdRate: vi.fn(async () => undefined) }));

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Challenge, Credential } from "mppx";
import { DvmError, usdToMsats } from "@dvmkit/sdk/internal";

import { recordSpendOnce } from "../budget-ledger";
import { fundOverStripe, type CardFundDeps } from "../card-credit/fund";
import {
  clearPendingCardFunding,
  loadPendingCardFunding,
  type PendingCardFunding,
  recordPendingCardFunding,
  sha256Hex,
} from "../card-credit/journal";
import type { CreditFundOutcome, FundCreditArgs } from "../credit-fund";

const ENDPOINT = "https://card.example.test";
const PUBKEY = "ab".repeat(32);
const CREDIT = "11111111-1111-4111-8111-111111111111";
const SPT = "spt_test_0123456789abcdef01234567";

afterEach(() => {
  rmSync(join(stateRoot, "card-fundings"), { recursive: true, force: true });
  vi.mocked(recordSpendOnce).mockClear();
});
afterAll(() => rmSync(stateRoot, { recursive: true, force: true }));

describe("re-run of a card top-up whose first send went unanswered", () => {
  let pending: PendingCardFunding;
  beforeEach(() => {
    pending = journal(Date.now() + 120_000);
  });

  it("keeps the journal when the unpaid status probe is refused, because that refusal says nothing about the charge", async () => {
    const post = vi.fn<CardFundDeps["post"]>().mockRejectedValue(
      new DvmError("auth_invalid", "The request signature was not accepted.", "Check the caller identity.")
    );

    const outcome = await fundOverStripe(args(), "fund-new", deps(post));

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[1]).toBeUndefined();
    expect(outcome.display).toContain("may or may not have been charged");
    expect(outcome.display).not.toMatch(/nothing was charged/i);
    expect(outcome.hint).toContain("Do not ask your human for a new approval");
    expect(outcome.hint).toContain("about 30 minutes");
    expect(loadPendingCardFunding(ENDPOINT, PUBKEY, CREDIT)?.fundId).toBe(pending.fundId);
  });

  it("keeps the journal when a resend is refused as an invalid credential after an earlier resend timed out", async () => {
    const post = vi
      .fn<CardFundDeps["post"]>()
      .mockRejectedValueOnce(new DvmError("timeout", "The DVM did not answer in time."))
      .mockRejectedValueOnce(
        new DvmError("payment_invalid", "the challenge has expired", undefined, { reason: "invalid_credential" })
      );

    const outcome = await fundOverStripe(args({ cardSpt: SPT }), "fund-new", deps(post));

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]?.[1]).toEqual({ mppCredentialRaw: credentialFor(pending) });
    expect(outcome.display).toContain("may or may not have been charged");
    expect(outcome.display).not.toMatch(/nothing was charged/i);
    expect(outcome.hint).not.toMatch(/approve a new top-up/);
    expect(loadPendingCardFunding(ENDPOINT, PUBKEY, CREDIT)?.fundId).toBe(pending.fundId);
    // The last refusal's reason would read as final to an agent branching on it.
    expect(outcome.error?.code).toBe("card_charge_unknown");
    expect(outcome.error?.data).toMatchObject({ card_charge: "unknown", retryable: true });
    expect(outcome.error?.data?.reason).toBeUndefined();
  });

  it("keeps a live entry when the DVM refuses the status check, and names --credit-id as the way past it", async () => {
    const post = vi
      .fn<CardFundDeps["post"]>()
      .mockRejectedValue(new DvmError("payment_invalid", "This DVM does not offer card funding."));

    const outcome = await fundOverStripe(args(), "fund-new", deps(post));

    expect(outcome.hint).toContain("--credit-id <new id>");
    expect(outcome.hint).toContain("refused the status check");
    expect(outcome.hint).not.toContain("could not be reached");
    expect(loadPendingCardFunding(ENDPOINT, PUBKEY, CREDIT)?.fundId).toBe(pending.fundId);
  });

  it("still retires the journal on a decline, which Stripe replays for the same charge", async () => {
    const post = vi
      .fn<CardFundDeps["post"]>()
      .mockRejectedValue(new DvmError("payment_invalid", "declined", undefined, { reason: "declined" }));

    const outcome = await fundOverStripe(args({ cardSpt: SPT }), "fund-new", deps(post));

    expect(outcome.display).toContain("declined");
    expect(loadPendingCardFunding(ENDPOINT, PUBKEY, CREDIT)).toBeUndefined();
  });
});

describe("re-run after a card top-up's challenge has expired", () => {
  it("retires the entry when the DVM refuses the status check, since nothing can book that fund any more", async () => {
    journal(Date.now() - 1_000);
    const post = vi
      .fn<CardFundDeps["post"]>()
      .mockRejectedValue(new DvmError("credit_closed", "This credit is closed."));

    const outcome = await fundOverStripe(args(), "fund-new", deps(post));

    expect(post).toHaveBeenCalledTimes(1);
    expect(outcome.display).toContain("five-minute window to finish has passed");
    expect(outcome.display).toContain("may or may not have been charged");
    expect(outcome.error?.data).toMatchObject({ card_charge: "unknown", retryable: false });
    expect(loadPendingCardFunding(ENDPOINT, PUBKEY, CREDIT)).toBeUndefined();
  });

  it("retires the entry on a reason-less payment_invalid, which the DVM sends only after its booked-fund lookup", async () => {
    journal(Date.now() - 1_000);
    const post = vi
      .fn<CardFundDeps["post"]>()
      .mockRejectedValue(new DvmError("payment_invalid", "This DVM does not offer card funding for prepaid credit."));

    await fundOverStripe(args(), "fund-new", deps(post));

    expect(loadPendingCardFunding(ENDPOINT, PUBKEY, CREDIT)).toBeUndefined();
  });

  // Each of these can come before the DVM looks the fund id up, so none proves the fund unbooked.
  it.each([
    ["auth_error", "The request signature was not accepted."],
    ["provider_error", "The DVM returned an unexpected response (502)."],
    ["credit_not_supported", "This DVM does not advertise prepaid credit."],
  ])("keeps the entry when the status check is refused with %s", async (code, message) => {
    journal(Date.now() - 1_000);
    const post = vi.fn<CardFundDeps["post"]>().mockRejectedValue(new DvmError(code, message));

    const outcome = await fundOverStripe(args(), "fund-new", deps(post));

    expect(outcome.display).toContain("may or may not have been charged");
    expect(outcome.hint).toContain("--credit-id <new id>");
    expect(loadPendingCardFunding(ENDPOINT, PUBKEY, CREDIT)?.fundId).toBe("fund-earlier");
  });
});

describe("card top-up limits and records", () => {
  it("refuses a top-up above Link's $500 approval limit before asking the DVM", async () => {
    const post = vi.fn<CardFundDeps["post"]>();

    const outcome = await fundOverStripe(
      args({ amountMicro: 500_010_000, cardApprovalSteps: true }),
      "fund-new",
      deps(post)
    );

    expect(post).not.toHaveBeenCalled();
    expect(outcome.status).toBe("refused");
    expect(outcome.display).toContain("$500");
    expect(outcome.hint).toContain("$500");
  });

  it("records a booked card top-up in the budget ledger at its exact USD when no BTC rate resolves", async () => {
    const challenge = liveChallenge(Date.now() + 120_000, 200);
    const post = vi
      .fn<CardFundDeps["post"]>()
      .mockRejectedValueOnce(
        new DvmError("payment_required", "pay", undefined, { tempo_challenges: [challenge] })
      )
      .mockResolvedValueOnce({} as Awaited<ReturnType<CardFundDeps["post"]>>);

    const outcome = await fundOverStripe(args({ cardSpt: SPT, amountMicro: 2_000_000 }), "fund-new", deps(post));

    expect(outcome.status).toBe("funded");
    expect(recordSpendOnce).toHaveBeenCalledTimes(1);
    const row = vi.mocked(recordSpendOnce).mock.calls[0]![0];
    expect(row.msats / 1000 / 100_000_000 * row.btcRate).toBeCloseTo(2, 9);
    expect(row.msats).toBe(usdToMsats(2, row.btcRate));
    expect(row.label).toContain("no BTC/USD rate");
  });
});

describe("card top-up journal", () => {
  it("refuses a second entry for the same credit, and a clear by the other run leaves the first entry", () => {
    const first = journal(Date.now() + 120_000);
    const rival = { ...first, fundId: "fund-rival" };

    expect(recordPendingCardFunding(rival)).toBe(false);
    clearPendingCardFunding(rival);

    expect(loadPendingCardFunding(ENDPOINT, PUBKEY, CREDIT)?.fundId).toBe(first.fundId);
    expect(readdirSync(join(stateRoot, "card-fundings")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

function args(overrides: Partial<FundCreditArgs> = {}): FundCreditArgs {
  return {
    ref: { endpoint: ENDPOINT },
    signing: { privkey: "cd".repeat(32), pubkey: PUBKEY },
    creditId: CREDIT,
    amountMicro: 1_000_000,
    menu: { funding: ["stripe"] },
    ...overrides,
  } as FundCreditArgs;
}

function deps(post: CardFundDeps["post"]): CardFundDeps {
  return {
    post,
    settled: (base) =>
      ({ ...base, status: "funded", fundedMicro: 2_000_000, display: "Funded." }) as CreditFundOutcome,
    sleep: async () => undefined,
  };
}

function liveChallenge(expiresAt: number, cents = 100): Challenge.Challenge {
  return Challenge.from({
    id: "challenge-1",
    realm: "card.example.test",
    method: "stripe",
    intent: "charge",
    request: { amount: String(cents), currency: "usd", methodDetails: { networkId: "internal" } },
    expires: new Date(expiresAt).toISOString(),
  });
}

function credentialFor(entry: PendingCardFunding): string {
  return Credential.serialize(Credential.from({ challenge: Challenge.deserialize(entry.challenge), payload: { spt: SPT } }));
}

function journal(expiresAt: number): PendingCardFunding {
  const challenge = liveChallenge(expiresAt);
  const credential = Credential.serialize(Credential.from({ challenge, payload: { spt: SPT } }));
  const entry: PendingCardFunding = {
    v: 1,
    endpoint: ENDPOINT,
    callerPubkey: PUBKEY,
    creditId: CREDIT,
    fundId: "fund-earlier",
    amountMicro: 1_000_000,
    targetMicro: 1_000_000,
    challenge: Challenge.serialize(challenge),
    challengeExpires: new Date(expiresAt).toISOString(),
    sptSha256: sha256Hex(SPT),
    commitment: sha256Hex(credential),
    presentedAt: Date.now() - 1_000,
  };
  expect(recordPendingCardFunding(entry)).toBe(true);
  return entry;
}
