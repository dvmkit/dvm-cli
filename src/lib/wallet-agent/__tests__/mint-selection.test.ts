import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()),
  checkMintHealth: vi.fn(),
}));
import { checkMintHealth, type MintHealthCheckResult } from "@dvmkit/sdk/internal";
import { resolveFundMint } from "../mint-selection";

const first = "https://mint-a.invalid";
const second = "https://mint-b.invalid";
function health(overrides: Partial<MintHealthCheckResult> = {}): MintHealthCheckResult {
  return { ok: true, mintUrl: first, mintingEnabled: true, mintAmountBounds: { minSats: 1, maxSats: 100 }, ...overrides } as MintHealthCheckResult;
}
beforeEach(() => vi.mocked(checkMintHealth).mockReset());

it("selects the next configured mint for amount bounds with one fresh probe per mint", async () => {
  vi.mocked(checkMintHealth).mockResolvedValueOnce(health()).mockResolvedValueOnce(health({ mintAmountBounds: { minSats: 1, maxSats: 1000 } }));
  const selected = await resolveFundMint({ preferred: first, explicit: false, configured: [first, second], sats: 200 });
  expect(selected).toMatchObject({ url: second, fallbackKind: "bounds", fallback: { preferred: first, selected: second, reason: "amount_above_max" } });
  expect(vi.mocked(checkMintHealth).mock.calls).toEqual([
    [first, { retries: 1, backoffMs: [0] }], [second, { retries: 1, backoffMs: [0] }],
  ]);
});

it("refuses an unreachable explicit mint instead of silently spending at a healthy alternative", async () => {
  vi.mocked(checkMintHealth).mockResolvedValueOnce(health({ ok: false, error: { code: "network", message: "offline" } })).mockResolvedValueOnce(health());
  await expect(resolveFundMint({ preferred: first, explicit: true, configured: [first, second], sats: 50 })).rejects.toMatchObject({ code: "mint_unhealthy", hint: expect.stringContaining(second) });
});

it("reports amount limits separately from unavailable mints without opening a funding quote", async () => {
  vi.mocked(checkMintHealth).mockResolvedValueOnce(health()).mockResolvedValueOnce(health({ ok: false, error: { code: "network", message: "offline" } }));
  await expect(resolveFundMint({ preferred: first, explicit: false, configured: [first, second], sats: 200 })).rejects.toMatchObject({
    code: "mint_amount_out_of_range", data: { amount_sats: 200,
      mint_bounds: [{ mint: first, min_sats: 1, max_sats: 100 }],
      unavailable_mints: [{ mint: second, reason: "network" }],
    },
  });
});
