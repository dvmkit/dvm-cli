import { ensureConfigSubdir, type Message, MESSAGES_DIR } from "@dvmkit/sdk/internal";
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  type Stats,
} from "fs";
import { join } from "path";

const CHECKPOINT_BYTES = 64;

export interface MessageAppendSession {
  append(messages: Message[]): void;
}

/** Append a single message to the job's JSONL file, deduplicating by seq. */
export function appendMessage(jobId: string, message: Message): void {
  appendMessages(jobId, [message]);
}

/** Append multiple messages to the job's JSONL file, deduplicating by seq. */
export function appendMessages(jobId: string, messages: Message[]): void {
  if (messages.length === 0) return;

  createMessageAppendSession(jobId).append(messages);
}

/**
 * Create a scoped appender that scans existing sequence state once, then only
 * parses bytes added during the session. The path is re-checked before every
 * append so external writers, truncation, and replacement cannot leave the
 * in-memory sequence index stale.
 */
export function createMessageAppendSession(jobId: string): MessageAppendSession {
  return new FileMessageAppendSession(messageFilePath(jobId));
}

class FileMessageAppendSession implements MessageAppendSession {
  private readonly seqs = new Set<number>();
  private identity: FileIdentity | undefined;
  private offset = 0;
  private pending: Buffer = Buffer.alloc(0);
  private checkpoint: Buffer = Buffer.alloc(0);
  private modifiedAt = 0;

  constructor(private readonly filePath: string) {
    this.syncFromDisk();
  }

  append(messages: Message[]): void {
    if (messages.length === 0) return;

    this.syncFromDisk();

    const selectedSeqs = new Set(this.seqs);
    const newMessages = messages.filter((message) => {
      if (selectedSeqs.has(message.seq)) return false;
      selectedSeqs.add(message.seq);
      return true;
    });
    if (newMessages.length === 0) return;

    // Owner-only, and recursive mkdir applies the mode to CONFIG_DIR too when
    // this is the first write to land there.
    ensureConfigSubdir(MESSAGES_DIR);
    const lines = newMessages.map((message) => JSON.stringify(message)).join("\n") + "\n";
    appendFileSync(this.filePath, lines);

    // Reading the just-appended range also incorporates any external append
    // that raced between the pre-write refresh and the O_APPEND write.
    this.syncFromDisk();
  }

  private syncFromDisk(): void {
    const snapshot = statFile(this.filePath);
    if (!snapshot) {
      this.reset();
      return;
    }

    const identity = fileIdentity(snapshot);
    const changedFile = !this.identity || !sameIdentity(this.identity, identity);
    const shrank = snapshot.size < this.offset;
    const changedSinceRead =
      snapshot.size !== this.offset ||
      Math.max(snapshot.mtimeMs, snapshot.ctimeMs) !== this.modifiedAt;

    if (changedFile || shrank || (changedSinceRead && !this.checkpointMatches())) {
      this.reset(identity);
    }

    this.identity = identity;
    this.modifiedAt = Math.max(snapshot.mtimeMs, snapshot.ctimeMs);
    if (snapshot.size <= this.offset) return;

    const bytes = readRange(this.filePath, this.offset, snapshot.size);
    this.offset += bytes.byteLength;
    this.consume(bytes);
    this.checkpoint = trailingBytes(this.checkpoint, bytes, CHECKPOINT_BYTES);
  }

  private checkpointMatches(): boolean {
    if (this.checkpoint.length === 0 || this.offset < this.checkpoint.length) return true;
    const actual = readRange(
      this.filePath,
      this.offset - this.checkpoint.length,
      this.offset
    );
    return actual.equals(this.checkpoint);
  }

  private consume(bytes: Buffer): void {
    const combined = Buffer.concat([this.pending, bytes]);
    const finalNewline = combined.lastIndexOf(0x0a);
    if (finalNewline === -1) {
      this.pending = combined;
      this.parseLine(this.pending);
      return;
    }

    const complete = combined.subarray(0, finalNewline).toString("utf8");
    for (const line of complete.split("\n")) this.parseLine(line);

    this.pending = combined.subarray(finalNewline + 1);
    this.parseLine(this.pending);
  }

  private parseLine(line: string | Buffer): void {
    const text = line.toString().trim();
    if (!text) return;
    try {
      const message = JSON.parse(text) as Message;
      this.seqs.add(message.seq);
    } catch {
      // Keep a malformed trailing fragment in `pending`: a later external
      // append may complete it. Malformed newline-terminated records stay
      // ignored, matching loadMessages.
    }
  }

  private reset(identity?: FileIdentity): void {
    this.seqs.clear();
    this.identity = identity;
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.checkpoint = Buffer.alloc(0);
    this.modifiedAt = 0;
  }
}

export function loadMessages(jobId: string, after?: number): Message[] {
  const filePath = messageFilePath(jobId);
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) return [];

  const messages: Message[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as Message;
      if (after === undefined || msg.seq > after) {
        messages.push(msg);
      }
    } catch {
    }
  }
  return messages;
}

export function getHighestSeq(jobId: string): number {
  const messages = loadMessages(jobId);
  if (messages.length === 0) return 0;
  return Math.max(...messages.map((m) => m.seq));
}

function messageFilePath(jobId: string): string {
  return join(MESSAGES_DIR, `${jobId}.jsonl`);
}

interface FileIdentity {
  dev: number;
  ino: number;
}

function statFile(filePath: string): Stats | undefined {
  try {
    return statSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function fileIdentity(stats: Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readRange(filePath: string, start: number, end: number): Buffer {
  const expected = Math.max(0, end - start);
  const buffer = Buffer.allocUnsafe(expected);
  const fd = openSync(filePath, "r");
  let total = 0;
  try {
    while (total < expected) {
      const read = readSync(fd, buffer, total, expected - total, start + total);
      if (read === 0) break;
      total += read;
    }
  } finally {
    closeSync(fd);
  }
  return total === expected ? buffer : buffer.subarray(0, total);
}

function trailingBytes(previous: Buffer, next: Buffer, limit: number): Buffer {
  if (next.length >= limit) return Buffer.from(next.subarray(next.length - limit));
  const combined = Buffer.concat([previous, next]);
  return Buffer.from(combined.subarray(Math.max(0, combined.length - limit)));
}
