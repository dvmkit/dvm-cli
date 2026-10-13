import { assertX402WalletIdle } from "../lib/x402/lifecycle";
import {
  assertX402ChannelPayer,
  chainIdFromCaip2,
  clearPendingX402Funding,
  DvmError,
  DvmX402ChannelStorage,
  ensureAddress,
  findX402Channel,
  generateX402PrivateKey,
  isValidEvmPrivateKey,
  listPendingX402Fundings,
  listPendingX402FundingsForChannel,
  listX402Channels,
  type PendingX402Funding,
  reconcileRefusedX402Deposits,
  redactUrl,
  redactUrlsInText,
  resolveRpcHttpTransportOptions,
  resolveX402Asset,
  resolveX402ChannelRpc,
  type StoredX402ChannelMetadata,
  withX402ChannelLock,
  X402_BATCH_CHANNEL_ABI,
  X402_DEFAULT_NETWORK,
  type X402Asset,
  type X402ChannelReconciliation,
  x402ChannelReservation,
  x402NetworkByCaip2,
  x402PendingBlockExpiresAt,
  x402PendingDepositExpiresAt,
  x402PendingFundingJson,
  x402PendingRetired,
  x402PendingStale,
  x402PendingUnsettled,
} from "@dvmkit/sdk/internal";
import {
  assertSupportedX402Network,
  x402NetworkLabel,
} from "../lib/x402/networks";
import {
  info,
  json,
} from "../lib/output";
import {
  loadConfig,
} from "../lib/identity";
import {
  loadX402Wallet,
  removeX402Wallet,
  repinX402WalletNetwork,
  saveX402Wallet,
} from "../lib/x402/wallet";
import { BATCH_SETTLEMENT_ADDRESS } from "@x402/evm";
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  InsufficientFundsError,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as chains from "viem/chains";

import { resolveDvmReference } from "../lib/dvm-identifier";
import { resolveEndpoint } from "../lib/favorites";
import {
  prepareStablecoinFundingHandoff,
  printStablecoinFundingHandoff,
  type StablecoinFundingHandoff,
  stablecoinFundingHandoffJson,
} from "../lib/funding-handoff";
import {
  hasPipedStdin,
  type PositionalRefusalCopy,
  refusePositionalSecret,
  resolveSecretInput,
  type SecretInputConfig,
} from "../lib/secret-input";
import { x402FinalizedWithdrawalAmount, x402WithdrawalRemainder } from "../lib/x402/withdrawal";

export interface WalletX402Options {
  human?: boolean;
  qrImage?: string;
}

export interface WalletX402DisconnectOptions extends WalletX402Options {
  /** Drop the key even though signed vouchers are still unacknowledged. */
  withPending?: boolean;
}

export interface WalletX402ClearPendingOptions extends WalletX402Options {
  dvm?: string;
  creditId?: string;
  all?: boolean;
  /** Retire an entry signed recently enough that a retry is the better repair. */
  force?: boolean;
}

export interface WalletX402ConnectOptions extends WalletX402Options {
  /** CAIP-2 chain identifier (default: eip155:8453 / Base). */
  network?: string;
  /**
   * Read the private key from a file — the import route that never puts the
   * secret in shell history, `ps`, or `/proc/<pid>/cmdline`. Paths under
   * shell-history or world-readable temp directories are rejected (see
   * `secret-input.ts`).
   */
  keyFile?: string;
  /**
   * Authorize replacing the wallet that is already connected. It never
   * authorizes replacing one that still controls channel funds — that check is
   * the caller's protection against stranding money, not a confirmation
   * prompt.
   */
  force?: boolean;
}

export interface WalletX402WithdrawalOptions extends WalletX402Options {
  dvm?: string;
  channelId?: string;
}

/**
 * Secret-input config for the EVM private key accepted by
 * `dvm wallet x402-connect`. Drives the file-not-found hint,
 * stdin-timeout message, and TTY prompt label.
 *
 * `warningCommands` is the resolver's positional-arg warning, which this rail
 * can no longer reach: the positional is refused before a key source is read
 * The list stays accurate as the set of sources that do work, so
 * it reads correctly if the resolver ever surfaces it another way.
 */
export const X402_SECRET_CONFIG: SecretInputConfig = {
  kind: "private key",
  promptLabel: "Enter EVM private key (input hidden, press enter to submit):",
  warningCommands: [
    "cat ~/key.txt | dvm wallet x402-connect              # pipe via stdin",
    "dvm wallet x402-connect --key-file ~/key.txt         # read from file",
    "DVM_X402_KEY=0x... dvm wallet x402-connect           # env var",
    "dvm wallet x402-connect                              # generate a fresh wallet instead",
  ],
};

/**
 * Connect an x402 wallet — generating one when the caller has no key to import
 * *
 * With no key source, this generates a 32-byte EVM secret and persists
 * it through `saveX402Wallet`, exactly as `dvm wallet tempo-connect` does
 * on the Tempo rail, and returns only the derived address.
 *
 * Importing stays explicit, in the precedence order left by
 * `--key-file`, the `DVM_X402_KEY` env var, or piped stdin. The interactive
 * prompt is absent: no key source means generation. A key on argv is refused
 * rather than imported — see
 * {@link X402_POSITIONAL_REFUSAL}.
 *
 * A wallet already connected is never replaced without `--force`, and never
 * replaced at all while it still controls channel funds.
 */
export async function walletX402Connect(
  keyArg: string | undefined,
  opts: WalletX402ConnectOptions
): Promise<void> {
  // First, ahead of `loadConfig` and the channel lock: a refused connect must
  // not contend for the lock a concurrent `dvm credit fund` needs, and a key
  // already loose in the caller's shell outranks a mistyped `--network`.
  if (keyArg !== undefined && keyArg !== "") {
    throw refusePositionalSecret(keyArg, X402_POSITIONAL_REFUSAL);
  }
  // reject an unsupported chain before asking for a private key —
  // `saveX402Wallet` guards the config either way, but there is no reason to
  // make the caller produce a secret for a connect that can't succeed.
  if (opts.network !== undefined) assertSupportedX402Network(opts.network);
  const config = loadConfig();
  if (!config) throw new DvmError("no_config", "No config found.", "Run: dvm init");

  // The lock spans the preflight and the config write together: a `dvm credit
  // fund` running alongside must not be able to sign a voucher in the window
  // between "this wallet controls nothing" and the key ceasing to be the
  // configured one.
  const { connected, handoff } = await withX402ChannelLock(async () => {
    const stored = loadX402Wallet();
    const existing = stored ? await ensureAddress(stored) : undefined;
    if (existing && !opts.force) throw walletExistsError(existing.address, existing.network);

    const imported = await readImportedKey(opts);
    if (imported) {
      // Re-supplying the same key isn't a replacement — it's how a caller
      // re-pins the chain — so nothing can be stranded and neither guard has
      // anything to protect.
      if (existing && !isSameAccount(imported, existing.address)) {
        await assertReplaceable(existing);
      }
      const address = privateKeyToAccount(imported).address;
      const handoff = await prepareStablecoinFundingHandoff({
        address,
        rail: "x402",
        human: opts.human ?? false,
        qrImagePath: opts.qrImage,
      });
      return {
        connected: { ...(await saveX402Wallet(imported, opts.network)), generated: false },
        handoff,
      };
    }

    if (existing) await assertReplaceable(existing);
    // A generated wallet pins its chain explicitly. `saveX402Wallet` leaves an
    // omitted `--network` unpinned, which is right for an import
    // over an existing wallet but would leave a brand-new one riding whatever
    // the read-side default happens to be.
    const network = opts.network ?? existing?.network ?? X402_DEFAULT_NETWORK;
    const privateKey = await generateX402PrivateKey();
    const address = privateKeyToAccount(privateKey).address;
    const handoff = await prepareStablecoinFundingHandoff({
      address,
      rail: "x402",
      human: opts.human ?? false,
      qrImagePath: opts.qrImage,
    });
    return {
      connected: { ...(await saveX402Wallet(privateKey, network)), generated: true },
      handoff,
    };
  });

  emitConnectOutput(opts, connected, handoff);
}

