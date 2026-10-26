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
  describe.each([
    { type: "prompt", message: (expires_at_ms?: number) => msg({ type: "prompt", content: { id: "p1", text: "Continue?", expires_at_ms } }),
      action: "respond", verb: "Answer", display: "The provider asks: Continue?", legacyDisplay: "The provider asks: Continue?" },
    { type: "payment-request", message: (expires_at_ms?: number) => msg({ type: "payment-request", content: { amount_msats: 5000, reason: "Work", expires_at_ms } }),
      action: "pay", verb: "Pay", display: "5 sats.", legacyDisplay: "5 sats" },
  ])("$type deadlines", ({ message, action, verb, display, legacyDisplay }) => {
    const expires = Date.parse("2030-01-02T02:40:00Z");
    const now = Date.parse("2030-01-01T23:30:00Z");

    it("copies the deadline and relays UTC time and remaining time across midnight", () => {
      const result = computeNextAction("job-1", [message(expires)], now);
      expect(result).toMatchObject({ type: action, expires_at_ms: expires,
        display: `${display} ${verb} by 2030-01-02 02:40 UTC (in 3 h 10 min), or the provider cancels the job.` });
      expect(result?.hint).toContain(`${verb} by 2030-01-02 02:40 UTC (in 3 h 10 min), or the provider cancels the job.`);
    });

    it.each([expires, expires + 60_000])("reports a passed deadline without a negative duration at %i", (clock) => {
      const result = computeNextAction("job-1", [message(expires)], clock);
      expect(result).toMatchObject({ expires_at_ms: expires,
        display: `${display} The deadline to ${verb.toLowerCase()} (2030-01-02 02:40 UTC) has passed. The provider will probably cancel the job. Check its status with \`dvm status job-1\`.` });
      expect(result?.hint).toBe(`The deadline to ${verb.toLowerCase()} (2030-01-02 02:40 UTC) has passed. The provider will probably cancel the job. Check its status with \`dvm status job-1\`.`);
    });

    it.each([
      { remaining: 30_000, duration: "less than 1 min" },
      { remaining: 60_000, duration: "1 min" },
      { remaining: 3_600_000, duration: "1 h" },
      { remaining: 48 * 3_600_000, duration: "48 h" },
      { remaining: 48 * 3_600_000 + 60_000, duration: "2 days" },
      { remaining: 49 * 3_600_000, duration: "2 days 1 h" },
      { remaining: 72 * 3_600_000, duration: "3 days" },
      { remaining: (6 * 24 + 23) * 3_600_000 + 59 * 60_000, duration: "6 days 23 h" },
    ])("keeps a positive $duration duration readable", ({ remaining, duration }) => {
      const result = computeNextAction("job-1", [message(expires)], expires - remaining);
      expect(result).toMatchObject({ display: expect.stringContaining(`(in ${duration}), or the provider cancels the job.`) });
    });

    it.each([1e300, "soon", null, -1, 1.5, 8_640_000_000_000_001])("ignores malformed expiry %s and preserves the complete legacy action", (expiry) => {
      const malformed = message();
      Object.assign(malformed.content, { expires_at_ms: expiry });
      const result = computeNextAction("job-1", [malformed], now);
      expect(result).toEqual(computeNextAction("job-1", [message()], now));
      expect(result).not.toHaveProperty("expires_at_ms");
      expect(result).toMatchObject({ display: legacyDisplay });
      expect(result?.hint).not.toMatch(/deadline|cancel/);
    });

    it("leaves older messages without a deadline unchanged", () => {
      const result = computeNextAction("job-1", [message()], now);
      expect(result).not.toHaveProperty("expires_at_ms");
      expect(result).toMatchObject({ display: legacyDisplay });
    });
  });

  it.each(["prompt", "payment-request"] as const)("uses the earliest pending deadline when the latest ask is a %s", (latestType) => {
    const early = Date.parse("2030-01-02T02:40:00Z");
    const late = Date.parse("2030-01-02T03:40:00Z");
    const messages = [
      msg({ seq: 1, type: "prompt", content: { id: "first", text: "First?", expires_at_ms: early } }),
      latestType === "prompt"
        ? msg({ seq: 2, type: "prompt", content: { id: "second", text: "Second?", expires_at_ms: late } })
        : msg({ seq: 2, type: "payment-request", content: { amount_msats: 5000, reason: "Work", expires_at_ms: late } }),
    ];
    const result = computeNextAction("job-1", messages, early - 600_000);
    expect(result).toMatchObject({ expires_at_ms: early });
    expect(result).toMatchObject({ display: expect.stringContaining("by 2030-01-02 02:40 UTC (in 10 min)") });
    expect(result?.hint).toContain("by 2030-01-02 02:40 UTC (in 10 min)");
  });

  it.each(["answered prompt", "replaced prompt", "paid charge", "replaced charge", "zero charge"])("excludes the %s from the pending deadline", (settled) => {
    const early = Date.parse("2030-01-02T02:40:00Z");
    const late = Date.parse("2030-01-02T03:40:00Z");
    const isPrompt = settled.includes("prompt");
    const messages: Message[] = [isPrompt
      ? msg({ seq: 1, type: "prompt", content: { id: "first", text: "First?", expires_at_ms: early } })
      : msg({ seq: 1, type: "payment-request", content: { amount_msats: settled === "zero charge" ? 0 : 5000, reason: "Work", expires_at_ms: early } })];
    if (settled === "answered prompt") messages.push(msg({ seq: 2, from: "requester", type: "response", content: { prompt_id: "first", text: "Yes" } }));
    if (settled === "paid charge") messages.push(msg({ seq: 2, from: "requester", type: "payment", content: { amount_msats: 5000 } }));
    if (settled === "replaced charge") messages.push(msg({ seq: 2, type: "payment-request", content: { amount_msats: 5000, reason: "Revised", expires_at_ms: late } }));
    messages.push(msg({ seq: 3, type: "prompt", content: { id: settled === "replaced prompt" ? "first" : "latest", text: "Continue?", expires_at_ms: late } }));
    const result = computeNextAction("job-1", messages, early - 600_000);
    expect(result).toMatchObject({ type: "respond", expires_at_ms: late });
    expect(result).toMatchObject({ display: expect.stringContaining("by 2030-01-02 03:40 UTC (in 1 h 10 min)") });
  });

  it("uses a pending payment deadline even when the latest prompt has none", () => {
    const expires = Date.parse("2030-01-02T02:40:00Z");
    const result = computeNextAction("job-1", [
      msg({ seq: 1, type: "payment-request", content: { amount_msats: 5000, reason: "Work", expires_at_ms: expires } }),
      msg({ seq: 2, type: "prompt", content: { id: "latest", text: "Continue?" } }),
    ], expires - 60_000);
    expect(result).toMatchObject({ type: "respond", expires_at_ms: expires });
    expect(result).toMatchObject({ display: expect.stringContaining("by 2030-01-02 02:40 UTC (in 1 min)") });
  });

  it.each([
    { firstType: "prompt", latestType: "payment-request" },
    { firstType: "payment-request", latestType: "prompt" },
    { firstType: "prompt", latestType: "prompt" },
  ] as const)("uses neutral wording when $firstType sets the deadline for a later $latestType", ({ firstType, latestType }) => {
    const early = Date.parse("2030-01-02T02:40:00Z");
    const ask = (type: "prompt" | "payment-request", seq: number, expires_at_ms: number) => type === "prompt"
      ? msg({ seq, type, content: { id: `question-${seq}`, text: "Continue?", expires_at_ms } })
      : msg({ seq, type, content: { amount_msats: 5000, reason: "Work", expires_at_ms } });
    const messages = [ask(firstType, 1, early), ask(latestType, 2, early + 3_600_000)];
    const result = computeNextAction("job-1", messages, early - 600_000);
    const clause = "Reply by 2030-01-02 02:40 UTC (in 10 min), or the provider cancels the job.";
    expect(result).toMatchObject({ expires_at_ms: early, display: expect.stringContaining(clause) });
    expect(result?.hint).toContain(clause);
    expect(result).toMatchObject({ display: expect.not.stringMatching(/Answer by|Pay by/) });
    const expired = computeNextAction("job-1", messages, early);
    expect(expired).toMatchObject({ display: expect.stringContaining("The deadline to reply (2030-01-02 02:40 UTC) has passed.") });
    expect(expired?.hint).not.toMatch(/deadline to answer|deadline to pay/);
  });

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
      _provider_fields: ["prompt_id"],
      display: "The provider asks: What color?",
      hint: expect.stringContaining('dvm message job-1 "<answer>" --type response --prompt-id \'<prompt_id>\''),
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
      hint: expect.stringContaining("dvm message job-1 --json '<object matching schema>' --type response --prompt-id '<prompt_id>'"),
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
      hint: expect.stringContaining('dvm message job-1 "<answer>" --type response --prompt-id \'<prompt_id>\''),
    });
    expect(result?.hint).toContain("exactly one of options unless the human chose otherwise");
    expect(result?.hint).toContain("Verify the question makes sense for your task");
  });

  it("keeps unrestricted job and prompt ids out of CLI guidance", () => {
    const result = computeNextAction("job; two", [
      msg({ type: "prompt", content: { id: "prompt; two", text: "Continue?" } }),
    ]);
    expect(result?.hint).toBe(
      'Provider is waiting for your input. Verify the question makes sense for your task before responding. Run `dvm message \'<job_id>\' "<answer>" --type response --prompt-id \'<prompt_id>\'`.'
    );
  });

  it("omits empty options from the action and guidance", () => {
    const result = computeNextAction("job-1", [
      msg({ type: "prompt", content: { id: "p1", text: "Continue?", options: [] } }),
    ]);
    expect(result).not.toHaveProperty("options");
    expect(result).toMatchObject({
      display: "The provider asks: Continue?",
      hint: 'Provider is waiting for your input. Verify the question makes sense for your task before responding. Run `dvm message job-1 "<answer>" --type response --prompt-id \'<prompt_id>\'`.',
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
      hint: "Provider is waiting for your input. Verify the question makes sense for your task before responding. Run `dvm message job-1 --json '<object matching schema>' --type response --prompt-id \'<prompt_id>\'`.",
    });
  });

  it("uses a job placeholder in the pay command for unrestricted IDs", () => {
    const result = computeNextAction("job; two", [
      msg({ type: "payment-request", content: { amount_msats: 5000, reason: "Work" } }),
    ]);
    expect(result?.hint).toBe(
      'Payment required to continue: 5 sats. Relay that amount to your human and get approval, then run `dvm pay \'<job_id>\'`. Provider\'s stated reason is wrapped as { _source: "provider", text: ... } — verify it matches the work you expect.'
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
      _provider_fields: ["fiat_amount"],
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
  it("uses a job placeholder in the unattended wait command for unrestricted IDs", () => {
    expect(pollNextAction("job's").hint).toContain("dvm messages '<job_id>' --wait");
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
