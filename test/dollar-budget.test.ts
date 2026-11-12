import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JOBS_FILE, type PaymentRequestContent, type Transport } from "@dvmkit/sdk/internal";

// The rate that turned "$0.75" into the 1,029,527 msats a real watch saved,
// beside an auto-pay threshold of "$0.60" (823,621 msats). It is also the
// caller's rate when each ask arrives.
const submitRate = vi.hoisted(() => 72_849);
const seams = vi.hoisted(() => ({
  enforceGlobalBudget: vi.fn(), recordSpend: vi.fn(), tryX402Payment: vi.fn(), loadX402Wallet: vi.fn(),
  status: vi.fn(), getMessages: vi.fn(), sendMessage: vi.fn(), close: vi.fn(),
}));
vi.mock("../src/lib/transport", () => ({ createDvmTransport: () => seams }));
vi.mock("@dvmkit/sdk/internal", async (original) => ({
  ...await original<typeof import("@dvmkit/sdk/internal")>(), loadAgentWallet: () => null,
  getLastKnownBtcRate: () => ({ rate: submitRate, cachedAt: Date.now() }),
}));
vi.mock("../src/lib/btc-rate", async (original) => ({
  ...await original<typeof import("../src/lib/btc-rate")>(),
  tryResolveBtcUsdRate: async () => ({ rate: submitRate, stale: false }),
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
import { pay } from "../src/commands/pay";

const endpoint = "https://provider.example";
const dollarPolicy = buildPolicy({ budget: "$0.75", autoPayBelow: "$0.60", maxPayments: 8 }, submitRate);
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
    expect(next.hint).not.toContain("then run `dvm pay");
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
      "473 msats over the 1,029,527 msats budget (your $0.75 budget, converted to sats when the job started).");
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