/**
 * Forget the x402 signing key. Refuses while signed vouchers are still
 * unacknowledged: this key is the only one that can acknowledge them, refund
 * the channel cooperatively, or sign its timed exit, and dropping it is not
 * recoverable from a different key. Exactly one command discards a signed
 * voucher — `x402-clear-pending` — and it is never a side effect of this one.
 *
 * `--with-pending` is the caller accepting that outcome for a voucher. It is
 * deliberately not a way past the channel check underneath: a
 * channel that still holds value onchain is money this key alone can withdraw,
 * which is a different fact from a voucher nobody will ever answer.
 */
export async function walletX402Disconnect(opts: WalletX402DisconnectOptions): Promise<void> {
  const config = loadConfig();
  if (!config) throw new DvmError("no_config", "No config found.", "Run: dvm init");
  const { address, pending } = await withX402ChannelLock(async () => {
    const journalled = listPendingX402Fundings().filter((entry) => x402PendingUnsettled(entry));
    if (journalled.length > 0 && !opts.withPending) {
      throw pendingFundingsError(journalled, "disconnect");
    }
    const existing = loadX402Wallet();
    const addressed = existing ? await ensureAddress(existing) : undefined;
    if (addressed) {
      await assertX402WalletIdle(
        { address: addressed.address, network: addressed.network },
        "disconnect"
      );
    }
    await removeX402Wallet();
    return { address: addressed?.address, pending: journalled };
  });
  const display = address
    ? `x402 wallet ${address} disconnected. Its private key is gone from this machine.`
    : "No x402 wallet was connected.";
  if (opts.human) {
    info(display);
    if (pending.length > 0) {
      info(
        `${describeCount(pending.length)} left unacknowledged — reconnect this same key to settle or exit ${pending.length === 1 ? "it" : "them"}.`
      );
    }
  } else {
    json({
      status: "disconnected",
      ...(address ? { address } : {}),
      display,
      ...(pending.length > 0
        ? {
            abandoned_fundings: pending.map(x402PendingFundingJson),
            hint: "Reconnect this same key to settle or exit those channels; a different key cannot.",
          }
        : {}),
    });
  }
}

/**
 * Re-pin a connected x402 wallet for new payments without asking the caller to
 * extract or re-supply its private key. Persisted channels keep the network
 * recorded when they were opened and remain withdrawable there.
 */
export async function walletX402Network(network: string, opts: WalletX402Options): Promise<void> {
  const updated = await repinX402WalletNetwork(network);
  const where = x402NetworkLabel(updated.network);
  const display = `x402 wallet ${updated.address} now settles new payments on ${where}.`;
  const hint = `Existing x402 channels keep the network recorded when they were opened and remain withdrawable there; only new payments use ${updated.network}.`;

  if (opts.human) {
    info(display);
    info(hint);
    return;
  }
  json({
    status: "network_set",
    address: updated.address,
    previous_network: updated.previousNetwork,
    network: updated.network,
    display,
    hint,
  });
}

/**
 * List the signed channel vouchers still awaiting acknowledgement, and retire
 * them on request. This is the supported escape from a funding no DVM will ever
 * answer — the alternative was hand-editing a store whose own error tells the
 * caller not to. Retiring is the destructive direction: it forgets that an
 * authorization may still be claimed, and the exit's guaranteed figure goes blind to it.
 *
 * It is also the only way out for a funding the DVM refused outright, which is
 * journalled but unretriable: its deposit stops blocking on its own clock, its
 * claim never does, so `--force` here is the one thing that ever releases the
 * effect that claim has on the timed exit's guaranteed floor.
 *
 * Retiring a refused entry also forgets the last local record of a deposit the
 * DVM never took, so this is the moment to settle whether the stored channel
 * balance still counts it — a `channels()` read while the evidence is still on
 * disk, and never a failure of the escape hatch when the chain won't answer
 * */
export function walletX402ClearPending(opts: WalletX402ClearPendingOptions): Promise<void> {
  // A refusal thrown while deciding what to retire has to surface as a
  // rejection rather than escaping the lock's own error handling synchronously,
  // which an async body gives for free.
  return withX402ChannelLock(() => walletX402ClearPendingLocked(opts));
}

