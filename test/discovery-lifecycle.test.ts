import { beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  close: vi.fn(),
  describe: vi.fn(),
  createMessageAppendSession: vi.fn(() => ({ append: vi.fn() })),
  getMessages: vi.fn(),
  info: vi.fn(),
  json: vi.fn(),
  submit: vi.fn(),
}));

vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()) }));
vi.mock("../src/lib/output", async () => ({ ...(await vi.importActual<typeof import("../src/lib/output")>("../src/lib/output")), info: seams.info,
json: seams.json }));

vi.mock("../src/lib/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/messages")>()),
  createMessageAppendSession: seams.createMessageAppendSession,
}));

vi.mock("../src/lib/transport", () => ({
  createDvmTransport: () => ({
    close: seams.close,
    describe: seams.describe,
    getMessages: seams.getMessages,
    submit: seams.submit,
  }),
}));

import { browse } from "../src/commands/browse";
import { search } from "../src/commands/search";

interface CommandFixture {
  name: "search" | "browse";
  invoke: (opts?: { human?: boolean; timeout?: string }) => Promise<void>;
  summary: string;
  emptyJson: Record<string, unknown>;
  emptyHuman: string;
  timeoutMessage: string;
  cancelFallback: string;
}

const commands: CommandFixture[] = [
  {
    name: "search",
    invoke: (opts = {}) => search({ query: "weather", ...opts }),
    summary: JSON.stringify({ results: [], query: "weather", mode: "keyword", total: 0 }),
    emptyJson: {
      results: [],
      query: "weather",
      mode: "keyword",
      total: 0,
      provider_count: 0,
    },
    emptyHuman: "No providers found.",
    timeoutMessage: "Search is still processing.",
    cancelFallback: "search_failed",
  },
  {
    name: "browse",
    invoke: (opts = {}) => browse(opts),
    summary: JSON.stringify({ entries: [], total: 0, offset: 0, limit: 10, query: null }),
    emptyJson: {
      entries: [],
      total: 0,
      offset: 0,
      limit: 10,
      query: null,
      provider_count: 0,
    },
    emptyHuman: "No DVMs found.",
    timeoutMessage: "Browse is still processing.",
    cancelFallback: "browse_failed",
  },
];

function working(seq: number) {
  return {
    seq,
    type: "working",
    from: "provider",
    timestamp: 1,
    content: { message: "Still working", estimate_seconds: 0 },
  };
}

function complete(seq: number, summary: string) {
  return {
    seq,
    type: "complete",
    from: "provider",
    timestamp: 2,
    content: { summary },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  seams.describe.mockResolvedValue({});
});

