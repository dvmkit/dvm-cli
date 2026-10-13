vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()) }));
vi.mock("../output", async () => ({ ...(await vi.importActual<typeof import("../output")>("../output")), info: vi.fn(),
progress: vi.fn() }));
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { type Nip47Stub, startNip47Stub } from "../../test-support/nip47-stub";
import { DvmError } from "@dvmkit/sdk/internal";
import {
  emitFloatBudgetWarning,
  floatBudgetJson,
  floatPaymentJson,
  parseStatedBudget,
  payViaFloat,
  probeFloat,
  toFloatError,
} from "../float";
import { NwcError, parseNwcUri } from "@dvmkit/sdk/internal";
import * as output from "../output";

let stub: Nip47Stub | undefined;

afterEach(async () => {
  await stub?.close();
  stub = undefined;
  vi.restoreAllMocks();
});

async function connect(...args: Parameters<typeof startNip47Stub>) {
  stub = await startNip47Stub(...args);
  return { stub, float: { conn: parseNwcUri(stub.uri), connectedAt: "" } };
}

describe("toFloatError", () => {
  const cases: [string, string][] = [
    ["QUOTA_EXCEEDED", "float_quota_exceeded"],
    ["INSUFFICIENT_BALANCE", "float_insufficient_balance"],
    ["UNAUTHORIZED", "float_unauthorized"],
    ["RESTRICTED", "float_connection_restricted"],
    ["RATE_LIMITED", "float_rate_limited"],
    ["NOT_IMPLEMENTED", "float_method_unsupported"],
    ["PAYMENT_FAILED", "float_payment_failed"],
    ["payment_unknown", "float_payment_unknown"],
    ["timeout", "float_wallet_offline"],
    ["relay_unreachable", "float_relay_unreachable"],
    ["publish_rejected", "float_relay_unreachable"],
    ["invalid_uri", "float_invalid_uri"],
    ["SOMETHING_NEW", "float_wallet_error"],
  ];

  it.each(cases)("maps %s to %s", (walletCode, dvmCode) => {
    const err = toFloatError(new NwcError(walletCode, "boom"));
    expect(err).toBeInstanceOf(DvmError);
    expect(err.code).toBe(dvmCode);
    const display = err.data?.display;
    expect(typeof display, walletCode).toBe("string");
    expect((display as string).length, walletCode).toBeGreaterThan(20);
    expect(err.hint, walletCode).toBeTruthy();
  });

  it("says plainly that nothing was charged, except when that isn't known", () => {
    // The one case where we must not claim it: a lost response could mean the
    // money moved. Telling a user "nothing was charged" there would be a lie
    // that costs them a double payment when they retry.
    expect(toFloatError(new NwcError("QUOTA_EXCEEDED", "x")).data?.display).toContain(
      "Nothing was charged"
    );
    expect(toFloatError(new NwcError("payment_unknown", "x")).data?.display).not.toContain(
      "Nothing was charged"
    );
  });

  it("reserves float_method_unsupported for a wallet that cannot perform the operation", () => {
    const err = toFloatError(new NwcError("NOT_IMPLEMENTED", "pay_invoice is unavailable"));

    expect(err.code).toBe("float_method_unsupported");
    expect(err.data?.next_step).toContain("Switch to a wallet");
    expect(err.data).not.toHaveProperty("advertised_methods");
  });

  it("preserves an unrecognised wallet code for debugging", () => {
    expect(toFloatError(new NwcError("WEIRD", "x")).data?.wallet_error_code).toBe("WEIRD");
  });

  it("surfaces the wallet's own PAYMENT_FAILED reason instead of an unconditional retry", () => {

    const reason = "no route found: 30000 msats is below this node's 50000-msat routing floor";
    const err = toFloatError(new NwcError("PAYMENT_FAILED", reason));
    expect(err.message).toContain(reason);
    expect(err.data?.display).toContain(reason);
    expect(err.data?.wallet_message).toBe(reason);
    expect(err.hint).not.toMatch(/^Retry —/);
    expect(err.hint).toContain("dvm wallet fund");
  });

  it("relays a routing-floor failure end to end through payViaFloat", async () => {
    const { float } = await connect({ routingFloorMsats: 50_000 });
    // The stub's HRP-encoded 30-sat invoice sits under the 50-sat floor.
    const invoice = "lnbcrt300n1stub";
    await expect(
      payViaFloat({ bolt11: invoice, amountMsats: 30_000, float })
    ).rejects.toMatchObject({
      code: "float_payment_failed",
      data: expect.objectContaining({
        wallet_message: expect.stringContaining("routing floor") as string,
      }) as Record<string, unknown>,
    });
    expect(stub?.payments.length).toBe(0);
  });

  it("tells a revoked connection apart from a restricted one", () => {
    const revoked = toFloatError(new NwcError("UNAUTHORIZED", "no wallet connected", "get_info"));
    const restricted = toFloatError(
      new NwcError("RESTRICTED", "not permitted to call get_info", "get_info")
    );

    expect(revoked.code).toBe("float_unauthorized");
    expect(restricted.code).toBe("float_connection_restricted");

    expect(restricted.message).not.toBe(revoked.message);
    expect(restricted.hint).not.toBe(revoked.hint);
    expect(restricted.data?.display).not.toBe(revoked.data?.display);
    expect(restricted.data?.next_step).not.toBe(revoked.data?.next_step);
  });

  it("keeps today's revoked-connection copy on UNAUTHORIZED", () => {
    const err = toFloatError(new NwcError("UNAUTHORIZED", "boom", "pay_invoice"));
    expect(err.message).toBe("The Lightning wallet rejected this connection.");
    expect(err.hint).toContain("revoked or expired");
    expect(err.data?.display).toContain("revoked or expired");
    expect(err.data?.next_step).toBe(
      "Create a new connection in your wallet app and reconnect it."
    );
  });

  it("names the refused method on both rejections", () => {
    expect(toFloatError(new NwcError("UNAUTHORIZED", "x", "get_info")).data?.method).toBe(
      "get_info"
    );
    expect(toFloatError(new NwcError("RESTRICTED", "x", "pay_invoice")).data?.method).toBe(
      "pay_invoice"
    );

    expect(toFloatError(new NwcError("timeout", "x")).data?.method).toBeUndefined();
  });

  it("sends a restricted connection to the permission, not to a new connection", () => {
    const err = toFloatError(
      new NwcError("RESTRICTED", "This connection may not pay invoices.", "pay_invoice")
    );
    expect(err.data?.restriction).toBe("permission");
    expect(err.message).toContain("pay_invoice");

    expect(err.data?.next_step).toContain("send payments");
    expect(err.hint).toContain("recreating it changes nothing");
    expect(err.data?.wallet_message).toBe("This connection may not pay invoices.");
  });

  it("sends a restricted-on-a-cap connection to the cap instead", () => {
    // NIP-47 gives one code to two wallet settings. "Grant the permission" is
    // as wrong for a crossed budget as "make a new connection" is for either.
    const err = toFloatError(
      new NwcError("RESTRICTED", "monthly budget of 50000 sats exceeded", "pay_invoice")
    );
    expect(err.code).toBe("float_connection_restricted");
    expect(err.data?.restriction).toBe("budget");
    expect(err.hint).toContain("spending limit");
    expect(err.data?.next_step).toContain("raise its spending limit");
    expect(err.data?.next_step).not.toContain("permission");
  });

  // Wallets write this refusal a dozen ways. The cap-vs-permission read is a
  // heuristic over the wallet's own words, so the words it accepts are part of
  // the contract — plurals included.
  it.each([
    "spending limits exceeded for this connection",
    "daily quotas reached",
    "budgets are set on this app connection",
    "connection is capped at 1000 sats",
  ])("reads a cap out of %j", (message) => {
    const err = toFloatError(new NwcError("RESTRICTED", message, "pay_invoice"));
    expect(err.data?.restriction).toBe("budget");
  });

  it("does not read a cap out of wording that only sounds like one", () => {
    // `cap\w*` would take this one and hand back the wrong remedy.
    const err = toFloatError(
      new NwcError("RESTRICTED", "this connection is not capable of paying invoices", "pay_invoice")
    );
    expect(err.data?.restriction).toBe("permission");
  });

  it("passes a DvmError through untouched", () => {
    const original = new DvmError("budget_exceeded", "nope");
    expect(toFloatError(original)).toBe(original);
  });
});

