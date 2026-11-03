import { describe, expect, it } from "vitest";
import type { JobReceipt, Message } from "@dvmkit/sdk/internal";
import type { JobRecord } from "../src/lib/job-store";
import { pieceSettlement } from "../src/lib/piece-settlement";

// Upfront piece $0.16; the first ask ($0.20) is paid; the second ask ($0.30) is open.
const UPFRONT = 160_000;
const askOne: Message = { seq: 1, from: "provider", timestamp: 1, type: "payment-request",
  content: { amount_msats: 200_000, reason: "Block 2", credit: { amount_micro: 200_000, currency: "usd" }, charged_if_declined_micro: 160_000 } };
const payOne: Message = { seq: 2, from: "requester", timestamp: 1, type: "payment",
  content: { credit: { amount_micro: 200_000, currency: "usd", request_seq: 1 } } as never };
const askTwo = (declined = 360_000): Message => ({ seq: 3, from: "provider", timestamp: 1, type: "payment-request",
  content: { amount_msats: 300_000, reason: "Block 3", credit: { amount_micro: 300_000, currency: "usd" }, charged_if_declined_micro: declined } });
const declinedAt = (seq: number): Message => ({ seq, from: "requester", timestamp: 1, type: "decline", content: {} });
const completedAt = (seq: number): Message => ({ seq, from: "provider", timestamp: 1, type: "complete", content: { summary: "Done" } });
const callerCancel = (seq: number): Message => ({ seq, from: "requester", timestamp: 1, type: "cancel", content: {} });
const ended = (seq: number): Message => ({ seq, from: "provider", timestamp: 1, type: "cancel", content: { reason: "Provider failed" } });

const job = (extra: Partial<JobRecord> = {}): JobRecord => ({ id: "job", endpoint: "https://provider.example", status: "cancelled",
  submittedAt: 1, upfrontPayment: { amount_msats: 160_000, amount_micro: UPFRONT, currency: "usd" }, ...extra });
const piece = (paid_seq: number, amount: number, state: "finished" | "stopped" | "released" | "running", charged = state === "released" ? 0 : amount) =>
  ({ amount, charged, paid_seq, state });
const receipt = (outcome: JobReceipt["outcome"], charged: number, pieces: ReturnType<typeof piece>[]) => ({
  outcome, settlement: { held: Math.max(charged, 360_000), charged, released: Math.max(charged, 360_000) - charged, pieces },
} as unknown as JobReceipt);
const honest = [piece(0, UPFRONT, "finished"), piece(2, 200_000, "finished")];
// A third piece "bought" at seq 5, which this CLI never paid.
const invented = [piece(0, UPFRONT, "finished"), piece(2, 200_000, "finished"), piece(5, 300_000, "finished")];

