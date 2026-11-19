import {
  DvmError,
  type PendingX402Funding,
  resolveRpcHttpTransportOptions,
  resolveX402ChannelRpc,
  X402_BATCH_SETTLEMENT_SCHEME,
  X402_VERSION,
  x402NetworkByCaip2,
  type X402VoucherPendingState,
  x402VoucherPendingState,
} from "@dvmkit/sdk/internal";
import { eip3009ABI, isBatchSettlementDepositPayload } from "@x402/evm";
import { createPublicClient, encodeAbiParameters, http, isAddress, isHash, keccak256 } from "viem";
import * as chains from "viem/chains";

export async function finalizedX402DepositExpiredUnused(
  paymentHeader: string,
  walletNetwork: string
): Promise<boolean> {
  const payment = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8")) as {
    x402Version?: number;
    accepted?: { scheme?: string; network?: string; asset?: string };
    payload?: unknown;
  };
  const { accepted, payload } = payment;
  if (
    payment.x402Version !== X402_VERSION ||
    accepted?.scheme !== X402_BATCH_SETTLEMENT_SCHEME ||
    typeof accepted.network !== "string" ||
    !isBatchSettlementDepositPayload(payload)
  ) {
    return false;
  }

  const { payer, token } = payload.channelConfig;
  const { channelId } = payload.voucher;
  const authorization = payload.deposit.authorization.erc3009Authorization;
  const network = x402NetworkByCaip2(accepted.network);
  if (
    !network ||
    accepted.asset?.toLowerCase() !== network.usdc.toLowerCase() ||
    token?.toLowerCase() !== network.usdc.toLowerCase() ||
    !isAddress(payer, { strict: false }) ||
    !isHash(channelId) ||
    !authorization ||
    !isHash(authorization.salt) ||
    typeof authorization.validBefore !== "string" ||
    !/^\d+$/.test(authorization.validBefore)
  ) {
    return false;
  }

  const chain = chains[network.viemChain as keyof typeof chains];
  const rpc = resolveX402ChannelRpc(accepted.network, walletNetwork, chain.rpcUrls.default.http[0]);
  const client = createPublicClient({
    chain,
    transport: http(
      rpc.url,
      resolveRpcHttpTransportOptions(rpc.source, process.env.DVM_X402_RPC_HEADERS_JSON)
    ),
  });
  if ((await client.getChainId()) !== chain.id) return false;

  // Expiry and non-use must hold in the same finalized block. A read at the
  // head can miss a deposit that lands before the chain reaches its deadline.
  const block = await client.getBlock({ blockTag: "finalized" });
  if (
    !block.hash ||
    !isHash(block.hash) ||
    typeof block.timestamp !== "bigint" ||
    block.timestamp <= BigInt(authorization.validBefore)
  ) {
    return false;
  }
  const nonce = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }],
    [channelId, BigInt(authorization.salt)]
  ));
  return (await client.readContract({
    address: network.usdc,
    abi: eip3009ABI,
    functionName: "authorizationState",
    args: [payer, nonce],
    blockHash: block.hash,
    requireCanonical: true,
  })) === false;
}

/** Compatibility adapter retaining caller commands until consumer migration. */
export function x402VoucherPendingRefusal(
  blocking: PendingX402Funding,
  data: Record<string, unknown> = {}
): DvmError {
  return formatX402VoucherPendingRefusal(x402VoucherPendingState(blocking), data);
}

function formatX402VoucherPendingRefusal(
  blocking: X402VoucherPendingState,
  data: Record<string, unknown> = {}
): DvmError {
  const base = {
    credit_id: blocking.creditId,
    fund_id: blocking.fundId,
    channel_id: blocking.channelId,
    ...data,
  };
  if (!blocking.retired) {
    return new DvmError(
      "x402_voucher_pending",
      `A signed x402 voucher for credit ${blocking.creditId} is still waiting for its acknowledgement, so this channel cannot sign another.`,
      `Retry that funding ('dvm credit fund ${blocking.endpoint} --credit-id ${blocking.creditId}'), or retire it with 'dvm wallet x402-clear-pending --credit-id ${blocking.creditId}' if the DVM is gone.`,
      base
    );
  }
  const until = new Date(blocking.blockedUntil).toISOString();
  const signedDeadline = blocking.depositExpiresAt !== undefined;
  return new DvmError(
    "x402_voucher_pending",
    signedDeadline
      ? `The deposit this channel signed for credit ${blocking.creditId} was refused by the DVM but can still be submitted, so the channel cannot sign a second one yet.`
      : `The funding this channel signed for credit ${blocking.creditId} was refused by the DVM, and it names no deadline after which it stops being submittable, so the channel cannot sign a second one yet.`,
    signedDeadline
      ? `Fund again after ${until}, when that authorization expires and this block lifts by itself.`
      : `Fund again after ${until} — a conservative cutoff this CLI picks when a signature carries no expiry of its own, not a deadline the DVM agreed to. The block lifts by itself then.`,
    { ...base, refused: true, funding_blocked_until: until }
  );
}
