import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveIdentityFromPrivkey, REQUEST_INTENTS_DIR, type ProviderInfo } from "@dvmkit/sdk/internal";

const seams = vi.hoisted(() => ({
  describe: vi.fn(), quote: vi.fn(), submit: vi.fn(), close: vi.fn(),
  getMessages: vi.fn(), sendMessage: vi.fn(), requestResult: vi.fn(), requestResume: vi.fn(),
}));
vi.mock("../src/lib/transport", () => ({ createDvmTransport: () => seams }));
vi.mock("../src/lib/output", async (original) => ({
  ...await original<typeof import("../src/lib/output")>(), json: vi.fn(), info: vi.fn(),
}));
vi.mock("../src/lib/btc-rate", async (original) => ({
  ...await original<typeof import("../src/lib/btc-rate")>(),
  resolveBtcUsdRate: async () => ({ rate: 100_000, stale: false }),
  tryResolveBtcUsdRate: async () => ({ rate: 100_000, stale: false }),
}));

import { request } from "../src/commands/request";
import { requestResult } from "../src/commands/request-result";
import { requestResume } from "../src/commands/request-resume";
import { json } from "../src/lib/output";
import { loadRequestIntent } from "../src/lib/request-intent-store";
import { loadRequestRefusal, REQUEST_REFUSALS_DIR } from "../src/lib/request-refusal-store";

const endpoint = "https://provider.example";
const signer = deriveIdentityFromPrivkey("01".repeat(32));
const root = process.env.DVM_CONFIG_DIR!;
const rid = "order:42";
const info: ProviderInfo = {
  name: "Test provider", capabilities: { work: { description: "Work" } },
  requestRecovery: true, auth: ["secp256k1-schnorr-v2"],
  authAudience: { dvm_id: "test-provider", builder_pubkey: "03".repeat(32) },
  credit: { funding: ["cashu"], balance_payment: true, currency: "usd", min_micro: 1, max_micro: 5_000_000, ttl_ms: 86_400_000 },
};
const submitArgs = { endpoint, input: "work", budget: "$1.50", autoPayBelow: "$0.90", creditOnly: "approved-credit", requestId: rid, stream: false };

