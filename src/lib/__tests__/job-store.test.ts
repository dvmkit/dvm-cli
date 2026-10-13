vi.mock("@dvmkit/sdk/internal", async () => {
 const actual = await vi.importActual<typeof import("@dvmkit/sdk/internal")>("@dvmkit/sdk/internal");
 return { ...actual, CONFIG_DIR: "/mock/.dvm",
JOBS_FILE: "/mock/.dvm/jobs.json" };
});
import { describe, expect, it, vi } from "vitest";

vi.mock("fs");

import { existsSync, readFileSync, writeFileSync } from "fs";

import type { JobRecord } from "../job-store";
import { loadAllJobs, loadJob, markJobTerminal, refFromJob, saveJob, updateJob } from "../job-store";

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job1",
    endpoint: "https://example.com",
    status: "submitted",
    submittedAt: 1000,
    ...overrides,
  };
}

describe("saveJob", () => {
  it("writes JSON with job record", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const job = makeJob();
    saveJob(job);
    expect(writeFileSync).toHaveBeenCalledWith(
      "/mock/.dvm/jobs.json",
      expect.stringContaining('"job1"')
    );
  });
});

describe("loadJob", () => {
  it("returns matching record", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify([makeJob()]));
    expect(loadJob("job1")).toEqual(expect.objectContaining({ id: "job1" }));
  });

  it("returns null for non-existent job", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify([makeJob()]));
    expect(loadJob("nope")).toBeNull();
  });
});

describe("loadAllJobs", () => {
  it("returns all records", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify([makeJob({ id: "a" }), makeJob({ id: "b" })])
    );
    expect(loadAllJobs()).toHaveLength(2);
  });

  it("returns [] when file does not exist", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(loadAllJobs()).toEqual([]);
  });

  it("returns [] on corrupt JSON", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("not json");
    expect(loadAllJobs()).toEqual([]);
  });
});

describe("updateJob", () => {
  it("merges partial update into existing record", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify([makeJob()]));
    updateJob("job1", { status: "completed", completedAt: 2000 });
    const written = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
    expect(written[0].status).toBe("completed");
    expect(written[0].completedAt).toBe(2000);
  });

  it("is a no-op for non-existent ID", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify([makeJob()]));
    updateJob("nope", { status: "completed" });
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});

describe("saveJob — duplicate ID", () => {
  it("appends duplicate and loadJob returns first match", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify([makeJob({ id: "dup", endpoint: "https://first.com" })])
    );

    saveJob(makeJob({ id: "dup", endpoint: "https://second.com" }));

    const written = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
    expect(written).toHaveLength(2);
    expect(written[0].endpoint).toBe("https://first.com");
    expect(written[1].endpoint).toBe("https://second.com");

    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(written));
    const loaded = loadJob("dup");
    expect(loaded?.endpoint).toBe("https://first.com");
  });
});

describe("refFromJob", () => {
  it("builds ProviderRef with endpoint", () => {
    const ref = refFromJob(makeJob({ endpoint: "https://example.com" }));
    expect(ref.endpoint).toBe("https://example.com");
  });
});

describe("markJobTerminal", () => {
  it.each([
    {
      status: "completed" as const,
      completion: { summary: "done", hasArtifacts: false, payloadIn: "summary" as const },
    },
    { status: "cancelled" as const, completion: {} },
  ])("writes status, completion and extras together ($status)", ({ status, completion }) => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify([makeJob({ status: "processing" })]));

    markJobTerminal("job1", status, completion, { costMsats: 5000, paymentMethod: "cashu" });

    const written = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string) as JobRecord[];
    expect(written[0].status).toBe(status);
    expect(written[0].completion).toEqual(completion);
    expect(written[0].completedAt).toBeGreaterThan(0);
    expect(written[0]).toMatchObject({ costMsats: 5000, paymentMethod: "cashu" });
  });

  // A job can be marked terminal twice (`dvm status --messages` re-reads the
  // wire; so does the first read of a record written before the snapshot
  // landed). It finished when it first finished — re-stamping would drift the
  // completion time forward and skew avgLatencyMs in local provider history.
  it("keeps the original completedAt when a terminal job is marked again", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify([makeJob({ status: "completed", completedAt: 4200, completion: {} })])
    );

    markJobTerminal("job1", "completed", { summary: "done", payloadIn: "summary" });

    const written = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string) as JobRecord[];
    expect(written[0].completedAt).toBe(4200);
    expect(written[0].completion).toEqual({ summary: "done", payloadIn: "summary" });
  });

  it("does nothing when the job is not in the store", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify([makeJob({ id: "other" })]));

    markJobTerminal("job1", "completed", {});

    expect(writeFileSync).not.toHaveBeenCalled();
  });
});
