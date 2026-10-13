import type { TempoAccount } from "@dvmkit/sdk/internal";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getVerifiedTempoBalance } from "../src/lib/tempo-rpc";

const account = {
  method: "tempo",
  privateKey: `0x${"33".repeat(32)}`,
  address: "0x3333333333333333333333333333333333333333",
  network: "moderato",
} as TempoAccount;

describe("Tempo balance RPC preflight", () => {
  const previousRpc = process.env.DVM_TEMPO_RPC_URL;

  afterEach(() => {
    if (previousRpc === undefined) delete process.env.DVM_TEMPO_RPC_URL;
    else process.env.DVM_TEMPO_RPC_URL = previousRpc;
  });

  it("reads the balance only after the configured RPC proves the selected chain", async () => {
    process.env.DVM_TEMPO_RPC_URL = "https://moderato-rpc.example";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response("0xa5bf"));
    const readBalance = vi.fn().mockResolvedValue({
      address: account.address,
      chainId: 42431,
      tokenAddress: "0x20c0000000000000000000000000000000000000",
      usdc: 5,
      rawBaseUnits: 5_000_000n,
    });

    await getVerifiedTempoBalance(account, { fetchImpl, readBalance });
    expect(fetchImpl.mock.invocationCallOrder[0]).toBeLessThan(readBalance.mock.invocationCallOrder[0]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://moderato-rpc.example");
    expect(readBalance).toHaveBeenCalledOnce();
  });

  it("rejects a wrong-chain RPC before reading or labeling its balance", async () => {
    process.env.DVM_TEMPO_RPC_URL = "https://wrong-chain.example";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response("0x1079"));
    const readBalance = vi.fn();

    await expect(getVerifiedTempoBalance(account, { fetchImpl, readBalance })).rejects.toMatchObject({
      code: "tempo_rpc_network_mismatch",
      data: { expected_chain_id: 42431, actual_chain_id: 4217 },
    });
    expect(readBalance).not.toHaveBeenCalled();
  });
});

function response(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
