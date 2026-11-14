import { DvmError, type StreamOptions, type Transport } from "@dvmkit/sdk/internal";
import lockfile from "proper-lockfile";
import { afterEach, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  writes: [] as { fd: number; text: string }[],
  transport: {} as Transport,
}));
vi.mock("../src/lib/transport", () => ({ createDvmTransport: () => captured.transport }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, writeSync: vi.fn((fd: number, buffer: Uint8Array, offset = 0, length = buffer.length) => {
    if (fd !== 1 && fd !== 2) return actual.writeSync(fd, buffer, offset, length);
    captured.writes.push({ fd, text: Buffer.from(buffer).subarray(offset, offset + length).toString() });
    return length;
  }) };
});

import { messages } from "../src/commands/messages";
import { catchErrors } from "../src/lib/error-handler";
import { saveJob, updateObservedJob } from "../src/lib/job-store";

afterEach(() => vi.restoreAllMocks());

it("ends a failed wait with the local-state warning after messages already written", async () => {
  const jobId = "wait-unsaved-error";
  const token = "ab".repeat(32);
  saveJob({ id: jobId, endpoint: "https://provider.example", jobToken: token, status: "processing", submittedAt: 0 });
  captured.writes.length = 0;
  captured.transport = {
    status: vi.fn().mockResolvedValue({ status: "processing" }),
    stream: vi.fn(async (_job: string, _after: number, _provider: unknown, options: StreamOptions) => {
      options.onMessage?.({ seq: 1, from: "provider", timestamp: 1, type: "text", content: { text: "Still working" } });
      vi.spyOn(lockfile, "lockSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("Storage unavailable"), { code: "EACCES" });
      });
      updateObservedJob(jobId, { messageCursor: 1 });
      throw new DvmError("provider_unreachable", `Connection lost for ${token}`);
    }),
    close: vi.fn(),
  } as unknown as Transport;
  const exit = new Error("process exit");
  vi.spyOn(process, "exit").mockImplementation(() => { throw exit; });

  await expect(catchErrors(() => messages(jobId, { wait: true }), false, { event: "error" })).rejects.toBe(exit);

  const stdout = captured.writes.filter(({ fd }) => fd === 1).map(({ text }) => text).join("");
  const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
  expect(lines.map((line) => line.event)).toEqual(["message", "error"]);
  expect(lines[0]).toMatchObject({ seq: 1, type: "text" });
  expect(lines[0]).not.toHaveProperty("warnings");
  expect(lines[1]).toMatchObject({
    error: { code: "provider_unreachable", message: "Connection lost for [REDACTED]" },
    warnings: [{
      code: "local_job_state_unsaved",
      display: expect.stringContaining("Automatic payments are paused"),
      hint: expect.stringContaining("dvm status"),
    }],
  });
  expect(lines[1].warnings).toHaveLength(1);
  expect(stdout).not.toContain(token);
  expect(captured.writes.filter(({ fd, text }) => fd === 2 && text.startsWith("Warning:"))).toEqual([]);
  expect(captured.transport.close).toHaveBeenCalledOnce();
  expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
});
