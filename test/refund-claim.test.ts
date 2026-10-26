import { expect, it, vi } from "vitest";
import type { Message } from "@dvmkit/sdk/internal";
import { claimInboundPayments, refundJsonField, refundNextAction } from "../src/lib/refund-claim";

const receive = vi.hoisted(() => vi.fn());
vi.mock("@dvmkit/sdk/internal", async (original) => ({
  ...await original<typeof import("@dvmkit/sdk/internal")>(),
  receiveToAgentWallet: receive,
  fetchBtcUsdRate: async () => 100_000,
}));

it.each([true, false])("redeems the original refund token and marks output copies (claimed=%s)", async (claimed) => {
  receive.mockReset();
  if (claimed) receive.mockResolvedValue({ claimedSats: 2 });
  else receive.mockRejectedValue(new Error("Mint unavailable"));
  const token = "cashu-recovery-token";
  const messages = [{ seq: 1, from: "provider", timestamp: 1, type: "payment",
    content: { amount_msats: 3000, cashu_token: token, mint: "https://mint.invalid", reason: "refund" } }] as Message[];
  const claims = await claimInboundPayments("refund", messages);
  expect(receive).toHaveBeenCalledExactlyOnceWith(token);
  expect(claims[0]).toMatchObject({ claimed, cashu_token: token, amount_msats: claimed ? 2000 : 3000 });
  const output = await refundJsonField(claims);
  expect(output.refund).toMatchObject({ cashu_token: token, claimed,
    _provider_fields: expect.arrayContaining(["cashu_token", "mint", "reason"]) });
  const action = refundNextAction("refund", claims);
  expect(action).toMatchObject({ claimed, _provider_fields: expect.arrayContaining(["reason"]) });
  if (!claimed) expect(action).toMatchObject({ cashu_token: token, _provider_fields: expect.arrayContaining(["cashu_token"]) });
});
