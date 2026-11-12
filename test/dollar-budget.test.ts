import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DvmError, JOBS_FILE, type PaymentRequestContent, type Transport } from "@dvmkit/sdk/internal";

// The rate that turned "$0.75" into the 1,029,527 msats a real watch saved,
// beside an auto-pay threshold of "$0.60" (823,621 msats). It is also the
// caller's rate when each ask arrives.
const submitRate = vi.hoisted(() => 72_849);
const seams = vi.hoisted(() => ({
  enforceGlobalBudget: vi.fn(), recordSpend: vi.fn(), tryX402Payment: vi.fn(), loadX402Wallet: vi.fn(),
  jsonEvent: vi.fn(), status: vi.fn(), getMessages: vi.fn(), sendMessage: vi.fn(), close: vi.fn(),
}));
vi.mock("../src/lib/output", async (original) => ({
  ...await original<typeof import("../src/lib/output")>(), jsonEvent: seams.jsonEvent,
}));
vi.mock("../src/lib/transport", () => ({ createDvmTransport: () => seams }));
vi.mock("@dvmkit/sdk/internal", async (original) => ({
  ...await original<typeof import("@dvmkit/sdk/internal")>(), loadAgentWallet: () => null,
  getLastKnownBtcRate: () => ({ rate: submitRate, cachedAt: Date.now() }),
}));
vi.mock("../src/lib/btc-rate", async (original) => ({
  ...await original<typeof import("../src/lib/btc-rate")>(),
  tryResolveBtcUsdRate: async () => ({ rate: submitRate, stale: false }),
  resolveBtcUsdRate: async () => ({ rate: submitRate, stale: false }),
}));
vi.mock("../src/lib/budget-ledger", async (original) => ({
  ...await original<typeof import("../src/lib/budget-ledger")>(),
  enforceGlobalBudget: seams.enforceGlobalBudget, recordSpend: seams.recordSpend,
}));
vi.mock("../src/lib/x402/client", async (original) => ({
  ...await original<typeof import("../src/lib/x402/client")>(), tryX402Payment: seams.tryX402Payment,
}));
vi.mock("../src/lib/x402/wallet", async (original) => ({
  ...await original<typeof import("../src/lib/x402/wallet")>(), loadX402Wallet: seams.loadX402Wallet,
}));

import { usdToMsats } from "@dvmkit/sdk/internal";
import { addPayment, loadJob, recordUpfrontRailPayment, saveJob, updateJob } from "../src/lib/job-store";
import { askUsdMicro, dollarBoundUsdMicro } from "../src/lib/job-budget";
import { jobSpend } from "../src/lib/job-spend";
import { handlePaymentRequest } from "../src/lib/payment-responder";
import { buildPolicy } from "../src/lib/policy";
import { computeNextAction } from "../src/lib/next-action";
import { streamLoop } from "../src/lib/stream-loop";
import { nextActionHuman } from "../src/lib/next-action-human";
import { pay } from "../src/commands/pay";
import { messages } from "../src/commands/messages";

const endpoint = "https://provider.example";
const dollarPolicy = buildPolicy({ budget: "$0.75", autoPayBelow: "$0.60", maxIncrement: "$0.75", maxPayments: 8 }, submitRate);
const x402 = { pay_to: `0x${"1".repeat(40)}`, network: "eip155:8453", asset: `0x${"2".repeat(40)}`,
  payment_required: "challenge" };

/** An hourly ask as the provider sends it: dollars pinned, sats converted at that moment's rate. */
function hourlyAsk(usdMicro: number, msats: number, requiredUsdcMicro = usdMicro): PaymentRequestContent {
  return { amount_msats: msats, reason: "Next hour", credit: { amount_micro: usdMicro, currency: "usd" },
    fiat_amount: { amount: usdMicro / 1_000_000, currency: "usd" },
    x402: { ...x402, required_usdc_micro: String(requiredUsdcMicro) } } as unknown as PaymentRequestContent;
}

/** The same ask with no rail this caller holds a wallet for: a fitting ask waits for approval. */
function cashuAsk(usdMicro: number, msats: number): PaymentRequestContent {
  const { x402: _x402, ...ask } = hourlyAsk(usdMicro, msats);
  return ask;
}

function startWatch(policy: object): void {
  saveJob({ id: "watch", endpoint, status: "processing", submittedAt: 1, policy: policy as typeof dollarPolicy });
  // $0.55 to start, paid in Cashu at the quote's 754,000 msats.
  recordUpfrontRailPayment("watch", { method: "cashu", amountMsats: 754_000, usdMicro: 550_000 }, true);
}

