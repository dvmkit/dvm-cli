import { createServer } from "node:http";
import { once } from "node:events";
import { HttpsTransport } from "../src/lib/transport/https";
import { DvmError, type JobPolicy, type Message, type Transport } from "@dvmkit/sdk/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  transport: {} as Transport,
  pay: vi.fn(), claim: vi.fn(), json: vi.fn(), jsonEvent: vi.fn(), info: vi.fn(),
  // Every stdout write in order: streamed events and the final document.
  lines: [] as Record<string, any>[],
  settlement: undefined as Record<string, unknown> | undefined,
}));
vi.mock("../src/lib/receipt-capture", async (original) => {
  const actual = await original<typeof import("../src/lib/receipt-capture")>();
  return { ...actual, observedSettlementFields: (...args: Parameters<typeof actual.observedSettlementFields>) =>
    seams.settlement ? Promise.resolve(seams.settlement) : actual.observedSettlementFields(...args) };
});
vi.mock("../src/lib/transport", () => ({ createDvmTransport: () => seams.transport }));
vi.mock("../src/lib/payment-responder", () => ({ handlePaymentRequest: seams.pay }));
vi.mock("../src/lib/refund-claim", async (original) => ({
  ...(await original<typeof import("../src/lib/refund-claim")>()),
  claimInboundPayments: seams.claim,
  refundJsonField: async (claims: unknown[]) => claims.length ? { refund: claims.at(-1) } : {},
}));
vi.mock("../src/lib/output", () => ({
  info: seams.info, json: seams.json, jsonEvent: seams.jsonEvent, addOutputWarnings: (entries: unknown[]) => entries,
  withOutputWarnings: <T>(run: () => Promise<T>) => run(),
}));
vi.mock("../src/lib/job-content", async (original) => ({
  ...(await original<typeof import("../src/lib/job-content")>()),
  observeJobContent: vi.fn(), jobContentFields: () => ({}),
}));
vi.mock("../src/lib/job-access", () => ({
  resolveJobAccess: (jobId: string) => ({ stored: loadJob(jobId) ?? { policy }, ref: provider, endpointOverridden: false }),
  resolveStoredJobAccess: (jobId: string) => ({ stored: loadJob(jobId), ref: provider, endpointOverridden: false }),
  withJobTokenRedaction: (_token: unknown, fn: () => unknown) => fn(),
}));

import { messages } from "../src/commands/messages";
import { catchErrors } from "../src/lib/error-handler";
import { pay } from "../src/commands/pay";
import { message } from "../src/commands/message";
import { streamLoop } from "../src/lib/stream-loop";
import { appendMessages } from "../src/lib/messages";
import { loadJob, saveJob, bookCreditPayment, markPaymentRequestInFlight, markPaymentRequestPaid } from "../src/lib/job-store";
import { createWaitPaymentLines } from "../src/lib/wait-payment-lines";
const provider = { endpoint: "https://dvm.example" };
const policy: JobPolicy = { maxTotalMsats: 100_000, autoPayBelowMsats: 2000, maxIncrementMsats: 0, maxPayments: 5 };
function msg(seq: number, type: string, content: unknown = {}): Message {
  return { seq, from: "provider", timestamp: seq, type, content } as Message;
}
// Like the HTTPS transport, the fake reports each message through onMessage as it reads it.
function transport(batches: Message[][], status = "processing") {
  const queue = [...batches];
  const stream = vi.fn(async (_job: string, _after: number, _provider: unknown, options: { onMessage?: (m: Message) => void; signal: AbortSignal }) => {
    const batch = queue.shift() ?? [];
    for (const message of batch) options?.onMessage?.(message);
    return { messages: batch };
  });
  seams.transport = {
    stream, status: vi.fn().mockResolvedValue({ status }),
    getMessages: vi.fn().mockResolvedValue([]), close: vi.fn(), sendMessage: vi.fn().mockResolvedValue(undefined),
  } as unknown as Transport;
  return stream;
}
const output = () => seams.json.mock.calls.at(-1)![0];
const streamed = (event: string) => seams.lines.filter((line) => line.event === event);
const streamedSeqs = () => streamed("message").map((line) => line.seq);
beforeEach(() => {
  seams.lines.length = 0;
  seams.settlement = undefined;
  seams.json.mockImplementation((line) => { seams.lines.push(line); });
  seams.jsonEvent.mockImplementation((line) => { seams.lines.push(line); });
  seams.claim.mockResolvedValue([]);
  seams.pay.mockResolvedValue({ status: "paid", rail: "cashu_p2pk", amountMsats: 1000 });
});
afterEach(() => vi.useRealTimers());

