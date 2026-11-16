import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { walletReceiveToken } from "../src/commands/wallet-agent-fund";

function stdin(tty = false): PassThrough {
  const stream = new PassThrough();
  Object.assign(stream, { isTTY: tty });
  vi.spyOn(process, "stdin", "get").mockReturnValue(stream as unknown as typeof process.stdin);
  return stream;
}

afterEach(() => vi.useRealTimers());

it.each([undefined, "-"])("rejects empty stdin for token=%s before accessing the wallet", async (token) => {
  stdin().end(" \n\t");
  await expect(walletReceiveToken(token, {})).rejects.toMatchObject({
    code: "no_input", hint: expect.stringContaining("stdin"),
  });
});

it("fails promptly at a terminal instead of waiting for an echoed secret", async () => {
  const stream = stdin(true);
  await expect(walletReceiveToken(undefined, {})).rejects.toMatchObject({ code: "no_input" });
  expect(stream.listenerCount("data")).toBe(0);
});

it("reports an idle pipe as missing input after the shared stdin timeout", async () => {
  vi.useFakeTimers();
  const stream = stdin();
  await Promise.all([
    expect(walletReceiveToken(undefined, {})).rejects.toMatchObject({
      code: "no_input", message: expect.stringContaining("timed out"),
    }),
    vi.advanceTimersByTimeAsync(10_000),
  ]);
  expect(stream.destroyed).toBe(true);
});
