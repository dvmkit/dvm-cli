import { createServer } from "node:http";

import { configureDVM } from "@dvmkit/sdk";
import { createDVMServer, MemoryKVStore } from "@dvmkit/sdk/internal";
import { secp256k1Auth } from "@dvmkit/sdk/server";
import { z } from "zod";

const jobs = [];
const submissions = [];
const providers = [];

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
        onJob(ctx) {
          const input = searchSchema.parse(ctx.input);
          jobs.push({ capability: "search", input: ctx.input, pubkey: ctx.auth?.pubkey });
          ctx.complete(JSON.stringify({ results: [], query: input.query, mode: input.mode, total: 0 }));
        },
      },
      browse: {
        input: browseSchema,
        onJob(ctx) {
          const input = browseSchema.parse(ctx.input);
          jobs.push({ capability: "browse", input: ctx.input, pubkey: ctx.auth?.pubkey });
          ctx.complete(JSON.stringify({ entries: [], total: 0, offset: input.offset, limit: input.limit }));
        },
      },
    },
  });
  const sdk = await createDVMServer(descriptor, { env: {}, store: new MemoryKVStore(), dvmId: "discovery-contract" });
  const server = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
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
    process.send({ type: "snapshot", jobs, submissions });
  } else if (message === "shutdown") {
    for (const { server, shutdown } of providers) {
      server.closeAllConnections();
      await new Promise((done, reject) => server.close((err) => err ? reject(err) : done()));
      await shutdown();
    }
    process.disconnect();
  }
});
process.send({ type: "ready", authenticated, anonymous });
