import { createServer } from "node:http";

import { configureDVM } from "@dvmkit/sdk";
import { buildAttestation, createDVMServer, MemoryKVStore, receiptPubkeyFromSecret, signAttestation } from "@dvmkit/sdk/internal";
import { secp256k1Auth } from "@dvmkit/sdk/server";
import { MemoryJobStore } from "@dvmkit/sdk/testing";
import { z } from "zod";

const jobs = [];
const submissions = [];
const providers = [];
const requests = [];
const pending = [];
let deferred = false;
const builderSecret = "11".repeat(32);
const builderPubkey = receiptPubkeyFromSecret(builderSecret);
const attestation = buildAttestation({
  dvmId: "discovery-contract", slug: "discovery-contract", capabilities: ["search", "browse"],
  builderPubkey, receiptPubkey: builderPubkey, deployedAt: 1_700_000_000,
});
const builder = { pubkey: builderPubkey, attestation, signature: signAttestation(attestation, builderSecret) };

async function finish(ctx, summary) {
  if (deferred) {
    ctx.working(0);
    await new Promise((resolve) => pending.push(resolve));
  }
  ctx.complete(summary);
}

async function provider(auth) {
  const envelope = auth ? {
    pubkey: z.string(), signature: z.string(), timestamp: z.number(), nonce: z.string(),
  } : {};
  const common = { ...envelope, limit: z.number(), tags: z.array(z.string()).optional(), region: z.string().default("global") };
  const searchSchema = z.object({ ...common, query: z.string(), mode: z.enum(["keyword", "natural_language"]), credit: z.boolean().optional() });
  const browseSchema = z.object({ ...common, builder: z.string().optional(), source: z.string(), sort: z.string(), offset: z.number() });
  const descriptor = configureDVM({
    name: "Discovery contract",
    ...(auth ? { auth: secp256k1Auth({ replayStore: null }) } : {}),
    capabilities: {
      search: {
        input: searchSchema,
        async onJob(ctx) {
          const input = searchSchema.parse(ctx.input);
          jobs.push({ capability: "search", input: ctx.input, pubkey: ctx.auth?.pubkey });
          await finish(ctx, JSON.stringify({ results: [], query: input.query, mode: input.mode, total: 0 }));
        },
      },
      browse: {
        input: browseSchema,
        async onJob(ctx) {
          const input = browseSchema.parse(ctx.input);
          jobs.push({ capability: "browse", input: ctx.input, pubkey: ctx.auth?.pubkey });
          await finish(ctx, JSON.stringify({ entries: [], total: 0, offset: input.offset, limit: input.limit }));
        },
      },
    },
  });
  const sdk = await createDVMServer(descriptor, {
    env: {}, store: new MemoryKVStore(), jobStore: new MemoryJobStore(), dvmId: "discovery-contract", builder,
  });
  const server = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    requests.push({ method: incoming.method, path: incoming.url, authenticated: auth });
    if (incoming.method === "POST" && incoming.url === "/v1/job") {
      submissions.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    }
    const response = await sdk.app.fetch(new Request(`http://127.0.0.1${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });

  providers.push({ server, shutdown: sdk.shutdown });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Discovery server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

const authenticated = await provider(true);
const anonymous = await provider(false);
process.on("message", async (message) => {
  if (message === "snapshot") {
    process.send({ type: "snapshot", jobs, submissions, requests });
  } else if (message === "defer") {
    deferred = true;
    process.send({ type: "deferred" });
  } else if (message === "release") {
    deferred = false;
    for (const release of pending.splice(0)) release();
    process.send({ type: "released" });
  } else if (message === "shutdown") {
    for (const release of pending.splice(0)) release();
    for (const { server, shutdown } of providers) {
      server.closeAllConnections();
      await new Promise((done, reject) => server.close((err) => err ? reject(err) : done()));
      await shutdown();
    }
    process.disconnect();
  }
});
process.send({ type: "ready", authenticated, anonymous });
