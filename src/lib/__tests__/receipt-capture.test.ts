vi.mock("@dvmkit/sdk/internal", async () => {
 const actual = await vi.importActual<typeof import("@dvmkit/sdk/internal")>("@dvmkit/sdk/internal");
 return { ...actual, getLastKnownBtcRate: vi.fn(() => ({ rate: 100_000, cachedAt: 1789300000000 })), appendReceipt: vi.fn(),
appendFundingReceipt: vi.fn() };
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JobRecord } from "../job-store";
import type { ProviderRef, Transport } from "@dvmkit/sdk/internal";
import { attestedDvm } from "./fixtures/receipt-fixture";

vi.mock("../output", () => ({ info: vi.fn() }));
vi.mock("../job-store", () => ({ loadJob: vi.fn(() => null), updateJob: vi.fn() }));

import { loadJob, updateJob } from "../job-store";
import { info } from "../output";
import { captureFundingReceipt, captureJobReceipt, fetchMissingJobReceipt, receiptJsonFields, replayStoredReceipt } from "../receipt-capture";
import { appendFundingReceipt, appendReceipt } from "@dvmkit/sdk/internal";

const DVM = attestedDvm("wordcount");
const REF: ProviderRef = { endpoint: "https://wordcount.dvmkit.ai" };

function jobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-a7571b-1",
    endpoint: "https://wordcount.dvmkit.ai",
    status: "completed",
    submittedAt: 1789300000000,
    builderAnchor: DVM.anchor,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(loadJob).mockReturnValue(null);
});

describe("captureJobReceipt", () => {
  it("verifies against the anchor snapshotted when the job ran and files both copies", () => {
    vi.mocked(loadJob).mockReturnValue(jobRecord());
    const receipt = DVM.sign();

    const capture = captureJobReceipt("job-a7571b-1", receipt);

    expect(capture.status).toBe("verified");
    expect(capture.checks).toMatchObject({ job_id: "ok", signature: true, attestation: "ok" });
    expect(updateJob).toHaveBeenCalledWith("job-a7571b-1", { receipt });
    expect(vi.mocked(appendReceipt).mock.calls[0][0]).toMatchObject({
      receipt,
      endpoint: "https://wordcount.dvmkit.ai",
      builder: DVM.anchor,
      verification: "verified",
    });
  });

  it("refuses to file a validly-signed receipt that names another job", () => {
    // Both homes are keyed by job, so storing this would either overwrite this
    // job's proof or squat the other job's slot with an entry nothing
    // collected — and `receipts show <thisJob>` would then 404 on a request
    // that had just reported "verified".
    vi.mocked(loadJob).mockReturnValue(jobRecord({ id: "job-mine" }));

    const capture = captureJobReceipt("job-mine", DVM.sign());

    expect(capture.status).toBe("invalid");
    expect(capture.reason).toBe("job_id_mismatch");
    expect(updateJob).not.toHaveBeenCalled();
    expect(appendReceipt).not.toHaveBeenCalled();
    expect(capture.receipt).toBeDefined();
    expect(vi.mocked(info).mock.calls.flat().join("\n")).toContain("did not verify");
  });

  it("reports absent with no side effects when the response carried no receipt", () => {
    const capture = captureJobReceipt("job-a7571b-1", undefined);

    expect(capture.status).toBe("absent");
    expect(receiptJsonFields(capture)).toEqual({ receipt_verified: "absent" });
    expect(updateJob).not.toHaveBeenCalled();
    expect(appendReceipt).not.toHaveBeenCalled();
  });

  it("warns and reports unparseable when a response offered an invalid shape", () => {
    const capture = captureJobReceipt("job-a7571b-1", undefined, "shape_invalid");

    expect(receiptJsonFields(capture)).toEqual({
      receipt_verified: "unparseable",
      receipt_display:
        "UNREADABLE receipt: this DVM returned a receipt block that does not match the signed receipt protocol shape. The job itself is unaffected.",
      receipt_error: "shape_invalid",
    });
    expect(vi.mocked(info).mock.calls.flat().join("\n")).toContain(
      "receipt could not be parsed (shape_invalid)"
    );
    expect(updateJob).toHaveBeenCalledWith("job-a7571b-1", {
      receiptParseError: "shape_invalid",
    });
    expect(appendReceipt).not.toHaveBeenCalled();
  });

  it("swallows an unwritable store rather than failing a paid job", () => {
    vi.mocked(loadJob).mockReturnValue(jobRecord());
    vi.mocked(updateJob).mockImplementationOnce(() => {
      throw new Error("ENOSPC: no space left on device");
    });

    expect(captureJobReceipt("job-a7571b-1", DVM.sign()).status).toBe("verified");
    expect(vi.mocked(info).mock.calls.flat().join("\n")).toContain("could not store job receipt");
  });
});

