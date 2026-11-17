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
let hold = false;
let pieces = 0;
const paymentPosts = [];
let quoteMode = "normal";
let rejectMandate = false;
const pending = [];
const descriptor = configureDVM({ name: "Mandate contract", capability: "run", price: "$0.10",
  credit: { min: "$0.10", max: "$20" }, auth: secp256k1Auth({ replayStore: null }),
  input: z.object({}).passthrough(), async onJob(ctx) {
    const asks = pieces;
    if (hold) { ctx.working(0); await new Promise((resolve) => pending.push(resolve)); }
    for (let index = 0; index < asks; index++)
      await ctx.requestPayment({ amount: 0.2, currency: "usd" }, `Piece ${index + 2}`);
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
  if (incoming.method === "POST" && incoming.url?.endsWith("/messages")) {
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.type === "payment") paymentPosts.push(message);
  }
  if (incoming.method === "POST" && incoming.url === "/v1/job")
    submissions.push(JSON.parse(Buffer.concat(chunks).toString()));
  if (incoming.url === "/v1/quote" && quoteMode !== "normal") {
    if (quoteMode === "timeout") await new Promise((done) => setTimeout(done, 1500));
    outgoing.writeHead(503, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ error: "unavailable" }));
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
  if (incoming.url === "/v1/info") {
    const body = await response.json();
    // Memory runs exercise SDK admission; database runs also exercise automatic settlement.
    if (supported) body.credit.standing_mandate = true;
    else delete body.credit.standing_mandate;
    response = Response.json(body);
  }
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
process.on("message", async (message) => {
  if (message.op === "configure") {
    hold = message.hold ?? false; pieces = message.pieces ?? 0; quoteMode = message.quote ?? "normal"; rejectMandate = message.reject ?? false;
    process.send({ type: "configured" });
  }
  if (message.op === "release") { pending.splice(0).forEach((resolve) => resolve()); process.send({ type: "released" }); }
  if (message.op === "support") { supported = message.value; process.send({ type: "support" }); }
  if (message.op === "snapshot") {
    const jobs = await Promise.all(message.ids.map((id) => jobStore.get(id)));
    process.send({ type: "snapshot", submissions, jobs, paymentPosts });
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