let seq = 10;
const transport = { sendMessage: vi.fn() } as unknown as Transport;
const respond = (ask: PaymentRequestContent, policy: object = dollarPolicy) =>
  handlePaymentRequest("watch", ask, policy as typeof dollarPolicy, transport, { endpoint }, { rail: "x402", requestSeq: seq++ });

beforeEach(() => {
  rmSync(JOBS_FILE, { force: true });
  seams.enforceGlobalBudget.mockResolvedValue(submitRate);
  seams.loadX402Wallet.mockReturnValue({ privateKey: "0xkey" });
  vi.mocked(transport.sendMessage).mockResolvedValue({ seq: 99 } as never);
  seams.tryX402Payment.mockImplementation(async (args: { amountMsats: number; requiredUsdcMicro: string }) => ({
    paymentHeader: "proof", amountMsats: args.amountMsats, amountUsdcMicro: args.requiredUsdcMicro, btcRate: submitRate,
  }));
});

describe("a budget declared in dollars", () => {
  it("pays $0.55 plus four $0.05 asks under a $0.75 budget and refuses a fifth", async () => {
    expect(dollarPolicy).toMatchObject({ maxTotalMsats: 1_029_527, autoPayBelowMsats: 823_621 });
    startWatch(dollarPolicy);
    for (let hour = 1; hour <= 4; hour++)
      await expect(respond(hourlyAsk(50_000, 69_000)), `hour ${hour}`).resolves.toMatchObject({ status: "paid" });
    // 754,000 + 4 x 69,000 msats is 473 msats past the converted budget, but exactly $0.75.
    expect(loadJob("watch")).toMatchObject({ totalPaidMsats: 1_030_000, paidUsdMicro: 750_000, paymentsHonoured: 5 });
    await expect(respond(hourlyAsk(50_000, 69_000))).resolves.toBe("over-budget");
    expect(transport.sendMessage).toHaveBeenCalledTimes(4);
  });

  it("refuses an ask that would pass the dollar budget even when its sats fit the converted budget", async () => {
    startWatch(dollarPolicy);
    for (let hour = 1; hour <= 3; hour++) await respond(hourlyAsk(50_000, 69_000));
    // The rate rose: $0.050001 now converts to fewer sats than the remaining 68,527 msats.
    await expect(respond(hourlyAsk(50_001, 60_000))).resolves.toBe("over-budget");
    await expect(respond(hourlyAsk(50_000, 60_000))).resolves.toMatchObject({ status: "paid" });
    expect(loadJob("watch")?.paidUsdMicro).toBe(750_000);
  });

  // Tolerance rule: an ask is held to its dollars only if its sats, at the
  // caller's own rate, come to at most those dollars plus one sat; booked
  // dollars then never pass the declared budget, not even by one micro-dollar.
  it("holds an ask to its dollars only within one sat of them at the caller's rate", () => {
    const fair = usdToMsats(0.05, submitRate);
    expect(fair).toBe(68_635);
    expect(dollarBoundUsdMicro({ msats: fair + 1_000, usdMicro: 50_000, rate: submitRate })).toBe(50_000);
    expect(dollarBoundUsdMicro({ msats: fair + 1_001, usdMicro: 50_000, rate: submitRate })).toBeUndefined();
    expect(dollarBoundUsdMicro({ msats: fair, usdMicro: 50_000, rate: undefined })).toBeUndefined();
    // A display figure is not an exact price.
    expect(askUsdMicro({ amount_msats: 69_000, reason: "Next hour", fiat_amount: { amount: 0.05, currency: "usd" } } as PaymentRequestContent)).toBeUndefined();
  });

  it("holds a Cashu ask whose sats overstate its dollars to the sat budget", async () => {
    startWatch(dollarPolicy);
    // "$0.05" for 378,000 msats, about $0.275 at the caller's rate: 754,000 + 378,000
    // is past the 1,029,527-msat budget, so it is refused before any rail is tried.
    await expect(respond(cashuAsk(50_000, 378_000))).resolves.toBe("over-budget");
    // An honest ask on the same path is not refused on budget; with no wallet it waits for approval.
    await expect(respond(cashuAsk(50_000, 69_000))).resolves.toBe("needs-approval");
  });

  it.each([
    { probe: "a signed amount above the ask's dollars at the budget edge", hours: 3, ask: hourlyAsk(50_000, 69_000, 55_000) },
    { probe: "an under-priced ask whose sats and signed amount are far higher", hours: 0, ask: hourlyAsk(1, 378_000, 300_000) },
  ])("refuses x402 for $probe and never books past the budget", async ({ hours, ask }) => {
    startWatch(dollarPolicy);
    for (let hour = 1; hour <= hours; hour++) await respond(hourlyAsk(50_000, 69_000));
    // As the real client does: sign the offer's USDC and value it at the caller's rate.
    seams.tryX402Payment.mockImplementation(async (args: { requiredUsdcMicro: string }) => ({ paymentHeader: "proof",
      amountMsats: usdToMsats(Number(args.requiredUsdcMicro) / 1e6, submitRate),
      amountUsdcMicro: args.requiredUsdcMicro, btcRate: submitRate }));
    const sent = vi.mocked(transport.sendMessage).mock.calls.length;
    await expect(respond(ask)).resolves.toBe("over-budget");
    expect(transport.sendMessage).toHaveBeenCalledTimes(sent);
    expect(loadJob("watch")!.paidUsdMicro).toBeLessThanOrEqual(750_000);
  });

  it("states the signed overrun, not a payable ask, in the next step and in dvm pay", async () => {
    startWatch(dollarPolicy);
    for (let hour = 1; hour <= 3; hour++) await respond(hourlyAsk(50_000, 69_000));
    seams.tryX402Payment.mockImplementation(async (args: { requiredUsdcMicro: string }) => ({ paymentHeader: "proof",
      amountMsats: usdToMsats(Number(args.requiredUsdcMicro) / 1e6, submitRate),
      amountUsdcMicro: args.requiredUsdcMicro, btcRate: submitRate }));
    // The ask's own figures fit; the 55,000 micro-USDC its x402 offer signs does not.
    const ask = { seq: 40, from: "provider" as const, timestamp: 1, type: "payment-request" as const,
      content: hourlyAsk(50_000, 69_000, 55_000) };
    const overrun = "$0.70 spent so far plus $0.055 asked comes to $0.755, $0.005 over the $0.75 budget.";
    seams.status.mockResolvedValue({ status: "awaiting-input" });
    seams.getMessages.mockResolvedValue([ask]);
    await expect(pay("watch", { rail: "x402" })).rejects.toMatchObject({ code: "over_budget",
      hint: expect.stringContaining(overrun) });
    expect(seams.sendMessage).not.toHaveBeenCalled();
    const next = computeNextAction("watch", [ask], undefined, { ...loadJob("watch")!, policy: dollarPolicy }) as
      { display: string; hint: string };
    expect(next.display).toContain(overrun);
    expect(next.hint).toContain("dvm decline watch");
    expect(next.hint).toContain("Ask your human");
    expect(next.hint).toContain("dvm pay watch --budget <new total>");
  });

  it.each([
    ["a payment booked without dollars", () => addPayment("watch", 69_000)],
    ["a payment booked by an older CLI", () => updateJob("watch", { totalPaidMsats: 823_000, paymentsHonoured: 2 })],
  ])("falls back to the sat budget after %s", async (_name, book) => {
    startWatch(dollarPolicy);
    book();
    await respond(hourlyAsk(50_000, 69_000));
    await respond(hourlyAsk(50_000, 69_000));
    // $0.70 in dollars, but 961,000 msats: the next 69,000 passes the 1,029,527-msat budget.
    await expect(respond(hourlyAsk(50_000, 69_000))).resolves.toBe("over-budget");
  });

  it("shows the declared dollars as the job's budget", () => {
    startWatch(dollarPolicy);
    expect(jobSpend(loadJob("watch")!).budget_display).toMatch(/^\$0\.75 /);
  });

  it("states a dollar overrun in dollars in the next step", () => {
    startWatch(dollarPolicy);
    const job = loadJob("watch")!;
    const action = computeNextAction("watch", [{ seq: 3, from: "provider", timestamp: 1, type: "payment-request",
      content: hourlyAsk(250_000, 343_000) }], undefined, { ...job, policy: dollarPolicy });
    expect(action).toMatchObject({ type: "pay" });
    expect((action as { display?: string } | null)?.display).toContain("$0.55 spent so far plus $0.25 asked comes to $0.80, $0.05 over the $0.75 budget.");
  });

  it("names the dollar budget beside exact msats when sats decided", () => {
    startWatch(dollarPolicy);
    addPayment("watch", 207_000);
    const job = loadJob("watch")!;
    const action = computeNextAction("watch", [{ seq: 3, from: "provider", timestamp: 1, type: "payment-request",
      content: hourlyAsk(50_000, 69_000) }], undefined, { ...job, policy: dollarPolicy });
    expect((action as { display?: string } | null)?.display).toContain("961,000 msats spent so far plus 69,000 msats asked comes to 1,030,000 msats, " +
      "473 msats over the 1,029,527 msats budget (your $0.75 budget, converted to sats when the budget was set).");
  });
});

