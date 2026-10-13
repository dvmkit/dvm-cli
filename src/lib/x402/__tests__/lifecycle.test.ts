import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@dvmkit/sdk/internal", async () => ({
  ...(await vi.importActual<typeof import("@dvmkit/sdk/internal")>("@dvmkit/sdk/internal")),
  listX402Channels: vi.fn(),
}));
import { listX402Channels, type StoredX402ChannelMetadata, type DvmError } from "@dvmkit/sdk/internal";
import { assertX402WalletIdle } from "../lifecycle";

const PAYER = "0x1111111111111111111111111111111111111111";
const OTHER_PAYER = "0x2222222222222222222222222222222222222222";
const CHANNEL_ID = "0xaaaa000000000000000000000000000000000000000000000000000000000001";
const OTHER_CHANNEL_ID = "0xaaaa000000000000000000000000000000000000000000000000000000000002";
const WALLET = { address: PAYER, network: "eip155:8453" };

function channel(overrides: Partial<StoredX402ChannelMetadata> = {}): StoredX402ChannelMetadata {
  return {
    channelId: CHANNEL_ID,
    endpoint: "https://dvm.example",
    callerPubkey: "caller-pub",
    creditId: "credit-1",
    network: "eip155:8453",
    updatedAt: 1,
    ...overrides,
    config: {
      payer: PAYER,
      payerAuthorizer: PAYER,
      receiver: "0x3333333333333333333333333333333333333333",
      receiverAuthorizer: "0x3333333333333333333333333333333333333333",
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      withdrawDelay: 86_400,
      salt: "0xbbbb000000000000000000000000000000000000000000000000000000000001",
      ...overrides.config,
    },
  };
}

/** Give the store a channel set, honouring the payer filter the real one applies. */
function storeChannels(entries: StoredX402ChannelMetadata[]): void {
  vi.mocked(listX402Channels).mockImplementation((filter = {}) =>
    entries.filter(
      (entry) => !filter.payer || entry.config.payer.toLowerCase() === filter.payer.toLowerCase()
    )
  );
}

/** Stub viem's public client, returning one `(value, timestamp)` pair per view. */
function mockChainState(state: {
  channels?: readonly [bigint, bigint];
  pendingWithdrawals?: readonly [bigint, number];
  /** The contract's monotonic cooperative-refund counter. */
  refundNonce?: bigint;
  throws?: Error;
}) {
  const readContract = vi.fn(({ functionName }: { functionName: string }) => {
    if (state.throws) return Promise.reject(state.throws);
    if (functionName === "refundNonce") return Promise.resolve(state.refundNonce ?? 0n);
    return Promise.resolve(
      functionName === "channels"
        ? (state.channels ?? [0n, 0n])
        : (state.pendingWithdrawals ?? [0n, 0])
    );
  });
  const http = vi.fn((_url?: string) => "transport");
  const createPublicClient = vi.fn().mockReturnValue({ readContract });
  vi.doMock("viem", () => ({ createPublicClient, http }));
  return { readContract, http, createPublicClient };
}

const savedRpcUrl = process.env.DVM_X402_RPC_URL;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.DVM_X402_RPC_URL;
  storeChannels([]);
});

afterEach(() => {
  vi.doUnmock("viem");
  if (savedRpcUrl === undefined) delete process.env.DVM_X402_RPC_URL;
  else process.env.DVM_X402_RPC_URL = savedRpcUrl;
});

