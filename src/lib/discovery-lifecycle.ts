import { type NextAction } from "./next-action";
import {
  type Message,
  type ProviderRef,
  type Transport
} from "@dvmkit/sdk/internal";

import { createMessageAppendSession } from "./messages";
import { streamLoop } from "./stream-loop";

export interface DiscoveryLifecycleOptions {
  transport: Transport;
  provider: ProviderRef;
  capability: "search" | "browse";
  input: string;
  timeoutMs: number;
}

export interface DiscoveryLifecycleResult {
  summary?: string;
  messages: Message[];
  nextAction: NextAction;
}

export async function runDiscoveryLifecycle(
  options: DiscoveryLifecycleOptions
): Promise<DiscoveryLifecycleResult> {
  const { transport, provider, capability, input, timeoutMs } = options;
  const receipt = await transport.submit(provider, { capability, input });

  if (receipt.status === "completed" && receipt.summary) {
    return { summary: receipt.summary, messages: [], nextAction: null };
  }

  const deadline = Date.now() + timeoutMs;
  const messageAppendSession = createMessageAppendSession(receipt.jobId);
  const messages: Message[] = [];
  let result = await streamLoop({
    jobId: receipt.jobId,
    transport,
    provider,
    afterSeq: 0,
    timeoutMs: Math.max(1, deadline - Date.now()),
    messageAppendSession,
    jobToken: receipt.jobToken,
  });
  messages.push(...result.messages);

  while (result.nextAction?.type === "poll" && Date.now() < deadline) {
    const waitMs = Math.min(
      Math.max((result.nextAction.estimate_seconds ?? 0) * 1_000, 500),
      deadline - Date.now()
    );
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    if (Date.now() >= deadline) break;

    const next = await streamLoop({
      jobId: receipt.jobId,
      transport,
      provider,
      afterSeq: result.cursor,
      timeoutMs: Math.max(1, deadline - Date.now()),
      messageAppendSession,
      jobToken: receipt.jobToken,
    });
    if (next.messages.length === 0) break;
    messages.push(...next.messages);
    result = next;
  }

  const complete = messages.find((message) => message.type === "complete");
  const summary = complete?.content.summary;
  return { ...(summary ? { summary } : {}), messages, nextAction: result.nextAction };
}
