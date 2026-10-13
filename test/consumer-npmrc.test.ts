import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { consumerNpmrc } from "../scripts/consumer-npmrc.mjs";

const repositoryNpmrc = readFileSync(resolve(import.meta.dirname, "..", ".npmrc"), "utf8");

describe("consumerNpmrc", () => {
  it("hands the consumer the @dvmkit scope line and nothing else", () => {
    const consumer = consumerNpmrc(repositoryNpmrc);
    expect(consumer).toBe("@dvmkit:registry=https://registry.npmjs.org/\n");

  });

  it("drops every other line of a repository file, wherever the scope line sits", () => {
    expect(
      consumerNpmrc("legacy-peer-deps=true\n  @dvmkit:registry=https://registry.example/  \nfund=false\n")
    ).toBe("@dvmkit:registry=https://registry.example/\n");
  });

  it("refuses a repository file that does not pin the scope", () => {
    expect(() => consumerNpmrc("legacy-peer-deps=true\n")).toThrow(/does not pin the @dvmkit scope/);
  });
});
