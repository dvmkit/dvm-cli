/**
 * Receipts are real signed fixtures ({@link attestedDvm}): the tier counter
 * re-verifies every receipt it counts (the stored verdict is a hand-editable
 * file), so a mocked verifier here would prove nothing.
 */

import { describe, expect, it } from "vitest";

import { signAttestation } from "@dvmkit/sdk/internal";
import {
  automaticCreditBoundRail,
  CASHU_REFILL_TARGET_JOBS,
  DEFAULT_CREDIT_POSTURE,
  effectiveCreditPosture,
  effectiveFundingRail,
  fundWireAmountMicro,
  msatsToMicro,
  needsPocketRefill,
  needsTopup,
  OPEN_TARGET_JOBS,
  planCreditForQuote,
  planProbeDraw,
  POCKET_TARGET_MICRO,
  pocketTargetMicro,
  readFundValuation,
  refillTargetMicro,
  sizeCreditMicro,
  TIER0_CAP_MICRO,
  TIER1_CAP_MICRO,
  trustLadderFor,
  trustOverrideCapMicro,
  trustTierFor,
} from "../credit-policy";
import type { StoredCredit, StoredImplicitCredit } from "@dvmkit/sdk/internal";
import type { CreditConfig } from "../identity";
import type { StoredReceipt } from "@dvmkit/sdk/internal";
import { attestedDvmIdentity } from "@dvmkit/sdk/internal";
import type { CreditMenu } from "@dvmkit/sdk/internal";
import {
  attestedDvm,
  CALLER_A,
  CALLER_B,
  WORDCOUNT_DVM_ID,
} from "./fixtures/receipt-fixture";

const ENDPOINT = "https://wordcount.example";
const RATE = 100_000;
const DAY_S = 24 * 60 * 60;

const dvm = attestedDvm("wordcount");

function menu(overrides: Partial<CreditMenu> = {}): CreditMenu {
  return {
    min_micro: 100_000,
    max_micro: 5_000_000,
    ttl_ms: 30 * DAY_S * 1000,
    currency: "usd",
    funding: ["cashu", "x402"],
    ...overrides,
  };
}

const X402_CHANNELS = {
  schemes: [
    { scheme: "exact", network: "eip155:84532" },
    { scheme: "batch-settlement", network: "eip155:84532" },
  ],
};

const X402_EXACT_ONLY = { schemes: [{ scheme: "exact", network: "eip155:84532" }] };

function receipts(count: number, spanDays = 0, requester = CALLER_A): StoredReceipt[] {
  const base = 1789300000;
  return Array.from({ length: count }, (_, i) => ({
    receipt: dvm.sign({
      job_id: `job-${String(i)}`,
      issued_at: base + (count > 1 ? Math.round((i * spanDays * DAY_S) / (count - 1)) : 0),
      requester_pubkey: requester,
    }),
    endpoint: ENDPOINT,
    builder: dvm.anchor,
    verification: "verified" as const,
    verified_at: 0,
  }));
}

