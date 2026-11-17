import { DvmError, isAbortError } from "@dvmkit/sdk/internal";

// Only read boundaries may use this: a failed send can have reached the provider.
export function isTransientJobReadError(error: unknown): boolean {
  return isAbortError(error) || (error instanceof DvmError && ["timeout", "provider_unreachable"].includes(error.code));
}
