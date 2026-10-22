import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { attestedDvm, unsignedReceipt } from "../../src/lib/__tests__/fixtures/receipt-fixture";

const binary = resolve(import.meta.dirname, "../../dist/dvm.js");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function seed(overrides: Record<string, unknown> = {}, messages: unknown[] = []) {
  const root = mkdtempSync(join(tmpdir(), "status-spend-"));
  roots.push(root);
  writeFileSync(join(root, "jobs.json"), JSON.stringify([{ id: "bill", endpoint: "https://provider.example",
    status: "completed", submittedAt: 1, completion: { summary: "Done" }, ...overrides }]));
  mkdirSync(join(root, "messages"));
  writeFileSync(join(root, "messages/bill.jsonl"), messages.map((message) => JSON.stringify(message)).join("\n"));
  return root;
}
function run(root: string, flags: string[] = []) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    execFile(process.execPath, [binary, "status", "bill", ...flags], {
      env: { ...process.env, DVM_CONFIG_DIR: root }, timeout: 15_000,
    }, (error, stdout, stderr) => done({ code: error ? Number(error.code) || 1 : 0, stdout, stderr }));
  });
}

it("renders ordered charges, approval provenance, budget, change, and a signed receipt offline", async () => {
  const dvm = attestedDvm();
  const receipt = dvm.sign({ job_id: "bill", paid: { ...unsignedReceipt().paid, msats: 5000 } });
  const messages = Array.from({ length: 5 }, (_, index) => [
    { seq: index * 2 + 1, from: "provider", type: "payment-request", content: {
      amount_msats: 1000, fiat_amount: { amount: 0.02, currency: "usd" }, reason: `Stage ${index + 1}` } },
    { seq: index * 2 + 2, from: "requester", type: "payment", content: { amount_msats: 1000, cashu_token: "redacted" } },
  ]).flat();
  const root = seed({ totalPaidMsats: 5000, paymentsHonoured: 5,
    policy: { maxTotalMsats: 10000, maxPayments: 6 }, receipt, builderAnchor: dvm.anchor,
    paymentApprovals: [1, 3, 5, 7, 9].map((requestSeq) => ({ requestSeq, approval: requestSeq === 9 ? "explicit" : "auto" })),
  }, [...messages.reverse(), { seq: 11, from: "provider", type: "payment", content: { amount_msats: 500, reason: "change" } }]);
  const result = await run(root);
  expect(result.code).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.receipt_verified).toBe("verified");
  expect(output.spend).toMatchObject({ total_msats: 5000, payments: 5, max_payments: 6,
    log_mismatch: false, receipt_mismatch: false, receipt_total_display: "5 sats", budget_display: "$0.20 USD (10 sats)", total_display: "$0.10 USD (5 sats)",
    refunds: [{ seq: 11, amount_msats: 500, reason: { _source: "provider", text: "change" } }] });
  expect(output.spend.charges.map((charge: { seq: number; approval: string }) => [charge.seq, charge.approval]))
    .toEqual([[2, "auto"], [4, "auto"], [6, "auto"], [8, "auto"], [10, "explicit"]]);
  expect(output.spend.charges[4]).toMatchObject({ display: "$0.02 USD (1 sats)", rail: "cashu_p2pk",
    fiat_amount: { amount: 0.02, currency: "usd" }, reason: { _source: "provider", text: "Stage 5" } });
  expect(output.spend.display).toContain("over 5 charges, budget $0.20 USD (10 sats), 1 refund");
  const human = await run(root, ["--human"]);
  expect(human.code).toBe(0);
  expect(human.stderr).toContain(output.spend.display);
  expect(human.stderr).toContain("[2] $0.02 USD (1 sats) (Cashu, paid automatically): Stage 1");
  expect(human.stderr).toContain("[10] $0.02 USD (1 sats) (Cashu, you approved): Stage 5");
  expect(human.stderr).toContain("Receipt total: 5 sats");

  writeFileSync(join(root, "jobs.json"), JSON.stringify([{ id: "bill", endpoint: "https://provider.example",
    status: "completed", submittedAt: 1, completion: {}, totalPaidMsats: 9000, paymentsHonoured: 5, receipt, builderAnchor: dvm.anchor }]));
  const tampered = JSON.parse((await run(root)).stdout);
  expect(tampered.spend).toMatchObject({ total_msats: 9000, total_display: "9 sats",
    receipt_total_display: "5 sats", log_mismatch: true, receipt_mismatch: true });
});

