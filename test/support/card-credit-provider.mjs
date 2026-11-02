/* A DVM that takes card-funded prepaid credit, for driving the built `dvm` CLI
 * end to end: the SDK's real card rail, ledger and drain leg, against a fake
 * Stripe that models PaymentIntents, the fee on the charge and refunds.
 * Controlled over IPC so a test can make Stripe decline, lose a response, or
 * hold a refund pending, and can make the HTTP front drop paid responses. */
import { readdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { configureDVM } from "@dvmkit/sdk";
import { createDVMServer, MemoryKVStore } from "@dvmkit/sdk/internal";
import { createStripeCreditRail, MemoryCreditLedger, secp256k1Auth } from "@dvmkit/sdk/server";
import { z } from "zod";

const HMAC = "44".repeat(32);
const LIVE = process.argv[2] === "live" ? process.env.STRIPE_TEST_SECRET_KEY : undefined;
if (process.argv[2] === "live" && !/^(sk|rk)_test_/.test(LIVE ?? "")) {
  throw new Error("live mode needs a Stripe test-mode key in STRIPE_TEST_SECRET_KEY");
}
const NETWORK_ID = "profile_test";

const control = {
  /** succeed | decline | unusable-token | lose-first-response */
  charge: "succeed",
  lostChargeResponses: 0,
  /** While false, the charge's balance transaction has no fee yet, so a card drain stays pending. */
  feeSettled: true,
  /** Paid fund requests whose response the front forwards to the DVM and then drops. */
  dropPaidResponses: 0,
};
const calls = [];
const intents = new Map();
const intentByKey = new Map();
const refunds = new Map();
const refundByKey = new Map();
const jobs = [];

/** Stripe's US card fee on a charge of `amount` cents: 2.9% + 30 cents. */
const cardFee = (amount) => Math.round(amount * 0.029) + 30;

const stripeFetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  const key = headers.get("Idempotency-Key");
  const body = new URLSearchParams(init?.body ?? "");
  const path = url.pathname;
  calls.push({ method, path, key, spt: body.get("shared_payment_granted_token") ?? body.get("payment_method_data[shared_payment_granted_token]") ?? null });

  if (method === "POST" && path === "/v1/payment_intents") {
    if (control.charge === "decline") {
      return Response.json(
        { error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds." } },
        { status: 402 }
      );
    }
    if (control.charge === "unusable-token") {
      return Response.json(
        { error: { type: "invalid_request_error", code: "resource_missing", message: "No such shared payment token." } },
        { status: 400 }
      );
    }
    const idem = key ?? `anon-${calls.length}`;
    const replayed = intentByKey.has(idem);
    if (!replayed) {
      const id = `pi_test_${intents.size + 1}`;
      intents.set(id, { id, amount: Number(body.get("amount")), currency: body.get("currency") ?? "usd", refunded: 0, created: Math.floor(Date.now() / 1000), metadata: {} });
      intentByKey.set(idem, id);
    }
    if (control.lostChargeResponses > 0) {
      control.lostChargeResponses -= 1;
      throw new TypeError("fetch failed: socket hang up");
    }
    const intent = intents.get(intentByKey.get(idem));
    return Response.json(
      { id: intent.id, status: "succeeded", amount: intent.amount, currency: intent.currency },
      { headers: replayed ? { "idempotent-replayed": "true" } : {} }
    );
  }
  if (method === "GET" && path === "/v1/payment_intents/search") {
    return Response.json({ data: [] });
  }
  const intentMatch = /^\/v1\/payment_intents\/([^/]+)$/.exec(path);
  if (method === "GET" && intentMatch) {
    const intent = intents.get(intentMatch[1]);
    if (!intent) return missing();
    return Response.json({
      id: intent.id,
      status: "succeeded",
      amount: intent.amount,
      currency: intent.currency,
      created: intent.created,
      metadata: intent.metadata,
      latest_charge: {
        amount_refunded: intent.refunded,
        disputed: false,
        balance_transaction: control.feeSettled
          ? { amount: intent.amount, fee: cardFee(intent.amount), currency: "usd" }
          : null,
      },
    });
  }
  if (method === "POST" && path === "/v1/refunds") {
    const idem = key ?? `anon-${calls.length}`;
    const known = refundByKey.get(idem);
    if (known) return Response.json(refunds.get(known));
    const intent = intents.get(body.get("payment_intent") ?? "");
    if (!intent) return missing();
    const amount = Number(body.get("amount"));
    const refund = { object: "refund", id: `re_test_${refunds.size + 1}`, payment_intent: intent.id, amount, status: "succeeded", metadata: {} };
    refunds.set(refund.id, refund);
    refundByKey.set(idem, refund.id);
    intent.refunded += amount;
    return Response.json(refund);
  }
  if (method === "GET" && path === "/v1/refunds") {
    const pi = url.searchParams.get("payment_intent");
    return Response.json({ data: [...refunds.values()].filter((r) => r.payment_intent === pi), has_more: false });
  }
  const refundMatch = /^\/v1\/refunds\/([^/]+)$/.exec(path);
  if (method === "GET" && refundMatch) {
    const refund = refunds.get(refundMatch[1]);
    return refund ? Response.json(refund) : missing();
  }
  if (method === "GET" && path === "/v1/disputes") {
    return Response.json({ data: [], has_more: false });
  }
  return missing();
};

function missing() {
  return Response.json({ error: { type: "invalid_request_error", code: "resource_missing" } }, { status: 404 });
}

const input = z.object({ pubkey: z.string(), signature: z.string(), timestamp: z.number(), nonce: z.string() }).passthrough();
const descriptor = configureDVM({
  name: "Card credit contract",
  capability: "run",
  input,
  auth: secp256k1Auth({ replayStore: null }),
  price: "$0.10",
  credit: { min: "$0.10", max: "$20.00" },
  onJob(ctx) {
    jobs.push({ pubkey: ctx.auth?.pubkey });
    ctx.complete("done");
  },
});
// A priced job needs a payment method on the job surface before it can be
// drawn from credit; the SDK builds that MPP handle in a module its exports
// map does not publish, so it is loaded from the installed package by name.
const sdkDist = dirname(fileURLToPath(import.meta.resolve("@dvmkit/sdk/server")));
const mppSetupFile = readdirSync(join(sdkDist, "..")).find((name) => /^mpp-setup-.*\.js$/.test(name));
if (!mppSetupFile) throw new Error("The installed @dvmkit/sdk no longer ships mpp-setup; update this fixture.");
const { createMppFromOpts } = await import(pathToFileURL(join(sdkDist, "..", mppSetupFile)).href);
const ledger = new MemoryCreditLedger();
const sdk = await createDVMServer(descriptor, {
  env: {},
  store: new MemoryKVStore(),
  dvmId: "card-credit-contract",
  devMode: true,
  creditLedger: ledger,
  mpp: createMppFromOpts(
    { tempoRecipient: "0x1111111111111111111111111111111111111111" },
    { DVMKIT_TEMPO_SECRET_KEY: HMAC }
  ),
  fxFetcher: {
    fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: new Date().toISOString() }),
    supportedCurrencies: () => ["usd"],
  },
  // `live` runs the same DVM against Stripe test mode; the key arrives in the
  // environment only and is never echoed.
  stripeCredit: LIVE
    ? createStripeCreditRail({ secretKey: LIVE, networkId: "internal", hmacSecret: HMAC })
    : createStripeCreditRail({
        secretKey: "sk_test_fake",
        networkId: NETWORK_ID,
        hmacSecret: HMAC,
        apiBase: "https://stripe.invalid",
        fetch: stripeFetch,
      }),
});

