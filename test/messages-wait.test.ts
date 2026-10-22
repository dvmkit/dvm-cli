import { createServer } from "node:http";
import { once } from "node:events";
import { HttpsTransport } from "../src/lib/transport/https";
import { DvmError, type JobPolicy, type Message, type Transport } from "@dvmkit/sdk/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  transport: {} as Transport,
  pay: vi.fn(), claim: vi.fn(), json: vi.fn(), info: vi.fn(),
}));
vi.mock("../src/lib/transport", () => ({ createDvmTransport: () => seams.transport }));
vi.mock("../src/lib/payment-responder", () => ({ handlePaymentRequest: seams.pay }));
vi.mock("../src/lib/refund-claim", async (original) => ({
  ...(await original<typeof import("../src/lib/refund-claim")>()),
  claimInboundPayments: seams.claim,
  refundJsonField: async (claims: unknown[]) => claims.length ? { refund: claims.at(-1) } : {},
}));
vi.mock("../src/lib/output", () => ({ info: seams.info, json: seams.json }));
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
import { pay } from "../src/commands/pay";
import { message } from "../src/commands/message";
import { streamLoop } from "../src/lib/stream-loop";
import { appendMessages } from "../src/lib/messages";
import { loadJob, saveJob, bookCreditPayment, markPaymentRequestInFlight } from "../src/lib/job-store";
const provider = { endpoint: "https://dvm.example" };
const policy: JobPolicy = { maxTotalMsats: 100_000, autoPayBelowMsats: 2000, maxIncrementMsats: 0, maxPayments: 5 };
function msg(seq: number, type: string, content: unknown = {}): Message {
  return { seq, from: "provider", timestamp: seq, type, content } as Message;
}
function transport(batches: Message[][], status = "processing") {
  const stream = vi.fn();
  for (const batch of batches) stream.mockResolvedValueOnce({ messages: batch });
  stream.mockResolvedValue({ messages: [] });
  seams.transport = {
    stream, status: vi.fn().mockResolvedValue({ status }),
    getMessages: vi.fn().mockResolvedValue([]), close: vi.fn(), sendMessage: vi.fn().mockResolvedValue(undefined),
  } as unknown as Transport;
  return stream;
}
const output = () => seams.json.mock.calls.at(-1)![0];
beforeEach(() => {
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
    expect(output().next_action).toMatchObject({ type: "respond", prompt_id: "choice", options: ["yes", "no"] });
    expect(output().auto_payments).toHaveLength(3);
    expect(output().messages.map((m: Message) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
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
    stream.mockImplementation(async (_job, after) => ({ messages: history.filter((message) => message.seq > after) }));
    vi.mocked(seams.transport.getMessages).mockResolvedValue(history);
    await messages(jobId, { wait: true, ...(explicit ? { after: "4" } : {}) });
    expect(output().cursor).toBe(4);
    expect(output().messages.map((message: Message) => message.seq)).toEqual([5, 6, 7]);
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
      expect(output().auto_payments).toHaveLength(3);
      expect(output().messages.map((m: Message) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
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
    const stream = transport([]);
    stream.mockRejectedValueOnce(new DvmError("timeout", "Read timed out"))
      .mockResolvedValueOnce({ messages: [msg(1, "complete", { summary: "Done" })] });
    const pending = messages("wait-retry", { wait: true });
    await vi.runAllTimersAsync();
    await pending;
    expect(output().next_action).toBeNull();
    expect(output().messages).toHaveLength(1);
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
    expect(output().messages.map((m: Message) => m.type)).toEqual(["working", "artifact", "complete"]);
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
    expect(output().messages.filter((m: Message) => m.seq === 5)).toHaveLength(1);
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
    expect(output().next_action).toEqual({ type: "refund", job_id: expect.any(String), amount_msats: 1000, reason: "change", claimed: false, cashu_token: "tok", display: expect.any(String), hint: expect.stringContaining("dvm wallet receive-token") });
  });
  it("retains terminal refund recovery in streamed JSON", async () => {
    transport([[msg(2, "payment", { amount_msats: 1000, reason: "change", cashu_token: "tok" }), msg(3, "complete", { summary: "Done" })]], "completed");
    seams.claim.mockResolvedValue([{ seq: 2, amount_msats: 1000, reason: "change", claimed: false, cashu_token: "tok" }]);
    await messages("term-refund2", {});
    expect(output().next_action).toEqual({ type: "refund", job_id: expect.any(String), amount_msats: 1000, reason: "change", claimed: false, cashu_token: "tok", display: expect.any(String), hint: expect.stringContaining("dvm wallet receive-token") });
  });
  it("preserves terminal refund recovery in non-streamed JSON", async () => {
    transport([], "completed");
    vi.mocked(seams.transport.getMessages).mockResolvedValue([msg(2, "payment", { amount_msats: 1000, reason: "change", cashu_token: "tok" }), msg(3, "complete", { summary: "Done" })]);
    seams.claim.mockResolvedValue([{ seq: 2, amount_msats: 1000, reason: "change", claimed: false, cashu_token: "tok" }]);
    await messages("term-refund3", { stream: false });
    expect(output().next_action).toEqual({ type: "refund", job_id: expect.any(String), amount_msats: 1000, reason: "change", claimed: false, cashu_token: "tok", display: expect.any(String), hint: expect.stringContaining("dvm wallet receive-token") });
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
    expect(output().messages.at(-1).type).toBe("complete");
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
    policy, inFlightPaymentRequestSeqs: [5] });
  transport([]);
  vi.mocked(seams.transport.getMessages).mockResolvedValue([msg(5, "payment-request", { amount_msats: 1000, reason: "One block" })]);
  await messages(jobId, { stream: false });
  expect(output().next_action).toMatchObject({ type: "pay", hint: expect.stringContaining("payment may already have been sent") });
  expect(output().next_action.hint).toContain(String.raw`dvm pay 'uncertain'\''s job'`);
  expect(seams.pay).not.toHaveBeenCalled();
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
