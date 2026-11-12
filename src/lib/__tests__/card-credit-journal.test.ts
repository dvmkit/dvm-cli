import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import {
  CARD_FUNDINGS_DIR,
  checkoutRetiredSince,
  loadPendingCardFunding,
  recordPendingCardFunding,
  retireCheckoutFunding,
  withCardFundingLock,
  type PendingCheckoutFunding,
} from "../card-credit/journal";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});

const retiredAt = 1_800_000_000_000;
const entry: PendingCheckoutFunding = {
  v: 2, endpoint: "https://example.invalid", callerPubkey: "a".repeat(64),
  creditId: "credit", fundId: "fund", amountMicro: 5_000_000, targetMicro: 5_000_000,
  presentedAt: retiredAt - 1_000,
  checkout: { url: "https://checkout.stripe.com/c/pay/example", expires_at: retiredAt / 1_000 + 3600 },
};
const directory = join(CARD_FUNDINGS_DIR, "retired");

beforeEach(() => {
  rmSync(CARD_FUNDINGS_DIR, { recursive: true, force: true });
  vi.spyOn(Date, "now").mockReturnValue(retiredAt);
});

it("retains a scoped completion fence without extending it on a later replay", async () => {
  expect(recordPendingCardFunding(entry)).toBe(true);
  await retireCheckoutFunding(entry);
  expect(loadPendingCardFunding(entry.endpoint, entry.callerPubkey, entry.creditId)).toBeUndefined();
  expect(JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]), "utf8"))).toEqual({
    endpoint: entry.endpoint, callerPubkey: entry.callerPubkey, creditId: "credit", fundId: "fund", retiredAt,
  });
  await withCardFundingLock(entry, () => {
    expect(checkoutRetiredSince({ ...entry, endpoint: `${entry.endpoint}/` }, retiredAt - 1)?.fundId).toBe("fund");
    expect(checkoutRetiredSince({ ...entry, callerPubkey: "b".repeat(64) }, retiredAt - 1)).toBeUndefined();
    expect(checkoutRetiredSince({ ...entry, endpoint: "https://other.invalid" }, retiredAt - 1)).toBeUndefined();
    expect(checkoutRetiredSince(entry, retiredAt)).toBeUndefined();
  });
  vi.mocked(Date.now).mockReturnValue(retiredAt + 1000);
  await retireCheckoutFunding(entry);
  await withCardFundingLock(entry, () => {
    expect(checkoutRetiredSince(entry, retiredAt - 1)?.retiredAt).toBe(retiredAt);
  });
});

it("keeps the fence until 24 hours and prunes it at the retention boundary", async () => {
  recordPendingCardFunding(entry);
  await retireCheckoutFunding(entry);
  vi.mocked(Date.now).mockReturnValue(retiredAt + 86_399_999);
  await withCardFundingLock(entry, () => expect(checkoutRetiredSince(entry, retiredAt - 1)).toBeDefined());
  vi.mocked(Date.now).mockReturnValue(retiredAt + 86_400_000);
  await withCardFundingLock(entry, () => expect(checkoutRetiredSince(entry, retiredAt - 1)).toBeUndefined());
  expect(readdirSync(directory)).toEqual([]);
});

it("preserves the pending intent when retirement state cannot be read", async () => {
  recordPendingCardFunding(entry);
  writeFileSync(directory, "blocked");
  await expect(retireCheckoutFunding(entry)).rejects.toThrow();
  expect(loadPendingCardFunding(entry.endpoint, entry.callerPubkey, entry.creditId)?.fundId).toBe("fund");
});

it("preserves pending state and releases the scope lock when saving the fence fails", async () => {
  recordPendingCardFunding(entry);
  const failure = Object.assign(new Error("Fence rename failed"), { code: "EIO" });
  vi.mocked(renameSync).mockImplementationOnce((source, target) => {
    expect(dirname(String(target))).toBe(directory);
    expect(JSON.parse(readFileSync(source, "utf8")).fundId).toBe("fund");
    throw failure;
  });
  await expect(retireCheckoutFunding(entry)).rejects.toBe(failure);
  expect(renameSync).toHaveBeenCalledOnce();
  expect(loadPendingCardFunding(entry.endpoint, entry.callerPubkey, entry.creditId)?.fundId).toBe("fund");
  expect(readdirSync(CARD_FUNDINGS_DIR).filter((name) => name.endsWith(".lock"))).toEqual([]);
  await withCardFundingLock(entry, () => {
    expect(loadPendingCardFunding(entry.endpoint, entry.callerPubkey, entry.creditId)?.fundId).toBe("fund");
  });
});
