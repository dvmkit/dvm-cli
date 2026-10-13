import { DvmError } from "@dvmkit/sdk/internal";

/**
 * Bytes-upload kind. Each DVM's ingest surface accepts one or more kinds;
 * `audio` is the default and the only kind scribe supports.
 */
export type UploadKind = "audio" | "image";

/**
 * A resolved bytes-ingest target — the per-DVM wire facts a `dvm upload` call
 * needs to sign the upload-claim envelope and stream the body to the right
 * endpoint. These differ across the three first-party surfaces (cast audio,
 * cast image, scribe audio) and are **not** advertised on `/v1/info`, so they
 * live in the static {@link UPLOAD_TARGETS} registry rather than being derived
 * from a fetched descriptor.
 */
export interface UploadTarget {
  dvmId: string;
  kind: UploadKind;
  /** HTTP header carrying the base64 upload-claim envelope (e.g. `X-Cast-Upload-Claim`). */
  header: string;
  /** `purpose` domain-separator baked into the signed claim (e.g. `cast-upload`). */
  purpose: string;
  /** Ingest route path relative to the DVM base URL (e.g. `/v1/ingest/audio`). */
  route: string;
  /** Server-enforced byte cap; the CLI rejects oversize files before uploading. */
  maxBytes: number;
  /** The consuming job's field the returned `upload_handle` is passed on (e.g. `audio_upload_handle`). */
  handleField: string;
  /**
   * Other job fields the same handle can feed, when a kind serves more than one
   * consumer (e.g. a cast image is cover art via `update-feed` **or** episode
   * artwork via `add-episode`). Surfaced in `next_action.alt_handle_fields` so an
   * agent following the response verbatim can pick the right slot.
   */
  altHandleFields?: string[];
  consumerHint: string;
  /** Staged-upload TTL in seconds — the window before the handle expires. */
  ttlSeconds: number;
}

/** Shared 15-minute staged-upload TTL (cast + scribe `UPLOAD_HANDLE_TTL_SECONDS`). */
const UPLOAD_HANDLE_TTL_SECONDS = 15 * 60;

/**
 * Static registry of first-party bytes-ingest targets, keyed by `dvmId` then
 * {@link UploadKind}. Caps mirror the server constants (`MAX_EPISODE_BYTES`
 * 200 MB / `MAX_COVER_IMAGE_BYTES` 10 MB in `src/dvms/cast/types.ts`,
 * `MAX_INGEST_BYTES` 2 GB in `src/dvms/scribe/types.ts`) — kept in lockstep by
 * hand rather than imported so the CLI doesn't pull DVM server modules into its
 * bundle. Add a row here when a new DVM grows an ingest surface.
 */
export const UPLOAD_TARGETS: Record<string, Partial<Record<UploadKind, UploadTarget>>> = {
  cast: {
    audio: {
      dvmId: "cast",
      kind: "audio",
      header: "X-Cast-Upload-Claim",
      purpose: "cast-upload",
      route: "/v1/ingest/audio",
      maxBytes: 200 * 1024 * 1024,
      handleField: "audio_upload_handle",
      consumerHint: "cast add-episode `audio_upload_handle`",
      ttlSeconds: UPLOAD_HANDLE_TTL_SECONDS,
    },
    image: {
      dvmId: "cast",
      kind: "image",
      header: "X-Cast-Upload-Claim",
      purpose: "cast-image-upload",
      route: "/v1/ingest/image",
      maxBytes: 10 * 1024 * 1024,
      handleField: "cover_image_upload_handle",
      altHandleFields: ["episode_image_upload_handle"],
      consumerHint:
        "cast update-feed `cover_image_upload_handle` or add-episode `episode_image_upload_handle`",
      ttlSeconds: UPLOAD_HANDLE_TTL_SECONDS,
    },
  },
  scribe: {
    audio: {
      dvmId: "scribe",
      kind: "audio",
      header: "X-Scribe-Upload-Claim",
      purpose: "scribe-upload",
      route: "/v1/ingest/audio",
      maxBytes: 2 * 1024 * 1024 * 1024,
      handleField: "audio_upload_handle",
      consumerHint: "scribe transcribe `audio_upload_handle`",
      ttlSeconds: UPLOAD_HANDLE_TTL_SECONDS,
    },
  },
};

/**
 * Resolve the {@link UploadTarget} for a `(dvmId, kind)` pair. Throws a
 * structured {@link DvmError} — never a bare 400 from a mystery request — when
 * the DVM has no ingest surface or doesn't serve the requested kind, so an
 * agent gets an actionable hint listing what's supported.
 */
export function resolveUploadTarget(dvmId: string, kind: UploadKind): UploadTarget {
  if (!Object.hasOwn(UPLOAD_TARGETS, dvmId)) {
    const supported = Object.keys(UPLOAD_TARGETS).join(", ");
    throw new DvmError(
      "unsupported_upload",
      `${dvmId} doesn't support bytes-upload via \`dvm upload\`.`,
      `Uploadable DVMs: ${supported}.`,
      { anchor: "unsupported_upload_dvm" }
    );
  }
  const byKind = UPLOAD_TARGETS[dvmId];
  const target = byKind[kind];
  if (!target) {
    const kinds = Object.keys(byKind).join(", ");
    throw new DvmError(
      "unsupported_upload",
      `${dvmId} doesn't support --kind ${kind}.`,
      `${dvmId} accepts: ${kinds}.`,
      { anchor: "unsupported_upload_kind" }
    );
  }
  return target;
}
