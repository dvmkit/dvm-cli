import { describe, expect, it, vi } from "vitest";
import { type Transport } from "@dvmkit/sdk/internal";
import { jobContentFields, observeJobContent, parseJobContent } from "../src/lib/job-content";

describe("content observations", () => {
  it("preserves null and false while ignoring private and malformed fields", () => {
    expect(parseJobContent({ content_expires_at: null, content_available: false, holds: ["private"] }))
      .toEqual({ content_expires_at: null, content_available: false });
    expect(parseJobContent({ content_expires_at: "2030", content_available: "true" })).toEqual({});
    expect(parseJobContent({ content_expires_at: 9e15 })).toEqual({});
  });

  it("does not turn a passed deadline into unavailable content", () => {
    const fields = jobContentFields("job", { content_expires_at: 1, content_available: true });
    expect(fields).toMatchObject({ content_expires_at: 1, content_available: true, content_metadata_known: true });
    expect(fields.content_hint).toContain("1970-01-01T00:00:00.001Z");
  });

  it.each([true, false])("quotes the real job ID in human content guidance when available=%s", (available) => {
    const fields = jobContentFields("job; one", { content_available: available }, true);
    expect(fields.content_hint).toContain(available
      ? "dvm messages 'job; one' --no-stream"
      : "dvm receipts verify 'job; one'");
    expect(fields.content_hint).not.toContain("<job_id>");
    expect(jobContentFields("job; one", { content_available: available }).content_hint).toContain("'<job_id>'");
  });

  it("distinguishes a legacy provider observation from an unobserved cache", () => {
    expect(jobContentFields("job", {})).toMatchObject({ content_metadata_source: "provider", content_metadata_known: false });
    const cached = jobContentFields("job");
    expect(cached).toMatchObject({ content_metadata_source: "unknown", content_metadata_known: false });
    expect(cached).not.toHaveProperty("content_available");
    expect(cached).not.toHaveProperty("content_expires_at");
  });

  it.each([0, -1, 60_000, Infinity, NaN])("bounds an optional metadata read with timeout %s", async (timeoutMs) => {
    const status = vi.fn().mockRejectedValue(new Error("provider disconnected"));
    const transport = { status } as unknown as Transport;
    await expect(observeJobContent("job", transport, { endpoint: "https://provider.example" }, { timeoutMs, jobToken: "token" }))
      .resolves.toBeUndefined();
    expect(status).toHaveBeenCalledWith("job", { endpoint: "https://provider.example" }, { timeoutMs: 5000, jobToken: "token" });
  });
});