function seedCredit(posture: "off" | "suggest"): void {
  writeFileSync(join(root, "config.json"), JSON.stringify({ credit: { posture } }));
  writeFileSync(join(root, "credits.json"), JSON.stringify({ credits: [{ endpoint, callerPubkey: signer.pubkey,
    creditId: "approved-credit", currency: "usd", remainingMicro: 3_000_000, balanceMicro: 3_000_000,
    targetMicro: 3_000_000, expiryMs: Date.now() + 86_400_000, status: "active", ledgerSeq: 1 }], implicitCredits: [], pendingFundings: [] }));
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  vi.mocked(json).mockClear();
  seams.describe.mockResolvedValue(info);
  seams.quote.mockResolvedValue([]);
  seams.submit.mockResolvedValue({ jobId: "job-1", status: "processing" });
  seams.requestResult.mockResolvedValue({ jobId: "job-1", status: "processing" });
  vi.stubEnv("DVM_IDENTITY_KEY", signer.privkey);
  fetchMock = vi.fn().mockRejectedValue(new Error("Unexpected network access"));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const noProviderContact = () => {
  expect(seams.submit).not.toHaveBeenCalled();
  expect(seams.requestResult).not.toHaveBeenCalled();
  expect(seams.requestResume).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
};

describe("a request refused before it was sent", () => {
  it("is reported as not submitted by the refusal, request-result and request-resume", async () => {
    seedCredit("off");
    await expect(request(submitArgs)).rejects.toMatchObject({
      code: "credit_only_unavailable", data: { reason: "posture_off", submitted: false },
    });
    expect(seams.submit).not.toHaveBeenCalled();
    expect(loadRequestIntent(rid)).toBeNull();

    for (const lookup of [requestResult, requestResume]) {
      await expect(lookup(rid)).rejects.toMatchObject({
        code: "request_not_submitted",
        hint: expect.stringContaining("Retrying the same approved request is safe"),
        data: { request_id: rid, status: "not_submitted", submitted: false,
          refusal_code: "credit_only_unavailable", refusal_reason: "posture_off" },
      });
    }
    noProviderContact();
  });

  it("covers the refusal that runs before the credit plan is built", async () => {
    seedCredit("suggest");
    await expect(request({ ...submitArgs, creditOnly: "another-credit" })).rejects.toMatchObject({
      code: "credit_only_unavailable", data: { submitted: false },
    });
    await expect(requestResult(rid)).rejects.toMatchObject({
      code: "request_not_submitted", data: { refusal_code: "credit_only_unavailable" },
    });
    noProviderContact();
  });

  it("keeps the ID free: the retry succeeds and the lookup then follows the job", async () => {
    seedCredit("off");
    await expect(request(submitArgs)).rejects.toMatchObject({ data: { submitted: false } });
    expect(loadRequestRefusal(rid)).not.toBeNull();

    seedCredit("suggest");
    await request(submitArgs);
    expect(seams.submit).toHaveBeenCalledTimes(1);
    expect(loadRequestIntent(rid)).toMatchObject({ requestId: rid, creditOnly: "approved-credit" });
    expect(existsSync(join(REQUEST_REFUSALS_DIR, `${rid}.json`))).toBe(false);

    await requestResult(rid);
    expect(seams.requestResult).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenLastCalledWith(expect.objectContaining({ request_id: rid, jobId: "job-1" }));
  });

  it("stays unknown, with no record, when the ID was already submitted", async () => {
    seedCredit("suggest");
    await request(submitArgs);
    const intentFile = join(REQUEST_INTENTS_DIR, rid, "intent.json");
    const intentBefore = readFileSync(intentFile, "utf8");
    seams.submit.mockClear();

    seedCredit("off");
    const rerun = await request(submitArgs).catch((error: unknown) => error);
    expect(rerun).toMatchObject({ code: "credit_only_unavailable", data: { reason: "posture_off" } });
    expect((rerun as { data: Record<string, unknown> }).data).not.toHaveProperty("submitted");
    expect(existsSync(join(REQUEST_REFUSALS_DIR, `${rid}.json`))).toBe(false);
    expect(readFileSync(intentFile, "utf8")).toBe(intentBefore);

    await requestResult(rid);
    expect(seams.requestResult).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: "job-1" }));
  });

  it("does not report a submitted ID as unsent after its intent is lost", async () => {
    seedCredit("off");
    await expect(request(submitArgs)).rejects.toMatchObject({ data: { submitted: false } });
    seedCredit("suggest");
    await request(submitArgs);

    rmSync(join(REQUEST_INTENTS_DIR, rid), { recursive: true, force: true });
    for (const lookup of [requestResult, requestResume]) {
      await expect(lookup(rid)).rejects.toMatchObject({
        code: "request_not_found", data: { request_id: rid, status: "unknown" },
      });
    }
  });

  it("lets a real intent win over a refusal record that was left behind", async () => {
    seedCredit("suggest");
    await request(submitArgs);
    mkdirSync(REQUEST_REFUSALS_DIR, { recursive: true });
    writeFileSync(join(REQUEST_REFUSALS_DIR, `${rid}.json`), JSON.stringify({ v: 1, requestId: rid, code: "credit_only_unavailable", refusedAt: 1 }));
    await requestResult(rid);
    expect(seams.requestResult).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: "job-1" }));
  });

  it("leaves an ID with neither intent nor refusal as unknown", async () => {
    for (const lookup of [requestResult, requestResume]) {
      await expect(lookup("never-seen")).rejects.toMatchObject({
        code: "request_not_found", data: { request_id: "never-seen", status: "unknown" },
      });
    }
    noProviderContact();
  });

  it("stores only the request ID, code, reason and time", async () => {
    seedCredit("off");
    await expect(request(submitArgs)).rejects.toMatchObject({ data: { submitted: false } });
    const files = readdirSync(REQUEST_REFUSALS_DIR);
    expect(files).toEqual([`${rid}.json`]);
    expect(Object.keys(JSON.parse(readFileSync(join(REQUEST_REFUSALS_DIR, files[0]!), "utf8"))).sort())
      .toEqual(["code", "reason", "refusedAt", "requestId", "v"]);
    expect(existsSync(join(REQUEST_INTENTS_DIR, rid))).toBe(false);
  });
});

describe("refusal record reads", () => {
  it("treats a malformed record as no record", () => {
    mkdirSync(REQUEST_REFUSALS_DIR, { recursive: true });
    writeFileSync(join(REQUEST_REFUSALS_DIR, "broken.json"), "{not json");
    writeFileSync(join(REQUEST_REFUSALS_DIR, "wrong-id.json"), JSON.stringify({ v: 1, requestId: "other", code: "x", refusedAt: 1 }));
    expect(loadRequestRefusal("broken")).toBeNull();
    expect(loadRequestRefusal("wrong-id")).toBeNull();
  });
});
