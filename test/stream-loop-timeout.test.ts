import {
  DvmError,
  type JobPolicy,
  type Message,
  type ProviderRef,
  type Transport,
} from "@dvmkit/sdk/internal";
import { beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  append: vi.fn(),
  handlePaymentRequest: vi.fn(),
}));

vi.mock("../src/lib/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/messages")>()),
  createMessageAppendSession: () => ({ append: seams.append }),
}));

vi.mock("../src/lib/payment-responder", () => ({
  handlePaymentRequest: seams.handlePaymentRequest,
}));

import { streamLoop } from "../src/lib/stream-loop";

const provider = { endpoint: "https://dvm.example" } as ProviderRef;
const policy: JobPolicy = {
  maxTotalMsats: 10_000,
  autoPayBelowMsats: 10_000,
  maxIncrementMsats: 10_000,
  maxPayments: 2,
};

beforeEach(() => {
  seams.handlePaymentRequest.mockResolvedValue({
    status: "paid",
    rail: "cashu_p2pk",
    amountMsats: 1_000,
  });
});

describe("stream loop message poll deadlines", () => {
  it("passes the remaining budget to a fallback poll", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValue(1_250);
    const getMessages = vi.fn().mockResolvedValue([complete(1)]);

    await streamLoop({
      jobId: "job-budget",
      transport: fallbackTransport(getMessages),
      provider,
      afterSeq: 0,
      timeoutMs: 1_000,
      jobToken: "token",
    });

    expect(getMessages).toHaveBeenCalledExactlyOnceWith("job-budget", 0, provider, {
      timeoutMs: 750,
      jobToken: "token",
    });
  });

  it("preserves no-timeout semantics when no deadline is supplied", async () => {
    const getMessages = vi.fn().mockResolvedValue([]);

    await streamLoop({
      jobId: "job-unbounded",
      transport: fallbackTransport(getMessages),
      provider,
      afterSeq: 0,
      jobToken: "token",
    });

    expect(getMessages).toHaveBeenCalledExactlyOnceWith("job-unbounded", 0, provider, {
      jobToken: "token",
    });
  });

  it("does not reinterpret a transport timeout when the caller set no deadline", async () => {
    const failure = new DvmError("timeout", "Transport-owned timeout.");
    const getMessages = vi.fn().mockRejectedValue(failure);

    await expect(
      streamLoop({
        jobId: "job-transport-timeout",
        transport: fallbackTransport(getMessages),
        provider,
        afterSeq: 0,
      })
    ).rejects.toBe(failure);
  });

  it("bounds the fallback and final recheck by the same deadline", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce([paymentRequest(1)])
      .mockImplementationOnce(async () => {
        now = 1_500;
        return [];
      })
      .mockResolvedValueOnce([complete(2)]);
    seams.handlePaymentRequest.mockImplementationOnce(async () => {
      now = 1_400;
      return { status: "paid", rail: "cashu_p2pk", amountMsats: 1_000 };
    });

    const result = await streamLoop({
      jobId: "job-recheck",
      transport: fallbackTransport(getMessages),
      provider,
      policy,
      afterSeq: 0,
      timeoutMs: 1_000,
      jobToken: "token",
    });

    expect(getMessages).toHaveBeenNthCalledWith(1, "job-recheck", 0, provider, {
      timeoutMs: 1_000,
      jobToken: "token",
    });
    expect(getMessages).toHaveBeenNthCalledWith(2, "job-recheck", 1, provider, {
      timeoutMs: 600,
      jobToken: "token",
    });
    expect(getMessages).toHaveBeenNthCalledWith(3, "job-recheck", 1, provider, {
      timeoutMs: 500,
      jobToken: "token",
    });
    expect(result.messages).toEqual([paymentRequest(1), complete(2)]);
    expect(result.nextAction).toBeNull();
  });

  it("does not poll again after payment exhausts the budget", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const getMessages = vi.fn().mockResolvedValueOnce([paymentRequest(1)]);
    seams.handlePaymentRequest.mockImplementationOnce(async () => {
      now = 2_000;
      return { status: "paid", rail: "cashu_p2pk", amountMsats: 1_000 };
    });

    const result = await streamLoop({
      jobId: "job-expired",
      transport: fallbackTransport(getMessages),
      provider,
      policy,
      afterSeq: 0,
      timeoutMs: 1_000,
      jobToken: "token",
    });

    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(seams.handlePaymentRequest).toHaveBeenCalledTimes(1);
    expect(result.messages).toEqual([paymentRequest(1)]);
    expect(result.autoPayments).toHaveLength(1);
    expect(result.nextAction).toMatchObject({ type: "poll", job_id: "job-expired" });
  });

  it("keeps the paid continuation when a bounded follow-up poll times out", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce([paymentRequest(1)])
      .mockImplementationOnce(async () => {
        now = 2_000;
        throw new DvmError("timeout", "Message poll timed out.");
      });

    const result = await streamLoop({
      jobId: "job-timed-out",
      transport: fallbackTransport(getMessages),
      provider,
      policy,
      afterSeq: 0,
      timeoutMs: 1_000,
    });

    expect(getMessages).toHaveBeenCalledTimes(2);
    expect(seams.handlePaymentRequest).toHaveBeenCalledTimes(1);
    expect(result.autoPayments).toHaveLength(1);
    expect(result.nextAction).toMatchObject({ type: "poll", job_id: "job-timed-out" });
  });
});

function fallbackTransport(getMessages: ReturnType<typeof vi.fn>): Transport {
  return { getMessages } as unknown as Transport;
}

function paymentRequest(seq: number): Message {
  return {
    seq,
    from: "provider",
    timestamp: seq,
    type: "payment-request",
    content: { amount_msats: 1_000, reason: "Finish the job" },
  };
}

function complete(seq: number): Message {
  return {
    seq,
    from: "provider",
    timestamp: seq,
    type: "complete",
    content: { summary: "Done" },
  };
}
