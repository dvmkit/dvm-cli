import { createBlindSignature, createDLEQProof, createNewMintKeys, pointFromHex, serializeMintKeys } from "@cashu/cashu-ts";
import { WALLET_VERSION } from "@dvmkit/sdk/internal";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";

const binary = resolve(import.meta.dirname, "../../dist/dvm.js");
const root = mkdtempSync(join(tmpdir(), "dvm-fund-handoff-contract-"));
const execute = promisify(execFile);
const pubkey = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
// cashu-ts rejects a keyset that reuses one public key across denominations.
const mintKeys = createNewMintKeys(11, new Uint8Array(32).fill(1));
const keys = serializeMintKeys(mintKeys.pubKeys);
const keyset = { id: mintKeys.keysetId, unit: "sat", active: true, input_fee_ppk: 0 };
const requests: string[] = [];
const expiry = Math.floor(Date.now() / 1000) + 3600;
let server: Server;
let endpoint: string;
let createdQuotes = 0;
let receivedQuoteBody: Record<string, unknown>;
type Output = { amount: number; B_: string };
type Quote = {
  state: "UNPAID" | "PAID" | "ISSUED";
  holdStatus?: () => Promise<void>;
  holdIssuance?: (outputs: Output[]) => Promise<void>;
};
const quotes = new Map<string, Quote>();
let prepareNextQuote: ((quote: Quote) => void) | undefined;

function seedWallet(directory: string) {
  writeFileSync(join(directory, "wallet.json"), JSON.stringify({
    version: WALLET_VERSION, lock_privkey: `${"0".repeat(63)}1`, lock_pubkey: pubkey,
    mnemonic_fingerprint: null, mints: [endpoint], proofs: [], nut13_counters: {},
    pending_mints: [], pending_melts: [], pending_submissions: [], recent_spends: [], created_at: new Date().toISOString(),
  }));
}

function quoteReply(id: string) {
  return {
    quote: id, request: id === "quote-1" ? "lnbc10u1fakea" : "lnbc10u1fakeb", amount: 1000,
    unit: "sat", pubkey, expiry, state: quotes.get(id)!.state,
  };
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const route = `${request.method} ${request.url}`;
    requests.push(route);
    response.setHeader("content-type", "application/json");
    if (route === "GET /v1/info") {
      response.end(JSON.stringify({ name: "Handoff test mint", pubkey, version: "fixture/1", nuts: {
        "4": { methods: [{ method: "bolt11", unit: "sat" }], disabled: false },
        "5": { methods: [{ method: "bolt11", unit: "sat" }], disabled: false },
        "7": { supported: true }, "9": { supported: true }, "10": { supported: true },
        "11": { supported: true }, "12": { supported: true }, "20": { supported: true },
      } }));
    } else if (route === "GET /v1/keysets") {
      response.end(JSON.stringify({ keysets: [keyset] }));
    } else if (route.startsWith("GET /v1/keys/") || route === "GET /v1/keys") {
      response.end(JSON.stringify({ keysets: [{ ...keyset, keys }] }));
    } else if (route === "POST /v1/mint/quote/bolt11") {
      receivedQuoteBody = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      const id = `quote-${++createdQuotes}`;
      const quote: Quote = { state: "UNPAID" };
      prepareNextQuote?.(quote);
      prepareNextQuote = undefined;
      quotes.set(id, quote);
      response.end(JSON.stringify({ ...quoteReply(id), amount: receivedQuoteBody.amount, pubkey: receivedQuoteBody.pubkey }));
    } else if (route.startsWith("GET /v1/mint/quote/bolt11/")) {
      const id = route.split("/").at(-1)!;
      await quotes.get(id)?.holdStatus?.();
      if (!response.destroyed) response.end(JSON.stringify(quoteReply(id)));
    } else if (route === "POST /v1/mint/bolt11") {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { quote: string; outputs: Output[] };
      const quote = quotes.get(body.quote)!;
      await quote.holdIssuance?.(body.outputs);
      quote.state = "ISSUED";
      response.end(JSON.stringify({ signatures: body.outputs.map((output) => {
        const point = pointFromHex(output.B_);
        const privateKey = mintKeys.privKeys[output.amount];
        const signature = createBlindSignature(point, privateKey, keyset.id);
        const dleq = createDLEQProof(point, privateKey);
        return { amount: output.amount, id: keyset.id, C_: signature.C_.toHex(true),
          dleq: { e: Buffer.from(dleq.e).toString("hex"), s: Buffer.from(dleq.s).toString("hex") } };
      }) }));
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  seedWallet(root);
});

afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

