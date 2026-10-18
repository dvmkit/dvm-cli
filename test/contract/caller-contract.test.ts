import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { computeResultHash, receiptPubkeyFromSecret, signReceipt } from "@dvmkit/sdk/internal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const binary = join(repositoryRoot, "dist", "dvm.js");
const configRoot = mkdtempSync(join(tmpdir(), "dvm-cli-contract-"));
const configRoots = new Set([configRoot]);
const requests: Array<{ method: string; path: string; body: unknown; jobToken?: string }> = [];
let server: Server;
let endpoint: string;
const portableToken = "ab".repeat(32);
const contractCreditId = "contract-credit";
const resumedCreditId = "resumed-credit";
const resumedFundId = "resumed-funding";
let resumedFundAttempts = 0;
const drainAttempts = new Map<string, number>();

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const jobToken = request.headers["x-job-token"];
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body: text ? JSON.parse(text) : undefined,
        ...(typeof jobToken === "string" ? { jobToken } : {}),
      });
      response.setHeader("content-type", "application/json");
      if (request.method === "GET" && request.url === "/v1/info") {
        response.end(
          JSON.stringify({
            protocol_version: 1,
            name: "Contract provider",
            description: "Repository-local mock",
            auth: ["secp256k1-schnorr-v2"],
            auth_audience: {
              dvm_id: "contract-provider",
              builder_pubkey: "00".repeat(32),
            },
            capabilities: {
              echo: {
                description: "Echo input",
                input_schema: { type: "object", properties: {} },
                pricing: { max: { amount: 0, currency: "usd" } },
              },
            },
            payment: { methods: [] },
          })
        );
        return;
      }
      if (request.method === "POST" && request.url === "/v1/job") {
        response.end(
          JSON.stringify({
            job_id: "contract-search",
            status: "completed",
            summary: JSON.stringify({ results: [] }),
          })
        );
        return;
      }
      if (request.method === "POST" && request.url === "/v1/quote") {
        response.end(
          JSON.stringify({
            upfront: { amount: 0, currency: "usd" },
            description: "No-charge contract quote",
            shape: "fixed",
          })
        );
        return;
      }
      if (request.method === "POST" && request.url === "/v1/credit") {
        const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        if (body.op === "balance") {
          const requestedCreditId =
            typeof body.credit_id === "string" ? body.credit_id : contractCreditId;
          const credit = creditWire(requestedCreditId, 750_000, 1);
          response.end(
            JSON.stringify({
              op: "balance",
              credit,
              credits: [credit],
              menu: creditMenu(),
            })
          );
          return;
        }
        if (body.op === "fund") {
          const creditId = typeof body.credit_id === "string" ? body.credit_id : "unknown-credit";
          const fund = isRecord(body.fund) ? body.fund : {};
          if (creditId === resumedCreditId && fund.fund_id === resumedFundId) {
            resumedFundAttempts += 1;
            if (resumedFundAttempts === 1) {
              response.statusCode = 503;
              response.end(
                JSON.stringify({
                  error: "provider_unavailable",
                  message: "The local funding fixture is temporarily unavailable.",
                  hint: "Retry the same funding id.",
                })
              );
              return;
            }
            response.end(
              JSON.stringify({
                op: "fund",
                replayed: true,
                funded_micro: 250_000,
                credit: creditWire(resumedCreditId, 250_000, 2),
              })
            );
            return;
          }
        }
        if (body.op === "drain") {
          const drain = isRecord(body.drain) ? body.drain : {};
          const drainId = typeof drain.drain_id === "string" ? drain.drain_id : "missing-drain";
          const attempt = (drainAttempts.get(drainId) ?? 0) + 1;
          drainAttempts.set(drainId, attempt);
          if (drainId.startsWith("exit-refusal")) {
            response.statusCode = 409;
            response.end(JSON.stringify({
              error: "tempo_channel_exit_required",
              message: "Cooperative close unavailable.",
              display: "Provider recovery advice.",
              hint: "Provider retry advice.",
              drain_registered: drainId !== "exit-refusal-unregistered",
              ...(drainId !== "exit-refusal-no-channel" ? { channel_id: "channel-exit" } : {}),
              ...(drainId !== "exit-refusal-unregistered" ? { drain_id: drainId, status: drainId === "exit-refusal-pending" ? "pending" : "exit_required" } : {}),
            }));
            return;
          }
          if (drainId.startsWith("exit-status") || drainId === "future-status") {
            response.end(JSON.stringify({
              op: "drain",
              credit: creditWire(contractCreditId, 0, 2),
              drain: {
                drain_id: drainId,
                credit_id: contractCreditId,
                method: "tempo",
                status: drainId === "future-status" ? "future_refund_state" : "exit_required",
                // Hypothetical extension: SDK 0.9.0 drain records omit channel_id.
                ...(drainId === "exit-status-hypothetical-channel" ? { channel_id: "channel-exit" } : {}),
                amount_micro: 750_000,
                currency: "usd",
                ledger_seq: 2,
                created_at: 1_700_000_000_000,
                receipts: [],
              },
            }));
            return;
          }
          response.end(
            JSON.stringify({
              op: "drain",
              credit: creditWire(contractCreditId, 0, 2),
              drain: {
                drain_id: drainId,
                credit_id: contractCreditId,
                method: "x402",
                status: attempt === 1 ? "pending" : "sent",
                amount_micro: 750_000,
                currency: "usd",
                ledger_seq: 2,
                created_at: 1_700_000_000_000,
                receipts: [],
              },
            })
          );
          return;
        }
        response.statusCode = 400;
        response.end(JSON.stringify({ error: "invalid_credit_fixture_request" }));
        return;
      }
      if (request.method === "GET" && request.url?.startsWith("/v1/job/echo-secret")) {
        response.statusCode = 401;
        response.end(
          JSON.stringify({
            error: "job_credential_invalid",
            message: `Provider rejected ${String(jobToken)}`,
            hint: `Replace ${String(jobToken)}`,
          })
        );
        return;
      }
      if (
        request.method === "GET" &&
        request.url?.startsWith("/v1/job/override-state/messages")
      ) {
        const after = new URL(request.url, "http://provider.invalid").searchParams.get("after");
        response.end(
          JSON.stringify({
            messages:
              after === "0"
                ? [
                    {
                      seq: 1,
                      from: "provider",
                      timestamp: new Date(0).toISOString(),
                      type: "payment-request",
                      content: { amount_msats: 1, reason: "Detached provider state" },
                    },
                  ]
                : [],
          })
        );
        return;
      }
      if (
        request.method === "GET" &&
        request.url?.startsWith("/v1/job/") &&
        request.url.includes("/messages")
      ) {
        response.end(JSON.stringify({ messages: [] }));
        return;
      }
      if (request.method === "GET" && request.url === "/v1/job/portable-terminal") {
        response.end(JSON.stringify({ status: "completed", summary: "portable result" }));
        return;
      }
      if (request.method === "GET" && request.url?.startsWith("/v1/job/")) {
        response.end(JSON.stringify({ status: "processing" }));
        return;
      }
      if (
        request.method === "POST" &&
        request.url?.startsWith("/v1/job/") &&
        request.url.endsWith("/messages")
      ) {
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.method === "DELETE" && request.url?.startsWith("/v1/job/")) {
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock provider did not bind TCP");
  endpoint = `http://127.0.0.1:${address.port}`;
  await runCli(["init"]);
});