describe("captureFundingReceipt", () => {
  it("files a matching funding tuple and refuses invalid evidence", () => {
    const receipt = DVM.signFunding();
    const args = {
      receipt,
      endpoint: "https://wordcount.dvmkit.ai",
      builder: DVM.anchor,
      expectedCreditId: "credit-1",
      expectedFundId: "fund-1",
      expectedFundedMicro: 500_000,
      expectedBalanceAfterMicro: 750_000,
      expectedLedgerSeq: 3,
      expectedCallerPubkey: "bb".repeat(32),
    };
    expect(captureFundingReceipt(args)).toBe("verified");
    expect(appendFundingReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        receipt,
        endpoint: "https://wordcount.dvmkit.ai",
        builder: DVM.anchor,
        verification: "verified",
      })
    );
    vi.mocked(appendFundingReceipt).mockClear();
    vi.mocked(info).mockClear();
    expect(captureFundingReceipt({ ...args, expectedFundedMicro: 500_001 })).toBe("invalid");
    expect(appendFundingReceipt).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("funding_amount_mismatch"));
  });
});

describe("fetchMissingJobReceipt", () => {
  const statusRead = vi.fn();
  const transport = { status: statusRead } as unknown as Transport;

  it("spends one read against a DVM that advertised receipts", async () => {
    const receipt = DVM.sign();
    vi.mocked(loadJob).mockReturnValue(jobRecord({ receiptsSupported: true }));
    statusRead.mockResolvedValue({ status: "completed", receipt });

    expect(await fetchMissingJobReceipt("job-a7571b-1", transport, REF)).toEqual({ receipt });
  });

  it("hands back the receipt it already holds instead of reporting absent", async () => {
    const receipt = DVM.sign();
    vi.mocked(loadJob).mockReturnValue(jobRecord({ receiptsSupported: true, receipt }));

    expect(await fetchMissingJobReceipt("job-a7571b-1", transport, REF)).toEqual({ receipt });
    expect(statusRead).not.toHaveBeenCalled();
  });

  it("re-reads when the receipt on the record isn't structurally one", async () => {
    const { receipt_pubkey: _dropped, ...body } = DVM.sign();
    const fresh = DVM.sign();
    vi.mocked(loadJob).mockReturnValue(
      jobRecord({ receiptsSupported: true, receipt: body as never })
    );
    statusRead.mockResolvedValue({ status: "completed", receipt: fresh });

    expect(await fetchMissingJobReceipt("job-a7571b-1", transport, REF)).toEqual({
      receipt: fresh,
    });
  });

  it("costs nothing against a DVM that issues no receipts", async () => {
    vi.mocked(loadJob).mockReturnValue(jobRecord());

    expect(await fetchMissingJobReceipt("job-a7571b-1", transport, REF)).toEqual({});
    expect(statusRead).not.toHaveBeenCalled();
  });

  it("gives up quietly when the read fails", async () => {
    vi.mocked(loadJob).mockReturnValue(jobRecord({ receiptsSupported: true }));
    statusRead.mockRejectedValue(new Error("connection reset"));

    expect(await fetchMissingJobReceipt("job-a7571b-1", transport, REF)).toEqual({});
  });

  it("preserves a malformed receipt marker from the recovery read", async () => {
    vi.mocked(loadJob).mockReturnValue(jobRecord({ receiptsSupported: true }));
    statusRead.mockResolvedValue({
      status: "completed",
      receiptParseError: "shape_invalid",
    });

    expect(await fetchMissingJobReceipt("job-a7571b-1", transport, REF)).toEqual({
      receiptParseError: "shape_invalid",
    });
  });
});

describe("replayStoredReceipt", () => {
  it("re-runs the chain rather than replaying a cached verdict", () => {
    const receipt = DVM.sign();
    const tampered = { ...receipt, paid: { ...receipt.paid, msats: 1 } };

    expect(replayStoredReceipt(jobRecord({ receipt })).status).toBe("verified");
    expect(replayStoredReceipt(jobRecord({ receipt: tampered })).status).toBe("invalid");
  });

  it("catches a job record carrying another job's receipt", () => {
    const capture = replayStoredReceipt(jobRecord({ id: "job-mine", receipt: DVM.sign() }));
    expect(capture.status).toBe("invalid");
    expect(capture.reason).toBe("job_id_mismatch");
  });

  it("reports absent rather than throwing on a record whose receipt lost a field", () => {
    // `jobs.json` is hand-editable, so the record's type is not evidence. A
    // body missing `paid` reaches `receiptDisplay`'s `paid.msats` unguarded and
    // exits `internal` on a job that already ran. It is `absent`, not
    // `invalid`: without those fields there is nothing to verify a verdict
    // about, and `receipts.jsonl` still holds the collected copy.
    const { paid: _dropped, ...body } = DVM.sign();

    const capture = replayStoredReceipt(jobRecord({ receipt: body as never }));

    expect(capture.status).toBe("absent");
    expect(capture.receipt).toBeUndefined();
  });

  it("replays a stored transport parse error instead of degrading it to absent", () => {
    const capture = replayStoredReceipt(jobRecord({ receiptParseError: "shape_invalid" }));

    expect(receiptJsonFields(capture)).toMatchObject({
      receipt_verified: "unparseable",
      receipt_error: "shape_invalid",
    });
  });
});