it("labels free jobs and keeps legacy approvals unknown", async () => {
  const free = JSON.parse((await run(seed())).stdout).spend;
  expect(free).toMatchObject({ charges: [], refunds: [], total_msats: 0, payments: 0 });
  expect(free.display).toBe("This job was free.");
  const root = seed({ totalPaidMsats: 1000, paymentsHonoured: 1 }, [
    { seq: 1, from: "requester", type: "payment", content: { amount_msats: 1000, x402_payment: "redacted" } },
  ]);
  const legacy = JSON.parse((await run(root)).stdout).spend;
  expect(legacy).toMatchObject({ total_msats: 1000, payments: 1, log_mismatch: false,
    charges: [{ seq: 1, approval: "unknown", rail: "x402" }] });
});

it("prices a prepaid balance payment from its booked native debit when the ask is missing", async () => {
  const authorization = { payment_id: "accepted", request_seq: 4, amount_micro: 42000, currency: "usd" };
  const root = seed({ totalPaidMsats: 3000, paymentsHonoured: 1,
    bookedCreditPayments: [{ authorization, amountMsats: 3000, request: { amount_msats: 2500, reason: "Compute" } }],
    paymentApprovals: [{ requestSeq: 4, approval: "explicit" }],
  }, [{ seq: 5, from: "requester", type: "payment", content: { credit: authorization } }]);
  const result = await run(root);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).spend).toMatchObject({ total_msats: 3000, log_mismatch: false,
    charges: [{ seq: 5, amount_msats: 3000, display: "$0.04 USD (3 sats)", approval: "explicit", rail: "credit",
      fiat_amount: { amount: 0.042, currency: "usd" }, reason: { _source: "provider", text: "Compute" } }] });
});

it.each([0, 1000])("counts a Cashu upfront payment once with %i msats of conversation charges", async (midJob) => {
  const root = seed({ costMsats: 2000, totalPaidMsats: 2000 + midJob,
    paymentsHonoured: midJob ? 2 : 1, paymentMethod: "cashu" }, midJob ? [
    { seq: 1, from: "provider", type: "payment-request", content: { amount_msats: 1000, reason: "More work" } },
    { seq: 2, from: "requester", type: "payment", content: { amount_msats: 1000, cashu_token: "redacted" } },
  ] : []);
  const result = await run(root);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).spend).toMatchObject({ total_msats: midJob ? 3000 : 2000,
    upfront_display: "2 sats", payments: midJob ? 2 : 1, log_mismatch: false });
});

it.each([0, 1000])("leaves receipt comparison unknown for prepaid credit with %i msats booked", async (total) => {
  const dvm = attestedDvm();
  const receipt = dvm.sign({ job_id: "bill", paid: { ...unsignedReceipt().paid, msats: 5000 } });
  const spend = JSON.parse((await run(seed({ paymentMethod: "credit", totalPaidMsats: total,
    paymentsHonoured: total ? 1 : 0, receipt, builderAnchor: dvm.anchor }))).stdout).spend;
  expect(spend.display).toContain("Paid from prepaid credit");
  expect(spend.display).toContain("amount is not recorded locally");
  expect(spend.display).toContain("receipt total includes the unrecorded credit draw");
  expect(spend.display).not.toMatch(/free|refund|exceeds/);
  expect(spend.receipt_total_display).toBe("5 sats");
  expect(spend).not.toHaveProperty("receipt_mismatch");
  expect(spend).not.toHaveProperty("upfront_display");
});

it.each([4000, 6000])("neutrally compares a signed %i-msat receipt with 5000 msats paid", async (receiptTotal) => {
  const dvm = attestedDvm();
  const receipt = dvm.sign({ job_id: "bill", paid: { ...unsignedReceipt().paid, msats: receiptTotal } });
  const root = seed({ totalPaidMsats: 5000, paymentsHonoured: 1,
    costMsats: 5000, paymentMethod: "cashu", receipt, builderAnchor: dvm.anchor });
  const spend = JSON.parse((await run(root)).stdout).spend;
  expect(spend.receipt_mismatch).toBe(true);
  expect(spend).not.toHaveProperty("receipt_shortfall_display");
  expect(spend.display).toContain(`Receipt total ${receiptTotal / 1000} sats differs from local total 5 sats; mint fees, returned change, or a payment not recorded locally can explain the difference.`);
  expect(spend.display).not.toMatch(/exceeds|disagrees/);
  const human = await run(root, ["--human"]);
  expect(human.code).toBe(0);
  expect(human.stderr).toContain(spend.display);
});
