import {
  DvmError,
  isAbortError,
  parseTraceparent,
  providerProseSources,
  transportErrorCode,
} from "@dvmkit/sdk/internal";
import {
  setOutputTraceId,
} from "./output";

import { dvmFetch } from "./http";

export interface FeedbackSubmitResponse {
  id: string;
  created_at: string;
  dvm_id: string | null;
  job_id: string | null;
  tier?: "receipt_verified" | "claimed" | null;
}

export interface MintReliabilityRow {
  url: string;
  recent_failures_7d: number;
  last_check_at: string;
  consecutive_failures: number;
}

export async function submitFeedback(
  platformUrl: string,
  signedEnvelope: Record<string, unknown>
): Promise<FeedbackSubmitResponse> {
  const res = await callerPlatformFetch(`${platformUrl}/api/v1/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signedEnvelope),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string; display?: string; hint?: string };
    };
    throw callerPlatformResponseError(
      body.error?.code ?? "feedback_failed",
      body.error,
      `Feedback submission failed: ${res.status}`
    );
  }
  return (await res.json()) as FeedbackSubmitResponse;
}

export async function getMintReliability(platformUrl: string): Promise<MintReliabilityRow[]> {
  const res = await callerPlatformFetch(`${platformUrl}/api/v1/mint-health`);
  if (!res.ok) {
    throw new DvmError("mint_health_failed", `Failed to fetch mint reliability: ${res.status}`);
  }
  const body = (await res.json()) as { mints: MintReliabilityRow[] };
  return body.mints;
}

async function callerPlatformFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const attempts = method === "GET" || method === "HEAD" ? 3 : 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await dvmFetch(input, init);
      const traceparent = res.headers.get("traceparent");
      if (traceparent) {
        const parsed = parseTraceparent(traceparent);
        if (parsed) setOutputTraceId(parsed.traceId);
      }
      return res;
    } catch (err) {
      if (isAbortError(err) || err instanceof DvmError) throw err;
      lastError = err;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
  const cause = transportErrorCode(lastError);
  throw new DvmError(
    "platform_unreachable",
    `Could not reach the dvmkit platform after ${attempts} attempt${attempts === 1 ? "" : "s"}${cause ? ` (${cause})` : ""}.`,
    "Check the network connection and retry. No server response was received.",
    { attempts, method, ...(cause ? { transport_code: cause } : {}) }
  );
}

function callerPlatformResponseError(
  code: string,
  remote:
    | {
        message?: string;
        hint?: string;
        display?: string;
        data?: Record<string, unknown>;
      }
    | undefined,
  fallbackMessage: string
): DvmError {
  return new DvmError(
    code,
    remote?.message ?? fallbackMessage,
    remote?.hint,
    remote?.data,
    remote?.display,
    providerProseSources(remote, remote?.data)
  );
}
