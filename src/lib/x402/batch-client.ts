import {
  DvmError,
  DvmX402ChannelStorage,
  listPendingX402Fundings,
  type PendingX402Funding,
  resolveRpcHttpTransportOptions,
  resolveX402ChannelRpc,
  X402_BATCH_CHANNEL_ABI,
  X402_BATCH_SETTLEMENT_SCHEME,
  X402_VERSION,
  x402NetworkByCaip2,
  x402PendingBlockExpiresAt,
  x402PendingDepositExpiresAt,
  x402PendingRetired,
  x402PendingUnsettled,
  type X402Wallet,
} from "@dvmkit/sdk/internal";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import {
  BATCH_SETTLEMENT_ADDRESS,
  eip3009ABI,
  isBatchSettlementDepositPayload,
  isBatchSettlementVoucherPayload,
} from "@x402/evm";
import { BatchSettlementEvmScheme, computeChannelId } from "@x402/evm/batch-settlement/client";
import { createPublicClient, encodeAbiParameters, http, isAddress, isHash, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as chains from "viem/chains";

function readBatchFundingHeader(paymentHeader: string) {
  try {
    const payment = decodePaymentSignatureHeader(paymentHeader);
    if (payment.x402Version === X402_VERSION && payment.accepted?.scheme === X402_BATCH_SETTLEMENT_SCHEME) {
      return payment;
    }
  } catch {
    // A header that cannot be decoded supplies no evidence about its authority.
  }
  return undefined;
}

function readDepositAuthorization(paymentHeader: string) {
  const payment = readBatchFundingHeader(paymentHeader);
  if (!payment || !isBatchSettlementDepositPayload(payment.payload)) return undefined;
  const { accepted, payload } = payment;
  const { payer, token } = payload.channelConfig ?? {};
  const { channelId } = payload.voucher;
  const authorization = payload.deposit.authorization.erc3009Authorization;
  const network = x402NetworkByCaip2(accepted.network);
  if (
    !network ||
    typeof accepted.asset !== "string" || accepted.asset.toLowerCase() !== network.usdc.toLowerCase() ||
    typeof token !== "string" || token.toLowerCase() !== network.usdc.toLowerCase() ||
    typeof payer !== "string" || !isAddress(payer, { strict: false }) ||
    typeof channelId !== "string" || !isHash(channelId) ||
    !authorization ||
    typeof authorization.salt !== "string" || !isHash(authorization.salt) ||
    typeof authorization.validBefore !== "string" ||
    !/^\d+$/.test(authorization.validBefore)
  ) {
    return undefined;
  }
  return { network, payer, channelId, deadline: BigInt(authorization.validBefore), salt: authorization.salt };
}

async function readFinalizedDeposit(
  deposit: NonNullable<ReturnType<typeof readDepositAuthorization>>,
  walletNetwork: string
) {
  const { network, payer, channelId, deadline, salt } = deposit;
  const chain = chains[network.viemChain as keyof typeof chains];
  const rpc = resolveX402ChannelRpc(network.caip2, walletNetwork, chain.rpcUrls.default.http[0]);
  const client = createPublicClient({
    chain,
    transport: http(
      rpc.url,
      resolveRpcHttpTransportOptions(rpc.source, process.env.DVM_X402_RPC_HEADERS_JSON)
    ),
  });
  if ((await client.getChainId()) !== chain.id) return undefined;

  // Expiry and non-use must hold in the same finalized block. A read at the
  // head can miss a deposit that lands before the chain reaches its deadline.
  const block = await client.getBlock({ blockTag: "finalized" });
  if (
    !block.hash ||
    !isHash(block.hash) ||
    typeof block.timestamp !== "bigint" ||
    block.timestamp <= deadline
  ) {
    return undefined;
  }
  const nonce = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }],
    [channelId, BigInt(salt)]
  ));
  const consumed = await client.readContract({
    address: network.usdc,
    abi: eip3009ABI,
    functionName: "authorizationState",
    args: [payer, nonce],
    blockHash: block.hash,
    requireCanonical: true,
  });
  return typeof consumed === "boolean" ? { client, consumed } : undefined;
}

export async function finalizedX402DepositExpiredUnused(
  paymentHeader: string,
  walletNetwork: string
): Promise<boolean> {
  const deposit = readDepositAuthorization(paymentHeader);
  return deposit !== undefined && (await readFinalizedDeposit(deposit, walletNetwork))?.consumed === false;
}

export function isVoucherOnlyX402Funding(pending: PendingX402Funding): boolean {
  const payload = readBatchFundingHeader(pending.paymentHeader)?.payload;
  return pending.depositMicro === undefined &&
    pending.authorizationValidBefore === undefined &&
    isBatchSettlementVoucherPayload(payload) &&
    typeof payload.voucher.channelId === "string" &&
    payload.voucher.channelId.toLowerCase() === pending.channelId.toLowerCase();
}

