vi.mock("@dvmkit/sdk/internal", async () => {
 const actual = await vi.importActual<typeof import("@dvmkit/sdk/internal")>("@dvmkit/sdk/internal");
 return { ...actual, tempoChannelControlledBy: actual.tempoChannelControlledBy,
listTempoChannelAssociations: vi.fn(() => []),
loadTempoChannelController: vi.fn(),
reconcileTempoChannelOnChain: vi.fn() };
});
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../cli-identity-resolve", () => ({
  findSigningIdentityByPubkey: vi.fn(),
}));
// The ownership rule itself is the real one — restating it here would let the
// filter and the rule drift apart, and the rule is the whole fix.

vi.mock("../tempo-wallet", () => ({
  connectedTempoAccount: vi.fn(),
}));

import { findSigningIdentityByPubkey } from "../../cli-identity-resolve";
import { DvmError } from "@dvmkit/sdk/internal";
import { listTempoChannelAssociations, loadTempoChannelController, type TempoChannelAssociation } from "@dvmkit/sdk/internal";
import { assertTempoWalletIdle } from "../tempo-lifecycle";
import { reconcileTempoChannelOnChain,  type TempoChannelReconcileResult } from "@dvmkit/sdk/internal";
import { connectedTempoAccount } from "../tempo-wallet";

const ENDPOINT = "https://wordcount.example";
const CHANNEL_ID = `0x${"11".repeat(32)}` as const;
/** The Tempo key the config holds in every case below. */
const CONNECTED = `0x${"ab".repeat(20)}`;
/** The key that opened a channel and is no longer on this machine. */
const STRANGER = `0x${"cd".repeat(20)}`;

function association(overrides: Partial<TempoChannelAssociation> = {}): TempoChannelAssociation {
  return {
    endpoint: ENDPOINT,
    callerPubkey: "aa".repeat(32),
    creditId: "credit-exit",
    channelKey: "scope-key",
    operator: `0x${"22".repeat(20)}`,
    channelId: CHANNEL_ID,
    cumulativeAmount: "25000",
    deposit: "180000",
    chainId: 42431,
    opened: true,
    updatedAt: 1,
    ...overrides,
  };
}

function verdict(
  status: TempoChannelChainStatus,
  overrides: Partial<TempoChannelReconcileResult> = {}
): TempoChannelReconcileResult {
  return {
    status,
    retired: status === "closed",
    channelId: CHANNEL_ID,
    depositMicro: status === "open" || status === "closing" ? 2_500_000 : 0,
    settledMicro: status === "unreadable" ? 0 : 25_000,
    ...overrides,
  };
}

/**
 * Which wallet a seeded record's descriptor names: the connected key by
 * default, another key, or — for `null` — a record whose descriptor is gone.
 */
type SeededOwner = string | null;

/**
 * Give the store a record set with an owner each, and the escrow one verdict
 * per record.
 */
function escrowSays(
  entries: [TempoChannelAssociation, TempoChannelReconcileResult, SeededOwner?][]
): void {
  vi.mocked(listTempoChannelAssociations).mockReturnValue(entries.map(([record]) => record));
  const seeded = (creditId: string) => {
    const match = entries.find(([candidate]) => candidate.creditId === creditId);
    if (!match) expect.unreachable(`touched an unseeded record: ${creditId}`);
    return match;
  };
  vi.mocked(loadTempoChannelController).mockImplementation(async (record) => {
    const payer = seeded(record.creditId)[2];
    if (payer === null) return undefined;
    return { payer: payer ?? CONNECTED, authorizedSigner: payer ?? CONNECTED };
  });
  vi.mocked(reconcileTempoChannelOnChain).mockImplementation(
    async ({ association: record }) => seeded(record.creditId)[1]
  );
}

async function refusal(intent: "replace" | "disconnect" = "disconnect"): Promise<DvmError> {
  const err = await assertTempoWalletIdle(intent).catch((thrown: unknown) => thrown);
  expect(err).toBeInstanceOf(DvmError);
  return err as DvmError;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(connectedTempoAccount).mockResolvedValue({
    privateKey: `0x${"11".repeat(32)}`,
    address: CONNECTED as `0x${string}`,
  });
  vi.mocked(findSigningIdentityByPubkey).mockReturnValue({
    privkey: "bb".repeat(32),
    pubkey: "aa".repeat(32),
    source: { kind: "pubkey", name: "personal" },
  });
  escrowSays([]);
});

