import { CONFIG_DIR } from "@dvmkit/sdk/internal";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => [] as { fd: number; text: string }[]);
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, writeSync: vi.fn((fd: number, bytes: Uint8Array, offset = 0, length = bytes.length) => {
    if (fd !== 1 && fd !== 2) return actual.writeSync(fd, bytes, offset, length);
    captured.push({ fd, text: Buffer.from(bytes).subarray(offset, offset + length).toString() });
    return length;
  }) };
});
import * as output from "../src/lib/output";
import { handleError } from "../src/lib/error-handler";

const logs = join(CONFIG_DIR, "logs");
const file = join(logs, "internal-errors.jsonl");
const localSource = resolve(import.meta.dirname, "../src/lib/error-handler.ts");
const secret = "c47ea1902fb56d38".repeat(4);

beforeEach(() => {
  rmSync(logs, { force: true, recursive: true });
  captured.length = 0;
  vi.spyOn(output, "json");
  vi.spyOn(output, "info");
  vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
});
afterEach(() => rmSync(logs, { force: true, recursive: true }));

function publish(error: unknown, human = false) {
  expect(() => handleError(error, human, { event: "error" })).toThrow("exit");
  expect(process.exit).toHaveBeenCalledWith(1);
  return (vi.mocked(output.json).mock.calls.at(-1)?.[0] as { error: { code: string; error_site?: string[]; error_log?: string } } | undefined)?.error!;
}

it("names a real throw site while saving foreign text only in a private log", () => {
  function failingDependency() { throw new Error(`private key ${secret}`, { cause: new Error("root detail") }); }
  let failure: Error;
  try { failingDependency(); } catch (err) { failure = err as Error; }
  vi.spyOn(process, "argv", "get").mockReturnValue(["node", "dvm", "messages", secret]);
  const error = publish(failure!);
  expect(error).toMatchObject({ code: "internal", error_name: "Error", error_site: expect.arrayContaining(["failingDependency"]) });
  expect(error.error_site![0]).toBe("failingDependency");
  const publicText = captured.map((write) => write.text).join("");
  expect(JSON.parse(captured.find((write) => write.fd === 1)!.text)).toMatchObject({ event: "error", error });
  expect(captured.some((write) => write.fd === 2)).toBe(false);
  for (let i = 0; i <= secret.length - 8; i++) expect(publicText).not.toContain(secret.slice(i, i + 8));
  const record = JSON.parse(readFileSync(file, "utf8").trim());
  expect(record).toMatchObject({ command: "messages", code: "internal", error_name: "Error", message: failure!.message, stack: failure!.stack, cause: { message: "root detail", stack: expect.any(String) }, version: expect.stringMatching(/^\d+\.\d+\.\d+/), timestamp: expect.any(String) });
  expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
  expect(record).not.toHaveProperty("argv");
  if (process.platform !== "win32") {
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(logs).mode & 0o777).toBe(0o700);
  }
  expect(error.error_log).toBe(file);
});

it("publishes only identifier frames, skips internals and anonymous frames, and caps sites at five", () => {
  const messageFrame = "sk_live_fixtureSecret";
  const failure = new Error(`upstream said:\n    at ${secret} (/source:1:2)\n    at ${messageFrame} (${localSource}:1:2)`);
  failure.stack = `Error: ${failure.message}\n    at async Client.send (${localSource}:2:3)\n    at node:internal/task:1:2\n    at run (node:internal/task:1:2)\n    at /private/anonymous.js:1:2\n    at bad-name (${localSource}:1:2)\n    at call(${secret}) (${localSource}:1:2)\n    at second (${localSource}:1:2)\n    at third (${localSource}:1:2)\n    at fourth (${localSource}:1:2)\n    at fifth (${localSource}:1:2)\n    at sixth (${localSource}:1:2)`;
  expect(publish(failure).error_site).toEqual(["Client.send", "second", "third", "fourth", "fifth"]);
  const publicText = captured.map((write) => write.text).join("");
  expect(publicText).not.toContain(messageFrame);
  for (let i = 0; i <= secret.length - 8; i++) expect(publicText).not.toContain(secret.slice(i, i + 8));
});

it("omits the site when no named stack frames exist", () => {
  const error = new Error("detail");
  error.stack = undefined;
  expect(publish(error)).not.toHaveProperty("error_site");
});

