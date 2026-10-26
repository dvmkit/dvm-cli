import { rmSync } from "node:fs";
import { JOBS_FILE } from "@dvmkit/sdk/internal";
import { beforeEach, expect, it, vi } from "vitest";
import type { Message, OutboundMessage } from "@dvmkit/sdk/internal";
import { saveJob, loadJob } from "../src/lib/job-store";
import { HttpsTransport } from "../src/lib/transport/https";

vi.mock("../src/lib/http", () => ({ dvmFetch: async () => new Response("{}", { status: 404 }) }));

beforeEach(() => rmSync(JOBS_FILE, { force: true }));

const equivalents = [
  ["https://provider.invalid/service", "https://provider.invalid/service/"],
  ["https://provider.invalid/service", "HTTPS://PROVIDER.INVALID:443/service///"],
  ["http://provider.invalid/service", "HTTP://PROVIDER.INVALID:80/service/"],
];
const outbound = { type: "text", content: { text: "Caller original" } } as OutboundMessage;
const echo = (): Message => ({ ...outbound, seq: 1, from: "requester", timestamp: 1 }) as Message;

it.each(equivalents)("retains provider job-ID provenance for equivalent URLs %s and %s", async (stored, accessed) => {
  const jobId = "provider-issued-id";
  saveJob({ id: jobId, endpoint: stored, status: "processing", submittedAt: 1 });
  await expect(new HttpsTransport().status(jobId, { endpoint: accessed })).rejects.toMatchObject({
    code: "job_not_found", data: { job_id: jobId, _provider_fields: ["job_id"] },
  });
});

it.each(equivalents)("persists and replays caller ownership across equivalent URLs %s and %s", async (stored, accessed) => {
  vi.resetModules();
  const ownership = await import("../src/lib/message-ownership");
  const jobId = "stored-caller";
  saveJob({ id: jobId, endpoint: stored, status: "processing", submittedAt: 1 });
  ownership.rememberCallerMessage(jobId, accessed, outbound);
  expect(loadJob(jobId)?.callerMessageHashes).toHaveLength(1);
  vi.resetModules();
  const replayOwnership = await import("../src/lib/message-ownership");
  const message = replayOwnership.callerMessageRecognizer(jobId, accessed)(echo());
  expect(replayOwnership.isCallerMessage(message)).toBe(true);
  const otherService = replayOwnership.callerMessageRecognizer(jobId, stored + "/other")(echo());
  expect(replayOwnership.isCallerMessage(otherService)).toBe(false);
});

it.each(equivalents)("recognizes in-process portable caller echoes across equivalent URLs %s and %s", async (sent, replayed) => {
  vi.resetModules();
  const ownership = await import("../src/lib/message-ownership");
  const jobId = "portable-caller";
  ownership.rememberCallerMessage(jobId, sent, outbound);
  const message = ownership.callerMessageRecognizer(jobId, replayed)(echo());
  expect(ownership.isCallerMessage(message)).toBe(true);
  const otherService = ownership.callerMessageRecognizer(jobId, sent + "/other")(echo());
  expect(ownership.isCallerMessage(otherService)).toBe(false);
});