afterAll(async () => {
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise()))
  );
  for (const root of configRoots) rmSync(root, { recursive: true, force: true });
});

describe("standalone caller contract", () => {
  it("rejects a doctor target with --no-network before checks or local repair", async () => {
    const root = mkdtempSync(join(tmpdir(), "dvm-cli-doctor-invalid-"));
    configRoots.add(root);
    chmodSync(root, 0o755);
    requests.length = 0;

    const jsonResult = await runCliOutcome(["doctor", endpoint, "--no-network"], {}, root);
    const output = JSON.parse(jsonResult.stdout) as { error: Record<string, unknown> };

    expect(jsonResult.code).toBe(1);
    expect(jsonResult.stderr).toBe("");
    expect(output.error).toMatchObject({
      code: "invalid_argument",
      message: expect.stringContaining("cannot be combined"),
      hint: expect.stringContaining("Remove --no-network"),
    });
    expect(requests).toEqual([]);
    if (process.platform !== "win32") expect(statSync(root).mode & 0o777).toBe(0o755);

    const humanResult = await runCliOutcome(
      ["doctor", endpoint, "--no-network", "--human"],
      {},
      root
    );

    expect(humanResult.code).toBe(1);
    expect(humanResult.stdout).toBe("");
    expect(humanResult.stderr).toContain("Error: A doctor target cannot be combined");
    expect(humanResult.stderr).toContain("Remove --no-network");
    expect(requests).toEqual([]);
    if (process.platform !== "win32") expect(statSync(root).mode & 0o777).toBe(0o755);

    const localResult = await runCliOutcome(["doctor", "--no-network"], {}, root);
    const report = JSON.parse(localResult.stdout) as {
      checks: Array<{ name: string; details?: Record<string, unknown> }>;
    };

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "config_dir_mode",
        details: expect.objectContaining({ repaired: true }),
      })
    );
    expect(requests).toEqual([]);
    if (process.platform !== "win32") expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it("reads provider metadata over the public HTTP contract", async () => {
    const result = await runCli(["describe", endpoint]);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output.endpoint).toBe(endpoint);
    expect(output.name).toEqual({ _source: "provider", text: "Contract provider" });
    expect(requests).toContainEqual({ method: "GET", path: "/v1/info", body: undefined });
  });

  // `runCliOutcome` spawns with piped stdio, so the child sees no terminal on
  // either stream — the shape a CI script or an agent harness runs the CLI in.
  // The documented promise is that stdout is then the JSON document and nothing
  // else, so a caller never needs a `tail -1` to find it.
  it("emits one bare JSON document and no prose when no terminal is attached", async () => {
    const described = await runCli(["describe", endpoint]);
    const searched = await runCli(["search", "hello", "--endpoint", endpoint]);

    for (const result of [described, searched]) {
      expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
      expect(() => JSON.parse(result.stdout) as unknown).not.toThrow();
      expect(result.stderr).toBe("");
    }
  });

  it("keeps the progress notice for a --human run", async () => {
    const described = await runCli(["describe", endpoint, "--human"]);
    const searched = await runCli(["search", "hello", "--endpoint", endpoint, "--human"]);

    expect(described.stderr).toContain("Fetching provider info");
    expect(searched.stderr).toContain("Searching for providers");
    expect(described.stdout).toBe("");
    expect(searched.stdout).toBe("");
  });

  it("resolves a capability and posts the documented quote envelope", async () => {
    requests.length = 0;
    const result = await runCli(["quote", "--endpoint", endpoint, "--input", "hello"]);
    const output = JSON.parse(result.stdout) as {
      upfront: { amount: number; currency: string };
      description: { _source: string; text: string };
    };
    expect(output.upfront).toEqual({ amount: 0, currency: "usd" });
    expect(output.description).toEqual({
      _source: "provider",
      text: "No-charge contract quote",
    });
    expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "GET", path: "/v1/info" },
      { method: "POST", path: "/v1/quote" },
    ]);
    expect(requests[1]?.body).toEqual(
      expect.objectContaining({ capability: "echo", input: "hello" })
    );
  });

  it("uses portable credentials for every stateless read and control verb", async () => {
    requests.length = 0;
    const portableArgs = ["--endpoint", endpoint, "--job-token", portableToken];

    const portableStatus = await runCli(["status", "portable-status", ...portableArgs]);
    const contentHint = JSON.parse(portableStatus.stdout).content_hint as string;
    for (const option of ["--endpoint", "--job-token", "DVM_JOB_ENDPOINT", "DVM_JOB_TOKEN"]) {
      expect(contentHint).toContain(option);
    }
    expect(portableStatus.stdout + portableStatus.stderr).not.toContain(portableToken);
    await runCli(["messages", "portable-messages", "--no-stream", ...portableArgs]);
    await runCli(["message", "portable-message", "hello", ...portableArgs]);
    await runCli(["cancel", "portable-cancel", ...portableArgs]);

    expect(requests.map(({ method, path, jobToken }) => ({ method, path, jobToken }))).toEqual([
      { method: "GET", path: "/v1/job/portable-status", jobToken: portableToken },
      {
        method: "GET",
        path: "/v1/job/portable-messages/messages?after=0",
        jobToken: portableToken,
      },
      { method: "GET", path: "/v1/job/portable-messages", jobToken: portableToken },
      {
        method: "POST",
        path: "/v1/job/portable-message/messages",
        jobToken: portableToken,
      },
      {
        method: "GET",
        path: "/v1/job/portable-message/messages?after=0",
        jobToken: portableToken,
      },
      { method: "GET", path: "/v1/job/portable-message", jobToken: portableToken },
      { method: "DELETE", path: "/v1/job/portable-cancel", jobToken: portableToken },
    ]);
    expect(existsSync(join(configRoot, "jobs.json"))).toBe(false);
  });

  it("explains how to inspect retained results when the provider is gone", async () => {
    const retainedRoot = mkdtempSync(join(tmpdir(), "dvm-cli-retained-"));
    configRoots.add(retainedRoot);
    const jobId = "retained-result";
    const artifact = { name: "report.txt", mime_type: "text/plain", data: "Report" };
    const receiptSecret = "11".repeat(32);
    const receipt = signReceipt(
      {
        v: 1,
        job_id: jobId,
        dvm_id: "dvm-report",
        dvm: "Report provider",
        capability: "report",
        outcome: "completed",
        reason: null,
        seq: 1,
        issued_at: 1_789_300_000,
        requester_pubkey: null,
        paid: {
          msats: 12_000,
          rail: "cashu",
          native_amount: null,
          native_asset: null,
          tx_hash: null,
          mint: "https://mint.example",
        },
        result_hash: computeResultHash("Report complete", [artifact]),
        receipt_pubkey: receiptPubkeyFromSecret(receiptSecret),
      },
      receiptSecret
    );
    writeFileSync(
      join(retainedRoot, "jobs.json"),
      `${JSON.stringify([{
        id: jobId,
        endpoint: "http://127.0.0.1:1",
        status: "completed",
        submittedAt: 1,
        completedAt: 2,
        completion: { summary: "Report complete", hasArtifacts: true, artifactCount: 1 },
      }])}\n`
    );
    writeFileSync(
      join(retainedRoot, "receipts.jsonl"),
      `${JSON.stringify({
        receipt,
        endpoint: "http://127.0.0.1:1",
        verification: "verified_unattested",
        verified_at: 1_789_300_000_000,
      })}\n`
    );
    mkdirSync(join(retainedRoot, "messages"));
    writeFileSync(
      join(retainedRoot, "messages", `${jobId}.jsonl`),
      [
        { seq: 1, from: "provider", type: "text", content: { text: "Report" } },
        { seq: 2, from: "provider", type: "artifact", content: artifact },
        { seq: 3, from: "provider", type: "complete", content: { summary: "Report complete" } },
      ].map((message) => JSON.stringify(message)).join("\n") + "\n"
    );

    const human = await runCliOutcome(["messages", jobId, "--no-stream", "--human"], {}, retainedRoot);
    expect(human.code).toBe(1);
    expect(human.stderr).toContain("Could not fetch messages for completed job");
    expect(human.stderr).toContain(`dvm receipts verify ${jobId}`);
    expect(human.stderr).not.toContain("internal error");

    const jsonResult = await runCliOutcome(["messages", jobId, "--no-stream"], {}, retainedRoot);
    expect(jsonResult.code).toBe(1);
    expect(JSON.parse(jsonResult.stdout)).toEqual({
      error: expect.objectContaining({
        code: "retained_messages_offline",
        hint: expect.stringContaining(`dvm receipts verify ${jobId}`),
      }),
    });

    const verified = await runCli(["receipts", "verify", jobId], {}, retainedRoot);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      job_id: jobId,
      receipt_verified: "verified_unattested",
      receipt_checks: { signature: true, result_hash: "ok" },
    });
  });

  it("lets flags override environment credentials", async () => {
    requests.length = 0;

    await runCli(
      ["status", "flag-precedence", "--endpoint", endpoint, "--job-token", portableToken],
      {
        DVM_JOB_ENDPOINT: "https://environment.invalid",
        DVM_JOB_TOKEN: "cd".repeat(32),
      }
    );

    expect(requests).toContainEqual({
      method: "GET",
      path: "/v1/job/flag-precedence",
      body: undefined,
      jobToken: portableToken,
    });
  });

  it("preserves terminal status fields without creating a local job", async () => {
    const result = await runCli([
      "status",
      "portable-terminal",
      "--endpoint",
      endpoint,
      "--job-token",
      portableToken,
    ]);

    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        jobId: "portable-terminal",
        status: "completed",
        summary: "portable result",
        source: "provider",
        receipt_verified: "absent",
      })
    );
    expect(existsSync(join(configRoot, "jobs.json"))).toBe(false);
  });

  it("lets environment credentials override stored credentials without changing the saved job", async () => {
    const jobsFile = join(configRoot, "jobs.json");
    const savedJobs = [
      {
        id: "environment-access",
        endpoint: `${endpoint}/stored-provider`,
        status: "processing",
        submittedAt: 1,
        jobToken: "ef".repeat(32),
      },
    ];
    const savedBytes = `${JSON.stringify(savedJobs, null, 2)}\n`;
    writeFileSync(jobsFile, savedBytes);
    requests.length = 0;

    await runCli(["status", "environment-access"], {
      DVM_JOB_ENDPOINT: endpoint,
      DVM_JOB_TOKEN: portableToken,
    });

    expect(requests).toEqual([
      {
        method: "GET",
        path: "/v1/job/environment-access",
        body: undefined,
        jobToken: portableToken,
      },
    ]);
    expect(readFileSync(jobsFile, "utf8")).toBe(savedBytes);
  });

  it("uses stored credentials by default without persisting explicit replacements", async () => {
    const jobsFile = join(configRoot, "jobs.json");
    const staleToken = "ef".repeat(32);
    const initialJobs = [
      {
        id: "stored-access",
        endpoint,
        status: "processing",
        submittedAt: 1,
        jobToken: portableToken,
      },
      {
        id: "cached-terminal",
        endpoint: "https://stale.invalid",
        status: "completed",
        submittedAt: 1,
        completedAt: 2,
        completion: { summary: "stale" },
        jobToken: staleToken,
      },
    ];
    writeFileSync(
      jobsFile,
      `${JSON.stringify(initialJobs, null, 2)}\n`
    );
    requests.length = 0;

    await runCli(["status", "stored-access"]);
    await runCli([
      "status",
      "cached-terminal",
      "--endpoint",
      endpoint,
      "--job-token",
      portableToken,
    ]);

    expect(requests.map(({ path, jobToken }) => ({ path, jobToken }))).toEqual([
      { path: "/v1/job/stored-access", jobToken: portableToken },
      { path: "/v1/job/cached-terminal", jobToken: portableToken },
    ]);
    const jobs = JSON.parse(readFileSync(jobsFile, "utf8")) as typeof initialJobs;
    expect(jobs).toEqual(initialJobs);
  });

  it("keeps endpoint-overridden status, cursor, completion, and messages detached", async () => {
    const jobsFile = join(configRoot, "jobs.json");
    const storedJobs = JSON.parse(readFileSync(jobsFile, "utf8")) as Array<
      Record<string, unknown>
    >;
    const detachedJob = {
      id: "override-state",
      endpoint: "https://original.invalid",
      status: "awaiting-input",
      submittedAt: 3,
      messageCursor: 41,
      completion: { summary: "original completion" },
      jobToken: "12".repeat(32),
      policy: {
        maxTotalMsats: 1000,
        autoPayBelowMsats: 1000,
        maxIncrementMsats: 1000,
        maxPayments: 1,
      },
    };
    const initialJobs = [...storedJobs, detachedJob];
    writeFileSync(jobsFile, `${JSON.stringify(initialJobs, null, 2)}\n`);
    const portableArgs = ["--endpoint", endpoint, "--job-token", portableToken];

    await runCli(["status", "override-state", "--messages", ...portableArgs]);
    await runCli(["messages", "override-state", "--no-stream", ...portableArgs]);
    await runCli(["message", "override-state", "hello", ...portableArgs]);
    await runCli(["cancel", "override-state", ...portableArgs]);

    expect(JSON.parse(readFileSync(jobsFile, "utf8"))).toEqual(initialJobs);
    expect(existsSync(join(configRoot, "messages", "override-state.jsonl"))).toBe(false);
    const detachedReads = requests.filter(({ path }) => path.includes("override-state/messages"));
    expect(detachedReads.every(({ path }) => path.endsWith("after=0") || !path.includes("?"))).toBe(
      true
    );
  });

  it("fails pay closed without local policy and pending-request state", async () => {
    const result = await runCliOutcome([
      "pay",
      "portable-pay",
      "--endpoint",
      endpoint,
      "--job-token",
      portableToken,
    ]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      error: expect.objectContaining({ code: "job_payment_state_required" }),
    });
    expect(result.stdout + result.stderr).not.toContain(portableToken);
  });

  it("redacts a provider response that echoes the job token", async () => {
    const result = await runCliOutcome([
      "status",
      "echo-secret",
      "--endpoint",
      endpoint,
      "--job-token",
      portableToken,
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(portableToken);
    expect(result.stdout).toContain("[REDACTED]");
  });

  describe("credit command boundary", () => {
    it("reconciles a live balance into isolated caller state without changing config", async () => {
      const caller = await initializedCaller();
      const expectedConfig = pinCallerConfig(caller.root);

      const result = await runCli(["credit", "balance", endpoint], {}, caller.root);
      const output = JSON.parse(result.stdout) as {
        credits: Array<Record<string, unknown>>;
        count: number;
      };

      expect(result.stderr).toBe("");
      expect(output.count).toBe(1);
      expect(output.credits[0]).toMatchObject({
        credit_id: contractCreditId,
        remaining_micro: 750_000,
        ledger_seq: 1,
        tracked: true,
        drawable: true,
      });
      const store = readJson(join(caller.root, "credits.json")) as CreditStoreFixture;
      expect(store.credits).toEqual([
        expect.objectContaining({
          callerPubkey: caller.pubkey,
          creditId: contractCreditId,
          remainingMicro: 750_000,
          ledgerSeq: 1,
          status: "active",
        }),
      ]);
      expect(readJson(join(caller.root, "config.json"))).toEqual(expectedConfig);
    });

    it("rejects contradictory funding arguments before network or state mutation", async () => {
      const caller = await initializedCaller();
      const expectedConfig = pinCallerConfig(caller.root);
      requests.length = 0;

      const result = await runCliOutcome(
        ["credit", "fund", endpoint, "--amount", "$0.25", "--target-jobs", "5"],
        {},
        caller.root
      );
      const output = JSON.parse(result.stdout) as { error: Record<string, unknown> };

      expect(result.code).toBe(1);
      expect(result.stderr).toBe("");
      expect(output.error).toMatchObject({
        code: "invalid_argument",
        message: expect.stringContaining("either --amount or --target-jobs"),
        hint: expect.stringContaining("Pick the one"),
      });
      expect(requests).toEqual([]);
      expect(existsSync(join(caller.root, "credits.json"))).toBe(false);
      expect(readJson(join(caller.root, "config.json"))).toEqual(expectedConfig);
    });

    it("reports an unavailable forced rail without claiming or recording a funding", async () => {
      const caller = await initializedCaller();
      const expectedConfig = pinCallerConfig(caller.root);
      requests.length = 0;

      const result = await runCliOutcome(
        [
          "credit",
          "fund",
          endpoint,
          "--amount",
          "$0.10",
          "--rail",
          "lightning",
          "--over-trust",
        ],
        {},
        caller.root
      );
      const output = JSON.parse(result.stdout) as { error: Record<string, unknown> };

      expect(result.code).toBe(1);
      expect(result.stderr).toBe("");
      expect(output.error).toMatchObject({
        code: "credit_funding_unavailable",
        display: expect.stringContaining("No way to fund"),
        hint: expect.any(String),
      });
      expect(String(output.error.display)).not.toContain("Funded $");
      expect(creditRequestBodies().filter((body) => body.op === "fund")).toEqual([]);
      expect(existsSync(join(caller.root, "credits.json"))).toBe(false);
      expect(readJson(join(caller.root, "config.json"))).toEqual(expectedConfig);
    });

    it("keeps an interrupted funding durable and resumes the same paid intent", async () => {
      const caller = await initializedCaller();
      const expectedConfig = pinCallerConfig(caller.root);
      seedPendingFunding(caller.root, caller.pubkey);
      resumedFundAttempts = 0;
      requests.length = 0;

      const interrupted = await runCliOutcome(
        ["credit", "fund", endpoint],
        {},
        caller.root
      );
      const interruptedOutput = JSON.parse(interrupted.stdout) as {
        error: Record<string, unknown>;
      };

      expect(interrupted.code).toBe(1);
      expect(interrupted.stderr).toBe("");
      expect(interruptedOutput.error).toMatchObject({
        code: "provider_unavailable",
        credit_id: resumedCreditId,
        fund_id: resumedFundId,
        rail: "lightning",
        hint: expect.any(String),
      });
      expect(String(interruptedOutput.error.display)).not.toContain("Funded $");
      expect(pendingFundings(caller.root)).toEqual([
        expect.objectContaining({ creditId: resumedCreditId, fundId: resumedFundId }),
      ]);

      const resumed = await runCli(["credit", "fund", endpoint], {}, caller.root);
      const resumedOutput = JSON.parse(resumed.stdout) as Record<string, unknown>;

      expect(resumed.stderr).toBe("");
      expect(resumedOutput).toMatchObject({
        op: "fund",
        status: "funded",
        credit_id: resumedCreditId,
        fund_id: resumedFundId,
        rail: "lightning",
        funded_micro: 250_000,
        spent_sats: 5,
      });
      const fundBodies = creditRequestBodies().filter((body) => body.op === "fund");
      expect(fundBodies).toHaveLength(2);
      expect(fundBodies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            credit_id: resumedCreditId,
            fund: expect.objectContaining({ fund_id: resumedFundId, amount_micro: 250_000 }),
          }),
        ])
      );
      expect(pendingFundings(caller.root)).toEqual([]);
      const store = readJson(join(caller.root, "credits.json")) as CreditStoreFixture;
      expect(store.credits).toEqual([
        expect.objectContaining({
          creditId: resumedCreditId,
          remainingMicro: 250_000,
          rail: "lightning",
        }),
      ]);
      expect(readJson(join(caller.root, "config.json"))).toEqual(expectedConfig);
    });

    it.each([
      ["exit-refusal-registered", true, false],
      ["exit-refusal-unregistered", true, false],
      ["exit-refusal-no-channel", false, false],
      ["exit-refusal-local", true, true],
      ["exit-status-hypothetical-channel", true, false],
      ["exit-status-no-channel", false, false],
    ] as const)("stops cooperative recovery and names the timed exit for %s", async (drainId, hasChannel, localChannel) => {
      const caller = await initializedCaller();
      await runCli(["credit", "balance", endpoint], {}, caller.root);
      if (localChannel) seedTempoAssociation(caller.root, caller.pubkey);

      const result = await runCliOutcome([
        "credit", "drain", endpoint,
        "--credit-id", contractCreditId,
        "--drain-id", drainId,
        "--method", "tempo",
        ...(!localChannel ? ["--address", `0x${"12".repeat(20)}`] : []),
        "--as", caller.identityName,
      ], {}, caller.root);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      const outcome = (output.error ?? output) as Record<string, unknown>;
      const command = `dvm wallet tempo-exit ${endpoint} --credit-id ${contractCreditId} --as ${caller.identityName}`;

      expect(result.code).toBe(drainId.startsWith("exit-refusal") ? 1 : 0);
      expect(outcome.display).toEqual(expect.stringContaining("service cannot return this money directly"));
      expect(outcome.display).toEqual(expect.stringContaining("timed exit"));
      expect(outcome.display).not.toEqual(expect.stringContaining("channel-exit"));
      expect(outcome.hint).toEqual(expect.stringContaining("timed exit"));
      expect(outcome.hint).toEqual(expect.stringContaining("after its delay"));
      expect(outcome.hint).toEqual(expect.stringContaining(command));
      expect(outcome.hint).toEqual(expect.stringContaining("do not poll"));
      expect(outcome.hint).not.toEqual(expect.stringContaining("Re-run this command"));
      if (hasChannel) expect(outcome.hint).toEqual(expect.stringContaining("channel-exit"));
      if (localChannel) {
        expect(outcome.hint).toEqual(expect.stringContaining("Keep the channel recovery record"));
        const channels = readJson(join(caller.root, "tempo-channels.json")) as { associations: unknown[] };
        expect(channels.associations).toEqual([expect.objectContaining({ creditId: contractCreditId })]);
      } else {
        expect(outcome.hint).toEqual(expect.stringContaining("wallet and machine that opened the channel"));
        expect(outcome.hint).not.toEqual(expect.stringContaining("Keep the channel recovery record"));
      }
      const credit = readCredit(caller.root);
      expect(credit.status).toBe("active");
      if (drainId === "exit-refusal-unregistered") {
        expect(credit.pendingDrains).toBeUndefined();
      } else {
        expect(credit.pendingDrains).toEqual([
          expect.objectContaining({ drainId, creditId: contractCreditId }),
        ]);
      }
    });

    it("keeps server and CLI text separate when an unregistered refusal retires the local marker", async () => {
      const caller = await initializedCaller();
      await runCli(["credit", "balance", endpoint], {}, caller.root);
      const result = await runCliOutcome([
        "credit", "drain", endpoint, "--credit-id", contractCreditId,
        "--drain-id", "exit-refusal-unregistered", "--method", "tempo",
        "--address", `0x${"12".repeat(20)}`,
      ], {}, caller.root);
      const { error } = JSON.parse(result.stdout) as { error: Record<string, unknown> };

      expect(result.code).toBe(1);
      expect(error.provider_display).toEqual({ _source: "provider", text: "Provider recovery advice." });
      expect(error.display).toEqual(expect.stringContaining("The DVM confirmed drain exit-refusal-unregistered was never registered, so its stale local record was retired. No refund was created or paid."));
      expect(error.local_drain_retired).toBe(true);
      expect(readCredit(caller.root).pendingDrains).toBeUndefined();
    });

    it("requires the same environment signer on the machine that opened the channel", async () => {
      const caller = await initializedCaller();
      const key = "11".repeat(32);
      const env = { DVM_IDENTITY_KEY: key };
      await runCli(["credit", "balance", endpoint], env, caller.root);
      const result = await runCliOutcome([
        "credit", "drain", endpoint, "--credit-id", contractCreditId,
        "--drain-id", "exit-refusal-registered", "--method", "tempo",
        "--address", `0x${"12".repeat(20)}`,
      ], env, caller.root);
      const { error } = JSON.parse(result.stdout) as { error: Record<string, unknown> };

      expect(result.code).toBe(1);
      expect(error.hint).toEqual(expect.stringContaining("same DVM_IDENTITY_KEY"));
      expect(error.hint).toEqual(expect.stringContaining("wallet and machine that opened the channel"));
      expect(error.hint).not.toEqual(expect.stringContaining("--as"));
      expect(error.hint).not.toEqual(expect.stringContaining("Keep the channel recovery record"));
      expect(result.stdout + result.stderr).not.toContain(key);
    });

    it("preserves a pending close refusal and allows a valid credential retry before timed exit", async () => {
      const caller = await initializedCaller();
      await runCli(["credit", "balance", endpoint], {}, caller.root);
      const result = await runCliOutcome([
        "credit", "drain", endpoint, "--credit-id", contractCreditId,
        "--drain-id", "exit-refusal-pending", "--method", "tempo",
        "--address", `0x${"12".repeat(20)}`,
      ], {}, caller.root);
      const { error } = JSON.parse(result.stdout) as { error: Record<string, unknown> };

      expect(result.code).toBe(1);
      expect(error.status).toBe("pending");
      expect(error.retryable).toBe(true);
      expect(error.hint).toEqual(expect.stringContaining("same drain with a valid close credential"));
      expect(error.hint).toEqual(expect.stringContaining("timed exit is the fallback"));
      expect(error.hint).not.toEqual(expect.stringContaining("do not poll this drain again"));
      expect(readCredit(caller.root).pendingDrains).toEqual([
        expect.objectContaining({ drainId: "exit-refusal-pending", creditId: contractCreditId }),
      ]);
    });

    it("rejects an unknown drain status with upgrade guidance and preserves recovery", async () => {
      const caller = await initializedCaller();
      await runCli(["credit", "balance", endpoint], {}, caller.root);
      requests.length = 0;

      const result = await runCliOutcome([
        "credit", "drain", endpoint, "--credit-id", contractCreditId, "--drain-id", "future-status",
        "--method", "tempo", "--address", `0x${"12".repeat(20)}`,
      ], {}, caller.root);
      const output = JSON.parse(result.stdout) as { error: Record<string, unknown> };

      expect(result.code).toBe(1);
      expect(output.error).toMatchObject({
        code: "unknown_drain_status",
        status: "future_refund_state",
        display: expect.stringContaining("future_refund_state"),
        hint: expect.stringContaining("Upgrade dvm"),
      });
      expect(output.error.hint).toEqual(expect.stringContaining("do not poll"));
      expect(readCredit(caller.root)).toMatchObject({
        status: "active",
        pendingDrains: [expect.objectContaining({ drainId: "future-status" })],
      });
    });

    it("reuses a recoverable drain until the fixture confirms the refund was sent", async () => {
      const caller = await initializedCaller();
      const expectedConfig = pinCallerConfig(caller.root);
      await runCli(["credit", "balance", endpoint], {}, caller.root);
      drainAttempts.clear();
      requests.length = 0;
      const address = `0x${"12".repeat(20)}`;
      const args = [
        "credit",
        "drain",
        endpoint,
        "--method",
        "x402",
        "--address",
        address,
      ];

      const pending = await runCli(args, {}, caller.root);
      const pendingOutput = JSON.parse(pending.stdout) as {
        drain: Record<string, unknown>;
        display: string;
        hint: string;
      };
      const drainId = String(pendingOutput.drain.drain_id);

      expect(pending.stderr).toBe("");
      expect(pendingOutput.drain).toMatchObject({
        credit_id: contractCreditId,
        method: "x402",
        status: "pending",
        amount_micro: 750_000,
      });
      expect(pendingOutput.hint).toContain("Re-run");
      expect(readCredit(caller.root)).toMatchObject({
        creditId: contractCreditId,
        remainingMicro: 0,
        pendingDrains: [expect.objectContaining({ drainId, creditId: contractCreditId })],
      });

      const sent = await runCli(args, {}, caller.root);
      const sentOutput = JSON.parse(sent.stdout) as {
        drain: Record<string, unknown>;
        display: string;
      };

      expect(sent.stderr).toBe("");
      expect(sentOutput.drain).toMatchObject({
        drain_id: drainId,
        credit_id: contractCreditId,
        status: "sent",
        amount_micro: 750_000,
      });
      const drainBodies = creditRequestBodies().filter((body) => body.op === "drain");
      expect(drainBodies).toHaveLength(2);
      expect(
        drainBodies.map((body) => (isRecord(body.drain) ? body.drain.drain_id : undefined))
      ).toEqual([drainId, drainId]);
      const retiredCredit = readCredit(caller.root);
      expect(retiredCredit).toMatchObject({
        creditId: contractCreditId,
        status: "drained",
        remainingMicro: 0,
      });
      expect(retiredCredit.pendingDrains).toBeUndefined();
      expect(readJson(join(caller.root, "config.json"))).toEqual(expectedConfig);
    });
  });
});

