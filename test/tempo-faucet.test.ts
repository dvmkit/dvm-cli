import { TEMPO_MODERATO_RPC, type TempoAccount } from "@dvmkit/sdk/internal";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fundTempoFromFaucet } from "../src/lib/tempo-faucet";

const account = {
  method: "tempo",
  privateKey: `0x${"11".repeat(32)}`,
  address: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD",
  network: "moderato",
} as TempoAccount;

describe("Tempo Moderato faucet", () => {
  const previousRpc = process.env.DVM_TEMPO_RPC_URL;

  afterEach(() => {
    if (previousRpc === undefined) delete process.env.DVM_TEMPO_RPC_URL;
    else process.env.DVM_TEMPO_RPC_URL = previousRpc;
  });

  it("checks the RPC chain, requests the lowercase address, and reports the observed grant", async () => {
    process.env.DVM_TEMPO_RPC_URL = "https://balance-rpc.example";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response("0xa5bf"))
      .mockResolvedValueOnce(response("0xa5bf"))
      .mockResolvedValueOnce(response("0xfeed", 2))
      .mockResolvedValueOnce(response("0xa5bf"))
      .mockResolvedValueOnce(response("0xa5bf"));
    const readBalance = vi
      .fn()
      .mockResolvedValueOnce(balance(5_000_000n))
      .mockResolvedValueOnce(balance(5_000_000n))
      .mockResolvedValueOnce(balance(1_005_000_000_000n));

    const result = await fundTempoFromFaucet(account, {
      fetchImpl,
      readBalance,
      sleep: async () => undefined,
      intervalMs: 0,
    });

    expect(result.grantedBaseUnits).toBe(1_004_995_000_000n);
    expect(result.granted).toBe(1_004_995);
    expect(result.attempts).toBe(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://balance-rpc.example");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(TEMPO_MODERATO_RPC);
    expect(fetchImpl.mock.calls[2]?.[0]).toBe(TEMPO_MODERATO_RPC);
    expect(rpcBody(fetchImpl, 1)).toMatchObject({ method: "eth_chainId", params: [] });
    expect(rpcBody(fetchImpl, 2)).toMatchObject({
      method: "tempo_fundAddress",
      params: [account.address.toLowerCase()],
    });
  });

  it("does not call tempo_fundAddress when the official faucet endpoint answers for the wrong chain", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response("0xa5bf"))
      .mockResolvedValueOnce(response("0x1079"));
    const readBalance = vi.fn().mockResolvedValue(balance(0n));

    await expect(
      fundTempoFromFaucet(account, { fetchImpl, readBalance })
    ).rejects.toMatchObject({
      code: "tempo_rpc_network_mismatch",
    });
    expect(readBalance).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every((call) => rpcBodyFromCall(call).method !== "tempo_fundAddress"))
      .toBe(true);
  });

  it("bounds confirmation polling after an accepted faucet request", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response("0xa5bf"))
      .mockResolvedValueOnce(response("0xa5bf"))
      .mockResolvedValueOnce(response("0xfeed", 2))
      .mockImplementation(() => Promise.resolve(response("0xa5bf")));
    const readBalance = vi.fn().mockResolvedValue(balance(7_000_000n));

    await expect(
      fundTempoFromFaucet(account, {
        fetchImpl,
        readBalance,
        sleep: async () => undefined,
        attempts: 3,
        intervalMs: 0,
      })
    ).rejects.toMatchObject({
      code: "tempo_faucet_balance_unconfirmed",
      hint: expect.stringContaining("Do not request again blindly"),
    });
    expect(readBalance).toHaveBeenCalledTimes(4);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("classifies malformed JSON as an unknown outcome without polling or requesting again", async () => {
    const fetchImpl = faucetFetch(new Response("{", { status: 200 }));
    const readBalance = vi.fn().mockResolvedValue(balance(7_000_000n));

    await expect(fundTempoFromFaucet(account, { fetchImpl, readBalance })).rejects.toMatchObject({
      code: "tempo_faucet_outcome_unknown",
      message: expect.stringContaining("invalid JSON-RPC response"),
      hint: expect.stringMatching(/Do not request again blindly.*dvm wallet balance/),
      data: {
        status: "unknown",
        reason: "malformed_json",
        network: "moderato",
        chain_id: 42431,
        token: "0x20c0000000000000000000000000000000000000",
      },
    });
    expect(readBalance).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fundingRequestCount(fetchImpl)).toBe(1);
  });

  it.each([
    ["null", null, "response_not_object"],
    ["an array", [], "response_not_object"],
    ["a primitive", "accepted", "response_not_object"],
    ["a missing result/error member", { jsonrpc: "2.0", id: 2 }, "missing_result_or_error"],
    [
      "the wrong JSON-RPC version",
      { jsonrpc: "1.0", id: 2, result: null },
      "invalid_jsonrpc_version",
    ],
    ["the wrong id", { jsonrpc: "2.0", id: 1, result: null }, "mismatched_id"],
    [
      "both result and error",
      { jsonrpc: "2.0", id: 2, result: null, error: { code: -1, message: "no" } },
      "result_and_error",
    ],
    [
      "an error without a numeric code",
      { jsonrpc: "2.0", id: 2, error: { code: "-1", message: "no" } },
      "invalid_error_object",
    ],
    [
      "an error without a string message",
      { jsonrpc: "2.0", id: 2, error: { code: -1, message: null } },
      "invalid_error_object",
    ],
  ])("rejects %s without entering balance polling", async (_label, payload, reason) => {
    const fetchImpl = faucetFetch(envelope(payload));
    const readBalance = vi.fn().mockResolvedValue(balance(7_000_000n));

    await expect(fundTempoFromFaucet(account, { fetchImpl, readBalance })).rejects.toMatchObject({
      code: "tempo_faucet_outcome_unknown",
      hint: expect.stringMatching(/Do not request again blindly.*dvm wallet balance/),
      data: { status: "unknown", reason },
    });
    expect(readBalance).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fundingRequestCount(fetchImpl)).toBe(1);
  });

  it("surfaces a valid JSON-RPC error as a faucet refusal", async () => {
    const fetchImpl = faucetFetch(
      envelope({
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32029, message: "rate limit exceeded", data: { retryAfter: 60 } },
      })
    );
    const readBalance = vi.fn().mockResolvedValue(balance(7_000_000n));

    await expect(fundTempoFromFaucet(account, { fetchImpl, readBalance })).rejects.toMatchObject({
      code: "tempo_faucet_refused",
      message: "Tempo faucet RPC refused the request (-32029): rate limit exceeded.",
    });
    expect(readBalance).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fundingRequestCount(fetchImpl)).toBe(1);
  });

  it.each([
    ["null", null],
    ["a boolean", false],
    ["a number", 0],
    ["an object", { accepted: true }],
    ["an array", ["accepted"]],
  ])("preserves %s as a method-defined success result", async (_label, result) => {
    const fetchImpl = faucetFetch(envelope({ jsonrpc: "2.0", id: 2, result })).mockResolvedValueOnce(
      response("0xa5bf")
    );
    const readBalance = vi
      .fn()
      .mockResolvedValueOnce(balance(7_000_000n))
      .mockResolvedValueOnce(balance(8_000_000n));

    await expect(
      fundTempoFromFaucet(account, { fetchImpl, readBalance, sleep: async () => undefined })
    ).resolves.toMatchObject({ grantedBaseUnits: 1_000_000n, attempts: 1 });
    expect(fundingRequestCount(fetchImpl)).toBe(1);
  });

  it("refuses a mainnet account without any balance or network request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const readBalance = vi.fn();
    await expect(
      fundTempoFromFaucet({ ...account, network: "mainnet" }, { fetchImpl, readBalance })
    ).rejects.toMatchObject({ code: "tempo_faucet_mainnet_refused" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readBalance).not.toHaveBeenCalled();
  });
});

function response(result: unknown, id = 1): Response {
  return envelope({ jsonrpc: "2.0", id, result });
}

function envelope(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function faucetFetch(faucetResponse: Response) {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response("0xa5bf"))
    .mockResolvedValueOnce(response("0xa5bf"))
    .mockResolvedValueOnce(faucetResponse);
}

function balance(rawBaseUnits: bigint) {
  return { address: account.address, usdc: Number(rawBaseUnits) / 1e6, rawBaseUnits };
}

function rpcBody(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>, index: number) {
  const init = fetchImpl.mock.calls[index]?.[1];
  return JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
}

function rpcBodyFromCall(call: [URL | RequestInfo, RequestInit?]) {
  return JSON.parse(String(call[1]?.body)) as { method: string; params: unknown[] };
}

function fundingRequestCount(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>): number {
  return fetchImpl.mock.calls.filter((call) => rpcBodyFromCall(call).method === "tempo_fundAddress")
    .length;
}
