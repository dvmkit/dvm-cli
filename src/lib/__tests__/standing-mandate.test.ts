import { afterEach, expect, it, vi } from "vitest";
import { signedRequestDomain, unsignRequestData, type ProviderInfo } from "@dvmkit/sdk/internal";
import { prepareStandingMandate, signJobData, standingMandateRecord, setMandateUpfront, type PreparedStandingMandate } from "../standing-mandate";

vi.mock("../btc-rate", () => ({ tryResolveBtcUsdRate: async () => ({ rate: 100_000 }) }));
const provider = { credit: { currency: "eur", standing_mandate: true } } as unknown as ProviderInfo;
const domain = signedRequestDomain({ provider: { auth: ["secp256k1-schnorr-v2"],
  authAudience: { dvm_id: "test", builder_pubkey: "11".repeat(32) } } as ProviderInfo,
  endpoint: "https://provider.example", method: "POST", path: "v1/job", capability: "run" });
const privkey = "0d".repeat(32);
afterEach(() => vi.unstubAllGlobals());

it("converts mixed dollar and millisat limits into the credit's non-USD currency", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ bitcoin: { usd: 100_000, eur: 90_000 } })));
  const standingMandate = await prepareStandingMandate({ budget: "$1.10", autoPayBelow: "$0.55", maxIncrement: "200000" }, provider, 100_000, 5);
  setMandateUpfront(standingMandate, { upfront: { amount: 0.09, amount_micro: 90_000, currency: "eur" } } as import("@dvmkit/sdk/internal").Quote);
  const wire = signJobData({ privkey, domain, standingMandate }, { credit_id: "credit", draw_id: "draw" });
  expect(unsignRequestData(wire)?.body.mandate).toMatchObject({ max_total_micro: 810_000, max_ask_micro: 180_000 });
});

it("adds no mandate to a signed body without a credit binding", () => {
  const standingMandate: PreparedStandingMandate = { currency: "usd", supported: true, total: 1_100_000,
    ask: 550_000, durationMs: 86_400_000, maxPayments: 5 };
  const wire = signJobData({ privkey, domain, standingMandate }, { input: "watch" });
  expect(unsignRequestData(wire)?.body).toEqual({ input: "watch" });
});

it.each([{ budget: "$1" }, { autoPayBelow: "$0.50" }])("requires both explicit consent flags: %j", async (opts) => {
  expect(await prepareStandingMandate(opts, provider, 100_000, 5)).toBeUndefined();
});

it("skips the mandate without refusing an unknown upfront price", () => {
  const standingMandate: PreparedStandingMandate = { currency: "usd", supported: true, total: 10_000_000,
    ask: 200_000, durationMs: 86_400_000, maxPayments: 2 };
  const wire = signJobData({ privkey, domain, standingMandate }, { credit_id: "credit", draw_id: "draw" });
  expect(unsignRequestData(wire)?.body.mandate).toBeUndefined();
  expect(standingMandateRecord({ input: "watch", data: wire }, standingMandate)).toMatchObject({
    mandateUnavailable: expect.stringContaining("upfront price was unknown") });
});

it.each([{ budget: "1001", autoPayBelow: "1009", expected: 950 },
  { budget: "2000", autoPayBelow: "1009", expected: 1900, ask: 958 },
  { budget: "$1.0000009", autoPayBelow: "$1.0000009", expected: 1_000_000 }])(
  "floors every converted micro-unit limit: $budget", async ({ budget, autoPayBelow, expected, ask }) => {
    const standingMandate = await prepareStandingMandate({ budget, autoPayBelow },
      { credit: { currency: "usd", standing_mandate: true } } as unknown as ProviderInfo, 95_000, 5);
    const wire = signJobData({ privkey, domain, standingMandate }, { credit_id: "credit", draw_id: "draw" });
    expect(unsignRequestData(wire)?.body.mandate).toMatchObject({ max_total_micro: expected, max_ask_micro: ask ?? expected });
});

it.each([{ upfront: 100_000, count: 2, total: 300_000 }, { upfront: 0, count: 2, total: 400_000 }])(
  "matches the payer's count when upfront is $upfront", ({ upfront, count, total }) => {
    const standingMandate: PreparedStandingMandate = { currency: "usd", supported: true, total: 1_100_000,
      ask: 200_000, durationMs: 86_400_000, maxPayments: count, upfront };
    const wire = signJobData({ privkey, domain, standingMandate }, { credit_id: "credit", draw_id: "draw" });
    expect(unsignRequestData(wire)?.body.mandate).toMatchObject({ max_total_micro: total });
});

it.each([{ upfront: 100_000, count: 1 }, { upfront: 0, count: 0 }])(
  "sends no mandate when the payer allows no later charge: %j", ({ upfront, count }) => {
    const standingMandate: PreparedStandingMandate = { currency: "usd", supported: true, total: 1_100_000,
      ask: 200_000, durationMs: 86_400_000, maxPayments: count, upfront };
    const wire = signJobData({ privkey, domain, standingMandate }, { credit_id: "credit", draw_id: "draw" });
    expect(unsignRequestData(wire)?.body.mandate).toBeUndefined();
    expect(standingMandateRecord({ input: "watch", data: wire }, standingMandate).mandateUnavailable).toContain("--max-payments");
});

it("treats an approximate quote as unknown rather than inflating its upfront", () => {
  const standingMandate: PreparedStandingMandate = { currency: "usd", supported: true, total: 1_100_000,
    ask: 200_000, durationMs: 86_400_000, maxPayments: 2, upfront: 10 };
  setMandateUpfront(standingMandate, { upfront: { currency: "usd", amount: 0.1000009 } } as import("@dvmkit/sdk/internal").Quote);
  const wire = signJobData({ privkey, domain, standingMandate }, { credit_id: "credit", draw_id: "draw" });
  expect(unsignRequestData(wire)?.body.mandate).toBeUndefined();
  expect(standingMandateRecord({ input: "watch", data: wire }, standingMandate).mandateUnavailable).toContain("price was unknown");
});

it("withholds authority without failing a credit request when its FX lookup fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("FX unavailable"); }));
  const standingMandate = await prepareStandingMandate({ budget: "$1", autoPayBelow: "$0.20" },
    { credit: { currency: "gbp", standing_mandate: true } } as unknown as ProviderInfo, 100_000, 5);
  const wire = signJobData({ privkey, domain, standingMandate }, { credit_id: "credit", draw_id: "draw" });
  expect(unsignRequestData(wire)?.body.mandate).toBeUndefined();
  expect(standingMandateRecord({ input: "watch", data: wire }, standingMandate).mandateUnavailable).toContain("local exchange rate");
});

it("withholds authority without failing a credit request at a zero auto-pay threshold", async () => {
  const standingMandate = await prepareStandingMandate({ budget: "$1", autoPayBelow: "0" },
    { credit: { currency: "usd", standing_mandate: true } } as unknown as ProviderInfo, 100_000, 5);
  const wire = signJobData({ privkey, domain, standingMandate }, { credit_id: "credit", draw_id: "draw" });
  expect(unsignRequestData(wire)?.body.mandate).toBeUndefined();
  expect(standingMandateRecord({ input: "watch", data: wire }, standingMandate).mandateUnavailable).toContain("positive charge");
});
