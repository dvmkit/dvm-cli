import { expect, it, vi } from "vitest";
import type { PendingSubmission } from "@dvmkit/sdk/internal";
import { recoveredStandingMandate, MANDATE_RECOVERY_DISPLAY } from "../src/lib/mandate-recovery";
import { loadRequestIntent, type RequestIntent } from "../src/lib/request-intent-store";

vi.mock("../src/lib/request-intent-store", async (original) => ({
  ...await original<typeof import("../src/lib/request-intent-store")>(), loadRequestIntent: vi.fn(),
}));
const mandate = { max_total_micro: 300_000, max_ask_micro: 200_000, expires_at_ms: 2_000_000,
  credit_id: "credit", draw_id: "draw", currency: "usd", signed_data: { signature: "original" } };
const data = { request_id: "req-recover", credit_id: "credit", draw_id: "draw",
  mandate: { max_total_micro: 300_000, max_ask_micro: 200_000, expires_at_ms: 2_000_000 } };
const entry: PendingSubmission = { request_id: "cashu-recover", intended_lock_pubkey: "02" + "aa".repeat(32),
  mint: "https://mint.example", amount_sats: 1, output_proofs: [], created_at: "2026-11-17T00:00:00Z", endpoint: "https://provider.example", context: { signing_pubkey: "caller", submit_body: { data } } };
const intent: RequestIntent = { mandate, endpoint: entry.endpoint, callerPubkey: "caller", v: 2,
  requestId: data.request_id, capability: "run", body: { data }, createdAt: 1,
  policy: { maxTotalMsats: 300_000, maxIncrementMsats: 200_000, autoPayBelowMsats: 200_000, maxPayments: 3 },
  authAudience: { dvm_id: "provider", builder_pubkey: "aa".repeat(32) } };

it("keeps a dropped mandate dropped even when the original recovery intent still contains it", () => {
  vi.mocked(loadRequestIntent).mockReturnValue(intent);
  const dropped = { ...entry, context: { ...entry.context!, mandate_unavailable: MANDATE_RECOVERY_DISPLAY,
    submit_body: { data: { request_id: "req-recover", credit_id: "credit", draw_id: "draw" } } } };
  expect(recoveredStandingMandate(dropped)).toEqual({ mandate: undefined, mandateUnavailable: MANDATE_RECOVERY_DISPLAY });
  expect(loadRequestIntent).not.toHaveBeenCalled();
});

it.each([
  { endpoint: "https://another-provider.example" },
  { callerPubkey: "another-caller" },
  { mandate: { ...mandate, draw_id: "another-draw" } },
  { mandate: { ...mandate, max_ask_micro: 1 } },
])("does not restore authority from an intent with a conflicting binding: %j", (change) => {
  vi.mocked(loadRequestIntent).mockReturnValue({ ...intent, ...change });
  expect(recoveredStandingMandate(entry)).toEqual({});
});
