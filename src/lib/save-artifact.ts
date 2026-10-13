import type { ArtifactContent } from "@dvmkit/sdk";
import {
  info,
} from "./output";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mimeToExt } from "./mime-ext";

/** Maximum decoded inline artifact size written by the human CLI (10 MiB). */
export const MAX_INLINE_ARTIFACT_BYTES = 10 * 1024 * 1024;

const BINARY_PREFIXES = ["image/", "audio/", "video/"];
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Lazily owns one private temporary directory for a command's human-mode artifacts.
 *
 * Failed, unreported partial files are removed synchronously. Successful files are
 * deliberately retained because their paths are printed to the caller; the host's
 * temporary-directory policy owns their eventual removal.
 */
export class ArtifactSaveSession {
  private directory: string | undefined;
  private successfulWrites = 0;

  /** Decode and exclusively save one inline artifact inside this session's directory. */
  save(content: ArtifactContent): { path: string; bytes: number } | null {
    if (!content.data) return null;

    const isBase64 = content.encoding === "base64" || isBinaryMime(content.mime_type);
    const decodedBytes = Buffer.byteLength(content.data, isBase64 ? "base64" : "utf8");
    if (decodedBytes > MAX_INLINE_ARTIFACT_BYTES) {
      info(
        `Warning: inline artifact is ${formatBytes(decodedBytes)}, above the ${formatBytes(MAX_INLINE_ARTIFACT_BYTES)} human-mode save limit. Re-run without --human to retain the inline data in JSON, or ask the provider for URL delivery.`
      );
      return null;
    }

    const buf = Buffer.from(content.data, isBase64 ? "base64" : "utf8");
    const ext = mimeToExt(content.mime_type);
    let path: string | undefined;
    let fd: number | undefined;
    let created = false;

    try {
      const directory = this.ensureDirectory();
      path = join(directory, `artifact-${randomBytes(16).toString("hex")}.${ext}`);
      // O_CREAT | O_EXCL (`wx`) refuses existing files and symlinks. There is no
      // provider-derived fallback name: a losing collision fails this save.
      fd = openSync(path, "wx", FILE_MODE);
      created = true;
      writeFileSync(fd, buf);
      closeSync(fd);
      fd = undefined;
      // Pin the final mode explicitly instead of leaving it to the host umask.
      chmodSync(path, FILE_MODE);
      this.successfulWrites += 1;
      return { path, bytes: buf.length };
    } catch (err) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
        }
      }
      if (created && path) {
        try {
          unlinkSync(path);
        } catch {
        }
      }
      this.removeEmptyUnreportedDirectory();
      info(`Warning: could not save artifact: ${String(err)}`);
      return null;
    }
  }

  private ensureDirectory(): string {
    if (this.directory) return this.directory;
    const directory = mkdtempSync(join(tmpdir(), "dvm-artifacts-"));
    try {
      // mkdtemp is private on supported Node platforms; chmod makes the
      // confidentiality contract explicit and independent of umask.
      chmodSync(directory, DIRECTORY_MODE);
    } catch (err) {
      try {
        rmdirSync(directory);
      } catch {
        // Preserve the chmod error below; the best-effort directory is random.
      }
      throw err;
    }
    this.directory = directory;
    return directory;
  }

  private removeEmptyUnreportedDirectory(): void {
    if (!this.directory || this.successfulWrites > 0) return;
    try {
      if (readdirSync(this.directory).length === 0) {
        rmdirSync(this.directory);
        this.directory = undefined;
      }
    } catch {
      // A concurrent local-owner change or cleanup leaves nothing safe to remove.
    }
  }
}

export function createArtifactSaveSession(): ArtifactSaveSession {
  return new ArtifactSaveSession();
}

export function saveArtifact(
  content: ArtifactContent,
  session: ArtifactSaveSession
): { path: string; bytes: number } | null {
  return session.save(content);
}

function isBinaryMime(mime?: string): boolean {
  if (!mime) return false;
  if (mime === "application/octet-stream") return true;
  return BINARY_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

function formatBytes(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} bytes`;
}