function runCli(
  args: string[],
  env: Record<string, string> = {},
  callerConfigRoot = configRoot
): Promise<{ stdout: string; stderr: string }> {
  return runCliOutcome(args, env, callerConfigRoot).then((result) => {
    if (result.code === 0) return result;
    throw new Error(`dvm exited ${result.code}: ${result.stderr || result.stdout}`);
  });
}

function runCliOutcome(
  args: string[],
  env: Record<string, string> = {},
  callerConfigRoot = configRoot
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [binary, ...args], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        DVM_CONFIG_DIR: callerConfigRoot,
        LANG: "C",
        LC_ALL: "C",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ stdout, stderr, code }));
  });
}

interface CreditStoreFixture {
  credits: Array<Record<string, unknown>>;
  implicitCredits: Array<Record<string, unknown>>;
  pendingFundings: Array<Record<string, unknown>>;
  fundingMenuSnapshots: Array<Record<string, unknown>>;
}

function creditWire(creditId: string, remainingMicro: number, ledgerSeq: number) {
  return {
    credit_id: creditId,
    currency: "usd",
    balance_micro: remainingMicro,
    remaining_micro: remainingMicro,
    expiry_ms: 4_102_444_800_000,
    expired: false,
    drainable: remainingMicro > 0,
    ledger_seq: ledgerSeq,
  };
}

