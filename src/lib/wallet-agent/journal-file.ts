import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";

import { ensureConfigDir, JOBS_FILE } from "@dvmkit/sdk/internal";

/**
 * A CLI-owned JSON array beside the jobs file. Reads tolerate a missing or
 * damaged file; writes are fsynced and renamed into place, and every change
 * runs under a file lock so two commands cannot overwrite each other.
 */
export interface JournalFile<T> {
  read(): T[];
  /** Run `change` with the file locked. Reads and writes inside it are consistent. */
  withLock<R>(change: () => R): R;
  /** Replace the contents atomically. Call only inside {@link JournalFile.withLock}. */
  write(entries: T[]): void;
}

export function journalFile<T>(name: string): JournalFile<T> {
  const file = () => join(dirname(JOBS_FILE), name);

  function read(): T[] {
    if (!existsSync(file())) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(file(), "utf8"));
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }

  function withLock<R>(change: () => R): R {
    ensureConfigDir();
    if (!existsSync(file())) writeFileSync(file(), "[]\n", { mode: 0o600, flag: "a" });
    let release: (() => void) | undefined;
    for (let attempt = 0; !release; attempt++) {
      try {
        release = lockfile.lockSync(file(), { realpath: false });
      } catch (error) {
        if (attempt >= 40) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    try { return change(); } finally { release(); }
  }

  function write(entries: T[]): void {
    const temporary = `${file()}.${process.pid}.tmp`;
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(entries, null, 2) + "\n");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, file());
  }

  return { read, withLock, write };
}