async function walletX402ClearPendingLocked(opts: WalletX402ClearPendingOptions): Promise<void> {
  const endpoint = opts.dvm ? resolveChannelEndpoint(opts.dvm) : undefined;
  const scoped = listPendingX402Fundings({ ...(endpoint ? { endpoint } : {}) }).filter(
    (entry) => !opts.creditId || entry.creditId === opts.creditId
  );
  if (!opts.creditId && !opts.all) {
    renderPendingList(opts, scoped);
    return;
  }
  if (scoped.length === 0) {
    throw new DvmError(
      "x402_pending_not_found",
      "No journalled x402 funding matches that scope.",
      "Run 'dvm wallet x402-clear-pending' with no flags to see what is journalled."
    );
  }
  const fresh = scoped.filter((entry) => !x402PendingStale(entry) && !x402PendingRetired(entry));
  const refused = scoped.filter(x402PendingRetired);
  if (fresh.length > 0 && !opts.force) {
    throw new DvmError(
      "x402_voucher_recent",
      `${describeCount(fresh.length)} left this wallet in the last day, and retrying the funding is the cheaper repair.`,
      `Run 'dvm credit fund ${fresh[0].endpoint} --credit-id ${fresh[0].creditId}' first. Pass --force to retire ${fresh.length === 1 ? "it" : "them"} anyway; the signed authorization may still be claimed, will stop lowering the timed exit's guaranteed floor, and will disappear from a cooperative drain's at-risk report.`,
      { pending_fundings: fresh.map(x402PendingFundingJson) }
    );
  }
  // A refused entry has no cheaper repair to point at — the DVM will not answer
  // it — so the guard is not about age. It is here because forgetting it is the
  // one irreversible thing this command does: the claim it reserves against the
  // timed exit has no expiry, so nothing else will ever free that hold and
  // nothing will ever prove it safe to.
  if (refused.length > 0 && !opts.force) {
    // Whether a refused entry still blocks funding is the deposit's clock, not
    // the refusal's — inside that window it very much does block, which is the
    // hazard this whole change exists for, so the sentence has to ask.
    const blocking = refused.filter((entry) => x402PendingUnsettled(entry));
    const blockedUntil =
      blocking.length > 0
        ? new Date(Math.max(...blocking.map(x402PendingBlockExpiresAt))).toISOString()
        : undefined;
    const blocks =
      blockedUntil === undefined
        ? `no longer ${refused.length === 1 ? "blocks" : "block"} funding`
        : blocking.length < refused.length
          ? `${String(blocking.length)} of them still block new funding until ${blockedUntil}`
          : `still ${refused.length === 1 ? "blocks" : "block"} new funding until ${blockedUntil}`;
    throw new DvmError(
      "x402_voucher_reserved",
      `${describeCount(refused.length)} ${refused.length === 1 ? "was" : "were"} refused by the DVM and ${blocks}, and ${refused.length === 1 ? "its" : "their"} signed claim never expires at all.`,
      `Pass --force to retire ${refused.length === 1 ? "it" : "them"}, raise the guaranteed figure reported by 'dvm wallet x402-withdraw-initiate', and remove ${refused.length === 1 ? "it" : "them"} from the cooperative drain's at-risk report. The signed claim may still be taken, so retire ${refused.length === 1 ? "it" : "them"} only once you accept that exposure.`,
      { pending_fundings: refused.map(x402PendingFundingJson) }
    );
  }
  const reconciled = await reconcileRetiredChannels(refused);
  for (const entry of scoped) clearPendingX402Funding(entry);
  if (opts.human) {
    info(`Retired ${describeCount(scoped.length)}.`);
    info(
      "Those channels can be funded and exited again. Any authorization still inside its validity window may yet be claimed onchain, and a refused voucher's claim has no expiry at all."
    );
    for (const channel of reconciled) {
      info(
        `  ${channel.channelId} now reads $${formatUsdcMicro(BigInt(channel.balanceMicro))} on chain${channel.previousBalanceMicro !== undefined && channel.previousBalanceMicro !== channel.balanceMicro ? `, not the $${formatUsdcMicro(BigInt(channel.previousBalanceMicro))} this machine had counted` : ""}.`
      );
    }
    return;
  }
  json({
    status: "cleared",
    cleared: scoped.map(x402PendingFundingJson),
    ...(reconciled.length > 0
      ? {
          reconciled_channels: reconciled.map((channel) => ({
            channel_id: channel.channelId,
            previous_balance_micro: channel.previousBalanceMicro ?? null,
            balance_micro: channel.balanceMicro,
            total_claimed_micro: channel.totalClaimedMicro,
            fund_ids: channel.fundIds,
          })),
        }
      : {}),
    display: `Retired ${describeCount(scoped.length)}, so those channels can be funded and exited again.`,
    hint: "A retired entry no longer lowers the guaranteed figure on 'dvm wallet x402-withdraw-initiate' or appears in a cooperative drain's at-risk report. An authorization still inside its validity window may yet be claimed onchain, and a refused voucher's claim has no expiry at all.",
  });
}

/**
 * Replace each retired entry's channel projection with what the contract holds,
 * for every channel where a refused deposit provably lapsed unconsumed.
 *
 * Deliberately best-effort. This command is the escape hatch a caller reaches
 * for when the DVM is gone, so an RPC that doesn't answer must not stand
 * between them and the journal: the record simply keeps its unreconciled stamp,
 * and the next funding or clear tries the read again.
 */
async function reconcileRetiredChannels(
  retired: PendingX402Funding[]
): Promise<X402ChannelReconciliation[]> {
  if (retired.length === 0) return [];
  const wallet = loadX402Wallet();
  if (!wallet) return [];
  const byChannel = new Map<`0x${string}`, PendingX402Funding[]>();
  for (const entry of retired) {
    byChannel.set(entry.channelId, [...(byChannel.get(entry.channelId) ?? []), entry]);
  }
  const reconciled: X402ChannelReconciliation[] = [];
  for (const [channelId, pending] of byChannel) {
    try {
      const outcome = await reconcileRefusedX402Deposits({ wallet, channelId, pending });
      if (outcome) reconciled.push(outcome);
    } catch {
      // Never a reason to leave the entry journalled.
    }
  }
  return reconciled;
}

/** Start the payer's timed unilateral channel exit. The caller pays chain gas. */
export async function walletX402WithdrawInitiate(opts: WalletX402WithdrawalOptions): Promise<void> {
  // Initiate derives the requested amount while a sibling credit fund could
  // create a voucher, so its read-decide-submit sequence shares that writer's
  // lock rather than taking a reporting snapshot mid-signature.
  return withX402ChannelLock(() => walletX402WithdrawInitiateLocked(opts));
}

