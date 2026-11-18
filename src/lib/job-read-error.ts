import { DvmError, isAbortError } from "@dvmkit/sdk/internal";

class JobGatewayReadError extends DvmError {
  constructor(message: string, proseSources?: DvmError["proseSources"]) {
    super("provider_error", message, undefined, undefined, undefined, proseSources);
  }
}

export function jobReadHttpError(status: number, message: string, proseSources?: DvmError["proseSources"]): DvmError {
  if (status === 502 || status === 503 || status === 504) return new JobGatewayReadError(message, proseSources);
  return new DvmError("provider_error", message, undefined, undefined, undefined, proseSources);
}

// Only read boundaries may use this: a failed send can have reached the provider.
export function isTransientJobReadError(error: unknown): boolean {
  return isAbortError(error) || error instanceof JobGatewayReadError ||
    (error instanceof DvmError && ["timeout", "provider_unreachable"].includes(error.code));
}