function stored(overrides: Partial<StoredCredit> = {}): StoredCredit {
  return {
    endpoint: ENDPOINT,
    callerPubkey: CALLER_A,
    creditId: "credit-1",
    currency: "usd",
    balanceMicro: 400_000,
    remainingMicro: 400_000,
    ledgerSeq: 3,
    expiryMs: Date.now() + 86_400_000,
    targetMicro: 800_000,
    lastPriceMicro: 10_000,
    menu: menu(),
    status: "active",
    openedAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function implicit(overrides: Partial<StoredImplicitCredit> = {}): StoredImplicitCredit {
  return {
    endpoint: ENDPOINT,
    callerPubkey: CALLER_A,
    creditId: "imp:cashu:released",
    currency: "usd",
    remainingMicro: 100_000,
    ledgerSeq: 1,
    expiryMs: Date.now() + 86_400_000,
    status: "active",
    releasedByJobId: "job-failed",
    releasedAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("receipt trust against a live DVM at the same origin", () => {
  const history = receipts(20, 30);
  const identity = attestedDvmIdentity(dvm.anchor)!;
  const replacement = attestedDvm("wordcount");
  const changedId = { ...dvm.attestation, dvm_id: "dvm-replacement" };
  const otherDvmIdentity = attestedDvmIdentity({
    ...dvm.anchor,
    attestation: changedId,
    signature: signAttestation(changedId, dvm.identity.secret),
  })!;
  const unattested = history.map((entry) => ({ ...entry, builder: undefined }));
  const base = {
    menu: menu(),
    endpoint: ENDPOINT,
    signingPubkey: CALLER_A,
    priceMsats: 100_000,
    btcRate: RATE,
    stored: undefined,
    config: { posture: "auto" } as CreditConfig,
  };
  const rejected = [
    { name: "a different DVM ID under the same builder", identity: otherDvmIdentity, history },
    {
      name: "a different builder reusing the DVM ID",
      identity: attestedDvmIdentity(replacement.anchor)!,
      history,
    },
    { name: "receipts without a builder attestation", identity, history: unattested },
    {
      name: "a tampered builder attestation",
      identity,
      history: history.map((entry) => ({
        ...entry,
        builder: { ...dvm.anchor, attestation: { ...dvm.attestation, slug: "tampered" } },
      })),
    },
    {
      name: "a tampered receipt",
      identity,
      history: history.map((entry) => ({
        ...entry,
        receipt: { ...entry.receipt, seq: entry.receipt.seq + 1 },
      })),
    },
  ];

  it.each(rejected)("earns no trust from $name", ({ identity, history }) => {
    expect(trustLadderFor({ ...base, identity, receipts: history })).toMatchObject({
      tier: 0,
      receipts: 0,
      spanMs: 0,
      capMicro: 500_000,
    });
  });

  it.each(rejected)("does not automatically open credit from $name", ({ identity, history }) => {
    expect(planCreditForQuote({ ...base, identity, receipts: history.slice(0, 1) })).toEqual({
      mode: "none",
    });
  });

  it.each([
    { name: "matching live identity", identity, receipts: history },
    {
      name: "matching live identity at another hostname",
      identity,
      receipts: history.map((entry) => ({ ...entry, endpoint: "https://wordcount-alt.example" })),
    },
    { name: "offline attested history", identity: undefined, receipts: history },
    { name: "offline unattested history", identity: undefined, receipts: unattested },
  ])("preserves the tier and funding amounts for $name", ({ identity, receipts }) => {
    expect(trustLadderFor({ ...base, identity, receipts })).toMatchObject({
      tier: 2,
      receipts: 20,
      spanMs: 30 * DAY_S * 1000,
      capMicro: 5_000_000,
    });
    expect(planCreditForQuote({ ...base, identity, receipts })).toMatchObject({
      mode: "open",
      fundMicro: 2_000_000,
      fundSats: 2_000,
      fundMsats: 2_000_000,
      targetMicro: 4_000_000,
      currency: "usd",
    });
  });

  it("keeps matching live history scoped to the caller who earned it", () => {
    const args = { ...base, identity, receipts: history, signingPubkey: CALLER_B };
    expect(trustLadderFor(args)).toMatchObject({ tier: 0, receipts: 0, capMicro: 500_000 });
    expect(planCreditForQuote(args)).toEqual({ mode: "none" });
  });

  it("sizes a replacement builder's open using only its own history", () => {
    const current: StoredReceipt = {
      receipt: replacement.sign({ job_id: "current-job", requester_pubkey: CALLER_A }),
      builder: replacement.anchor,
      endpoint: ENDPOINT,
      verification: "verified",
      verified_at: 0,
    };
    const args = {
      ...base,
      identity: attestedDvmIdentity(replacement.anchor)!,
      receipts: [...history, current],
    };
    expect(trustLadderFor(args)).toMatchObject({
      tier: 0,
      receipts: 1,
      spanMs: 0,
      capMicro: 500_000,
    });
    expect(planCreditForQuote(args)).toMatchObject({
      mode: "open",
      fundMicro: 500_000,
      fundSats: 500,
      fundMsats: 500_000,
      targetMicro: 500_000,
    });
  });
});

describe("one DVM on two hostnames", () => {
  const ALIAS = "https://wordcount-alt.example";
  const IDENTITY = { dvmId: WORDCOUNT_DVM_ID, builderPubkey: dvm.identity.pubkey };

  function alias(count: number, source = dvm, anchored = true): StoredReceipt[] {
    return Array.from({ length: count }, (_, i) => ({
      receipt: source.sign({ job_id: `alias-${String(i)}`, requester_pubkey: CALLER_A }),
      endpoint: ALIAS,
      ...(anchored ? { builder: source.anchor } : {}),
      verification: "verified" as const,
      verified_at: 0,
    }));
  }

  it("pools one DVM's history across its hostnames", () => {
    const split = [...receipts(2), ...alias(2)];
    const ladder = trustLadderFor({
      signingPubkey: CALLER_A,
      receipts: split,
      endpoint: ENDPOINT,
      identity: IDENTITY,
    });
    expect(ladder.tier).toBe(1);
    expect(ladder.receipts).toBe(4);
  });

  it("carries the history to a hostname with no receipts of its own", () => {
    const only = alias(4);
    expect(
      trustLadderFor({ signingPubkey: CALLER_A, receipts: only, endpoint: ENDPOINT }).receipts
    ).toBe(0);
    expect(
      trustLadderFor({
        signingPubkey: CALLER_A,
        receipts: only,
        endpoint: ENDPOINT,
        identity: IDENTITY,
      }).receipts
    ).toBe(4);
  });

  it("pools without a live identity, off the origin's own attested receipts", () => {
    const split = [...receipts(2), ...alias(2)];
    expect(
      trustLadderFor({ signingPubkey: CALLER_A, receipts: split, endpoint: ENDPOINT }).receipts
    ).toBe(4);
  });

  it("counts nothing for an unattested stranger claiming this DVM's id", () => {
    const imposter = attestedDvm("wordcount");
    const farmed = alias(20, imposter, false);
    expect(farmed.every((entry) => entry.receipt.dvm_id === WORDCOUNT_DVM_ID)).toBe(true);
    const ladder = trustLadderFor({
      signingPubkey: CALLER_A,
      receipts: [...receipts(2), ...farmed],
      endpoint: ENDPOINT,
      identity: IDENTITY,
    });
    expect(ladder.tier).toBe(0);
    expect(ladder.receipts).toBe(2);
  });

  it("counts nothing for a different builder attesting this DVM's id", () => {
    const imposter = attestedDvm("wordcount");
    const ladder = trustLadderFor({
      signingPubkey: CALLER_A,
      receipts: [...receipts(2), ...alias(20, imposter)],
      endpoint: ENDPOINT,
      identity: IDENTITY,
    });
    expect(ladder.tier).toBe(0);
    expect(ladder.receipts).toBe(2);
  });

  it("applies a posture set at one hostname to a job that names the other", () => {
    const config: CreditConfig = {
      posture: "auto",
      perDvm: {
        [ENDPOINT]: { posture: "off", ...IDENTITY },
        [ALIAS]: { posture: "auto", ...IDENTITY },
      },
    };
    expect(effectiveCreditPosture(config, ALIAS, IDENTITY)).toEqual({
      posture: "off",
      source: "per_dvm",
    });
    expect(effectiveCreditPosture(config, ENDPOINT, IDENTITY).posture).toBe("off");
  });

  it("inherits a posture at a hostname with no entry of its own", () => {
    const config: CreditConfig = {
      posture: "auto",
      perDvm: { [ENDPOINT]: { posture: "off", ...IDENTITY } },
    };
    expect(effectiveCreditPosture(config, ALIAS, IDENTITY).posture).toBe("off");
    expect(effectiveCreditPosture(config, ALIAS).posture).toBe("auto");
  });

  it("refuses to inherit across a mismatched builder key", () => {
    const config: CreditConfig = {
      posture: "auto",
      perDvm: { [ENDPOINT]: { posture: "off", ...IDENTITY } },
    };
    const stranger = { dvmId: WORDCOUNT_DVM_ID, builderPubkey: "de".repeat(32) };
    expect(effectiveCreditPosture(config, ALIAS, stranger).posture).toBe("auto");
  });

  it("drops to no pin when two hostnames pin different rails", () => {
    const config: CreditConfig = {
      perDvm: {
        [ENDPOINT]: { fundingRail: "cashu", ...IDENTITY },
        [ALIAS]: { fundingRail: "tempo", ...IDENTITY },
      },
    };
    const resolved = effectiveFundingRail(config, ENDPOINT, IDENTITY);
    expect(resolved.rail).toBeUndefined();
    expect(resolved.source).toBe("default");
    expect(resolved.conflict).toEqual({
      rails: ["cashu", "tempo"],
      endpoints: [ENDPOINT, ALIAS],
    });
  });

  it("falls through to the global pin when two hostnames disagree", () => {
    const config: CreditConfig = {
      fundingRail: "lightning",
      perDvm: {
        [ENDPOINT]: { fundingRail: "cashu", ...IDENTITY },
        [ALIAS]: { fundingRail: "tempo", ...IDENTITY },
      },
    };
    const resolved = effectiveFundingRail(config, ENDPOINT, IDENTITY);
    expect(resolved.rail).toBe("lightning");
    expect(resolved.source).toBe("global");
    expect(resolved.conflict).toEqual({
      rails: ["cashu", "tempo"],
      endpoints: [ENDPOINT, ALIAS],
    });
    expect(effectiveFundingRail({ fundingRail: "lightning" }, ENDPOINT, IDENTITY)).toEqual({
      rail: "lightning",
      source: "global",
    });
  });

  it("is not a conflict when both hostnames pin the same rail", () => {
    const config: CreditConfig = {
      perDvm: {
        [ENDPOINT]: { fundingRail: "cashu", ...IDENTITY },
        [ALIAS]: { fundingRail: "cashu", ...IDENTITY },
      },
    };
    expect(effectiveFundingRail(config, ALIAS, IDENTITY)).toEqual({
      rail: "cashu",
      source: "per_dvm",
    });
  });
});

describe("trustTierFor", () => {
  it("tier 0 below three completed receipts", () => {
    const t = trustTierFor({
      signingPubkey: CALLER_A,
      receipts: receipts(2),
      endpoint: ENDPOINT,
      menu: menu(),
    });
    expect(t).toEqual({ tier: 0, capMicro: TIER0_CAP_MICRO });
  });

  it("tier 1 at exactly three receipts", () => {
    const t = trustTierFor({
      signingPubkey: CALLER_A,
      receipts: receipts(3),
      endpoint: ENDPOINT,
      menu: menu(),
    });
    expect(t).toEqual({ tier: 1, capMicro: TIER1_CAP_MICRO });
  });

  it("tier 2 needs ≥15 receipts spanning ≥7 days — 6 days stays tier 1", () => {
    const six = trustTierFor({
      signingPubkey: CALLER_A,
      receipts: receipts(15, 6),
      endpoint: ENDPOINT,
      menu: menu(),
    });
    expect(six.tier).toBe(1);
    const seven = trustTierFor({
      signingPubkey: CALLER_A,
      receipts: receipts(15, 7),
      endpoint: ENDPOINT,
      menu: menu(),
    });
    expect(seven).toEqual({ tier: 2, capMicro: menu().max_micro });
  });

  it("does not count failed receipts, other DVMs, or forged verdicts", () => {
    const failed: StoredReceipt = {
      ...receipts(1)[0],
      receipt: dvm.sign({ job_id: "job-f", requester_pubkey: CALLER_A, outcome: "failed", reason: "worker_died_mid_job" }),
    };
    const other = attestedDvm("summarize");
    const elsewhere: StoredReceipt = {
      receipt: other.sign({ job_id: "job-o", requester_pubkey: CALLER_A }),
      endpoint: "https://other.example",
      builder: other.anchor,
      verification: "verified" as const,
      verified_at: 0,
    };
    const forged: StoredReceipt = {
      ...receipts(1)[0],
      receipt: { ...receipts(1)[0].receipt, seq: 999999 },
    };
    const t = trustTierFor({
      signingPubkey: CALLER_A,
      receipts: [...receipts(2), failed, elsewhere, forged],
      endpoint: ENDPOINT,
      menu: menu(),
    });
    expect(t.tier).toBe(0);
  });

  it("honours config cap overrides", () => {
    const t = trustTierFor({
      signingPubkey: CALLER_A,
      receipts: receipts(0),
      endpoint: ENDPOINT,
      menu: menu(),
      tier0CapMicro: 250_000,
    });
    expect(t.capMicro).toBe(250_000);
  });
});

describe("trustLadderFor", () => {

  it("reports the receipts counted and the span they cover", () => {
    const ladder = trustLadderFor({
      signingPubkey: CALLER_A,
      receipts: receipts(4, 2),
      endpoint: ENDPOINT,
      menu: menu(),
    });
    expect(ladder.receipts).toBe(4);
    expect(ladder.spanMs).toBe(2 * DAY_S * 1000);
  });

  it("leaves tier 2's cap unstated with no menu — the builder's max is the builder's to say", () => {
    const ladder = trustLadderFor({
      signingPubkey: CALLER_A,
      receipts: receipts(15, 8),
      endpoint: ENDPOINT,
    });
    expect(ladder.tier).toBe(2);
    expect(ladder.capMicro).toBeUndefined();
  });
});

describe("trust is scoped to the signing identity", () => {
  it("a fresh identity inherits nothing from another identity's history here", () => {
    const earned = receipts(20, 30, CALLER_A);
    expect(
      trustLadderFor({
        signingPubkey: CALLER_A,
        receipts: earned,
        endpoint: ENDPOINT,
        menu: menu(),
      })
    ).toMatchObject({ tier: 2, receipts: 20 });
    expect(
      trustLadderFor({
        signingPubkey: CALLER_B,
        receipts: earned,
        endpoint: ENDPOINT,
        menu: menu(),
      })
    ).toMatchObject({ tier: 0, receipts: 0, capMicro: TIER0_CAP_MICRO });
  });

  it("an identity's own receipts still advance its tier alongside a neighbour's", () => {
    const mixed = [...receipts(20, 30, CALLER_A), ...receipts(3, 0, CALLER_B)];
    expect(
      trustLadderFor({ signingPubkey: CALLER_B, receipts: mixed, endpoint: ENDPOINT, menu: menu() })
    ).toMatchObject({ tier: 1, receipts: 3, capMicro: TIER1_CAP_MICRO });
  });

  it("matches case-insensitively — hex casing is nobody's identity boundary", () => {
    const ladder = trustLadderFor({
      signingPubkey: CALLER_A.toUpperCase(),
      receipts: receipts(3, 0, CALLER_A),
      endpoint: ENDPOINT,
      menu: menu(),
    });
    expect(ladder.tier).toBe(1);
  });

  it("counts nothing for a surface that doesn't know who is asking", () => {
    expect(
      trustLadderFor({
        signingPubkey: undefined,
        receipts: receipts(20, 30),
        endpoint: ENDPOINT,
        menu: menu(),
      })
    ).toMatchObject({ tier: 0, receipts: 0 });
  });

  it("counts an unattributable receipt for nobody — a job with no signed auth earns no trust", () => {
    const anonymous = receipts(20, 30).map((entry) => ({
      ...entry,
      receipt: dvm.sign({ job_id: entry.receipt.job_id, issued_at: entry.receipt.issued_at }),
    }));
    expect(anonymous[0].receipt.requester_pubkey).toBeNull();
    expect(
      trustLadderFor({
        signingPubkey: CALLER_A,
        receipts: anonymous,
        endpoint: ENDPOINT,
        menu: menu(),
      })
    ).toMatchObject({ tier: 0, receipts: 0 });
  });
});

describe("trustOverrideCapMicro", () => {
  const pubkey = "ab".repeat(32);

  it("matches on builder pubkey, case-insensitively", () => {
    const config = { trustOverrides: { [pubkey]: "$50" } };
    expect(trustOverrideCapMicro({ config, builderPubkey: pubkey.toUpperCase() })).toBe(50_000_000);
  });

  it("matches an uppercase config key too — a pre-grant that silently misses is the failure mode", () => {
    const config = { trustOverrides: { [pubkey.toUpperCase()]: "$50" } };
    expect(trustOverrideCapMicro({ config, builderPubkey: pubkey })).toBe(50_000_000);
    expect(trustOverrideCapMicro({ config, builderPubkey: pubkey.toUpperCase() })).toBe(50_000_000);
  });

  it("is undefined with no pubkey to key on — an unattested DVM can't be pre-granted", () => {
    const config = { trustOverrides: { [pubkey]: "$50" } };
    expect(trustOverrideCapMicro({ config })).toBeUndefined();
  });

  it("does not round a hand-edited sub-micro cap into a different policy", () => {
    const config = { trustOverrides: { [pubkey]: "$0.0000006" } };
    expect(trustOverrideCapMicro({ config, builderPubkey: pubkey })).toBeUndefined();
  });
});

describe("automaticCreditBoundRail", () => {
  it("returns only the active credit binding the automatic planner can refill", () => {
    expect(automaticCreditBoundRail(stored({ rail: "lightning" }))).toBe("lightning");
    expect(
      automaticCreditBoundRail(stored({ rail: "lightning", status: "expired" }))
    ).toBeUndefined();
    expect(
      automaticCreditBoundRail(stored({ rail: "lightning", reconciliationPending: true }))
    ).toBeUndefined();
    expect(automaticCreditBoundRail(stored({ rail: "not-a-rail" }))).toBeUndefined();
  });
});

describe("sizeCreditMicro / refillTargetMicro", () => {
  it("clamp(min, 20×price, cap): the 20× term wins in the middle", () => {
    expect(sizeCreditMicro({ menu: menu(), priceMicro: 10_000, capMicro: TIER0_CAP_MICRO })).toBe(
      10_000 * OPEN_TARGET_JOBS
    );
  });

  it("tier cap binds 20× from above", () => {
    expect(sizeCreditMicro({ menu: menu(), priceMicro: 100_000, capMicro: TIER0_CAP_MICRO })).toBe(
      TIER0_CAP_MICRO
    );
  });

  it("builder min binds from below — even above the tier cap", () => {
    const m = menu({ min_micro: 600_000 });
    expect(sizeCreditMicro({ menu: m, priceMicro: 1_000, capMicro: TIER0_CAP_MICRO })).toBe(
      600_000
    );
  });

  it("residual ceiling: never fund more than max + price", () => {
    const m = menu({ max_micro: 150_000 });
    expect(sizeCreditMicro({ menu: m, priceMicro: 10_000, capMicro: 5_000_000 })).toBe(160_000);
  });

  it("refill target defaults to 40× on the Cashu rail, capped by tier and max", () => {
    expect(refillTargetMicro({ menu: menu(), priceMicro: 10_000, capMicro: TIER1_CAP_MICRO })).toBe(
      Math.min(10_000 * CASHU_REFILL_TARGET_JOBS, TIER1_CAP_MICRO)
    );
  });
});

describe("planCreditForQuote", () => {
  const base = {
    menu: menu(),
    endpoint: ENDPOINT,
    signingPubkey: CALLER_A,
    priceMsats: 10_000,
    btcRate: RATE,
    receipts: receipts(1),
    stored: undefined,
    config: { posture: "auto" } as CreditConfig,
  };

  it("first contact stays implicit N=1 — zero completed receipts → none", () => {
    expect(planCreditForQuote({ ...base, receipts: [] })).toEqual({ mode: "none" });
  });

  it("a fresh identity is on its own first contact, whatever a neighbour earned here", () => {
    const plan = planCreditForQuote({
      ...base,
      signingPubkey: CALLER_B,
      receipts: receipts(20, 30, CALLER_A),
    });
    expect(plan).toEqual({ mode: "none" });
  });

  it("and opens at the tier-0 floor once it has a receipt of its own", () => {
    const plan = planCreditForQuote({
      ...base,
      signingPubkey: CALLER_B,
      priceMsats: 100_000,
      receipts: [...receipts(20, 30, CALLER_A), ...receipts(1, 0, CALLER_B)],
    });
    expect(plan.mode).toBe("open");
    if (plan.mode !== "open") return;
    expect(plan.fundMicro).toBe(TIER0_CAP_MICRO);

    const neighbour = planCreditForQuote({
      ...base,
      signingPubkey: CALLER_A,
      priceMsats: 100_000,
      receipts: [...receipts(20, 30, CALLER_A), ...receipts(1, 0, CALLER_B)],
    });
    expect(neighbour.mode).toBe("open");
    if (neighbour.mode !== "open") return;
    expect(neighbour.fundMicro).toBe(2_000_000);
  });

  it("second interaction opens at clamp(min, 20×, tier cap)", () => {
    const plan = planCreditForQuote(base);
    expect(plan.mode).toBe("open");
    if (plan.mode !== "open") return;
    expect(plan.fundMicro).toBe(200_000);
    expect(plan.currency).toBe("usd");
    expect(plan.fundSats).toBe(200);
    expect(plan.fundMsats).toBe(200_000);
    expect(plan.creditId).not.toMatch(/^(imp|fnd):/);
    expect(plan.targetMicro).toBe(400_000);
  });

  it("routes an advertised Tempo session to a healthy-moment open with a policy cap", () => {
    const plan = planCreditForQuote({
      ...base,
      menu: menu({
        funding: ["tempo"],
        tempo: { methods: [{ method: "tempo", intent: "session" }] },
      }),
      tempoConnected: true,
    });
    expect(plan.mode).toBe("none");
    if (plan.mode !== "none") return;
    expect(plan.deferred).toMatchObject({
      reason: "open",
      fundMicro: 200_000,
      targetMicro: 400_000,
      maxDepositMicro: 200_000,
    });
  });

  it("routes an advertised Tempo charge to the same durable credit open", () => {
    const plan = planCreditForQuote({
      ...base,
      menu: menu({
        funding: ["tempo"],
        tempo: { methods: [{ method: "tempo", intent: "charge" }] },
      }),
      tempoConnected: true,
    });
    expect(plan.mode).toBe("none");
    if (plan.mode !== "none") return;
    expect(plan.deferred).toMatchObject({
      reason: "open",
      fundMicro: 200_000,
      targetMicro: 400_000,
      maxDepositMicro: 200_000,
    });
  });

  it("does not engage a Tempo-only credit menu without a connected key", () => {
    expect(
      planCreditForQuote({
        ...base,
        menu: menu({
          funding: ["tempo"],
          tempo: { methods: [{ method: "tempo", intent: "session" }] },
        }),
        tempoConnected: false,
      })
    ).toEqual({ mode: "none" });
  });

  it("an active stored credit plans a topup under the same id", () => {
    const plan = planCreditForQuote({ ...base, stored: stored({ remainingMicro: 5_000 }) });
    expect(plan.mode).toBe("topup");
    if (plan.mode !== "topup") return;
    expect(plan.creditId).toBe("credit-1");
    expect(plan.fundMicro).toBeGreaterThanOrEqual(menu().min_micro);
  });

  it("does not refill or replace a credit while its chain backing is unresolved", () => {
    expect(
      planCreditForQuote({
        ...base,
        stored: stored({ remainingMicro: 5_000, reconciliationPending: true }),
      })
    ).toEqual({ mode: "none" });
  });

  it.each([
    ["no menu", { menu: undefined }],
    ["no signer", { signingPubkey: undefined }],
    ["non-usd menu", { menu: menu({ currency: "eur" }) }],
    ["x402 wallet not connected", { menu: menu({ funding: ["x402"] }) }],
    ["posture off", { config: { posture: "off" } as CreditConfig }],
    [
      "posture off per-DVM",
      { config: { perDvm: { [ENDPOINT]: { posture: "off" } } } as CreditConfig },
    ],
  ])("refuses to engage: %s", (_label, overrides) => {
    expect(planCreditForQuote({ ...base, ...overrides })).toEqual({ mode: "none" });
  });

  describe("unavailable BTC pricing", () => {
    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
      "explains an eligible second-contact open without sizing a purchase at rate %s",
      (btcRate) => {
        expect(planCreditForQuote({ ...base, btcRate })).toEqual({
          mode: "none",
          fundingSkipped: { reason: "btc_rate_unavailable", operation: "open" },
        });
      }
    );

    it("explains a refill of applicable active credit without requiring receipt history", () => {
      expect(
        planCreditForQuote({
          ...base,
          btcRate: 0,
          receipts: [],
          stored: stored({ remainingMicro: 5_000 }),
        })
      ).toEqual({
        mode: "none",
        fundingSkipped: { reason: "btc_rate_unavailable", operation: "refill" },
      });
    });

    it("does not attribute old same-origin receipts to a different live DVM identity", () => {
      const replacement = attestedDvm("replacement");
      const identity = { dvmId: "dvm-replacement", builderPubkey: replacement.identity.pubkey };
      expect(planCreditForQuote({ ...base, identity, btcRate: 0 })).toEqual({ mode: "none" });
    });

    it("does not attribute same-DVM-id receipts to a different live builder", () => {
      const replacement = attestedDvm("wordcount");
      const identity = { dvmId: WORDCOUNT_DVM_ID, builderPubkey: replacement.identity.pubkey };
      expect(planCreditForQuote({ ...base, identity, btcRate: 0 })).toEqual({ mode: "none" });
    });

    it("recognizes the caller's completed receipt at another hostname for the live identity", () => {
      const identity = { dvmId: WORDCOUNT_DVM_ID, builderPubkey: dvm.identity.pubkey };
      expect(
        planCreditForQuote({ ...base, identity, endpoint: "https://alias.example.com", btcRate: 0 })
      ).toEqual({
        mode: "none",
        fundingSkipped: { reason: "btc_rate_unavailable", operation: "open" },
      });
    });

    it.each<[string, Partial<Parameters<typeof planCreditForQuote>[0]>]>([
      ["first contact", { receipts: [] }],
      ["another caller's receipts", { receipts: receipts(1, 0, CALLER_B) }],
      ["another endpoint's receipts", { endpoint: "https://other.example.com" }],
      [
        "a failed receipt",
        {
          receipts: [{
            ...receipts(1)[0],
            receipt: dvm.sign({ requester_pubkey: CALLER_A, outcome: "failed" }),
          }],
        },
      ],
      [
        "a forged receipt",
        {
          receipts: receipts(1).map((entry) => ({
            ...entry,
            receipt: { ...entry.receipt, signature: "00".repeat(64) },
          })),
        },
      ],
      ["off posture", { config: { posture: "off" } as CreditConfig }],
      ["suggest posture", { config: { posture: "suggest" } as CreditConfig }],
      ["default suggest posture", { config: undefined }],
      ["no menu", { menu: undefined }],
      ["no signer", { signingPubkey: undefined }],
      ["non-USD menu", { menu: menu({ currency: "eur" }) }],
      ["no funding routes", { menu: menu({ funding: [] }) }],
      ["disconnected float", { menu: menu({ funding: ["lightning"] }), floatConnected: false }],
      ["disconnected x402 wallet", { menu: menu({ funding: ["x402"], x402: X402_CHANNELS }) }],
      ["missing x402 scheme", { menu: menu({ funding: ["x402"] }), x402Connected: true }],
      [
        "unsupported x402 network",
        {
          menu: menu({ funding: ["x402"], x402: X402_CHANNELS }),
          x402Connected: true,
          x402Network: "eip155:8453",
        },
      ],
      ["missing Tempo method", { menu: menu({ funding: ["tempo"] }), tempoConnected: true }],
      [
        "disconnected Tempo account",
        {
          menu: menu({
            funding: ["tempo"],
            tempo: { methods: [{ method: "tempo", intent: "charge" }] },
          }),
        },
      ],
      ["pending reconciliation", { stored: stored({ reconciliationPending: true }) }],
      ["zero price", { priceMsats: 0 }],
      ["negative price", { priceMsats: -1 }],
      ["nonfinite price", { priceMsats: Number.NaN }],
      ["inactive credit without open history", { receipts: [], stored: stored({ status: "expired" }) }],
      [
        "currency-mismatched credit without open history",
        { receipts: [], stored: stored({ currency: "eur" }) },
      ],
    ])("does not blame the rate for %s", (_label, overrides) => {
      expect(planCreditForQuote({ ...base, btcRate: 0, ...overrides })).toEqual({ mode: "none" });
    });

    it.each<[string, Partial<Parameters<typeof planCreditForQuote>[0]>]>([
      ["Lightning", { menu: menu({ funding: ["lightning"] }), floatConnected: true }],
      [
        "x402",
        {
          menu: menu({ funding: ["x402"], x402: X402_CHANNELS }),
          x402Connected: true,
          x402Network: "eip155:84532",
        },
      ],
      [
        "Tempo",
        {
          menu: menu({
            funding: ["tempo"],
            tempo: { methods: [{ method: "tempo", intent: "charge" }] },
          }),
          tempoConnected: true,
        },
      ],
    ])("explains missing pricing for eligible deferred %s funding", (_label, route) => {
      expect(planCreditForQuote({ ...base, ...route, btcRate: 0 })).toEqual({
        mode: "none",
        fundingSkipped: { reason: "btc_rate_unavailable", operation: "open" },
      });
      expect(planCreditForQuote({ ...base, ...route, btcRate: 0, stored: stored() })).toEqual({
        mode: "none",
        fundingSkipped: { reason: "btc_rate_unavailable", operation: "refill" },
      });
    });
  });

  it("opens an x402-only credit at the post-job healthy moment", () => {
    const plan = planCreditForQuote({
      ...base,
      menu: menu({ funding: ["x402"], x402: X402_CHANNELS }),
      x402Connected: true,
      x402Network: "eip155:84532",
    });
    expect(plan.mode).toBe("none");
    if (plan.mode !== "none") return;
    expect(plan.deferred).toMatchObject({
      reason: "open",
      fundMicro: 200_000,
      targetMicro: 400_000,
      currency: "usd",
    });
  });

  it("opens an exact-only x402 credit too — one authorization per top-up", () => {
    const plan = planCreditForQuote({
      ...base,
      menu: menu({ funding: ["x402"], x402: X402_EXACT_ONLY }),
      x402Connected: true,
      x402Network: "eip155:84532",
    });
    expect(plan.mode).toBe("none");
    if (plan.mode !== "none") return;
    expect(plan.deferred).toMatchObject({ reason: "open", fundMicro: 200_000 });
  });

  it("does not engage an x402 menu that names no scheme at all", () => {
    expect(
      planCreditForQuote({
        ...base,
        menu: menu({ funding: ["x402"] }),
        x402Connected: true,
        x402Network: "eip155:84532",
      })
    ).toEqual({ mode: "none" });
  });

  it.each([
    ["a channel", X402_CHANNELS],
    ["exact", X402_EXACT_ONLY],
  ])("does not engage %s on a chain this wallet isn't pinned to", (_label, x402) => {
    expect(
      planCreditForQuote({
        ...base,
        menu: menu({ funding: ["x402"], x402 }),
        x402Connected: true,
        x402Network: "eip155:8453",
      })
    ).toEqual({ mode: "none" });
  });
});

describe("credit posture", () => {
  const base = {
    menu: menu(),
    endpoint: ENDPOINT,
    signingPubkey: CALLER_A,
    priceMsats: 10_000,
    btcRate: RATE,
    receipts: receipts(1),
    stored: undefined,
  };
  const auto: CreditConfig = { posture: "auto" };

  it("defaults to suggest — a zero-config caller's second job buys nothing", () => {
    expect(DEFAULT_CREDIT_POSTURE).toBe("suggest");
    const plan = planCreditForQuote(base);
    expect(plan.mode).toBe("none");
    if (plan.mode !== "none") return;
    expect(plan.fundingSkipped).toBeUndefined();
    expect(plan.suppressed).toEqual({
      reason: "open",
      fundMicro: 200_000,
      targetMicro: 400_000,
      currency: "usd",
    });
  });

  it("suppresses a refill of an active credit, quoting what it would have added", () => {
    const args = { ...base, stored: stored({ remainingMicro: 5_000 }) };
    const suggested = planCreditForQuote(args);
    const purchased = planCreditForQuote({ ...args, config: auto });
    expect(purchased.mode).toBe("topup");
    expect(suggested.mode).toBe("none");
    if (suggested.mode !== "none" || purchased.mode !== "topup") return;
    expect(suggested.fundingSkipped).toBeUndefined();
    expect(suggested.suppressed).toEqual({
      reason: "refill",
      fundMicro: purchased.fundMicro,
      targetMicro: purchased.targetMicro,
      currency: purchased.currency,
    });
  });

  it("first contact is per-call in every posture, and carries no suggestion", () => {
    for (const posture of ["suggest", "auto", "off"] as const) {
      expect(planCreditForQuote({ ...base, receipts: [], config: { posture } })).toEqual({
        mode: "none",
      });
    }
  });

  it("off refuses a draw on a credit already held; suggest does not", () => {
    const probe = {
      stored: stored(),
      drawCeilingMsats: 1e6,
      drawCeilingSource: "budget" as const,
      btcRate: RATE,
    };
    expect(planProbeDraw({ ...probe, config: { posture: "off" } }).mode).toBe("none");
    expect(planProbeDraw({ ...probe, config: { posture: "suggest" } }).mode).toBe("draw");
  });

  it.each([
    ["nothing configured", undefined, "suggest", "default"],
    ["global auto", { posture: "auto" }, "auto", "global"],
    [
      "per-DVM auto over global suggest",
      { posture: "suggest", perDvm: { [ENDPOINT]: { posture: "auto" } } },
      "auto",
      "per_dvm",
    ],
    [
      "per-DVM suggest over global auto",
      { posture: "auto", perDvm: { [ENDPOINT]: { posture: "suggest" } } },
      "suggest",
      "per_dvm",
    ],
    [
      "per-DVM entry for another DVM",
      { posture: "auto", perDvm: { "https://other.example": { posture: "off" } } },
      "auto",
      "global",
    ],
    ["an unrecognised value", { posture: "yes" as never }, "suggest", "default"],
  ])("resolves %s", (_label, config, posture, source) => {
    expect(effectiveCreditPosture(config as CreditConfig | undefined, ENDPOINT)).toEqual({
      posture,
      source,
    });
  });

  it("layers per-DVM overrides through the endpoint normaliser", () => {
    const config: CreditConfig = { perDvm: { [ENDPOINT]: { posture: "auto" } } };
    expect(effectiveCreditPosture(config, `${ENDPOINT}/v1/job`).posture).toBe("auto");
  });
});

describe("planProbeDraw", () => {
  const base = {
    stored: stored(),
    drawCeilingMsats: 1_000_000,
    drawCeilingSource: "budget" as const,
    btcRate: RATE,
  };

  it("draws on a live credit", () => {
    const plan = planProbeDraw(base);
    expect(plan.mode).toBe("draw");
    if (plan.mode !== "draw") return;
    expect(plan.creditId).toBe("credit-1");
    expect(plan.drawId).toBeTruthy();
  });

  it("spends the earliest released per-call balance before prepaid credit", () => {
    const plan = planProbeDraw({
      ...base,
      implicit: [
        implicit({ creditId: "imp:cashu:later", expiryMs: Date.now() + 20_000 }),
        implicit({ creditId: "imp:cashu:first", expiryMs: Date.now() + 10_000 }),
      ],
    });
    expect(plan).toMatchObject({
      mode: "draw",
      creditId: "imp:cashu:first",
      source: "implicit",
    });
  });

  it("does not let a lost implicit row hide usable prepaid credit", () => {
    expect(
      planProbeDraw({
        ...base,
        implicit: [implicit({ status: "lost" })],
      })
    ).toMatchObject({ mode: "draw", creditId: "credit-1", source: "prepaid" });
  });

  it("applies the same posture-off gate to released value", () => {
    expect(
      planProbeDraw({
        ...base,
        stored: undefined,
        implicit: [implicit()],
        config: { posture: "off" },
      })
    ).toMatchObject({
      mode: "none",
      drawSkipped: { reason: "posture_off", creditId: "imp:cashu:released" },
    });
  });

  it("draws with no per-call payment consent declared", () => {
    expect(planProbeDraw({ ...base, drawCeilingMsats: 0 }).mode).toBe("draw");
  });

  it("draws again at a ceiling the last drawn price sits under", () => {
    const stale = stored({ lastPriceMicro: 5_091 });
    expect(planProbeDraw({ ...base, stored: stale, drawCeilingMsats: 31_427 }).mode).toBe("draw");
  });

  it.each([
    ["expired locally", { stored: stored({ expiryMs: 1 }) }, "expired"],
    ["nothing spendable", { stored: stored({ remainingMicro: 0 }) }, "exhausted"],
    ["marked gone", { stored: stored({ status: "gone" as const }) }, "not_active"],
    [
      "backing reconciliation pending",
      { stored: stored({ reconciliationPending: true }) },
      "reconciliation_pending",
    ],
    [
      "last price above the declared ceiling",
      { stored: stored({ lastPriceMicro: 5_000_000 }), drawCeilingMsats: 10_000 },
      "price_above_ceiling",
    ],
  ])("stands down: %s, naming why", (_label, overrides, reason) => {
    const plan = planProbeDraw({ ...base, ...overrides });
    expect(plan.mode).toBe("none");
    if (plan.mode !== "none") return;
    expect(plan.drawSkipped?.reason).toBe(reason);
    expect(plan.drawSkipped?.creditId).toBe("credit-1");
  });

  it.each(["auto_pay_below", "config_threshold", "budget"] as const)(
    "records that the %s ceiling is what bound",
    (source) => {
      const plan = planProbeDraw({
        ...base,
        stored: stored({ lastPriceMicro: 5_000_000 }),
        drawCeilingMsats: 10_000,
        drawCeilingSource: source,
      });
      expect(plan.mode).toBe("none");
      if (plan.mode !== "none") return;
      expect(plan.drawSkipped?.ceilingSource).toBe(source);
    }
  );

  it("stands down silently when no credit is held here", () => {
    expect(planProbeDraw({ ...base, stored: undefined })).toEqual({ mode: "none" });
  });

  it("draws through a zero the server has not confirmed", () => {
    const plan = planProbeDraw({
      ...base,
      stored: stored({ remainingMicro: 0, provisional: true }),
    });
    expect(plan.mode).toBe("draw");
    if (plan.mode !== "draw") return;
    expect(plan.creditId).toBe("credit-1");
  });

  it("reports a provisional zero that has expired as expired, not drawable", () => {
    const plan = planProbeDraw({
      ...base,
      stored: stored({ remainingMicro: 0, provisional: true, expiryMs: 1 }),
    });
    expect(plan.mode).toBe("none");
    if (plan.mode !== "none") return;
    expect(plan.drawSkipped?.reason).toBe("expired");
  });
});

describe("needsTopup / msatsToMicro", () => {
  it("fires strictly below 25% of target", () => {
    expect(needsTopup(99_999, 400_000)).toBe(true);
    expect(needsTopup(100_000, 400_000)).toBe(false);
    expect(needsTopup(0, 0)).toBe(false);
  });

  it("msats→micro round-trips the fx math", () => {
    expect(msatsToMicro(10_000, 50_000)).toBe(5_000);
  });
});

describe("the pocket target", () => {
  it("defaults to $5 and honours a parseable config override", () => {
    expect(pocketTargetMicro()).toBe(POCKET_TARGET_MICRO);
    expect(pocketTargetMicro({})).toBe(5_000_000);
    expect(pocketTargetMicro({ pocketTarget: "$8" })).toBe(8_000_000);
    expect(pocketTargetMicro({ pocketTarget: "2.50" })).toBe(2_500_000);
  });

  it("falls back to the default on junk rather than disabling the refill", () => {
    expect(pocketTargetMicro({ pocketTarget: "eight dollars" })).toBe(POCKET_TARGET_MICRO);
    expect(pocketTargetMicro({ pocketTarget: "$0" })).toBe(POCKET_TARGET_MICRO);
  });

  it("shares the credit refill's 25% low-water mark", () => {
    expect(needsPocketRefill(1_249_999, 5_000_000)).toBe(true);
    expect(needsPocketRefill(1_250_000, 5_000_000)).toBe(false);
    expect(needsPocketRefill(0, 0)).toBe(false);
  });
});

describe("fundWireAmountMicro", () => {
  it("returns the fiat price verbatim when the token pays exactly", () => {
    expect(fundWireAmountMicro(3174, 100_000, 100_000)).toBe(3174);
  });

  it("scales pro-rata at the quote-pinned ratio, rounding half-up", () => {
    expect(fundWireAmountMicro(100_000, 250_000, 100_000)).toBe(250_000);
    expect(fundWireAmountMicro(3174, 150_000, 100_000)).toBe(4761);
    expect(fundWireAmountMicro(3175, 150_000, 100_000)).toBe(4763);
  });
});

describe("readFundValuation", () => {
  const MESSAGE =
    "fund.amount_micro (3200) does not match the attached token's value at the quoted price (3174).";

  it("prefers the structured field over a conflicting message figure", () => {
    expect(readFundValuation({ expectedMicro: 3174, message: MESSAGE })).toEqual({
      kind: "figure",
      micro: 3174,
    });
    expect(readFundValuation({ expectedMicro: 999, message: MESSAGE })).toEqual({
      kind: "figure",
      micro: 999,
    });
  });

  it("falls back to the message figure for providers predating the field", () => {
    expect(readFundValuation({ message: MESSAGE })).toEqual({ kind: "figure", micro: 3174 });
    expect(readFundValuation({ expectedMicro: undefined, message: MESSAGE })).toEqual({
      kind: "figure",
      micro: 3174,
    });
  });

  it("reports `absent` when the provider stated no valuation at all", () => {
    expect(readFundValuation({})).toEqual({ kind: "absent" });
    expect(
      readFundValuation({
        message: "fund.commitment does not match the SHA-256 of the attached funding artifact.",
      })
    ).toEqual({ kind: "absent" });
  });

  it("falls through to the message when the structured field is present but unusable", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, "3174", null]) {
      expect(readFundValuation({ expectedMicro: bad, message: MESSAGE })).toEqual({
        kind: "figure",
        micro: 3174,
      });
    }
  });

  it("reports `malformed`, never `absent`, when the stated valuation is unusable", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, null]) {
      expect(readFundValuation({ expectedMicro: bad, message: "refused" })).toEqual({
        kind: "malformed",
      });
    }
    expect(
      readFundValuation({
        message: "does not match the attached token's value at the quoted price (0).",
      })
    ).toEqual({ kind: "malformed" });
  });
});

