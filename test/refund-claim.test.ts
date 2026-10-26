import { expect, it, vi } from "vitest";
import { saveJob, loadJob } from "../src/lib/job-store";
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


it("retains wallet-confirmed refund amounts when the provider changes a claimed replay", async () => {
  const jobId = "confirmed-refund";
  saveJob({ id: jobId, endpoint: "https://provider.invalid", status: "processing", submittedAt: 1 });
  receive.mockReset().mockResolvedValue({ claimedSats: 2 });
  const payment = { seq: 1, from: "provider", timestamp: 1, type: "payment",
    content: { amount_msats: 3000, cashu_token: "cashu-original-token", reason: "refund" } } as Message;
  await claimInboundPayments(jobId, [payment]);
  expect(loadJob(jobId)?.claimedPaymentSeqs).toEqual([1]);
  const replay = { ...payment, content: { ...payment.content, amount_msats: "changed provider amount" } } as unknown as Message;
  const claims = await claimInboundPayments(jobId, [replay]);
  expect(receive).toHaveBeenCalledExactlyOnceWith("cashu-original-token");
  expect(claims[0].amount_msats).toBe(2000);
  expect(refundNextAction(jobId, claims)).toMatchObject({ amount_msats: 2000,
    _provider_fields: expect.not.arrayContaining(["amount_msats"]) });
  const output = await refundJsonField(claims);
  expect(output.refund.amount).toMatchObject({ msats: 2000 });
  expect(output.refund._provider_fields).not.toContain("amount");
});
