/** Maps MIME types to file extensions (without leading dot). */
const MIME_TO_EXT: Record<string, string> = {
  "text/plain": "txt",
  "text/markdown": "md",
  "text/html": "html",
  "text/css": "css",
  "text/csv": "csv",
  "application/json": "json",
  "application/xml": "xml",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/octet-stream": "bin",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

/** Returns the file extension for a MIME type, defaulting to `"bin"` for unknowns. */
export function mimeToExt(mime?: string): string {
  if (!mime) return "bin";
  return MIME_TO_EXT[mime] ?? "bin";
}