describe("a budget saved before dollar budgets were kept", () => {
  it("still refuses the fourth $0.05 ask by its 473 msats", async () => {
    const { maxTotalMsats, autoPayBelowMsats, maxIncrementMsats, maxPayments } = dollarPolicy;
    startWatch({ maxTotalMsats, autoPayBelowMsats, maxIncrementMsats, maxPayments });
    const legacy = { maxTotalMsats, autoPayBelowMsats, maxIncrementMsats, maxPayments };
    for (let hour = 1; hour <= 3; hour++)
      await expect(respond(hourlyAsk(50_000, 69_000), legacy)).resolves.toMatchObject({ status: "paid" });
    await expect(respond(hourlyAsk(50_000, 69_000), legacy)).resolves.toBe("over-budget");
  });

  it("keeps a sat budget on the sat comparison for dollar-priced asks", async () => {
    const satPolicy = buildPolicy({ budget: "961000", autoPayBelow: "823621", maxPayments: 8 }, submitRate);
    expect(satPolicy).not.toHaveProperty("maxTotalUsdMicro");
    startWatch(satPolicy);
    await expect(respond(hourlyAsk(50_000, 69_000), satPolicy)).resolves.toMatchObject({ status: "paid" });
    await expect(respond(hourlyAsk(50_000, 69_000), satPolicy)).resolves.toMatchObject({ status: "paid" });
    await expect(respond(hourlyAsk(50_000, 69_000), satPolicy)).resolves.toMatchObject({ status: "paid" });
    await expect(respond(hourlyAsk(1, 1), satPolicy)).resolves.toBe("over-budget");
  });
});