describe.each(commands)("$name discovery lifecycle", (fixture) => {
  it("renders an immediately completed receipt as command-specific JSON", async () => {
    seams.submit.mockResolvedValue({ status: "completed", summary: fixture.summary });

    await fixture.invoke();

    expect(seams.json).toHaveBeenCalledExactlyOnceWith(fixture.emptyJson);
    expect(seams.getMessages).not.toHaveBeenCalled();
    expect(seams.close).toHaveBeenCalledExactlyOnceWith();
  });

  it("renders an immediately completed receipt as command-specific human output", async () => {
    seams.submit.mockResolvedValue({ status: "completed", summary: fixture.summary });

    await fixture.invoke({ human: true });

    expect(seams.info).toHaveBeenCalledWith(fixture.emptyHuman);
    expect(seams.json).not.toHaveBeenCalled();
    expect(seams.close).toHaveBeenCalledExactlyOnceWith();
  });

  it("follows working polls to completion with the anonymous token and cursor", async () => {
    seams.submit.mockResolvedValue({
      status: "accepted",
      jobId: `${fixture.name}-job`,
      jobToken: `${fixture.name}-token`,
    });
    seams.getMessages
      .mockResolvedValueOnce([working(4)])
      .mockResolvedValueOnce([complete(7, fixture.summary)]);

    vi.useFakeTimers();
    try {
      const invocation = fixture.invoke();
      await vi.runAllTimersAsync();
      await invocation;
    } finally {
      vi.useRealTimers();
    }

    expect(seams.getMessages).toHaveBeenCalledTimes(2);
    expect(seams.getMessages).toHaveBeenNthCalledWith(
      1,
      `${fixture.name}-job`,
      0,
      expect.anything(),
      { timeoutMs: 15_000, jobToken: `${fixture.name}-token` }
    );
    expect(seams.getMessages).toHaveBeenNthCalledWith(
      2,
      `${fixture.name}-job`,
      4,
      expect.anything(),
      { timeoutMs: 14_500, jobToken: `${fixture.name}-token` }
    );
    expect(seams.json).toHaveBeenCalledExactlyOnceWith(fixture.emptyJson);
    expect(seams.close).toHaveBeenCalledExactlyOnceWith();
  });

  it("stops after an empty follow-up poll and preserves the command timeout", async () => {
    seams.submit.mockResolvedValue({ status: "accepted", jobId: "empty-job", jobToken: "secret" });
    seams.getMessages.mockResolvedValueOnce([working(2)]).mockResolvedValueOnce([]);

    vi.useFakeTimers();
    try {
      const invocation = fixture.invoke();
      const rejection = expect(invocation).rejects.toMatchObject({
        code: "timeout",
        message: fixture.timeoutMessage,
      });
      await vi.runAllTimersAsync();
      await rejection;
    } finally {
      vi.useRealTimers();
    }

    expect(seams.getMessages).toHaveBeenNthCalledWith(
      2,
      "empty-job",
      2,
      expect.anything(),
      { timeoutMs: 14_500, jobToken: "secret" }
    );
    expect(seams.close).toHaveBeenCalledExactlyOnceWith();
  });

  it("honours the polling deadline and preserves the command timeout", async () => {
    seams.submit.mockResolvedValue({ status: "accepted", jobId: "deadline-job" });
    seams.getMessages.mockResolvedValue([working(1)]);

    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      const invocation = fixture.invoke({ timeout: "0.1" });
      const rejection = expect(invocation).rejects.toMatchObject({
        code: "timeout",
        message: fixture.timeoutMessage,
      });
      await vi.runAllTimersAsync();
      await rejection;
    } finally {
      vi.useRealTimers();
    }

    expect(seams.getMessages).toHaveBeenCalledExactlyOnceWith(
      "deadline-job",
      0,
      expect.anything(),
      { timeoutMs: 100, jobToken: undefined }
    );
    expect(seams.close).toHaveBeenCalledExactlyOnceWith();
  });

  it("maps a provider cancellation and closes the transport", async () => {
    seams.submit.mockResolvedValue({ status: "accepted", jobId: "cancel-job" });
    seams.getMessages.mockResolvedValue([
        {
          seq: 1,
          type: "cancel",
          from: "provider",
          timestamp: 1,
          content: { reason: "upstream_failed: Provider failed" },
        },
      ]);

    await expect(fixture.invoke()).rejects.toMatchObject({
      code: "upstream_failed",
      message: "Provider failed",
    });
    expect(seams.close).toHaveBeenCalledExactlyOnceWith();
  });

  it("preserves an unstructured provider cancellation fallback", async () => {
    seams.submit.mockResolvedValue({ status: "accepted", jobId: "cancel-job" });
    seams.getMessages.mockResolvedValue([
        {
          seq: 1,
          type: "cancel",
          from: "provider",
          timestamp: 1,
          content: { reason: "Provider stopped" },
        },
      ]);

    await expect(fixture.invoke()).rejects.toMatchObject({
      code: fixture.cancelFallback,
      message: "Provider stopped",
    });
    expect(seams.close).toHaveBeenCalledExactlyOnceWith();
  });

  it("propagates transport errors and still closes the transport", async () => {
    const failure = new Error("connection lost");
    seams.submit.mockResolvedValue({ status: "accepted", jobId: "error-job" });
    seams.getMessages.mockRejectedValue(failure);

    await expect(fixture.invoke()).rejects.toBe(failure);
    expect(seams.close).toHaveBeenCalledExactlyOnceWith();
  });

  it("passes the lifecycle next action into command-specific JSON rendering", async () => {
    seams.submit.mockResolvedValue({ status: "accepted", jobId: "next-job" });
    seams.getMessages
      .mockResolvedValueOnce([complete(1, fixture.summary), working(2)])
      .mockResolvedValueOnce([]);

    vi.useFakeTimers();
    try {
      const invocation = fixture.invoke();
      await vi.runAllTimersAsync();
      await invocation;
    } finally {
      vi.useRealTimers();
    }

    expect(seams.json).toHaveBeenCalledExactlyOnceWith({
      ...fixture.emptyJson,
      next_action: expect.objectContaining({ type: "poll", job_id: "next-job" }),
    });
    expect(seams.close).toHaveBeenCalledExactlyOnceWith();
  });
});

