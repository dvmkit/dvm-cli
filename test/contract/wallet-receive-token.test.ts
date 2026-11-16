import {
  Amount,
  createBlindSignature,
  createDLEQProof,
  createNewMintKeys,
  getEncodedToken,
  hashToCurve,
  pointFromHex,
  serializeMintKeys,
} from "@cashu/cashu-ts";
import { WALLET_VERSION } from "@dvmkit/sdk/internal";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

const binary = resolve(import.meta.dirname, "../../dist/dvm.js");
const pubkey = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const mintKeys = createNewMintKeys(8, new Uint8Array(32).fill(3));
const keyset = { id: mintKeys.keysetId, unit: "sat", active: true, input_fee_ppk: 0 };
const keys = serializeMintKeys(mintKeys.pubKeys);
const roots: string[] = [];
const swapInputs: string[] = [];
let server: Server;
let endpoint: string;

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/info") {
      response.end(JSON.stringify({ name: "Receive test mint", pubkey, version: "fixture/1", nuts: {
        "4": { methods: [{ method: "bolt11", unit: "sat" }], disabled: false },
        "5": { methods: [{ method: "bolt11", unit: "sat" }], disabled: false },
        "7": { supported: true }, "9": { supported: true }, "10": { supported: true },
        "11": { supported: true }, "12": { supported: true }, "20": { supported: true },
      } }));
    } else if (request.url === "/v1/keysets") {
      response.end(JSON.stringify({ keysets: [keyset] }));
    } else if (request.url?.startsWith("/v1/keys")) {
      response.end(JSON.stringify({ keysets: [{ ...keyset, keys }] }));
    } else if (request.method === "POST" && request.url === "/v1/swap") {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        inputs: Array<{ secret: string }>;
        outputs: Array<{ amount: number; B_: string }>;
      };
      swapInputs.push(...body.inputs.map((input) => input.secret));
      response.end(JSON.stringify({ signatures: body.outputs.map((output) => {
        const point = pointFromHex(output.B_);
        const privateKey = mintKeys.privKeys[output.amount];
        const signed = createBlindSignature(point, privateKey, keyset.id);
        const dleq = createDLEQProof(point, privateKey);
        return { amount: output.amount, id: keyset.id, C_: signed.C_.toHex(true),
          dleq: { e: Buffer.from(dleq.e).toString("hex"), s: Buffer.from(dleq.s).toString("hex") } };
      }) }));
    } else {
      response.writeHead(404).end("{}");
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((done) => server.close(() => done()));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function caller(): string {
  const root = mkdtempSync(join(tmpdir(), "dvm-receive-contract-"));
  roots.push(root);
  writeFileSync(join(root, "wallet.json"), JSON.stringify({
    version: WALLET_VERSION, lock_privkey: `${"0".repeat(63)}1`, lock_pubkey: pubkey,
    mnemonic_fingerprint: null, mints: [], proofs: [], nut13_counters: {},
    pending_mints: [], pending_melts: [], pending_submissions: [], recent_spends: [], created_at: new Date().toISOString(),
  }));
  return root;
}

function token() {
  const secret = randomBytes(32).toString("hex");
  const signature = createBlindSignature(hashToCurve(new TextEncoder().encode(secret)), mintKeys.privKeys[8], keyset.id);
  return { secret, encoded: getEncodedToken({ mint: endpoint, unit: "sat", proofs: [
    { amount: Amount.from(8), id: keyset.id, secret, C: signature.C_.toHex(true) },
  ] }) };
}

function run(args: string[], root: string, input = ""): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [binary, "wallet", "receive-token", ...args], {
      env: { ...process.env, DVM_CONFIG_DIR: root }, stdio: ["pipe", "pipe", "pipe"], timeout: 10_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => done({ stdout, stderr, code }));
    child.stdin.on("error", () => { /* A CLI rejecting its input can close the pipe before it is written. */ });
    child.stdin.end(input);
  });
}

it.each(["implicit stdin", "explicit stdin", "positional"])("claims and persists a token through %s", async (source) => {
  const root = caller();
  const incoming = token();
  const args = source === "positional" ? [incoming.encoded] : source === "explicit stdin" ? ["-"] : [];
  const result = await run(args, root, source === "positional" ? "ignored stdin" : ` \n${incoming.encoded}\n\t`);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    status: "received", mint: endpoint, claimed_sats: 8, proof_count: 1,
    display: `Claimed 8 sats from ${endpoint} into your wallet.`,
    hint: "Inspect the resulting balance with `dvm wallet show`.",
  });
  if (source === "positional") {
    expect(result.stderr).toContain("WARNING:");
    expect(result.stderr).toContain("shell history and process listings");
  } else {
    expect(result.stderr).toBe("");
  }
  expect(result.stdout + result.stderr).not.toContain(incoming.encoded);
  expect(swapInputs).toContain(incoming.secret);
  const saved = JSON.parse(readFileSync(join(root, "wallet.json"), "utf8")) as {
    mints: string[]; proofs: Array<{ amount: number; secret: string; status: string }>;
  };
  expect(saved.mints).toEqual([endpoint]);
  expect(saved.proofs).toHaveLength(1);
  expect(saved.proofs[0]).toMatchObject({ amount: 8, status: "valid" });
  const locked = JSON.parse(saved.proofs[0].secret);
  expect(locked[0]).toBe("P2PK");
  expect(locked[1].data).toBe(pubkey);
}, 15_000);

it("keeps an invalid positional token out of its warning and JSON error", async () => {
  const secret = "cashu-invalid-secret";
  const result = await run([secret], caller());
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("invalid_token");
  expect(result.stderr).toContain("WARNING:");
  expect(result.stdout + result.stderr).not.toContain(secret);
});

it.each([{ args: [] }, { args: ["-"] }])("rejects an empty pipe through the CLI with $args", async ({ args }) => {
  const result = await run(args, caller(), " \n");
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe("no_input");
  expect(result.stderr).toBe("");
});