// The transport ends each stream; the command must preserve its policy and output across reconnects.
describe("messages wait", () => {
  it("continues through dropped streams and working messages, pays three charges, and returns the prompt once", async () => {
    vi.useFakeTimers();
    const stream = transport([
      [], [msg(1, "working")],
      [msg(2, "payment-request", { amount_msats: 1000, reason: "Block one" })], [],
      [msg(3, "progress", { percent_complete: 50 })],
      [msg(4, "payment-request", { amount_msats: 1000, reason: "Block two" })], [],
      [msg(5, "payment-request", { amount_msats: 1000, reason: "Block three" })],
      [msg(6, "prompt", { id: "choice", text: "Continue?", options: ["yes", "no"] })],
    ]);
    const pending = messages("wait-charges", { wait: true });
    await vi.runAllTimersAsync();
    await pending;
    expect(seams.json).toHaveBeenCalledTimes(1);
    expect(output()).toMatchObject({ event: "result", message_count: 6, auto_payment_count: 3,
      next_action: { type: "respond", prompt_id: "choice", options: ["yes", "no"] } });
    expect(output()).not.toHaveProperty("messages");
    expect(output()).not.toHaveProperty("auto_payments");
    // Each payment line follows the ask it answered, and the result line comes last.
    expect(seams.lines.map((line) => line.event === "message" ? line.seq : line.event))
      .toEqual([1, 2, "payment", 3, 4, "payment", 5, "payment", 6, "result"]);
    expect(streamed("payment")[0]).toMatchObject({ amount_msats: 1000, rail: "cashu_p2pk",
      reason: { _source: "provider", text: "Block one" }, display: expect.any(String) });
    expect(seams.pay).toHaveBeenCalledTimes(3);
    expect(seams.pay.mock.calls.every((call) => call[2] === policy)).toBe(true);
    expect(stream.mock.calls.at(-1)?.[1]).toBe(5);
  });

  it.each([false, true])("returns a JSON cursor behind an unresolved payment with a newer prompt (explicit after=%s)", async (explicit) => {
    const jobId = `wait-unresolved-cursor-${explicit}`;
    saveJob({ id: jobId, endpoint: provider.endpoint, status: "awaiting-input", submittedAt: 0, messageCursor: 4, policy });
    markPaymentRequestInFlight(jobId, 5);
    const history = [msg(5, "payment-request", { amount_msats: 1000, reason: "Continue" }),
      msg(6, "text", { text: "Still working" }), msg(7, "prompt", { id: "choice", text: "Continue?" })];
    const stream = transport([], "awaiting-input");
    stream.mockImplementation(async (_job, after, _provider, options) => {
      const batch = history.filter((message) => message.seq > after);
      for (const message of batch) options?.onMessage?.(message);
      return { messages: batch };
    });
    vi.mocked(seams.transport.getMessages).mockResolvedValue(history);
    await messages(jobId, { wait: true, ...(explicit ? { after: "4" } : {}) });
    expect(output().cursor).toBe(4);
    expect(streamedSeqs()).toEqual([5, 6, 7]);
    expect(output().next_action).toMatchObject({ type: "respond", prompt_id: "choice" });
    expect(seams.pay).not.toHaveBeenCalled();
  });

  it("keeps the HTTP message stream attached across provider disconnects", async () => {
    const batches = [[], [msg(1, "working")],
      [msg(2, "payment-request", { amount_msats: 1000, reason: "First block" }), msg(3, "progress", { percent_complete: 30 })],
      [msg(4, "working")],
      [msg(5, "payment-request", { amount_msats: 1000, reason: "Second block" })],
      [msg(6, "payment-request", { amount_msats: 1000, reason: "Third block" })],
      [msg(7, "prompt", { id: "choice", text: "Continue?" })]];
    const server = createServer((request, response) => {
      if (request.url?.includes("/messages")) {
        if (request.headers.accept === "text/event-stream") {
          response.setHeader("content-type", "text/event-stream");
          for (const message of batches.shift() ?? []) response.write(`data: ${JSON.stringify(message)}\n\n`);
          response.end();
        } else {
          response.setHeader("content-type", "application/json");
          response.end('{"messages":[]}');
        }
      } else {
        response.setHeader("content-type", "application/json");
        response.end('{"status":"processing"}');
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const originalEndpoint = provider.endpoint;
    provider.endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    seams.transport = new HttpsTransport();
    try {
      await messages("http-wait", { wait: true, until: "20s" });
      expect(output().next_action).toMatchObject({ type: "respond", prompt_id: "choice" });
      expect(streamed("payment")).toHaveLength(3);
      expect(streamedSeqs()).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(seams.pay).toHaveBeenCalledTimes(3);
    } finally {
      provider.endpoint = originalEndpoint;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);

  it("returns an over-threshold charge without paying", async () => {
    transport([[msg(1, "payment-request", { amount_msats: 3000, reason: "More work" })]]);
    await messages("wait-expensive", { wait: true });
    expect(output().next_action).toMatchObject({ type: "pay", amount_msats: 3000 });
    expect(seams.pay).not.toHaveBeenCalled();
  });

  it("returns poll after exactly the requested three seconds without yields", async () => {
    vi.useFakeTimers();
    const stream = transport([]);
    const start = Date.now();
    const pending = messages("wait-limit", { wait: true, until: "3s" });
    await vi.runAllTimersAsync();
    await pending;
    expect(Date.now() - start).toBe(3000);
    expect(output().next_action.type).toBe("poll");
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it("backs off to at most thirty seconds and resets after progress", async () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    transport([]);
    vi.mocked(seams.transport.stream!).mockImplementation(async () => {
      calls.push(Date.now());
      return { messages: calls.length === 7 ? [msg(1, "working")] : [], reason: "yield" };
    });
    const pending = messages("wait-backoff", { wait: true, until: "2m" });
    await vi.runAllTimersAsync();
    await pending;
    expect(calls.slice(1).map((time, i) => time - calls[i])).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 1000, 2000, 4000, 8000, 16000]);
    expect(output().next_action.type).toBe("poll");
  });

  it("retries a transport timeout and returns a later completion", async () => {
    vi.useFakeTimers();
    const stream = transport([[msg(1, "complete", { summary: "Done" })]]);
    stream.mockRejectedValueOnce(new DvmError("timeout", "Read timed out"));
    const pending = messages("wait-retry", { wait: true });
    await vi.runAllTimersAsync();
    await pending;
    expect(output().next_action).toBeNull();
    expect(streamedSeqs()).toEqual([1]);
  });

  it("returns immediately for a terminal snapshot", async () => {
    const stream = transport([], "completed");
    await messages("wait-done", { wait: true });
    expect(output().next_action).toBeNull();
    expect(stream).not.toHaveBeenCalled();
  });

  it("retrieves the final artifact when completion races a reconnect", async () => {
    vi.useFakeTimers();
    const stream = transport([[msg(1, "working")]]);
    vi.mocked(seams.transport.status).mockResolvedValueOnce({ status: "processing" } as never)
      .mockResolvedValue({ status: "completed" } as never);
    vi.mocked(seams.transport.getMessages).mockResolvedValue([
      msg(2, "artifact", { mime_type: "text/plain", data: "result" }), msg(3, "complete", { summary: "Done" }),
    ]);
    const pending = messages("wait-completion-race", { wait: true });
    await vi.runAllTimersAsync();
    await pending;
    expect(output().next_action).toBeNull();
    expect(streamed("message").map((line) => line.type)).toEqual(["working", "artifact", "complete"]);
    expect(output().cursor).toBe(3);
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("retains the payment-cap error and hint during a reconnect", async () => {
    vi.useFakeTimers();
    transport([[], [msg(1, "payment-request", { amount_msats: 1000, reason: "Next block" })]]);
    seams.pay.mockResolvedValue("payment-cap-exceeded");
    const pending = expect(messages("wait-cap", { wait: true })).rejects.toMatchObject({
      code: "payment_cap_exceeded", hint: expect.stringContaining("--max-payments 6"),
    });
    await vi.runAllTimersAsync();
    await pending;
    expect(seams.json).not.toHaveBeenCalled();
  });

  it("writes each message line as it arrives, before the wait resolves", async () => {
    vi.useFakeTimers();
    const stream = transport([]);
    const still = msg(2, "artifact", { name: "still-1.jpg", mime_type: "image/jpeg", url: "https://dvm.example/still-1.jpg" });
    stream.mockImplementationOnce(async (_job, _after, _provider, options) => {
      options.onMessage?.(msg(1, "working"));
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      options.onMessage?.(still);
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      const prompt = msg(3, "prompt", { id: "more", text: "Keep watching?" });
      options.onMessage?.(prompt);
      return { messages: [msg(1, "working"), still, prompt] };
    });
    let settled = false;
    const pending = messages("wait-live", { wait: true }).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1);
    expect(streamedSeqs()).toEqual([1]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(streamed("message").at(-1)).toMatchObject({ seq: 2, type: "artifact", content: { mime_type: "image/jpeg" } });
    expect(settled).toBe(false);
    expect(seams.json).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    await pending;
    expect(seams.lines.map((line) => line.event)).toEqual(["message", "message", "message", "result"]);
    expect(output().next_action).toMatchObject({ type: "respond", prompt_id: "more" });
  });

  it("puts the job's settlement and wallet report on the result line only", async () => {
    transport([[msg(1, "complete", { summary: "Done" })]]);
    const walletRemaining = { display: "$0.45 of what you paid is left over from this job.", hint: "Keep it." };
    seams.settlement = { wallet_remaining: walletRemaining };
    await messages("wait-wallet", { wait: true });
    expect(seams.lines.map((line) => line.event)).toEqual(["message", "result"]);
    expect(output()).toMatchObject({ event: "result", wallet_remaining: walletRemaining });
    expect(seams.lines[0]).not.toHaveProperty("wallet_remaining");
  });

  it.each([["--after 0", { after: "0" }, undefined], ["the stored cursor", {}, 4]] as const)(
    "writes a recovered credit payment after its ask (%s)", async (_label, flags, messageCursor) => {
      const jobId = `wait-credit-recovery-${messageCursor ?? "after"}`;
      const ask = msg(5, "payment-request", { amount_msats: 1000, reason: "Recovered block" });
      const intent = { request: ask.content, amountMsats: 1000, approval: "auto",
        authorization: { request_seq: 5, payment_id: `${jobId}-payment`, amount_micro: 1000, currency: "usd" } };
      saveJob({ id: jobId, endpoint: provider.endpoint, status: "processing", submittedAt: 0, policy,
        pendingCreditPayment: intent, ...(messageCursor !== undefined ? { messageCursor } : {}) } as never);
      transport([[ask, msg(6, "prompt", { id: "q", text: "Continue?" })]]);
      seams.pay.mockImplementationOnce(async () => {
        bookCreditPayment(jobId, intent as never);
        return { status: "paid", rail: "credit", amountMsats: 1000 };
      });
      await messages(jobId, { wait: true, ...flags });
      expect(seams.lines.map((line) => line.event === "message" ? line.seq : line.event)).toEqual([5, "payment", 6, "result"]);
      expect(output().auto_payment_count).toBe(1);
    });

  it("writes a payment line for an auto-payment confirmed only on a later read", async () => {
    vi.useFakeTimers();
    const jobId = "wait-delayed-confirmation";
    const ask = msg(5, "payment-request", { amount_msats: 1000, reason: "Delayed block", fiat_amount: { amount: 0.01, currency: "usd" } });
    const paid = { ...msg(6, "payment", { x402_payment: "signed" }), from: "requester" } as Message;
    saveJob({ id: jobId, endpoint: provider.endpoint, status: "processing", submittedAt: 0, policy });
    transport([[ask]]);
    vi.mocked(seams.transport.status).mockResolvedValueOnce({ status: "processing" } as never)
      .mockResolvedValue({ status: "completed" } as never);
    vi.mocked(seams.transport.getMessages).mockResolvedValue([ask, paid, msg(7, "complete", { summary: "Done" })]);
    seams.pay.mockImplementationOnce(async () => {
      markPaymentRequestInFlight(jobId, 5, { rail: "x402", content: { x402_payment: "signed" },
        requestAmountMsats: 1000, amountMsats: 1000, btcRate: 100_000, approval: "auto", reason: "Delayed block" });
      throw new DvmError("payment_unconfirmed", "Reply not confirmed yet");
    });
    const pending = messages(jobId, { wait: true });
    await vi.runAllTimersAsync();
    await pending;
    expect(loadJob(jobId)).toMatchObject({ totalPaidMsats: 1000, paymentsHonoured: 1 });
    expect(seams.lines.map((line) => line.event === "message" ? line.seq : line.event))
      .toEqual([5, 6, 7, "payment", "result"]);
    expect(streamed("payment")[0]).toMatchObject({ amount_msats: 1000, rail: "x402",
      reason: { _source: "provider", text: "Delayed block" }, display: expect.stringContaining("$0.01") });
    expect(output().auto_payment_count).toBe(1);
  });

  it("does not repeat written messages after an error exit, but repeats the open ask", async () => {
    const jobId = "wait-error-resume";
    const artifact = msg(1, "artifact", { name: "picture.jpg", mime_type: "image/jpeg", url: "https://dvm.example/picture.jpg" });
    const ask = msg(2, "payment-request", { amount_msats: 1000, reason: "Next block" });
    saveJob({ id: jobId, endpoint: provider.endpoint, status: "processing", submittedAt: 0, policy, messageCursor: 0 });
    transport([[artifact, ask]]);
    seams.pay.mockResolvedValueOnce("payment-cap-exceeded");
    await expect(messages(jobId, { wait: true })).rejects.toMatchObject({ code: "payment_cap_exceeded" });
    expect(streamedSeqs()).toEqual([1, 2]);
    // The cursor stays before the unpaid ask, so the next wait still answers it.
    expect(loadJob(jobId)?.messageCursor).toBe(0);
    seams.lines.length = 0;
    transport([[artifact, ask], [msg(3, "prompt", { id: "q", text: "Continue?" })]]);
    await messages(jobId, { wait: true });
    expect(seams.lines.map((line) => line.event === "message" ? line.seq : line.event)).toEqual([2, "payment", 3, "result"]);
    seams.lines.length = 0;
    // An explicit --after reads written messages again.
    transport([[artifact, ask, msg(3, "prompt", { id: "q", text: "Continue?" })]]);
    await messages(jobId, { wait: true, after: "0" });
    expect(streamedSeqs()).toEqual([1, 2, 3]);
  });

  it("ends an error exit with the error line after every payment and message already written", async () => {
    vi.useFakeTimers();
    transport([[msg(1, "payment-request", { amount_msats: 1000, reason: "Hour one" })],
      [msg(2, "payment-request", { amount_msats: 1000, reason: "Hour two" })],
      [msg(3, "payment-request", { amount_msats: 1000, reason: "Hour three" })]]);
    seams.pay.mockResolvedValueOnce({ status: "paid", rail: "cashu_p2pk", amountMsats: 1000 })
      .mockResolvedValueOnce({ status: "paid", rail: "cashu_p2pk", amountMsats: 1000 })
      .mockResolvedValue("payment-cap-exceeded");
    const exit = new Error("process exit");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw exit; });
    const pending = expect(catchErrors(() => messages("wait-cap-lines", { wait: true }), undefined, { event: "error" })).rejects.toBe(exit);
    await vi.runAllTimersAsync();
    await pending;
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(seams.lines.map((line) => line.event === "message" ? line.seq : line.event))
      .toEqual([1, "payment", 2, "payment", 3, "error"]);
    expect(seams.lines.at(-1)).toMatchObject({ event: "error", error: { code: "payment_cap_exceeded" } });
  });

  it("propagates non-timeout transport failures", async () => {
    transport([]);
    const failure = new DvmError("provider_unreachable", "Connection lost");
    vi.mocked(seams.transport.stream!).mockRejectedValue(failure);
    await expect(messages("wait-failed", { wait: true })).rejects.toBe(failure);
    expect(seams.transport.close).toHaveBeenCalled();
  });
});

describe("messages next-action regressions", () => {
  it.each([false, true])("keeps a heartbeat-only processing job active (human=%s)", async (human) => {
    transport([[msg(1, "progress", { percent_complete: 10 })]]);
    await messages("heartbeat", { human });
    if (human) expect(seams.info.mock.calls.flat().join("\n")).toContain("Next: Provider is still working");
    else expect(output().next_action).toMatchObject({ type: "poll" });
  });

  it.each([[false, true], [true, true], [false, false], [true, false]])("shows the pending question even after claiming a refund (human=%s, stream=%s)", async (human, stream) => {
    transport([[msg(2, "prompt", { id: "choice", text: "Continue?" })]]);
    seams.claim.mockResolvedValue([{ seq: 1, amount_msats: 1000, reason: "refund", claimed: true, cashu_token: "spent-token" }]);
    vi.mocked(seams.transport.getMessages).mockResolvedValue([msg(2, "prompt", { id: "choice", text: "Continue?" })]);
    await messages("refund-question", { human, stream });
    if (human) {
      const text = seams.info.mock.calls.flat().join("\n");
      expect(text).toContain("Claimed refund");
      expect(text).toContain('Next: The provider asks: Continue?');
      expect(text).toContain('dvm message refund-question "<answer>" --type response --prompt-id choice');
    } else {
      expect(output().next_action.type).toBe("respond");
      expect(output().refund.claimed).toBe(true);
    }
  });
  it("keeps an unclaimed refund actionable without a pending yield", async () => {
    transport([]);
    seams.claim.mockResolvedValue([{ seq: 1, amount_msats: 1000, reason: "refund", claimed: false, cashu_token: "recover-token" }]);
    vi.mocked(seams.transport.getMessages).mockResolvedValue([msg(1, "payment", { amount_msats: 1000 })]);
    await messages("refund-recovery", { stream: false });
    expect(output().next_action).toMatchObject({ type: "refund", claimed: false, cashu_token: "recover-token" });
  });

  it("keeps an unpaid charge ahead of a claimed refund", async () => {
    transport([[msg(2, "payment-request", { amount_msats: 3000, reason: "More work" })]]);
    seams.claim.mockResolvedValue([{ seq: 1, amount_msats: 1000, reason: "refund", claimed: true, cashu_token: "spent-token" }]);
    await messages("refund-charge", {});
    expect(output().next_action).toMatchObject({ type: "pay", amount_msats: 3000 });
    expect(output().refund.claimed).toBe(true);
  });

});

describe("payment replay and terminal refund regressions", () => {
  it.each([undefined, "6"])("does not re-pay an already-paid request at wait start (after=%s)", async (after) => {
    vi.useFakeTimers();
    transport([[msg(5, "payment-request", { amount_msats: 1000, reason: "x" }), { ...msg(6, "payment", { amount_msats: 1000 }), from: "requester" } as Message],
      [msg(7, "prompt", { id: "q", text: "?" })]]);
    vi.mocked(seams.transport.status).mockResolvedValueOnce({ status: "awaiting-input" } as never)
      .mockResolvedValue({ status: "processing" } as never);
    vi.mocked(seams.transport.getMessages).mockResolvedValue([
      msg(5, "payment-request", { amount_msats: 1000, reason: "x" }), { ...msg(6, "payment", { amount_msats: 1000 }), from: "requester" } as Message]);
    const pending = messages(`replay-${after ?? "stored"}`, { wait: true, after });
    await vi.runAllTimersAsync();
    await pending;
    expect(seams.pay).not.toHaveBeenCalled();
    if (after) expect(vi.mocked(seams.transport.stream!).mock.calls.every((call) => call[1] >= 6)).toBe(true);
  });
  it("provider re-sends paid request after reconnect", async () => {
    vi.useFakeTimers();
    transport([[msg(5, "payment-request", { amount_msats: 1000, reason: "x" })], [],
      [msg(5, "payment-request", { amount_msats: 1000, reason: "x" })], [msg(7, "prompt", { id: "q", text: "?" })]]);
    const pending = messages("replay2", { wait: true });
    await vi.runAllTimersAsync();
    await pending;
    expect(seams.pay).toHaveBeenCalledTimes(1);
    expect(streamedSeqs()).toEqual([5, 7]);
  });
  it("terminal snapshot with unclaimed refund in tail keeps refund action", async () => {
    vi.useFakeTimers();
    transport([[msg(1, "working")]]);
    vi.mocked(seams.transport.status).mockResolvedValueOnce({ status: "processing" } as never)
      .mockResolvedValue({ status: "completed" } as never);
    vi.mocked(seams.transport.getMessages).mockResolvedValue([
      msg(2, "payment", { amount_msats: 1000, reason: "change", cashu_token: "tok" }), msg(3, "complete", { summary: "Done" })]);
    seams.claim.mockImplementation(async (_j: string, ms: Message[]) => ms.some((m) => m.type === "payment")
      ? [{ seq: 2, amount_msats: 1000, reason: "change", claimed: false, cashu_token: "tok" }] : []);
    const pending = messages("term-refund", { wait: true });
    await vi.runAllTimersAsync();
    await pending;
    expect(output().next_action).toEqual({ type: "refund", job_id: expect.any(String), _provider_fields: ["amount_msats", "reason", "cashu_token", "job_id"], amount_msats: 1000, reason: "change", claimed: false, cashu_token: "tok", display: expect.any(String), hint: expect.stringContaining("dvm wallet receive-token") });
  });
  it("retains terminal refund recovery in streamed JSON", async () => {
    transport([[msg(2, "payment", { amount_msats: 1000, reason: "change", cashu_token: "tok" }), msg(3, "complete", { summary: "Done" })]], "completed");
    seams.claim.mockResolvedValue([{ seq: 2, amount_msats: 1000, reason: "change", claimed: false, cashu_token: "tok" }]);
    await messages("term-refund2", {});
    expect(output().next_action).toEqual({ type: "refund", job_id: expect.any(String), _provider_fields: ["amount_msats", "reason", "cashu_token", "job_id"], amount_msats: 1000, reason: "change", claimed: false, cashu_token: "tok", display: expect.any(String), hint: expect.stringContaining("dvm wallet receive-token") });
  });
  it("preserves terminal refund recovery in non-streamed JSON", async () => {
    transport([], "completed");
    vi.mocked(seams.transport.getMessages).mockResolvedValue([msg(2, "payment", { amount_msats: 1000, reason: "change", cashu_token: "tok" }), msg(3, "complete", { summary: "Done" })]);
    seams.claim.mockResolvedValue([{ seq: 2, amount_msats: 1000, reason: "change", claimed: false, cashu_token: "tok" }]);
    await messages("term-refund3", { stream: false });
    expect(output().next_action).toEqual({ type: "refund", job_id: expect.any(String), _provider_fields: ["amount_msats", "reason", "cashu_token", "job_id"], amount_msats: 1000, reason: "change", claimed: false, cashu_token: "tok", display: expect.any(String), hint: expect.stringContaining("dvm wallet receive-token") });
  });
  it.each([undefined, "6"])("does not return respond for an already-answered prompt (after=%s)", async (after) => {
    vi.useFakeTimers();
    transport([[msg(5, "prompt", { id: "q", text: "?" }), { ...msg(6, "response", { prompt_id: "q", text: "yes" }), from: "requester" } as Message], [msg(8, "complete", {summary: "d"})]]);
    vi.mocked(seams.transport.status).mockResolvedValueOnce({ status: "awaiting-input" } as never)
      .mockResolvedValue({ status: "processing" } as never);
    vi.mocked(seams.transport.getMessages).mockResolvedValue([msg(5, "prompt", { id: "q", text: "?" }), { ...msg(6, "response", { prompt_id: "q", text: "yes" }), from: "requester" } as Message]);
    const pending = messages(`answered-${after ?? "stored"}`, { wait: true, after });
    await vi.runAllTimersAsync();
    await pending;
    expect(output().next_action).toBeNull();
    expect(streamed("message").at(-1)?.type).toBe("complete");
  });
});

describe("durable answered yields", () => {
  it("does not surface a manually paid charge from a stale non-streamed history", async () => {
    const jobId = "paid-snapshot";
    saveJob({ id: jobId, endpoint: provider.endpoint, status: "awaiting-input", submittedAt: 0,
      policy, paidPaymentRequestSeqs: [5] });
    transport([], "awaiting-input");
    vi.mocked(seams.transport.getMessages).mockResolvedValue([msg(5, "payment-request", { amount_msats: 3000, reason: "Already settled" })]);
    await messages(jobId, { stream: false });
    expect(output().next_action).toMatchObject({ type: "poll" });
    expect(seams.pay).not.toHaveBeenCalled();
  });

  it("does not surface a prompt answered in the durable journal to a fresh stream", async () => {
    const jobId = "answered-journal";
    const prompt = msg(5, "prompt", { id: "choice", text: "Continue?" });
    appendMessages(jobId, [prompt, { ...msg(6, "response", { prompt_id: "choice", text: "yes" }), from: "requester" } as Message]);
    transport([[prompt]]);
    const result = await streamLoop({ jobId, provider, policy, transport: seams.transport, afterSeq: 0 });
    expect(result.nextAction).toMatchObject({ type: "poll" });
  });

  it("resumes an unanswered prompt behind the stored cursor when no explicit after is given", async () => {
    const jobId = "unanswered-journal";
    const prompt = msg(5, "prompt", { id: "choice", text: "Continue?" });
    saveJob({ id: jobId, endpoint: provider.endpoint, status: "awaiting-input", submittedAt: 0, messageCursor: 6, policy });
    const stream = transport([[prompt]], "awaiting-input");
    vi.mocked(seams.transport.getMessages).mockResolvedValue([prompt]);
    await messages(jobId, { wait: true });
    expect(stream.mock.calls[0][1]).toBe(4);
    expect(output().next_action).toMatchObject({ type: "respond", prompt_id: "choice" });
    expect(seams.json).toHaveBeenCalledTimes(1);
  });

  it.each(["requester", "credit", "record"])("does not auto-pay a settled request after a restart (%s)", async (source) => {
    const jobId = `settled-${source}`;
    const request = msg(5, "payment-request", { amount_msats: 1000, reason: "Already settled" });
    saveJob({ id: jobId, endpoint: provider.endpoint, status: "awaiting-input", submittedAt: 0, policy,
      ...(source === "record" ? { paidPaymentRequestSeqs: [5] } : {}),
    });
    appendMessages(jobId, [request]);
    if (source === "requester") appendMessages(jobId, [{ ...msg(6, "payment", { amount_msats: 1000 }), from: "requester" } as Message]);
    if (source === "credit") bookCreditPayment(jobId, {
      request: request.content as never,
      authorization: { request_seq: 5, payment_id: "settled-credit" } as never,
    });
    transport([[request], []]);
    const result = await streamLoop({ jobId, provider, policy, transport: seams.transport, afterSeq: 0 });
    expect(seams.pay).not.toHaveBeenCalled();
    expect(result.nextAction).toMatchObject({ type: "poll" });
  });

  it("persists the settled seq before a new stream loop with a stale cursor", async () => {
    const jobId = "paid-before-restart";
    saveJob({ id: jobId, endpoint: provider.endpoint, status: "processing", submittedAt: 0, policy });
    const request = msg(5, "payment-request", { amount_msats: 1000, reason: "One block" });
    transport([[request], []]);
    await streamLoop({ jobId, provider, policy, transport: seams.transport, afterSeq: 0 });
    expect(loadJob(jobId)?.paidPaymentRequestSeqs).toEqual([5]);
    transport([[request], []]);
    const result = await streamLoop({ jobId, provider, policy, transport: seams.transport, afterSeq: 0 });
    expect(seams.pay).toHaveBeenCalledTimes(1);
    expect(result.autoPayments).toEqual([]);
    expect(result.nextAction).toMatchObject({ type: "poll" });
  });
});

describe("wait read bounds", () => {
  it.each([undefined, "2"])("reconnects an idle stream after the bounded read and backoff (timeout=%s)", async (timeout) => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const stream = transport([]);
    const start = Date.now();
    stream.mockImplementationOnce((_job, _after, _provider, options) => {
      calls.push(Date.now());
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => {
        reject(new DOMException("Idle stream", "AbortError"));
      }));
    }).mockImplementationOnce(async () => {
      calls.push(Date.now());
      return { messages: [msg(1, "prompt", { id: "wake", text: "Continue?" })] };
    });
    const pending = messages(`idle-${timeout ?? "default"}`, { wait: true, until: "2m", timeout });
    await vi.runAllTimersAsync();
    await pending;
    const bound = timeout ? 2000 : 60000;
    expect(calls).toEqual([start, start + bound + 1000]);
    expect(output().next_action).toMatchObject({ type: "respond", prompt_id: "wake" });
    expect(seams.transport.status).toHaveBeenNthCalledWith(1, expect.any(String), provider, { timeoutMs: bound, jobToken: undefined });
  });

  it("caps an idle stream by the remaining wait limit", async () => {
    vi.useFakeTimers();
    const stream = transport([]);
    stream.mockImplementation((_job, _after, _provider, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Idle stream", "AbortError")));
    }));
    const start = Date.now();
    const pending = messages("idle-deadline", { wait: true, until: "3s", timeout: "20" });
    await vi.runAllTimersAsync();
    await pending;
    expect(Date.now() - start).toBe(3000);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(output().next_action.type).toBe("poll");
  });
});

