import { describe, expect, it, vi } from "vitest";
import { DvmError } from "@dvmkit/sdk/internal";
import { PAYMENT_IN_PROGRESS_ATTEMPTS, retryWhilePaymentInProgress } from "../src/lib/job-ending";

const inProgress = (retry_after_ms?: number) =>
  new DvmError("payment_in_progress", "A payment is being verified.", undefined, retry_after_ms === undefined ? undefined : { retry_after_ms });

describe("ending a job while a payment is verified", () => {
  it("resends after each Retry-After wait until the write lands", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(inProgress(3000))
      .mockRejectedValueOnce(inProgress())
      .mockResolvedValueOnce("ended");
    const sleep = vi.fn(async () => undefined);
    await expect(retryWhilePaymentInProgress(send, { sleep })).resolves.toBe("ended");
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[3000], [2000]]);
  });

  it("caps a provider's wait so the command cannot hang on it", async () => {
    const sleep = vi.fn(async () => undefined);
    const send = vi.fn().mockRejectedValueOnce(inProgress(3_600_000)).mockResolvedValueOnce(undefined);
    await retryWhilePaymentInProgress(send, { sleep });
    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it(`gives up after ${PAYMENT_IN_PROGRESS_ATTEMPTS} attempts with the provider's refusal`, async () => {
    const send = vi.fn().mockRejectedValue(inProgress(0));
    await expect(retryWhilePaymentInProgress(send, { sleep: async () => undefined }))
      .rejects.toMatchObject({ code: "payment_in_progress" });
    expect(send).toHaveBeenCalledTimes(PAYMENT_IN_PROGRESS_ATTEMPTS);
  });

  it("does not resend after any other refusal", async () => {
    const send = vi.fn().mockRejectedValue(new DvmError("no_open_ask", "Nothing to decline."));
    const sleep = vi.fn(async () => undefined);
    await expect(retryWhilePaymentInProgress(send, { sleep })).rejects.toMatchObject({ code: "no_open_ask" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