async function walletX402WithdrawInitiateLocked(opts: WalletX402WithdrawalOptions): Promise<void> {
  const ctx = await withdrawalContext(opts, { refuseAmbiguousBare: true });
  const { metadata, publicClient, walletClient, account } = ctx;
  const storage = new DvmX402ChannelStorage();
  const [channel, pending, nativeBalance, local, acknowledgedCumulativeAmount] = await Promise.all([
    onChain(
      ctx,
      `Reading the x402 channel with ${metadata.endpoint}`,
      READ_CONSEQUENCE,
      publicClient.readContract({
        address: BATCH_SETTLEMENT_ADDRESS,
        abi: X402_BATCH_CHANNEL_ABI,
        functionName: "channels",
        args: [metadata.channelId],
      })
    ),
    onChain(
      ctx,
      `Reading the x402 channel's pending withdrawal with ${metadata.endpoint}`,
      READ_CONSEQUENCE,
      publicClient.readContract({
        address: BATCH_SETTLEMENT_ADDRESS,
        abi: X402_BATCH_CHANNEL_ABI,
        functionName: "pendingWithdrawals",
        args: [metadata.channelId],
      })
    ),
    onChain(
      ctx,
      "Reading the x402 wallet's gas balance",
      READ_CONSEQUENCE,
      publicClient.getBalance({ address: account.address })
    ),
    storage.get(metadata.channelId),
    storage.getAcknowledgedCumulativeAmount(metadata.channelId),
  ]);
  const journalled = listPendingX402FundingsForChannel(metadata.channelId);
  await storage.reconcileChainState(metadata.channelId, {
    balance: channel[0].toString(),
    totalClaimed: channel[1].toString(),
  });
  const figures = withdrawalFigures(channel, local, acknowledgedCumulativeAmount, journalled);
  if (nativeBalance === 0n) {
    throw gasRequired(
      ctx,
      "then retry. The raw withdrawal transaction is paid by the caller, not the facilitator."
    );
  }
  if (pending[0] > 0n) {
    renderWithdrawal(opts, {
      status: "already_initiated",
      metadata,
      amountMicro: pending[0],
      ...figures,
      readyAt: pending[1] + metadata.config.withdrawDelay,
      ...(journalled.length > 0 ? { pendingFundings: journalled } : {}),
      display: `This x402 channel's full-position exit is already in its ${withdrawalWindow(metadata.config.withdrawDelay)} window. Guaranteed floor: ${formatUsdcMicro(figures.guaranteedMicro)} USDC. Likely recovery if no further claims land: ${formatUsdcMicro(figures.likelyMicro)} USDC.`,
      hint: `The window ends ${new Date((pending[1] + metadata.config.withdrawDelay) * 1000).toISOString()}. The DVM may still claim value the caller already authorized, reducing the payout; the remaining escrow returns to this wallet. Then run 'dvm wallet x402-withdraw-finalize --channel-id ${metadata.channelId}'.`,
    });
    return;
  }
  // A funding the DVM refused is not retriable, so it never earns the "retry
  // instead" advice — retiring it is the only thing that raises the guaranteed
  // floor it lowers. Neither kind gates the full-position exit.
  const recent = journalled.filter(
    (entry) => !x402PendingStale(entry) && !x402PendingRetired(entry)
  );
  const refused = journalled.filter(x402PendingRetired);
  const amount = figures.likelyMicro;
  if (amount <= 0n) {
    throw new DvmError(
      "x402_withdraw_amount_invalid",
      "This x402 channel has no unclaimed escrow left to withdraw.",
      "The chain reports that the DVM has already claimed the channel balance. No timed exit can move value that has already been claimed.",
      {
        channel_id: metadata.channelId,
        balance_micro: channel[0].toString(),
        total_claimed_micro: channel[1].toString(),
      }
    );
  }
  const hash = await onChain(
    ctx,
    `Starting the timed exit on the x402 channel with ${metadata.endpoint}`,
    INITIATE_CONSEQUENCE,
    walletClient.writeContract({
      account,
      chain: walletClient.chain,
      address: BATCH_SETTLEMENT_ADDRESS,
      abi: X402_BATCH_CHANNEL_ABI,
      functionName: "initiateWithdraw",
      args: [metadata.config, amount],
    }),
    {
      gas: {
        balance: nativeBalance,
        retry:
          "then retry. The raw withdrawal transaction is paid by the caller, not the facilitator.",
      },
    }
  );
  const receipt = await onChain(
    ctx,
    `Waiting for the timed exit's transaction ${hash}`,
    INITIATE_CONSEQUENCE,
    publicClient.waitForTransactionReceipt({ hash })
  );
  if (receipt.status !== "success") {
    throw new DvmError(
      "x402_withdrawal_reverted",
      "The timed-withdrawal transaction reverted onchain.",
      "No withdrawal was started. Check the transaction hash and current channel state before retrying.",
      { transaction: hash }
    );
  }
  const initiated = parseEventLogs({
    abi: X402_BATCH_CHANNEL_ABI,
    logs: receipt.logs,
    eventName: "WithdrawInitiated",
  }).find((event) => event.args.channelId.toLowerCase() === metadata.channelId.toLowerCase());
  const readyAt =
    initiated?.args.finalizeAfter ?? Math.floor(Date.now() / 1000) + metadata.config.withdrawDelay;
  // An exit and a retry are not alternatives — one completes a deposit, the
  // other ends the channel relationship — so a fresh entry gets the fact, not
  // a refusal.
  const retryFirst =
    recent.length > 0
      ? ` ${recent.length === 1 ? "One funding was" : `${String(recent.length)} fundings were`} signed within the last day; retrying ${recent.length === 1 ? "it" : "them"} would complete that funding, but the exit is already closing this position.`
      : "";
  const refusedNote =
    refused.length > 0
      ? ` ${refused.length === 1 ? "One signed claim belongs" : `${String(refused.length)} signed claims belong`} to funding the DVM refused and never expire; ${refused.length === 1 ? "it lowers" : "they lower"} the guaranteed floor until explicitly retired with 'dvm wallet x402-clear-pending --force'.`
      : "";
  renderWithdrawal(opts, {
    status: "initiated",
    metadata,
    amountMicro: amount,
    ...figures,
    readyAt,
    transaction: hash,
    ...(journalled.length > 0 ? { pendingFundings: journalled } : {}),
    display: `Started this x402 channel's full-position exit. Guaranteed floor: ${formatUsdcMicro(figures.guaranteedMicro)} USDC. Likely recovery if no further claims land: ${formatUsdcMicro(figures.likelyMicro)} USDC. The ${withdrawalWindow(metadata.config.withdrawDelay)} window ends ${new Date(readyAt * 1000).toISOString()}.`,
    hint: `This deliberately closes the relationship: new funding is refused while the withdrawal races. The DVM may still claim value the caller already authorized during the window, reducing the payout; the remaining escrow returns to this wallet. The caller paid network gas. Finalize with 'dvm wallet x402-withdraw-finalize --channel-id ${metadata.channelId}'.${retryFirst}${refusedNote}`,
  });
}

/** Finalize a matured payer withdrawal and return the channel funds onchain. */
export async function walletX402WithdrawFinalize(opts: WalletX402WithdrawalOptions): Promise<void> {
  // Deliberately no withX402ChannelLock: finalize signs no voucher and the
  // contract caps its payout against the live channel state at execution. The
  // upstream channel context and pending-funding journal read below are only
  // for reporting; they must never gate or parameterize this transaction
  // unless finalize moves under the channel lock too.
  const ctx = await withdrawalContext(opts);
  const { metadata, publicClient, walletClient, account } = ctx;
  const storage = new DvmX402ChannelStorage();
  const [pending, channel, nativeBalance, local, acknowledgedCumulativeAmount] = await Promise.all([
    onChain(
      ctx,
      `Reading the x402 channel's pending withdrawal with ${metadata.endpoint}`,
      READ_CONSEQUENCE,
      publicClient.readContract({
        address: BATCH_SETTLEMENT_ADDRESS,
        abi: X402_BATCH_CHANNEL_ABI,
        functionName: "pendingWithdrawals",
        args: [metadata.channelId],
      })
    ),
    onChain(
      ctx,
      `Reading the x402 channel with ${metadata.endpoint}`,
      READ_CONSEQUENCE,
      publicClient.readContract({
        address: BATCH_SETTLEMENT_ADDRESS,
        abi: X402_BATCH_CHANNEL_ABI,
        functionName: "channels",
        args: [metadata.channelId],
      })
    ),
    onChain(
      ctx,
      "Reading the x402 wallet's gas balance",
      READ_CONSEQUENCE,
      publicClient.getBalance({ address: account.address })
    ),
    storage.get(metadata.channelId),
    storage.getAcknowledgedCumulativeAmount(metadata.channelId),
  ]);
  await withX402ChannelLock(() =>
    storage.reconcileChainState(metadata.channelId, {
      balance: channel[0].toString(),
      totalClaimed: channel[1].toString(),
    })
  );
  if (pending[0] === 0n) {
    throw new DvmError(
      "x402_withdrawal_not_pending",
      "This channel has no timed withdrawal to finalize.",
      // A finalize that already succeeded reads identically to one that was
      // never started, so the advice has to cover both — telling a caller whose
      // exit just paid out to start another one is how a completed withdrawal
      // gets mistaken for a lost one.
      `If a finalize was already submitted for this channel, it landed and the escrow is back in this wallet — check 'dvm wallet balance'. Otherwise run 'dvm wallet x402-withdraw-initiate --channel-id ${metadata.channelId}' first, or use 'dvm credit drain' for the cooperative no-wait exit.`,
      { channel_id: metadata.channelId, network: metadata.network }
    );
  }
  const readyAt = pending[1] + metadata.config.withdrawDelay;
  const journalled = listPendingX402FundingsForChannel(metadata.channelId);
  const figures = withdrawalFigures(channel, local, acknowledgedCumulativeAmount, journalled);
  const now = Math.floor(Date.now() / 1000);
  if (now < readyAt) {
    throw new DvmError(
      "x402_withdrawal_not_ready",
      `The channel withdrawal is still inside its ${withdrawalWindow(metadata.config.withdrawDelay)} window until ${new Date(readyAt * 1000).toISOString()}.`,
      "Retry finalize at or after that time; the DVM may claim already-authorized vouchers during the delay.",
      { channel_id: metadata.channelId, ready_at: new Date(readyAt * 1000).toISOString() }
    );
  }
  if (nativeBalance === 0n) throw gasRequired(ctx, "then retry finalize.");
  const hash = await onChain(
    ctx,
    `Finalizing the timed exit on the x402 channel with ${metadata.endpoint}`,
    FINALIZE_CONSEQUENCE,
    walletClient.writeContract({
      account,
      chain: walletClient.chain,
      address: BATCH_SETTLEMENT_ADDRESS,
      abi: X402_BATCH_CHANNEL_ABI,
      functionName: "finalizeWithdraw",
      args: [metadata.config],
    }),
    { gas: { balance: nativeBalance, retry: "then retry finalize." } }
  );
  const receipt = await onChain(
    ctx,
    `Waiting for the timed exit's final transaction ${hash}`,
    FINALIZE_CONSEQUENCE,
    publicClient.waitForTransactionReceipt({ hash })
  );
  if (receipt.status !== "success") {
    throw new DvmError(
      "x402_withdrawal_reverted",
      "The final withdrawal transaction reverted onchain.",
      "The withdrawal remains pending. Check the transaction hash and channel state before retrying.",
      { transaction: hash }
    );
  }
  const finalized = parseEventLogs({
    abi: X402_BATCH_CHANNEL_ABI,
    logs: receipt.logs,
    eventName: "WithdrawFinalized",
  }).find((event) => event.args.channelId.toLowerCase() === metadata.channelId.toLowerCase());
  const recovered =
    finalized?.args.amount ?? x402FinalizedWithdrawalAmount(pending[0], channel[0], channel[1]);
  // Another CLI can fund this channel after the receipt and before this one
  // updates its projection. Re-read while holding the shared channel lock so a
  // fresh funding cannot be overwritten by a synthetic terminal zero.
  await withX402ChannelLock(async () => {
    const latestChannel = await onChain(
      ctx,
      `Refreshing the finalized x402 channel with ${metadata.endpoint}`,
      FINALIZE_RECONCILE_CONSEQUENCE,
      publicClient.readContract({
        address: BATCH_SETTLEMENT_ADDRESS,
        abi: X402_BATCH_CHANNEL_ABI,
        functionName: "channels",
        args: [metadata.channelId],
      })
    );
    await storage.reconcileChainState(metadata.channelId, {
      balance: latestChannel[0].toString(),
      totalClaimed: latestChannel[1].toString(),
    });
  });
  renderWithdrawal(opts, {
    status: "finalized",
    metadata,
    amountMicro: recovered,
    ...figures,
    readyAt,
    transaction: hash,
    ...(journalled.length > 0 ? { pendingFundings: journalled } : {}),
    display: `Finalized the x402 channel exit and returned ${formatUsdcMicro(recovered)} USDC to this wallet.`,
    hint:
      recovered === 0n
        ? "The DVM claimed the full authorized remainder during the window. The timed exit is complete and is not wedged; no escrow remains for the caller to withdraw."
        : "The caller paid network gas. Any reduction from the earlier likely figure was value the DVM claimed under the caller's existing authorization during the window.",
  });
}

