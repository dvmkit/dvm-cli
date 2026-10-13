import { createHash } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const output = vi.hoisted(() => ({ json: vi.fn() }));
vi.mock("../src/lib/output", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/output")>("../src/lib/output")),
  json: output.json,
}));

import { doctor } from "../src/commands/doctor";
import { recordSubmissionEvidence, SUBMISSION_EVIDENCE_DIR } from "../src/lib/submission-evidence";

const exitCode = process.exitCode;

beforeEach(() => {
  output.json.mockReset();
  rmSync(SUBMISSION_EVIDENCE_DIR, { recursive: true, force: true });
});

afterEach(() => {
  process.exitCode = exitCode;
});

describe("dvm doctor submission evidence", () => {
  // A record can hold an anonymous job's bearer token.
  it("names each evidence file that is readable beyond its owner", async () => {
    const kept = recordSubmissionEvidence(evidence("6f1b1d3e-6f1a-4f0e-9a3d-2b7c8f5e4a11"));
    const loose = recordSubmissionEvidence(evidence("7f1b1d3e-6f1a-4f0e-9a3d-2b7c8f5e4a12"));
    chmodSync(pathOf(loose.ambiguity_id), 0o644);

    await doctor({ network: false });

    expect(evidenceCheck()).toMatchObject({
      status: "warn",
      details: { offending_paths: [pathOf(loose.ambiguity_id)] },
      hint: `Tighten permissions: chmod 600 ${pathOf(loose.ambiguity_id)}`,
    });
    expect(JSON.stringify(evidenceCheck())).not.toContain(pathOf(kept.ambiguity_id));
  });

  it("passes evidence files written at 0600", async () => {
    recordSubmissionEvidence(evidence("6f1b1d3e-6f1a-4f0e-9a3d-2b7c8f5e4a11"));

    await doctor({ network: false });

    expect(evidenceCheck()).toMatchObject({ status: "ok" });
  });
});

function evidence(cashuRequestId: string) {
  return {
    observation: { kind: "body_unreadable" as const, headerJobId: "job-a", jobToken: "f".repeat(64) },
    endpoint: "https://dvm.test",
    cashuRequestId,
    rail: "cashu" as const,
  };
}

/** A record's file is named by the SHA-256 of its ambiguity ID. */
function pathOf(ambiguityId: string): string {
  return join(SUBMISSION_EVIDENCE_DIR, `${createHash("sha256").update(ambiguityId).digest("hex")}.json`);
}

function evidenceCheck(): Record<string, unknown> | undefined {
  const report = output.json.mock.calls.at(-1)?.[0] as { checks: Record<string, unknown>[] };
  return report.checks.find((check) => check.name === "file_submission_evidence");
}
