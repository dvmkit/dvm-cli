import {
  DvmError,
  DvmX402ChannelStorage,
  listPendingX402FundingsForChannel,
  normalizeCreditEndpoint,
  type PendingX402Funding,
  recordX402ChannelMetadata,
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
import { decodePaymentSignatureHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import {
  BATCH_SETTLEMENT_ADDRESS,
  eip3009ABI,
  isBatchSettlementDepositPayload,
  isBatchSettlementVoucherPayload,
  PERMIT2_ADDRESS,
  toClientEvmSigner,
} from "@x402/evm";
import { BatchSettlementEvmScheme, computeChannelId } from "@x402/evm/batch-settlement/client";
import { createPublicClient, encodeAbiParameters, http, isAddress, isHash, keccak256, parseAbi, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as chains from "viem/chains";
import { x402NetworkLabel } from "./networks";

const permit2NonceAbi = parseAbi(["function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)"]);

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
  const { erc3009Authorization, permit2Authorization } = payload.deposit.authorization;
  const network = x402NetworkByCaip2(accepted.network);
  if (
    !network ||
    typeof accepted.asset !== "string" ||
    typeof token !== "string" || !isAddress(token, { strict: false }) ||
    token.toLowerCase() !== accepted.asset.toLowerCase() ||
    typeof payer !== "string" || !isAddress(payer, { strict: false }) ||
    typeof channelId !== "string" || !isHash(channelId)
  ) {
    return undefined;
  }
  if (permit2Authorization && !erc3009Authorization) {
    const { from, permitted, witness } = permit2Authorization;
    const deadline = unsignedInteger(permit2Authorization.deadline);
    const nonce = unsignedInteger(permit2Authorization.nonce);
    if (
      deadline === undefined || nonce === undefined ||
      typeof from !== "string" || from.toLowerCase() !== payer.toLowerCase() ||
      typeof permitted?.token !== "string" || permitted.token.toLowerCase() !== token.toLowerCase() ||
      typeof witness?.channelId !== "string" || witness.channelId.toLowerCase() !== channelId.toLowerCase()
    ) {
      return undefined;
    }
    return { network, payer, channelId, deadline, nonce };
  }
  if (!erc3009Authorization || permit2Authorization || token.toLowerCase() !== network.usdc.toLowerCase()) {
    return undefined;
  }
  const { salt, validBefore } = erc3009Authorization;
  const deadline = unsignedInteger(validBefore);
  if (deadline === undefined || typeof salt !== "string" || !isHash(salt)) return undefined;
  const nonce = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }],
    [channelId, BigInt(salt)]
  ));
  return { network, payer, channelId, deadline, nonce };
}

function unsignedInteger(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value)) return undefined;
  const amount = BigInt(value);
  return amount < 2n ** 256n ? amount : undefined;
}

function createX402ChannelReader(
  network: NonNullable<ReturnType<typeof x402NetworkByCaip2>>,
  walletNetwork: string
) {
  const chain = chains[network.viemChain as keyof typeof chains];
  const rpc = resolveX402ChannelRpc(network.caip2, walletNetwork, chain.rpcUrls.default.http[0]);
  const options = resolveRpcHttpTransportOptions(rpc.source, process.env.DVM_X402_RPC_HEADERS_JSON);
  const client = createPublicClient({
    chain,
    transport: http(rpc.url, options),
  });
  return { client, chain, rpcUrl: rpc.url };
}

