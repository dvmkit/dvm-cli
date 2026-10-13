import { spawnSync } from "node:child_process";
import type * as nodeFs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof nodeFs>("node:fs");
  return { ...actual, writeSync: vi.fn(actual.writeSync) };
});

import { writeSync as mockedWriteSync } from "node:fs";

import { info, json, setOutputTraceId } from "../output";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type WriteSyncCall = [number, Buffer, (number | undefined)?, (number | undefined)?];

function bytesWrittenTo(fd: number): string {
  const calls = vi.mocked(mockedWriteSync).mock.calls as unknown as WriteSyncCall[];
  const chunks = calls
    .filter((c) => c[0] === fd)
    .map(([, buf, offset = 0, length]) => {
      const end = offset + (length ?? buf.length);
      return Buffer.from(buf.subarray(offset, end));
    });
  return Buffer.concat(chunks).toString("utf8");
}

describe("json", () => {
  it("writes compact JSON + newline synchronously to fd 1", () => {
    vi.mocked(mockedWriteSync).mockClear();
    json({ a: 1 });
    expect(bytesWrittenTo(1)).toBe('{"a":1}\n');
  });
});

describe("info", () => {
  it("writes message + newline synchronously to fd 2", () => {
    vi.mocked(mockedWriteSync).mockClear();
    info("hello");
    expect(bytesWrittenTo(2)).toBe("hello\n");
  });
});

describe("json trace_id injection", () => {
  afterEach(() => {
    setOutputTraceId(null);
  });

  it("injects trace_id as the first key when set", () => {
    vi.mocked(mockedWriteSync).mockClear();
    setOutputTraceId("aabbccdd00112233aabbccdd00112233");
    json({ status: "ok" });
    const output = bytesWrittenTo(1);
    const parsed = JSON.parse(output);
    expect(parsed.trace_id).toBe("aabbccdd00112233aabbccdd00112233");
    expect(parsed.status).toBe("ok");
    expect(output.indexOf('"trace_id"')).toBeLessThan(output.indexOf('"status"'));
  });

  it("does not overwrite existing trace_id in data", () => {
    vi.mocked(mockedWriteSync).mockClear();
    setOutputTraceId("command-trace-id-0000000000000000");
    json({ trace_id: "queried-trace-id-000000000000000", spans: [] });
    const parsed = JSON.parse(bytesWrittenTo(1));
    expect(parsed.trace_id).toBe("queried-trace-id-000000000000000");
  });

  it("does not inject into arrays", () => {
    vi.mocked(mockedWriteSync).mockClear();
    setOutputTraceId("aabbccdd00112233aabbccdd00112233");
    json([1, 2, 3]);
    expect(bytesWrittenTo(1)).toBe("[1,2,3]\n");
  });

  it("clears injection after setOutputTraceId(null)", () => {
    vi.mocked(mockedWriteSync).mockClear();
    setOutputTraceId("aabbccdd00112233aabbccdd00112233");
    setOutputTraceId(null);
    json({ a: 1 });
    expect(bytesWrittenTo(1)).toBe('{"a":1}\n');
  });
});

// The real child process has its own kill deadline below the suite deadline.
describe("json large output regression", () => {
  it("emits the full payload through a pipe without truncation", () => {
    const root = mkdtempSync(path.join(tmpdir(), "caller-output-pipe-"));
    const fixture = path.join(root, "fixture.ts");
    const bundle = path.join(root, "fixture.mjs");
    const outputModule = path.resolve(__dirname, "../output.ts");
    writeFileSync(fixture, `import { json } from ${JSON.stringify(outputModule)};
const payload = { data: "x".repeat(150_000) };
process.stderr.write("expected:" + Buffer.byteLength(JSON.stringify(payload) + "\\n") + "\\n");
json(payload);
process.exit(0);
`);
    buildSync({ entryPoints: [fixture], outfile: bundle, bundle: true, format: "esm", platform: "node" });
    const result = spawnSync(process.execPath, [bundle], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    rmSync(root, { recursive: true, force: true });
    expect(result.status).toBe(0);

    const stderr = result.stderr.toString("utf8");
    const match = /expected:(\d+)/.exec(stderr);
    expect(match).not.toBeNull();
    if (!match) return;
    const expectedBytes = Number(match[1]);
    expect(expectedBytes).toBeGreaterThan(100_000);

    expect(result.stdout.length).toBe(expectedBytes);
  });
});
