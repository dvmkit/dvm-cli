import { Credential } from "mppx";
import { beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  fetch: vi.fn(),
  recordSpendOnce: vi.fn(() => true),
  json: vi.fn(),
  info: vi.fn(),
}));
vi.mock("../src/lib/http", () => ({ dvmFetch: seams.fetch }));
vi.mock("../src/lib/budget-ledger", async (original) => ({
  ...(await original<typeof import("../src/lib/budget-ledger")>()),
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

import { payWithTempo } from "../src/commands/request";
import { HttpsTransport } from "../src/lib/transport/https";
import { sendTempoCredential } from "../src/lib/payment-rails/tempo-broadcast";
import type { JobEnvelope, MppxCredential, ProviderRef } from "@dvmkit/sdk/internal";

const ref = { endpoint: "https://dvm.example" } as ProviderRef;
const envelope = { input: "hello", capability: "echo" } as JobEnvelope;
const credential = Credential.from({
  challenge: { id: "challenge-1", realm: "dvm.example", method: "tempo", intent: "charge", request: { amount: "10000" } },
  payload: { type: "transaction", signature: "0xsigned" },
}) as unknown as MppxCredential;
const signedHeader = Credential.serialize(credential as never);

const refusal = (reason: string | undefined, retryable?: boolean) =>
  new Response(JSON.stringify({
    error: "payment_invalid", rail: "tempo", ...(reason ? { reason } : {}), ...(retryable === undefined ? {} : { retryable }),
    display: "Provider prose.", hint: "Provider hint.",
  }), { status: 402, headers: { "Content-Type": "application/json" } });
const accepted = () => new Response(JSON.stringify({ job_id: "job-1", status: "processing" }), { status: 202 });
const sentHeaders = () => seams.fetch.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>);
const sentBodies = () => seams.fetch.mock.calls.map(([, init]) => (init as RequestInit).body);

beforeEach(() => seams.fetch.mockReset());

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

  it("does not resend settlement_unconfirmed, a reason-less refusal, or a non-retryable not_broadcast", async () => {
    for (const body of [refusal("settlement_unconfirmed", false), refusal(undefined), refusal("not_broadcast", false)]) {
      seams.fetch.mockReset().mockResolvedValueOnce(body);
      const transport = new HttpsTransport();
      await expect(sendTempoCredential(() => transport.submit(ref, envelope, { mppCredential: credential })))
        .rejects.toMatchObject({ code: "payment_invalid" });
      expect(seams.fetch).toHaveBeenCalledTimes(1);
    }
  });

  const pay = () => payWithTempo({
    transport: new HttpsTransport(), ref, envelope, jobId: "", deadlineMs: Date.now() + 60_000,
    chosen: { priceMsats: 10_000 }, quotes: [], opts: {}, identity: { dvmId: "dvm-1", capability: "echo" },
    policy: {}, btcRate: 100_000,
    account: { address: "0x0000000000000000000000000000000000000001", privateKey: "0x01" },
    providerInfo: {},
  } as never, credential);

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

  it("stops at settlement_unconfirmed without a resend and keeps the spend booked", async () => {
    seams.fetch.mockImplementation(async () => refusal("settlement_unconfirmed", false));
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

  it("leaves a reason-less payment_invalid as the provider's refusal with nothing booked", async () => {
    seams.fetch.mockImplementation(async () => refusal(undefined));
    await expect(pay()).rejects.toMatchObject({ code: "payment_invalid" });
    expect(seams.fetch).toHaveBeenCalledTimes(1);
    expect(seams.recordSpendOnce).not.toHaveBeenCalled();
  });
});
