import { describe, expect, it } from "vitest";

import { DvmError } from "@dvmkit/sdk/internal";
import { assertSupportedX402Network, x402NetworkLabel, x402NetworkListForCopy } from "../networks";
import { X402_NETWORKS } from "@dvmkit/sdk/internal";

describe("assertSupportedX402Network", () => {
  it("passes every supported chain", () => {
    for (const network of X402_NETWORKS) {
      expect(() => {
        assertSupportedX402Network(network.caip2);
      }).not.toThrow();
    }
  });

  it("names what it does accept when it rejects", () => {
    try {
      assertSupportedX402Network("eip155:1");
      expect.unreachable("expected an unsupported chain to be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(DvmError);
      const dvmErr = err as DvmError;
      expect(dvmErr.code).toBe("unsupported_network");
      expect(dvmErr.message).toContain("eip155:1");
      // The agent relaying this needs the accepted list, not just a refusal.
      expect(dvmErr.hint).toContain("eip155:8453 (Base)");
      expect(dvmErr.hint).toContain("eip155:137 (Polygon)");
      expect(dvmErr.hint).toContain("dvm wallet x402-network <caip2>");
      expect(dvmErr.hint).not.toContain("--force");
      expect(dvmErr.hint).not.toContain("--key-file");
    }
  });
});

describe("x402NetworkListForCopy", () => {
  it("pairs each chain id with a name a human recognises", () => {
    const list = x402NetworkListForCopy();

    expect(list).toContain("eip155:8453 (Base)");
    expect(list).toContain("eip155:80002 (Polygon Amoy)");
    expect(list.split(", ")).toHaveLength(X402_NETWORKS.length);
  });
});

describe("x402NetworkLabel", () => {
  it("puts the human name before the CAIP-2 id in relayable copy", () => {
    expect(x402NetworkLabel("eip155:84532")).toBe("Base Sepolia (eip155:84532)");
  });

  it("falls back to the raw id for a chain this build does not know", () => {
    expect(x402NetworkLabel("eip155:999999")).toBe("eip155:999999");
  });
});