/**
 * Copy for the positional a connect never accepts. The commander
 * slot survives only as this catcher: dropping it would let a caller who types
 * their key still leak it to shell history and `ps` while the command silently
 * succeeded by generating a *different* wallet, which is worse than refusing.
 */
const X402_POSITIONAL_REFUSAL: PositionalRefusalCopy = {
  code: "invalid_argument",
  keyRemedy:
    "Import it with `dvm wallet x402-connect --key-file <path>`, `DVM_X402_KEY=<key> dvm wallet x402-connect`, or `cat key.txt | dvm wallet x402-connect` — or run `dvm wallet x402-connect` with no argument at all to generate a fresh wallet instead.",
  message: "`dvm wallet x402-connect` takes no positional argument.",
  // The non-key arm names the chain routes too: this command's only argument-
  // shaped input is a CAIP-2 chain id, and the caller who typed one is the
  // likeliest person to land here without having leaked anything.
  hint: "A chain goes in `--network <caip2>` (or `dvm wallet x402-network <caip2>` for a wallet already connected). A private key goes in `--key-file <path>`, the DVM_X402_KEY env var, or piped stdin — never a positional argument. Run `dvm wallet x402-connect` with no argument to generate a fresh wallet instead.",
};

/**
 * Resolve and validate an imported key, or return `undefined` for the generate
 * branch. Validation of a key that *is* supplied is the path, unchanged.
 *
 * `--key-file` and `DVM_X402_KEY` are unambiguous claims to be importing: a key
 * that then fails to resolve is an error, never a silent fresh wallet. Piped
 * stdin is not — an `fstat` can't tell a pipe carrying a key from one an agent
 * harness opened and never wrote to (both are FIFOs), so when stdin is the only
 * claim and it yields nothing, that is the no-key case and the command
 * generates rather than failing on `missing_key` / `no_input`.
 *
 * No positional is forwarded: `walletX402Connect` refuses one outright, so a
 * key on argv can never reach the resolver's warn-and-import arm.
 */
async function readImportedKey(opts: WalletX402ConnectOptions): Promise<`0x${string}` | undefined> {
  const declared = Boolean(opts.keyFile) || Boolean(process.env.DVM_X402_KEY);
  if (!declared && !hasPipedStdin()) return undefined;

  let resolved;
  try {
    resolved = await resolveSecretInput({
      file: opts.keyFile,
      envValue: process.env.DVM_X402_KEY,
      config: X402_SECRET_CONFIG,
    });
  } catch (err) {
    // A pipe nobody ever wrote to drains to the 10s timeout. Nothing was
    // claimed, so nothing is missing.
    if (!declared && err instanceof DvmError && err.code === "no_input") return undefined;
    throw err;
  }
  const privateKey = resolved.value.trim();
  if (!privateKey) {
    if (!declared) return undefined;
    throw new DvmError(
      "missing_key",
      "No private key provided.",
      "Use --key-file <path>, set DVM_X402_KEY env var, or pipe the key via stdin. To have dvm create a wallet for you instead, run `dvm wallet x402-connect` with no key at all."
    );
  }
  if (!isValidEvmPrivateKey(privateKey)) {
    throw new DvmError(
      "invalid_key",
      "Invalid secp256k1 private key.",
      "Provide a valid 32-byte secp256k1 private key prefixed with 0x (66 characters total)."
    );
  }
  return privateKey;
}

function isSameAccount(privateKey: string, address: string): boolean {
  try {
    return (
      privateKeyToAccount(privateKey as `0x${string}`).address.toLowerCase() ===
      address.toLowerCase()
    );
  } catch {
    return false;
  }
}

function walletExistsError(address: string, network: string): DvmError {
  return new DvmError(
    "x402_wallet_exists",
    `An x402 wallet is already connected (${address} on ${network}).`,
    "Pass --force to replace it, or run 'dvm wallet x402-disconnect' first. Both refuse while that wallet still controls channel funds, because only its key can withdraw them.",
    { address, network }
  );
}

/**
 * Both refusals that stand between a caller and losing the key they need: a
 * voucher this key already signed, which outlives the config entry and stays
 * claimable, and a channel that still holds value onchain
 * Replacing has no `--with-pending` equivalent — `x402-clear-
 * pending` is the one command that discards a signed voucher on purpose.
 */
