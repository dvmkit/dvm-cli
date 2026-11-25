import { Challenge, Credential } from "mppx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  fetch: vi.fn(),
  recordSpend: vi.fn(),
  recordSpendOnce: vi.fn(() => true),
  json: vi.fn(),
  info: vi.fn(),
}));
vi.mock("../src/lib/http", () => ({ dvmFetch: seams.fetch }));
vi.mock("../src/lib/budget-ledger", async (original) => ({
  ...(await original<typeof import("../src/lib/budget-ledger")>()),
  recordSpend: seams.recordSpend,
  recordSpendOnce: seams.recordSpendOnce,
}));
vi.mock("../src/lib/output", async (original) => ({
  ...(await original<typeof import("../src/lib/output")>()),
  json: seams.json,
  info: seams.info,
}));
vi.mock("@dvmkit/sdk/internal", async (original) => ({
  ...(await original<typeof import("@dvmkit/sdk/internal")>()),
  tempoCredentialAmountMicro: () => 10_000n,
}));

import { PAID_SUBMIT_FLOOR_MS, payWithTempo } from "../src/commands/request";
import { HttpsTransport } from "../src/lib/transport/https";
import { sendTempoCredential } from "../src/lib/payment-rails/tempo-broadcast";
import { DvmError, type JobEnvelope, type ProviderRef } from "@dvmkit/sdk/internal";

const ref = { endpoint: "https://dvm.example" } as ProviderRef;
const envelope = { input: "hello", capability: "echo" } as JobEnvelope;
const challenge = Challenge.from({
  id: "challenge-1", realm: "dvm.example", method: "tempo", intent: "charge", request: { amount: "10000" },
});
const credential = Credential.from({
  challenge,
  payload: { type: "transaction", signature: "0xsigned" },
});
const signedHeader = Credential.serialize(credential);

const refusal = (reason: string | undefined, retryable?: boolean, retryAfterMs?: number) =>
  new Response(JSON.stringify({
    error: "payment_invalid", rail: reason ? "tempo" : undefined, reason, retryable, retry_after_ms: retryAfterMs,
    display: "Provider prose.", hint: "Provider hint.",
  }), { status: 402, headers: {
    "Content-Type": "application/json",
    "WWW-Authenticate": Challenge.serialize({ ...challenge, id: "fresh-challenge" }),
  } });
const accepted = () => new Response(JSON.stringify({ job_id: "job-1", status: "processing" }), { status: 202 });
const sentHeaders = () => seams.fetch.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>);
const sentBodies = () => seams.fetch.mock.calls.map(([, init]) => (init as RequestInit).body);

beforeEach(() => seams.fetch.mockReset());
afterEach(() => vi.useRealTimers());

