import { describe, expect, it } from "vitest";

import { DvmError } from "@dvmkit/sdk/internal";
import { extractBuilderHandle, reservedForMarker } from "../builder-handle";

describe("extractBuilderHandle", () => {
  it("returns the hostname for a typical DVM endpoint", () => {
    expect(extractBuilderHandle("https://scrape.dvmkit.ai")).toBe("scrape.dvmkit.ai");
    expect(extractBuilderHandle("https://scrape.dvmkit.ai/v1/info")).toBe("scrape.dvmkit.ai");
    expect(extractBuilderHandle("https://scrape.dvmkit.ai:8443/v1/info")).toBe("scrape.dvmkit.ai");
  });

  it("lowercases the hostname so the marker is case-stable", () => {
    expect(extractBuilderHandle("https://SCRAPE.DVMKit.AI")).toBe("scrape.dvmkit.ai");
  });

  it("throws DvmError on a malformed URL", () => {
    expect(() => extractBuilderHandle("not-a-url")).toThrow(DvmError);
  });
});

describe("reservedForMarker", () => {
  it("prefixes the handle with the builder/ scope", () => {
    expect(reservedForMarker("scrape.dvmkit.ai")).toBe("builder/scrape.dvmkit.ai");
  });
});
