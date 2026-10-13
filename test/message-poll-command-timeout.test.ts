import { DvmError } from "@dvmkit/sdk/internal";
import { beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  close: vi.fn(),
  getMessages: vi.fn(),
  status: vi.fn(),
}));

vi.mock("../src/lib/job-access", () => ({
  resolveJobAccess: () => ({
    stored: null,
    ref: { endpoint: "https://dvm.example" },
    jobToken: "ab".repeat(32),
    overridden: true,
    endpointOverridden: true,
  }),
  withJobTokenRedaction: (_jobToken: string, action: () => Promise<unknown>) => action(),
}));

vi.mock("../src/lib/transport", () => ({
  createDvmTransport: () => ({
    close: seams.close,
    getMessages: seams.getMessages,
    status: seams.status,
  }),
}));

import { messages } from "../src/commands/messages";
import { status } from "../src/commands/status";

beforeEach(() => {
  seams.getMessages.mockRejectedValue(new DvmError("timeout", "Message poll timed out."));
  seams.status.mockResolvedValue({ jobId: "job-1", status: "processing" });
});

describe("message poll command deadlines", () => {
  it("passes the direct messages timeout and job token to the transport", async () => {
    await expect(
      messages("job-1", { stream: false, timeout: "1.25" })
    ).rejects.toMatchObject({ code: "timeout" });

    expect(seams.getMessages).toHaveBeenCalledExactlyOnceWith(
      "job-1",
      0,
      { endpoint: "https://dvm.example" },
      { timeoutMs: 1_250, jobToken: "ab".repeat(32) }
    );
  });

  it("passes the status --messages timeout and job token to the transport", async () => {
    await expect(status("job-1", { messages: true, timeout: "2.5" })).rejects.toMatchObject({
      code: "timeout",
    });

    expect(seams.status).toHaveBeenCalledExactlyOnceWith(
      "job-1",
      { endpoint: "https://dvm.example" },
      { timeoutMs: 2_500, jobToken: "ab".repeat(32) }
    );
    expect(seams.getMessages).toHaveBeenCalledExactlyOnceWith(
      "job-1",
      0,
      { endpoint: "https://dvm.example" },
      { timeoutMs: 2_500, jobToken: "ab".repeat(32) }
    );
  });
});