export function x402RetiredDepositExpiresAt(pending: PendingX402Funding): number | undefined {
  const deposit = readDepositAuthorization(pending.paymentHeader);
  const deadline = deposit ? Number(deposit.deadline * 1000n) : x402PendingDepositExpiresAt(pending);
  return deadline !== undefined && Number.isFinite(new Date(deadline).getTime()) ? deadline : undefined;
}

/** Call under the channel lock, after discovery and before asking the SDK signer for a payload. */
export async function assertRetiredX402FundingReady(
  wallet: X402Wallet,
  paymentRequired: PaymentRequired
): Promise<void> {
  const retired = listPendingX402Fundings().filter(x402PendingRetired);
  if (retired.length === 0) return;
  const accepted = paymentRequired.accepts.find(
    (terms) => terms.scheme === X402_BATCH_SETTLEMENT_SCHEME && terms.network === wallet.network
  );
  if (!accepted) return;
  const payer = privateKeyToAccount(wallet.privateKey as `0x${string}`);
  // Match the SDK signer's selection and default channel salt. Endpoint and caller identity
  // aren't part of the channel ID, so either can differ from the retired funding.
  const salt = keccak256(toBytes(`dvmkit:x402-batch:${wallet.network}:${payer.address.toLowerCase()}`));
  const scheme = new BatchSettlementEvmScheme(payer, { salt });
  const channelId = computeChannelId(scheme.buildChannelConfig(accepted), accepted.network);
  for (const pending of retired) {
    if (pending.channelId.toLowerCase() !== channelId.toLowerCase()) continue;
    if (x402PendingUnsettled(pending) || !(await retiredX402FundingReady(pending, wallet.network).catch(() => false))) {
      throw x402VoucherPendingRefusal(pending);
    }
  }
}

async function retiredX402FundingReady(pending: PendingX402Funding, walletNetwork: string): Promise<boolean> {
  if (isVoucherOnlyX402Funding(pending)) return true;
  const deposit = readDepositAuthorization(pending.paymentHeader);
  if (
    !deposit ||
    deposit.channelId.toLowerCase() !== pending.channelId.toLowerCase() ||
    deposit.network.caip2 !== walletNetwork
  ) {
    return false;
  }
  const proof = await readFinalizedDeposit(deposit, walletNetwork);
  if (!proof) return false;
  if (proof.consumed) {
    // Refresh the current escrow before sizing a new payment. The finalized nonce proves
    // the old authorization cannot land again. The DVM's credit ledger remains independent.
    const [balance, totalClaimed] = await proof.client.readContract({
      address: BATCH_SETTLEMENT_ADDRESS,
      abi: X402_BATCH_CHANNEL_ABI,
      functionName: "channels",
      args: [pending.channelId],
      blockTag: "latest",
    });
    if (typeof balance !== "bigint" || typeof totalClaimed !== "bigint") return false;
    await new DvmX402ChannelStorage().reconcileChainState(pending.channelId, {
      balance: balance.toString(),
      totalClaimed: totalClaimed.toString(),
    });
  }
  return true;
}

export function x402VoucherPendingRefusal(
  blocking: PendingX402Funding,
  data: Record<string, unknown> = {}
): DvmError {
  const base = {
    credit_id: blocking.creditId,
    fund_id: blocking.fundId,
    channel_id: blocking.channelId,
    ...data,
  };
  if (!x402PendingRetired(blocking)) {
    return new DvmError(
      "x402_voucher_pending",
      `A signed x402 voucher for credit ${blocking.creditId} is still waiting for its acknowledgement, so this channel cannot sign another.`,
      `Retry that funding ('dvm credit fund ${blocking.endpoint} --credit-id ${blocking.creditId}'), or retire it with 'dvm wallet x402-clear-pending --credit-id ${blocking.creditId}' if the DVM is gone.`,
      base
    );
  }
  const until = new Date(x402PendingBlockExpiresAt(blocking)).toISOString();
  const voucherOnly = isVoucherOnlyX402Funding(blocking);
  const deadline = x402RetiredDepositExpiresAt(blocking);
  const deadlineCopy = deadline === undefined
    ? "its signed deadline"
    : `its signed deadline of ${new Date(deadline).toISOString()}`;
  return new DvmError(
    "x402_voucher_pending",
    `The DVM refused a signed x402 funding for credit ${blocking.creditId}, so this channel cannot sign again yet.`,
    voucherOnly
      ? `Fund again after ${until}, the CLI's waiting period for a refused voucher-only funding.`
      : `Retry after the chain finalizes a block past ${deadlineCopy}. The CLI must check the original deposit nonce and refresh the escrow if it was used. Run 'dvm wallet x402-clear-pending' to see the original funding and its outstanding claim.`,
    { ...base, refused: true, funding_blocked_until: until }
  );
}