describe("piece settlement ceiling", () => {
  it.each([
    { name: "a completed job charging every paid piece", outcome: "completed", charged: 360_000, pieces: honest,
      messages: [askOne, payOne], record: job(), ceiling: 360_000, overcharged: false },
    { name: "a completed job charging more than was paid", outcome: "completed", charged: 360_001, pieces: honest,
      messages: [askOne, payOne], record: job(), ceiling: 360_000, overcharged: true },
    { name: "a decline at the open ask", outcome: "cancelled", charged: 360_000, pieces: honest,
      messages: [askOne, payOne, askTwo()], record: job({ callerCancelled: true, callerDeclined: true }), ceiling: 360_000, overcharged: false },
    { name: "a decline charging above the ask's own stated cost", outcome: "cancelled", charged: 360_000, pieces: honest,
      messages: [askOne, payOne, askTwo(100_000)], record: job({ callerCancelled: true, callerDeclined: true }), ceiling: 100_000, overcharged: true },
    { name: "a failure with the paid piece released", outcome: "failed", charged: 160_000,
      pieces: [piece(0, UPFRONT, "finished"), piece(2, 200_000, "released")],
      messages: [askOne, payOne], record: job(), ceiling: 160_000, overcharged: false },
    { name: "a failure charging the piece in progress, with the whole log seen", outcome: "failed", charged: 360_000, pieces: honest,
      messages: [askOne, payOne, ended(3)], record: job(), ceiling: 160_000, overcharged: true },
    { name: "a failure charging the paid piece, with the log incomplete", outcome: "failed", charged: 360_000, pieces: honest,
      messages: [askOne, payOne], record: job(), ceiling: 360_000, overcharged: false },
    { name: "this caller's cancel charging the stopped piece", outcome: "cancelled", charged: 360_000,
      pieces: [piece(0, UPFRONT, "finished"), piece(2, 200_000, "stopped")],
      messages: [askOne, payOne], record: job({ callerCancelled: true }), ceiling: 360_000, overcharged: false },
    { name: "a failure before any ask, with the whole log seen", outcome: "failed", charged: 160_000,
      pieces: [piece(0, UPFRONT, "finished")], messages: [ended(1)], record: job(), ceiling: 0, overcharged: true },
    { name: "a failure before any ask, with no log", outcome: "failed", charged: 160_000,
      pieces: [piece(0, UPFRONT, "finished")], messages: [], record: job(), ceiling: 160_000, overcharged: false },
    { name: "a charge its own pieces do not add up to", outcome: "completed", charged: 360_000,
      pieces: [piece(0, UPFRONT, "finished"), piece(2, 200_000, "finished", 140_000)],
      messages: [askOne, payOne], record: job(), ceiling: 300_000, overcharged: true },
    { name: "a completed job whose payment echo never reached the log", outcome: "completed", charged: 360_000, pieces: honest,
      messages: [askOne], record: job(), ceiling: 360_000, overcharged: false },
    { name: "a completed job with an empty log", outcome: "completed", charged: 360_000, pieces: honest,
      messages: [], record: job(), ceiling: 360_000, overcharged: false },
    { name: "this caller's cancel whose payment echo never reached the log", outcome: "cancelled", charged: 360_000,
      pieces: [piece(0, UPFRONT, "finished"), piece(2, 200_000, "stopped")],
      messages: [askOne], record: job({ callerCancelled: true }), ceiling: 360_000, overcharged: false },
    { name: "this caller's cancel with an empty log", outcome: "cancelled", charged: 360_000,
      pieces: [piece(0, UPFRONT, "finished"), piece(2, 200_000, "stopped")],
      messages: [], record: job({ callerCancelled: true }), ceiling: 360_000, overcharged: false },
    { name: "a decline with the whole log, charging an invented piece", outcome: "cancelled", charged: 660_000, pieces: invented,
      messages: [askOne, payOne, askTwo(), declinedAt(4)], record: job({ callerCancelled: true, callerDeclined: true }),
      ceiling: 360_000, basis: "payments", overcharged: true },
    { name: "a decline with a gapped log, charging an invented piece", outcome: "cancelled", charged: 660_000, pieces: invented,
      messages: [askOne, payOne, askTwo()], record: job({ callerCancelled: true, callerDeclined: true }),
      ceiling: 360_000, basis: "declined_ask", overcharged: true },
    { name: "a completed job with the whole log, charging an invented piece", outcome: "completed", charged: 660_000, pieces: invented,
      messages: [askOne, payOne, completedAt(3)], record: job(), ceiling: 360_000, basis: "payments", overcharged: true },
    { name: "a completed job with a gapped log, listing a piece bought at an unlogged seq", outcome: "completed", charged: 660_000,
      pieces: invented, messages: [askOne, payOne], record: job(), ceiling: 660_000, basis: "receipt_pieces", overcharged: false },
    { name: "a decline whose paid ask's echo never reached the log", outcome: "cancelled", charged: 360_000, pieces: honest,
      messages: [askOne], record: job({ callerCancelled: true, callerDeclined: true, paidPaymentRequestSeqs: [1] }),
      ceiling: 360_000, overcharged: false },
    { name: "a failure after asks the record paid but the log never received", outcome: "failed", charged: 660_000, pieces: invented,
      messages: [askOne, payOne], record: job({ paidPaymentRequestSeqs: [1, 3, 5] }),
      ceiling: 660_000, basis: "receipt_pieces", overcharged: false },
    { name: "an override cancel the signed receipt attributes to the caller", outcome: "cancelled", charged: 360_000,
      pieces: [piece(0, UPFRONT, "finished"), piece(2, 200_000, "stopped")], endedBy: "caller",
      messages: [askOne, payOne, callerCancel(3)], record: job(), ceiling: 360_000, overcharged: false },
    { name: "a decline the signed receipt attributes to the caller", outcome: "cancelled", charged: 360_000, pieces: honest, endedBy: "caller",
      messages: [askOne, payOne, askTwo(100_000)], record: job({ callerCancelled: true, callerDeclined: true }),
      ceiling: 100_000, overcharged: true },
    { name: "an upfront price not recorded locally", outcome: "completed", charged: 360_000, pieces: honest,
      messages: [askOne, payOne], record: job({ upfrontPayment: undefined }), ceiling: 360_000, overcharged: false },
  ] as const)("$name", (row) => {
    const { outcome, charged, pieces, messages, record, ceiling, overcharged } = row;
    const signed = { ...receipt(outcome, charged, [...pieces]), ...("endedBy" in row ? { ended_by: row.endedBy } : {}) } as JobReceipt;
    const result = pieceSettlement(signed, { job: record, messages: [...messages] });
    expect(result).toMatchObject({ charged_micro: charged, currency: "usd", ceiling_micro: ceiling, overcharged,
      ...("basis" in row ? { ceiling_basis: row.basis } : {}) });
    expect(result?.display.includes("This charge exceeds")).toBe(overcharged);
  });

  it("words the flag for the basis that set the ceiling", () => {
    const listed = pieceSettlement(receipt("completed", 360_000, [piece(0, UPFRONT, "finished"), piece(2, 200_000, "finished", 140_000)]),
      { job: job(), messages: [] });
    expect(listed).toMatchObject({ ceiling_basis: "receipt_pieces", overcharged: true });
    expect(listed?.display).toContain("This charge exceeds what the receipt's own pieces add up to ($0.30 USD).");
    const paid = pieceSettlement(receipt("cancelled", 360_000, honest),
      { job: job({ callerCancelled: true, callerDeclined: true }), messages: [askOne, payOne, askTwo(100_000)] });
    expect(paid).toMatchObject({ ceiling_basis: "payments", overcharged: true });
    expect(paid?.display).toContain("This charge exceeds the finished pieces this CLI paid for (at most $0.10 USD).");
  });

  it("states the charge, hold and release in the job's currency", () => {
    const result = pieceSettlement(receipt("cancelled", 160_000, [piece(0, UPFRONT, "finished"), piece(2, 200_000, "released")]),
      { job: job(), messages: [askOne, payOne] });
    expect(result).toMatchObject({ held_micro: 360_000, released_micro: 200_000, stopped_micro: 0,
      display: "Charged $0.16 USD of $0.36 USD held, $0.20 USD released." });
  });

  it("sums only the stopped piece as the work in progress a cancel charged", () => {
    expect(pieceSettlement(receipt("cancelled", 360_000, [piece(0, UPFRONT, "finished"), piece(2, 200_000, "stopped")]),
      { job: job({ callerCancelled: true }), messages: [askOne, payOne] })?.stopped_micro).toBe(200_000);
  });

  it("does not check a price in another currency", () => {
    const eur = { ...payOne, content: { credit: { amount_micro: 200_000, currency: "eur", request_seq: 1 } } } as Message;
    expect(pieceSettlement(receipt("completed", 360_000, honest), { job: job(), messages: [askOne, eur] }))
      .toMatchObject({ ceiling_micro: 360_000, overcharged: false });
  });

  it("checks only the receipt's own pieces when no message log is supplied", () => {
    expect(pieceSettlement(receipt("completed", 360_000, honest), { job: job() }))
      .toMatchObject({ ceiling_micro: 360_000, overcharged: false });
  });

  it("returns nothing for a receipt without a piece settlement", () => {
    expect(pieceSettlement({ outcome: "cancelled" } as JobReceipt, { job: job() })).toBeUndefined();
  });
});
