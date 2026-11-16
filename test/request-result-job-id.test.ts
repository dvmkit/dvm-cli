import { rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { JOBS_FILE } from "@dvmkit/sdk/internal";
import { requestResult } from "../src/commands/request-result";
import { saveJob } from "../src/lib/job-store";

beforeEach(() => {
  rmSync(JOBS_FILE, { force: true });
  saveJob({ id: "job-a", endpoint: "https://provider.example", status: "processing", submittedAt: 1,
    requestId: "req-a" });
});

// The upfront_credit_unknown hint sends callers to `dvm request-result`; a job id must reach the same recovery.
it("resolves a job id to its stored request id", async () => {
  await expect(requestResult("job-a")).rejects.toMatchObject({
    code: "request_not_found", data: { request_id: "req-a" } });
});

it("keeps treating an unknown id as a request id", async () => {
  await expect(requestResult("never-seen")).rejects.toMatchObject({
    code: "request_not_found", data: { request_id: "never-seen" } });
});