async function assertReplaceable(existing: { address: string; network: string }): Promise<void> {
  const pending = listPendingX402Fundings().filter((entry) => x402PendingUnsettled(entry));
  if (pending.length > 0) throw pendingFundingsError(pending, "replace");
  await assertX402WalletIdle({ address: existing.address, network: existing.network }, "replace");
}

/**
 * One refusal for both ways of losing the key . The remedy
 * is the same either way — settle the voucher or retire it on purpose — and
 * only disconnect has an "accept the loss" flag to name.
 *
 * Scoped by the caller to entries that can still put money into a channel: a
 * live voucher, or a refused one whose deposit authorization has not expired
 * Past that point a refused entry strands nothing this key is
 * needed for, and `assertX402WalletIdle` is the check that still matters.
 */
function pendingFundingsError(
  pending: PendingX402Funding[],
  intent: "replace" | "disconnect"
): DvmError {
  const one = pending.length === 1;
  const retriable = pending.filter((entry) => !x402PendingRetired(entry));
  const retries = retriable
    .map((entry) => `'dvm credit fund ${entry.endpoint} --credit-id ${entry.creditId}'`)
    .join(", ");
  const escape =
    intent === "disconnect"
      ? ", or pass --with-pending to disconnect anyway"
      : ", then retry the replacement";
  const refused = pending.filter(x402PendingRetired);
  // A refused entry in scope makes the plain clear a dead end: it comes back
  // with `x402_voucher_reserved`, so the command named here has to be the one
  // that actually completes.
  const clear = `'dvm wallet x402-clear-pending --all${refused.length > 0 ? " --force" : ""}'`;
  const retry =
    retriable.length > 0
      ? `Retry ${retriable.length === 1 ? "that funding" : "those fundings"} (${retries}), retire ${one ? "it" : "them"} with ${clear}${escape}.`
      : `Retire ${one ? "it" : "them"} with ${clear}${escape}.`;
  const waitOut =
    refused.length > 0
      ? ` ${refused.length === 1 ? "One was" : `${String(refused.length)} were`} refused by the DVM and cannot be retried; this refusal lifts for ${refused.length === 1 ? "it" : "them"} at ${new Date(
          Math.max(...refused.map(x402PendingBlockExpiresAt))
        ).toISOString()}.`
      : "";
  return new DvmError(
    "x402_pending_fundings",
    `${describeCount(pending.length)} still awaiting acknowledgement, and this key is the only one that can settle or exit ${one ? "it" : "them"}.`,
    `${retry}${waitOut}`,
    { pending_fundings: pending.map(x402PendingFundingJson) }
  );
}

/**
 * One shape, two renderers. `display` says what just happened and `hint` what
 * to do next — both written to be relayed to a human verbatim, since the reader
 * deciding which dollar to buy is usually not the one running the command.
 *
 * this is the last output a caller reads before sending money, so it
 * names the dollar as well as the chain. The rail reads one contract on one
 * chain, and funding either of them wrong reads as $0.00 with no other symptom.
 * Both come off the chain that was actually persisted, which an omitted
 * `--network` leaves as whatever was already configured.
 */
function emitConnectOutput(
  opts: WalletX402ConnectOptions,
  connected: { address: string; network: string; generated: boolean },
  handoff: StablecoinFundingHandoff
): void {
  const { network, generated } = connected;
  const asset = resolveX402Asset(network);
  const where = x402NetworkLabel(network);
  const display = generated
    ? `Created a fresh x402 wallet on ${where}. It holds nothing until it is funded; relay the address standalone and attach the QR separately.`
    : `x402 wallet connected on ${where}; relay the address standalone and attach the QR separately.`;
  const hint = connectHint(asset, generated);
  if (opts.human) {
    info(
      `x402 wallet ${generated ? "created" : "connected"} · ${asset?.networkLabel ?? network} (${network}; chain ${String(chainIdFromCaip2(network))})${asset ? ` · ${asset.label} · contract ${asset.address}` : ""}`
    );
    printStablecoinFundingHandoff(handoff);
    info("");
    if (asset) {
      info(
        `Fund it with ${asset.label} — contract ${asset.address}. A bridged dollar${asset.confusable ? ` such as ${asset.confusable}` : ""}, or USDC on another chain, is a different token and reads as $0.00 here.`
      );
    }
    if (generated) info(CUSTODY_NOTE);
    return;
  }
  json({
    status: generated ? "generated" : "connected",
    rail: "x402",
    network,
    chain_id: chainIdFromCaip2(network),
    ...(asset ? { asset: asset.symbol, token: asset.address } : {}),
    ...stablecoinFundingHandoffJson(handoff),
    display,
    ...(hint ? { hint } : {}),
  });
}

function connectHint(asset: X402Asset | null, generated: boolean): string | undefined {
  const funding = asset
    ? `Fund this address with ${asset.label} (${asset.address}) on ${asset.networkLabel}. A bridged dollar${asset.confusable ? ` such as ${asset.confusable}` : ""}, or USDC on another chain, is a different token and will read as $0.00 in \`dvm wallet balance\`.`
    : undefined;
  if (!generated) return funding;
  return funding ? `${funding} ${CUSTODY_NOTE}` : CUSTODY_NOTE;
}

/**
 * Said only on the generate path. An imported key has a copy somewhere by
 * definition; a generated one exists nowhere else, and channel funds are
 * unrecoverable without it.
 */
const CUSTODY_NOTE =
  "The private key was written to the dvm config (mode 0600) and is never printed — back that file up, because x402 channel funds can only be withdrawn with it.";

async function withdrawalContext(
  opts: WalletX402WithdrawalOptions,
  policy: { refuseAmbiguousBare?: boolean } = {}
) {
  const wallet = loadX402Wallet();
  if (!wallet) throw new DvmError("x402_wallet_missing", "No x402 wallet is connected.");
  const addressed = await ensureAddress(wallet);
  const endpoint = opts.dvm ? resolveChannelEndpoint(opts.dvm) : undefined;
  const bare = !opts.channelId && !endpoint;
  const candidates =
    policy.refuseAmbiguousBare && bare ? listX402Channels({ payer: addressed.address }) : undefined;
  if (candidates && candidates.length > 1) throw ambiguousX402Channel(candidates);
  const metadata =
    candidates !== undefined
      ? candidates[0]
      : findX402Channel({
          ...(opts.channelId ? { channelId: opts.channelId } : {}),
          ...(endpoint ? { endpoint } : {}),
        });
  if (!metadata) {
    throw new DvmError(
      "x402_channel_not_found",
      "No persisted x402 batch channel matches this request.",
      "Fund an x402-backed credit first, or pass --channel-id from an earlier funding result."
    );
  }
  assertX402ChannelPayer(metadata, addressed.address);
  // Deliberately no chain check: this exit reads and withdraws on the channel's
  // own network, so it keeps working across an `x402-network` re-pin.
  const spec = x402NetworkByCaip2(metadata.network);
  if (!spec)
    throw new DvmError("x402_unsupported_network", `Unsupported network ${metadata.network}.`);
  const chain = chains[spec.viemChain as keyof typeof chains] as Parameters<
    typeof createPublicClient
  >[0]["chain"];
  // Which is exactly why the endpoint has to be chain-scoped: reading on the
  // channel's own network means the wallet's `DVM_X402_RPC_URL` may speak for a
  // different chain entirely, and the settlement contract answers `(0, 0)` there
  // rather than erroring — a full channel reported as already claimed, with the
  // emergency exit refusing over it.
  const rpc = resolveX402ChannelRpc(
    metadata.network,
    addressed.network,
    chain?.rpcUrls.default.http[0]
  );
  const account = privateKeyToAccount(addressed.privateKey as `0x${string}`);
  const transportOptions = resolveRpcHttpTransportOptions(
    rpc.source,
    process.env.DVM_X402_RPC_HEADERS_JSON
  );
  return {
    metadata,
    spec,
    rpc,
    account,
    publicClient: createPublicClient({
      chain,
      transport: transportOptions ? http(rpc.url, transportOptions) : http(rpc.url),
    }),
    walletClient: createWalletClient({
      account,
      chain,
      transport: transportOptions ? http(rpc.url, transportOptions) : http(rpc.url),
    }),
  };
}

