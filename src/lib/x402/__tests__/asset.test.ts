import { describe, expect, it } from "vitest";

import { resolveX402Asset } from "@dvmkit/sdk/internal";
import { x402WrongAssetHint } from "../asset";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const POLYGON_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

/** {@link resolveX402Asset} for the chains the hint cases assume are nameable. */
function mustResolve(network?: string) {
  const asset = resolveX402Asset(network);
  if (!asset) throw new Error(`expected a nameable asset for ${network ?? "the default network"}`);
  return asset;
}

describe("x402WrongAssetHint", () => {
  it("names the accepted contract, the chain, and both remedies", () => {
    const hint = x402WrongAssetHint(mustResolve());

    expect(hint).toContain("native USDC");
    expect(hint).toContain(BASE_USDC);
    expect(hint).toContain("Base");
    // The wrong-token case and the wrong-chain case are both named, and each
    // gets its own remedy — swap, or bridge.
    expect(hint).toContain("USDbC");
    expect(hint).toMatch(/different chain/i);
    expect(hint).toMatch(/swap/i);
    expect(hint).toMatch(/bridge/i);
  });

  it("follows the configured chain instead of hardcoding Base", () => {
    const hint = x402WrongAssetHint(mustResolve("eip155:137"));

    expect(hint).toContain("Polygon");
    expect(hint).toContain(POLYGON_USDC);
    expect(hint).not.toContain("Base");
    // Polygon's own bridged dollar, not Base's — naming USDbC here would be
    // advice to go looking for a token that isn't on this chain.
    expect(hint).toContain("USDC.e");
    expect(hint).not.toContain("USDbC");
  });

  it("still names the failure without a confusable to warn off", () => {
    const hint = x402WrongAssetHint(mustResolve("eip155:84532"));

    expect(hint).toContain("Base Sepolia");
    expect(hint).toMatch(/different contract/i);
    expect(hint).toMatch(/different chain/i);
    // No bridged dollar is tracked for a testnet, so the copy must not trail
    // off into an empty ticker.
    expect(hint).not.toMatch(/USDbC|USDC\.e/);
  });
});