function creditMenu() {
  return {
    funding: ["lightning"],
    min_micro: 100_000,
    max_micro: 5_000_000,
    lightning_min_micro: 100_000,
    currency: "usd",
    ttl_ms: 86_400_000,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function initializedCaller(): Promise<{ root: string; pubkey: string; identityName: string }> {
  const root = mkdtempSync(join(tmpdir(), "dvm-cli-credit-contract-"));
  configRoots.add(root);
  const initialized = await runCli(["init"], {}, root);
  const output = JSON.parse(initialized.stdout) as { identity?: { pubkey?: unknown; name?: unknown } };
  const pubkey = output.identity?.pubkey;
  if (typeof pubkey !== "string") throw new Error("init did not provision a signing identity");
  const identityName = output.identity?.name;
  if (typeof identityName !== "string") throw new Error("init did not name its signing identity");
  return { root, pubkey, identityName };
}

function pinCallerConfig(root: string): Record<string, unknown> {
  const current = readJson(join(root, "config.json")) as Record<string, unknown>;
  const expected = {
    ...current,
    defaultBudget: "$3",
    defaultMaxPayments: 4,
    credit: { posture: "suggest", targetJobs: 12 },
    feedback: { posture: "off" },
  };
  writeFileSync(join(root, "config.json"), `${JSON.stringify(expected, null, 2)}\n`, { mode: 0o600 });
  return expected;
}

function seedPendingFunding(root: string, callerPubkey: string): void {
  const store: CreditStoreFixture = {
    credits: [],
    implicitCredits: [],
    pendingFundings: [
      {
        endpoint,
        callerPubkey,
        creditId: resumedCreditId,
        fundId: resumedFundId,
        amountMicro: 250_000,
        rail: "lightning",
        targetMicro: 250_000,
        requestedAt: Date.now(),
        principalMsats: 5_000,
        routingFeeMsats: 0,
        totalWalletFeeMsats: 0,
        unitemizedWalletFeeMsats: 0,
        walletDebitMsats: 5_000,
        paymentOutcome: "paid",
      },
    ],
    fundingMenuSnapshots: [],
  };
  writeFileSync(join(root, "credits.json"), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function seedTempoAssociation(root: string, callerPubkey: string): void {
  const config = readJson(join(root, "config.json")) as Record<string, unknown>;
  writeFileSync(join(root, "config.json"), JSON.stringify({
    ...config,
    tempo: { method: "tempo", apiKey: `0x${"22".repeat(32)}`, network: "moderato" },
  }), { mode: 0o600 });
  writeFileSync(join(root, "tempo-channels.json"), JSON.stringify({
    version: 2,
    values: {},
    charges: [],
    associations: [{
      endpoint,
      callerPubkey,
      creditId: contractCreditId,
      channelKey: "example-scope",
      operator: `0x${"33".repeat(20)}`,
      channelId: `0x${"44".repeat(32)}`,
      cumulativeAmount: "250000",
      deposit: "1000000",
      chainId: 42431,
      opened: true,
      updatedAt: 1_700_000_000_000,
    }],
  }), { mode: 0o600 });
}

function pendingFundings(root: string): Array<Record<string, unknown>> {
  return (readJson(join(root, "credits.json")) as CreditStoreFixture).pendingFundings;
}

function readCredit(root: string): Record<string, unknown> {
  const store = readJson(join(root, "credits.json")) as CreditStoreFixture;
  const credit = store.credits[0];
  if (!credit) throw new Error("credit fixture was not persisted");
  return credit;
}

function creditRequestBodies(): Array<Record<string, unknown>> {
  return requests
    .filter(({ method, path }) => method === "POST" && path === "/v1/credit")
    .map(({ body }) => body)
    .filter(isRecord);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