describe("upfront Tempo broadcast refusals", () => {
  it("resends a not_broadcast refusal once with the byte-identical credential and body", async () => {
    seams.fetch.mockResolvedValueOnce(refusal("not_broadcast", true)).mockResolvedValueOnce(accepted());
    const transport = new HttpsTransport();
    const receipt = await sendTempoCredential(() => transport.submit(ref, envelope, { mppCredential: credential }));
    expect(receipt).toMatchObject({ jobId: "job-1", status: "processing" });
    expect(seams.fetch).toHaveBeenCalledTimes(2);
    const [first, second] = sentHeaders();
    expect(first.Authorization).toBe(signedHeader);
    expect(second.Authorization).toBe(first.Authorization);
    expect(sentBodies()[1]).toBe(sentBodies()[0]);
  });

  it("does not resend a reason-less refusal or a non-retryable not_broadcast", async () => {
    for (const body of [refusal(undefined), refusal("not_broadcast", false)]) {
      seams.fetch.mockReset().mockResolvedValueOnce(body);
      const transport = new HttpsTransport();
      await expect(sendTempoCredential(() => transport.submit(ref, envelope, { mppCredential: credential })))
        .rejects.toMatchObject({ code: "payment_invalid" });
      expect(seams.fetch).toHaveBeenCalledTimes(1);
    }
  });

  const pay = (deadlineMs = Date.now() + 60_000) => payWithTempo({
    transport: new HttpsTransport(), ref, envelope, jobId: "", deadlineMs,
    chosen: { priceMsats: 10_000 }, quotes: [], opts: {}, identity: { dvmId: "dvm-1", capability: "echo" },
    policy: {}, btcRate: 100_000,
    account: { address: "0x0000000000000000000000000000000000000001", privateKey: "0x01" },
    providerInfo: {},
  } as never, credential);

  it("waits for settlement and books one accepted spend using the original HTTP bytes", async () => {
    vi.useFakeTimers();
    seams.fetch.mockResolvedValueOnce(refusal("settlement_unconfirmed", true, 750))
      .mockResolvedValueOnce(new Response(JSON.stringify({ job_id: "job-1", summary: "Done" })));
    const result = expect(pay()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(749);
    expect(seams.fetch).toHaveBeenCalledTimes(1);
    expect(seams.recordSpend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;

    expect(seams.fetch).toHaveBeenCalledTimes(2);
    expect(sentHeaders().map((headers) => headers.Authorization)).toEqual([signedHeader, signedHeader]);
    expect(sentBodies()[1]).toBe(sentBodies()[0]);
    expect(seams.recordSpend).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ jobId: "job-1", msats: 10_000 }));
    expect(seams.recordSpendOnce).not.toHaveBeenCalled();
  });

  it("respects the request deadline when scheduling a resend and keeps the paid POST timeout floor", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    seams.fetch.mockResolvedValueOnce(refusal("settlement_unconfirmed", true, 750));
    await expect(pay(Date.now() + 750)).rejects.toMatchObject({ code: "tempo_settlement_unconfirmed" });
    expect(timeout).toHaveBeenCalledWith(PAID_SUBMIT_FLOOR_MS);
    expect(seams.fetch).toHaveBeenCalledTimes(1);
    expect(seams.recordSpendOnce).toHaveBeenCalledTimes(1);
  });

  it("stops after a second not_broadcast, tells the agent not to pay again, and keeps the spend booked", async () => {
    seams.fetch.mockImplementation(async () => refusal("not_broadcast", true));
    const error = await pay().catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "tempo_not_broadcast",
      display: expect.stringContaining("Do not pay again"),
      hint: expect.stringContaining("Do not pay again"),
    });
    expect(seams.fetch).toHaveBeenCalledTimes(2);
    expect(sentHeaders()[1].Authorization).toBe(sentHeaders()[0].Authorization);
    expect(seams.recordSpendOnce).toHaveBeenCalledTimes(1);
  });

  it.each([false, undefined])("stops at settlement_unconfirmed with retryable=%s and keeps the spend booked", async (retryable) => {
    seams.fetch.mockImplementation(async () => refusal("settlement_unconfirmed", retryable));
    const error = await pay().catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "tempo_settlement_unconfirmed",
      display: expect.stringContaining("Do not pay again"),
      hint: expect.stringContaining("Do not pay again"),
      data: { reason: "settlement_unconfirmed", rail: "tempo", payment_state: "unknown" },
    });
    expect(seams.fetch).toHaveBeenCalledTimes(1);
    expect(seams.recordSpendOnce).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "expired"])("keeps the prior uncertainty when a resend is refused with reason %s", async (reason) => {
    seams.fetch.mockResolvedValueOnce(refusal("settlement_unconfirmed", true, 0)).mockResolvedValueOnce(refusal(reason));
    await expect(pay()).rejects.toMatchObject({
      code: "tempo_settlement_unconfirmed", data: { payment_state: "unknown" },
    });
    expect(seams.fetch).toHaveBeenCalledTimes(2);
    expect(seams.recordSpendOnce).toHaveBeenCalledTimes(1);
    expect(seams.recordSpend).not.toHaveBeenCalled();
  });

  it.each([
    ["plain payment_invalid", () => refusal(undefined)],
    ["a fresh quote", () => new Response(JSON.stringify({
      error: "payment_insufficient", required_msats: 10_000, price_micro: 10_000,
    }), { status: 402 })],
  ])("books one unconfirmed spend when a not_broadcast resend returns %s", async (_label, response) => {
    seams.fetch.mockResolvedValueOnce(refusal("not_broadcast", true)).mockResolvedValueOnce(response());
    await expect(pay()).rejects.toMatchObject({
      code: "tempo_settlement_unconfirmed",
      data: { rail: "tempo", payment_state: "unknown" },
      hint: expect.stringContaining("Do not pay again"),
    });
    expect(sentHeaders().map((headers) => headers.Authorization)).toEqual([signedHeader, signedHeader]);
    expect(seams.recordSpendOnce).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      msats: 10_000, label: "unconfirmed · echo",
    }));
    expect(seams.recordSpend).not.toHaveBeenCalled();
  });

  it("keeps the lost-response recovery error and books the unconfirmed spend", async () => {
    seams.fetch.mockResolvedValueOnce(refusal("settlement_unconfirmed", true, 0))
      .mockRejectedValueOnce(new TypeError("Connection lost"));
    await expect(pay()).rejects.toMatchObject({ code: "provider_unreachable" });
    expect(seams.fetch).toHaveBeenCalledTimes(2);
    expect(seams.recordSpendOnce).toHaveBeenCalledTimes(1);
  });

  it("leaves a reason-less payment_invalid as the provider's refusal with nothing booked", async () => {
    seams.fetch.mockImplementation(async () => refusal(undefined));
    await expect(pay()).rejects.toMatchObject({ code: "payment_invalid" });
    expect(seams.fetch).toHaveBeenCalledTimes(1);
    expect(seams.recordSpendOnce).not.toHaveBeenCalled();
  });
});

