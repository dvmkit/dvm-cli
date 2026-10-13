import { DvmError, formatUsdcMicrounits, listX402Channels, readX402ChannelGuardFacts, type X402ChannelClient } from "@dvmkit/sdk/internal";

/** What the caller is about to do to the configured key — drives the remedy copy. */
export type X402WalletIntent = "replace" | "disconnect";

/** The public half of the wallet under scrutiny: who it pays as, and on which chain. */
export interface X402WalletIdentity {
  /** Payer address the channel salts are derived from. */
  address: string;
  /** CAIP-2 chain the wallet is pinned to — the one `DVM_X402_RPC_URL` speaks for. */
  network: string;
}

/**
 * Throw unless the currently configured payer provably controls no x402 funds.
 *
 * Run inside {@link withX402ChannelLock} together with the config write it
 * guards, so a concurrent funding can't sign a voucher between the check and
 * the moment the key it signed with stops being the configured one.
 *
 * Throws `x402_wallet_in_use` when a channel still holds value, and
 * `x402_rpc_error` / `x402_unsupported_network` when safety can't be
 * established at all. Every one of those leaves the key exactly as it was.
 */
export async function assertX402WalletIdle(
  wallet: X402WalletIdentity,
  intent: X402WalletIntent
): Promise<void> {
  const payerAddress = wallet.address;
  const owned = listX402Channels({ payer: payerAddress });
  const clients = new Map<string, X402ChannelClient>();
  for (const channel of owned) {
    const state = await readX402ChannelGuardFacts({ channel, configuredNetwork: wallet.network, clients });
    if (state.balance === 0n && state.pendingWithdrawal === 0n) continue;
    throw new DvmError(
      "x402_wallet_in_use",
      state.balance > 0n
        ? `The connected x402 wallet still holds ${formatUsdcMicrounits(state.balance)} USDC in an open channel with ${channel.endpoint}.`
        : `The connected x402 wallet has a timed withdrawal of ${formatUsdcMicrounits(state.pendingWithdrawal)} USDC still in flight on its channel with ${channel.endpoint}.`,
      `Only this key can move those funds. Empty the channel first — 'dvm credit drain' for the cooperative exit, or 'dvm wallet x402-withdraw-initiate --channel-id ${channel.channelId}' and then finalize after the delay — and ${intentClause(intent)}.`,
      {
        anchor: "x402_channel_live",
        address: payerAddress,
        channel_id: channel.channelId,
        endpoint: channel.endpoint,
        network: channel.network,
        balance_micro: state.balance.toString(),
        pending_withdrawal_micro: state.pendingWithdrawal.toString(),
      }
    );
  }
}


function intentClause(intent: X402WalletIntent): string {
  return intent === "replace" ? "retry the replacement" : "retry 'dvm wallet x402-disconnect'";
}
