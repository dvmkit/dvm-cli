import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { attestedDvm, unsignedReceipt } from "../../src/lib/__tests__/fixtures/receipt-fixture";

const binary = process.env.DVM_CLI_TEST_BINARY ?? resolve(import.meta.dirname, "../../dist/dvm.js");
const roots: string[] = [];
const endpoint = "https://provider.example";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A credit-backed piece job: the receipt states $2.06 charged of $2.50 held,
// in micro-units of a currency it never names.
function seed(localJob: boolean) {
  const root = mkdtempSync(join(tmpdir(), "receipt-amounts-"));
  roots.push(root);
  const dvm = attestedDvm();
  const receipt = dvm.sign({ job_id: "piece-job", outcome: "completed",
    paid: { ...unsignedReceipt().paid, msats: 2_500_000, rail: null, mint: null },
    credit: { credit_id: "credit-1", draw_id: "draw-1", amount: 2_060_000, balance_after: 940_000, ledger_seq: 3 },
    settlement: { held: 2_500_000, charged: 2_060_000, released: 440_000, pieces: [
      { amount: 1_000_000, charged: 1_000_000, paid_seq: 0, state: "finished" },
      { amount: 1_500_000, charged: 1_060_000, paid_seq: 2, state: "finished" },
    ] } } as never);
  writeFileSync(join(root, "receipts.jsonl"), JSON.stringify({ receipt, builder: dvm.anchor,
    endpoint, verification: "verified", verified_at: 1 }) + "\n");
  if (localJob) {
    writeFileSync(join(root, "jobs.json"), JSON.stringify([{ id: "piece-job", endpoint, status: "completed",
      submittedAt: 1, paymentMethod: "credit", builderAnchor: dvm.anchor }]));
    mkdirSync(join(root, "messages"));
    writeFileSync(join(root, "messages/piece-job.jsonl"), [
      { seq: 1, from: "provider", timestamp: 1, type: "payment-request", content: { amount_msats: 1_500_000,
        reason: "Second block", credit: { amount_micro: 1_500_000, currency: "usd" } } },
      { seq: 2, from: "requester", timestamp: 2, type: "payment", content: { credit: { credit_id: "credit-1",
        draw_id: "draw-1", payment_id: "pay-1", request_seq: 1, amount_micro: 1_500_000, currency: "usd" } } },
      { seq: 3, from: "provider", timestamp: 3, type: "complete", content: { summary: "Done" } },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n");
  }
  return root;
}

function run(root: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    execFile(process.execPath, [binary, "receipts", ...args], {
      env: { ...process.env, DVM_CONFIG_DIR: root }, timeout: 15_000,
    }, (error, stdout, stderr) => done({ code: error ? Number(error.code) || 1 : 0, stdout, stderr }));
  });
}

it("states a credit-backed receipt's charge in dollars from the local job record", async () => {
  const root = seed(true);
  const verified = await run(root, ["verify", "piece-job"]);
  expect(verified.code).toBe(0);
  const output = JSON.parse(verified.stdout);
  expect(output.display).toContain("Charged $2.06 USD for");
  expect(output.settlement).toMatchObject({ currency: "usd", display: expect.stringContaining("Charged $2.06 USD of $2.50 USD held") });
  expect(output.hint).not.toContain("currency");
  const human = await run(root, ["verify", "piece-job", "--human"]);
  expect(human.code).toBe(0);
  expect(human.stderr).toContain("Charged $2.06 USD for");
  const listed = JSON.parse((await run(root, ["list"])).stdout);
  expect(listed.entries[0].display).toContain("Charged $2.06 USD for");
  expect(listed.entries[0]).not.toHaveProperty("hint");
  expect(verified.stdout + human.stderr + JSON.stringify(listed)).not.toContain("micro-units");
});

it("labels the amount and explains why when no local record names the currency", async () => {
  const root = seed(false);
  const verified = await run(root, ["verify", "piece-job"]);
  expect(verified.code).toBe(0);
  const output = JSON.parse(verified.stdout);
  expect(output.display).toContain("Charged 2.06 (currency not recorded) for");
  expect(output.settlement).toMatchObject({ currency: null });
  expect(output.hint).toContain("does not name the currency");
  expect(output.hint).toContain(`dvm describe ${endpoint}`);
  const human = await run(root, ["verify", "piece-job", "--human"]);
  expect(human.stderr).toContain("Charged 2.06 (currency not recorded) for");
  expect(human.stderr).toContain("does not name the currency");
  const listed = JSON.parse((await run(root, ["list"])).stdout);
  expect(listed.entries[0].hint).toContain("does not name the currency");
  expect(verified.stdout + human.stderr + JSON.stringify(listed)).not.toContain("micro-units");
});
