import { describe, expect, it } from "vitest";

import {
  assertLocalCorrelationIdUnused,
  localCorrelationJobFields,
  type LocallyCorrelatedJob,
  normalizeLocalCorrelationId,
} from "../src/lib/local-correlation";

const CORRELATION_ID = "fa21f3ce-b44c-44f1-8bc9-40fded559e9d";

describe("local request correlation", () => {
  it("accepts only canonical high-entropy UUID v4 markers", () => {
    expect(normalizeLocalCorrelationId(CORRELATION_ID.toUpperCase())).toBe(CORRELATION_ID);
    expect(() => normalizeLocalCorrelationId("not-random")).toThrow(
      /Invalid value for --local-correlation-id/
    );
    expect(() =>
      normalizeLocalCorrelationId("fa21f3ce-b44c-14f1-8bc9-40fded559e9d")
    ).toThrow(/Invalid value for --local-correlation-id/);
  });

  it("adds only the caller-local field to a saved job", () => {
    expect(localCorrelationJobFields(CORRELATION_ID)).toEqual({
      localCorrelationId: CORRELATION_ID,
    });
    expect(localCorrelationJobFields(undefined)).toEqual({});
  });

  it("refuses to reuse a correlation attached to an existing job", () => {
    const jobs = [
      {
        id: "job-1",
        endpoint: "https://dvm.example",
        status: "submitted",
        submittedAt: 1,
        localCorrelationId: CORRELATION_ID,
      } satisfies LocallyCorrelatedJob,
    ];

    expect(() => assertLocalCorrelationIdUnused(CORRELATION_ID, jobs)).toThrow(
      /already attached to a job/
    );
    expect(() => assertLocalCorrelationIdUnused("other", jobs)).not.toThrow();
  });
});
