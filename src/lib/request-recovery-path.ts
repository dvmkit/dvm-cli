/**
 * The path of a request's recovery route, relative to the provider endpoint.
 * The provider checks the signature over the path it receives, which keeps the
 * request ID's percent-encoding (a `:` arrives as `%3A`), so the URL and the
 * signature both take the path from here.
 */
export function requestRecoveryPath(
  route: "request-result" | "request-resume",
  requestId: string
): string {
  return `v1/${route}/${encodeURIComponent(requestId)}`;
}
