import { TEMPO_EXIT_KEY_MISSING_HINT, tempoExitRecoveryError } from "../lib/wallet-rail-copy";
import {
  advanceTempoChannelExit,
  deriveTempoAddress,
  DvmError,
  formatUsdcMicrounits,
  isValidEvmPrivateKey,
  listPendingFundings,
  listTempoChannelAssociations,
  loadCredit,
  loadTempoChannelAssociation,
  normalizeCreditEndpoint,
  resolveTempoAsset,
  resolveTempoNetwork,
  shellQuoteArg,
  type TempoNetwork,
  type TempoChannelExitResult,
  tempoTokenReference,
} from "@dvmkit/sdk/internal";
import {
  assertTempoWalletIdle,
} from "../lib/payment-rails/tempo-lifecycle";
import {
  authorizeProtectedRemoval,
} from "../lib/config-mutation";
import {
  connectedTempoAccount,
  generateTempoKey,
  tempoBalanceCheckHint,
} from "../lib/payment-rails/tempo-wallet";
import {
  info,
  json,
} from "../lib/output";
import {
  loadConfig,
  updateConfig,
} from "../lib/identity";
import {
  resolveSigningIdentity,
} from "../lib/cli-identity-resolve";

import { resolveDvmReference } from "../lib/dvm-identifier";
import { resolveEndpoint } from "../lib/favorites";
import {
  prepareStablecoinFundingHandoff,
  printStablecoinFundingHandoff,
  type StablecoinFundingHandoff,
  stablecoinFundingHandoffJson,
} from "../lib/funding-handoff";
import {
  assertTempoChannelNetwork,
  resolveTempoNetworkSelection,
  tempoNetworkLabel,
} from "../lib/tempo-network";
import {
  hasPipedStdin,
  refusePositionalSecret,
  resolveSecretInput,
  type SecretInputConfig,
} from "../lib/secret-input";

export interface WalletMppOptions {
  human?: boolean;
  force?: boolean;
  qrImage?: string;
}

export interface WalletMppConnectOptions extends WalletMppOptions {
  /** Tempo chain to persist for this wallet. Defaults to mainnet. */
  network?: string;
  /**
   * Import a key handed over on the command line. Still supported, because
   * every shipped runbook spells it, but warned about: a flag value reaches
   * shell history, `ps` and `/proc/<pid>/cmdline` exactly as a positional does
   * Prefer {@link keyFile}, `DVM_TEMPO_KEY`, or piped stdin.
   */
  apiKey?: string;
  /**
   * Read the private key from a file — the import route that never puts the
   * secret in shell history, `ps`, or `/proc/<pid>/cmdline`. Paths under
   * shell-history or world-readable temp directories are rejected (see
   * `secret-input.ts`).
   */
  keyFile?: string;
}

/**
 * Secret-input config for the Tempo private key `dvm wallet tempo-connect`
 * accepts. Drives the `--api-key` warning, the file-not-found hint,
 * the stdin-timeout message, and the TTY prompt label.
 *
 * Unlike the x402 rail's config, `warningCommands` is live copy: `--api-key`
 * is routed through the resolver's warn-and-import arm, so this list is what a
 * caller who used it is told to switch to. Generating is in the list because
 * this verb mints a key when handed none, and a caller who has no key yet is
 * the likeliest reader of the warning.
 */
export const TEMPO_SECRET_CONFIG: SecretInputConfig = {
  kind: "private key",
  promptLabel: "Enter Tempo private key (input hidden, press enter to submit):",
  warningCommands: [
    "cat ~/key.txt | dvm wallet tempo-connect       # pipe via stdin",
    "dvm wallet tempo-connect --key-file ~/key.txt  # read from file",
    "DVM_TEMPO_KEY=0x... dvm wallet tempo-connect   # env var",
    "dvm wallet tempo-connect                       # generate a fresh wallet instead",
  ],
};

/**
 * Connect a Tempo wallet by persisting `(method, apiKey)` to the CLI config.
 * Tempo is the only per-call method dvmkit DVMs accept today — Stripe
 * is the platform-side subscription rail (builder→platform), see
 * `docs/payments.md`. When no key is supplied by any route, a fresh EVM keypair
 * is generated automatically (mirroring `dvm wallet init` on the Cashu side).
 *
 * A key can arrive by `--key-file`, the `DVM_TEMPO_KEY` env var, `--api-key`,
 * or piped stdin, in that precedence order. Only `--api-key` puts the value on
 * argv, and only it warns.
 */