describe("explicit replacement of a saved budget", () => {
  const openAsk = () => ({ seq: 40, from: "provider" as const, timestamp: 1,
    type: "payment-request" as const, content: hourlyAsk(50_000, 69_000, 55_000) });
  const complete = { seq: 42, from: "provider", timestamp: 2, type: "complete", content: { status: "success", summary: "Done" } };
  function pending(): void {
    seams.status.mockResolvedValue({ status: "awaiting-input" });
    seams.getMessages.mockResolvedValue([openAsk()]);
    seams.sendMessage.mockImplementation(async () => {
      seams.status.mockResolvedValue({ status: "completed" });
      seams.getMessages.mockResolvedValue([complete]);
      return { seq: 41 };
    });
  }

  it.each(["$1.00", "1500000"])("saves approved total %s and pays a previously refused signed ask", async (budget) => {
    startWatch(dollarPolicy);
    for (let hour = 1; hour <= 3; hour++) await respond(hourlyAsk(50_000, 69_000));
    pending();
    await expect(pay("watch", { rail: "x402" })).rejects.toMatchObject({ code: "over_budget" });
    expect(loadJob("watch")?.budgetRefusals?.[40]).toMatchObject({ unit: "usd", total: 755_000 });
    await pay("watch", { rail: "x402", budget });
    const job = loadJob("watch")!;
    expect(job).toMatchObject({ paidUsdMicro: 755_000, paymentsHonoured: 5,
      policy: { maxPayments: 8, maxIncrementMsats: 1_029_527, autoPayBelowMsats: 823_621 } });
    expect(job.policy?.maxTotalMsats).toBe(budget === "$1.00" ? 1_372_702 : 1_500_000);
    if (budget === "$1.00") expect(job.policy?.maxTotalUsdMicro).toBe(1_000_000);
    else expect(job.policy).not.toHaveProperty("maxTotalUsdMicro");
    expect(job.budgetRefusals?.[40]).toBeUndefined();
    expect(seams.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("raises an exhausted sat budget and pays its open ask", async () => {
    const satPolicy = buildPolicy({ budget: "800000", maxPayments: 8 }, submitRate);
    startWatch(satPolicy);
    pending();
    await expect(pay("watch", { rail: "x402" })).rejects.toMatchObject({ code: "over_budget" });
    await pay("watch", { rail: "x402", budget: "1000000" });
    expect(loadJob("watch")).toMatchObject({ totalPaidMsats: 823_000, policy: { maxTotalMsats: 1_000_000,
      maxIncrementMsats: 1_000_000, autoPayBelowMsats: 160_000, maxPayments: 8 } });
    expect(loadJob("watch")?.policy).not.toHaveProperty("maxTotalUsdMicro");
    expect(seams.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("checks a dollar replacement against sats when the dollar ledger is incomplete", async () => {
    startWatch(dollarPolicy);
    addPayment("watch", 100_000);
    pending();
    // The recorded dollars alone fit $0.60, but 854,000 msats already spent do not.
    await expect(pay("watch", { budget: "$0.60" })).rejects.toMatchObject({ code: "budget_below_spend" });
    expect(loadJob("watch")?.policy).toEqual(dollarPolicy);
    expect(seams.sendMessage).not.toHaveBeenCalled();
  });

  it.each([["$0.54", 550_000, 540_000, "usd"], ["753999", 754_000, 753_999, "msats"]] as const)("refuses total %s below spend without rewriting policy or paying", async (budget, spent, proposed, unit) => {
    startWatch(dollarPolicy);
    pending();
    await expect(pay("watch", { budget })).rejects.toMatchObject({ code: "budget_below_spend",
      hint: expect.stringContaining("approve a higher total"),
      data: expect.objectContaining({ spent, proposed, unit, next_action: expect.objectContaining({ type: "pay", hint: expect.stringContaining("approve a higher total") }) }) });
    expect(loadJob("watch")?.policy).toEqual(dollarPolicy);
    expect(seams.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps the policy update and send under the job payment lock", async () => {
    const { withJobPaymentLock } = await import("../src/lib/payment-lock");
    startWatch(dollarPolicy);
    pending();
    await withJobPaymentLock("watch", async () => {
      await expect(pay("watch", { budget: "$1.00", rail: "x402" })).rejects.toMatchObject({ code: "payment_settling" });
      expect(loadJob("watch")?.policy).toEqual(dollarPolicy);
    });
    const send = seams.sendMessage.getMockImplementation()!;
    seams.sendMessage.mockImplementation(async (...args: unknown[]) => {
      expect(loadJob("watch")?.policy?.maxTotalUsdMicro).toBe(1_000_000);
      await expect(withJobPaymentLock("watch", async () => undefined)).rejects.toMatchObject({ code: "payment_settling" });
      return send(...args);
    });
    await pay("watch", { budget: "$1.00", rail: "x402" });
    expect(seams.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("rechecks a waiting caller's old budget against the saved approved total", async () => {
    startWatch(dollarPolicy);
    updateJob("watch", { policy: { ...dollarPolicy, maxTotalUsdMicro: 1_000_000, maxTotalMsats: 1_372_702 } });
    await expect(handlePaymentRequest("watch", hourlyAsk(250_000, 343_000), dollarPolicy,
      transport, { endpoint }, { rail: "x402", requestSeq: 40, useStoredPolicy: true })).resolves.toMatchObject({ status: "paid" });
    expect(loadJob("watch")?.paidUsdMicro).toBe(800_000);
  });

  it("does not save or offer a budget raise when budget and payment count are exhausted", async () => {
    const policy = { ...dollarPolicy, maxPayments: 1 };
    startWatch(policy);
    const ask = { ...openAsk(), content: hourlyAsk(250_000, 343_000) };
    pending();
    seams.getMessages.mockResolvedValue([ask]);
    const next = computeNextAction("watch", [ask], undefined, loadJob("watch")!) as { hint: string };
    expect(next.hint).toContain("used its 1-payment limit");
    expect(next.hint).toContain("dvm decline watch");
    expect(next.hint).not.toContain("dvm pay");
    expect(next.hint).not.toContain("--max-payments");
    await expect(pay("watch", { rail: "x402" })).rejects.toMatchObject({ code: "over_budget",
      hint: expect.stringContaining("used its 1-payment limit") });
    await expect(pay("watch", { budget: "$1.00", rail: "x402" })).rejects.toMatchObject({ code: "payment_cap_exceeded",
      hint: expect.not.stringContaining("--max-payments") });
    expect(loadJob("watch")?.policy).toEqual(policy);
    expect(seams.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["new implicit", false, true], ["new explicit", true, false],
    ["older equal cap", undefined, true], ["older lower cap", undefined, false],
  ] as const)("follows the new total only for an implicit increment: %s", async (_name, explicit, pays) => {
    const { maxIncrementExplicit: _recorded, ...older } = dollarPolicy;
    const policy = { ...older, ...(_name === "older lower cap" ? { maxIncrementMsats: 100_000 } : {}), ...(explicit !== undefined ? { maxIncrementExplicit: explicit } : {}) };
    startWatch(policy);
    pending();
    const ask = { ...openAsk(), content: hourlyAsk(800_000, 1_098_000) };
    seams.getMessages.mockResolvedValue([ask]);
    const next = computeNextAction("watch", [ask], undefined, loadJob("watch")!) as { hint: string };
    if (pays) expect(next.hint).toContain("dvm pay watch --budget <new total>");
    else expect(next.hint).toContain("exceeds the job's --max-increment");
    if (pays) {
      await pay("watch", { budget: "$3.00", rail: "x402" });
      expect(loadJob("watch")?.policy).toMatchObject({ maxTotalUsdMicro: 3_000_000,
        maxIncrementMsats: 4_118_107, maxIncrementExplicit: false });
      expect(seams.sendMessage).toHaveBeenCalledTimes(1);
    } else {
      await expect(pay("watch", { budget: "$3.00", rail: "x402" })).rejects.toMatchObject({ code: "over_budget" });
      expect(loadJob("watch")?.policy).toEqual(policy);
      expect(seams.sendMessage).not.toHaveBeenCalled();
    }
  });

  it.each([
    { state: "strict per-call", patch: { strictPerCall: true as const }, code: "strict_per_call_mid_job_payment" },
    { state: "already paid", patch: { paidPaymentRequestSeqs: [40] }, code: "payment_already_sent" },
    { state: "unconfirmed without a copy", patch: { inFlightPaymentRequestSeqs: [40] }, code: "payment_unconfirmed" },
  ])("keeps the old total on a deterministic refusal: $state", async ({ patch, code }) => {
    startWatch(dollarPolicy);
    updateJob("watch", patch);
    pending();
    await expect(pay("watch", { budget: "$1.00", rail: "x402" })).rejects.toMatchObject({ code });
    expect(loadJob("watch")?.policy).toEqual(dollarPolicy);
    expect(seams.sendMessage).not.toHaveBeenCalled();
  });

  it("does not save a proposed total when signing fails before any send", async () => {
    startWatch(dollarPolicy);
    pending();
    seams.tryX402Payment.mockRejectedValueOnce(new DvmError("payment_failed", "Signing unavailable."));
    await expect(pay("watch", { budget: "$1.00", rail: "x402" })).rejects.toMatchObject({ code: "payment_failed" });
    expect(loadJob("watch")?.policy).toEqual(dollarPolicy);
    expect(seams.sendMessage).not.toHaveBeenCalled();
  });

  it("reports a saved total and plain pay retry after a send fails", async () => {
    startWatch(dollarPolicy);
    pending();
    seams.sendMessage.mockRejectedValue(new DvmError("payment_failed", "Provider unavailable."));
    await expect(pay("watch", { budget: "$1.00", rail: "x402" })).rejects.toMatchObject({
      hint: expect.stringContaining("new total budget of $1.00 was saved. Retry with `dvm pay watch`"),
      data: expect.objectContaining({ budget_saved: true, next_action: expect.objectContaining({ type: "pay" }) }),
    });
    expect(loadJob("watch")?.policy?.maxTotalUsdMicro).toBe(1_000_000);
    expect(seams.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each(["$0.55", "754000"])("accepts a total equal to spend (%s), then refuses the unpaid ask without saving", async (budget) => {
    startWatch(dollarPolicy);
    pending();
    await expect(pay("watch", { budget, rail: "x402" })).rejects.toMatchObject({ code: "over_budget" });
    expect(loadJob("watch")?.policy).toEqual(dollarPolicy);
    expect(seams.sendMessage).not.toHaveBeenCalled();
  });

  it("stores a dollar total with an omitted leading zero using the submit representation", async () => {
    saveJob({ id: "watch", endpoint, status: "processing", submittedAt: 1, policy: dollarPolicy });
    pending();
    await pay("watch", { budget: "$.50", rail: "x402" });
    expect(loadJob("watch")?.policy?.maxTotalUsdMicro).toBe(500_000);
  });

  it("refreshes the policy through streamLoop before an attached waiter pays", async () => {
    startWatch(dollarPolicy);
    const raised = { ...dollarPolicy, maxTotalMsats: 1_372_702, maxTotalUsdMicro: 1_000_000 };
    updateJob("watch", { policy: raised });
    seams.getMessages.mockResolvedValueOnce([{ ...openAsk(), seq: 60, content: hourlyAsk(250_000, 343_000) }]).mockResolvedValue([]);
    seams.sendMessage.mockResolvedValue({ seq: 61 });
    const result = await streamLoop({ jobId: "watch", transport: seams as unknown as Transport,
      provider: { endpoint }, policy: dollarPolicy, afterSeq: 0 });
    expect(result.autoPayments).toHaveLength(1);
    expect(loadJob("watch")?.paidUsdMicro).toBe(800_000);
    expect(seams.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("states the current saved cap in an attached waiter's next step", async () => {
    const old = { ...dollarPolicy, autoPayBelowMsats: 0 };
    startWatch(old);
    updateJob("watch", { policy: { ...old, maxTotalMsats: 1_372_702, maxTotalUsdMicro: 1_000_000 } });
    seams.getMessages.mockResolvedValue([{ ...openAsk(), seq: 60, content: hourlyAsk(600_000, 823_000) }]);
    const result = await streamLoop({ jobId: "watch", transport: seams as unknown as Transport,
      provider: { endpoint }, policy: old, afterSeq: 0 });
    expect((result.nextAction as { display: string }).display).toContain("$0.15 over the $1.00 budget");
    expect(seams.sendMessage).not.toHaveBeenCalled();
  });

  it("pays an exact dollar total despite rounding above its implicit sat increment", async () => {
    const policy = buildPolicy({ budget: "$0.75", maxPayments: 1 }, submitRate);
    saveJob({ id: "watch", endpoint, status: "processing", submittedAt: 1, policy });
    pending();
    const ask = { ...openAsk(), content: hourlyAsk(750_000, 1_030_000) };
    seams.getMessages.mockResolvedValue([ask]);
    const next = computeNextAction("watch", [ask], undefined, loadJob("watch")!) as { hint: string };
    expect(next.hint).toContain("then run `dvm pay watch`");
    await pay("watch", { rail: "x402" });
    expect(loadJob("watch")).toMatchObject({ paidUsdMicro: 750_000, totalPaidMsats: 1_030_000, paymentsHonoured: 1 });
    expect(seams.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("reports an insufficient proposed total without saving (prior refusal: %s)", async (priorRefusal) => {
    startWatch(dollarPolicy);
    pending();
    const ask = { ...openAsk(), content: hourlyAsk(250_000, 343_000) };
    seams.getMessages.mockResolvedValue([ask]);
    if (priorRefusal) await expect(pay("watch", { rail: "x402" })).rejects.toMatchObject({ code: "over_budget" });
    const before = loadJob("watch");
    await expect(pay("watch", { budget: "$0.78", rail: "x402" })).rejects.toMatchObject({ code: "over_budget",
      hint: expect.stringContaining("Proposed total $0.78: This charge would take the job past its budget: $0.55 spent so far plus $0.25 asked comes to $0.80, $0.02 over the $0.78 budget."),
      data: expect.objectContaining({ next_action: expect.objectContaining({ type: "pay" }) }),
    });
    expect(loadJob("watch")).toEqual(before);
    expect(seams.sendMessage).not.toHaveBeenCalled();
  });

  it("refreshes the automatic increment check before an attached waiter pays", async () => {
    const old = { ...dollarPolicy, maxTotalMsats: 60_000, maxTotalUsdMicro: 40_000,
      autoPayBelowMsats: 100_000, maxIncrementMsats: 60_000, maxIncrementExplicit: false };
    saveJob({ id: "watch", endpoint, status: "processing", submittedAt: 1, policy: old });
    updateJob("watch", { policy: { ...old, maxTotalMsats: 100_000, maxTotalUsdMicro: 100_000, maxIncrementMsats: 100_000 } });
    seams.getMessages.mockResolvedValueOnce([{ ...openAsk(), seq: 60 }]).mockResolvedValue([]);
    seams.sendMessage.mockResolvedValue({ seq: 61 });
    const result = await streamLoop({ jobId: "watch", transport: seams as unknown as Transport,
      provider: { endpoint }, policy: old, afterSeq: 0 });
    expect(result.autoPayments).toHaveLength(1);
    expect(loadJob("watch")?.paidUsdMicro).toBe(55_000);
    expect(seams.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("streams a payment line when an attached wait pays under a concurrently raised budget", async () => {
    startWatch(dollarPolicy);
    pending();
    const ask = { ...openAsk(), seq: 40, content: hourlyAsk(250_000, 343_000) };
    seams.getMessages.mockResolvedValue([ask]);
    seams.status.mockImplementationOnce(async () => {
      updateJob("watch", { policy: { ...dollarPolicy, maxTotalMsats: 1_372_702, maxTotalUsdMicro: 1_000_000 } });
      return { status: "processing" };
    });
    await messages("watch", { wait: true, until: "1s" });
    const lines = seams.jsonEvent.mock.calls.map(([line]) => line);
    expect(lines.map((line) => line.event)).toEqual(["message", "payment", "message"]);
    expect(lines[1]).toMatchObject({ event: "payment", amount_msats: 343_000, rail: "x402", amount_usdc_microunits: "250000" });
    expect(loadJob("watch")?.paidUsdMicro).toBe(800_000);
    expect(seams.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps the old total when recovering the same signed payment", async () => {
    startWatch(dollarPolicy);
    pending();
    seams.sendMessage.mockRejectedValueOnce(new DvmError("timeout", "Reply lost."));
    await expect(pay("watch", { rail: "x402" })).rejects.toMatchObject({ code: "timeout" });
    const first = seams.sendMessage.mock.calls[0][1];
    updateJob("watch", { inFlightPaymentRequestStartedAtMs: { 40: Date.now() - 60_000 } });
    await pay("watch", { budget: "$1.00", rail: "x402" });
    expect(loadJob("watch")?.policy).toEqual(dollarPolicy);
    expect(seams.sendMessage).toHaveBeenCalledTimes(2);
    expect(seams.sendMessage.mock.calls[1][1]).toEqual(first);
    expect(seams.tryX402Payment).toHaveBeenCalledTimes(1);
  });

  it("keeps unsendable-hold guidance before reporting the saved total", async () => {
    startWatch(dollarPolicy);
    pending();
    seams.sendMessage.mockRejectedValue(new DvmError("request_id_reused", "This payment cannot be taken.", undefined,
      { http_status: 409, code_source: "provider" }));
    await expect(pay("watch", { budget: "$1.00", rail: "x402" })).rejects.toMatchObject({ code: "request_id_reused",
      hint: expect.stringContaining("request id already carries a different payment"),
      data: expect.objectContaining({ budget_saved: true, next_action: expect.objectContaining({ type: "poll",
        hint: expect.stringMatching(/new total budget of \$1\.00 was saved\.$/) }) }),
    });
    expect(loadJob("watch")?.unconfirmedPaymentSubmissions?.[40]?.blocked?.reason).toBe("not_resendable");
    expect(loadJob("watch")?.policy?.maxTotalUsdMicro).toBe(1_000_000);
    expect(seams.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("never accepts a budget override from automatic payment", async () => {
    startWatch(dollarPolicy);
    await expect(handlePaymentRequest("watch", hourlyAsk(50_000, 69_000), dollarPolicy,
      transport, { endpoint }, { requestSeq: 40, budget: "$1.00" })).rejects.toMatchObject({ code: "invalid_budget" });
    expect(loadJob("watch")?.policy).toEqual(dollarPolicy);
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it("does not suggest pay for a charge above the unchanged increment limit", () => {
    startWatch({ ...dollarPolicy, maxIncrementMsats: 60_000 });
    const ask = { ...openAsk(), content: { ...openAsk().content, charged_if_declined_micro: 360_000 } };
    const next = computeNextAction("watch", [ask], undefined, loadJob("watch")!) as { hint: string };
    expect(next.hint).toContain("Declining ends the job and charges $0.36 USD");
    expect(next.hint).toContain("Letting the deadline pass also ends the job");
    expect(next.hint).toContain("exceeds the job's --max-increment");
    expect(next.hint).toContain("dvm decline watch");
    expect(next.hint).not.toContain("dvm pay");
    expect(nextActionHuman(next as ReturnType<typeof computeNextAction>)).toContain("exceeds the job's --max-increment");
  });
});
