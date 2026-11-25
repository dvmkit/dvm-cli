import { randomBytes } from "node:crypto";
import pg from "pg";
import { readdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configureDVM } from "@dvmkit/sdk";
import { createDVMServer, MemoryKVStore, deriveIdentityFromPrivkey } from "@dvmkit/sdk/internal";
import { CreditLedger, PostgresJobStore, MemoryCreditLedger, secp256k1Auth } from "@dvmkit/sdk/server";
import { MemoryJobStore } from "@dvmkit/sdk/testing";
import { z } from "zod";

const signer = deriveIdentityFromPrivkey("0d".repeat(32));
const connectionString = process.env.DVM_CLI_MANDATE_DATABASE_URL;
const schema = `mandate_test_${randomBytes(8).toString("hex")}`;
const admin = connectionString ? new pg.Pool({ connectionString }) : undefined;
if (admin) await admin.query(`CREATE SCHEMA ${schema}`);
const db = connectionString ? new pg.Pool({ connectionString, options: `-c search_path=${schema}` }) : undefined;
const ledger = db ? new CreditLedger(db) : new MemoryCreditLedger();
const jobStore = db ? new PostgresJobStore(db) : new MemoryJobStore();
if (db) { await ledger.init(); await jobStore.init(); await jobStore.initStreaming(); }
const credit = await ledger.fund({ creditId: "mandate-credit", callerPubkey: signer.pubkey,
  currency: "usd", amountMicro: 20_000_000, expiryMs: Date.now() + 86_400_000,
  basis: { rail: "lightning", paidMsats: 20_000_000 } });
const submissions = [];
let supported = true;
let advertiseCredit = true;
let maxDuration;
let omitMaxDuration = false;
let hold = false;
let pieces = 0;
let askAmounts;
let dropPaymentResponse = false;
const paymentPosts = [];
const postPaths = [];
const recoveryPosts = [];
let quoteMode = "normal";
let rejectMandate = false;
let rejectCredit = false;
let advertisedUpfront;
const pending = [];
const descriptor = configureDVM({ name: "Mandate contract", capability: "run", price: "$0.10",
  credit: { min: "$0.10", max: "$20" }, auth: secp256k1Auth({ replayStore: null }),
  input: z.object({}).passthrough(), async onJob(ctx) {
    const asks = askAmounts ?? Array(pieces).fill(0.2);
    if (hold) { ctx.working(0); await new Promise((resolve) => pending.push(resolve)); }
    for (let index = 0; index < asks.length; index++)
      await ctx.requestPayment({ amount: asks[index], currency: "usd" }, `Piece ${index + 2}`);
    ctx.complete("done");
  } });
const sdkDist = dirname(fileURLToPath(import.meta.resolve("@dvmkit/sdk/server")));
const setupFile = readdirSync(join(sdkDist, "..")).find((name) => /^mpp-setup-.*\.js$/.test(name));
if (!setupFile) throw new Error("Installed SDK has no MPP setup module; update the fixture.");
const { createMppFromOpts } = await import(pathToFileURL(join(sdkDist, "..", setupFile)).href);
const sdk = await createDVMServer(descriptor, { env: {}, devMode: true, dvmId: "mandate-contract",
  store: new MemoryKVStore(), jobStore, creditLedger: ledger, ...(db ? { db } : {}),
  mpp: createMppFromOpts({ tempoRecipient: "0x1111111111111111111111111111111111111111" },
    { DVMKIT_TEMPO_SECRET_KEY: "44".repeat(32) }),
  fxFetcher: { fetch: async () => ({ rates: { usd: 100_000 }, as_of: new Date().toISOString() }),
    supportedCurrencies: () => ["usd"] } });
