import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JOBS_FILE, deriveIdentityFromPrivkey, type ProviderInfo, type Quote, type Transport } from "@dvmkit/sdk/internal";

const seams = vi.hoisted(() => ({
  describe: vi.fn(), quote: vi.fn(), submit: vi.fn(), close: vi.fn(),
  getMessages: vi.fn(), sendMessage: vi.fn(), requestResult: vi.fn(),
  stdout: [] as string[], stderr: [] as string[],
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, writeSync: (...args: Parameters<typeof fs.writeSync>) => {
    if (args[0] === 1 || args[0] === 2) {
      const data = args[1] as unknown as Uint8Array;
      const offset = typeof args[2] === "number" ? args[2] : 0;
      const length = typeof args[3] === "number" ? args[3] : data.byteLength;
      (args[0] === 1 ? seams.stdout : seams.stderr).push(Buffer.from(data).subarray(offset, offset + length).toString());
      return length;
    }
    return Reflect.apply(fs.writeSync, fs, args);
  } };
});
vi.mock("../src/lib/transport", () => ({ createDvmTransport: () => seams }));
vi.mock("../src/lib/btc-rate", async (original) => ({
  ...await original<typeof import("../src/lib/btc-rate")>(),
  resolveBtcUsdRate: async () => ({ rate: 100_000, stale: false }),
  tryResolveBtcUsdRate: async () => ({ rate: 100_000, stale: false }),
}));

import { quote } from "../src/commands/quote";
import { request } from "../src/commands/request";
import { createSignedRequestVerifier } from "@dvmkit/sdk";
import { requestResult } from "../src/commands/request-result";
import { streamLoop } from "../src/lib/stream-loop";
import { handlePaymentRequest } from "../src/lib/payment-responder";
import { loadJob, saveJob } from "../src/lib/job-store";
import { nextActionHuman } from "../src/lib/next-action-human";
import { buildProgram } from "../src/cli/dvm";

const endpoint = "https://provider.example";
const signer = deriveIdentityFromPrivkey("01".repeat(32));
const root = process.env.DVM_CONFIG_DIR!;
const policy = { maxTotalMsats: 1_500_000, autoPayBelowMsats: 300_000, maxIncrementMsats: 1_500_000, maxPayments: 5 };
const ask = { amount_msats: 900_000, fiat_amount: { amount: 0.9, currency: "usd" }, reason: "More work",
  credit: { amount_micro: 900_000, currency: "usd" } };
const walletAsk = { ...ask, x402: { pay_to: `0x${"f".repeat(40)}`, network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", required_usdc_micro: "900000" } };
const metered: Quote = { upfront: { amount: 0, currency: "usd" }, description: "Metered", priceMsats: 0,
  rate: { per_unit: { amount: 0.09, currency: "usd" }, max_units: 10, unit: "block" }, shape: "rate" };
const info: ProviderInfo = { name: "Test provider", capabilities: { work: { description: "Work" } } };

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  seams.stdout.length = 0;
  seams.stderr.length = 0;
  seams.describe.mockResolvedValue(info);
  seams.quote.mockResolvedValue([metered]);
  seams.submit.mockResolvedValue({ jobId: "job-metered", status: "processing" });
  seams.getMessages.mockResolvedValue([{ seq: 1, from: "provider", timestamp: 1, type: "payment-request", content: ask }]);
  seams.sendMessage.mockResolvedValue({ seq: 2 });
  vi.stubEnv("DVM_IDENTITY_KEY", signer.privkey);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network access")));
});

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const output = () => JSON.parse(seams.stdout.join("").trim().split("\n").at(-1)!);

function snapshot(path = root): Record<string, string> {
  return Object.fromEntries(readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const full = join(path, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(full)).map(([name, data]) => [`${entry.name}/${name}`, data])
      : [[entry.name, readFileSync(full, "utf8")]];
  }));
}

function seedWallet(): void {
  writeFileSync(join(root, "config.json"), JSON.stringify({
    x402: { privateKey: `0x${"11".repeat(32)}`, network: "eip155:8453" },
    feedback: { posture: "off" },
  }));
}

function seedCredit(): void {
  seams.describe.mockResolvedValue({ ...info, requestRecovery: true, auth: ["secp256k1-schnorr-v2"],
    authAudience: { dvm_id: "test-provider", builder_pubkey: "03".repeat(32) },
    credit: { funding: ["cashu"], balance_payment: true, currency: "usd", min_micro: 1, max_micro: 5_000_000, ttl_ms: 86_400_000 } });
  writeFileSync(join(root, "credits.json"), JSON.stringify({ credits: [{ endpoint, callerPubkey: signer.pubkey,
    creditId: "approved-credit", currency: "usd", remainingMicro: 3_000_000, balanceMicro: 3_000_000,
    targetMicro: 3_000_000, expiryMs: Date.now() + 86_400_000, status: "active", ledgerSeq: 1 }], implicitCredits: [], pendingFundings: [] }));
}

