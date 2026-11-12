import { createNewMintKeys, serializeMintKeys } from "@cashu/cashu-ts";
import { WALLET_VERSION } from "@dvmkit/sdk/internal";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
        "11": { supported: true }, "20": { supported: true },
      } }));
    } else if (route === "GET /v1/keysets") {
      response.end(JSON.stringify({ keysets: [keyset] }));
    } else if (route === "GET /v1/keys") {
      response.end(JSON.stringify({ keysets: [{ ...keyset, keys }] }));
    } else if (route === "POST /v1/mint/quote/bolt11") {
      receivedQuoteBody = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      createdQuotes += 1;
      response.end(JSON.stringify({ quote: `quote-${createdQuotes}`, request: createdQuotes === 1 ? "lnbc10u1fakea" : "lnbc10u1fakeb",
        amount: receivedQuoteBody.amount, unit: "sat", pubkey: receivedQuoteBody.pubkey, expiry, state: "UNPAID" }));
    } else if (route.startsWith("GET /v1/mint/quote/bolt11/")) {
      response.end(JSON.stringify({ quote: "quote-1", request: "lnbc10u1fakea", amount: 1000,
        unit: "sat", pubkey, expiry, state: "UNPAID" }));
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  writeFileSync(join(root, "wallet.json"), JSON.stringify({
    version: WALLET_VERSION, lock_privkey: `${"0".repeat(63)}1`, lock_pubkey: pubkey,
    mnemonic_fingerprint: null, mints: [endpoint], proofs: [], nut13_counters: {},
    pending_mints: [], pending_melts: [], pending_submissions: [], recent_spends: [], created_at: new Date().toISOString(),
  }));
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
