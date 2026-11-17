import { readdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configureDVM } from "@dvmkit/sdk";
import { createDVMServer, MemoryKVStore, deriveIdentityFromPrivkey } from "@dvmkit/sdk/internal";
import { MemoryCreditLedger, secp256k1Auth } from "@dvmkit/sdk/server";
import { MemoryJobStore } from "@dvmkit/sdk/testing";
import { z } from "zod";

const signer = deriveIdentityFromPrivkey("0d".repeat(32));
const ledger = new MemoryCreditLedger();
const jobStore = new MemoryJobStore();
const credit = await ledger.fund({ creditId: "mandate-credit", callerPubkey: signer.pubkey,
  currency: "usd", amountMicro: 20_000_000, expiryMs: Date.now() + 86_400_000,
  basis: { rail: "lightning", paidMsats: 20_000_000 } });
const submissions = [];
let supported = true;
let hold = false;
let quoteMode = "normal";
let rejectMandate = false;
const pending = [];
const descriptor = configureDVM({ name: "Mandate contract", capability: "run", price: "$0.10",
  credit: { min: "$0.10", max: "$20" }, auth: secp256k1Auth({ replayStore: null }),
  input: z.object({}).passthrough(), async onJob(ctx) {
    if (hold) { ctx.working(0); await new Promise((resolve) => pending.push(resolve)); }
    ctx.complete("done");
  } });
const sdkDist = dirname(fileURLToPath(import.meta.resolve("@dvmkit/sdk/server")));
const setupFile = readdirSync(join(sdkDist, "..")).find((name) => /^mpp-setup-.*\.js$/.test(name));
if (!setupFile) throw new Error("Installed SDK has no MPP setup module; update the fixture.");
const { createMppFromOpts } = await import(pathToFileURL(join(sdkDist, "..", setupFile)).href);
const sdk = await createDVMServer(descriptor, { env: {}, devMode: true, dvmId: "mandate-contract",
  store: new MemoryKVStore(), jobStore, creditLedger: ledger,
  mpp: createMppFromOpts({ tempoRecipient: "0x1111111111111111111111111111111111111111" },
    { DVMKIT_TEMPO_SECRET_KEY: "44".repeat(32) }),
  fxFetcher: { fetch: async () => ({ rates: { usd: 100_000 }, as_of: new Date().toISOString() }),
    supportedCurrencies: () => ["usd"] } });
const server = createServer(async (incoming, outgoing) => {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
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
    // Exercise real SDK admission/storage in memory; automatic settlement itself requires durable stores.
    if (supported) body.credit.standing_mandate = true;
    response = Response.json(body);
  }
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
process.on("message", async (message) => {
  if (message.op === "configure") {
    hold = message.hold ?? false; quoteMode = message.quote ?? "normal"; rejectMandate = message.reject ?? false;
    process.send({ type: "configured" });
  }
  if (message.op === "support") { supported = message.value; process.send({ type: "support" }); }
  if (message.op === "snapshot") {
    const jobs = await Promise.all(message.ids.map((id) => jobStore.get(id)));
    process.send({ type: "snapshot", submissions, jobs });
  }
  if (message.op === "shutdown") {
    pending.splice(0).forEach((resolve) => resolve());
    await new Promise(setImmediate);
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await sdk.shutdown();
    process.disconnect();
  }
});
process.send({ type: "ready", endpoint: `http://127.0.0.1:${server.address().port}`, pubkey: signer.pubkey,
  credit: { creditId: credit.creditId, currency: "usd", balanceMicro: 20_000_000,
    remainingMicro: 20_000_000, ledgerSeq: 1, expiryMs: Date.now() + 86_400_000 } });
