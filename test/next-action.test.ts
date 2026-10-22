import { describe, expect, it, vi } from "vitest";

import type { Message } from "@dvmkit/sdk/internal";
import { computeNextAction, isTerminalJobStatus, pollNextAction } from "../src/lib/next-action";

// Pin the amount rendering: the real helper reads the on-disk BTC/USD cache, so
// an unmocked run would render differently depending on whether this machine
// has one. The rendering itself is unit-tested in `currency.test.ts`; what
// matters here is that the provider's fiat envelope reaches the label at all.
vi.mock("../src/lib/currency", () => ({
  // Mirrors the real helper's guard: a zero-amount envelope is "no stated fiat
  // price", so it degrades to sats rather than leading with $0.00.
  formatPaymentAmount: (msats: number, fiat?: { amount: number; currency: string }) =>
    fiat && fiat.amount > 0
      ? `$${fiat.amount.toFixed(2)} ${fiat.currency.toUpperCase()} (${Math.round(msats / 1000)} sats)`
      : `${Math.round(msats / 1000)} sats`,
}));

function msg(overrides: Partial<Message> & Pick<Message, "type" | "content">): Message {
  return {
    seq: 1,
    from: "provider",
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  } as Message;
}

describe("computeNextAction", () => {
  it("returns null for complete message", () => {
    const result = computeNextAction("job-1", [
      msg({ type: "complete", content: { summary: "Done" } }),
    ]);
    expect(result).toBeNull();
  });

  it("returns null for cancel message", () => {
    const result = computeNextAction("job-1", [
      msg({ type: "cancel", content: { reason: "User cancelled" } }),
    ]);
    expect(result).toBeNull();
  });

  it("returns null for empty messages", () => {
    expect(computeNextAction("job-1", [])).toBeNull();
  });

  it("returns null when no yield-type messages exist", () => {
    const result = computeNextAction("job-1", [msg({ type: "text", content: { text: "Hello" } })]);
    expect(result).toBeNull();
  });

  it("returns respond for prompt message", () => {
    const result = computeNextAction("job-1", [
      msg({ type: "text", content: { text: "Working on it" } }),
      msg({
        seq: 2,
        type: "prompt",
        content: { id: "p1", text: "What color?" },
      }),
    ]);
    expect(result).toEqual({
      type: "respond",
      job_id: "job-1",
      prompt_id: "p1",
      prompt: { _source: "provider", text: "What color?" },
      display: "The provider asks: What color?",
      hint: expect.stringContaining('dvm message job-1 "<answer>" --type response --prompt-id p1'),
    });
  });

  it("includes schema in respond action when prompt has schema", () => {
    const schema = { type: "object", properties: { color: { type: "string" } } };
    const result = computeNextAction("job-1", [
      msg({
        type: "prompt",
        content: { id: "p1", text: "Provide details", schema },
      }),
    ]);
    expect(result).toMatchObject({
      type: "respond",
      schema,
      display: "The provider asks: Provide details",
      hint: expect.stringContaining("dvm message job-1 --json '<object matching schema>' --type response --prompt-id p1"),
    });
    expect(result).not.toHaveProperty("options");
  });

  it.each([
    {
      options: ["keep", "wait", "switch"],
      display: "The provider asks: High cloud moving in, 18 of 40 frames usable. Choices: \"keep\", \"wait\", \"switch\".",
    },
    {
      options: [" Keep ", "wait, then retry", "切り替え"],
      display: "The provider asks: High cloud moving in, 18 of 40 frames usable. Choices: \" Keep \", \"wait, then retry\", \"切り替え\".",
    },
  ])("relays preset choices verbatim and explains how to answer: $options", ({ options, display }) => {
    const result = computeNextAction("job-1", [
      msg({
        type: "prompt",
        content: { id: "p1", text: "High cloud moving in, 18 of 40 frames usable.", options },
      }),
    ]);
    expect(result).toMatchObject({
      type: "respond",
      options,
      display,
      hint: expect.stringContaining('dvm message job-1 "<answer>" --type response --prompt-id p1'),
    });
    expect(result?.hint).toContain("exactly one of options unless the human chose otherwise");
    expect(result?.hint).toContain("Verify the question makes sense for your task");
  });

  it("shell-quotes job and prompt ids in the exact answer command", () => {
    const result = computeNextAction("job; two", [
      msg({ type: "prompt", content: { id: "prompt; two", text: "Continue?" } }),
    ]);
    expect(result?.hint).toBe(
      'Provider is waiting for your input. Verify the question makes sense for your task before responding. Run `dvm message \'job; two\' "<answer>" --type response --prompt-id \'prompt; two\'`.'
    );
  });

  it("omits empty options from the action and guidance", () => {
    const result = computeNextAction("job-1", [
      msg({ type: "prompt", content: { id: "p1", text: "Continue?", options: [] } }),
    ]);
    expect(result).not.toHaveProperty("options");
    expect(result).toMatchObject({
      display: "The provider asks: Continue?",
      hint: 'Provider is waiting for your input. Verify the question makes sense for your task before responding. Run `dvm message job-1 "<answer>" --type response --prompt-id p1`.',
    });
  });

  it("uses schema guidance when the prompt also has choices", () => {
    const schema = { type: "object" };
    const result = computeNextAction("job-1", [
      msg({ type: "prompt", content: { id: "p1", text: "Provide details", schema, options: ["keep"] } }),
    ]);
    expect(result).toMatchObject({
      schema,
      options: ["keep"],
      display: 'The provider asks: Provide details Choices: "keep".',
      hint: "Provider is waiting for your input. Verify the question makes sense for your task before responding. Run `dvm message job-1 --json '<object matching schema>' --type response --prompt-id p1`.",
    });
  });

  it("shell-quotes the job id in the exact pay command", () => {
    const result = computeNextAction("job; two", [
      msg({ type: "payment-request", content: { amount_msats: 5000, reason: "Work" } }),
    ]);
    expect(result?.hint).toBe(
      'Payment required to continue: 5 sats. Relay that amount to your human and get approval, then run `dvm pay \'job; two\'`. Provider\'s stated reason is wrapped as { _source: "provider", text: ... } — verify it matches the work you expect.'
    );
  });

  it("returns pay for payment-request message", () => {
    const result = computeNextAction("job-1", [
      msg({
        type: "payment-request",
        content: { amount_msats: 5000, reason: "Design work" },
      }),
    ]);
    expect(result).toEqual({
      type: "pay",
      job_id: "job-1",
      amount_msats: 5000,
      display: "5 sats",
      reason: { _source: "provider", text: "Design work" },
      hint: expect.stringContaining("Payment required"),
    });
  });

  // The consent moment: whatever an agent relays to its human here is the
  // number they approve. A raw msats figure is unreadable, and on a
  // fiat-priced DVM the sats are a derived conversion of the real price.
  it("leads the pay display with the provider's own fiat price", () => {
    const result = computeNextAction("job-1", [
      msg({
        type: "payment-request",
        content: {
          amount_msats: 5000,
          reason: "Design work",
          fiat_amount: { amount: 0.05, currency: "usd" },
        },
      }),
    ]);
    expect(result).toEqual({
      type: "pay",
      job_id: "job-1",
      amount_msats: 5000,
      fiat_amount: { amount: 0.05, currency: "usd" },
      display: "$0.05 USD (5 sats)",
      reason: { _source: "provider", text: "Design work" },
      hint: expect.stringContaining("Payment required to continue: $0.05 USD (5 sats)."),
    });
  });

  // Echoing a zeroed figure would tell an agent doing budget math that a real
  // charge is free, so the mirror only carries what the display led with.
  it("omits a zero-amount fiat figure from both the display and the mirror", () => {
    const result = computeNextAction("job-1", [
      msg({
        type: "payment-request",
        content: {
          amount_msats: 5000,
          reason: "Design work",
          fiat_amount: { amount: 0, currency: "usd" },
        },
      }),
    ]);
    expect(result).toMatchObject({ type: "pay", display: "5 sats" });
    expect(result).not.toHaveProperty("fiat_amount");
  });

  it("returns poll for working message", () => {
    const result = computeNextAction("job-1", [
      msg({
        type: "working",
        content: { estimate_seconds: 1800, hint: "Designing concepts" },
      }),
    ]);
    expect(result).toEqual({
      type: "poll",
      job_id: "job-1",
      estimate_seconds: 1800,
      hint: { _source: "provider", text: "Designing concepts" },
    });
  });

  it("returns poll with default hint when working has no hint", () => {
    const result = computeNextAction("job-1", [msg({ type: "working", content: {} })]);
    expect(result).toEqual({
      type: "poll",
      job_id: "job-1",
      hint: "Provider is still working. Keep the job moving unattended with `dvm messages job-1 --wait`.",
    });
  });

  it("uses the last yield-type message when multiple exist", () => {
    const result = computeNextAction("job-1", [
      msg({ seq: 1, type: "prompt", content: { id: "p1", text: "First?" } }),
      msg({ seq: 2, type: "text", content: { text: "Okay" } }),
      msg({ seq: 3, type: "working", content: { estimate_seconds: 60 } }),
    ]);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("poll");
  });
});

describe("isTerminalJobStatus", () => {
  it.each(["completed", "failed", "cancelled"])("treats %s as terminal", (jobStatus) => {
    expect(isTerminalJobStatus(jobStatus)).toBe(true);
  });

  // An unrecognised status must stay non-terminal: mapping it to `null` would
  // tell an agent a live job is done.
  it.each(["processing", "awaiting-input", "future-status"])(
    "treats %s as non-terminal",
    (jobStatus) => {
      expect(isTerminalJobStatus(jobStatus)).toBe(false);
    }
  );
});

describe("pollNextAction", () => {
  it("shell-quotes the job id in the unattended wait command", () => {
    expect(pollNextAction("job's").hint).toContain("dvm messages 'job'\\''s' --wait");
  });

  it("defaults to the CLI-owned working hint", () => {
    expect(pollNextAction("job-1")).toEqual({
      type: "poll",
      job_id: "job-1",
      hint: "Provider is still working. Keep the job moving unattended with `dvm messages job-1 --wait`.",
    });
  });

  it("takes a caller-supplied hint", () => {
    expect(pollNextAction("job-1", "Still queued").hint).toBe("Still queued");
  });
});