describe("follow-up command progress", () => {
  it.each(["pay", "message"])("%s returns poll on progress without another yield", async (command) => {
    const jobId = `progress-${command}`;
    saveJob({ id: jobId, endpoint: provider.endpoint, status: "processing", submittedAt: 0, policy, messageCursor: 5 });
    appendMessages(jobId, [msg(5, "payment-request", { amount_msats: 1000, reason: "A block" })]);
    transport([[msg(6, "progress", { percent_complete: 50 })]]);
    if (command === "pay") {
      vi.mocked(seams.transport.status).mockResolvedValue({ status: "awaiting-input" } as never);
      vi.mocked(seams.transport.getMessages).mockResolvedValue([msg(5, "payment-request", { amount_msats: 1000, reason: "A block" })]);
      await pay(jobId, {});
      expect(seams.pay).toHaveBeenCalledTimes(1);
    } else {
      await message(jobId, "yes", { type: "response", promptId: "choice" });
      expect(seams.transport.sendMessage).toHaveBeenCalledWith(jobId,
        { type: "response", content: { prompt_id: "choice", text: "yes" } }, provider, { jobToken: undefined });
    }
    expect(output().messages).toEqual([expect.objectContaining({ seq: 6, type: "progress" })]);
    expect(output().next_action).toMatchObject({ type: "poll", job_id: jobId });
  });
});