describe("assertX402WalletIdle", () => {
  it("passes when the payer has no channels at all", async () => {
    const { createPublicClient } = mockChainState({});
    await expect(assertX402WalletIdle(WALLET, "replace")).resolves.toBeUndefined();
    expect(createPublicClient).not.toHaveBeenCalled();
  });

  // A cooperatively drained channel keeps its metadata forever. Refusing on the
  // record alone would make the caller's first rotation impossible.
  it("passes when a persisted channel reads as terminal and empty onchain", async () => {
    storeChannels([channel()]);
    mockChainState({ channels: [0n, 4_000_000n], pendingWithdrawals: [0n, 0] });
    await expect(assertX402WalletIdle(WALLET, "replace")).resolves.toBeUndefined();
  });

  it("refuses while a channel still holds value, naming what has to be emptied", async () => {
    storeChannels([channel()]);
    mockChainState({ channels: [2_500_000n, 0n] });

    const err = (await assertX402WalletIdle(WALLET, "replace").catch(
      (e: DvmError) => e
    )) as DvmError;

    expect(err.code).toBe("x402_wallet_in_use");
    expect(err.message).toContain("2.50 USDC");
    expect(err.hint).toContain("dvm credit drain");
    expect(err.data).toMatchObject({
      anchor: "x402_channel_live",
      channel_id: CHANNEL_ID,
      endpoint: "https://dvm.example",
      network: "eip155:8453",
      balance_micro: "2500000",
    });
  });

  it("refuses while a timed withdrawal is still in flight on an emptied channel", async () => {
    storeChannels([channel()]);
    mockChainState({ channels: [0n, 0n], pendingWithdrawals: [1_000_000n, 1_700_000_000] });

    const err = (await assertX402WalletIdle(WALLET, "replace").catch(
      (e: DvmError) => e
    )) as DvmError;

    expect(err.code).toBe("x402_wallet_in_use");
    expect(err.data).toMatchObject({ pending_withdrawal_micro: "1000000" });
  });

  // The channel salt is derived from the payer, so a channel opened by an
  // earlier key can neither vouch for nor block the wallet configured today.
  it("ignores a live channel belonging to a different payer", async () => {
    storeChannels([channel({ config: { payer: OTHER_PAYER } as never })]);
    const { readContract } = mockChainState({ channels: [9_000_000n, 0n] });

    await expect(assertX402WalletIdle(WALLET, "replace")).resolves.toBeUndefined();
    expect(readContract).not.toHaveBeenCalled();
  });

  it("reads each channel on the network it was recorded on", async () => {
    storeChannels([channel({ network: "eip155:137" })]);
    const { createPublicClient } = mockChainState({});

    await assertX402WalletIdle(WALLET, "replace");

    expect(createPublicClient).toHaveBeenCalledWith(
      expect.objectContaining({ chain: expect.objectContaining({ id: 137 }) })
    );
  });

  // The settlement contract has one address on every chain, so a Base channel
  // read against a Polygon endpoint doesn't error — it finds a real contract,
  // misses the channel id and answers (0, 0), clearing a funded channel.
  it("keeps DVM_X402_RPC_URL scoped to the chain the wallet is pinned to", async () => {
    process.env.DVM_X402_RPC_URL = "https://base.example/rpc";
    storeChannels([
      channel({ network: "eip155:8453" }),
      channel({ channelId: OTHER_CHANNEL_ID, network: "eip155:137" }),
    ]);
    const { http } = mockChainState({});

    await assertX402WalletIdle(WALLET, "replace");

    expect(http).toHaveBeenCalledTimes(2);
    expect(http).toHaveBeenCalledWith("https://base.example/rpc");
    const polygonUrl = http.mock.calls
      .map(([u]) => u)
      .find((u) => u !== "https://base.example/rpc");
    expect(polygonUrl).toBeDefined();
    expect(polygonUrl).not.toContain("base.example");
  });

  it("says why the override did not apply when an off-chain channel fails to read", async () => {
    process.env.DVM_X402_RPC_URL = "https://base.example/rpc";
    storeChannels([channel({ network: "eip155:137" })]);
    mockChainState({ throws: new Error("timeout") });

    const err = (await assertX402WalletIdle(WALLET, "replace").catch(
      (e: DvmError) => e
    )) as DvmError;

    expect(err.code).toBe("x402_rpc_error");
    expect(err.hint).toContain("did not apply");
    expect(err.hint).toContain("The x402 wallet is untouched");
  });

  it("fails closed on a channel recorded for a chain it cannot read", async () => {
    storeChannels([channel({ network: "eip155:1" })]);
    mockChainState({});

    const err = (await assertX402WalletIdle(WALLET, "replace").catch(
      (e: DvmError) => e
    )) as DvmError;

    expect(err.code).toBe("x402_unsupported_network");
    expect(err.data).toMatchObject({ channel_id: CHANNEL_ID });
  });

  // An endpoint that didn't answer is not evidence the channel is empty.
  it("preserves the wallet and names the endpoint, redacted, when the read fails", async () => {
    process.env.DVM_X402_RPC_URL = "https://base.example/rpc/0123456789abcdef0123";
    storeChannels([channel()]);
    mockChainState({
      throws: new Error("fetch failed\n URL: https://base.example/rpc/0123456789abcdef0123"),
    });

    const err = (await assertX402WalletIdle(WALLET, "replace").catch(
      (e: DvmError) => e
    )) as DvmError;

    expect(err.code).toBe("x402_rpc_error");
    expect(err.hint).toContain("DVM_X402_RPC_URL");
    expect(err.hint).toContain("The x402 wallet is untouched");
    expect(`${err.message} ${err.hint ?? ""}`).not.toContain("0123456789abcdef0123");
    expect(err.hint).toContain("the key stays connected");
  });

  it("names the bundled endpoint when no override is set", async () => {
    storeChannels([channel()]);
    mockChainState({ throws: new Error("timeout") });

    const err = (await assertX402WalletIdle(WALLET, "disconnect").catch(
      (e: DvmError) => e
    )) as DvmError;

    expect(err.code).toBe("x402_rpc_error");
    expect(err.hint).toContain("Base");
    expect(err.hint).toContain("DVM_X402_RPC_URL");
  });
});