type WithdrawalContext = Awaited<ReturnType<typeof withdrawalContext>>;

/**
 * Run one chain call, turning anything viem throws into a refusal an agent can
 * relay and a caller can act on.
 *
 * Unwrapped, these reached the terminal verbatim — and viem writes its own
 * `URL:` line into the message, so the caller's endpoint, API key in the path
 * and all, went with them . Every endpoint this names is
 * redacted, including the one inside the underlying message: naming only the
 * one we resolved would leave a second, clear copy sitting in the text.
 *
 * A `DvmError` passes through — the local refusals this wraps already say
 * something better than "the endpoint didn't answer".
 */
async function onChain<T>(
  ctx: WithdrawalContext,
  operation: string,
  consequence: string,
  call: Promise<T>,
  options: { gas?: { balance: bigint; retry: string } } = {}
): Promise<T> {
  try {
    return await call;
  } catch (err) {
    if (err instanceof DvmError) throw err;
    if (options.gas && isInsufficientFundsError(err)) {
      throw gasRequired(
        ctx,
        options.gas.retry,
        options.gas.balance,
        insufficientFundsShortfallWei(err)
      );
    }
    const { spec, rpc, metadata } = ctx;
    const cause = redactUrlsInText(err instanceof Error ? err.message : String(err));
    const endpointClause = rpc.url ? ` (${redactUrl(rpc.url)})` : "";
    // The CAIP-2 id rides along with the label wherever the chain is named, the
    // way `lifecycle.ts` does it: it is what 'dvm wallet x402-network' takes, so
    // a caller acting on this refusal can paste it rather than derive it.
    const chainName = `${spec.label} (${metadata.network})`;
    // Which knob is the caller's to turn depends on whose endpoint this was —
    // and on whether their override was even allowed to apply here.
    const remedy = rpc.overrideOutOfScope
      ? `This channel is on ${chainName}, not the chain the x402 wallet is pinned to, so DVM_X402_RPC_URL did not apply to it — it stays scoped to the pinned chain, because the settlement contract shares one address across chains and a cross-chain read would report a funded channel as empty. Verify connectivity to ${spec.label}'s bundled endpoint${endpointClause}, then retry.`
      : rpc.source === "override"
        ? `DVM_X402_RPC_URL sent this to ${redactUrl(rpc.url ?? "")}. Correct it, or unset it to fall back to ${spec.label}'s bundled endpoint, then retry.`
        : `Verify connectivity to ${spec.label}'s bundled endpoint${endpointClause}, or send it somewhere else with DVM_X402_RPC_URL, then retry.`;
    throw new DvmError(
      "x402_rpc_error",
      `${operation} on ${chainName} failed: ${cause}`,
      `${remedy} ${consequence}`,
      {
        channel_id: metadata.channelId,
        endpoint: metadata.endpoint,
        network: metadata.network,
        rpc_source: rpc.source,
      }
    );
  }
}

/** Said after a read: the caller's position is exactly where they left it. */
const READ_CONSEQUENCE =
  "Nothing was signed or submitted, and the channel balance is untouched — an endpoint that didn't answer is not evidence about the money.";

/**
 * Said after initiate's submit, where the honest answer is that we don't know.
 * Re-running is safe because the verb reads the channel's current state first: a
 * transaction that did land comes back as `already_initiated`, with its window.
 */
const INITIATE_CONSEQUENCE =
  "The transaction may or may not have reached the chain. Re-run this command — it reads the channel's current state before submitting anything, so one that did land is reported as already_initiated rather than sent a second time.";

/**
 * Said after finalize's submit. Re-running is equally safe, but it does not read
 * back as cleanly: a finalize that landed clears the pending withdrawal, so the
 * re-run refuses with `x402_withdrawal_not_pending` — which on a channel that
 * was mid-exit is the confirmation, not a reason to start another one.
 */
const FINALIZE_CONSEQUENCE =
  "The transaction may or may not have reached the chain. Re-run this command — it reads the channel's current state before submitting anything, so it will never finalize twice. A re-run that refuses with x402_withdrawal_not_pending means the earlier transaction landed and the escrow is already back in this wallet; check the balance with 'dvm wallet balance' rather than starting a fresh exit.";

/** Said after finalize landed but its authoritative local refresh failed. */
const FINALIZE_RECONCILE_CONSEQUENCE =
  "The timed exit landed, but its latest channel state was not saved locally. Run 'dvm wallet balance' to reconcile the record before relying on its stored figure.";

function resolveChannelEndpoint(identifier: string): string {
  if (identifier.startsWith("http://") || identifier.startsWith("https://")) return identifier;
  if (identifier.startsWith("@")) return resolveEndpoint(identifier);
  return resolveDvmReference(identifier).endpoint;
}

function renderWithdrawal(
  opts: WalletX402WithdrawalOptions,
  value: {
    status: string;
    metadata: StoredX402ChannelMetadata;
    amountMicro: bigint;
    guaranteedMicro: bigint;
    likelyMicro: bigint;
    readyAt: number;
    transaction?: string;
    pendingFundings?: PendingX402Funding[];
    display: string;
    hint: string;
  }
): void {
  if (opts.human) {
    info(value.display);
    info(value.hint);
    if (value.transaction) info(`Transaction: ${value.transaction}`);
    return;
  }
  json({
    status: value.status,
    channel_id: value.metadata.channelId,
    endpoint: value.metadata.endpoint,
    network: value.metadata.network,
    amount_micro: value.amountMicro.toString(),
    amount_usdc: formatUsdcMicro(value.amountMicro),
    guaranteed_micro: value.guaranteedMicro.toString(),
    guaranteed_usdc: formatUsdcMicro(value.guaranteedMicro),
    likely_micro: value.likelyMicro.toString(),
    likely_usdc: formatUsdcMicro(value.likelyMicro),
    ready_at: new Date(value.readyAt * 1000).toISOString(),
    ...(value.transaction ? { transaction: value.transaction } : {}),
    ...(value.pendingFundings?.length
      ? { pending_fundings: value.pendingFundings.map(x402PendingFundingJson) }
      : {}),
    display: value.display,
    hint: value.hint,
  });
}

/**
 * Refuse a transaction the caller cannot pay for, in the asset the chain the
 * channel is on actually charges.
 *
 * The channel's chain, not the wallet's pinned one: this exit deliberately
 * follows `metadata.network` across an `x402-network` re-pin, so the
 * two differ exactly when the caller most needs to be told which chain to fund.
 * And the asset is the row's own — "Base Sepolia ETH" was hardcoded, and there
 * is no ETH to buy on Polygon or Avalanche.
 */