const deliveredWords = "Delivered 97% of 1,204 paid jobs in the last 30 days, measured by dvmkit";
const feedbackWords = "92% positive from 48 paying callers in the last 90 days";
const firstSpeed = "Usually 4.2 s; 95% finish within 11 s (last 30 days)";
const secondSpeed = "Usually 1 s; 95% finish within 3 s (last 30 days)";

function trustResults() {
  const base = {
    dvm_id: "registered-provider", owner_handle: "builder", slug: "scribe",
    name: "Provider name", description: "Provider description", tags: ["audio"],
    endpoint: "https://provider.example", identifier: "builder--scribe",
    pricing: { max: { amount: 99, currency: "usd" } }, price_raw: "$99.00", credit: null,
    score: 0.8, match_reason: "Provider match prose", future_field: { retained: true },
    trust: {
      status: "live", basis: "measured", window_days: 30,
      delivery: { delivered: 1168, paid_jobs: 1204, rate: 0.97 },
      feedback: { callers: 48, positive_share: 0.92, window_days: 90 },
      unreachable_since_ms: null, listed_at_ms: 1789000000000,
    },
    capabilities: [
      {
        name: "transcribe", description: "Transcribe provider instructions",
        price: { amount: 0.05, currency: "usd" }, quote_required: false,
        speed: { p50_ms: 4200, p95_ms: 11000, jobs: 312 },
        display: { price: "$0.05", speed: firstSpeed },
      },
      {
        name: "caption", description: "",
        price: { amount: 0.25, currency: "usd" }, quote_required: false,
        speed: { p50_ms: 1000, p95_ms: 3000, jobs: 900 },
        display: { price: "$0.25", speed: secondSpeed },
      },
    ],
    display: {
      price: "$99.00", endpoint_hint: "Use with: dvm request -d builder--scribe",
      owner: "by builder (@builder)", credit: "Prepaid credit offered", warning: "Provider warning words",
      status: "Live", delivered: deliveredWords, feedback: feedbackWords,
      reliability: "Legacy reliability must not render",
    },
  };
  return [base, {
    ...base, identifier: "builder--new", endpoint: "https://new.example", score: 0.9,
    trust: { ...base.trust, status: "new", basis: null, delivery: null, feedback: null },
    capabilities: [{
      name: "quote", description: null, price: null, quote_required: true, speed: null,
      display: { price: "Quote required", speed: null },
    }],
    display: {
      ...base.display, status: "New — no paid jobs yet", delivered: "No delivered record yet",
      feedback: "No paying-caller feedback yet", warning: null, owner: null, credit: null,
      endpoint_hint: "Use with: dvm request -d builder--new",
    },
  }, {
    ...base, identifier: null, endpoint: "https://external.example", score: 1,
    capabilities: base.capabilities.map((capability) => ({ ...capability, description: null })),
    trust: { ...base.trust, status: "unreachable", unreachable_since_ms: 1789000500000 },
    display: {
      ...base.display, status: "Not responding since yesterday",
      endpoint_hint: "Use with: dvm request --endpoint https://external.example",
    },
  }];
}

function resultSummary(name: CommandFixture["name"], results: unknown[] = trustResults()) {
  return JSON.stringify(name === "search"
    ? { results, query: "weather", mode: "keyword", total: 3, future_envelope: "preserved" }
    : { entries: results, total: 91, offset: 10, limit: 10, query: null, future_envelope: "preserved" });
}

