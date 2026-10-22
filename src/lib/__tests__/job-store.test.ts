import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { JOBS_FILE } from "@dvmkit/sdk/internal";
import { beforeEach, describe, expect, it } from "vitest";

import type { JobRecord } from "../job-store";
import { addPayment, loadAllJobs, loadJob, markJobTerminal, refFromJob, saveJob, updateJob } from "../job-store";

beforeEach(() => rmSync(JOBS_FILE, { force: true }));

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job1",
    endpoint: "https://example.com",
    status: "submitted",
    submittedAt: 1000,
    ...overrides,
  };
}

function seedJobs(jobs: JobRecord[]): void {
  writeFileSync(JOBS_FILE, JSON.stringify(jobs));
}

function writtenJobs(): JobRecord[] {
  return JSON.parse(readFileSync(JOBS_FILE, "utf8")) as JobRecord[];
}

describe("saveJob", () => {
  it("writes JSON with job record", () => {
    const job = makeJob();
    saveJob(job);
    expect(writtenJobs()).toEqual([job]);
  });
});

describe("loadJob", () => {
  it("returns matching record", () => {
    seedJobs([makeJob({ id: "other" }), makeJob()]);
    expect(loadJob("job1")).toEqual(makeJob());
  });

  it("returns null for non-existent job", () => {
    seedJobs([makeJob()]);
    expect(loadJob("nope")).toBeNull();
  });
});

describe("loadAllJobs", () => {
  it("returns all records", () => {
    seedJobs([makeJob({ id: "a" }), makeJob({ id: "b" })]);
    expect(loadAllJobs()).toEqual([makeJob({ id: "a" }), makeJob({ id: "b" })]);
  });

  it("returns [] when file does not exist", () => {
    expect(loadAllJobs()).toEqual([]);
  });

  it("returns [] on corrupt JSON", () => {
    writeFileSync(JOBS_FILE, "not json");
    expect(loadAllJobs()).toEqual([]);
  });
});

describe("updateJob", () => {
  it("merges partial update into existing record", () => {
    seedJobs([makeJob()]);
    updateJob("job1", { status: "completed", completedAt: 2000 });
    expect(writtenJobs()).toEqual([makeJob({ status: "completed", completedAt: 2000 })]);
  });

  it("is a no-op for non-existent ID", () => {
    seedJobs([makeJob()]);
    const before = readFileSync(JOBS_FILE, "utf8");
    const identity = statSync(JOBS_FILE).ino;
    updateJob("nope", { status: "completed" });
    expect(readFileSync(JOBS_FILE, "utf8")).toBe(before);
    expect(statSync(JOBS_FILE).ino).toBe(identity);
  });
});

describe("saveJob — duplicate ID", () => {
  it("appends duplicate and loadJob returns first match", () => {
    seedJobs([makeJob({ id: "dup", endpoint: "https://first.com" })]);
    saveJob(makeJob({ id: "dup", endpoint: "https://second.com" }));
    const written = writtenJobs();
    expect(written).toHaveLength(2);
    expect(written[0].endpoint).toBe("https://first.com");
    expect(written[1].endpoint).toBe("https://second.com");
    expect(loadJob("dup")?.endpoint).toBe("https://first.com");
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
    seedJobs([makeJob({ status: "processing" })]);
    markJobTerminal("job1", status, completion, { costMsats: 5000, paymentMethod: "cashu" });
    const written = writtenJobs();
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
    seedJobs([makeJob({ status: "completed", completedAt: 4200, completion: {} })]);
    markJobTerminal("job1", "completed", { summary: "done", payloadIn: "summary" });
    const written = writtenJobs();
    expect(written[0].completedAt).toBe(4200);
    expect(written[0].completion).toEqual({ summary: "done", payloadIn: "summary" });
  });

  it("does nothing when the job is not in the store", () => {
    seedJobs([makeJob({ id: "other" })]);
    const before = readFileSync(JOBS_FILE, "utf8");
    const identity = statSync(JOBS_FILE).ino;
    markJobTerminal("job1", "completed", {});
    expect(readFileSync(JOBS_FILE, "utf8")).toBe(before);
    expect(statSync(JOBS_FILE).ino).toBe(identity);
    expect(existsSync(`${JOBS_FILE}.lock`)).toBe(false);
  });
});

it("persists each payment approval with its total without changing older jobs", () => {
  seedJobs([makeJob(), makeJob({ id: "legacy" })]);
  addPayment("job1", 1000, { requestSeq: 1, approval: "auto" });
  addPayment("job1", 2000, { requestSeq: 3, approval: "explicit" });
  addPayment("legacy", 500);
  expect(loadJob("job1")).toMatchObject({ totalPaidMsats: 3000, paymentsHonoured: 2,
    paymentApprovals: [{ requestSeq: 1, approval: "auto" }, { requestSeq: 3, approval: "explicit" }] });
  expect(loadJob("legacy")).toMatchObject({ totalPaidMsats: 500, paymentsHonoured: 1 });
  expect(loadJob("legacy")?.paymentApprovals).toBeUndefined();
});