describe("Tempo resend limits", () => {
  const pending = (retryAfterMs?: number) =>
    new DvmError("payment_invalid", "Settlement pending", undefined, {
      rail: "tempo", reason: "settlement_unconfirmed", retryable: true, retry_after_ms: retryAfterMs,
    });
  const notBroadcast = () => new DvmError("payment_invalid", "Not broadcast", undefined, {
    rail: "tempo", reason: "not_broadcast", retryable: true,
  });

  it.each([
    { given: undefined, delay: 2_000 },
    { given: -500, delay: 0 },
    { given: 20_000, delay: 10_000 },
  ])("uses $delay ms for a provider delay of $given", async ({ given, delay }) => {
    vi.useFakeTimers();
    const now = Date.now();
    const dispatchTimes: number[] = [];
    const send = vi.fn(async () => {
      dispatchTimes.push(Date.now() - now);
      if (dispatchTimes.length === 1) throw pending(given);
    });
    const result = sendTempoCredential(send);
    await vi.advanceTimersByTimeAsync(delay);
    await result;
    expect(dispatchTimes).toEqual([0, delay]);
  });

  it("skips a delay that would reach challenge expiry", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValue(pending(1_000));
    await expect(sendTempoCredential(send, { expires: new Date(Date.now() + 1_000).toISOString() }))
      .rejects.toMatchObject({ code: "payment_invalid", data: { reason: "settlement_unconfirmed" } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rechecks challenge expiry after sleeping", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const send = vi.fn().mockRejectedValue(pending(1_000));
    const result = expect(sendTempoCredential(send, { expires: new Date(now + 2_000).toISOString() }))
      .rejects.toMatchObject({ data: { reason: "settlement_unconfirmed" } });
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(now + 2_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await result;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("uses the latest delay and counts every resend toward the cap without an expiry", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const dispatchTimes: number[] = [];
    const send = vi.fn(async () => {
      dispatchTimes.push(Date.now() - now);
      if (dispatchTimes.length === 2) throw notBroadcast();
      throw pending(dispatchTimes.length === 1 ? 100 : 200);
    });
    const result = expect(sendTempoCredential(send)).rejects.toMatchObject({
      data: { reason: "settlement_unconfirmed" },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(dispatchTimes).toEqual([0, 100, 100, 300, 500, 700]);
  });

  it("does not grant a second immediate not_broadcast resend after waiting for settlement", async () => {
    const send = vi.fn().mockRejectedValueOnce(notBroadcast()).mockRejectedValueOnce(pending(0))
      .mockRejectedValue(notBroadcast());
    await expect(sendTempoCredential(send)).rejects.toMatchObject({ data: { reason: "not_broadcast" } });
    expect(send).toHaveBeenCalledTimes(3);
  });
});

describe("HTTPS Tempo 402 retry delay", () => {
  const transport = new HttpsTransport();
  const submit = () => transport.submit(ref, envelope, { mppCredentialRaw: signedHeader });
  const send = () => transport.sendMessage("job-1", { type: "payment", content: { tempo_credential: credential } }, ref);

  it.each([{ invoke: submit, context: {} }, { invoke: send, context: { http_status: 402 } }])(
    "reads the nested delay first, then falls back to a finite envelope delay", async ({ invoke, context }) => {
      const error = { code: "payment_invalid", retryable: true };
      const envelope = { reason: "settlement_unconfirmed", rail: "tempo", retry_after_ms: 400 };
      for (const [inner, delay] of [[0, 0], ["250", 400]]) {
        seams.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
          ...envelope, error: { ...error, retry_after_ms: inner },
        }), { status: 402 }));
        await expect(invoke()).rejects.toMatchObject({
          code: "payment_invalid",
          data: { ...context, rail: "tempo", reason: "settlement_unconfirmed", retryable: true, retry_after_ms: delay },
        });
      }
      seams.fetch.mockResolvedValueOnce(new Response(
        '{"error":"payment_invalid","rail":"tempo","retry_after_ms":1e309}', { status: 402 }
      ));
      const invalid = await invoke().catch((error: unknown) => error);
      expect(invalid).toMatchObject({ code: "payment_invalid", data: { ...context, rail: "tempo" } });
      expect((invalid as DvmError).data).not.toHaveProperty("retry_after_ms");
    }
  );
});
