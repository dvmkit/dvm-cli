import { afterEach, expect, it, vi } from "vitest";
import { signedRequestDomain, unsignRequestData, type ProviderInfo } from "@dvmkit/sdk/internal";
import { creditTermsWithStandingMandate, mandateExpiryMs, prepareStandingMandate, resolveMandateExpiry, standingMandateOutput, signJobData, standingMandateRecord, setMandateUpfront, type PreparedStandingMandate } from "../standing-mandate";

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
    ask: 550_000, expiry: () => Date.now() + 86_400_000, maxPayments: 5 };
  const wire = signJobData({ privkey, domain, standingMandate }, { input: "watch" });
  expect(unsignRequestData(wire)?.body).toEqual({ input: "watch" });
});

it.each([{ budget: "$1" }, { autoPayBelow: "$0.50" }])("requires both explicit consent flags: %j", async (opts) => {
  expect(await prepareStandingMandate(opts, provider, 100_000, 5)).toBeUndefined();
});

it("skips the mandate without refusing an unknown upfront price", () => {
  const standingMandate: PreparedStandingMandate = { currency: "usd", supported: true, total: 10_000_000,
    ask: 200_000, expiry: () => Date.now() + 86_400_000, maxPayments: 2 };
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
      ask: 200_000, expiry: () => Date.now() + 86_400_000, maxPayments: count, upfront };
    const wire = signJobData({ privkey, domain, standingMandate }, { credit_id: "credit", draw_id: "draw" });
    expect(unsignRequestData(wire)?.body.mandate).toMatchObject({ max_total_micro: total });
});

it.each([{ upfront: 100_000, count: 1 }, { upfront: 0, count: 0 }])(
  "sends no mandate when the payer allows no later charge: %j", ({ upfront, count }) => {
    const standingMandate: PreparedStandingMandate = { currency: "usd", supported: true, total: 1_100_000,
      ask: 200_000, expiry: () => Date.now() + 86_400_000, maxPayments: count, upfront };
    const wire = signJobData({ privkey, domain, standingMandate }, { credit_id: "credit", draw_id: "draw" });
    expect(unsignRequestData(wire)?.body.mandate).toBeUndefined();
    expect(standingMandateRecord({ input: "watch", data: wire }, standingMandate).mandateUnavailable).toContain("--max-payments");
});

it("treats an approximate quote as unknown rather than inflating its upfront", () => {
  const standingMandate: PreparedStandingMandate = { currency: "usd", supported: true, total: 1_100_000,
    ask: 200_000, expiry: () => Date.now() + 86_400_000, maxPayments: 2, upfront: 10 };
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

const now = Date.parse("2026-01-01T00:00:00Z");
it.each([
  [undefined, "2026-01-02T00:00:00Z"],
  ["2h", "2026-01-01T02:00:00Z"],
  ["15d", "2026-01-16T00:00:00Z"],
  ["6w", "2026-02-12T00:00:00Z"],
  ["400d", "2027-02-05T00:00:00Z"],
  ["2026-02-01", "2026-02-01T00:00:00Z"],
  ["2026-02-01T04:35:00+02:00", "2026-02-01T02:35:00Z"],
])("resolves %s to the requested absolute expiry", (input, expected) => {
  expect(mandateExpiryMs(input, now)).toBe(Date.parse(expected));
});

it.each(["0s", "-2h", "Friday", "2026", "2026-02-30", "2026-02-01T04:35:00", "2025-12-31", "999999999999999w", ""])(
  "rejects invalid or past mandate end %j", (input) => {
    expect(() => mandateExpiryMs(input, now)).toThrow(expect.objectContaining({ code: "invalid_arguments" }));
  });

function advertisedProvider(limit?: number | null): ProviderInfo {
  const credit = creditTermsWithStandingMandate({
    currency: "usd", standing_mandate: true, min_micro: 1, max_micro: 1_000_000, ttl_ms: 86_400_000,
    funding: [], ...(limit === undefined ? {} : { mandate_max_duration: limit }),
  });
  return { credit } as ProviderInfo;
}

it("keeps the historical ceiling and skew margin when the limit is absent", () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const opts = { budget: "$1", autoPayBelow: "$0.20" };
  expect(() => resolveMandateExpiry({ ...opts, mandateUntil: "14d" }, advertisedProvider())).toThrow(
    expect.objectContaining({ code: "mandate_duration_unsupported", display: "The DVM accepts standing limits up to 7 days." }),
  );
  expect(resolveMandateExpiry({ ...opts, mandateUntil: "7d" }, advertisedProvider())).toBe(Date.parse("2026-01-07T23:55:00Z"));
});

it("signs the full absolute expiry when the provider explicitly advertises no ceiling", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const standingMandate = await prepareStandingMandate(
    { budget: "$1", autoPayBelow: "$0.20", mandateUntil: "2026-01-15T03:00:00Z" }, advertisedProvider(null), 100_000, 6,
  );
  const wire = signJobData({ privkey, domain, standingMandate }, { credit_id: "credit", draw_id: "draw" });
  expect(unsignRequestData(wire)?.body.mandate).toMatchObject({ expires_at_ms: Date.parse("2026-01-15T03:00:00Z") });
});

it("enforces a numeric bound advertised by the provider", () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const opts = { budget: "$1", autoPayBelow: "$0.20", mandateUntil: "14d" };
  expect(() => resolveMandateExpiry(opts, advertisedProvider(1_123_200_000))).toThrow(
    expect.objectContaining({ display: "The DVM accepts standing limits up to 13d." }),
  );
  expect(resolveMandateExpiry(opts, advertisedProvider(1_296_000_000))).toBe(Date.parse("2026-01-15T00:00:00Z"));
});

it("preserves the approved expiry inside the provider limit even near the skew margin", () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const expiry = "2026-01-01T00:59:59.999Z";
  expect(resolveMandateExpiry({ mandateUntil: expiry, mandatePreview: "approval" }, advertisedProvider(3_600_000)))
    .toBe(Date.parse(expiry));
});

it("shows the signed total at its full precision in the credit's currency", () => {
  const standingMandate: PreparedStandingMandate = { currency: "eur", supported: true, total: 1_100_000,
    ask: 200_001, expiry: () => Date.parse("2026-01-15T03:00:00.999Z"), maxPayments: 2, upfront: 100_000 };
  const wire = signJobData({ privkey, domain, standingMandate }, { credit_id: "credit", draw_id: "draw" });
  const output = standingMandateOutput(standingMandateRecord({ input: "watch", data: wire }, standingMandate));
  expect(output.mandate).toMatchObject({
    max_total: { amount_micro: 300_001, currency: "eur", display: "€0.300001 EUR" },
    expires_at: "2026-01-15T03:00:00.999Z",
    display: expect.stringContaining("can charge at most €0.300001 EUR until 2026-01-15T03:00:00.999Z"),
  });
});