export async function walletMppConnect(
  method: string,
  opts: WalletMppConnectOptions
): Promise<void> {
  if (method !== "tempo") {
    // This command's one positional slot sits exactly where two shipped hints
    // used to tell callers to put their private key. The shared
    // helper owns the no-echo contract and the rotate advice, so both
    // stablecoin connect verbs refuse in the same shape.
    throw refusePositionalSecret(method, {
      code: "invalid_method",
      keyRemedy:
        "Import it with `dvm wallet tempo-connect --key-file <path>`, `DVM_TEMPO_KEY=<key> dvm wallet tempo-connect`, or `cat key.txt | dvm wallet tempo-connect` — add `--force` to replace a wallet already configured.",
      message: "Unsupported Tempo method.",
      hint: "Supported methods: tempo. A Tempo private key goes in `--key-file <path>`, the DVM_TEMPO_KEY env var, or piped stdin — never in a positional argument. Run `dvm wallet tempo-connect` with no key at all to generate a fresh wallet instead.",
    });
  }

  const network = resolveTempoNetworkSelection(opts.network);

  let address: string;
  let handoff: StablecoinFundingHandoff;

  const imported = await readImportedTempoKey(opts);
  if (imported) {
    const config = loadConfig();
    if (!config) throw new DvmError("no_config", "No config found.", "Run: dvm init");
    // A `tempo` block whose apiKey isn't a key is not a wallet — it's the
    // broken config `dvm doctor` diagnoses, and importing over it is the
    // repair that check's hint names. Gating on the method alone treated it as
    // configured, then derived an address from the empty string and died
    // inside viem before it could say so. This is the same test
    // `generateTempoKey` applies, so both branches now agree on what
    // "already configured" means.
    const storedKey = config.tempo?.method === "tempo" ? (config.tempo.apiKey ?? "") : "";
    const configured = isValidEvmPrivateKey(storedKey);
    if (configured && !opts.force) {
      const existingAddress = await deriveTempoAddress(storedKey);
      throw new DvmError(
        "tempo_wallet_exists",
        `Tempo wallet already configured (address ${existingAddress}).`,
        "Pass `--force` to replace, or run `dvm wallet tempo-disconnect` to clear it first."
      );
    }
    if (configured && opts.force) await assertTempoWalletIdle("replace");
    address = await deriveTempoAddress(imported);
    handoff = await prepareTempoHandoff(address, opts);
    const apiKey = imported;
    await updateConfig({
      reason: "tempo_wallet_connect",
      patch: () => ({ set: { tempo: { method, apiKey, network } } }),
    });
  } else {
    let prepared: StablecoinFundingHandoff | undefined;
    const account = await generateTempoKey({
      force: opts.force,
      network,
      beforePersist: async (generated) => {
        prepared = await prepareTempoHandoff(generated.address, opts);
      },
    });
    address = account.address;
    if (!prepared) {
      throw new DvmError(
        "qr_render_failed",
        "The Tempo funding handoff was not prepared before the wallet was saved.",
        "Retry the command; no wallet change was made."
      );
    }
    handoff = prepared;
  }

  emitTempoOutput(address, network, opts, handoff);
}

/**
 * Resolve and validate an imported Tempo key, or return `undefined` for the
 * generate branch.
 *
 * `--key-file`, `DVM_TEMPO_KEY` and `--api-key` are unambiguous claims to be
 * importing: a key that then fails to resolve is an error, never a silent
 * fresh wallet. Piped stdin is not — an `fstat` can't tell a pipe carrying a
 * key from one an agent harness opened and never wrote to (both are FIFOs), so
 * when stdin is the only claim and it yields nothing, that is the no-key case
 * and the command generates rather than failing on `no_input`.
 *
 * No positional is forwarded: `walletMppConnect` refuses one outright, so a key
 * typed as an argument can never reach the resolver's import arm.
 * `--api-key` takes the resolver's positional slot instead, which is what makes
 * it warn — the value is on argv either way.
 *
 * `--api-key` beside an off-argv source is refused rather than quietly losing
 * the ladder's precedence contest. Two harms compound there and only an error
 * surfaces both: the `--api-key` value leaked the moment it was typed, *and* a
 * different key would be imported than the caller named, leaving them to
 * believe the wallet is the one they specified. The realistic path is a
 * migration — `--key-file` added to a CI config with `--api-key` left
 * in place, leaking a live key on every run — where a warning scrolls past
 * forever and a failure gets fixed once.
 */