describe("assertTempoWalletIdle", () => {
  it("passes when no channel is recorded at all, without reading any chain", async () => {
    await expect(assertTempoWalletIdle("disconnect")).resolves.toBeUndefined();
    expect(reconcileTempoChannelOnChain).not.toHaveBeenCalled();
  });

  // The whole point: a cooperative close the caller was only told about leaves
  // its record behind, and counting records refused forever over money that is
  // already home.
  it("passes on a record the escrow reports closed, and lets the reconcile retire it", async () => {
    escrowSays([[association(), verdict("closed", { retired: true })]]);

    await expect(assertTempoWalletIdle("disconnect")).resolves.toBeUndefined();
    expect(reconcileTempoChannelOnChain).toHaveBeenCalledWith({
      association: expect.objectContaining({ creditId: "credit-exit" }),
    });
  });

  // The chain's verdict is what the gate rests on. Whether the local file write
  // that follows it succeeded is a separate fact, and not one that should keep
  // refusing over an escrow that holds nothing.
  it("passes on a closed channel whose record could not be retired", async () => {
    escrowSays([[association(), verdict("closed", { retired: false })]]);

    await expect(assertTempoWalletIdle("replace")).resolves.toBeUndefined();
  });

  it("refuses on a channel the escrow still funds, naming it and the collateral", async () => {
    escrowSays([[association(), verdict("open", { depositMicro: 2_500_000 })]]);

    const err = await refusal("disconnect");

    expect(err.code).toBe("tempo_channels_active");
    expect(err.message).toContain("$2.50");
    expect(err.message).toContain(ENDPOINT);
    // The credit id, not just the endpoint: a bare drain resolves whichever
    // credit is tracked there, which need not be this channel's.
    expect(err.hint).toContain(
      `dvm credit drain ${ENDPOINT} --credit-id credit-exit --as personal`
    );
    expect(err.hint).toContain(
      `dvm wallet tempo-exit ${ENDPOINT} --credit-id credit-exit --as personal`
    );
    expect(err.hint).toContain("retry 'dvm wallet tempo-disconnect'");
    expect(err.data).toMatchObject({
      anchor: "tempo_channel_live",
      endpoint: ENDPOINT,
      credit_id: "credit-exit",
      channel_id: CHANNEL_ID,
      chain_id: 42431,
      chain_status: "open",
      deposit_micro: 2_500_000,
      settled_micro: 25_000,
      blocking_channels: 1,
    });
  });

  it("names the replacement rather than the disconnect when that is what was attempted", async () => {
    escrowSays([[association(), verdict("open")]]);

    expect((await refusal("replace")).hint).toContain("retry the replacement");
  });

  it("refuses on a close already requested on-chain, pointing at the exit", async () => {
    escrowSays([[association(), verdict("closing", { depositMicro: 1_000_000 })]]);

    const err = await refusal();

    expect(err.code).toBe("tempo_channels_active");
    expect(err.message).toContain("grace period");
    expect(err.hint).toContain(
      `dvm wallet tempo-exit ${ENDPOINT} --credit-id credit-exit --as personal`
    );
    expect(err.data).toMatchObject({ chain_status: "closing", deposit_micro: 1_000_000 });
  });

  // A provisional open still refuses — it may yet land, and the record is what
  // would close its deposit — so the refusal has to name the way back out.
  it("refuses on a provisional record and names --abandon, reporting the committed deposit", async () => {
    escrowSays([[association({ deposit: "180000" }), verdict("unconfirmed", { depositMicro: 0 })]]);

    const err = await refusal();

    expect(err.code).toBe("tempo_channels_active");
    // The chain's zero is an absence here, not a balance: the figure that says
    // what this wallet committed is the record's own.
    expect(err.message).toContain("$0.18");
    expect(err.hint).toContain(
      `dvm wallet tempo-exit ${ENDPOINT} --credit-id credit-exit --as personal --abandon`
    );
    expect(err.hint).toContain(`dvm credit fund ${ENDPOINT} --credit-id credit-exit --as personal`);
    expect(err.data).toMatchObject({ chain_status: "unconfirmed", deposit_micro: 180_000 });
  });

  // An endpoint that didn't answer is not evidence the channel is empty, and it
  // is a different fact from money being locked — so it keeps its own code.
  it("refuses on an unreadable chain in the rail's read-failure dialect", async () => {
    escrowSays([
      [
        association(),
        verdict("unreadable", {
          depositMicro: 180_000,
          error: new DvmError(
            "tempo_rpc_error",
            "The Tempo channel state could not be read: fetch failed",
            "Verify connectivity to Tempo's bundled endpoint (https://rpc.example)."
          ),
        }),
      ],
    ]);

    const err = await refusal("replace");

    expect(err.code).toBe("tempo_rpc_error");
    expect(err.message).toContain(ENDPOINT);
    expect(err.message).toContain("fetch failed");
    expect(err.hint).toContain("Verify connectivity to Tempo's bundled endpoint");
    expect(err.hint).toContain("The Tempo key is untouched");
    expect(err.hint).toContain("retry the replacement");
    expect(err.data).toMatchObject({ chain_status: "unreadable", deposit_micro: 180_000 });
    // Nothing was read, so there is no settled figure to report.
    expect(err.data).not.toHaveProperty("settled_micro");
  });

  it("still refuses when an unreadable verdict carries no reason at all", async () => {
    escrowSays([[association(), verdict("unreadable")]]);

    expect((await refusal()).code).toBe("tempo_chain_read_failed");
  });

  it("names no unusable cleanup command when the channel's caller identity is gone", async () => {
    vi.mocked(findSigningIdentityByPubkey).mockReturnValue(null);
    escrowSays([[association(), verdict("open")]]);

    const err = await refusal();

    expect(err.hint).toContain(association().callerPubkey);
    expect(err.hint).toContain("Restore that identity first");
    expect(err.hint).not.toContain("dvm credit drain");
    expect(err.hint).not.toContain("dvm wallet tempo-exit");
  });

  it("treats a missing descriptor as a local repair, not a transient RPC failure", async () => {
    escrowSays([
      [
        association(),
        verdict("unreadable", {
          depositMicro: 180_000,
          error: new DvmError(
            "tempo_channel_not_found",
            "The Tempo channel record has no stored descriptor."
          ),
        }),
      ],
    ]);

    const err = await refusal();

    expect(err.code).toBe("tempo_channel_not_found");
    expect(err.message).toContain("no stored descriptor");
    expect(err.hint).toContain(
      `dvm wallet tempo-exit ${ENDPOINT} --credit-id credit-exit --as personal --abandon`
    );
    expect(err.hint).toContain("without broadcasting anything");
    expect(err.hint).not.toContain("Restore the chain read");
    expect(err.data).toMatchObject({
      anchor: "tempo_channel_descriptor_missing",
      chain_status: "unreadable",
      blocking_channels: 1,
    });
  });

  it("does not name a descriptor-less cleanup command when its caller identity is gone", async () => {
    vi.mocked(findSigningIdentityByPubkey).mockReturnValue(null);
    escrowSays([
      [
        association(),
        verdict("unreadable", {
          error: new DvmError(
            "tempo_channel_not_found",
            "The Tempo channel record has no stored descriptor."
          ),
        }),
      ],
    ]);

    const err = await refusal();

    expect(err.hint).toContain(association().callerPubkey);
    expect(err.hint).toContain("Restore that identity first");
    expect(err.hint).not.toContain("dvm wallet tempo-exit");
  });

  // Every record is confirmed even on a run that ends in a refusal, so the
  // closed siblings are retired and the next attempt has less in its way.
  it("reconciles every record before refusing, and counts what is left", async () => {
    escrowSays([
      [association({ creditId: "credit-closed" }), verdict("closed", { retired: true })],
      [association({ creditId: "credit-unreadable" }), verdict("unreadable")],
      [association({ creditId: "credit-open" }), verdict("open")],
    ]);

    const err = await refusal();

    expect(reconcileTempoChannelOnChain).toHaveBeenCalledTimes(3);
    // The one the escrow confirms it funds is the one to act on first, whatever
    // order the records came back in.
    expect(err.code).toBe("tempo_channels_active");
    expect(err.data).toMatchObject({ credit_id: "credit-open", blocking_channels: 2 });
    expect(err.hint).toContain("1 other recorded channel still blocks this");
  });

  it("prefers a provisional record over one it could not read", async () => {
    escrowSays([
      [association({ creditId: "credit-unreadable" }), verdict("unreadable")],
      [association({ creditId: "credit-provisional" }), verdict("unconfirmed")],
    ]);

    const err = await refusal();

    expect(err.code).toBe("tempo_channels_active");
    expect(err.data).toMatchObject({ credit_id: "credit-provisional", blocking_channels: 2 });
  });
});