async function readFinalizedDeposit(
  deposit: NonNullable<ReturnType<typeof readDepositAuthorization>>,
  walletNetwork: string
) {
  const { network, payer, deadline, nonce } = deposit;
  const { client, chain } = createX402ChannelReader(network, walletNetwork);
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
  const at = { blockHash: block.hash, requireCanonical: true } as const;
  if (typeof nonce === "bigint") {
    // Permit2 uses the low eight nonce bits as an index into one bitmap word.
    const bitmap = await client.readContract({
      address: PERMIT2_ADDRESS,
      abi: permit2NonceAbi,
      functionName: "nonceBitmap",
      args: [payer, nonce >> 8n],
      ...at,
    });
    if (typeof bitmap !== "bigint") return undefined;
    return { client, consumed: (bitmap & (1n << (nonce & 255n))) !== 0n };
  }
  const consumed = await client.readContract({
    address: network.usdc,
    abi: eip3009ABI,
    functionName: "authorizationState",
    args: [payer, nonce],
    ...at,
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

/**
 * Whether a retired funding can no longer put a deposit into a channel the
 * given key controls. Local expiry is not proof: the authorization's own chain
 * must have finalized a block past its deadline, so a wrong local clock cannot
 * release the only key that could sign for a deposit that may still land.
 * Unreadable authority or an unavailable chain keeps the hold. A consumed
 * deposit is released here, because its escrow is the channel checks' concern.
 */
export async function x402RetiredDepositCannotLand(
  pending: PendingX402Funding,
  wallet: { address: string; network: string }
): Promise<boolean> {
  if (isVoucherOnlyX402Funding(pending)) return true;
  const deposit = readDepositAuthorization(pending.paymentHeader);
  if (!deposit) return false;
  if (deposit.payer.toLowerCase() !== wallet.address.toLowerCase()) return true;
  return (await readFinalizedDeposit(deposit, wallet.network).catch(() => undefined)) !== undefined;
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

/** Call under the channel lock so the journal and the escrow used to size the payment agree. */
export async function createX402BatchPayment(args: {
  wallet: X402Wallet;
  paymentRequired: PaymentRequired;
  endpoint: string;
  callerPubkey: string;
  creditId: string;
  depositMicro: number;
}) {
  const { wallet, paymentRequired } = args;
  const accepted = paymentRequired.accepts.find(
    (terms) => terms.scheme === X402_BATCH_SETTLEMENT_SCHEME && terms.network === wallet.network
  );
  if (!accepted) {
    const label = x402NetworkLabel(wallet.network);
    throw new DvmError(
      "x402_batch_not_offered",
      `The DVM offered no batch-settlement channel on the wallet's ${label} network.`,
      `Fund over another rail or re-pin the wallet to a network the DVM supports with 'dvm wallet x402-network <caip2>'.`
    );
  }
  const network = x402NetworkByCaip2(accepted.network);
  if (!network) throw new DvmError("x402_unsupported_network", `Unsupported x402 network ${wallet.network}.`);

  const account = privateKeyToAccount(wallet.privateKey as `0x${string}`);
  const { client, rpcUrl } = createX402ChannelReader(network, wallet.network);
  const storage = new DvmX402ChannelStorage();
  // The existing salt keeps the SDK channel identity for replay, correction and exits.
  const salt = keccak256(toBytes(`dvmkit:x402-batch:${wallet.network}:${account.address.toLowerCase()}`));
  const scheme = new BatchSettlementEvmScheme(toClientEvmSigner(account, client), {
    storage,
    salt,
    depositStrategy: ({ minimumDepositAmount }) => {
      const depositTarget = BigInt(args.depositMicro);
      const minimum = BigInt(minimumDepositAmount);
      return (minimum > depositTarget ? minimum : depositTarget).toString();
    },
    ...(rpcUrl ? { rpcUrl } : {}),
  });
  const config = scheme.buildChannelConfig(accepted);
  const channelId = computeChannelId(config, accepted.network);
  await assertX402ChannelReady(channelId, args.creditId, wallet.network, storage);

  const created = await scheme.createPaymentPayload(X402_VERSION, accepted, { extensions: paymentRequired.extensions });
  const { payload } = created;
  if (
    (!isBatchSettlementDepositPayload(payload) && !isBatchSettlementVoucherPayload(payload)) ||
    typeof payload.voucher.maxClaimableAmount !== "string"
  ) {
    throw new DvmError("x402_voucher_unreadable", "The signed x402 payload carries no cumulative voucher to journal.");
  }
  const deposit = payload.type === "deposit" ? payload.deposit : undefined;
  recordX402ChannelMetadata({
    channelId,
    endpoint: normalizeCreditEndpoint(args.endpoint),
    callerPubkey: args.callerPubkey,
    creditId: args.creditId,
    network: accepted.network,
    config,
    updatedAt: Date.now(),
  });
  const authorizationValidBefore = deposit?.authorization.erc3009Authorization?.validBefore;
  return {
    channelId,
    paymentHeader: encodePaymentSignatureHeader({
      ...created,
      accepted,
      resource: paymentRequired.resource,
      extensions: { ...paymentRequired.extensions, ...created.extensions },
    }),
    maxClaimableMicro: payload.voucher.maxClaimableAmount,
    ...(deposit ? { depositMicro: deposit.amount } : {}),
    ...(authorizationValidBefore === undefined ? {} : { authorizationValidBefore }),
  };
}

async function assertX402ChannelReady(
  channelId: `0x${string}`,
  creditId: string,
  walletNetwork: string,
  storage: DvmX402ChannelStorage
): Promise<void> {
  const journal = listPendingX402FundingsForChannel(channelId);
  const rival = journal.find((entry) => entry.creditId !== creditId && !x402PendingRetired(entry));
  if (rival) throw x402VoucherPendingRefusal(rival);

  let verifiedClient: ReturnType<typeof createX402ChannelReader>["client"] | undefined;
  let consumedDeposit: PendingX402Funding | undefined;
  for (const entry of journal.filter(x402PendingRetired)) {
    if (isVoucherOnlyX402Funding(entry)) {
      if (x402PendingUnsettled(entry)) throw x402VoucherPendingRefusal(entry);
      continue;
    }
    const deposit = readDepositAuthorization(entry.paymentHeader);
    if (!deposit || deposit.channelId.toLowerCase() !== channelId.toLowerCase() || deposit.network.caip2 !== walletNetwork) {
      throw x402VoucherPendingRefusal(entry);
    }
    const proof = await readFinalizedDeposit(deposit, walletNetwork).catch(() => undefined);
    if (!proof) throw x402VoucherPendingRefusal(entry);
    verifiedClient = proof.client;
    if (proof.consumed) consumedDeposit ??= entry;
  }
  if (!verifiedClient) return;

  // An unused deposit permits signing even if the projection cannot be repaired.
  // A used nonce requires refreshed escrow before sizing another payment.
  try {
    const [balance, totalClaimed] = await verifiedClient.readContract({
      address: BATCH_SETTLEMENT_ADDRESS,
      abi: X402_BATCH_CHANNEL_ABI,
      functionName: "channels",
      args: [channelId],
      blockTag: "latest",
    });
    if (typeof balance !== "bigint" || typeof totalClaimed !== "bigint") {
      throw new Error("Invalid x402 channel balance or claims");
    }
    await storage.reconcileChainState(channelId, {
      balance: balance.toString(),
      totalClaimed: totalClaimed.toString(),
    });
  } catch {
    if (consumedDeposit) throw x402VoucherPendingRefusal(consumedDeposit);
  }
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
  const deadline = x402RetiredDepositExpiresAt(blocking);
  const until = new Date(deadline ?? x402PendingBlockExpiresAt(blocking)).toISOString();
  const voucherOnly = isVoucherOnlyX402Funding(blocking);
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
