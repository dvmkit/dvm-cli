import {
  DvmError,
  signDvmRequestData,
  signedRequestDomain,
} from "@dvmkit/sdk/internal";
import {
  info,
  json,
} from "../lib/output";
import {
  loadConfig,
} from "../lib/identity";
import {
  resolveSigningIdentity,
} from "../lib/cli-identity-resolve";
import { statSync } from "node:fs";

import { resolveDvmReference } from "../lib/dvm-identifier";
import { createDvmTransport } from "../lib/transport";
import { hashFile, streamUpload } from "../lib/upload-stream";
import { resolveUploadTarget, type UploadKind } from "../lib/upload-targets";

export interface UploadOptions {
  file?: string;
  /** Upload kind — `audio` (default) or `image` (cast only). */
  kind?: string;
  /** Caller signing identity name (for the upload-claim signature). */
  as?: string;
  /** Override the DVM base URL (local stack / staging). Defaults to the `-d`-style convention. */
  endpoint?: string;
  human?: boolean;
}


export async function upload(dvmRef: string, opts: UploadOptions): Promise<void> {
  const { dvmId, capability, endpoint, qualified } = resolveDvmReference(dvmRef);
  const qualifiedDvmId = qualified?.dvmId;
  if (capability !== undefined) {
    throw new DvmError(
      "invalid_argument",
      `\`dvm upload\` takes a DVM identifier without a capability, not \`${dvmRef}\`.`,
      `Use \`dvm upload ${dvmId} --file <path>\`.`
    );
  }

  if (!opts.file) {
    throw new DvmError(
      "invalid_argument",
      "No file given.",
      "Pass the file to stage with --file <path>."
    );
  }

  const kind = normalizeKind(opts.kind);
  const target = resolveUploadTarget(qualified?.slug ?? dvmId, kind);

  let sizeOnDisk: number;
  try {
    const st = statSync(opts.file);
    if (!st.isFile()) {
      throw new DvmError(
        "invalid_argument",
        `${opts.file} is not a regular file.`,
        "Pass a file path."
      );
    }
    sizeOnDisk = st.size;
  } catch (err) {
    if (err instanceof DvmError) throw err;
    throw new DvmError(
      "invalid_argument",
      `Cannot read ${opts.file}: ${err instanceof Error ? err.message : String(err)}`,
      "Check the path exists and is readable."
    );
  }
  if (sizeOnDisk > target.maxBytes) {
    throw new DvmError(
      "oversize",
      `File is ${fmtBytes(sizeOnDisk)} — over ${dvmId}'s ${fmtBytes(target.maxBytes)} ${kind} cap.`,
      `Trim or re-encode under ${fmtBytes(target.maxBytes)}.`,
      { anchor: "oversize", size_bytes: sizeOnDisk, max_bytes: target.maxBytes }
    );
  }
  if (sizeOnDisk === 0) {
    throw new DvmError("invalid_argument", `${opts.file} is empty.`, "Upload a non-empty file.");
  }

  const config = loadConfig();
  const signer = resolveSigningIdentity({ as: opts.as, config });

  // Hash + size in one bounded pass; both bind the claim to the exact bytes.
  const { sizeBytes, sha256 } = await hashFile(opts.file);

  const base = opts.endpoint ?? endpoint;
  const url = joinUrl(base, target.route);
  const transport = createDvmTransport();
  let provider;
  try {
    provider = await transport.describe({ endpoint: base });
  } finally {
    transport.close();
  }
  const claim = signDvmRequestData(
    signer.privkey,
    {
      purpose: target.purpose,
      declared_size_bytes: sizeBytes,
      declared_sha256: sha256,
    },
    signedRequestDomain({
      provider,
      endpoint: base,
      method: "POST",
      path: url,
      capability: null,
    })
  );
  const claimB64 = Buffer.from(JSON.stringify(claim), "utf8").toString("base64");

  const outputTarget = qualifiedDvmId ?? base;

  if (opts.human) info(`Uploading ${fmtBytes(sizeBytes)} to ${outputTarget} (${kind})…`);

  const res = await streamUpload({
    url,
    header: target.header,
    claimB64,
    filePath: opts.file,
    sizeBytes,
    log: opts.human ? info : undefined,
  });

  const parsed = parseBody(res.body);

  if (res.status < 200 || res.status >= 300) {
    // Pass the endpoint's structured error through verbatim — `sub_reason`,
    // `display`, `hint` unchanged — so agents branch on the same taxonomy the
    // DVM documents (claim-mismatch, 429 backpressure, …).
    throw errorFromEndpoint(res.status, parsed, url);
  }

  const body = (parsed ?? {}) as Record<string, unknown>;
  const handle = typeof body.upload_handle === "string" ? body.upload_handle : undefined;
  if (!handle) {
    throw new DvmError(
      "unexpected_response",
      `Ingest endpoint returned ${res.status.toString()} without an upload_handle.`,
      "Retry; if it persists, report to the operator.",
      { anchor: "unexpected_response", body }
    );
  }
  const expiresAt = typeof body.expires_at === "string" ? body.expires_at : undefined;

  const nextActionHint = `Reference this upload_handle within ${(target.ttlSeconds / 60).toString()} minutes via ${target.consumerHint} (same signing identity).`;

  if (opts.human) {
    info(
      `Staged ${fmtBytes(sizeBytes)} → ${outputTarget} upload_handle=${handle}${expiresAt ? ` (expires ${expiresAt})` : ""}`
    );
    info(nextActionHint);
    return;
  }

  json({
    ...body,
    ...(qualifiedDvmId ? { dvm_id: qualifiedDvmId } : { endpoint: base }),
    kind,
    next_action: {
      type: "submit_job",
      ...(qualifiedDvmId ? { dvm: qualifiedDvmId } : { endpoint: base }),
      handle_field: target.handleField,
      ...(target.altHandleFields ? { alt_handle_fields: target.altHandleFields } : {}),
      handle,
      expires_at: expiresAt,
      hint: nextActionHint,
    },
    hint: nextActionHint,
  });
}

function normalizeKind(raw: string | undefined): UploadKind {
  if (raw === undefined) return "audio";
  if (raw === "audio" || raw === "image") return raw;
  throw new DvmError(
    "invalid_argument",
    `Invalid --kind "${raw}".`,
    "Use --kind audio or --kind image."
  );
}

/** Build a `DvmError` from a non-2xx ingest response, preserving the server's structured fields. */
function errorFromEndpoint(status: number, parsed: unknown, url: string): DvmError {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const b = parsed as Record<string, unknown>;
    const code = typeof b.code === "string" ? b.code : `http_${status.toString()}`;
    const message =
      typeof b.message === "string"
        ? b.message
        : typeof b.display === "string"
          ? b.display
          : `Ingest endpoint returned ${status.toString()}.`;
    const hint = typeof b.hint === "string" ? b.hint : undefined;
    const data: Record<string, unknown> = { status };
    if (typeof b.sub_reason === "string") data.sub_reason = b.sub_reason;
    if (typeof b.display === "string") data.display = b.display;
    if (typeof b.formatted === "string") data.formatted = b.formatted;
    return new DvmError(code, message, hint, data);
  }
  return new DvmError(
    `http_${status.toString()}`,
    `Ingest endpoint ${url} returned ${status.toString()}.`,
    "The endpoint returned a non-JSON error body.",
    { status }
  );
}

function parseBody(body: string): unknown {
  if (body.trim() === "") return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function joinUrl(base: string, route: string): string {
  return base.replace(/\/+$/, "") + route;
}

function fmtBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
