import { describe, expect, it } from "vitest";

import { completionFromMessages, completionSnapshot } from "../src/lib/completion-hints";
import type { Message } from "@dvmkit/sdk/internal";

function msg(seq: number, type: Message["type"], content: Record<string, unknown> = {}): Message {
  return { seq, from: "provider", timestamp: seq, type, content } as Message;
}

describe("completionSnapshot", () => {
  it("keeps the fields the provider sent and drops the ones it didn't", () => {
    expect(
      completionSnapshot({
        summary: "done",
        hasArtifacts: true,
        artifactCount: 2,
        payloadIn: "messages",
      })
    ).toEqual({ summary: "done", hasArtifacts: true, artifactCount: 2, payloadIn: "messages" });

    expect(completionSnapshot({ message: "boom" })).toEqual({ message: "boom" });
    expect(completionSnapshot({})).toEqual({});
    expect(completionSnapshot({ hasArtifacts: false })).toEqual({ hasArtifacts: false });
  });

});

describe("completionFromMessages", () => {
  it("points the payload at the artifacts when the provider emitted any", () => {
    const log = [
      msg(1, "artifact", { name: "a.md" }),
      msg(2, "artifact", { name: "b.md" }),
      msg(3, "complete", { summary: "scraped 2 pages" }),
    ];

    expect(completionFromMessages(log)).toEqual({
      summary: "scraped 2 pages",
      hasArtifacts: true,
      artifactCount: 2,
      payloadIn: "messages",
    });
  });

  it("points the payload at the summary when there are no artifacts", () => {
    const log = [
      msg(1, "progress", { percent_complete: 50 }),
      msg(2, "complete", { summary: "hi" }),
    ];

    expect(completionFromMessages(log)).toEqual({
      summary: "hi",
      hasArtifacts: false,
      payloadIn: "summary",
    });
  });

  it("omits the summary when the terminal message carries none (e.g. a cancel)", () => {
    expect(
      completionFromMessages([msg(1, "cancel", { reason: "caller changed their mind" })])
    ).toEqual({ hasArtifacts: false, payloadIn: "summary" });
  });
});
