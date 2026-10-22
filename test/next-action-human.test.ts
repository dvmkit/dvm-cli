import { describe, expect, it, vi } from "vitest";
import { info } from "../src/lib/output";
import { nextActionHuman, printNextActionHuman } from "../src/lib/next-action-human";
import { pollNextAction } from "../src/lib/next-action";
import { refundNextAction, type RefundClaim } from "../src/lib/refund-claim";

const claim: RefundClaim = {
  seq: 1,
  reason: "refund",
  amount_msats: 1000,
  claimed: false,
  cashu_token: "recoverable-token",
};

vi.mock("../src/lib/output", () => ({ info: vi.fn() }));

describe("human next actions", () => {
  it("renders the default poll hint once with a separate watching command", () => {
    expect(nextActionHuman(pollNextAction("watch"))).toBe(
      "Next: Provider is still working. Keep watching with `dvm messages watch`."
    );
  });

  it("preserves the paid-timeout hint in the poll instruction", () => {
    const hint = "Payment sent but the result stream timed out. The job is still running — check back with 'dvm status'.";
    expect(nextActionHuman(pollNextAction("watch", hint))).toContain(hint);
  });

  it.each([false, true])("prints recovery once for terminal=%s", (terminal) => {
    printNextActionHuman(refundNextAction("recover", [claim]), { refunds: [claim], terminal });
    const output = vi.mocked(info).mock.calls.map(([text]) => text).join("");
    expect(output.match(/could not be auto-claimed/g)).toHaveLength(1);
    expect(output).toContain("dvm wallet receive-token recoverable-token");
    expect(output.includes("Next:")).toBe(!terminal);
  });

  it("reports claimed refunds once without a next instruction", () => {
    const claimed = { ...claim, claimed: true };
    printNextActionHuman(refundNextAction("recover", [claimed]), { refunds: [claimed] });
    const output = vi.mocked(info).mock.calls.map(([text]) => text).join("");
    expect(output.match(/Claimed refund/g)).toHaveLength(1);
    expect(output).not.toContain("Next:");
  });
});
