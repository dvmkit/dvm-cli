import type { TempoAccount } from "@dvmkit/sdk/internal";
import { describe, expect, it, vi } from "vitest";

import { checkTempoTargetNetwork } from "../src/commands/doctor";

const endpoint = "https://target.example";

describe("dvm doctor target Tempo network", () => {
  it("reports an advertised chain mismatch from an unauthenticated info read", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(info({ chain_id: 4217 }));

    await expect(
      checkTempoTargetNetwork(endpoint, { fetchImpl, account: account("moderato") })
    ).resolves.toMatchObject({
      name: "network_tempo_target",
      status: "fail",
      details: {
        wallet_network: "moderato",
        wallet_chain_id: 42431,
        advertised_chain_id: 4217,
        payment_signed: false,
      },
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`${endpoint}/v1/info`);
    expect(init).toMatchObject({ method: "GET" });
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });

  it.each([
    ["mainnet", 4217],
    ["moderato", 42431],
  ] as const)("accepts a matching %s advertisement", async (network, chainId) => {
    const result = await checkTempoTargetNetwork(endpoint, {
      account: account(network),
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(info({ chain_id: chainId })),
    });
    expect(result).toMatchObject({ status: "ok", details: { advertised_chain_id: chainId } });
  });

  it("reports a missing Tempo advertisement without assuming mainnet", async () => {
    const result = await checkTempoTargetNetwork(endpoint, {
      account: account("mainnet"),
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(info(undefined)),
    });
    expect(result).toMatchObject({
      status: "warn",
      display: expect.stringContaining("does not advertise Tempo"),
      details: expect.not.objectContaining({ advertised_chain_id: expect.anything() }),
    });
  });

  it("reports an omitted chain id without treating it as a match", async () => {
    const result = await checkTempoTargetNetwork(endpoint, {
      account: account("mainnet"),
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(info({ methods: [] })),
    });
    expect(result).toMatchObject({
      status: "warn",
      display: expect.stringContaining("omits tempo.chain_id"),
    });
  });
});

function account(network: "mainnet" | "moderato"): TempoAccount {
  return {
    method: "tempo",
    privateKey: `0x${"55".repeat(32)}`,
    address: "0x5555555555555555555555555555555555555555",
    network,
  } as TempoAccount;
}

function info(tempo: Record<string, unknown> | undefined): Response {
  return new Response(JSON.stringify({ ...(tempo === undefined ? {} : { tempo }) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
