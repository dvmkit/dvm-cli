import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createSignedRequestVerifier, type PaymentContent } from "@dvmkit/sdk";
import { computeResultHash, decodePayment, shellQuoteArg, type Message } from "@dvmkit/sdk/internal";
import { expect, it } from "vitest";
import { attestedDvm } from "../../src/lib/__tests__/fixtures/receipt-fixture";

const binary = resolve(import.meta.dirname, "../../dist/dvm.js");

it("drives a conversational metered job across CLI processes, from quote to verified artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "dvm-conversation-"));
  const jobId = "conversation";
  const token = "ab".repeat(32);
  const dvm = attestedDvm("conversation");
  const audience = { dvm_id: "dvm-conversation", builder_pubkey: dvm.identity.pubkey };
  const verifier = createSignedRequestVerifier({ _zod: {}, parse: (data: unknown) => data,
    safeParse: (data: unknown) => ({ success: true as const, data }) }, { replayStore: null });
  const log: Message[] = [];
  const payments: NonNullable<PaymentContent["credit"]>[] = [];
  const x402Payments: string[] = [];
  const payee = `0x${"f".repeat(40)}`;
  let paymentCount = 0;
  const answers: unknown[] = [];
  const failures: string[] = [];
  const reads: number[] = [];
  const artifact = { name: "report.txt", mime_type: "text/plain", url: "",
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", size_bytes: 3 };
  const promptExpiresAtMs = Date.now() + 2 * 3_600_000;
  const promptDeadline = new Date(promptExpiresAtMs).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const promptDeadlineClause = new RegExp(`Answer by ${promptDeadline} \\(in (?:1 h(?: \\d+ min)?|2 h)\\), or the provider cancels the job\\.`);
  const choices = ["keep  cadence — Δ", "wait", "switch"];
  let status = "processing";
  let streamCount = 0;
  let callerPubkey: string;
  let receipt: ReturnType<typeof dvm.sign> | undefined;
  let submission: Record<string, unknown> | undefined;
  let quoteInput: unknown;

  function append(type: string, content: unknown, from: Message["from"] = "provider") {
    log.push({ seq: log.length + 1, from, timestamp: 1_767_225_600_000, type, content } as Message);
  }
  function charge(amount: number, reason: string, rail: "credit" | "x402" = "credit") {
    append("payment-request", { amount_msats: amount, fiat_amount: { amount: amount / 1_000_000, currency: "usd" },
      ...(rail === "credit" ? { credit: { amount_micro: amount, currency: "usd" } }
        : { x402: { pay_to: payee, network: "eip155:8453", required_usdc_micro: String(amount) } }), reason });
    status = "awaiting-input";
  }
  const menu = { funding: ["lightning"], min_micro: 100_000, max_micro: 5_000_000,
    lightning_min_micro: 100_000, currency: "usd", ttl_ms: 86_400_000, balance_payment: true };
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text ? JSON.parse(text) : undefined;
      const url = new URL(request.url!, "http://provider.invalid");
      response.setHeader("content-type", "application/json");
      if (url.pathname === "/report.txt") {
        response.setHeader("content-type", "text/plain");
        response.end("abc");
      } else if (url.pathname === "/v1/info") {
        response.end(JSON.stringify({ protocol_version: 1, name: "Conversation provider",
          auth: ["secp256k1-schnorr-v2"], auth_audience: audience,
          capabilities: { count: { description: "Observe and report", input_schema: { type: "object", properties: {} },
            pricing: { max: { amount: 3, currency: "usd" } } } },
          payment: { methods: [] }, credit: menu, receipts: true, builder: dvm.anchor }));
      } else if (request.method === "POST" && url.pathname === "/v1/quote") {
        quoteInput = body;
        response.end(JSON.stringify({ upfront: { amount: 0, currency: "usd" }, shape: "rate",
          description: "Metered observation; approve further work as it arrives." }));
      } else if (request.method === "POST" && url.pathname === "/v1/job") {
        submission = body;
        response.statusCode = 202;
        response.end(JSON.stringify({ job_id: jobId, job_token: token, status }));
      } else if (request.method === "POST" && url.pathname === "/v1/credit") {
        if (body.op !== "balance") throw new Error(`Unexpected credit operation ${body.op}`);
        const credit = { credit_id: "conversation-credit", currency: "usd", balance_micro: 5_000_000,
          remaining_micro: 5_000_000, expiry_ms: 4_102_444_800_000, expired: false, drainable: true, ledger_seq: 1 };
        response.end(JSON.stringify({ op: "balance", credit, credits: [credit], menu }));
      } else if (url.pathname.startsWith(`/v1/job/${jobId}`)) {
        if (request.headers["x-job-token"] !== token) throw new Error("Missing saved job credential");
        if (request.method === "POST" && url.pathname.endsWith("/messages")) {
          if (body.type === "payment") {
            if (body.content.credit) {
              const credit = body.content.credit as NonNullable<PaymentContent["credit"]>;
              verifier.checkAuth(credit, { audience, method: "POST", path: `/v1/job/${jobId}/messages`, capability: null });
              payments.push(credit);
            } else {
              expect(decodePayment(body.content.x402_payment)).toMatchObject({
                x402Version: 1, scheme: "exact", network: "base",
                payload: { authorization: { to: payee, value: "100000" }, signature: expect.stringMatching(/^0x[0-9a-f]{130}$/i) },
              });
              expect(body.content.amount_msats).toBe(100_000);
              x402Payments.push(body.content.x402_payment);
            }
            paymentCount++;
            append("payment", body.content, "requester");
            if (paymentCount === 1) charge(200_000, "Second observing block");
            else if (paymentCount === 2) charge(300_000, "Third observing block");
            else if (paymentCount === 3) charge(100_000, "Per-charge observing block", "x402");
            else if (paymentCount === 4) charge(100_000, "Fifth observing block");
            else if (paymentCount === 5) charge(100_000, "Sixth observing block");
            else if (paymentCount === 6) {
              append("prompt", { id: "cadence", text: "Cloud moving in. Which cadence?", options: choices, expires_at_ms: promptExpiresAtMs });
            } else if (paymentCount === 7) {
              append("artifact", artifact);
              append("complete", { status: "success", summary: "Observation complete" });
              status = "completed";
              receipt = dvm.sign({ job_id: jobId, capability: "count", requester_pubkey: callerPubkey,
                paid: { msats: 1_400_000, rail: null, native_amount: null, native_asset: null, tx_hash: null, mint: null },
                result_hash: computeResultHash("Observation complete", [artifact]) });
            } else throw new Error("Unexpected extra payment");
          } else if (body.type === "response") {
            answers.push(body.content);
            append("response", body.content, "requester");
            append("working", { hint: "Applying the selected cadence" });
            status = "processing";
          } else throw new Error(`Unexpected message ${body.type}`);
          response.statusCode = 201;
          response.end(JSON.stringify({ seq: log.findLast((message) => message.from === "requester")!.seq }));
        } else if (url.pathname.endsWith("/messages")) {
          const after = Number(url.searchParams.get("after") ?? 0);
          if (request.headers.accept === "text/event-stream") {
            reads.push(after);
            response.setHeader("content-type", "text/event-stream");
            streamCount++;
            // A socket failure mid-event and a separate working turn must both be retried.
            if (streamCount === 1) {
              response.flushHeaders();
              response.write('data: {"seq":', () => response.destroy());
              return;
            }
            if (streamCount === 2) append("working", { hint: "Watching the sky" });
            if (streamCount === 3) charge(100_000, "First observing block");
            for (const message of log.filter((message) => message.seq > after))
              response.write(`data: ${JSON.stringify(message)}\n\n`);
            response.end();
          } else response.end(JSON.stringify({ messages: log.filter((message) => message.seq > after) }));
        } else response.end(JSON.stringify({ status, receipt, summary: "Observation complete",
          has_artifacts: status === "completed", artifact_count: status === "completed" ? 1 : 0,
          payload_in: "messages", content_available: true, content_expires_at: null }));
      } else throw new Error(`Unexpected request ${request.method} ${url.pathname}`);
    } catch (error) {
      failures.push(String(error));
      response.statusCode = 500;
      response.end(JSON.stringify({ error: "fixture_failure", message: String(error) }));
    }
  });

  try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    artifact.url = `${endpoint}/report.txt`;
    const initialized = JSON.parse((await run(["init"])).stdout);
    expect(initialized.identity.pubkey).toMatch(/^[0-9a-f]{64}$/);
    callerPubkey = initialized.identity.pubkey;
    const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
    writeFileSync(join(root, "config.json"), JSON.stringify({ ...config, feedback: { posture: "off" },
      x402: { privateKey: `0x${"11".repeat(32)}`, network: "eip155:8453" } }));

    await run(["budget", "set", "--daily", "0.10"]);

    const quote = JSON.parse((await run(["quote", "--endpoint", endpoint, "--input", "observe"])).stdout);
    expect(quote).toMatchObject({ upfront: { amount: 0, currency: "usd" }, shape: "rate",
      description: { _source: "provider", text: "Metered observation; approve further work as it arrives." } });
    expect(quoteInput).toMatchObject({ capability: "count", input: "observe" });

    const submitted = JSON.parse((await run(["request", "--endpoint", endpoint, "--input", "observe",
      "--budget", "3000000", "--auto-pay-below", "400000", "--max-increment", "2000000",
      "--max-payments", "8", "--no-stream"])).stdout);
    expect(submitted).toMatchObject({ jobId, next_action: { type: "poll", job_id: jobId } });
    expect(submission).toMatchObject({ capability: "count" });
    // Reconcile an existing balance after submit, so the first conversation charge selects it.
    const balance = JSON.parse((await run(["credit", "balance", endpoint])).stdout);
    expect(balance).toMatchObject({ credits: [{ credit_id: "conversation-credit", remaining_micro: 5_000_000, drawable: true }] });

    const question = JSON.parse((await run(["messages", jobId, "--wait", "--until", "60s"])).stdout);
    expect(question).toMatchObject({ jobId, next_action: { type: "respond", job_id: jobId, prompt_id: "cadence",
      prompt: { _source: "provider", text: "Cloud moving in. Which cadence?" }, options: choices } });
    expect(question.next_action.expires_at_ms).toBe(promptExpiresAtMs);
    expect(question.next_action.display).toMatch(promptDeadlineClause);
    expect(question.messages.map((message: Message) => [message.seq, message.type])).toEqual([
      [1, "working"], [2, "payment-request"], [3, "payment"], [4, "payment-request"],
      [5, "payment"], [6, "payment-request"], [7, "payment"], [8, "payment-request"],
      [9, "payment"], [10, "payment-request"], [11, "payment"], [12, "payment-request"],
      [13, "payment"], [14, "prompt"],
    ]);
    expect(question.auto_payments.map((payment: { amount_msats: number; rail: string }) => [payment.amount_msats, payment.rail]))
      .toEqual([[100_000, "credit"], [200_000, "credit"], [300_000, "credit"],
        [100_000, "x402"], [100_000, "credit"], [100_000, "credit"]]);
    expect(reads.slice(0, 3)).toEqual([0, 0, 1]);
    expect(payments.map((payment) => [payment.request_seq, payment.amount_micro, payment.currency]))
      .toEqual([[2, 100_000, "usd"], [4, 200_000, "usd"], [6, 300_000, "usd"],
        [10, 100_000, "usd"], [12, 100_000, "usd"]]);
    expect(new Set(payments.map((payment) => payment.payment_id)).size).toBe(5);
    expect(x402Payments).toHaveLength(1);
    const globalBudget = JSON.parse((await run(["budget", "status"])).stdout);
    expect(globalBudget.windows).toEqual(["daily", "weekly", "monthly"].map((window) => expect.objectContaining({
      window, spentUsd: 0.1, spent_breakdown: { jobs_usd: 0.1, float_fundings_usd: 0, credit_fundings_usd: 0 },
    })));

    const answerTemplate = /`([^`]+)`/.exec(question.next_action.hint)?.[1];
    expect(answerTemplate).toBe(`dvm message conversation "<answer>" --type response --prompt-id '<prompt_id>'`);
    const answerCommand = answerTemplate!.replace("--prompt-id '<prompt_id>'", () => `--prompt-id ${shellQuoteArg(question.next_action.prompt_id)}`);
    const humanQuestion = await run(["status", jobId, "--human"]);
    expect(humanQuestion.stdout).toBe("");
    const questionNext = humanQuestion.stderr.split("\n").find((line) => line.startsWith("Next:"));
    expect(questionNext).toContain('The provider asks: Cloud moving in. Which cadence? Choices: "keep  cadence — Δ", "wait", "switch".');
    expect(questionNext).toMatch(promptDeadlineClause);
    expect(questionNext).toContain(`\`${answerCommand}\``);

    mkdirSync(join(root, "bin"));
    symlinkSync(binary, join(root, "bin", "dvm"));
    const answered = JSON.parse((await run(answerCommand.replace('"<answer>"', shellQuoteArg(choices[0])))).stdout);
    expect(answered).toMatchObject({ jobId, sent: { type: "response",
      content: { prompt_id: "cadence", text: "keep  cadence — Δ" } }, next_action: { type: "poll" } });
    expect(answers).toEqual([{ prompt_id: "cadence", text: "keep  cadence — Δ" }]);
    expect(payments).toHaveLength(5);

    charge(500_000, "Extended observing block");
    const approval = JSON.parse((await run(["messages", jobId, "--wait", "--until", "60s"])).stdout);
    expect(approval).toMatchObject({ jobId, next_action: { type: "pay", job_id: jobId, amount_msats: 500_000,
      fiat_amount: { amount: 0.5, currency: "usd" }, hint: expect.stringContaining("`dvm pay conversation`") } });
    expect(approval.messages.map((message: Message) => [message.seq, message.type])).toEqual([[17, "payment-request"]]);
    expect(approval).not.toHaveProperty("auto_payments");
    const humanApproval = await run(["status", jobId, "--human"]);
    expect(humanApproval.stdout).toBe("");
    const payNext = humanApproval.stderr.split("\n").find((line) => line.startsWith("Next:"));
    expect(payNext).toContain("$0.50 USD (500 sats)");
    expect(payNext).toContain("`dvm pay conversation`");
    expect(payments).toHaveLength(5);

    const completed = JSON.parse((await run(["pay", jobId])).stdout);
    expect(completed).toMatchObject({ jobId, paid: { msats: 500_000, rail: "credit" }, next_action: null,
      summary: "Observation complete", artifact_count: 1 });
    expect(completed.messages.map((message: Message) => [message.seq, message.type]))
      .toEqual([[18, "payment"], [19, "artifact"], [20, "complete"]]);
    expect(payments.map((payment) => [payment.request_seq, payment.amount_micro]))
      .toEqual([[2, 100_000], [4, 200_000], [6, 300_000], [10, 100_000], [12, 100_000], [17, 500_000]]);

    const final = JSON.parse((await run(["status", jobId])).stdout);
    expect(final).toMatchObject({ status: "completed", next_action: null, receipt_verified: "verified",
      spend: { total_msats: 1_400_000, payments: 7, max_payments: 8, total_display: "$1.40 USD (1,400 sats) (BTC valuation)",
        budget_display: "$3.00 USD (3,000 sats)", receipt_total_display: "~$1.40 (1,400 sats) (BTC valuation)", log_mismatch: false } });
    expect(final.spend).not.toHaveProperty("receipt_mismatch");
    expect(final.spend.charges.map((entry: { seq: number; amount_msats: number; approval: string; rail: string }) =>
      [entry.seq, entry.amount_msats, entry.approval, entry.rail])).toEqual([
      [3, 100_000, "auto", "credit"], [5, 200_000, "auto", "credit"],
      [7, 300_000, "auto", "credit"], [9, 100_000, "auto", "x402"],
      [11, 100_000, "auto", "credit"], [13, 100_000, "auto", "credit"], [18, 500_000, "explicit", "credit"],
    ]);
    expect(final.spend.display).toContain("Paid $1.40 USD (1,400 sats) (BTC valuation) over 7 charges, budget $3.00 USD (3,000 sats).");
    expect(final.spend.display).toContain("comparison is unknown");
    const humanBill = await run(["status", jobId, "--human"]);
    expect(humanBill.stdout).toBe("Observation complete\n");
    expect(humanBill.stderr).toContain(final.spend.display);
    expect(humanBill.stderr).toContain("Receipt total: ~$1.40 (1,400 sats) (BTC valuation)");

    const file = join(root, "report.txt");
    const delivered = completed.messages.find((message: Message) => message.type === "artifact");
    const download = await fetch(delivered.content.url, { signal: AbortSignal.timeout(30_000) });
    expect(download.status).toBe(200);
    writeFileSync(file, Buffer.from(await download.arrayBuffer()));
    const verified = JSON.parse((await run(["receipts", "verify", jobId, "--file", file, "--artifact", "report.txt"])).stdout);
    expect(verified).toMatchObject({ job_id: jobId, receipt_verified: "verified",
      receipt_checks: { signature: true, result_hash: "ok" },
      files: [{ status: "match", matched_artifact: { index: 1, name: { _source: "provider", text: "report.txt" } } }] });
    expect(failures).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  }

  function run(command: string[] | string): Promise<{ stdout: string; stderr: string }> {
    // Refresh the isolated FX cache before each child; no live rate or host timing affects the amounts.
    writeFileSync(join(root, "btc-rate.json"), JSON.stringify({ rate: 100_000, timestamp: Date.now() }));
    return new Promise((done, reject) => {
      const child = typeof command === "string"
        ? spawn("/bin/sh", ["-c", `exec ${command}`], { env: environment(), stdio: ["ignore", "pipe", "pipe"] })
        : spawn(process.execPath, [binary, ...command], { env: environment(), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 90_000);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) done({ stdout, stderr });
        else reject(new Error(`dvm ${JSON.stringify(command)} exited ${code}: ${stdout}\n${stderr}\n${failures.join("\n")}`));
      });
    });
  }
  function environment() {
    return { ...process.env, DVM_CONFIG_DIR: root, LANG: "C", LC_ALL: "C",
      PATH: `${join(root, "bin")}:${dirname(process.execPath)}:${process.env.PATH ?? ""}` };
  }
}, 240_000);