it("exits successfully within five seconds with a durable invoice and warns on a second quote", async () => {
  const args = [binary, "wallet", "fund", "1000", "--sats", "--no-float", "--no-wait", "--qr-image", join(root, "qr.png")];
  const env = { ...process.env, DVM_CONFIG_DIR: root };
  async function runFundingCommand() {
    const result = await execute(process.execPath, args, { env, timeout: 5000 }).then(
      (result) => ({ ...result, code: 0 }),
      (error) => error as { stdout: string; stderr: string; code: number | undefined }
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    return result;
  }
  const started = Date.now();
  const first = await runFundingCommand();
  expect(Date.now() - started).toBeLessThan(5000);
  expect(first.stderr).toBe("");
  expect(JSON.parse(first.stdout)).toMatchObject({
    status: "awaiting_payment", quote_id: "quote-1", invoice: "lnbc10u1fakea",
    next_step: "dvm wallet show", expires_at: new Date(expiry * 1000).toISOString(),
  });
  expect(receivedQuoteBody).toMatchObject({ amount: 1000, unit: "sat", pubkey });
  expect(requests.some((route) => route.startsWith("GET /v1/mint/quote/bolt11/"))).toBe(false);
  const disk = () => JSON.parse(readFileSync(join(root, "wallet.json"), "utf8")) as { pending_mints: Array<{ quote_id: string }> };
  expect(disk().pending_mints).toMatchObject([{ quote_id: "quote-1", amount_sats: 1000, expires_at: expiry }]);
  expect(readFileSync(join(root, "qr.png")).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  const second = await runFundingCommand();
  expect(JSON.parse(second.stdout)).toMatchObject({
    quote_id: "quote-2", warning: expect.stringContaining("An unpaid quote already exists: quote-1"),
  });
  expect(disk().pending_mints.map((entry) => entry.quote_id)).toEqual(["quote-1", "quote-2"]);
}, 15_000);

function startCollection(directory: string, duration: string) {
  const env = { ...process.env, DVM_CONFIG_DIR: directory };
  const child = spawn(process.execPath, [binary, "wallet", "fund", "1000", "--sats", "--no-float", "--no-wait",
    "--qr-image", join(directory, "qr.png"), "--collect-for", duration], { env, timeout: 18_000 });
  const handoff = Promise.withResolvers<string>();
  const events: Record<string, unknown>[] = [];
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const event = JSON.parse(line) as Record<string, unknown>;
    events.push(event);
    if (event.status === "awaiting_payment") handoff.resolve(event.quote_id as string);
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  void closed.then((code) => handoff.reject(new Error(`Collector exited before printing an invoice (${code}). ${stderr}`)), handoff.reject);
  return { env, handoff: handoff.promise, finished: async () => {
    expect(await closed, stderr).toBe(0);
    return events.at(-1);
  }, stop: () => child.kill() };
}

function readWallet(directory: string) {
  return JSON.parse(readFileSync(join(directory, "wallet.json"), "utf8")) as {
    pending_mints: Array<{ quote_id: string; minting?: { outputs: Array<{ blinded_message: Output }> } }>;
    proofs: Array<{ amount: number; secret: string }>;
  };
}

it("fund and show share one durable issuance across processes", async () => {
  const directory = mkdtempSync(join(root, "race-"));
  seedWallet(directory);
  const pendingIssuance = Promise.withResolvers<Output[]>();
  const finishIssuance = Promise.withResolvers<void>();
  const start = requests.length;
  const run = startCollection(directory, "15s");
  try {
    const id = await run.handoff;
    const quote = quotes.get(id)!;
    quote.holdIssuance = (outputs) => {
      pendingIssuance.resolve(outputs);
      return finishIssuance.promise;
    };
    quote.state = "PAID";
    const outputs = await Promise.race([pendingIssuance.promise, run.finished().then(() => { throw new Error("Collection ended before minting"); })]);
    const pending = readWallet(directory).pending_mints[0];
    expect(pending).toMatchObject({ quote_id: id, minting: { outputs: outputs.map((o) => ({ blinded_message: o })) } });

    const show = await execute(process.execPath, [binary, "wallet", "show"], { env: run.env, timeout: 5000 });
    expect(JSON.parse(show.stdout)).toMatchObject({ total_sats: 0, sweep: { unchecked: [{ quote_id: id }] } });

    finishIssuance.resolve();
    expect(await run.finished()).toMatchObject({ status: "minted", quote_id: id, sats_minted: 1000 });
    const wallet = readWallet(directory);
    expect(requests.slice(start).filter((route) => route === "POST /v1/mint/bolt11")).toHaveLength(1);
    expect(wallet.pending_mints).toEqual([]);
    expect(wallet.proofs.reduce((sum, proof) => sum + proof.amount, 0)).toBe(1000);
    expect(new Set(wallet.proofs.map((proof) => proof.secret)).size).toBe(wallet.proofs.length);
  } finally {
    finishIssuance.resolve();
    run.stop();
  }
}, 20_000);

it("ends the collection window even if the mint does not finish replying", async () => {
  const directory = mkdtempSync(join(root, "bound-"));
  seedWallet(directory);
  let receivedStatus = false;
  const finishStatus = Promise.withResolvers<void>();
  prepareNextQuote = (quote) => {
    quote.holdStatus = () => {
      receivedStatus = true;
      return finishStatus.promise;
    };
  };
  const run = startCollection(directory, "1s");
  try {
    const id = await run.handoff;
    const started = Date.now();
    const event = await run.finished();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(receivedStatus).toBe(true);
    expect(event).toMatchObject({
      status: "collection_stopped", reason: "duration_elapsed", quote_id: id,
      next_step: "dvm wallet show", collect_before: new Date(expiry * 1000).toISOString(),
    });
    expect(readWallet(directory)).toMatchObject({ pending_mints: [{ quote_id: id }], proofs: [] });
  } finally {
    prepareNextQuote = undefined;
    finishStatus.resolve();
    run.stop();
  }
}, 10_000);
