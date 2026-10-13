/**
 * The safety preflight that stands between the caller's Tempo key and the
 * collateral only that key can close.
 *
 * A TIP-1034 session channel pays its refund back to the wallet that opened it,
 * and the local record is the only copy of the descriptor a unilateral exit
 * needs. So dropping `config.tempo` — or replacing it — is not a settings
 * change: any deposit the old key still controls becomes unreachable.
 *
 * The check is therefore grounded in chain state rather than in what the local
 * journal remembers. Counting records refused on the journal alone, and a
 * cooperative close the caller was merely *told* about leaves its record behind
 * so a wallet being decommissioned met a refusal with nothing left to close,
 * and nothing it could run that would ever clear it. Refusing only on a channel
 * the escrow confirms still holds collateral is the line that is both safe and
 * eventually passable. It is the Tempo twin of
 * {@link import("../x402/lifecycle").assertX402WalletIdle}, which reached the
 * same shape for the same reason.
 *
 * The two directions are not symmetric, and the asymmetry is deliberate. On the
 * read surfaces (`dvm wallet balance`) an unreadable chain reports what it
 * couldn't establish and carries on; here it refuses, because an endpoint that
 * didn't answer is not evidence a channel is empty.
 */

import { findSigningIdentityByPubkey } from "../cli-identity-resolve";

import { formatUsdcMicrounits } from "@dvmkit/sdk/internal";

import { DvmError } from "@dvmkit/sdk/internal";

import { shellQuoteArg } from "@dvmkit/sdk/internal";

import { listTempoChannelAssociations, loadTempoChannelController, type TempoChannelAssociation, tempoChannelControlledBy } from "@dvmkit/sdk/internal";

import { reconcileTempoChannelOnChain, type TempoChannelReconcileResult } from "@dvmkit/sdk/internal";

import { connectedTempoAccount } from "./tempo-wallet";

/** What the caller is about to do to the configured Tempo key — drives the remedy copy. */
export type TempoWalletIntent = "replace" | "disconnect";

/**
 * Throw unless the escrow confirms the configured Tempo key controls no
 * collateral.
 *
 * *The configured key's* channels, not every channel this machine ever
 * recorded. The store keeps a record until something proves the channel
 * terminal, so a key that was lost and replaced leaves its channels behind —
 * and judging those against the key configured today attributes a stranger's
 * collateral to it. The refusal then says something false in its load-bearing
 * clause, and every remedy it offers needs a key nobody holds, which turns a
 * recoverable state into an unreplaceable key slot. Ownership is
 * read from each record's descriptor, and a record whose descriptor is gone
 * still counts as this key's: see {@link tempoChannelControlledBy}.
 *
 * Every owned record is reconciled against the chain — which retires the
 * records of channels already closed, so a run that ends in a refusal still
 * makes progress on the next one — and the refusal names the channel that
 * blocked it, its endpoint and what the escrow holds for it.
 *
 * Broadcasts nothing: the only chain call is
 * {@link reconcileTempoChannelOnChain}, whose seam is narrowed to one `view`
 * call, and whose retirement is a local file write.
 *
 * Throws `tempo_channels_active` on a channel that still holds collateral or
 * whose open the escrow has no record of, and `tempo_rpc_error` /
 * `tempo_chain_read_failed` when the chain could not be read at all. Every one
 * of those leaves the key exactly as it was.
 */
export async function assertTempoWalletIdle(intent: TempoWalletIntent): Promise<void> {
  const connected = await connectedTempoAccount();
  // No derivable key means there is no signing authority for this change to
  // destroy — including the `tempo` block whose apiKey isn't a key at all,
  // which `dvm doctor` diagnoses and whose repair is exactly this disconnect
  // The x402 restore gate skips its own check on the same grounds.
  if (!connected) return;
  const records = await ownedTempoChannelRecords(connected.address);
  const verdicts = await Promise.all(
    records.map(async (association) => ({
      association,
      chain: await reconcileTempoChannelOnChain({ association }),
    }))
  );
  // Ordered by how much the caller can act on it rather than by record age: a
  // channel the escrow confirms it still funds is the one to empty first, and
  // an endpoint that wouldn't answer says nothing about any of them.
  let blocker: (typeof verdicts)[number] | undefined;
  for (const status of BLOCKING_ORDER) {
    blocker = verdicts.find((verdict) => verdict.chain.status === status);
    if (blocker) break;
  }
  if (!blocker) return;
  const blocking = verdicts.filter((verdict) => verdict.chain.status !== "closed").length;
  throw blocker.chain.status === "unreadable"
    ? blocker.chain.error?.code === "tempo_channel_not_found"
      ? descriptorlessChannelError(blocker.association, blocker.chain, intent, blocking)
      : unreadableChainError(blocker.association, blocker.chain, intent, blocking)
    : liveChannelError(blocker.association, blocker.chain, intent, blocking);
}