it("shell-quotes the paid-request hint and names the wait command", async () => {
  const jobId = "paid's job";
  transport([[msg(1, "payment-request", { amount_msats: 1000, reason: "One block" })], []]);
  const result = await streamLoop({ jobId, provider, policy, transport: seams.transport, afterSeq: 0 });
  expect(result.nextAction).toMatchObject({ type: "poll" });
  expect(result.nextAction?.hint).toContain("Payment already sent");
  expect(result.nextAction?.hint).toContain(String.raw`dvm messages 'paid'\''s job' --wait`);
});

it.each([true, false])("keeps terminal human refund output actionable only when unclaimed (claimed=%s)", async (claimed) => {
  transport([[msg(2, "payment", { amount_msats: 1000, reason: "change", cashu_token: "tok" }), msg(3, "complete", { summary: "Done" })]], "completed");
  seams.claim.mockResolvedValue([{ seq: 2, amount_msats: 1000, reason: "change", claimed, cashu_token: "tok" }]);
  await messages(`human-refund-${claimed}`, { human: true });
  const text = seams.info.mock.calls.flat().join("\n");
  if (claimed) {
    expect(text).toContain("Claimed change");
    expect(text).not.toContain("Next:");
  } else {
    expect(text).toContain("Next: Change");
    expect(text).toContain("dvm wallet receive-token tok");
  }
});

