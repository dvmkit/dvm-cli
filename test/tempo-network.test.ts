import type { MppxChallenge } from "@dvmkit/sdk/internal";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertTempoChallengeNetwork,
  resolveTempoNetworkSelection,
} from "../src/lib/tempo-network";

describe("Tempo wallet network selection", () => {
  const previousEnv = process.env.DVM_TEMPO_NETWORK;

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.DVM_TEMPO_NETWORK;
    else process.env.DVM_TEMPO_NETWORK = previousEnv;
  });

  it("keeps legacy wallets on mainnet and accepts either explicit network", () => {
    delete process.env.DVM_TEMPO_NETWORK;
    expect(resolveTempoNetworkSelection(undefined)).toBe("mainnet");
    expect(resolveTempoNetworkSelection("mainnet")).toBe("mainnet");
    expect(resolveTempoNetworkSelection("moderato")).toBe("moderato");
  });

  it("uses the environment equivalent and rejects conflicting or malformed input", () => {
    process.env.DVM_TEMPO_NETWORK = "moderato";
    expect(resolveTempoNetworkSelection(undefined)).toBe("moderato");
    expect(() => resolveTempoNetworkSelection("mainnet")).toThrowError(
      expect.objectContaining({ code: "tempo_network_conflict" })
    );
    expect(() => resolveTempoNetworkSelection("testnet", undefined)).toThrowError(
      expect.objectContaining({ code: "invalid_tempo_network" })
    );
  });

  it("refuses charge and session challenges for the other chain before signing", () => {
    for (const intent of ["charge", "session"] as const) {
      expect(() =>
        assertTempoChallengeNetwork([challenge(intent, 4217)], "moderato", [intent])
      ).toThrowError(
        expect.objectContaining({
          code: "tempo_network_mismatch",
          data: expect.objectContaining({
            wallet_network: "moderato",
            challenge_chain_id: 4217,
            payment_signed: false,
          }),
        })
      );
      expect(() =>
        assertTempoChallengeNetwork([challenge(intent, 42431)], "moderato", [intent])
      ).not.toThrow();
    }
  });

  it("treats an unstamped legacy challenge as mainnet", () => {
    expect(() =>
      assertTempoChallengeNetwork([challenge("charge")], "moderato", ["charge"])
    ).toThrowError(expect.objectContaining({ code: "tempo_network_mismatch" }));
    expect(() =>
      assertTempoChallengeNetwork([challenge("charge")], "mainnet", ["charge"])
    ).not.toThrow();
  });
});

function challenge(intent: "charge" | "session", chainId?: number): MppxChallenge {
  return {
    method: "tempo",
    intent,
    request: chainId === undefined ? {} : { methodDetails: { chainId } },
  } as unknown as MppxChallenge;
}
