import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildProgram } from "../src/cli/dvm";

const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")
) as { version: string };

describe("isolated caller program", () => {
  it("builds the caller command tree without private CLI entries", () => {
    const commands = buildProgram().commands.map((command) => command.name());
    expect(commands).toEqual(expect.arrayContaining(["init", "request", "wallet", "credit"]));
    expect(commands.filter((name) => ["deploy", "admin", "serve"].includes(name))).toEqual([]);
  });

  it("reads its version from the caller package manifest", () => {
    expect(buildProgram().version()).toBe(manifest.version);
  });

  it("exposes request output and local correlation controls", () => {
    const program = buildProgram();
    const request = program.commands.find((command) => command.name() === "request");
    expect(request?.options.some((option) => option.long === "--human")).toBe(true);
    expect(request?.options.some((option) => option.long === "--local-correlation-id")).toBe(
      true
    );
  });

  it("lets a pending payment be forced onto one rail", () => {
    const program = buildProgram();
    const pay = program.commands.find((command) => command.name() === "pay");
    expect(pay?.options.some((option) => option.long === "--rail")).toBe(true);
    expect(
      pay?.options.some((option) => option.long === "--max-cashu-principal-sats")
    ).toBe(true);
  });

  it("exposes Tempo network selection on wallet connect", () => {
    const program = buildProgram();
    const wallet = program.commands.find((command) => command.name() === "wallet");
    const connect = wallet?.commands.find((command) => command.name() === "tempo-connect");
    expect(connect?.options.some((option) => option.long === "--network")).toBe(true);
  });

  it("exposes a scoped credit-posture clear without requiring a replacement value", () => {
    const program = buildProgram();
    const credit = program.commands.find((command) => command.name() === "credit");
    const posture = credit?.commands.find((command) => command.name() === "posture");

    expect(posture?.registeredArguments[0]?.required).toBe(false);
    expect(posture?.options.some((option) => option.long === "--clear")).toBe(true);
    expect(posture?.options.some((option) => option.long === "--dvm")).toBe(true);
  });
});