describe("parseStatedBudget", () => {
  it("keeps what the user typed, verbatim", () => {
    expect(parseStatedBudget("$20/month")).toEqual({
      raw: "$20/month",
      period: "month",
      display: "$20/month",
    });
  });

  it("accepts an amount with no period", () => {
    expect(parseStatedBudget("50000 sats")).toMatchObject({ raw: "50000 sats" });
  });

  it.each([["daily", "day"], ["weekly", "week"], ["monthly", "month"], ["yearly", "year"], ["day", "day"], ["week", "week"], ["month", "month"], ["year", "year"]])(
    "recognises the %s renewal period",
    (period, canonical) => {
      expect(parseStatedBudget(`$5/${period}`).period).toBe(canonical);
    }
  );

  it("rejects an unknown period with an actionable hint", () => {
    expect(() => parseStatedBudget("$5/fortnight")).toThrow(DvmError);
  });

  it("rejects an empty budget", () => {
    expect(() => parseStatedBudget("  ")).toThrow(DvmError);
  });
});

describe("floatBudgetJson", () => {
  it("labels the stated budget as the user's own claim", () => {
    const json = floatBudgetJson({ statedBudget: "$20/month" });
    expect(json.stated).toBe("$20/month");
    expect(json.source).toBe("user_stated");
    expect(Object.keys(json)).not.toContain("remaining");
    expect(JSON.stringify(json)).not.toMatch(/remaining/i);
    expect(json.routing_fee_inclusion).toBe("unknown");
    expect(json.hint).toContain("routing-fee ceiling");
    expect(json.hint).toContain("does not know whether");
  });

  it("attributes volunteered wallet fields rather than passing them off as ours", () => {
    const json = floatBudgetJson({ statedBudget: "$5" }, { budget_renewal: "monthly" });
    expect(json.wallet_reported).toMatchObject({ _source: "wallet", budget_renewal: "monthly" });
  });

  it("tells the user how to record a budget when none is set", () => {
    expect(String(floatBudgetJson({}).display)).toContain("No wallet budget recorded");
  });
});