it("prints the site and a separate log pointer in human mode without foreign text", () => {
  const error = new Error(secret);
  error.stack = `Error: ${secret}\n    at fail (${localSource}:1:2)`;
  publish(error, true);
  expect(output.json).not.toHaveBeenCalled();
  expect(vi.mocked(output.info).mock.calls).toEqual([["Error: An unexpected internal error occurred (Error at fail)."], [expect.stringContaining("Details saved to ")]]);
  expect(JSON.stringify(vi.mocked(output.info).mock.calls)).not.toContain(secret);
});

it("preserves the original terminal when the log directory cannot be created", () => {
  writeFileSync(logs, "blocked");
  const error = publish(new Error(secret));
  expect(error.code).toBe("internal");
  expect(error).not.toHaveProperty("error_log");
});

it("rotates a full log, retains complete recent records, and bounds oversized errors", () => {
  mkdirSync(logs);
  const previous = JSON.stringify({ message: "x".repeat(256 * 1024 - 200) }) + "\n";
  writeFileSync(file, previous);
  publish(new Error("new detail"));
  expect(readFileSync(file + ".1", "utf8")).toBe(previous);
  expect(JSON.parse(readFileSync(file, "utf8")).message).toBe("new detail");
  const before = readFileSync(file, "utf8");
  expect(publish(new Error("x".repeat(256 * 1024)))).not.toHaveProperty("error_log");
  expect(readFileSync(file, "utf8")).toBe(before);
});

it("bounds cyclic cause chains and repairs existing loose permissions before writing", () => {
  mkdirSync(logs, { mode: 0o755 });
  writeFileSync(file, "", { mode: 0o644 });
  const error = new Error("cycle");
  error.cause = error;
  publish(error);
  let record = JSON.parse(readFileSync(file, "utf8"));
  let depth = 0;
  while (record.cause) { record = record.cause; depth++; }
  expect(depth).toBeLessThanOrEqual(5);
  if (process.platform !== "win32") {
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(logs).mode & 0o777).toBe(0o700);
  }
});

it("shortens log paths beneath home without publishing the home directory", () => {
  vi.mocked(homedir).mockReturnValue(CONFIG_DIR);
  expect(publish(new Error("detail")).error_log).toBe(join("~", "logs", "internal-errors.jsonl"));
});

it("omits sites when the stack header no longer matches the message", () => {
  const error = new Error("current message");
  error.stack = `Error: old message\n    at untrusted (${localSource}:1:2)`;
  expect(publish(error)).not.toHaveProperty("error_site");
});

it("accepts only package locations, including file URLs, constructors, and aliases", () => {
  const error = new Error("detail");
  error.stack = `Error: detail\n    at outside (/source:1:2)\n    at sibling (${resolve(import.meta.dirname, "../../outside.js")}:1:2)\n    at traversed (${localSource}/../../../../outside.js:1:2)\n    at new Client (${localSource}:1:2)\n    at Client.send [as dispatch] (${new URL("../src/lib/error-handler.ts", import.meta.url).href}:1:2)`;
  expect(publish(error).error_site).toEqual(["Client", "Client.send"]);
});

it("bounds every dotted segment and rejects private-key-shaped names", () => {
  const error = new Error("detail");
  error.stack = `Error: detail\n    at Client.${"z".repeat(65)} (${localSource}:1:2)\n    at Client.nsec1${"q".repeat(58)} (${localSource}:1:2)\n    at Client.${secret} (${localSource}:1:2)\n    at ${"z".repeat(64)}.send (${localSource}:1:2)`;
  expect(publish(error).error_site).toEqual([`${"z".repeat(64)}.send`]);
});

it.each(["directory", "file"])("skips a symlinked log %s without changing its target", (kind) => {
  const targetDir = mkdtempSync(join(tmpdir(), "internal-log-target-"));
  const targetFile = join(targetDir, "target");
  chmodSync(targetDir, 0o755);
  try {
    writeFileSync(targetFile, "untouched", { mode: 0o644 });
    if (kind === "directory") symlinkSync(targetDir, logs, "dir");
    else {
      mkdirSync(logs);
      symlinkSync(targetFile, file);
    }
    const originalMode = statSync(targetDir).mode;
    expect(publish(new Error("detail"))).not.toHaveProperty("error_log");
    expect(readFileSync(targetFile, "utf8")).toBe("untouched");
    expect(statSync(targetDir).mode).toBe(originalMode);
    if (process.platform !== "win32") expect(statSync(targetFile).mode & 0o777).toBe(0o644);
    if (kind === "directory") expect(() => statSync(join(targetDir, "internal-errors.jsonl"))).toThrow();
  } finally {
    rmSync(logs, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});
