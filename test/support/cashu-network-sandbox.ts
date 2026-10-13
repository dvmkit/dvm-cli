import { afterEach, beforeEach, expect, vi } from "vitest";

// These orchestration fixtures supply mint/HTTP boundaries. A caught transport
// error must still fail the fixture if it tried an unallocated live request.
if (["/wallet-agent/__tests__/", "/x402/__tests__/", "/payment-rails/__tests__/", "/wallet-probe.test.ts"].some((part) => expect.getState().testPath?.includes(part))) {
  const blockedFetch = vi.fn(() => Promise.reject(new Error("Live network is disabled in caller payment fixtures")));
  beforeEach(() => {
    blockedFetch.mockClear();
    vi.stubGlobal("fetch", blockedFetch);
  });
  afterEach(() => {
    try {
      expect(blockedFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
}