const server = createServer(async (incoming, outgoing) => {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  const paid = incoming.method === "POST" && incoming.url === "/v1/credit" && typeof incoming.headers.authorization === "string";
  const response = await sdk.app.fetch(
    new Request(`http://127.0.0.1${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    })
  );
  if (paid && control.dropPaidResponses > 0) {
    // The DVM has charged and booked; the caller never hears about it.
    control.dropPaidResponses -= 1;
    incoming.socket.destroy();
    return;
  }
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Card credit server did not bind TCP");

process.on("message", async (message) => {
  if (message?.type === "control") {
    Object.assign(control, message.control);
    process.send({ type: "ok" });
  } else if (message?.type === "snapshot") {
    const credits = {};
    for (const creditId of message.creditIds ?? []) {
      const credit = await ledger.get(creditId);
      credits[creditId] = credit ? { balanceMicro: credit.balanceMicro, status: credit.status, rail: credit.rail } : null;
    }
    process.send({
      type: "snapshot",
      chargeAttempts: calls.filter((c) => c.method === "POST" && c.path === "/v1/payment_intents").length,
      intents: [...intents.values()].map((i) => ({ id: i.id, amount: i.amount, refunded: i.refunded })),
      refundCreates: calls.filter((c) => c.method === "POST" && c.path === "/v1/refunds").length,
      jobs: jobs.length,
      credits,
    });
  } else if (message?.type === "shutdown") {
    server.closeAllConnections();
    await new Promise((done) => server.close(() => done()));
    await sdk.shutdown();
    process.disconnect();
  }
});
process.send({ type: "ready", endpoint: `http://127.0.0.1:${address.port}`, networkId: LIVE ? "internal" : NETWORK_ID });
