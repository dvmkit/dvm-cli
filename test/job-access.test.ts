vi.mock("../src/lib/job-store", async () => ({ ...(await vi.importActual<typeof import("../src/lib/job-store")>("../src/lib/job-store")), loadJob: sdkMocks.loadJob }));
const sdkMocks = vi.hoisted(() => ({
  loadJob: vi.fn(),
}));

vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
  loadJob: sdkMocks.loadJob,
}));

import { DvmError } from "@dvmkit/sdk/internal";
import { type JobRecord } from "../src/lib/job-store";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { recordLocalJobCollision } from "../src/lib/submission-evidence";
import {
  redactJobTokenFromError,
  resolveJobAccess,
  resolveStoredJobAccess,
} from "../src/lib/job-access";

const STORED_TOKEN = "11".repeat(32);
const FLAG_TOKEN = "33".repeat(32);
const originalEndpoint = process.env.DVM_JOB_ENDPOINT;
const originalToken = process.env.DVM_JOB_TOKEN;

const storedJob: JobRecord = {
  id: "job-1",
  endpoint: "https://stored.example",
  status: "processing",
  submittedAt: 1,
  jobToken: STORED_TOKEN,
};

beforeEach(() => {
  delete process.env.DVM_JOB_ENDPOINT;
  delete process.env.DVM_JOB_TOKEN;
  sdkMocks.loadJob.mockReturnValue(storedJob);
});

afterAll(() => {
  if (originalEndpoint === undefined) delete process.env.DVM_JOB_ENDPOINT;
  else process.env.DVM_JOB_ENDPOINT = originalEndpoint;
  if (originalToken === undefined) delete process.env.DVM_JOB_TOKEN;
  else process.env.DVM_JOB_TOKEN = originalToken;
});

describe("portable job access", () => {

  it.each([
    [{}, "job_access_required"],
    [{ endpoint: "https://portable.example" }, "job_token_required"],
    [{ jobToken: FLAG_TOKEN }, "job_endpoint_required"],
  ] as const)("reports the missing stateless input with %s", (options, code) => {
    sdkMocks.loadJob.mockReturnValue(null);

    expect(() => resolveJobAccess("portable", options)).toThrowError(
      expect.objectContaining({ code })
    );
  });

  it("rejects malformed endpoints and tokens without reflecting the token", () => {
    sdkMocks.loadJob.mockReturnValue(null);
    const malformedToken = "not-a-secret-token";

    expect(() =>
      resolveJobAccess("portable", { endpoint: "provider.example", jobToken: FLAG_TOKEN })
    ).toThrowError(expect.objectContaining({ code: "invalid_endpoint" }));

    let thrown: unknown;
    try {
      resolveJobAccess("portable", {
        endpoint: "https://portable.example",
        jobToken: malformedToken,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toEqual(expect.objectContaining({ code: "invalid_job_token" }));
    expect(JSON.stringify(thrown)).not.toContain(malformedToken);
  });

  it("never sends a local job's token to another endpoint that names the same job ID", () => {
    expect(() => resolveJobAccess("job-1", { endpoint: "https://hostile.example" })).toThrowError(
      expect.objectContaining({
        code: "job_token_required",
        message: expect.stringContaining("is not sent to https://hostile.example"),
        data: { job_id: "job-1", local_endpoint: "https://stored.example", endpoint: "https://hostile.example" },
      })
    );
    expect(resolveJobAccess("job-1", { endpoint: "https://stored.example/" })).toMatchObject({
      stored: storedJob,
      jobToken: STORED_TOKEN,
    });
  });

  it("points a foreign-endpoint read at the evidence row that holds that job's token", () => {
    const evidenceToken = "44".repeat(32);
    const refusal = (): DvmError => {
      try {
        resolveJobAccess("job-1", { endpoint: "https://moved.example" });
      } catch (err) {
        return err as DvmError;
      }
      throw new Error("expected a refusal");
    };
    // A row for the job at the local endpoint, or one without a token, is not it.
    recordLocalJobCollision({ publicRequestId: "elsewhere", endpoint: "https://stored.example", jobId: "job-1", jobToken: evidenceToken, rail: "none" });
    recordLocalJobCollision({ publicRequestId: "tokenless", endpoint: "https://moved.example", jobId: "job-1", jobToken: undefined, rail: "none" });
    expect(refusal().data).not.toHaveProperty("ambiguity_id");

    const row = recordLocalJobCollision({ publicRequestId: "order-7", endpoint: "https://moved.example", jobId: "job-1", jobToken: evidenceToken, rail: "none" });
    const thrown = refusal();

    expect(thrown).toMatchObject({ code: "job_token_required", data: { ambiguity_id: row.ambiguity_id } });
    expect(thrown.hint).toContain(`evidence row ${row.ambiguity_id} in 'dvm wallet submissions'`);
    expect(JSON.stringify(thrown)).not.toContain(evidenceToken);
    expect(JSON.stringify(thrown)).not.toContain(STORED_TOKEN);
  });

  it("lets pay resolve request-scoped replacements when local state exists", () => {
    const access = resolveStoredJobAccess("job-1", {
      endpoint: "https://replacement.example",
      jobToken: FLAG_TOKEN,
    });

    expect(access.stored).toBe(storedJob);
    expect(access.ref.endpoint).toBe("https://replacement.example");
    expect(access.jobToken).toBe(FLAG_TOKEN);
  });

  it("redacts credential echoes throughout structured provider errors", () => {
    const providerError = new DvmError(
      "credential_rejected",
      `Provider rejected ${FLAG_TOKEN}`,
      `Do not retry ${FLAG_TOKEN}`,
      { nested: { display: `Leaked ${FLAG_TOKEN}` } },
      `Rejected ${FLAG_TOKEN}`,
      { message: "provider", hint: "provider", display: "provider" }
    );

    const redacted = redactJobTokenFromError(providerError, FLAG_TOKEN) as DvmError;

    expect(JSON.stringify(redacted)).not.toContain(FLAG_TOKEN);
    expect(redacted.message).toContain("[REDACTED]");
    expect(redacted.data).toEqual({ nested: { display: "Leaked [REDACTED]" } });
    expect(redacted.proseSources).toEqual(providerError.proseSources);
  });
});