describe("rail-aware funding", () => {
  const railMenu = menu({ funding: ["cashu", "lightning"], lightning_min_micro: 1_400_000 });
  const base = {
    menu: railMenu,
    endpoint: ENDPOINT,
    signingPubkey: CALLER_A,
    priceMsats: 100_000,
    btcRate: RATE,
    receipts: receipts(3),
    stored: undefined,
    config: { posture: "auto", tier1Cap: "$5" } as CreditConfig,
    floatConnected: true,
  };

  describe("the healthy-moment open", () => {
    it("routes a floor-clearing open to the float instead of the job request", () => {
      const plan = planCreditForQuote(base);
      expect(plan.mode).toBe("none");
      if (plan.mode !== "none") return;
      expect(plan.deferred).toMatchObject({
        reason: "open",
        fundMicro: 2_000_000,
        targetMicro: 4_000_000,
        currency: "usd",
      });
      expect(plan.suppressed).toBeUndefined();
      expect(plan.fundingSkipped).toBeUndefined();
      expect(plan.deferred?.creditId).not.toMatch(/^(imp|fnd):/);
    });

    it("never inflates a cast-sized credit toward the floor — it funds in ecash", () => {
      const plan = planCreditForQuote({ ...base, priceMsats: 27_000 });
      expect(plan.mode).toBe("open");
      if (plan.mode !== "open") return;
      expect(plan.fundMicro).toBe(540_000);
      expect(plan.railReason).toBe("below_lightning_minimum");
    });

    it("is byte-identical to the cashu-only path for a caller with no float", () => {
      const withFloat = planCreditForQuote({ ...base, floatConnected: false });
      expect(withFloat.mode).toBe("open");
      if (withFloat.mode !== "open") return;
      expect(withFloat.fundMicro).toBe(2_000_000);
      expect(withFloat.railReason).toBe("no_float");
    });

    it("says so when the DVM takes no Lightning funding at all", () => {
      const plan = planCreditForQuote({ ...base, menu: menu({ funding: ["cashu"] }) });
      expect(plan.mode).toBe("open");
      if (plan.mode !== "open") return;
      expect(plan.railReason).toBe("lightning_not_offered");
    });

    it("never invents a floor the DVM didn't advertise", () => {
      const plan = planCreditForQuote({
        ...base,
        menu: menu({ funding: ["cashu", "lightning"] }),
      });
      expect(plan.mode).toBe("open");
      if (plan.mode !== "open") return;
      expect(plan.railReason).toBe("no_lightning_minimum");
    });

    it("stays held back under `suggest` — the float is not a way around consent", () => {
      const plan = planCreditForQuote({ ...base, config: { posture: "suggest" } });
      expect(plan.mode).toBe("none");
      if (plan.mode !== "none") return;
      expect(plan.deferred).toBeUndefined();
      expect(plan.suppressed?.reason).toBe("open");
    });
  });

  describe("the forced-rail pin", () => {
    it("keeps a large funding on ecash when pinned — the privacy persona", () => {
      const plan = planCreditForQuote({
        ...base,
        config: { ...base.config, fundingRail: "cashu" },
      });
      expect(plan.mode).toBe("open");
      if (plan.mode !== "open") return;
      expect(plan.fundMicro).toBe(2_000_000);
      expect(plan.railReason).toBe("forced");
    });

    it("forces a sub-floor funding to the float, where it is refused honestly", () => {
      const plan = planCreditForQuote({
        ...base,
        priceMsats: 27_000,
        config: { ...base.config, fundingRail: "lightning" },
      });
      expect(plan.mode).toBe("none");
      if (plan.mode !== "none") return;
      expect(plan.deferred).toMatchObject({
        reason: "open",
        fundMicro: 540_000,
        pinnedRail: "lightning",
        pinnedRailSource: "global",
      });
    });

    it("lets a per-DVM pin beat a global one", () => {
      const plan = planCreditForQuote({
        ...base,
        config: {
          ...base.config,
          fundingRail: "lightning",
          perDvm: { [ENDPOINT]: { fundingRail: "cashu" } },
        },
      });
      expect(plan.mode).toBe("open");
      if (plan.mode !== "open") return;
      expect(plan.railReason).toBe("forced");
    });

    it("resolves provenance the way the posture does", () => {
      expect(effectiveFundingRail(undefined, ENDPOINT)).toEqual({ source: "default" });
      expect(effectiveFundingRail({ fundingRail: "cashu" }, ENDPOINT)).toEqual({
        rail: "cashu",
        source: "global",
      });
      expect(
        effectiveFundingRail(
          { fundingRail: "cashu", perDvm: { [ENDPOINT]: { fundingRail: "lightning" } } },
          ENDPOINT
        )
      ).toEqual({ rail: "lightning", source: "per_dvm" });
    });

    it("reads the global layer through the same resolver when no endpoint is supplied", () => {
      expect(
        effectiveFundingRail({
          fundingRail: "cashu",
          perDvm: { [ENDPOINT]: { fundingRail: "lightning" } },
        })
      ).toEqual({ rail: "cashu", source: "global" });
      expect(
        effectiveFundingRail({ perDvm: { [ENDPOINT]: { fundingRail: "lightning" } } })
      ).toEqual({ source: "default" });
    });

    it("ignores a value outside the registry rather than throwing on the money path", () => {
      const config = { fundingRail: "bolt12" } as unknown as CreditConfig;
      expect(effectiveFundingRail(config, ENDPOINT)).toEqual({ source: "default" });
    });
  });

  describe("refills", () => {
    it("routes a lightning-bound credit's refill to the float, not a doomed fund-and-draw", () => {
      const plan = planCreditForQuote({
        ...base,
        stored: stored({ rail: "lightning", remainingMicro: 5_000, menu: railMenu }),
      });
      expect(plan.mode).toBe("none");
      if (plan.mode !== "none") return;
      expect(plan.deferred).toMatchObject({ reason: "refill", creditId: "credit-1" });
    });

    it("carries the DVM's binding to the healthy moment, so it isn't re-picked there", () => {
      const plan = planCreditForQuote({
        ...base,
        priceMsats: 27_000,
        stored: stored({ rail: "lightning", remainingMicro: 5_000, menu: railMenu }),
      });
      expect(plan.mode).toBe("none");
      if (plan.mode !== "none") return;
      expect(plan.deferred).toMatchObject({
        reason: "refill",
        pinnedRail: "lightning",
        pinnedRailSource: "credit_bound",
      });
    });

    it("floors a bound refill at the Lightning minimum, exactly as `fundTopup` does", () => {
      const plan = planCreditForQuote({
        ...base,
        priceMsats: 27_000,
        stored: stored({ rail: "lightning", remainingMicro: 5_000, menu: railMenu }),
      });
      expect(plan.mode).toBe("none");
      if (plan.mode !== "none") return;
      expect(plan.deferred?.fundMicro).toBe(1_400_000);
      expect(plan.deferred?.targetMicro).toBe(1_080_000);
    });

    it("floors on a `lightning` pin too, but never on an unforced sizing", () => {
      const pinned = planCreditForQuote({
        ...base,
        priceMsats: 27_000,
        config: { ...base.config, fundingRail: "lightning" },
        stored: stored({ remainingMicro: 5_000, menu: railMenu }),
      });
      expect(pinned.mode).toBe("none");
      if (pinned.mode !== "none") return;
      expect(pinned.deferred).toMatchObject({
        fundMicro: 1_400_000,
        pinnedRail: "lightning",
        pinnedRailSource: "global",
      });

      const unforced = planCreditForQuote({
        ...base,
        priceMsats: 27_000,
        stored: stored({ remainingMicro: 5_000, menu: railMenu }),
      });
      expect(unforced.mode).toBe("topup");
      if (unforced.mode !== "topup") return;
      expect(unforced.fundMicro).toBe(1_102_000);
    });

    it("offers the floored figure under `suggest`, not one the caller can't fund", () => {
      const plan = planCreditForQuote({
        ...base,
        priceMsats: 27_000,
        config: { posture: "suggest" },
        stored: stored({ rail: "lightning", remainingMicro: 5_000, menu: railMenu }),
      });
      expect(plan.mode).toBe("none");
      if (plan.mode !== "none") return;
      expect(plan.suppressed?.fundMicro).toBe(1_400_000);
    });

    it("keeps a cashu-bound credit's refill on the job request, whatever the amount", () => {
      const plan = planCreditForQuote({
        ...base,
        stored: stored({ rail: "cashu", remainingMicro: 5_000, menu: railMenu }),
      });
      expect(plan.mode).toBe("topup");
      if (plan.mode !== "topup") return;
      expect(plan.railReason).toBe("forced");
    });

    it("re-picks by amount for a credit with no recorded binding", () => {
      const plan = planCreditForQuote({
        ...base,
        stored: stored({ remainingMicro: 5_000, menu: railMenu }),
      });
      expect(plan.mode).toBe("none");
      if (plan.mode !== "none") return;
      expect(plan.deferred?.reason).toBe("refill");
    });
  });
});