it.each([true, false])("does not add HTTP reads for plain JSON messages (stream=%s)", async (stream) => {
  transport([[msg(1, "working")]], "awaiting-input");
  vi.mocked(seams.transport.getMessages).mockResolvedValue([msg(1, "working")]);
  await messages(`plain-reads-${stream}`, { stream });
  expect(seams.transport.status).not.toHaveBeenCalled();
  expect(seams.transport.getMessages).toHaveBeenCalledTimes(stream ? 0 : 1);
});

it("does not recheck a previously settled over-threshold charge in plain messages", async () => {
  const jobId = "settled-read-count";
  saveJob({ id: jobId, endpoint: provider.endpoint, status: "processing", submittedAt: 0,
    policy, paidPaymentRequestSeqs: [5] });
  transport([[msg(5, "payment-request", { amount_msats: 3000, reason: "Already settled" })]]);
  await messages(jobId, { after: "0" });
  expect(output().next_action).toMatchObject({ type: "poll" });
  expect(seams.pay).not.toHaveBeenCalled();
  expect(seams.transport.stream).toHaveBeenCalledTimes(1);
  expect(seams.transport.getMessages).not.toHaveBeenCalled();
});

describe("terminal JSON incremental reads", () => {
  it.each([["completed", true], ["failed", true], ["cancelled", true], ["cancelled", false]] as const)(
    "returns null for stored %s with stream=%s and no extra HTTP reads", async (status, stream) => {
      const jobId = `terminal-${status}-${stream}`;
      saveJob({ id: jobId, endpoint: provider.endpoint, status, submittedAt: 0, policy, messageCursor: 9 });
      transport([], status);
      await messages(jobId, { stream });
      expect(output().next_action).toBeNull();
      expect(seams.transport.status).not.toHaveBeenCalled();
      expect(seams.transport.getMessages).toHaveBeenCalledTimes(stream ? 0 : 1);
    });

  it.each(["complete", "cancel"])("returns null for a %s batch without a stored terminal record", async (type) => {
    transport([[msg(10, type)]]);
    await messages(`terminal-batch-${type}`, {});
    expect(output().next_action).toBeNull();
    expect(seams.transport.status).not.toHaveBeenCalled();
    expect(seams.transport.getMessages).not.toHaveBeenCalled();
  });

  it("keeps an unclaimed refund ahead of a stored terminal record", async () => {
    const jobId = "stored-terminal-refund";
    saveJob({ id: jobId, endpoint: provider.endpoint, status: "completed", submittedAt: 0, policy, messageCursor: 9 });
    transport([[msg(10, "payment", { cashu_token: "tok", amount_msats: 1000 })]]);
    seams.claim.mockResolvedValue([{ seq: 10, amount_msats: 1000, reason: "change", claimed: false, cashu_token: "tok" }]);
    await messages(jobId, {});
    expect(output().next_action).toMatchObject({ type: "refund", claimed: false, cashu_token: "tok" });
    expect(seams.transport.status).not.toHaveBeenCalled();
    expect(seams.transport.getMessages).not.toHaveBeenCalled();
  });
});

