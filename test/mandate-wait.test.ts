import { expect, it } from "vitest";
import { saveJob } from "../src/lib/job-store";
import { mandateWindowAction } from "../src/lib/mandate-wait";
import type { Message } from "@dvmkit/sdk/internal";

const start = 1_000_000;
const job = { id: "waiting", endpoint: "https://provider.example", status: "processing" as const, submittedAt: start,
  mandate: { max_total_micro: 300_000, max_ask_micro: 200_000, expires_at_ms: 2_000_000,
    credit_id: "credit", draw_id: "draw", currency: "usd", signed_data: {} }, mandateAskObservedAtMs: { 1: start } };
const ask = { amount_msats: 200_000, reason: "Next piece", credit: { amount_micro: 200_000, currency: "usd" } };

it("covers the SDK's 10-second recovery grace and 60-second sweep, with ten seconds of settlement margin", () => {
  saveJob(job);
  expect(mandateWindowAction(job.id, ask, 1, [], start + 75_000)).toMatchObject({ type: "poll", retry_at_ms: start + 80_000 });
  expect(mandateWindowAction(job.id, ask, 1, [], start + 80_000)).toBeUndefined();
});

it.each([
  { name: "ask cap", price: { amount_micro: 200_001, currency: "usd" }, now: start },
  { name: "currency", price: { amount_micro: 200_000, currency: "eur" }, now: start },
  { name: "expiry", price: ask.credit, now: 2_000_000 },
])("does not wait for a mandate that must skip due to $name", ({ price, now }) => {
  saveJob(job);
  expect(mandateWindowAction(job.id, { ...ask, credit: price }, 1, [], now)).toBeUndefined();
});

it("does not wait when this draw cannot fit the ask under the standing total", () => {
  saveJob(job);
  const payment = { seq: 2, from: "requester", timestamp: 1000, type: "payment", content: { credit: {
    credit_id: "credit", draw_id: "draw", request_seq: 1, payment_id: "paid", amount_micro: 200_000, currency: "usd",
  } } } as Message;
  expect(mandateWindowAction(job.id, ask, 3, [payment], start)).toBeUndefined();
});