describe("metered caller guidance", () => {
  it("accepts quote preview flags through the CLI without payment or stored consent", async () => {
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const before = snapshot();
    await buildProgram().parseAsync(["quote", "--endpoint", endpoint, "--input", "work", "--budget", "$1.50", "--auto-pay-below", "$0.40"], { from: "user" });
    expect(output().warnings[0]).toMatchObject({ auto_pay_below: "'$0.9'", bound: "$0.4 USD" });
    expect(seams.submit).not.toHaveBeenCalled();
    expect(seams.sendMessage).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it("uses config limits and omits warnings once the explicit bound covers the quote", async () => {
    writeFileSync(join(root, "config.json"), JSON.stringify({ defaultBudget: "$1.50", autoPayThreshold: "$0.40" }));
    await quote({ endpoint, input: "work" });
    expect(output().warnings[0].bound).toBe("$0.4 USD");
    seams.stdout.length = 0;
    await quote({ endpoint, input: "work", autoPayBelow: "$0.90" });
    expect(output()).not.toHaveProperty("warnings");
  });

  it("uses the advertised ceiling when the quote supplies no bounded amount", async () => {
    seams.quote.mockResolvedValue([{ ...metered, rate: undefined }]);
    seams.describe.mockResolvedValue({ ...info, capabilities: { work: { pricing: { max: { amount: 1.25, currency: "usd" } } } } });
    await quote({ endpoint, input: "work", budget: "$1.50" });
    expect(output().warnings[0]).toMatchObject({ source: "provider_ceiling", auto_pay_below: "'$1.25'" });
    expect(output().warnings[0].display).toContain("this provider's advertised job ceiling");
  });

  it("prints the preview in human mode and does not leak warnings to another command", async () => {
    await quote({ endpoint, input: "work", budget: "$1.50", human: true });
    expect(seams.stderr.join("")).toContain("--auto-pay-below '$0.9'");
    expect(seams.stdout).toEqual([]);
    await quote({ endpoint, input: "work" });
    expect(output()).not.toHaveProperty("warnings");
  });

  it("warns before submitting and yields an over-bound in-budget ask without paying", async () => {
    seams.submit.mockImplementation(async () => {
      expect(seams.stderr.join("")).toContain("--auto-pay-below 900000");
      return { jobId: "job-metered", status: "processing" };
    });
    await request({ endpoint, input: "work", budget: "$1.50", autoPay: true, human: true });
    expect(seams.sendMessage).not.toHaveBeenCalled();
    expect(seams.stderr.join("")).toContain("For the next run, use --auto-pay-below 900000");
    const result = await streamLoop({ jobId: "job-metered", transport: seams as unknown as Transport,
      provider: { endpoint }, policy, afterSeq: 0 });
    expect(result.nextAction).toMatchObject({ type: "pay", amount_msats: 900_000 });
    expect(result.nextAction?.hint).toContain("dvm pay job-metered");
    expect(result.nextAction?.hint).toContain("--auto-pay-below 900000");
    expect(nextActionHuman(result.nextAction)).toContain("--auto-pay-below 900000");
    expect(result.autoPayments).toEqual([]);
    expect(loadJob("job-metered")?.totalPaidMsats ?? 0).toBe(0);
  });

  it("carries the pre-submit warning into JSON for a direct no-stream submit", async () => {
    await request({ endpoint, input: "work", budget: "$1.50", autoPay: true, stream: false });
    expect(output()).toMatchObject({ warnings: [{ auto_pay_below: "900000" }], next_action: { type: "poll" } });
  });

  it("uses returned payment quotes when the advisory quote endpoint is unavailable", async () => {
    seams.quote.mockRejectedValue(new Error("Quote endpoint unavailable"));
    seams.submit.mockResolvedValue({ jobId: "", status: "payment-required", quotes: [metered] });
    await request({ endpoint, input: "work", budget: "$1.50" });
    expect(output()).toMatchObject({ status: "quotes-collected", warnings: [{ auto_pay_below: "900000" }] });
    expect(seams.sendMessage).not.toHaveBeenCalled();
  });

  it("does not suggest a threshold increase when the remaining budget or increment is insufficient", async () => {
    for (const overrides of [{ totalPaidMsats: 1_000_000 }, { policy: { ...policy, maxIncrementMsats: 800_000 } }]) {
      saveJob({ id: "job-metered", endpoint, status: "processing", submittedAt: Date.now(), upfrontRailPayment: "free", policy, ...overrides });
      const job = loadJob("job-metered")!;
      const result = await streamLoop({ jobId: job.id, transport: seams as unknown as Transport,
        provider: { endpoint }, policy: job.policy, afterSeq: 0 });
      expect(result.nextAction?.hint).not.toContain("--auto-pay-below");
      expect(seams.sendMessage).not.toHaveBeenCalled();
    }
  });
});

describe("credit-only threshold", () => {
  it("accepts a raised bound, persists the restriction and pays only the named credit", async () => {
    seedCredit();
    const verifier = createSignedRequestVerifier({ _zod: {}, parse: (data: unknown) => data,
      safeParse: (data: unknown) => ({ success: true as const, data }) }, { replayStore: null });
    seams.quote.mockImplementation(async (_ref, envelope) => {
      verifier.checkAuth(envelope.data, { audience: { dvm_id: "test-provider", builder_pubkey: "03".repeat(32) },
        method: "POST", path: "v1/quote", capability: "work" });
      return [metered];
    });
    seams.submit.mockImplementation(async (_ref, envelope) => ({ jobId: "job-metered", status: "processing",
      upfrontPayment: { amount_msats: 0, credit_id: "approved-credit", draw_id: envelope.data.draw_id,
        amount_micro: 0, currency: "usd" } }));
    await request({ endpoint, input: "work", budget: "$1.50", autoPayBelow: "$0.90", creditOnly: "approved-credit", requestId: "request-approved", stream: false });
    expect(seams.quote).toHaveBeenCalledTimes(1);
    expect(loadJob("job-metered")).toMatchObject({ creditOnly: "approved-credit", policy: { autoPayBelowMsats: 900_000 } });
    await handlePaymentRequest("job-metered", ask, loadJob("job-metered")!.policy!,
      seams as unknown as Transport, { endpoint }, { requestSeq: 1 });
    expect(seams.sendMessage).toHaveBeenCalledWith("job-metered", { type: "payment", content: { credit: expect.objectContaining({ credit_id: "approved-credit", amount_micro: 900_000 }) } }, { endpoint }, expect.anything());
    expect(loadJob("job-metered")?.totalPaidMsats).toBe(900_000);
  });

  it("never pays a fresh upfront quote when a credit-only draw is refused", async () => {
    seedCredit();
    seams.submit.mockResolvedValue({ jobId: "", status: "payment-required", quotes: [metered] });
    await expect(request({ endpoint, input: "work", budget: "$1.50", autoPayBelow: "$0.90", creditOnly: "approved-credit", requestId: "request-refused" }))
      .rejects.toMatchObject({ code: "credit_only_unavailable" });
    expect(seams.submit).toHaveBeenCalledTimes(1);
    expect(seams.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["missing", "refused", "forced-rail"])("blocks wallet fallback after %s credit", async (mode) => {
    seedCredit();
    seedWallet();
    saveJob({ id: "job-metered", endpoint, status: "processing", submittedAt: Date.now(), upfrontRailPayment: "free",
      policy: { ...policy, autoPayBelowMsats: 900_000 }, creditOnly: "approved-credit",
      creditBinding: { creditId: "approved-credit", drawId: "draw-approved", callerPubkey: signer.pubkey } });
    if (mode === "missing") rmSync(join(root, "credits.json"));
    if (mode === "refused") {
      const { DvmError } = await import("@dvmkit/sdk/internal");
      seams.sendMessage.mockImplementation(async (_id, message) => {
        if (message.content.credit) throw new DvmError("insufficient_credit", "Insufficient credit", undefined,
          { http_status: 402, remaining_micro: 0, shortfall_micro: 900_000 });
        return { seq: 2 };
      });
    }
    await expect(handlePaymentRequest("job-metered", walletAsk, loadJob("job-metered")!.policy!, seams as unknown as Transport,
      { endpoint }, { requestSeq: 1, ...(mode === "forced-rail" ? { rail: "cashu" as const } : {}) }))
      .rejects.toMatchObject({ code: "credit_only_unavailable" });
    expect(seams.sendMessage).toHaveBeenCalledTimes(mode === "refused" ? 1 : 0);
    expect(loadJob("job-metered")?.totalPaidMsats ?? 0).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps ordinary wallet payments available for jobs without the credit-only restriction", async () => {
    seedWallet();
    saveJob({ id: "job-metered", endpoint, status: "processing", submittedAt: Date.now(), upfrontRailPayment: "free",
      policy: { ...policy, autoPayBelowMsats: 900_000 } });
    const result = await handlePaymentRequest("job-metered", walletAsk, loadJob("job-metered")!.policy!,
      seams as unknown as Transport, { endpoint }, { requestSeq: 1 });
    expect(result).toMatchObject({ status: "paid", rail: "x402", amountMsats: 900_000 });
    expect(seams.sendMessage).toHaveBeenCalledWith("job-metered", { type: "payment", content: {
      x402_payment: expect.any(String), amount_msats: 900_000,
    } }, { endpoint }, expect.anything());
    expect(loadJob("job-metered")?.totalPaidMsats).toBe(900_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("restores the restriction from the request intent after loss of the job record", async () => {
    seedCredit();
    seams.submit.mockResolvedValue({ jobId: "job-metered", status: "processing" });
    await request({ endpoint, input: "work", budget: "$1.50", autoPayBelow: "$0.90", creditOnly: "approved-credit", requestId: "request-recovered", stream: false });
    rmSync(JOBS_FILE);
    seams.requestResult.mockResolvedValue({ jobId: "job-metered", status: "processing" });
    await requestResult("request-recovered");
    expect(loadJob("job-metered")?.creditOnly).toBe("approved-credit");
  });
});
