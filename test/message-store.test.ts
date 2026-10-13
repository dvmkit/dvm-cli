import type { Message } from "@dvmkit/sdk/internal";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const readMetrics = vi.hoisted(() => ({ bytes: 0 }));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const value = Reflect.apply(actual.readFileSync, actual, args) as ReturnType<
        typeof actual.readFileSync
      >;
      readMetrics.bytes += Buffer.isBuffer(value) ? value.byteLength : Buffer.byteLength(value);
      return value;
    },
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      const bytes = Reflect.apply(actual.readSync, actual, args) as number;
      readMetrics.bytes += bytes;
      return bytes;
    },
  };
});

let configRoot: string;
let messagesDir: string;
let originalConfigRoot: string | undefined;
let store: typeof import("../src/lib/messages/store");

describe("message journal persistence", () => {
  beforeAll(async () => {
    configRoot = mkdtempSync(join(tmpdir(), "dvm-cli-messages-"));
    originalConfigRoot = process.env.DVM_CONFIG_DIR;
    process.env.DVM_CONFIG_DIR = configRoot;
    vi.resetModules();
    ({ MESSAGES_DIR: messagesDir } = await import("@dvmkit/sdk/internal"));
    store = await import("../src/lib/messages/store");
  });

  beforeEach(() => {
    readMetrics.bytes = 0;
    rmSync(configRoot, { recursive: true, force: true });
    mkdirSync(configRoot, { recursive: true, mode: 0o700 });
  });

  afterAll(() => {
    rmSync(configRoot, { recursive: true, force: true });
    if (originalConfigRoot === undefined) delete process.env.DVM_CONFIG_DIR;
    else process.env.DVM_CONFIG_DIR = originalConfigRoot;
  });

  it("suppresses same-batch and replayed duplicates while retaining out-of-order messages", () => {
    const session = store.createMessageAppendSession("dedupe");
    session.append([message(3), message(1), message(3), message(2)]);
    session.append([message(2), message(1)]);

    expect(store.loadMessages("dedupe").map(({ seq }) => seq)).toEqual([3, 1, 2]);
  });

  it("rebuilds sequence state when a new session simulates a process restart", () => {
    store.createMessageAppendSession("restart").append([message(4), message(2)]);

    store.createMessageAppendSession("restart").append([message(2), message(5)]);

    expect(store.loadMessages("restart").map(({ seq }) => seq)).toEqual([4, 2, 5]);
  });

  it("incorporates another process's append before filtering the next batch", () => {
    const session = store.createMessageAppendSession("external");
    session.append([message(1)]);
    appendFileSync(messagePath("external"), `${JSON.stringify(message(2))}\n`);

    session.append([message(2), message(3)]);

    expect(store.loadMessages("external").map(({ seq }) => seq)).toEqual([1, 2, 3]);
  });

  it("rebuilds after in-place truncation and path replacement", () => {
    const session = store.createMessageAppendSession("rewritten");
    session.append([message(1), message(2)]);

    writeFileSync(
      messagePath("rewritten"),
      `${JSON.stringify(message(10, "replacement".repeat(30)))}\n`
    );
    session.append([message(1), message(10), message(11)]);
    expect(store.loadMessages("rewritten").map(({ seq }) => seq)).toEqual([10, 1, 11]);

    const replacement = join(configRoot, "replacement.jsonl");
    writeFileSync(replacement, `${JSON.stringify(message(20))}\n`);
    renameSync(replacement, messagePath("rewritten"));
    session.append([message(1), message(20), message(21)]);

    expect(store.loadMessages("rewritten").map(({ seq }) => seq)).toEqual([20, 1, 21]);
  });

  it("recovers a trailing JSON record completed by an external writer", () => {
    mkdirSync(messagesDir, { recursive: true });
    const encoded = JSON.stringify(message(7, "completed later"));
    const splitAt = encoded.length - 5;
    writeFileSync(messagePath("partial"), encoded.slice(0, splitAt));
    const session = store.createMessageAppendSession("partial");

    appendFileSync(messagePath("partial"), `${encoded.slice(splitAt)}\n`);
    session.append([message(7, "completed later"), message(8)]);

    expect(store.loadMessages("partial").map(({ seq }) => seq)).toEqual([7, 8]);
  });

  it("keeps bytes read and records parsed linear across many single-writer batches", () => {
    const parse = vi.spyOn(JSON, "parse");
    const small = runMeasuredWorkload("linear-small", 200, parse);
    const large = runMeasuredWorkload("linear-large", 400, parse);

    expect(small.parsedRecords).toBe(200);
    expect(large.parsedRecords).toBe(400);
    expect(large.bytesRead).toBeGreaterThan(small.bytesRead * 1.8);
    expect(large.bytesRead).toBeLessThan(small.bytesRead * 2.2);
    expect(large.bytesRead).toBeLessThan(large.fileBytes * 2);
    parse.mockRestore();
  });
});

function runMeasuredWorkload(
  jobId: string,
  batches: number,
  parse: ReturnType<typeof vi.spyOn>
): { bytesRead: number; fileBytes: number; parsedRecords: number } {
  readMetrics.bytes = 0;
  parse.mockClear();
  const session = store.createMessageAppendSession(jobId);
  for (let seq = 1; seq <= batches; seq += 1) session.append([message(seq)]);
  return {
    bytesRead: readMetrics.bytes,
    fileBytes: statSync(messagePath(jobId)).size,
    parsedRecords: parse.mock.calls.length,
  };
}

function message(seq: number, text = `message-${String(seq)}`): Message {
  return {
    seq,
    from: "provider",
    timestamp: seq,
    type: "text",
    content: { text },
  };
}

function messagePath(jobId: string): string {
  return join(messagesDir, `${jobId}.jsonl`);
}
