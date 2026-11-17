import { CONFIG_DIR, ensureConfigSubdir } from "@dvmkit/sdk/internal";
import { closeSync, constants, fchmodSync, fstatSync, openSync, renameSync, rmSync, writeSync, chmodSync, readFileSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

const MAX_LOG_BYTES = 256 * 1024;

// Foreign messages can contain credentials. Never forward this record to output.
export function appendInternalErrorLog(err: unknown, diagnostic: { name: string; code?: string }): string | undefined {
  let fd: number | undefined;
  try {
    const record = JSON.stringify({
      timestamp: new Date().toISOString(),
      version: localVersion(),
      command: process.argv[2],
      code: "internal",
      error_name: diagnostic.name,
      ...(diagnostic.code ? { error_code: diagnostic.code } : {}),
      ...errorDetail(err, 0),
    }) + "\n";
    // Preserve whole records; a single oversized failure cannot exhaust disk.
    if (Buffer.byteLength(record) > MAX_LOG_BYTES) return undefined;
    const dir = join(CONFIG_DIR, "logs");
    const file = join(dir, "internal-errors.jsonl");
    try {
      if (!lstatSync(dir).isDirectory()) return undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      ensureConfigSubdir(dir);
    }
    if (!lstatSync(dir).isDirectory()) return undefined;
    chmodSync(dir, 0o700);
    const open = () => {
      const descriptor = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      try {
        fchmodSync(descriptor, 0o600);
        return descriptor;
      } catch (err) {
        closeSync(descriptor);
        throw err;
      }
    };
    fd = open();
    const size = fstatSync(fd).size;
    if (size + Buffer.byteLength(record) > MAX_LOG_BYTES) {
      closeSync(fd);
      fd = undefined;
      rmSync(file + ".1", { force: true });
      if (size <= MAX_LOG_BYTES) renameSync(file, file + ".1");
      else rmSync(file);
      fd = open();
    }
    const bytes = Buffer.from(record);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    closeSync(fd);
    fd = undefined;
    const fromHome = relative(homedir(), file);
    return fromHome !== ".." && !fromHome.startsWith(".." + sep) && !isAbsolute(fromHome)
      ? join("~", fromHome) : file;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Logging must never replace the original error. */ }
    }
  }
}

function errorDetail(err: unknown, depth: number): Record<string, unknown> {
  const message = readProperty(err, "message");
  const stack = readProperty(err, "stack");
  const cause = readProperty(err, "cause");
  return {
    ...(typeof message === "string" ? { message } : typeof err === "string" ? { message: err } : {}),
    ...(typeof stack === "string" ? { stack } : {}),
    ...(cause !== undefined && depth < 5 ? { cause: errorDetail(cause, depth + 1) } : {}),
  };
}

function readProperty(value: unknown, key: string): unknown {
  try {
    return value !== null && (typeof value === "object" || typeof value === "function")
      ? (value as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
}

function localVersion(): string | undefined {
  for (const parent of ["..", "../.."]) {
    try {
      const manifest = JSON.parse(readFileSync(join(import.meta.dirname, parent, "package.json"), "utf8")) as { name?: string; version?: string };
      if (manifest.name === "@dvmkit/dvm-cli") return manifest.version;
    } catch { /* A standalone bundle may have no package manifest. */ }
  }
  return undefined;
}
