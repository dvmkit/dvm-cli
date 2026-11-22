import { DvmError } from "@dvmkit/sdk/internal";
import { dvmFetch } from "./http";

/** Follow body-preserving redirects only while a protected POST stays on its original origin. */
export async function sameOriginPost(
  url: string, init: RequestInit, fetchImpl: typeof fetch = dvmFetch,
): Promise<Response> {
  let target = new URL(url);
  const origin = target.origin;
  for (let hops = 0; ; hops++) {
    const response = await fetchImpl(target.href, { ...init, method: "POST", redirect: "manual" });
    const location = response.headers.get("location");
    if (!location || ![301, 302, 303, 307, 308].includes(response.status)) return response;
    const next = new URL(location, target);
    if (next.origin !== origin) {
      await response.body?.cancel().catch(() => {});
      const display = `The DVM redirected a protected POST from ${origin} to ${next.origin}. The CLI stopped at the original origin.`;
      throw new DvmError("protected_post_redirect", display,
        "Check the original job or payment state before trying again.",
        { from_origin: origin, to_origin: next.origin }, display);
    }
    if (response.status !== 307 && response.status !== 308) return response;
    await response.body?.cancel().catch(() => {});
    if (hops >= 19) throw new DvmError("provider_error", "The DVM returned too many redirects for a protected POST.");
    target = next;
  }
}