describe("emitFloatBudgetWarning", () => {
  it("emits a structured pre-payment warning for the primary JSON path", () => {
    const progress = vi.spyOn(output, "progress").mockImplementation(() => undefined);
    const info = vi.spyOn(output, "info").mockImplementation(() => undefined);

    emitFloatBudgetWarning({
      float: {},
      operation: "pocket_refill",
      principalMsats: 115_000,
    });

    expect(progress).toHaveBeenCalledWith({
      event: "warning",
      code: "float_budget_unstated",
      operation: "pocket_refill",
      principal_sats: 115,
      routing_fee_ceiling_sats: null,
      routing_fee_inclusion: "unknown",
      display: expect.stringContaining("No wallet-side spending policy"),
      hint: expect.stringContaining("confirm whether it counts routing fees"),
    });
    expect(info).not.toHaveBeenCalled();
  });

  it("retains relayable prose in human mode and stays quiet for a recorded policy", () => {
    const progress = vi.spyOn(output, "progress").mockImplementation(() => undefined);
    const info = vi.spyOn(output, "info").mockImplementation(() => undefined);

    emitFloatBudgetWarning({
      float: {},
      operation: "credit_funding",
      principalMsats: 100_000,
      human: true,
    });
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("Lightning credit funding warning: No wallet-side spending policy")
    );
    expect(progress).not.toHaveBeenCalled();

    info.mockClear();
    emitFloatBudgetWarning({
      float: { statedBudget: "$20/month" },
      operation: "credit_funding",
      principalMsats: 100_000,
    });
    expect(info).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  });
});