/**
 * The recorded channels the configured key can still act on.
 *
 * Read straight off each record's descriptor rather than projected onto the
 * association: the store has never carried a payer, and back-filling one would
 * leave every pre-existing record unattributed — the exact records this filter
 * exists for. The reads are local file reads, and they run before any chain
 * call, so a store full of strangers' channels costs no RPC at all.
 *
 * A read that throws — mppx `JSON.parse`s each stored entry, so one corrupt
 * value is enough — is not an answer, and a guard that fails open on it would
 * release the key slot over collateral it never established was gone. It counts
 * as this key's, and the chain pass below reports it as `unreadable`.
 */
async function ownedTempoChannelRecords(address: string): Promise<TempoChannelAssociation[]> {
  const records = listTempoChannelAssociations();
  const controlled = await Promise.all(
    records.map(async (association) =>
      tempoChannelControlledBy(
        await loadTempoChannelController(association).catch(() => undefined),
        address
      )
    )
  );
  return records.filter((_, index) => controlled[index]);
}

/** Which chain verdicts refuse, most consequential first. `closed` is the only one that passes. */
const BLOCKING_ORDER: TempoChannelChainStatus[] = ["open", "closing", "unconfirmed", "unreadable"];

/**
 * Refuse over collateral the escrow accounts for, in the wording
 * `dvm wallet balance` uses for the same three verdicts.
 *
 * `unconfirmed` refuses too: an open the escrow has no record of may still be
 * confirming, and the record is what closes its deposit if it lands. That is
 * the one refusal `wallet tempo-exit --abandon` exists to release, so the hint
 * names it — and names the pending funding that would restore the record, since
 * abandoning while such a funding survives is the trade the record exists to
 * avoid.
 */
function liveChannelError(
  association: TempoChannelAssociation,
  chain: TempoChannelReconcileResult,
  intent: TempoWalletIntent,
  blocking: number
): DvmError {
  // The escrow's figure for every channel it knows about. For a provisional
  // open its zero is an absence rather than a balance, so that row falls back
  // to what this wallet's open committed — the `wallet balance` rule.
  const depositMicro =
    chain.status === "unconfirmed" ? Number(association.deposit) : chain.depositMicro;
  const amount = `$${formatUsdcMicrounits(BigInt(depositMicro))}`;
  const message =
    chain.status === "open"
      ? `The connected Tempo key still holds ${amount} of collateral in an open channel with ${association.endpoint}.`
      : chain.status === "closing"
        ? `The connected Tempo key has ${amount} still escrowed on its channel with ${association.endpoint}, where a close has been requested on-chain and is in its 15-minute grace period.`
        : `The connected Tempo key signed an open committing ${amount} to a channel with ${association.endpoint} that the escrow has no record of, so that collateral may or may not be locked.`;
  const caller = findSigningIdentityByPubkey(association.callerPubkey);
  if (!caller) {
    return new DvmError(
      "tempo_channels_active",
      message,
      `Only this key can close that channel, but its caller identity (${association.callerPubkey}) is no longer configured. Restore that identity first, then retry the wallet ${intent === "replace" ? "replacement" : "disconnect"}; the key and channel record were left untouched.${remainingClause(blocking)}`,
      channelData(association, chain, depositMicro, blocking)
    );
  }
  const identityName = caller.source.kind === "env" ? undefined : caller.source.name;
  const selectors = { creditId: association.creditId, identityName };
  const exit = tempoExitCommand(association.endpoint, selectors);
  const abandon = tempoExitCommand(association.endpoint, selectors, true);
  const fund = creditCommand("fund", association.endpoint, selectors);
  const remedy =
    chain.status === "open"
      ? // The endpoint can hold several credits and caller identities. Both
        // selectors keep every remedy pointed at the channel just named.
        `Empty the channel first — '${creditCommand("drain", association.endpoint, selectors)}' for the cooperative exit, or '${exit}' if the DVM is unavailable`
      : chain.status === "closing"
        ? `'${exit}' withdraws what remains once the grace period ends`
        : `'${exit}' reads the chain and says which it is, and '${fund}' resumes a funding still pending for it. Once that open is known never to have landed, '${abandon}' retires the record`;
  return new DvmError(
    "tempo_channels_active",
    message,
    `Only this key can close that channel. ${remedy} — and ${intentClause(intent)}.${remainingClause(blocking)}`,
    channelData(association, chain, depositMicro, blocking)
  );
}

interface TempoRemedySelectors {
  creditId: string;
  identityName?: string;
}

