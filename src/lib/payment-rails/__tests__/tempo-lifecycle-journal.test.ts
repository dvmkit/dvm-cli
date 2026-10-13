import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { updateConfig } from "../../identity";

const ACCOUNT = {
  privateKey: `0x${"88".repeat(32)}` as `0x${string}`,
  address: `0x${"99".repeat(20)}` as `0x${string}`,
};

// Keep journal retirement real so the local guard observes the shared store.
describe("tempo-session unilateral exit", () => {
  async function seedChannel(opened = true, deposit = 100_000n) {
    const storeModule = await import("@dvmkit/sdk/internal");
    const endpoint = "https://wordcount.example";
    const callerPubkey = "aa".repeat(32);
    const creditId = "credit-exit";
    await storeModule.createTempoChannelStore({ endpoint, callerPubkey, creditId }).set({
      channelId: `0x${"11".repeat(32)}`,
      cumulativeAmount: 25_000n,
      deposit,
      descriptor: {
        payee: `0x${"22".repeat(20)}`,
        token: `0x${"33".repeat(20)}`,
        salt: `0x${"44".repeat(32)}`,
      },
      escrow: `0x${"55".repeat(20)}`,
      chainId: 42431,
      opened,
    } as never);
    const association = storeModule.loadTempoChannelAssociation(endpoint, callerPubkey, creditId);
    if (!association) expect.unreachable("seeded channel produced no association");
    return association;
  }

  async function associationSurvives(): Promise<boolean> {
    const storeModule = await import("@dvmkit/sdk/internal");
    return storeModule.listTempoChannelAssociations().length > 0;
  }

  /** Leave the association behind while removing mppx's only recovery descriptor. */
  function removeSeededDescriptor(): void {
    const file = join(process.env.DVM_CONFIG_DIR!, "tempo-channels.json");
    const stored = JSON.parse(readFileSync(file, "utf8")) as {
      values: Record<string, string>;
    };
    stored.values = {};
    writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
  }

  /** On-chain seam that advances state without touching a network. */
  function chainStub(closeRequestedAt = 0) {
    let state = { deposit: 100_000n, settled: 25_000n, closeRequestedAt };
    return {
      getChannelState: vi.fn(() => Promise.resolve(state)),
      requestCloseOnChain: vi.fn(() => {
        state = { ...state, closeRequestedAt: 100 };
        return Promise.resolve(`0x${"66".repeat(32)}`);
      }),
      waitForSuccessfulReceipt: vi.fn(() => Promise.resolve({ status: "success" })),
      withdrawOnChain: vi.fn(() => {
        state = { ...state, deposit: 0n };
        return Promise.resolve(`0x${"77".repeat(32)}`);
      }),
    };
  }

  it("retires a descriptor-less association on --abandon and releases the wallet guard", async () => {
    await updateConfig({ reason: "fixture", patch: () => ({ set: { tempo: { method: "tempo", apiKey: ACCOUNT.privateKey, network: "moderato" } } }) });
    const association = await seedChannel();
    removeSeededDescriptor();
    const chain = chainStub();
    const { advanceTempoChannelExit } = await import("@dvmkit/sdk/internal");
    const { assertTempoWalletIdle } = await import("../tempo-lifecycle");

    await expect(
      advanceTempoChannelExit({
        account: ACCOUNT,
        association,
        abandon: true,
        client: {} as never,
        chain: chain as never,
      })
    ).resolves.toEqual({
      status: "abandoned",
      descriptorMissing: true,
      channelId: association.channelId,
    });

    expect(chain.getChannelState).not.toHaveBeenCalled();
    expect(chain.requestCloseOnChain).not.toHaveBeenCalled();
    expect(chain.waitForSuccessfulReceipt).not.toHaveBeenCalled();
    expect(chain.withdrawOnChain).not.toHaveBeenCalled();
    await expect(associationSurvives()).resolves.toBe(false);
    await expect(assertTempoWalletIdle("disconnect")).resolves.toBeUndefined();
  });

});