describe.each(commands)("$name discover trust rows", (fixture) => {
  it("uses discover capabilities for prices, speeds, provenance and counts without provider probes", async () => {
    seams.describe.mockResolvedValue({ capabilities: { wrong: { description: "Stale probe" } } });
    seams.submit.mockResolvedValue({ status: "completed", summary: resultSummary(fixture.name) });
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network probe"));

    await fixture.invoke();

    expect(seams.describe).toHaveBeenCalledExactlyOnceWith(expect.anything());
    expect(network).not.toHaveBeenCalled();
    const output = seams.json.mock.calls[0][0];
    const rows = fixture.name === "search" ? output.results : output.entries;
    expect(rows.map((row: { identifier: string | null }) => row.identifier)).toEqual([
      "builder--scribe/transcribe", "builder--scribe/caption", "builder--new/quote", null,
    ]);
    expect(output).toMatchObject({
      total: fixture.name === "search" ? 4 : 91,
      provider_count: 3, future_envelope: "preserved",
    });
    expect(rows[0]).toMatchObject({
      capability: "transcribe", capability_description: { _source: "provider", text: "Transcribe provider instructions" },
      price: { amount: 0.05, currency: "usd" }, pricing: { max: { amount: 0.05, currency: "usd" } },
      speed: { p50_ms: 4200, p95_ms: 11000, jobs: 312 }, quote_required: false,
      display: { price: "$0.05", speed: firstSpeed, endpoint_hint: "Use with: dvm request -d builder--scribe/transcribe" },
      name: { _source: "provider", text: "Provider name" },
      description: { _source: "provider", text: "Provider description" },
      tags: [{ _source: "provider", text: "audio" }], future_field: { retained: true },
      trust: { status: "live", basis: "measured", delivery: { delivered: 1168, paid_jobs: 1204, rate: 0.97 } },
    });
    expect(rows[1]).toMatchObject({
      price: { amount: 0.25, currency: "usd" }, pricing: { max: { amount: 0.25, currency: "usd" } },
      speed: { p50_ms: 1000, p95_ms: 3000, jobs: 900 }, display: { price: "$0.25", speed: secondSpeed },
    });
    expect(rows[0].capabilities).toMatchObject([
      { description: { _source: "provider", text: "Transcribe provider instructions" } },
      { description: { _source: "provider", text: "" } },
    ]);
    expect(rows[2]).toMatchObject({
      capability_description: null,
      price: null, pricing: null, speed: null, quote_required: true,
      trust: { status: "new", basis: null, delivery: null, feedback: null },
      display: { price: "Quote required", speed: null },
    });
    expect(rows[3]).toMatchObject({
      identifier: null, trust: { status: "unreachable", unreachable_since_ms: 1789000500000 },
      display: { endpoint_hint: "Use with: dvm request --endpoint https://external.example" },
    });
    expect(rows[3]).not.toHaveProperty("capability");
    expect(rows[3].price_raw).toBe("$99.00");
    expect(rows[3].capabilities[0].description).toBeNull();
    expect(rows[2].capabilities[0].description).toBeNull();
    for (const row of rows.slice(0, 3)) expect(row).not.toHaveProperty("price_raw");
    if (fixture.name === "search") {
      expect(rows[0].match_reason).toEqual({ _source: "provider", text: "Provider match prose" });
    } else {
      expect(output).toMatchObject({ offset: 10, limit: 10, query: null });
    }
  });

  it("renders all status and trust words verbatim, including endpoint-only capability speeds", async () => {
    seams.submit.mockResolvedValue({ status: "completed", summary: resultSummary(fixture.name) });

    await fixture.invoke({ human: true });

    const lines = seams.info.mock.calls.map(([line]) => String(line));
    const text = lines.join("\n");
    for (const words of [
      "Price: $0.05", "Price: $0.25", "Price: Quote required", `Delivered: ${deliveredWords}`,
      `Feedback: ${feedbackWords}`, `Speed: ${firstSpeed}`, `Speed: ${secondSpeed}`,
      "Status: Live", "Status: New — no paid jobs yet", "Status: Not responding since yesterday",
      "Owner: by builder (@builder)", "Warning: Provider warning words", "Credit: Prepaid credit offered",
      "--endpoint https://external.example", `Speed: transcribe: ${firstSpeed}`, `Speed: caption: ${secondSpeed}`,
    ]) expect(text).toContain(words);
    expect(text).not.toContain("Legacy reliability");
    expect(text).not.toContain("Reliability:");
    expect(text).not.toContain("Speed: null");
    expect(text).not.toContain("Owner: null");
    expect(seams.describe).toHaveBeenCalledExactlyOnceWith(expect.anything());
    if (fixture.name === "browse") expect(text).toContain("dvm browse --offset 13");
  });
});