function tempoExitCommand(
  endpoint: string,
  selectors: TempoRemedySelectors,
  abandon = false
): string {
  const parts = [
    "dvm wallet tempo-exit",
    shellQuoteArg(endpoint),
    "--credit-id",
    shellQuoteArg(selectors.creditId),
  ];
  if (selectors.identityName !== undefined) {
    parts.push("--as", shellQuoteArg(selectors.identityName));
  }
  if (abandon) parts.push("--abandon");
  return parts.join(" ");
}

function creditCommand(
  verb: "drain" | "fund",
  endpoint: string,
  selectors: TempoRemedySelectors
): string {
  const parts = [
    `dvm credit ${verb}`,
    shellQuoteArg(endpoint),
    "--credit-id",
    shellQuoteArg(selectors.creditId),
  ];
  if (selectors.identityName !== undefined) {
    parts.push("--as", shellQuoteArg(selectors.identityName));
  }
  return parts.join(" ");
}

/**
 * Refuse because the chain could not be read, in the rail's own read-failure
 * dialect rather than as a channel that is holding money.
 *
 * The two are different facts an agent acts on differently — one is money to
 * empty, the other an endpoint to fix — which is why this keeps the reconcile's
 * `tempo_rpc_error` / `tempo_chain_read_failed` code and its hint naming the
 * `DVM_TEMPO_RPC_URL` knob, exactly as the x402 gate raises `x402_rpc_error`
 * rather than `x402_wallet_in_use`.
 */
function unreadableChainError(
  association: TempoChannelAssociation,
  chain: TempoChannelReconcileResult,
  intent: TempoWalletIntent,
  blocking: number
): DvmError {
  const cause = chain.error;
  return new DvmError(
    cause?.code ?? "tempo_chain_read_failed",
    `The Tempo channel with ${association.endpoint} could not be read, so there is no way to show it is empty: ${cause?.message ?? "the chain read failed"}`,
    `The Tempo key is untouched, and the local channel record was kept — it is the only route back to any collateral the escrow does hold. ${cause?.hint ? `${cause.hint} Then ${intentClause(intent)}.` : `Restore the chain read, then ${intentClause(intent)}.`}${remainingClause(blocking)}`,
    channelData(association, chain, Number(association.deposit), blocking)
  );
}

/** Refuse on a local projection whose recovery descriptor is already gone. */
function descriptorlessChannelError(
  association: TempoChannelAssociation,
  chain: TempoChannelReconcileResult,
  intent: TempoWalletIntent,
  blocking: number
): DvmError {
  const message = `The saved Tempo channel with ${association.endpoint} has no stored descriptor, so its escrow state cannot be read or closed from this machine.`;
  const data = {
    ...channelData(association, chain, Number(association.deposit), blocking),
    anchor: "tempo_channel_descriptor_missing",
  };
  const caller = findSigningIdentityByPubkey(association.callerPubkey);
  if (!caller) {
    return new DvmError(
      "tempo_channel_not_found",
      message,
      `The caller identity that owns this record (${association.callerPubkey}) is no longer configured. Restore that identity first, then retire the descriptor-less record; the Tempo key and record were left untouched.${remainingClause(blocking)}`,
      data
    );
  }
  const identityName = caller.source.kind === "env" ? undefined : caller.source.name;
  const abandon = tempoExitCommand(
    association.endpoint,
    { creditId: association.creditId, identityName },
    true
  );
  return new DvmError(
    "tempo_channel_not_found",
    message,
    `Run '${abandon}' to retire this unusable local record without broadcasting anything, then ${intentClause(intent)}.${remainingClause(blocking)}`,
    data
  );
}

/** The blocking channel, flat, as `handleError` spreads it onto the error JSON. */
function channelData(
  association: TempoChannelAssociation,
  chain: TempoChannelReconcileResult,
  depositMicro: number,
  blocking: number
): Record<string, unknown> {
  return {
    anchor: "tempo_channel_live",
    endpoint: association.endpoint,
    credit_id: association.creditId,
    channel_id: association.channelId,
    chain_id: association.chainId,
    chain_status: chain.status,
    deposit_micro: depositMicro,
    ...(chain.status === "unreadable" ? {} : { settled_micro: chain.settledMicro }),
    // How many records are still in the way, so an agent knows whether clearing
    // the one named above is the whole job.
    blocking_channels: blocking,
  };
}

function remainingClause(blocking: number): string {
  return blocking > 1
    ? ` ${blocking - 1} other recorded channel${blocking > 2 ? "s" : ""} still ${blocking > 2 ? "block" : "blocks"} this too — 'dvm wallet balance' lists them all with what the escrow says about each.`
    : "";
}

function intentClause(intent: TempoWalletIntent): string {
  return intent === "replace" ? "retry the replacement" : "retry 'dvm wallet tempo-disconnect'";
}
type TempoChannelChainStatus = TempoChannelReconcileResult["status"];