function gasRequired(
  ctx: WithdrawalContext,
  retry: string,
  balance = 0n,
  shortfall?: bigint
): DvmError {
  const { spec, metadata, account } = ctx;
  const balanceClause =
    balance === 0n
      ? `holds no ${spec.nativeGas}`
      : shortfall !== undefined
        ? `holds only ${formatEther(balance)} ${spec.nativeGas} and is short by ${formatEther(shortfall)} ${spec.nativeGas}`
        : `holds only ${formatEther(balance)} ${spec.nativeGas}, which is not enough`;
  return new DvmError(
    "x402_gas_required",
    `The x402 wallet ${balanceClause} to pay gas on ${spec.label} (${metadata.network}), the chain this channel lives on.`,
    `No transaction was submitted. Fund ${account.address} with a small amount of ${spec.label} ${spec.nativeGas}, ${retry}`,
    {
      channel_id: metadata.channelId,
      network: metadata.network,
      native_asset: spec.nativeGas,
      address: account.address,
      balance_wei: balance.toString(),
      ...(shortfall !== undefined ? { shortfall_wei: shortfall.toString() } : {}),
      transaction_submitted: false,
    }
  );
}

/** Refuse a bare destructive exit when the local store names several DVMs. */
function ambiguousX402Channel(channels: StoredX402ChannelMetadata[]): DvmError {
  const choices = channels
    .map(
      (channel) =>
        `${channel.endpoint}: 'dvm wallet x402-withdraw-initiate --channel-id ${channel.channelId}'`
    )
    .join("\n");
  return new DvmError(
    "x402_channel_ambiguous",
    `${String(channels.length)} persisted x402 channels match a bare withdrawal initiation, so no transaction was submitted.`,
    `Choose the DVM or exact channel to close:\n${choices}`,
    {
      channels: channels.map((channel) => ({
        channel_id: channel.channelId,
        endpoint: channel.endpoint,
        credit_id: channel.creditId,
        network: channel.network,
      })),
      transaction_submitted: false,
    }
  );
}

/** Whether viem classified any layer of a failed write as insufficient funds. */
function isInsufficientFundsError(err: unknown): boolean {
  if (err instanceof InsufficientFundsError) return true;
  return (
    err instanceof BaseError &&
    err.walk((cause) => cause instanceof InsufficientFundsError) !== null
  );
}

/** Read the exact node-reported gas deficit when its insufficient-funds detail carries one. */
function insufficientFundsShortfallWei(err: unknown): bigint | undefined {
  let current: unknown = err;
  while (current instanceof Error) {
    const overshot = /overshot\s+(\d+)/i.exec(current.message)?.[1];
    if (overshot) return BigInt(overshot);
    const haveAndWant = /\bhave\s+(\d+)\s+want\s+(\d+)/i.exec(current.message);
    if (haveAndWant) {
      const have = BigInt(haveAndWant[1]);
      const want = BigInt(haveAndWant[2]);
      if (want > have) return want - have;
    }
    const balanceAndCost = /balance\s+(\d+).*?(?:tx cost|cost)\s+(\d+)/i.exec(current.message);
    if (balanceAndCost) {
      const balance = BigInt(balanceAndCost[1]);
      const cost = BigInt(balanceAndCost[2]);
      if (cost > balance) return cost - balance;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

/**
 * The three figures a caller needs before and during a timed exit.
 *
 * The floor takes the *largest* of the three cumulative records rather than the
 * first one that exists (a residual). They advance
 * independently: `signedMaxClaimable` is upstream's, written once by corrective
 * recovery and never moved by an ordinary acknowledgement, while
 * `acknowledgedCumulativeAmount` is dvmkit's and moves on every one — so a
 * channel that was corrected and then went on being used has a stale-low
 * upstream figure that first-defined-wins let overstate the guaranteed floor,
 * which is the one figure a caller relays as safe.
 */
function withdrawalFigures(
  channel: readonly [bigint, bigint],
  local: { signedMaxClaimable?: string } | null | undefined,
  acknowledgedCumulativeAmount: string | undefined,
  journalled: PendingX402Funding[]
): { guaranteedMicro: bigint; likelyMicro: bigint } {
  const totalClaimed = channel[1];
  const reservationFloor = [local?.signedMaxClaimable, acknowledgedCumulativeAmount].reduce(
    (highest, recorded) => {
      const cap = recorded === undefined ? 0n : BigInt(recorded);
      return cap > highest ? cap : highest;
    },
    totalClaimed
  );
  const reserved = x402ChannelReservation(journalled, reservationFloor);
  return {
    guaranteedMicro: channel[0] > reserved ? channel[0] - reserved : 0n,
    likelyMicro: x402WithdrawalRemainder(channel[0], totalClaimed),
  };
}

function withdrawalWindow(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return days === 1 ? "24-hour" : `${String(days)}-day`;
  }
  if (seconds % 3_600 === 0) return `${String(seconds / 3_600)}-hour`;
  if (seconds % 60 === 0) return `${String(seconds / 60)}-minute`;
  return `${String(seconds)}-second`;
}

function renderPendingList(
  opts: WalletX402ClearPendingOptions,
  entries: PendingX402Funding[]
): void {
  const refused = entries.filter(x402PendingRetired);
  const display =
    entries.length === 0
      ? "No x402 channel funding is waiting for acknowledgement."
      : `${describeCount(entries.length)} journalled${refused.length > 0 ? `, ${String(refused.length)} of ${entries.length === 1 ? "which the DVM refused" : "them refused by their DVM"}` : ""}.`;
  const hint =
    entries.length === 0
      ? "Nothing to retire."
      : `Retry a funding with 'dvm credit fund <dvm> --credit-id <id>', or retire one with 'dvm wallet x402-clear-pending --credit-id <id>' (--force while it is under a day old).${refused.length > 0 ? " A refused funding cannot be retried and stops blocking on the deadline shown against it, but its claim never expires: it stays reserved from the timed exit until --force retires it." : ""}`;
  if (opts.human) {
    info(display);
    for (const entry of entries) {
      info(
        `  ${entry.creditId} at ${entry.endpoint} — $${formatUsdcMicro(BigInt(entry.amountMicro))} funded, signed ${describeAge(entry)}${describeState(entry)}`
      );
    }
    info(hint);
    return;
  }
  json({ status: "pending", pending_fundings: entries.map(x402PendingFundingJson), display, hint });
}

function describeState(entry: PendingX402Funding): string {
  if (!x402PendingRetired(entry)) return x402PendingStale(entry) ? " (looks abandoned)" : "";
  if (!x402PendingUnsettled(entry)) {
    return " (refused by the DVM; blocks no funding, and its claim never expires)";
  }
  const until = new Date(x402PendingBlockExpiresAt(entry)).toISOString();
  return x402PendingDepositExpiresAt(entry) !== undefined
    ? ` (refused by the DVM; its deposit is submittable until ${until}, and its claim never expires)`
    : ` (refused by the DVM; it names no deposit deadline, so funding stays blocked until ${until}, and its claim never expires)`;
}

function describeCount(count: number): string {
  return `${String(count)} signed x402 ${count === 1 ? "voucher" : "vouchers"}`;
}

function describeAge(entry: PendingX402Funding): string {
  const hours = Math.floor((Date.now() - entry.requestedAt) / 3_600_000);
  if (hours < 1) return "less than an hour ago";
  if (hours < 48) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
}

function formatUsdcMicro(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fraction.padEnd(2, "0") || "00"}`;
}