function ownershipResults() {
  const base = trustResults()[0];
  const owner = {
    handle: "plainops", type: "org", displayName: "Plain Ops",
    avatarUrl: null, profileUrl: "https://example.com/plainops",
  };
  return [
    {
      ...base, identifier: "plainops--scribe", name: "Plain service",
      owner: { ...owner, operatedByDvmkit: true },
      display: { ...base.display, owner: "by Plain Ops (@plainops) · Operated by dvmkit" },
    },
    {
      ...base, identifier: "dvmkit--lookalike", name: "dvmkit official service",
      owner: { ...owner, handle: "dvmkit", displayName: "dvmkit", operatedByDvmkit: false },
      display: { ...base.display, owner: "by dvmkit (@dvmkit)" },
    },
    {
      ...base, identifier: "dvmkit--legacy", name: "dvmkit legacy service",
      owner: { ...owner, handle: "dvmkit", displayName: "dvmkit" },
      display: { ...base.display, owner: "by dvmkit (@dvmkit), legacy identity" },
    },
    {
      ...base, identifier: null, owner: null,
      display: { ...base.display, owner: "by @example (self-reported)" },
    },
  ];
}

describe.each(commands)("$name discover ownership", (fixture) => {
  it("preserves owner identity and authoritative flags on every capability row", async () => {
    seams.submit.mockResolvedValue({
      status: "completed", summary: resultSummary(fixture.name, ownershipResults()),
    });

    await fixture.invoke();

    expect(seams.json).toHaveBeenCalledTimes(1);
    const output = seams.json.mock.calls[0][0];
    const rows = fixture.name === "search" ? output.results : output.entries;
    expect(rows.map((row: { identifier: string | null }) => row.identifier)).toEqual([
      "plainops--scribe/transcribe", "plainops--scribe/caption",
      "dvmkit--lookalike/transcribe", "dvmkit--lookalike/caption",
      "dvmkit--legacy/transcribe", "dvmkit--legacy/caption", null,
    ]);
    for (const row of rows.slice(0, 2)) {
      expect(row.owner).toEqual({
        handle: "plainops", type: "org", displayName: "Plain Ops", avatarUrl: null,
        profileUrl: "https://example.com/plainops", operatedByDvmkit: true,
      });
      expect(row.display.owner).toBe("by Plain Ops (@plainops) · Operated by dvmkit");
    }
    for (const row of rows.slice(2, 4)) {
      expect(row.owner).toEqual({
        handle: "dvmkit", type: "org", displayName: "dvmkit", avatarUrl: null,
        profileUrl: "https://example.com/plainops", operatedByDvmkit: false,
      });
      expect(row.display.owner).toBe("by dvmkit (@dvmkit)");
    }
    for (const row of rows.slice(4, 6)) {
      expect(row.owner).toEqual({
        handle: "dvmkit", type: "org", displayName: "dvmkit", avatarUrl: null,
        profileUrl: "https://example.com/plainops",
      });
      expect(row.display.owner).toBe("by dvmkit (@dvmkit), legacy identity");
    }
    expect(rows[6].owner).toBeNull();
    expect(rows[6].display.owner).toBe("by @example (self-reported)");
  });

  it("relays ownership words verbatim without claiming lookalikes or external services", async () => {
    seams.submit.mockResolvedValue({
      status: "completed", summary: resultSummary(fixture.name, ownershipResults()),
    });

    await fixture.invoke({ human: true });

    const lines = seams.info.mock.calls.map(([line]) => String(line).trim());
    expect(lines.filter((line) => line.startsWith("Owner:"))).toEqual([
      "Owner: by Plain Ops (@plainops) · Operated by dvmkit",
      "Owner: by Plain Ops (@plainops) · Operated by dvmkit",
      "Owner: by dvmkit (@dvmkit)", "Owner: by dvmkit (@dvmkit)",
      "Owner: by dvmkit (@dvmkit), legacy identity", "Owner: by dvmkit (@dvmkit), legacy identity",
      "Owner: by @example (self-reported)",
    ]);
    expect(lines.filter((line) => line.includes("Operated by dvmkit"))).toHaveLength(2);
    expect(seams.json).not.toHaveBeenCalled();
  });
});
