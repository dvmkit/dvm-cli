import { beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  close: vi.fn(),
  createTransport: vi.fn(),
  submit: vi.fn(),
  streamLoop: vi.fn(),
}));

vi.mock("../src/lib/transport", () => ({
  createDvmTransport: () => {
    seams.createTransport();
    return { close: seams.close, describe: async () => ({}), submit: seams.submit };
  },
}));

vi.mock("../src/lib/stream-loop", () => ({ streamLoop: seams.streamLoop }));

import { browse } from "../src/commands/browse";
import { search } from "../src/commands/search";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("discovery numeric options", () => {
  it.each([
    ["search limit", () => search({ query: "weather", limit: "10x" }), "invalid_limit"],
    ["search fractional limit", () => search({ query: "weather", limit: "1.5" }), "invalid_limit"],
    ["browse empty limit", () => browse({ limit: "" }), "invalid_limit"],
    ["browse limit above 50", () => browse({ limit: "51" }), "invalid_limit"],
    ["browse unsafe offset", () => browse({ offset: "9007199254740992" }), "invalid_offset"],
    ["browse negative offset", () => browse({ offset: "-1" }), "invalid_offset"],
    ["search zero timeout", () => search({ query: "weather", timeout: "0" }), "invalid_timeout"],
    ["browse infinite timeout", () => browse({ timeout: "Infinity" }), "invalid_timeout"],
    ["search oversized timeout", () => search({ query: "weather", timeout: "2147483.648" }), "invalid_timeout"],
  ])("rejects %s before creating network work", async (_label, invoke, code) => {
    await expect(invoke()).rejects.toMatchObject({ code });
    expect(seams.createTransport).not.toHaveBeenCalled();
    expect(seams.submit).not.toHaveBeenCalled();
    expect(seams.streamLoop).not.toHaveBeenCalled();
  });

  it("accepts the limit boundaries and a safe integer offset", async () => {
    seams.submit.mockResolvedValue({
      status: "completed",
      summary: JSON.stringify({ entries: [], total: 0, offset: 9_007_199_254_740_991, limit: 50 }),
    });

    await browse({ limit: "50", offset: "9007199254740991" });

    expect(seams.submit).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({
        input: expect.stringContaining('"limit":50,"offset":9007199254740991'),
      })
    );
    expect(seams.close).toHaveBeenCalledExactlyOnceWith();
  });

  it("accepts search's lower limit boundary", async () => {
    seams.submit.mockResolvedValue({
      status: "completed",
      summary: JSON.stringify({ results: [], query: "weather", mode: "keyword", total: 0 }),
    });

    await search({ query: "weather", limit: "1" });

    expect(seams.submit).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ input: expect.stringContaining('"limit":1') })
    );
  });

  it("preserves fractional timeout seconds as the polling deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      seams.submit.mockResolvedValue({ status: "accepted", jobId: "job-1" });
      seams.streamLoop.mockResolvedValue({ messages: [], cursor: 0, nextAction: null });

      await expect(search({ query: "weather", timeout: "1.25" })).rejects.toMatchObject({
        code: "timeout",
      });

      expect(seams.streamLoop).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ timeoutMs: 1_250 })
      );
      expect(seams.close).toHaveBeenCalledExactlyOnceWith();
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts Node's maximum timer duration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      seams.submit.mockResolvedValue({ status: "accepted", jobId: "job-2" });
      seams.streamLoop.mockResolvedValue({ messages: [], cursor: 0, nextAction: null });

      await expect(search({ query: "weather", timeout: "2147483.647" })).rejects.toMatchObject({
        code: "timeout",
      });
      expect(seams.streamLoop).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 2_147_483_647 })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
