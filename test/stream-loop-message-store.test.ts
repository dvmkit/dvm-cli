import type { Message, ProviderRef, Transport } from "@dvmkit/sdk/internal";
import { describe, expect, it, vi } from "vitest";

import type { MessageAppendSession } from "../src/lib/messages";
import { streamLoop } from "../src/lib/stream-loop";

describe("stream loop message persistence", () => {
  it("reuses a caller-scoped journal session across polling re-entries", async () => {
    const first = message(1);
    const second = message(2);
    const append = vi.fn<MessageAppendSession["append"]>();
    const messageAppendSession = { append };
    const transport = {
      getMessages: vi.fn().mockResolvedValueOnce([first]).mockResolvedValueOnce([second]),
    } as unknown as Transport;
    const provider = { endpoint: "https://dvm.example" } as ProviderRef;

    const firstResult = await streamLoop({
      jobId: "job-1",
      transport,
      provider,
      afterSeq: 0,
      messageAppendSession,
    });
    const secondResult = await streamLoop({
      jobId: "job-1",
      transport,
      provider,
      afterSeq: firstResult.cursor,
      messageAppendSession,
    });

    expect(append).toHaveBeenNthCalledWith(1, [first]);
    expect(append).toHaveBeenNthCalledWith(2, [second]);
    expect(firstResult.messages).toEqual([first]);
    expect(secondResult.messages).toEqual([second]);
    expect(secondResult.cursor).toBe(2);
  });
});

function message(seq: number): Message {
  return {
    seq,
    from: "provider",
    timestamp: seq,
    type: "complete",
    content: { summary: `complete-${String(seq)}` },
  };
}
