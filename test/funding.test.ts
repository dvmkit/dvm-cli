import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@dvmkit/sdk/internal")>()) }));
vi.mock("../src/lib/output", async () => ({ ...(await vi.importActual<typeof import("../src/lib/output")>("../src/lib/output")), info: vi.fn(),
json: vi.fn() }));

import { detectWalletType, getFundingGuidance, printFundingGuidance } from "../src/lib/funding";
import { info } from "../src/lib/output";

beforeEach(() => {
  vi.mocked(info).mockClear();
});

describe("detectWalletType", () => {
  it("returns null for null config + no mints", () => {
    expect(detectWalletType(null, [])).toBeNull();
  });

  it("returns null for empty config + no mints", () => {
    expect(detectWalletType({}, [])).toBeNull();
  });

  it("prefers nwc over cashu", () => {
    expect(detectWalletType({ nwcUri: "nostr+walletconnect://x" }, ["https://m"])).toBe("nwc");
  });

  it("returns cashu when only mints are configured", () => {
    expect(detectWalletType({}, ["https://m"])).toBe("cashu");
  });



  it("returns cashu when mints exist but config is null", () => {
    expect(detectWalletType(null, ["https://m"])).toBe("cashu");
  });
});

describe("getFundingGuidance", () => {
  it("returns empty fundingOptions but keeps the advisory when balance is positive", () => {
    const result = getFundingGuidance({ walletType: "nwc", balanceMsats: 1 });
    expect(result.fundingOptions).toEqual([]);
    expect(result.advisory.display).toContain("Start small");
  });

  it("nwc: returns external option only", () => {
    const result = getFundingGuidance({ walletType: "nwc", balanceMsats: 0 });
    expect(result.fundingOptions).toEqual([
      expect.objectContaining({
        method: "external",
        description: expect.stringContaining("Lightning wallet"),
      }),
    ]);
    expect(result.fundingOptions[0].command).toBeUndefined();
  });

  it("cashu with mints: skips cashu-add-mint", () => {
    const result = getFundingGuidance({
      walletType: "cashu",
      balanceMsats: 0,
      cashuMints: ["https://m"],
    });
    const methods = result.fundingOptions.map((o) => o.method);
    expect(methods).not.toContain("cashu-add-mint");
    expect(methods).toContain("cashu-mint");
    expect(methods).toContain("cashu-receive-token");
  });

  it("cashu without mints: prepends cashu-add-mint", () => {
    const result = getFundingGuidance({
      walletType: "cashu",
      balanceMsats: 0,
      cashuMints: [],
    });
    const methods = result.fundingOptions.map((o) => o.method);
    expect(methods[0]).toBe("cashu-add-mint");
    expect(methods).toContain("cashu-mint");
    expect(methods).toContain("cashu-receive-token");
  });

  it("cashu interpolates configured mint into the mint command", () => {
    const result = getFundingGuidance({
      walletType: "cashu",
      balanceMsats: 0,
      cashuMints: ["https://mint.example"],
      hasLightningBackend: true,
    });
    const mintOption = result.fundingOptions.find((o) => o.method === "cashu-mint");
    expect(mintOption?.command).toContain("https://mint.example");
    expect(mintOption?.mints).toEqual(["https://mint.example"]);
  });

  it("cashu without Lightning backend: reorders receive-token first", () => {
    const result = getFundingGuidance({
      walletType: "cashu",
      balanceMsats: 0,
      cashuMints: ["https://m"],
      hasLightningBackend: false,
    });
    const methods = result.fundingOptions.map((o) => o.method);
    expect(methods.indexOf("cashu-receive-token")).toBeLessThan(methods.indexOf("cashu-mint"));
  });

  it("cashu with Lightning backend: cashu-mint first", () => {
    const result = getFundingGuidance({
      walletType: "cashu",
      balanceMsats: 0,
      cashuMints: ["https://m"],
      hasLightningBackend: true,
    });
    const methods = result.fundingOptions.map((o) => o.method);
    expect(methods.indexOf("cashu-mint")).toBeLessThan(methods.indexOf("cashu-receive-token"));
  });

  it("cashu without mints: receive-token claims into the agent wallet (no add-mint prerequisite)", () => {
    const result = getFundingGuidance({
      walletType: "cashu",
      balanceMsats: 0,
      cashuMints: [],
    });
    const receive = result.fundingOptions.find((o) => o.method === "cashu-receive-token");
    expect(receive?.command).toBe("dvm wallet receive-token <cashu-token>");
    expect(receive?.description).toContain("into the agent wallet");
  });

  it("cashu with mints: receive-token description omits the prerequisite", () => {
    const result = getFundingGuidance({
      walletType: "cashu",
      balanceMsats: 0,
      cashuMints: ["https://m"],
    });
    const receive = result.fundingOptions.find((o) => o.method === "cashu-receive-token");
    expect(receive?.description).not.toContain("After adding a mint");
  });

  it("cashu without mints: mint option description also flags the prerequisite", () => {
    const result = getFundingGuidance({
      walletType: "cashu",
      balanceMsats: 0,
      cashuMints: [],
    });
    const mint = result.fundingOptions.find((o) => o.method === "cashu-mint");
    expect(mint?.description).toContain("After adding a mint above");
  });

  it("cashu with mints: mint option description omits the prerequisite", () => {
    const result = getFundingGuidance({
      walletType: "cashu",
      balanceMsats: 0,
      cashuMints: ["https://m"],
    });
    const mint = result.fundingOptions.find((o) => o.method === "cashu-mint");
    expect(mint?.description).not.toContain("After adding a mint");
  });

  it("does not call info() — function is pure", () => {
    getFundingGuidance({ walletType: "nwc", balanceMsats: 0 });
    getFundingGuidance({ walletType: "cashu", balanceMsats: 0, cashuMints: [] });
    expect(info).not.toHaveBeenCalled();
  });
});

describe("printFundingGuidance", () => {
  it("prints numbered options with display, command, and description", () => {
    const result = getFundingGuidance({ walletType: "cashu", balanceMsats: 0, cashuMints: [] });
    printFundingGuidance(result);
    expect(info).toHaveBeenNthCalledWith(1, expect.stringContaining("Start small"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("1. Add a Cashu mint"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("Fund your wallet"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("Cashu mint"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("dvm wallet mint-add"));
  });



  it("prints the advisory but skips the funding header when balance is positive", () => {
    const result = getFundingGuidance({ walletType: "nwc", balanceMsats: 1 });
    printFundingGuidance(result);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("Start small"));
    const calls = vi.mocked(info).mock.calls.flat();
    expect(calls.some((c) => typeof c === "string" && c.includes("Fund your wallet"))).toBe(false);
  });
});

describe("safe funding advisory", () => {
  it("attaches an advisory for nwc wallets", () => {
    const result = getFundingGuidance({ walletType: "nwc", balanceMsats: 0 });
    expect(result.advisory.display).toContain("Start small");
  });

  it("attaches an advisory for cashu wallets", () => {
    const result = getFundingGuidance({
      walletType: "cashu",
      balanceMsats: 0,
      cashuMints: ["https://m"],
    });
    expect(result.advisory.display).toContain("Start small");
  });


});
