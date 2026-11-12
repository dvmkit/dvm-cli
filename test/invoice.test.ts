import { bech32 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { invoiceAmountSats, invoiceDestination } from "../src/lib/wallet-agent/invoice";
import { CASH_OUT_INVOICE, EXPIRED_INVOICE, invoiceHeader } from "./support/lightning-invoices";

const NOW = Date.parse("2026-11-12T12:00:00Z");

describe("local invoice payment constraints", () => {
  it("reads the signed fixture amount and explicit expiry independently of the mint", () => {
    expect(invoiceAmountSats(CASH_OUT_INVOICE, NOW)).toBe(60);
    expect(invoiceAmountSats(EXPIRED_INVOICE, 1496314658_000)).toBe(250000);
    expect(() => invoiceAmountSats(EXPIRED_INVOICE, 1496314658_001)).toThrow("60 seconds");
    expect(() => invoiceAmountSats(EXPIRED_INVOICE, 1496314718_000)).toThrow("expired");
  });

  it("uses the default one-hour expiry when no expiry tag is present", () => {
    const decoded = bech32.decode(CASH_OUT_INVOICE as `${string}1${string}`, false);
    // Fixture layout: timestamp (7), payment hash (55), description (29), expiry (8).
    const withoutExpiry = bech32.encode(decoded.prefix, [...decoded.words.slice(0, 91), ...decoded.words.slice(99)], false);
    expect(invoiceAmountSats(withoutExpiry, 1790003540_000)).toBe(60);
    expect(() => invoiceAmountSats(withoutExpiry, 1790003599_000)).toThrow("60 seconds");
    expect(() => invoiceAmountSats(withoutExpiry, 1790003600_000)).toThrow("expired");
  });

  it("requires at least 60 seconds of remaining invoice life", () => {
    expect(invoiceAmountSats(CASH_OUT_INVOICE, 1821535940_000)).toBe(60);
    expect(() => invoiceAmountSats(CASH_OUT_INVOICE, 1821535940_001)).toThrow("60 seconds");
  });

  it("validates the checksum before trusting payment constraints", () => {
    const corrupt = CASH_OUT_INVOICE.slice(0, -1) + "q";
    expect(() => invoiceAmountSats(corrupt, NOW)).toThrow("checksum");
  });

  it.each([
    ["lnbc1m", 100000], ["lnbc1u", 100], ["lnbc600n", 60],
    ["lnbc600000p", 60], ["lnbc600010p", 61], ["lnbc1", 100000000],
  ])("converts %s to the sat-denominated quote amount", (header, sats) => {
    expect(invoiceAmountSats(invoiceHeader(header), NOW)).toBe(sats);
  });

  it("rejects sub-millisatoshi amounts", () => {
    expect(() => invoiceAmountSats(invoiceHeader("lnbc1p"), NOW)).toThrow("whole millisatoshis");
  });

  it.each(["lnbcfan@example.com", "lntbot@example.com", "lnbc600n1invoice", "lnbc600n", "lnurl1destination"])("leaves %s on the address/LNURL path", (destination) => {
    expect(invoiceDestination(destination)).toBeUndefined();
  });
});
