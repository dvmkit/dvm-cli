import { normalizeProviderEndpoint, sameEndpoint } from "./provider-endpoint";
import { createHash } from "node:crypto";
import type { Message, OutboundMessage } from "@dvmkit/sdk/internal";
import { loadJob, recordCallerMessageHash } from "./job-store";

const callerMessages = new WeakSet<Message>();
const sentHashes = new Map<string, Set<string>>();

// Hash only payloads we sent locally, never a sender label or metadata from the wire.
function payloadHash(message: Pick<Message, "type" | "content"> | OutboundMessage): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]),
    );
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical({ type: message.type, content: message.content }))).digest("hex");
}

export function rememberCallerMessage(jobId: string, endpoint: string, message: OutboundMessage): void {
  const hash = payloadHash(message);
  const key = JSON.stringify([normalizeProviderEndpoint(endpoint), jobId]);
  const hashes = sentHashes.get(key) ?? new Set<string>();
  hashes.add(hash);
  sentHashes.set(key, hashes);
  const job = loadJob(jobId);
  if (job && sameEndpoint(job.endpoint, endpoint)) recordCallerMessageHash(jobId, endpoint, hash);
}

export function callerMessageRecognizer(jobId: string, endpoint: string): (message: Message) => Message {
  const job = loadJob(jobId);
  const hashes = new Set([
    ...(sentHashes.get(JSON.stringify([normalizeProviderEndpoint(endpoint), jobId])) ?? []),
    ...(job && sameEndpoint(job.endpoint, endpoint) ? job.callerMessageHashes ?? [] : []),
  ]);
  return (message) => {
    if (message.from === "requester" && hashes.has(payloadHash(message))) callerMessages.add(message);
    return message;
  };
}

export function isCallerMessage(message: Message): boolean {
  return callerMessages.has(message);
}
