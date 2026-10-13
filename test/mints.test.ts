import { describe, expect, it } from "vitest";

import { RECOMMENDED_MINTS } from "../src/lib/mints";

describe("RECOMMENDED_MINTS", () => {
  it("lists the platform's curated mints in failover order", () => {
    expect(RECOMMENDED_MINTS.map(({ url }) => url)).toEqual([
      "https://mint.coinos.io",
      "https://mint.lnvoltz.com",
    ]);
  });
  it("excludes the hosted test mint from recommendations", () => {
    expect(RECOMMENDED_MINTS.some((mint) => mint.url.includes("dvmkit-testmint.fly.dev"))).toBe(false);
  });
});
