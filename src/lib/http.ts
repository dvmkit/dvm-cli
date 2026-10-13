/**
 * Outbound-`fetch` hardening for the dvmkit CLIs.
 *
 * Node >=26's global `fetch` (undici) advertises `Accept-Encoding: zstd` but
 * does NOT decompress a `Content-Encoding: zstd` response — it hands the raw
 * compressed bytes to `res.json()`/`res.text()`, which then throw on the zstd
 * magic number (`0x28 0xb5 0x2f 0xfd`). Every dvmkit DVM sits behind Fly's edge,
 * which honours the client's advertised encodings and zstd-compresses any
 * response above its size threshold — so on Node >=26 a plain `fetch(dvmUrl)`
 * fails with an opaque "... is not valid JSON" error that callers surface as
 * `endpoint_unreachable`. Node <=24 never advertised zstd, so it was invisible
 * until the runtime rolled forward.
 *
 * The fix pins `Accept-Encoding` to codecs the runtime reliably decodes
 * (`gzip, deflate, br`): a no-op on Node <=24 (already the default) and
 * corrective on Node >=26, while keeping compression's bandwidth win via `br`.
 */

import { clientCompatibilityError, withDvmClientHeaders } from "./client-compatibility";

/** `Accept-Encoding` value listing only codecs `fetch` decompresses on Node 22-26. */
export const DECODABLE_ACCEPT_ENCODING = "gzip, deflate, br";

/**
 * `fetch` wrapper for DVM and managed-platform requests. It attaches canonical
 * client compatibility metadata and pins {@link DECODABLE_ACCEPT_ENCODING}
 * unless the caller already set `Accept-Encoding`.
 */
export async function dvmFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): Promise<Response> {
  // Resolve `globalThis.fetch` at call time (not a captured reference) so test
  // doubles that stub the global are honoured. When the global is the installed
  // wrapper it calls {@link nativeFetch} directly, so this never recurses.
  const response = await globalThis.fetch(
    input,
    withDvmClientHeaders(input, withDecodableAcceptEncoding(input, init))
  );
  if (response.status === 426) {
    const body = await readBoundedBody(response, MAX_COMPATIBILITY_BODY_BYTES);
    const error = clientCompatibilityError(response.status, body ?? "");
    if (error) throw error;
  }
  return response;
}

/**
 * Install a global `fetch` that applies {@link DECODABLE_ACCEPT_ENCODING} to
 * every outbound request, covering third-party APIs and call sites not wrapped
 * with {@link dvmFetch}. Idempotent; call once at CLI startup, before any
 * request runs. CLI-only — library/SDK embedders should call {@link dvmFetch}
 * for DVM or managed-platform requests rather than mutate the global.
 */
export function installGlobalAcceptEncoding(): void {
  const current = globalThis.fetch as PatchedFetch;
  if (current.__dvmkitAcceptEncodingPatched) return;
  const wrapper = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    nativeFetch(input, withDecodableAcceptEncoding(input, init))) as PatchedFetch;
  wrapper.__dvmkitAcceptEncodingPatched = true;
  globalThis.fetch = wrapper;
}

/**
 * Merge {@link DECODABLE_ACCEPT_ENCODING} into a request's headers unless the
 * caller (or the source `Request`) already set `Accept-Encoding`. Exported for
 * testing.
 */
export function withDecodableAcceptEncoding(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): Parameters<typeof fetch>[1] {
  const source = init?.headers ?? (input instanceof Request ? input.headers : undefined);

  if (source instanceof Headers || Array.isArray(source)) {
    const headers = new Headers(source);
    if (!headers.has("accept-encoding")) {
      headers.set("accept-encoding", DECODABLE_ACCEPT_ENCODING);
    }
    return { ...init, headers };
  }

  // Plain-object headers (the shape every dvmkit call site uses) or none: merge
  // into a record so callers that still read `init.headers` as an object can,
  // preserving their key casing. Add Accept-Encoding only when absent.
  const record: Record<string, string> = { ...source };
  if (!Object.keys(record).some((name) => name.toLowerCase() === "accept-encoding")) {
    record["Accept-Encoding"] = DECODABLE_ACCEPT_ENCODING;
  }
  return { ...init, headers: record };
}

type PatchedFetch = typeof fetch & { __dvmkitAcceptEncodingPatched?: boolean };

/** The runtime `fetch`, captured at module load so the wrappers never recurse. */
const nativeFetch: typeof fetch = globalThis.fetch;

async function readBoundedBody(response: Response, limit: number): Promise<string | undefined> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return body + decoder.decode();
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return undefined;
      }
      body += decoder.decode(value, { stream: true });
    }
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

const MAX_COMPATIBILITY_BODY_BYTES = 16_384;
