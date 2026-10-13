import { beforeAll, describe, expect, it, vi } from "vitest";

import { DvmError } from "@dvmkit/sdk/internal";
import type { MppxChallenge } from "@dvmkit/sdk/internal";

function tempoChallenge(amount = "1000000"): MppxChallenge {
  return {
    id: "ch_test",
    realm: "test",
    method: "tempo",
    intent: "charge",
    request: { amount, currency: "0x20C0", recipient: "0x" + "a".repeat(40) },
  } as MppxChallenge;
}

/** Stand in for mppx's signer so a test can observe whether signing happened at all. */
function mockMppx(): { signed: () => boolean } {
  let signed = false;
  vi.doMock("mppx/client", () => ({
    tempo: {
      charge: () => ({
        createCredential: async () => {
          signed = true;
          return "serialized-credential";
        },
      }),
    },
  }));
  vi.doMock("mppx", async (orig) => {
    const real = (await orig()) as Record<string, unknown>;
    return {
      ...real,
      Credential: { deserialize: (s: string) => ({ kind: "credential", raw: s }) },
    };
  });
  return { signed: () => signed };
}

beforeAll(async () => {
  await Promise.all([vi.importActual("mppx"), import("viem/accounts")]);
});

describe("buildTempoCredential", () => {
  it("returns null when no Tempo challenge is in the list", async () => {
    const { buildTempoCredential } = await import("../tempo-credential");
    const result = await buildTempoCredential({
      challenges: [
        {
          id: "ch_stripe",
          realm: "test",
          method: "stripe",
          intent: "charge",
          request: {},
        } as MppxChallenge,
      ],
      privateKey: "0x" + "a".repeat(64),
      basisMicro: 1_000_000,
    });
    expect(result).toBeNull();
  });

  it("returns null when privateKey is malformed (onError=null)", async () => {
    const { buildTempoCredential } = await import("../tempo-credential");
    const result = await buildTempoCredential({
      challenges: [tempoChallenge()],
      privateKey: "not-a-hex-key",
      basisMicro: 1_000_000,
      onError: "null",
    });
    expect(result).toBeNull();
  });

  it("refuses an out-of-range scalar before constructing a signer", async () => {
    const { buildTempoCredential } = await import("../tempo-credential");

    await expect(
      buildTempoCredential({
        challenges: [tempoChallenge()],
        privateKey: `0x${"0".repeat(64)}`,
        basisMicro: 1_000_000,
        onError: "throw",
      })
    ).rejects.toMatchObject({ code: "tempo_credential_failed" });
  });

  // This one fires mid-payment, and its hint is a command an agent will run
  // verbatim. It used to hand back `tempo-connect --api-key 0x...`, so the
  // repair for a broken key put the replacement key on argv.
  it("repairs the key through a route that keeps it off argv", async () => {
    const { buildTempoCredential } = await import("../tempo-credential");
    const err = (await buildTempoCredential({
      challenges: [tempoChallenge()],
      privateKey: "not-a-hex-key",
      basisMicro: 1_000_000,
      onError: "throw",
    }).catch((e: unknown) => e)) as DvmError;

    expect(err).toBeInstanceOf(DvmError);
    expect(err.code).toBe("tempo_credential_failed");
    expect(err.hint).toContain("--key-file <path>");
    expect(err.hint).toContain("DVM_TEMPO_KEY");
    // Named as the leaky route, never as the repair to run.
    expect(err.hint).not.toMatch(/tempo-connect --api-key/);
  });

  it("calls mppx tempo.charge with the matching challenge and returns the deserialized credential", async () => {
    let captured: { challenge?: unknown; context?: unknown } = {};
    vi.doMock("mppx/client", () => ({
      tempo: {
        charge: ({ account }: { account: unknown }) => ({
          createCredential: async (args: { challenge: unknown; context: unknown }) => {
            captured = {
              challenge: args.challenge,
              context: { account, ...(args.context as object) },
            };
            return "serialized-credential";
          },
        }),
      },
    }));
    vi.doMock("mppx", async (orig) => {
      const real = (await orig()) as Record<string, unknown>;
      return {
        ...real,
        Credential: { deserialize: (s: string) => ({ kind: "credential", raw: s }) },
      };
    });

    const { buildTempoCredential } = await import("../tempo-credential");
    const selected = tempoChallenge();
    const result = await buildTempoCredential({
      challenges: [{ ...selected, method: "stripe" }, { ...selected, intent: "session" }, selected],
      privateKey: "0x" + "a".repeat(64),
      basisMicro: 1_000_000,
    });
    expect(result).toMatchObject({ kind: "credential", raw: "serialized-credential" });
    expect(captured.challenge).toBe(selected);
    expect((captured.context as { account: { address: string } }).account.address.toLowerCase())
      .toBe("0x8fd379246834eac74b8419ffda202cf8051f7a03");

    vi.doUnmock("mppx/client");
    vi.doUnmock("mppx");
  });
});

describe("buildTempoCredential amount ceiling", () => {
  it("refuses a challenge more than 10% above the caller's basis, before signing", async () => {
    const mppx = mockMppx();
    const { buildTempoCredential } = await import("../tempo-credential");
    await expect(
      buildTempoCredential({
        challenges: [tempoChallenge("1100001")],
        privateKey: "0x" + "a".repeat(64),
        basisMicro: 1_000_000,
        onError: "throw",
      })
    ).rejects.toMatchObject({
      code: "tempo_amount_exceeds_limit",
      data: {
        advertised_usdc_microunits: "1100001",
        local_usdc_microunits: "1000000",
        max_usdc_microunits: "1100000",
      },
    });
    expect(mppx.signed()).toBe(false);

    vi.doUnmock("mppx/client");
    vi.doUnmock("mppx");
  });

  it("signs an advertisement exactly at the tolerance boundary", async () => {
    const mppx = mockMppx();
    const { buildTempoCredential } = await import("../tempo-credential");
    const result = await buildTempoCredential({
      challenges: [tempoChallenge("1100000")],
      privateKey: "0x" + "a".repeat(64),
      basisMicro: 1_000_000,
      onError: "throw",
    });
    expect(result).toMatchObject({ kind: "credential" });
    expect(mppx.signed()).toBe(true);

    vi.doUnmock("mppx/client");
    vi.doUnmock("mppx");
  });

  it("refuses an amount that isn't a positive integer of micro-units", async () => {
    const { buildTempoCredential } = await import("../tempo-credential");
    await expect(
      buildTempoCredential({
        challenges: [tempoChallenge("1.10")],
        privateKey: "0x" + "a".repeat(64),
        basisMicro: 1_000_000,
        onError: "throw",
      })
    ).rejects.toMatchObject({ code: "tempo_amount_invalid" });
  });

  it("falls through to null on an over-charge when onError is null (mid-job)", async () => {
    const mppx = mockMppx();
    const { buildTempoCredential } = await import("../tempo-credential");
    const result = await buildTempoCredential({
      challenges: [tempoChallenge("50000000")],
      privateKey: "0x" + "a".repeat(64),
      basisMicro: 1_000_000,
      onError: "null",
    });
    expect(result).toBeNull();
    expect(mppx.signed()).toBe(false);

    vi.doUnmock("mppx/client");
    vi.doUnmock("mppx");
  });
});