it.each(["timeout", "AbortError"])("does not reconnect after %s inside a payment step", async (code) => {
  vi.useFakeTimers();
  const stream = transport([[msg(5, "payment-request", { amount_msats: 1000, reason: "One block" })]]);
  const failure = code === "timeout" ? new DvmError("timeout", "Payment reply lost") : new DOMException("Payment reply lost", "AbortError");
  seams.pay.mockRejectedValueOnce(failure);
  const pending = messages(`payment-${code}`, { wait: true, until: "3s" })
    .then(() => undefined, (error: unknown) => error);
  await vi.runAllTimersAsync();
  expect(await pending).toBe(failure);
  expect(stream).toHaveBeenCalledTimes(1);
  expect(seams.transport.status).toHaveBeenCalledTimes(1);
  expect(seams.transport.close).toHaveBeenCalledTimes(1);
});

it("keeps an uncertain send actionable without auto-paying in non-streamed JSON", async () => {
  const jobId = "uncertain's job";
  saveJob({ id: jobId, endpoint: provider.endpoint, status: "processing", submittedAt: 0,
    policy, inFlightPaymentRequestSeqs: [5], unconfirmedPaymentSubmissions: { 5: {
      rail: "x402", content: { x402_payment: "signed" }, requestAmountMsats: 1000, amountMsats: 1000, btcRate: 100_000 } } });
  transport([]);
  vi.mocked(seams.transport.getMessages).mockResolvedValue([msg(5, "payment-request", { amount_msats: 1000, reason: "One block" })]);
  await messages(jobId, { stream: false });
  expect(output().next_action).toMatchObject({ type: "pay", hint: expect.stringContaining("re-sends that same payment") });
  expect(output().next_action.hint).toContain("dvm pay '<job_id>'");
  expect(seams.pay).not.toHaveBeenCalled();
  expect(seams.transport.sendMessage).not.toHaveBeenCalled();
});

// An older CLI's in-flight record kept no copy, so `dvm pay` would refuse; the
// hint must not send the agent there and back.
it("names decline and cancel for an unconfirmed send this CLI cannot re-send", async () => {
  const jobId = "legacy's job";
  saveJob({ id: jobId, endpoint: provider.endpoint, status: "processing", submittedAt: 0,
    policy, inFlightPaymentRequestSeqs: [5] });
  transport([]);
  vi.mocked(seams.transport.getMessages).mockResolvedValue([msg(5, "payment-request", { amount_msats: 1000, reason: "One block" })]);
  await messages(jobId, { stream: false });
  const hint = output().next_action.hint;
  expect(hint).toContain("No new payment will be signed");
  expect(hint).toContain("dvm decline '<job_id>'");
  expect(hint).toContain("dvm cancel '<job_id>'");
  expect(hint).not.toContain("dvm pay");
  expect(seams.transport.sendMessage).not.toHaveBeenCalled();
});