const server = createServer(async (incoming, outgoing) => {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  if (incoming.method === "POST") postPaths.push(incoming.url);
  let isPayment = false;
  if (incoming.method === "POST" && incoming.url?.endsWith("/messages")) {
    const message = JSON.parse(Buffer.concat(chunks).toString());
    isPayment = message.type === "payment";
    if (isPayment) paymentPosts.push(message);
  }
  if (incoming.method === "POST" && incoming.url === "/v1/job")
    submissions.push(JSON.parse(Buffer.concat(chunks).toString()));
  if (incoming.url === "/v1/quote" && quoteMode !== "normal") {
    if (quoteMode === "timeout") await new Promise((done) => setTimeout(done, 1500));
    outgoing.writeHead(503, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ error: "unavailable" }));
    return;
  }
  if (incoming.method === "POST" && incoming.url?.startsWith("/v1/request-")) {
    recoveryPosts.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (rejectCredit && incoming.url.startsWith("/v1/request-resume/")) {
      outgoing.writeHead(400, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: "invalid_mandate", message: "The saved mandate was refused" }));
      return;
    }
  }
  if (incoming.url === "/v1/job" && rejectCredit) {
    outgoing.writeHead(404, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ error: "credit_not_found", message: "Credit not found" }));
    return;
  }
  if (incoming.url === "/v1/job" && rejectMandate && submissions.at(-1)?.data.mandate) {
    outgoing.writeHead(400, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ error: "invalid_mandate", message: "mandate.expires_at_ms is too far in the future" }));
    return;
  }
  let response = await sdk.app.fetch(new Request(`http://127.0.0.1${incoming.url}`, {
    method: incoming.method, headers: incoming.headers,
    ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
  if (isPayment && response.ok && dropPaymentResponse) {
    dropPaymentResponse = false;
    outgoing.destroy();
    return;
  }
  if (incoming.url === "/v1/info") {
    const body = await response.json();
    // Memory runs exercise SDK admission; database runs also exercise automatic settlement.
    if (!supported) {
      delete body.credit.standing_mandate;
      delete body.credit.mandate_max_duration;
    } else if (!db) {
      body.credit.standing_mandate = true;
    }
    if (advertisedUpfront !== undefined) {
      const max = { amount: advertisedUpfront, currency: "usd" };
      body.pricing = { ...body.pricing, max };
      body.capabilities.run.pricing = { ...body.capabilities.run.pricing, max };
    }
    if (omitMaxDuration) delete body.credit.mandate_max_duration;
    if (maxDuration !== undefined) body.credit.mandate_max_duration = maxDuration;
    if (!advertiseCredit) delete body.credit;
    response = Response.json(body);
  }
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
process.on("message", async (message) => {
  if (message.op === "configure") {
    hold = message.hold ?? false; pieces = message.pieces ?? 0; quoteMode = message.quote ?? "normal"; rejectMandate = message.reject ?? false;
    rejectCredit = message.rejectCredit ?? false;
    advertisedUpfront = message.advertisedUpfront;
    advertiseCredit = message.advertiseCredit ?? true;
    maxDuration = message.maxDuration;
    omitMaxDuration = message.omitMaxDuration ?? false;
    askAmounts = message.askAmounts;
    dropPaymentResponse = message.dropPaymentResponse ?? false;
    process.send({ type: "configured" });
  }
  if (message.op === "release") { pending.splice(0).forEach((resolve) => resolve()); process.send({ type: "released" }); }
  if (message.op === "support") { supported = message.value; process.send({ type: "support" }); }
  if (message.op === "snapshot") {
    const jobs = await Promise.all(message.ids.map((id) => jobStore.get(id)));
    const balance = await ledger.get(credit.creditId);
    process.send({ type: "snapshot", submissions, jobs, paymentPosts, postPaths, recoveryPosts, balance });
  }
  if (message.op === "shutdown") {
    pending.splice(0).forEach((resolve) => resolve());
    await new Promise(setImmediate);
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await sdk.shutdown();
    if (db) { await jobStore.shutdownStreaming(); await db.end(); }
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
    process.disconnect();
  }
});
process.send({ type: "ready", endpoint: `http://127.0.0.1:${server.address().port}`, pubkey: signer.pubkey,
  credit: { creditId: credit.creditId, currency: "usd", balanceMicro: 20_000_000,
    remainingMicro: 20_000_000, ledgerSeq: 1, expiryMs: Date.now() + 86_400_000 } });
