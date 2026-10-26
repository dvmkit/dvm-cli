import { shellQuoteArg } from "@dvmkit/sdk/internal";
import { json } from "./output";

/** Mark roots at the copy boundary; descendants retain their original wire shapes. */
export function providerFields<T extends Record<string, unknown>>(value: T, fields = Object.keys(value)): T & { _provider_fields: string[] } {
  return {
    ...value,
    _provider_fields: [...new Set([
      ...(Array.isArray(value._provider_fields) ? value._provider_fields as string[] : []),
      ...fields.filter((field) => field !== "_provider_fields" && value[field] !== undefined),
    ])],
  };
}

/** Only validated machine tokens may be interpolated into CLI-authored guidance. */
export function guidanceJobArg(jobId: string): string {
  return /^[A-Za-z0-9_-]+$/.test(jobId) ? shellQuoteArg(jobId) : "'<job_id>'";
}

export function providerJobJson(data: Record<string, unknown>, providerJob = true): void {
  const action = data.next_action;
  json(providerFields({
    ...data,
    ...(providerJob && action && typeof action === "object"
      ? { next_action: providerFields(action as Record<string, unknown>, ["job_id"]) } : {}),
  }, [...(providerJob ? ["jobId"] : []), "capability", "identifier"]));
}