describe("probeFloat", () => {
  it("reports capabilities and balance from one round trip", async () => {
    const { float } = await connect({ alias: "Probe Hub", balanceMsats: 12_345 });

    const probe = await probeFloat({ float, timeoutMs: 4000 });

    expect(probe).toMatchObject({
      reachable: true,
      alias: "Probe Hub",
      canPay: true,
      canReconcile: true,
      balanceMsats: 12_345,
    });
  });

  it("flags a connection that cannot pay, however healthy it looks", async () => {
    const { float } = await connect({ methods: ["get_info", "get_balance"] });

    const probe = await probeFloat({ float, timeoutMs: 4000 });

    expect(probe.reachable).toBe(true);
    expect(probe.canPay).toBe(false);
  });

  it("flags a connection that cannot reconcile a lost payment", async () => {
    const { float } = await connect({ methods: ["get_info", "get_balance", "pay_invoice"] });

    const probe = await probeFloat({ float, timeoutMs: 4000 });

    expect(probe.canPay).toBe(true);
    expect(probe.canReconcile).toBe(false);
  });

  it("leaves the balance undefined rather than zero when it can't be read", async () => {
    // A connection without get_balance permission is still a working float.
    // Zero here would render as "Lightning: 0 sats" for a funded wallet.
    const { float } = await connect({ methods: ["get_info", "pay_invoice", "lookup_invoice"] });

    const probe = await probeFloat({ float, timeoutMs: 4000 });

    expect(probe.reachable).toBe(true);
    expect(probe.canPay).toBe(true);
    expect(probe.balanceMsats).toBeUndefined();
  });

  it("relays volunteered budget fields without inventing any", async () => {
    const withFields = await connect({ volunteerBudgetFields: { budget_renewal: "monthly" } });
    expect(
      (await probeFloat({ float: withFields.float, timeoutMs: 4000 })).walletReportedBudget
    ).toEqual({ budget_renewal: "monthly" });

    await stub?.close();
    const without = await connect({});
    expect(
      (await probeFloat({ float: without.float, timeoutMs: 4000 })).walletReportedBudget
    ).toBeUndefined();
  });

  it("carries a restricted refusal, and the method refused, off the wire", async () => {

    const { float } = await connect({ restrictedMethods: ["get_info"] });

    const probe = await probeFloat({ float, timeoutMs: 4000 });

    expect(probe.reachable).toBe(false);
    expect(probe.error?.code).toBe("float_connection_restricted");
    expect(probe.error?.hint).toContain("recreating it changes nothing");
    expect(probe.error?.data).toMatchObject({
      method: "get_info",
      restriction: "permission",
      next_step: expect.stringContaining("read the wallet's details") as string,
    });
  });

  it("carries a revoked connection off the wire as float_unauthorized", async () => {
    const { float } = await connect({ unauthorized: true });

    const probe = await probeFloat({ float, timeoutMs: 4000 });

    expect(probe.reachable).toBe(false);
    expect(probe.error?.code).toBe("float_unauthorized");
    expect(probe.error?.data).toMatchObject({ method: "get_info" });
  });

  it("reports an unreachable wallet instead of throwing", async () => {

    const { stub: s, float } = await connect({});
    s.setFault({ mode: "offline" });

    const probe = await probeFloat({ float, timeoutMs: 600 });

    expect(probe.reachable).toBe(false);
    expect(probe.error?.code).toBe("float_wallet_offline");
    expect(probe.error?.display).toBeTruthy();
  });
});

describe("payViaFloat", () => {
  it("reports principal and routing fee without inventing an unproven wallet debit", async () => {
    const { float } = await connect({ routingFeeMsats: 5_000 });

    const payment = await payViaFloat({
      bolt11: "lnbc100n1pjfee",
      amountMsats: 10_000,
      float,
      timeoutMs: 4000,
    });

    expect(floatPaymentJson(payment)).toEqual({
      outcome: "paid",
      principal_sats: 10,
      routing_fee_sats: 5,
      total_wallet_fee_sats: null,
      unitemized_wallet_fee_sats: null,
      wallet_debit_sats: null,
    });
    expect(JSON.stringify(payment)).not.toContain("preimage");
  });

  it("names pay_invoice when the wallet refuses the payment itself", async () => {

    const { float } = await connect({ restrictedMethods: ["pay_invoice"] });

    await expect(
      payViaFloat({ bolt11: "lnbc100n1pjrestricted", amountMsats: 10_000, float, timeoutMs: 4000 })
    ).rejects.toMatchObject({
      code: "float_connection_restricted",
      data: expect.objectContaining({
        method: "pay_invoice",
        restriction: "permission",
        next_step: expect.stringContaining("send payments") as string,
      }) as Record<string, unknown>,
    });
  });

  it("reports an unknown fee and debit when the wallet omits fees_paid", async () => {
    const { float } = await connect({ omitFeesPaid: true });

    const payment = await payViaFloat({
      bolt11: "lnbc100n1pjunknownfee",
      amountMsats: 10_000,
      float,
      timeoutMs: 4000,
    });

    expect(floatPaymentJson(payment)).toMatchObject({
      principal_sats: 10,
      routing_fee_sats: null,
      wallet_debit_sats: null,
    });
  });

  it("maps a wallet budget refusal into the relayable taxonomy", async () => {
    const { float } = await connect({ budgetMsats: 1_000 });

    const err = await payViaFloat({
      bolt11: "lnbc100n1pjbudget",
      amountMsats: 10_000,
      float,
      timeoutMs: 4000,
    }).catch((e: unknown) => e as DvmError);

    expect(err).toBeInstanceOf(DvmError);
    expect((err as DvmError).code).toBe("float_quota_exceeded");
    expect((err as DvmError).data?.display).toContain("spending limit");
  });
});