describe("assertTempoWalletIdle — whose channel it is", () => {
  it("passes over a live channel another Tempo key opened, without reading its chain", async () => {
    escrowSays([[association(), verdict("open", { depositMicro: 100_240 }), STRANGER]]);

    await expect(assertTempoWalletIdle("replace")).resolves.toBeUndefined();
    await expect(assertTempoWalletIdle("disconnect")).resolves.toBeUndefined();
    expect(reconcileTempoChannelOnChain).not.toHaveBeenCalled();
  });

  // The acceptance case: one of each, and exactly one of them is the caller's
  // problem. The count has to agree, or the remedy copy sends an agent looking
  // for a second channel to empty that it can never empty.
  it("refuses over the owned channel only, and counts only owned records as blocking", async () => {
    escrowSays([
      [association({ creditId: "credit-foreign" }), verdict("open"), STRANGER],
      [association({ creditId: "credit-owned" }), verdict("open")],
    ]);

    const err = await refusal();

    expect(err.code).toBe("tempo_channels_active");
    expect(err.data).toMatchObject({ credit_id: "credit-owned", blocking_channels: 1 });
    expect(err.hint).not.toContain("other recorded channel");
    expect(reconcileTempoChannelOnChain).toHaveBeenCalledTimes(1);
  });

  // The descriptor is where ownership is written, so a record without one says
  // nothing about whose it is. Guessing "a stranger's" would drop the key over
  // a channel it may well own, which is the failure this guard exists to stop.
  it("keeps refusing over a record whose descriptor is gone", async () => {
    escrowSays([
      [
        association(),
        verdict("unreadable", {
          error: new DvmError(
            "tempo_channel_not_found",
            "The Tempo channel record has no stored descriptor."
          ),
        }),
        null,
      ],
    ]);

    expect((await refusal()).code).toBe("tempo_channel_not_found");
  });

  // A `tempo` block whose apiKey is not a key is the broken config `dvm doctor`
  // diagnoses, and clearing it is the repair. There is no signing authority to
  // protect, so the gate has nothing to weigh.
  it("passes when no Tempo key is derivable from the config at all", async () => {
    vi.mocked(connectedTempoAccount).mockResolvedValue(null);
    escrowSays([[association(), verdict("open")]]);

    await expect(assertTempoWalletIdle("disconnect")).resolves.toBeUndefined();
    expect(listTempoChannelAssociations).not.toHaveBeenCalled();
    expect(reconcileTempoChannelOnChain).not.toHaveBeenCalled();
  });

  // A descriptor read that throws is not an answer. Failing open on it would
  // release the key slot over collateral the guard never established was gone.
  it("keeps refusing over a record whose stored entry cannot be parsed", async () => {
    escrowSays([[association(), verdict("open")]]);
    vi.mocked(loadTempoChannelController).mockRejectedValue(new Error("entry is not JSON"));

    expect((await refusal()).code).toBe("tempo_channels_active");
  });

  // The descriptor can delegate voucher signing away from the payer. Either
  // role can still commit the deposit, so either one keeps the record blocking.
  it("treats the delegated voucher signer as an owner too", async () => {
    escrowSays([[association(), verdict("open")]]);
    vi.mocked(loadTempoChannelController).mockResolvedValue({
      payer: STRANGER,
      authorizedSigner: CONNECTED.toUpperCase(),
    });

    expect((await refusal()).code).toBe("tempo_channels_active");
  });
});

type TempoChannelChainStatus = TempoChannelReconcileResult["status"];
