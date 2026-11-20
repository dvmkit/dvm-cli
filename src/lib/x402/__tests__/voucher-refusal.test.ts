import type { PendingX402Funding } from "@dvmkit/sdk/internal";
import { describe, expect, it } from "vitest";
import { x402VoucherPendingRefusal } from "../batch-client";

const channelId = `0x${"12".repeat(32)}` as const;
function pending(overrides: Partial<PendingX402Funding> = {}): PendingX402Funding {
  return {
    endpoint: "https://example.com",
    callerPubkey: "ab".repeat(32),
    creditId: "credit-rival",
    fundId: "fund-rival",
    channelId,
    amountMicro: 100_000,
    targetMicro: 200_000,
    paymentHeader: "signed-credential",
    requestedAt: 1_000,
    ...overrides,
  };
}

describe("x402 voucher refusal guidance", () => {
  it("preserves exact live compatibility guidance and caller data overrides", () => {
    const error = x402VoucherPendingRefusal(pending(), { channel_id: "canonical", extra: 1 });
    expect([error.code, error.message, error.hint, error.data]).toEqual([
      "x402_voucher_pending",
      "A signed x402 voucher for credit credit-rival is still waiting for its acknowledgement, so this channel cannot sign another.",
      "Retry that funding ('dvm credit fund https://example.com --credit-id credit-rival'), or retire it with 'dvm wallet x402-clear-pending --credit-id credit-rival' if the DVM is gone.",
      { credit_id: "credit-rival", fund_id: "fund-rival", channel_id: "canonical", extra: 1 },
    ]);
  });

  for (const signed of [true, false]) {
    it(`keeps retired funding identifiers and the ${signed ? "signed" : "fallback"} cutoff in error data`, () => {
      const error = x402VoucherPendingRefusal(pending({ refusedAt: 0, ...(signed ? { authorizationValidBefore: "2000" } : {}) }));
      const until = signed ? "1970-01-01T00:33:20.000Z" : "1970-01-02T00:00:01.000Z";
      expect(error.code).toBe("x402_voucher_pending");
      expect(error.data).toEqual({
        credit_id: "credit-rival", fund_id: "fund-rival", channel_id: channelId, refused: true, funding_blocked_until: until,
      });
    });
  }
});
