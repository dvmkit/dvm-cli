import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveIdentityFromPrivkey, DvmError } from "@dvmkit/sdk/internal";

const seams = vi.hoisted(() => ({ describe: vi.fn() }));
// The provider answers `/v1/info` once; every later read fails, so no credit menu is known.
vi.mock("../src/lib/transport", () => ({
  createDvmTransport: () => new Proxy({ describe: seams.describe, close: () => undefined }, {
    get: (target, key) => key in target ? target[key as keyof typeof target]
      : () => Promise.reject(new Error("network unreachable")),
  }),
}));

import { buildCreditSuggestion } from "../src/lib/credit-notice";
import { runCreditFund } from "../src/lib/credit/funding";

const dvm = "http://127.0.0.1:1";

/** Split a printed command the way a POSIX shell does for plain words and single-quoted words. */
function shellWords(command: string): string[] {
  return [...command.matchAll(/'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2]);
}

async function runPrinted(command: string): Promise<unknown> {
  const [bin, group, verb, target, ...rest] = shellWords(command);
  expect([bin, group, verb]).toEqual(["dvm", "credit", "fund"]);
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    expect(rest[i]).toMatch(/^--[a-z-]+$/);
    opts[rest[i].slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = rest[i + 1];
  }
  return runCreditFund(target, opts).then(() => undefined, (error: unknown) => error);
}

describe("credit suggestion fund command", () => {
  beforeEach(() => {
    vi.stubEnv("DVM_IDENTITY_KEY", deriveIdentityFromPrivkey("01".repeat(32)).privkey);
    seams.describe.mockReset()
      .mockResolvedValueOnce({ name: "Provider", capabilities: {} })
      .mockRejectedValue(new Error("network unreachable"));
  });
  afterEach(() => vi.unstubAllEnvs());

  // A DVM minimum can size an open off the cent grid; the cent-rounded display would print $0.25, below the minimum.
  it.each([[500_000, "$0.50"], [254_000, "$0.254"]])(
    "names the exact suggested amount on first contact, so the printed command passes argument checks (%i micro)",
    async (fundMicro, amount) => {
      const suggestion = buildCreditSuggestion({
        dvm, endpoint: dvm, posture: "suggest", postureSource: "default",
        suppressed: { reason: "open", fundMicro, targetMicro: 2_000_000, currency: "USD" },
      });
      const error = await runPrinted(suggestion.fund_command);
      expect(error).toBeInstanceOf(DvmError);
      expect(error).not.toMatchObject({ code: "invalid_argument" });
      // Past the argument checks, this empty sandbox has no wallet to pay from.
      expect(error).toMatchObject({ code: "credit_funding_unavailable" });
      expect(suggestion.fund_command).toBe(`dvm credit fund ${dvm} --amount '${amount}'`);
      expect(suggestion.hint).toContain(suggestion.fund_command);
    });
});
