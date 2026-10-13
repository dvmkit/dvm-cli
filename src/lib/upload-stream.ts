import { DvmError } from "@dvmkit/sdk/internal";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";

import { clientCompatibilityError, dvmClientHeaders } from "./client-compatibility";

export const UPLOAD_RESPONSE_MAX_BYTES = 64 * 1024;

export interface FileDigest {
  sizeBytes: number;
  /** Lowercase-hex SHA-256 over the file's bytes. */
  sha256: string;
}

/**
 * Compute a file's byte count and SHA-256 by streaming it through the hasher —
 * never buffering the whole file. Both values bind the upload-claim envelope to
 * the exact bytes that will hit the wire (`declared_size_bytes` /
 * `declared_sha256`), which the ingest endpoint re-verifies server-side.
 */
export function hashFile(filePath: string): Promise<FileDigest> {
  return new Promise((resolve, reject) => {
    const hasher = createHash("sha256");
    let sizeBytes = 0;
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: string | Buffer) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      sizeBytes += buf.byteLength;
      hasher.update(buf);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve({ sizeBytes, sha256: hasher.digest("hex") });
    });
  });
}

export interface UploadResponse {
  status: number;
  /** Response headers, first-value-wins, lowercased keys. */
  headers: Record<string, string>;
  /** Raw response body, never larger than {@link UPLOAD_RESPONSE_MAX_BYTES}. */
  body: string;
}

export interface StreamUploadOpts {
  /** Absolute ingest URL (base endpoint + route), e.g. `https://cast.dvmkit.ai/v1/ingest/audio`. */
  url: string;
  /** Claim header name (e.g. `X-Cast-Upload-Claim`). */
  header: string;
  /** Base64 of the signed upload-claim JSON envelope. */
  claimB64: string;
  filePath: string;
  /** Byte count (from {@link hashFile}) sent as `Content-Length`. */
  sizeBytes: number;
  /** Max total attempts including the first (default 4 → up to 3 retries). */
  maxAttempts?: number;
  /** Upper bound on a single honored `Retry-After`, in seconds (default 60). */
  retryAfterCapSeconds?: number;
  /** Socket idle timeout in ms — no bytes flowing (default 120000). */
  idleTimeoutMs?: number;
  /** Injectable sleep (tests pass a no-op / fake clock). Defaults to real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

/**
 * Stream a file's bytes to a DVM bytes-ingest endpoint over HTTP/1.1.
 *
 * Deliberately uses `node:http`/`node:https` rather than `fetch`: undici (the
 * global `fetch`) negotiates HTTP/2 with the Fly edge on large streamed bodies
 * and drops the request with a "stream half-closed" error ( dogfood).
 * `node:https` speaks HTTP/1.1 only, sidestepping that path. The body streams
 * from disk with an explicit `Content-Length` (no chunked transfer), so client
 * memory stays bounded regardless of file size. Response bodies are capped at
 * {@link UPLOAD_RESPONSE_MAX_BYTES}; crossing the cap destroys the response
 * stream and discards the partial body before any parsing or concatenation.
 *
 * Retries: a `429` is retried honoring `Retry-After` (capped) up to
 * `maxAttempts`; a transient transport failure (reset/hang-up/idle-timeout) is
 * retried with a short backoff. A `429` with no attempts left is returned
 * as-is so the caller surfaces the endpoint's structured backpressure error
 * verbatim. Compatibility 426s are classified after the bounded read and are
 * never retried. Any non-`429`, non-error response returns immediately.
 */
export async function streamUpload(opts: StreamUploadOpts): Promise<UploadResponse> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const capMs = (opts.retryAfterCapSeconds ?? 60) * 1000;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  for (let attempt = 1; ; attempt++) {
    let res: UploadResponse;
    try {
      res = await postOnce(opts, idleTimeoutMs);
    } catch (err) {
      if (attempt < maxAttempts) {
        const backoff = Math.min(500 * 2 ** (attempt - 1), capMs);
        opts.log?.(
          `upload transport error (${err instanceof Error ? err.message : String(err)}); retry ${attempt.toString()}/${(maxAttempts - 1).toString()} in ${backoff.toString()}ms`
        );
        await sleep(backoff);
        continue;
      }
      throw new DvmError(
        "upload_transport_failed",
        `Upload to ${opts.url} failed after ${maxAttempts.toString()} attempt(s): ${err instanceof Error ? err.message : String(err)}`,
        "Transient network/transport failure. Retry the upload; if it persists, the endpoint or edge may be unhealthy.",
        { anchor: "upload_transport_failed", retryable: true }
      );
    }

    const compatibilityError = clientCompatibilityError(res.status, res.body);
    if (compatibilityError) throw compatibilityError;

    if (res.status === 429 && attempt < maxAttempts) {
      const wait = retryAfterMs(res.headers["retry-after"], capMs);
      opts.log?.(
        `429 backpressure; retry ${attempt.toString()}/${(maxAttempts - 1).toString()} in ${wait.toString()}ms`
      );
      await sleep(wait);
      continue;
    }
    return res;
  }
}

function postOnce(opts: StreamUploadOpts, idleTimeoutMs: number): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(opts.url);
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: "POST",
        headers: {
          ...dvmClientHeaders(),
          "content-type": "application/octet-stream",
          "content-length": opts.sizeBytes.toString(),
          [opts.header]: opts.claimB64,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        const status = res.statusCode ?? 0;
        const headers = firstValueHeaders(res.headers);
        let receivedBytes = 0;
        let settled = false;
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          receivedBytes += chunk.byteLength;
          if (receivedBytes > UPLOAD_RESPONSE_MAX_BYTES) {
            settled = true;
            chunks.length = 0;
            res.destroy();
            resolve({ status, headers, body: "" });
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({
            status,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", (err) => {
          if (!settled) reject(err);
        });
      }
    );

    req.setTimeout(idleTimeoutMs, () => {
      req.destroy(new Error(`socket idle for ${idleTimeoutMs.toString()}ms`));
    });
    req.on("error", reject);

    const body = createReadStream(opts.filePath);
    body.on("error", (err) => {
      req.destroy(err);
      reject(err);
    });
    body.pipe(req);
  });
}

function firstValueHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? (v[0] ?? "") : v;
  }
  return out;
}

/** Parse a `Retry-After` (delta-seconds) header into a clamped millisecond wait. Defaults to 2s when absent/unparseable. */
function retryAfterMs(retryAfter: string | undefined, capMs: number): number {
  const seconds = retryAfter !== undefined ? Number.parseInt(retryAfter, 10) : NaN;
  const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2000;
  return Math.min(ms, capMs);
}