async function readImportedTempoKey(
  opts: WalletMppConnectOptions
): Promise<`0x${string}` | undefined> {
  const envKey = process.env.DVM_TEMPO_KEY;
  if (opts.apiKey) assertSoleKeySource(opts.keyFile, envKey);
  const declared = Boolean(opts.keyFile) || Boolean(envKey) || Boolean(opts.apiKey);
  if (!declared && !hasPipedStdin()) return undefined;

  let resolved;
  try {
    resolved = await resolveSecretInput({
      positional: opts.apiKey,
      file: opts.keyFile,
      envValue: envKey,
      config: TEMPO_SECRET_CONFIG,
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
      "No Tempo private key provided.",
      "Use --key-file <path>, set the DVM_TEMPO_KEY env var, or pipe the key via stdin. To have dvm create a wallet for you instead, run `dvm wallet tempo-connect` with no key at all."
    );
  }
  // The same test `--api-key` always applied, now reached from every source.
  // The message names no flag: by here the key could have come from any of the
  // four, and a hint that blames the wrong one sends the caller to the wrong
  // file.
  if (!isValidEvmPrivateKey(privateKey)) {
    throw new DvmError(
      "invalid_api_key",
      "A Tempo private key must be a valid 0x-prefixed 32-byte hex secp256k1 private key.",
      "Generate one with `cast wallet new` or `openssl rand -hex 32` (and prepend 0x)."
    );
  }
  return privateKey;
}

/**
 * Refuse `--api-key` beside a source that keeps the key off argv.
 *
 * Names the conflicting source, never either value: `handleError` spreads
 * `message`, `display`, `hint` and every key of `data` onto stdout, which is
 * the channel an agent parses and may relay onward.
 */
function assertSoleKeySource(keyFile: string | undefined, envKey: string | undefined): void {
  const other = keyFile ? "--key-file" : envKey ? "DVM_TEMPO_KEY" : undefined;
  if (!other) return;
  throw new DvmError(
    "conflicting_key_sources",
    `Two Tempo key sources were supplied: --api-key and ${other}.`,
    `Nothing was imported and no wallet was changed. ${other} would have won, so the key you passed to --api-key is not the one that would have been connected. Drop --api-key and re-run with ${other} alone — and rotate the value you gave --api-key if it holds funds, because it has already reached your shell history, process listings (ps), and /proc/<pid>/cmdline on Linux.`,
    { sources: ["--api-key", other] }
  );
}

function emitTempoOutput(
  address: string,
  network: TempoNetwork,
  opts: WalletMppOptions,
  handoff: StablecoinFundingHandoff
): void {
  // resolve the settlement asset rather than hardcoding it, so a
  // caller running with DVM_TEMPO_CURRENCY set isn't told to fund a contract
  // the DVMs they call don't charge in.
  const chain = resolveTempoNetwork(network);
  const chainLabel = tempoNetworkLabel(network);
  const asset = resolveTempoAsset(process.env, network);
  const transferCmd = `tempo wallet transfer <amount> ${asset.address} ${address}`;
  const wrongAsset = `Send only ${asset.label} — another Tempo dollar such as USDT0 is a different token and will not be spendable here.`;
  if (opts.human) {
    info(`Tempo funding · ${chainLabel} (chain ${chain.chainId}) · ${asset.label} · contract ${asset.address}`);
    printStablecoinFundingHandoff(handoff);
    if (network === "moderato") {
      info("");
      info("Fund this disposable test wallet from Tempo's Moderato faucet:");
      info("  dvm wallet fund '$1' --rail tempo");
      info("The faucet grants test assets in its own fixed amounts; no real funds are needed.");
    } else {
      info("");
      info("To fund from the Tempo CLI:");
      info(`  ${transferCmd}`);
      info("");
      info(`Or send ${asset.label} to the address above on Tempo (chain ${chain.chainId}).`);
      info(wrongAsset);
      info(
        "Buy it in one hop on Kraken (withdraw choosing the Tempo network), or bridge from Base via https://stargate.finance if your dollars live there."
      );
    }
  } else {
    json({
      status: "connected",
      method: "tempo",
      network,
      chain_id: chain.chainId,
      network_label: chainLabel,
      asset: asset.symbol,
      token: asset.address,
      ...stablecoinFundingHandoffJson(handoff),
      funding: {
        address,
        network,
        chain_id: chain.chainId,
        token: { name: asset.symbol, address: asset.address },
        instructions:
          network === "moderato"
            ? [
                {
                  context: "Tempo Moderato faucet",
                  command: "dvm wallet fund '$1' --rail tempo",
                  description:
                    "Requests the public testnet faucet. It grants fixed test-token amounts rather than the requested dollar amount.",
                },
              ]
            : [
                {
                  context: "tempo CLI (https://docs.tempo.xyz)",
                  command: transferCmd,
                },
                {
                  context: "generic",
                  description: `Send ${asset.label} to the standalone funding address on Tempo (chain ${chain.chainId}). ${wrongAsset} Buy it in one hop on Kraken (withdraw choosing the Tempo network), or bridge from Base via https://stargate.finance if your dollars live there.`,
                },
              ],
      },
      display:
        network === "moderato"
          ? `Tempo wallet connected on ${chainLabel} (chain ${chain.chainId}). Fund it with the public testnet faucet; relay the address standalone and attach the QR separately.`
          : `Tempo wallet connected. Fund the standalone address with ${asset.label} on ${chainLabel} (chain ${chain.chainId}) and attach the QR separately.`,
      hint:
        network === "moderato"
          ? "Run `dvm wallet fund '$1' --rail tempo`; the faucet reports the test amount actually observed, then `dvm wallet balance` confirms it."
          : `${wrongAsset} Once the transfer confirms, 'dvm wallet balance' reads this contract's balance.`,
    });
  }
}

/** Prepare the fallible QR handoff before a Tempo key is persisted. */
function prepareTempoHandoff(
  address: string,
  opts: WalletMppOptions
): Promise<StablecoinFundingHandoff> {
  return prepareStablecoinFundingHandoff({
    address,
    rail: "tempo",
    human: opts.human ?? false,
    qrImagePath: opts.qrImage,
  });
}

/**
 * Disconnect the Tempo wallet by clearing the persisted config entry.
 *
 * Refuses while the escrow confirms a recorded channel still holds collateral
 * only this key can close. The gate is skipped when nothing is configured: a
 * no-op disconnect has no key to protect, and reading the chain in order to
 * refuse one would leave a stale record standing in the way of nothing.
 */
export async function walletMppDisconnect(opts: WalletMppOptions): Promise<void> {
  const config = loadConfig();
  if (!config) throw new DvmError("no_config", "No config found.", "Run: dvm init");
  const hadWallet = Boolean(config.tempo);
  if (hadWallet) await assertTempoWalletIdle("disconnect");
  await updateConfig({
    reason: "tempo_wallet_disconnect",
    authorize: authorizeProtectedRemoval("tempo"),
    patch: () => ({ unset: ["tempo"] }),
  });
  const display = hadWallet
    ? "Tempo wallet disconnected. Its private key is gone from this machine."
    : "No Tempo wallet was connected.";
  const hint = hadWallet
    ? "Run 'dvm wallet tempo-connect' before opening another Tempo-backed credit."
    : undefined;
  if (opts.human) {
    info(display);
    if (hint) info(hint);
  } else {
    json({ status: "disconnected", display, ...(hint ? { hint } : {}) });
  }
}

export interface WalletMppExitOptions {
  human?: boolean;
  as?: string;
  /** Select the channel attached to exactly this prepaid credit. */
  creditId?: string;
  /** Retire a descriptor-less record, or one the escrow has no record of. */
  abandon?: boolean;
}

/**
 * Request unilateral close now, or withdraw after Tempo's 900-second grace.
 *
 * `--abandon` is the counterpart for a channel this key cannot close: it
 * retires the local record so the Tempo key can be disconnected or replaced.
 * The channel-store entry is the only copy of the descriptor an exit needs, so
 * abandoning is refused for a descriptor-backed channel the escrow knows about
 * *and this key could still close*. Two records fall outside that:
 * one whose descriptor is already gone, which can only be retired locally
 * because there is no chain address left to inspect, and one whose
 * descriptor names a different wallet, which this key could never close and
 * whose refund would go to that wallet either way. Both retire
 * without reading the chain. With no key connected nothing is a stranger's, so
 * that second route closes and the on-chain refusal applies as usual.
 */
export async function walletMppExit(dvm: string, opts: WalletMppExitOptions): Promise<void> {
  const endpoint = resolveMppEndpoint(dvm);
  const config = loadConfig();
  const signer = resolveSigningIdentity({ as: opts.as, config });
  const credit = opts.creditId === undefined ? loadCredit(endpoint, signer.pubkey) : undefined;
  const association =
    opts.creditId !== undefined
      ? loadTempoChannelAssociation(endpoint, signer.pubkey, opts.creditId)
      : ((credit
          ? loadTempoChannelAssociation(endpoint, signer.pubkey, credit.creditId)
          : undefined) ??
        listTempoChannelAssociations().find(
          (candidate) => candidate.endpoint === endpoint && candidate.callerPubkey === signer.pubkey
        ));
  if (!association) {
    const exact = opts.creditId !== undefined;
    throw new DvmError(
      "tempo_channel_not_found",
      exact
        ? `No Tempo channel is recorded at ${endpoint} for credit ${opts.creditId} under this caller identity.`
        : `No Tempo channel is recorded at ${endpoint} for this caller identity.`,
      exact
        ? "No fallback was attempted because --credit-id selects one exact credit. 'dvm wallet balance' lists the channels this wallet still holds, and '--as <identity>' looks under a different caller identity."
        : "A record is retired once the escrow confirms its close, so this is the ordinary answer after a cooperative drain: the collateral is already back and there is nothing left to exit. 'dvm wallet balance' lists the channels this wallet still holds, and '--as <identity>' looks under a different caller identity."
    );
  }
  const account = await connectedTempoAccount();
  // `--abandon` is allowed to run without one: retiring a record is local, and
  // a caller who has already disconnected still needs a way to clear the
  // records that disconnect left behind. The escrow read is a `view`
  // call, so it runs keyless and still refuses to retire a record the chain
  // holds collateral for; only the signing legs demand a key, from inside the
  // exit itself.
  if (!account && !opts.abandon) {
    throw new DvmError(
      "tempo_wallet_missing",
      "The Tempo key that controls this channel is not connected.",
      TEMPO_EXIT_KEY_MISSING_HINT
    );
  }
  if (account) assertTempoChannelNetwork(association, account);
  let result: TempoChannelExitResult;
  try {
    result = await advanceTempoChannelExit({
      ...(account ? { account } : {}),
      association,
      ...(opts.abandon ? { abandon: true } : {}),
    });
  } catch (err) {
    if (
      err instanceof DvmError &&
      err.code === "tempo_channel_not_found" &&
      err.message.includes("has no stored descriptor")
    ) {
      throw new DvmError(
        err.code,
        err.message,
        `Run '${tempoExitCommand(dvm, opts, true)}' to retire this unusable local record. Nothing will be broadcast, because there is no descriptor from which to address the escrow.`,
        err.data,
        err.display
      );
    }
    throw err instanceof DvmError ? tempoExitRecoveryError(err, account !== null) : err;
  }
  // A pending funding journals the open credential and a resume re-persists the
  // provisional entry from it (`persistTempoOpenCredential({ opened: false })`),
  // so retiring the record is only final once no such funding survives — which
  // is the usual case, since a DVM's outright refusal clears the funding too.
  const replayableFunding =
    result.status === "abandoned" &&
    listPendingFundings({
      endpoint: association.endpoint,
      callerPubkey: association.callerPubkey,
      creditId: association.creditId,
    }).some((funding) => funding.rail === "tempo" && funding.mppCredential !== undefined);
  const retryExit = tempoExitCommand(dvm, opts);
  const abandonExit = tempoExitCommand(dvm, opts, true);
  const resumeFunding = creditFundCommand(dvm, opts);
  if (result.foreignPayer !== undefined) {
    // Only ever reached with a key connected — a record can be judged another
    // wallet's only against one — so the copy can name both sides.
    const display = `Retired the local Tempo channel record for ${endpoint}. It was opened by Tempo wallet ${result.foreignPayer}, not the connected ${account?.address ?? "one"}, so no chain state was read and nothing was broadcast.`;
    const hint = `Any collateral that channel holds is still ${result.foreignPayer}'s and the connected key could never have moved it — but this machine's only descriptor for it is now gone, so reconnecting ${result.foreignPayer} would no longer recover it either. The record blocked neither 'dvm wallet tempo-disconnect' nor a replacement while it stood.`;
    if (opts.human) {
      info(display);
      info(hint);
      return;
    }
    json({
      op: "tempo_exit",
      endpoint,
      credit_id: association.creditId,
      channel_id: result.channelId,
      status: result.status,
      foreign_payer: result.foreignPayer,
      display,
      hint,
    });
    return;
  }
  if (result.descriptorMissing) {
    const display = `Retired the unusable local Tempo channel record for ${endpoint}. Its recovery descriptor was already missing, so no chain state was read and nothing was broadcast. This record no longer blocks disconnecting or replacing the Tempo key.`;
    const hint = replayableFunding
      ? `A funding for this DVM is still pending and journals the original open credential. '${resumeFunding}' would replay it and restore the descriptor and record; resume it only if that open may still land. Otherwise retry 'dvm wallet tempo-disconnect' or the replacement.`
      : `The missing descriptor had already removed this machine's path to any collateral the channel may hold; retiring the orphan did not discard an additional recovery path. Retry 'dvm wallet tempo-disconnect' or the replacement.`;
    if (opts.human) {
      info(display);
      info(hint);
      return;
    }
    json({
      op: "tempo_exit",
      endpoint,
      credit_id: association.creditId,
      channel_id: result.channelId,
      status: result.status,
      descriptor_missing: true,
      display,
      hint,
    });
    return;
  }
  // Exact rather than two-decimal: the two figures below can differ by less
  // than a cent, and rounding a floor upward would overstate a guarantee.
  const usd = (micro: number) => `$${formatUsdcMicrounits(BigInt(micro))}`;
  // Two figures rather than one: the grace period is when the DVM settles what
  // it consumed, so a single "remains refundable" number states the ceiling as
  // if it were the outcome. The pair is the x402 timed exit's shape.
  const figures = `Guaranteed floor: ${usd(result.guaranteedMicro)}. Likely recovery if no further claims land: ${usd(result.likelyMicro)}.`;
  const waitUntil = result.withdrawAvailableAt
    ? new Date(result.withdrawAvailableAt).toISOString()
    : undefined;
  const graceEnds = waitUntil ? `, ending ${waitUntil}` : "";
  const display =
    result.status === "close_requested"
      ? `Requested unilateral close of the Tempo channel for ${endpoint}. ${figures} It is in its 15-minute grace period${graceEnds}.`
      : result.status === "waiting"
        ? `The Tempo channel close for ${endpoint} is in its 15-minute grace period${graceEnds}. ${figures}`
        : result.status === "withdrawn"
          ? `Withdrew ${usd(result.likelyMicro)} from the Tempo channel back to the connected wallet.`
          : result.status === "unconfirmed"
            ? `The escrow holds no record of the Tempo channel for ${endpoint}, so its open either never reached the chain or is still confirming. Nothing was closed, and the local channel record was kept — it is what closes the deposit if that open does land.`
            : result.status === "abandoned"
              ? `Retired the local record of the Tempo channel for ${endpoint}, which the escrow has no record of. No collateral was ever locked, and this wallet's Tempo key can now be disconnected or replaced.`
              : "The Tempo channel was already closed on-chain and has been retired locally.";
  const hint =
    result.status === "close_requested" || result.status === "waiting"
      ? `The DVM may still settle vouchers this wallet already authorized during the grace period, reducing the payout; whatever remains returns to this wallet. Re-run '${retryExit}'${waitUntil ? ` after ${waitUntil}` : " after 15 minutes"}; it will inspect the chain and withdraw when allowed. ${exitFeeGuidance(result.channelToken)}`
      : result.status === "unconfirmed"
        ? `Re-run '${retryExit}' later: if the open landed it closes the channel, and if it never landed no collateral was ever locked. While a funding for this DVM is still pending, '${resumeFunding}' resumes it by replaying the credential this wallet already signed rather than authorizing a second one. This record keeps 'dvm wallet tempo-disconnect' and 'dvm wallet tempo-connect --force' refusing; once the open is known never to have landed, '${abandonExit}' retires it and releases them.`
        : result.status === "abandoned"
          ? replayableFunding
            ? `Nothing on-chain was touched, and a funding for this DVM is still pending: it journals this channel's open credential, so '${resumeFunding}' would replay it and restore this record rather than open a fresh channel. Resume it only if that open may still land.`
            : `Nothing on-chain was touched, and no pending funding still holds this channel's open credential: were that open to land after all, its deposit could no longer be closed from here. Funding this DVM again opens a fresh channel.`
          : `The wallet's on-chain balance and the DVM's ledger credit are separate. ${tempoBalanceCheckHint(result.channelToken)} 'dvm credit balance ${dvm}' reports the ledger side.`;
  if (opts.human) {
    info(display);
    info(hint);
    return;
  }
  json({
    op: "tempo_exit",
    endpoint,
    credit_id: association.creditId,
    channel_id: result.channelId,
    // The token the exit's own fees are charged in, in full: the hint names it
    // too, but an agent funding the wallet needs a contract it can paste rather
    // than prose to parse.
    channel_token: result.channelToken,
    status: result.status,
    deposit_micro: result.depositMicro,
    settled_micro: result.settledMicro,
    guaranteed_micro: result.guaranteedMicro,
    likely_micro: result.likelyMicro,
    ...(result.transactionHash ? { transaction_hash: result.transactionHash } : {}),
    ...(waitUntil ? { withdraw_available_at: waitUntil } : {}),
    display,
    hint,
  });
}

/** Rebuild an exit command without dropping the selectors that made it exact. */
function tempoExitCommand(
  dvm: string,
  opts: Pick<WalletMppExitOptions, "as" | "creditId">,
  abandon = false
): string {
  const parts = ["dvm wallet tempo-exit", shellQuoteArg(dvm)];
  if (opts.creditId !== undefined) parts.push("--credit-id", shellQuoteArg(opts.creditId));
  if (opts.as !== undefined) parts.push("--as", shellQuoteArg(opts.as));
  if (abandon) parts.push("--abandon");
  return parts.join(" ");
}

/** Rebuild the pending-funding remedy against the same credit and identity. */
function creditFundCommand(
  dvm: string,
  opts: Pick<WalletMppExitOptions, "as" | "creditId">
): string {
  const parts = ["dvm credit fund", shellQuoteArg(dvm)];
  if (opts.creditId !== undefined) parts.push("--credit-id", shellQuoteArg(opts.creditId));
  if (opts.as !== undefined) parts.push("--as", shellQuoteArg(opts.as));
  return parts.join(" ");
}

/**
 * What the caller has to hold to finish an exit they have started.
 *
 * Both legs — request-close and withdraw — are transactions this wallet
 * broadcasts and pays for, and Tempo charges its fees in a TIP-20 stablecoin
 * rather than a separate gas token. Money inside the channel is escrowed and
 * cannot pay for the transaction that releases it, so a wallet that put every
 * dollar into the channel has nothing to exit with.
 */
function exitFeeGuidance(token: string): string {
  return `Withdrawing is an on-chain transaction this wallet pays for: Tempo charges network fees in a stablecoin rather than a separate gas token, so keep a spendable balance of ${tempoTokenReference(token)} in the connected wallet — outside the channel, whose collateral is escrowed until the withdrawal lands. The fees are sub-cent. ${tempoBalanceCheckHint(token)}`;
}

function resolveMppEndpoint(identifier: string): string {
  if (identifier.startsWith("http://") || identifier.startsWith("https://")) {
    return normalizeCreditEndpoint(identifier);
  }
  if (identifier.startsWith("@")) return normalizeCreditEndpoint(resolveEndpoint(identifier));
  return normalizeCreditEndpoint(resolveDvmReference(identifier).endpoint);
}
