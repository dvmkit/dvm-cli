import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { Message } from "@dvmkit/sdk/internal";

const execute = promisify(execFile);
const binary = resolve(import.meta.dirname, "../../dist/dvm.js");

it("a scheduled wait pays an open ask behind the saved cursor only without explicit --after", async () => {
  const root = mkdtempSync(join(tmpdir(), "dvm-checkin-"));
  const history: Message[] = [{ seq: 1, from: "provider", timestamp: Date.now(), type: "payment-request",
    content: { amount_msats: 100_000, fiat_amount: { amount: 0.1, currency: "usd" },
      credit: { amount_micro: 100_000, currency: "usd" }, reason: "Next observing block" } }];
  const payments: Record<string, any>[] = [];
  const failures: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, "http://provider.invalid");
      response.setHeader("content-type", "application/json");
      if (url.pathname === "/v1/info") {
        response.end(JSON.stringify({ protocol_version: 1, name: "Check-in provider", capabilities: {},
          auth: ["secp256k1-schnorr-v2"], auth_audience: { dvm_id: "checkin", builder_pubkey: "ab".repeat(32) },
          credit: { currency: "usd", funding: ["lightning"], min_micro: 1, max_micro: 5_000_000,
            ttl_ms: 86_400_000, balance_payment: true } }));
      } else if (request.method === "POST" && url.pathname === "/v1/job/watch/messages") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        payments.push(body);
        history.push({ seq: 2, from: "requester", timestamp: Date.now(), type: "payment", content: body.content });
        history.push({ seq: 3, from: "provider", timestamp: Date.now(), type: "prompt",
          content: { id: "continue", text: "Continue watching?" } });
        response.statusCode = 201;
        response.end(JSON.stringify({ seq: 2 }));
      } else if (url.pathname === "/v1/job/watch/messages") {
        const after = Number(url.searchParams.get("after") ?? 0);
        const messages = history.filter((message) => message.seq > after);
        if (request.headers.accept === "text/event-stream") {
          response.setHeader("content-type", "text/event-stream");
          response.end(messages.map((message) => `data: ${JSON.stringify(message)}\n\n`).join(""));
        } else response.end(JSON.stringify({ messages }));
      } else if (url.pathname === "/v1/job/watch") {
        response.end(JSON.stringify({ status: "awaiting-input" }));
      } else throw new Error(`Unexpected request ${request.method} ${url.pathname}`);
    } catch (error) {
      failures.push(String(error));
      response.statusCode = 500;
      response.end(JSON.stringify({ error: "fixture_failure" }));
    }
  });
  try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const env = { ...process.env, DVM_CONFIG_DIR: root, DVM_IDENTITY_KEY: "0d".repeat(32) };
    const run = (args: string[]) => execute(process.execPath, [binary, ...args], { env, timeout: 10_000 })
      .catch((error) => { throw new Error(`${error.message}\n${error.stdout}\n${error.stderr}`); });
    const pubkey = JSON.parse((await run(["init"])).stdout).identity.pubkey;
    writeFileSync(join(root, "btc-rate.json"), JSON.stringify({ rate: 100_000, timestamp: Date.now() }));
    writeFileSync(join(root, "credits.json"), JSON.stringify({ version: 1, credits: [{ endpoint, callerPubkey: pubkey,
      creditId: "watch-credit", currency: "usd", balanceMicro: 1_000_000, remainingMicro: 1_000_000,
      ledgerSeq: 1, expiryMs: Date.now() + 86_400_000, status: "active", targetMicro: 1_000_000,
      openedAt: Date.now(), updatedAt: Date.now() }] }));
    // A previous read saw the ask but did not pay it. There is no standing mandate.
    writeFileSync(join(root, "jobs.json"), JSON.stringify([{ id: "watch", endpoint, jobToken: "ab".repeat(32),
      status: "awaiting-input", submittedAt: Date.now(), messageCursor: 1, totalPaidMsats: 0, paymentsHonoured: 0,
      creditBinding: { creditId: "watch-credit", drawId: "watch-draw", callerPubkey: pubkey },
      policy: { maxTotalMsats: 1_000_000, autoPayBelowMsats: 200_000, maxIncrementMsats: 200_000, maxPayments: 5 } }]));
    const events = (stdout: string) => stdout.trim().split("\n").map((line) => JSON.parse(line));
    const skipped = events((await run(["messages", "watch", "--wait", "--until", "1s", "--after", "1"])).stdout);
    expect(skipped.at(-1)).toMatchObject({ event: "result", auto_payment_count: 0, next_action: { type: "poll" } });
    expect(payments).toHaveLength(0);
    const paid = events((await run(["messages", "watch", "--wait", "--until", "2s"])).stdout);
    expect(paid.at(-1)).toMatchObject({ event: "result", auto_payment_count: 1,
      next_action: { type: "respond", prompt_id: "continue" } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ type: "payment", content: { credit: {
      request_seq: 1, amount_micro: 100_000, currency: "usd", credit_id: "watch-credit" } } });
    expect(JSON.parse(readFileSync(join(root, "jobs.json"), "utf8"))[0]).toMatchObject({ totalPaidMsats: 100_000, paymentsHonoured: 1 });
    expect(failures).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