// These reads may time out while a long-running provider remains healthy.
describe("wait metadata read retries", () => {
  it.each(["status", "initial history", "terminal history"])("reconnects with backoff after a %s timeout", async (boundary) => {
    vi.useFakeTimers();
    const start = Date.now();
    const jobId = `read-timeout-${boundary}`;
    saveJob({ id: jobId, endpoint: provider.endpoint, status: "processing", submittedAt: 0, policy });
    const stream = transport([[msg(7, "prompt", { id: "question", text: "Continue?" })]],
      boundary === "initial history" ? "awaiting-input" : boundary === "terminal history" ? "completed" : "processing");
    const read = boundary === "status" ? seams.transport.status : seams.transport.getMessages;
    vi.mocked(read).mockRejectedValueOnce(new DvmError("timeout", "Read timed out"));
    const pending = messages(jobId, { wait: true, until: "1m" }).then(() => undefined, (error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await pending).toBeUndefined();
    expect(Date.now() - start).toBe(1000);
    expect(read).toHaveBeenCalledTimes(2);
    if (boundary === "terminal history") expect(output().next_action).toBeNull();
    else expect(output().next_action).toMatchObject({ type: "respond", prompt_id: "question" });
    expect(stream).toHaveBeenCalledTimes(boundary === "terminal history" ? 0 : 1);
  });
});

// A metered job's paid ask stays the last yield while the work carries on, so
// the expired wait must not read as a payment still being finalised.
it("names the wait limit when --until expires on a running job with nothing in flight", async () => {
  vi.useFakeTimers();
  const jobId = "until-expired";
  saveJob({ id: jobId, endpoint: provider.endpoint, status: "processing", submittedAt: 0, policy });
  const stream = transport([]);
  const ask = msg(1, "payment-request", { amount_msats: 1000, reason: "Hour two" });
  stream.mockImplementationOnce(async (_job, _after, _provider, options) => {
    options.onMessage?.(ask);
    return { messages: [ask] };
  });
  // After the payment the stream stays attached, collecting progress until the wait limit cuts it.
  stream.mockImplementationOnce((_job, _after, _provider, options) => new Promise((resolve) => {
    options.signal.addEventListener("abort", () => resolve({ messages: [msg(2, "progress", { percent_complete: 10 })] }));
  }));
  const pending = messages(jobId, { wait: true, until: "30s" });
  await vi.runAllTimersAsync();
  await pending;
  expect(streamed("payment")).toHaveLength(1);
  const action = output().next_action;
  expect(action).toMatchObject({ type: "poll", job_id: jobId });
  expect(action.hint).toContain("wait limit (30s)");
  expect(action.hint).toContain(`dvm messages ${jobId} --wait`);
  expect(action.hint).not.toMatch(/payment|finalising|pay again/i);
});

// Figures from a USD budget converted once at submit: 961 sats paid, a 69-sat ask,
// a 1,029.527-sat budget. Rounded to whole sats the ask would appear to fit, so
// every figure is stated in exact msats.
it("names the budget, the spend so far and the ask when an ask would exceed the job's budget", async () => {
  const jobId = "budget-exhausted";
  const budgetPolicy: JobPolicy = { maxTotalMsats: 1_029_527, autoPayBelowMsats: 823_621, maxIncrementMsats: 0, maxPayments: 8 };
  saveJob({ id: jobId, endpoint: provider.endpoint, status: "processing", submittedAt: 0,
    policy: budgetPolicy, totalPaidMsats: 961_000, paymentsHonoured: 4 });
  transport([[msg(9, "payment-request", { amount_msats: 69_000, reason: "Hour five" })]], "awaiting-input");
  seams.pay.mockResolvedValue("over-budget");
  await messages(jobId, { wait: true, until: "1m" });
  // The refusal's figures ride the stream's final line, after the ask itself.
  expect(seams.lines.map((line) => line.event === "message" ? line.seq : line.event)).toEqual([9, "result"]);
  const action = output().next_action;
  expect(action).toMatchObject({ type: "pay", amount_msats: 69_000 });
  const text = `${action.display} ${action.hint}`;
  expect(text).toContain("budget");
  expect(text).toContain("961,000 msats spent so far plus 69,000 msats asked comes to 1,030,000 msats, " +
    "473 msats over the 1,029,527 msats budget.");
  expect(action.hint).toContain(`dvm decline ${jobId}`);
  // `dvm pay` refuses an ask over the job's budget, so the hint must not send the agent there.
  expect(action.hint).not.toContain("then run `dvm pay");
});

// The limit must not bury a held payment: its guidance is what stops a second payment for the same charge.
it.each(["processing", "awaiting-input"])("keeps the held-payment guidance when the wait limit passes (provider %s)", async (status) => {
  vi.useFakeTimers();
  const jobId = `held-at-limit-${status}`;
  const submission = { rail: "x402", content: { x402_payment: "signed" }, requestAmountMsats: 1000, amountMsats: 1000, btcRate: 100_000 };
  saveJob({ id: jobId, endpoint: provider.endpoint, status: "processing", submittedAt: 0, policy,
    inFlightPaymentRequestSeqs: [5], inFlightPaymentRequestStartedAtMs: { 5: Date.now() },
    unconfirmedPaymentSubmissions: { 5: submission } } as never);
  const stream = transport([], status);
  stream.mockImplementation((_job, _after, _provider, options) => new Promise((resolve) => {
    options.signal?.addEventListener("abort", () => resolve({ messages: [] }));
  }));
  vi.mocked(seams.transport.getMessages).mockResolvedValue([msg(5, "payment-request", { amount_msats: 1000, reason: "One block" })]);
  const pending = messages(jobId, { wait: true, until: "30s" });
  await vi.runAllTimersAsync();
  await pending;
  const hint = output().next_action.hint;
  expect(output().next_action.type).toBe("poll");
  expect(hint).toContain("wait limit (30s)");
  expect(hint).toContain("earlier payment for this job is unconfirmed");
  expect(hint).toContain("re-sends that same payment rather than signing a new one");
  expect(hint).not.toContain("still running");
  expect(seams.pay).not.toHaveBeenCalled();
});

it("does not claim a job is running when the wait limit passes before any read", async () => {
  const jobId = "zero-wait";
  saveJob({ id: jobId, endpoint: provider.endpoint, status: "processing", submittedAt: 0, policy });
  const stream = transport([]);
  await messages(jobId, { wait: true, until: "0s" });
  const hint = output().next_action.hint;
  expect(stream).not.toHaveBeenCalled();
  expect(hint).toContain("state is unknown");
  expect(hint).toContain(`dvm status ${jobId}`);
  expect(hint).not.toContain("still running");
  expect(hint).not.toContain("--until 0s");
});

describe("wait stream recovery", () => {
  it("writes a payment confirmed by reconciliation within a second, while the stream stays quiet", async () => {
    vi.useFakeTimers();
    const jobId = "wait-quiet-booking";
    const ask = msg(5, "payment-request", { amount_msats: 1000, reason: "Quiet block" });
    const paid = { ...msg(6, "payment", { x402_payment: "signed" }), from: "requester" } as Message;
    saveJob({ id: jobId, endpoint: provider.endpoint, status: "processing", submittedAt: 0, policy });
    const stream = transport([]);
    stream.mockImplementationOnce(async (_job, _after, _provider, options) => {
      options.onMessage?.(ask);
      return { messages: [ask] };
    });
    stream.mockImplementationOnce(async (_job, _after, _provider, options) => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const done = msg(7, "complete", { summary: "Done" });
      for (const message of [ask, paid, done]) options.onMessage?.(message);
      return { messages: [ask, paid, done] };
    });
    vi.mocked(seams.transport.getMessages).mockResolvedValue([ask, paid]);
    seams.pay.mockImplementationOnce(async () => {
      markPaymentRequestInFlight(jobId, 5, { rail: "x402", content: { x402_payment: "signed" },
        requestAmountMsats: 1000, amountMsats: 1000, btcRate: 100_000, approval: "auto" });
      throw new DvmError("payment_unconfirmed", "Reply not confirmed yet");
    });
    const pending = messages(jobId, { wait: true });
    await vi.advanceTimersByTimeAsync(2_001);
    expect(loadJob(jobId)?.totalPaidMsats).toBe(1000);
    expect(seams.json).not.toHaveBeenCalled();
    expect(streamed("payment")).toHaveLength(1);
    await vi.runAllTimersAsync();
    await pending;
    expect(streamed("payment")).toHaveLength(1);
  });

  it("gives a recovered x402 payment its exact USDC amount, as a sent one has", () => {
    const jobId = "wait-recovered-usdc";
    const ask = msg(5, "payment-request", { amount_msats: 1000, reason: "Signed amount" });
    saveJob({ id: jobId, endpoint: provider.endpoint, status: "processing", submittedAt: 0, policy });
    appendMessages(jobId, [ask]);
    const report = vi.fn();
    transport([]);
    const paymentLines = createWaitPaymentLines({ jobId, provider, transport: seams.transport, afterSeq: 0, onAutoPayment: report });
    paymentLines.onMessage(ask);
    markPaymentRequestInFlight(jobId, 5, { rail: "x402", content: { x402_payment: "signed" },
      requestAmountMsats: 1000, amountMsats: 1000, amountUsdcMicro: "1000", btcRate: 100_000, approval: "auto" });
    markPaymentRequestPaid(jobId, 5);
    expect(report).toHaveBeenCalledTimes(1);
    paymentLines.finish();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({ amount_usdc_microunits: "1000", display: expect.stringContaining("USDC"),
      reason: { _source: "provider", text: "Signed amount" } });
  });

  it("repeats an open ask after an error exit, but not an ask it already paid", async () => {
    const jobId = "wait-paid-ask-resume";
    const paidAsk = msg(1, "payment-request", { amount_msats: 1000, reason: "Paid block" });
    const artifact = msg(2, "artifact", { mime_type: "image/jpeg", url: "https://dvm.example/picture.jpg" });
    const openAsk = msg(3, "payment-request", { amount_msats: 1000, reason: "Open block" });
    saveJob({ id: jobId, endpoint: provider.endpoint, status: "processing", submittedAt: 0, policy, messageCursor: 0 });
    transport([[paidAsk], [artifact, openAsk]]);
    seams.pay.mockResolvedValueOnce({ status: "paid", rail: "cashu_p2pk", amountMsats: 1000 })
      .mockResolvedValueOnce("payment-cap-exceeded");
    await expect(messages(jobId, { wait: true })).rejects.toMatchObject({ code: "payment_cap_exceeded" });
    expect(loadJob(jobId)?.paidPaymentRequestSeqs).toContain(1);
    expect(loadJob(jobId)?.waitDeliveredSeq).toBe(3);
    seams.lines.length = 0;
    transport([[paidAsk, artifact, openAsk], [msg(4, "prompt", { id: "q", text: "Continue?" })]]);
    await messages(jobId, { wait: true });
    expect(streamedSeqs()).toEqual([3, 4]);
  });

  it.each([false, true])("reads every later message for an explicit --after, whatever was delivered (older record=%s)", async (olderRecord) => {
    const jobId = `wait-explicit-after-${olderRecord}`;
    saveJob({ id: jobId, endpoint: provider.endpoint, status: "processing", submittedAt: 0, policy, messageCursor: 0,
      ...(olderRecord ? {} : { waitDeliveredSeq: 10 }) });
    transport([[msg(3, "text", { text: "Before after" }), msg(5, "artifact", { mime_type: "image/jpeg", url: "https://dvm.example/picture.jpg" }),
      msg(6, "prompt", { id: "q", text: "Continue?" })]]);
    await messages(jobId, { wait: true, after: "4" });
    expect(streamedSeqs()).toEqual([5, 6]);
    expect(output().next_action).toMatchObject({ type: "respond", prompt_id: "q" });
  });

  it.each(["prompt", "payment-request"])("repeats a delivered %s that is still open, and keeps it actionable", async (type) => {
    const jobId = `wait-open-${type}`;
    const content = type === "prompt" ? { id: "q", text: "Continue?" } : { amount_msats: 3000, reason: "Open block" };
    saveJob({ id: jobId, endpoint: provider.endpoint, status: "processing", submittedAt: 0, policy, messageCursor: 0, waitDeliveredSeq: 5 });
    transport([[msg(5, type, content)]]);
    await messages(jobId, { wait: true });
    expect(streamedSeqs()).toEqual([5]);
    expect(output().next_action.type).toBe(type === "prompt" ? "respond" : "pay");
  });

  it("keeps what was delivered when an explicit replay exits early, so a picture is not repeated", async () => {
    const jobId = "wait-replay-watermark";
    saveJob({ id: jobId, endpoint: provider.endpoint, status: "processing", submittedAt: 0, policy, messageCursor: 0, waitDeliveredSeq: 10 });
    transport([[msg(1, "text", { text: "Replay" }), msg(2, "payment-request", { amount_msats: 1000, reason: "Old open ask" })]]);
    seams.pay.mockResolvedValueOnce("payment-cap-exceeded");
    await expect(messages(jobId, { wait: true, after: "0" })).rejects.toMatchObject({ code: "payment_cap_exceeded" });
    expect(loadJob(jobId)?.waitDeliveredSeq).toBe(10);
    seams.lines.length = 0;
    transport([[msg(5, "artifact", { mime_type: "image/jpeg", url: "https://dvm.example/picture.jpg" }),
      msg(6, "payment-request", { amount_msats: 1000, reason: "New open ask" })],
    [msg(7, "prompt", { id: "q", text: "Continue?" })]]);
    await messages(jobId, { wait: true });
    expect(streamedSeqs()).toEqual([6, 7]);
  });
});
