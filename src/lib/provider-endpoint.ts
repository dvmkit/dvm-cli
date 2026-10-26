/** Service identity follows the access contract: URL origin and path, without trailing slashes. */
export function normalizeProviderEndpoint(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return value.replace(/\/+$/, "");
  }
}

export function sameEndpoint(a: string, b: string): boolean {
  return normalizeProviderEndpoint(a) === normalizeProviderEndpoint(b);
}
