import {
  rpcEndpointLine,
  tempoKeyImportRoutes,
  unreachableRailDisplay,
  unreachableRailHint,
} from "../lib/wallet-rail-copy";
import { probeRailLabel } from "../lib/rail-labels";
import { getFundingGuidance, printFundingGuidance } from "../lib/funding";
import { assertValidBudget, formatAmount, monetaryJson } from "../lib/currency";
import {
  DvmError,
  ensureAddress,
  listCredits,
  listTempoChannelAssociations,
  listX402Channels,
  loadAgentWallet,
  loadTempoChannelController,
  type NwcConnection,
  parseNwcUri,
  readX402ChannelOnChain,
  reconcileTempoChannelOnChain,
  resolveTempoAsset,
  resolveTempoNetwork,
  resolveX402Asset,
  shellQuoteArg,
  TEMPO_CHANNELS_FILE,
  tempoChannelControlledBy,
  type TempoChannelReconcileResult,
  withX402ChannelLock,
  X402_CHANNELS_FILE,
  X402_DEFAULT_NETWORK,
  type X402ChannelChainReport,
  type X402ChannelClient,
  x402ChannelControlledBy,
} from "@dvmkit/sdk/internal";
import {
  authorizeProtectedRemoval,
} from "../lib/config-mutation";
import {
  type Config,
  loadConfig,
  updateConfig,
} from "../lib/identity";
import {
  connectedTempoAccount,
  tempoWrongAssetHint,
} from "../lib/payment-rails/tempo-wallet";
import {
  connectedX402Payer,
  loadX402Wallet,
} from "../lib/x402/wallet";
import {
  info,
  json,
} from "../lib/output";
import {
  probeWallets,
  type RailProbe,
} from "../lib/wallet-probe";
import {
  x402NetworkLabel,
} from "../lib/x402/networks";
import {
  x402WrongAssetHint,
} from "../lib/x402/asset";
import {
  type Float,
  floatBudgetJson,
  type FloatProbe,
  NWC_FUNDING_FLOAT_ROLE,
  parseStatedBudget,
  probeFloat,
  toFloatError,
} from "../lib/float";
import {
  type ResolvedBtcRate,
  staleRateNotice,
  type StaleRateNotice,
  tryResolveBtcUsdRate,
} from "../lib/btc-rate";

import type { OnrampRail, RailOnramp } from "../lib/onramps";
import { FUNDING_DOCS_URL, getRailOnramp, RAIL_ONRAMPS } from "../lib/onramps";
import { progressNotice } from "../lib/progress-notice";
import { hasPipedStdin, resolveSecretInput, type SecretInputConfig } from "../lib/secret-input";
import { tempoAccountNetwork, tempoNetworkLabel } from "../lib/tempo-network";
import { assertTempoBalanceRpcNetwork } from "../lib/tempo-rpc";
import { FLOAT_WALLETS, NWC_WALLETS, unsuitableFloatWallet } from "../lib/wallets";
import { ADD_CASHU_MINT_HINT } from "./wallet-cashu";

export interface WalletConnectOptions {
  human?: boolean;
  /**
   * The spending cap the user set on the wallet side, e.g. '$20/month'.
   * Recorded verbatim as display metadata — NIP-47 has no way to read a
   * connection's real budget back, so this is never enforced against.
   */
  budget?: string;
  /**
   * Read the NWC connection string from a file instead of the positional arg —
   * avoids leaking a spending credential via shell history, `ps`, and
   * `/proc/<pid>/cmdline`. Paths under shell-history or world-readable temp
   * directories are rejected (see `secret-input.ts`).
   */
  file?: string;
}

/**
 * Secret-input config for the NWC connection string `dvm wallet connect`
 * accepts. Drives the positional warning, file-not-found hint,
 * stdin-timeout message, and TTY prompt label.
 */
export const NWC_CONNECT_SECRET_CONFIG: SecretInputConfig = nwcSecretConfig("dvm wallet connect", {
  prompts: true,
});

/**
 * The same ladder for `dvm wallet setup --type nwc`, whose `--nwc-uri` is the
 * other argv-leaking door into the same wallet write.
 *
 * It needs its own config because the safe forms name the verb the caller
 * actually ran: sending a `wallet setup` caller to `wallet connect` would drop
 * `--budget` and `--default-budget`, which only this command carries. Running
 * it bare prints the guided walkthrough rather than prompting, so the prompt
 * form is left out here.
 */
export const NWC_SETUP_SECRET_CONFIG: SecretInputConfig = nwcSecretConfig(
  "dvm wallet setup --type nwc",
  { prompts: false }
);

export interface WalletBalanceOptions {
  human?: boolean;
  /** Make every rail probe non-mutating and report unreachable rails instead of throwing. */
  observeOnly?: boolean;
}

export interface WalletSetupOptions {
  human?: boolean;
  rail?: string;
  type?: string;
  nwcUri?: string;
  /**
   * Read the NWC connection string from a file rather than `--nwc-uri`. Same
   * contract as {@link WalletConnectOptions.file}.
   */
  file?: string;
  /** Default max budget per request (e.g. '$1.00' or 'skip') */
  defaultBudget?: string;
  /** The spending cap set on the wallet side, recorded as display metadata. */
  budget?: string;
}

/** Safe warning produced while probing a candidate Lightning float. */
export interface FloatWarning {
  code: string;
  display: string;
}

/** Successfully parsed and probed NWC candidate, held in memory until commit. */
export interface ProbedWalletConnection {
  nwcUri: string;
  conn: NwcConnection;
  connectedAt: string;
  statedBudget?: string;
  probe: FloatProbe;
  balance: number | undefined;
  rate: ResolvedBtcRate | null;
  warnings: FloatWarning[];
}

const SETUP_ADVISORY =
  "Start small: fund a few days' worth of spend and top up as confidence grows. dvmkit is alpha software — run with small balances and review spend regularly.";

// NWC is deliberately separate from `RAIL_ONRAMPS`: it funds the agent's
// Cashu wallet and eligible prepaid credits, but is never a per-call rail.
// It sits in the same menu, so it takes the same rail-choice register — the
// protocol name, then what the money is — rather than `probeRailLabel`'s
// "Lightning float" (the rule is in `lib/rail-labels.ts`).
const NWC_FLOAT_CHOICE = {
  kind: "float",
  type: "nwc",
  title: "NWC — Lightning funding float",
  summary:
    "An always-on Lightning wallet lets your agent fund itself; its wallet-side cap is the belt an agent cannot raise.",
  bestFor:
    "Best when you already operate an always-on Lightning wallet and want capped automatic replenishment.",
  warning:
    "The wallet must stay online, support invoice payment, and enforce a wallet-side spending cap. Its NWC connection string is a secret and must never be pasted into chat.",
  recommended: false,
  command: "dvm wallet setup --type nwc",
  setupCommand: "dvm wallet setup --type nwc",
  verifyCommand: "dvm wallet balance",
  docsUrl: FUNDING_DOCS_URL,
} as const;

export async function walletSetup(opts: WalletSetupOptions): Promise<void> {
  // Funding-path walkthrough takes precedence over wallet-type setup.
  if (opts.rail) {
    if (opts.rail === "nwc") {
      await setupNwc(opts);
      return;
    }

    const onramp = getRailOnramp(opts.rail);
    if (!onramp) {
      throw new DvmError(
        "invalid_rail",
        `Unknown rail: ${opts.rail}`,
        "Use 'nwc', 'cashu', 'tempo', or 'x402'."
      );
    }
    emitRailOnramp(onramp, await railSetupFacts(onramp.rail), opts.human);
    return;
  }

  // Infer type from provided options for backward compat
  const walletType = opts.type ?? (opts.nwcUri || opts.file ? "nwc" : undefined);


  if (!walletType) {
    const railRows = await Promise.all(
      RAIL_ONRAMPS.map(async (onramp) => railSetupChoice(onramp, await railSetupFacts(onramp.rail)))
    );
    const floatRow = {
      ...NWC_FLOAT_CHOICE,
      wallet: { configured: Boolean(loadConfig()?.nwcUri) },
    };
    if (opts.human) {
      info("Wallet Setup — fund a wallet to pay for DVM jobs.\n");
      info(
        "Start from where your money already lives. Use Tempo when you can withdraw its configured dollar directly (of the two dollar routes, its fees and exits stay in that same dollar), x402 when you can withdraw native USDC directly to the configured network, NWC when you already operate an always-on Lightning wallet, or Cashu when privacy is worth accepting mint custody and availability risk. No route is the default.\n"
      );
      for (const row of [railRows[0], railRows[1], floatRow, railRows[2]])
        printSetupChoiceHuman(row);
      info("Start small — fund a few days' worth of spend and top up as confidence grows.");
      info("dvmkit is alpha software — run with small balances and review spend regularly.");
    } else {
      json({
        step: "choose_rail",
        float: floatRow,
        rails: railRows,
        advisory: SETUP_ADVISORY,
        hint: `Match the bestFor condition to the caller's starting point, then run that row's setupCommand. Provider and regional availability belong in ${FUNDING_DOCS_URL}; the network, token, address and commands above are the facts for this machine.`,
      });
    }
    return;
  }

  if (walletType === "nwc") {
    await setupNwc(opts);
  } else {
    throw new DvmError("invalid_type", `Unknown wallet type: ${walletType}`, "Use 'nwc'.");
  }
}

/**
 * What connecting a float actually buys, and the two caps that bound it. Shown
 * at the top of the walkthrough because the budget is the whole point: it's the
 * one boundary where a human appears in an otherwise autonomous loop.
 */
const FLOAT_ADVISORY =
  "This wallet becomes your agent's Lightning funding float: it pays ecash wallet top-ups and eligible prepaid credits on its own, never a direct dvm request. Set a spending cap once in your wallet app (that's the one the agent can't change), and set 'dvm budget set' caps here too. Fund lightly either way.";

async function setupNwc(opts: WalletSetupOptions): Promise<void> {
  const nwcUri = await readSetupNwcUri(opts);
  if (!nwcUri) {
    if (opts.human) {
      info("Lightning float setup — connect a wallet via NWC (Nostr Wallet Connect).\n");
      info(`${FLOAT_ADVISORY}\n`);
      info(`Local connection: ${loadConfig()?.nwcUri ? "configured" : "not configured"}`);
      info(`Warning: ${NWC_FLOAT_CHOICE.warning}`);
      info(`Setup: ${NWC_FLOAT_CHOICE.setupCommand}`);
      info(`Verify: ${NWC_FLOAT_CHOICE.verifyCommand}`);
      info(`Funding guide: ${NWC_FLOAT_CHOICE.docsUrl}\n`);
      info("The wallet has to be always on — a wallet that lives on your phone can't answer");
      info("while the phone is asleep, so it can't fund an agent.\n");
      info("Recommended for a float:\n");
      for (const w of FLOAT_WALLETS) {
        info(`  ${w.name} — ${w.description}`);
        info(`    ${w.url}${w.custodial ? " (custodial)" : ""}`);
        if (w.warning) info(`    Note: ${w.warning}`);
      }
      const others = NWC_WALLETS.filter((w) => w.role !== "recommended");
      if (others.length > 0) {
        info("\nAlso connectable, but not recommended for a float:\n");
        for (const w of others) {
          info(`  ${w.name} — ${w.warning ?? w.description}`);
        }
      }
      info("\nOnce your wallet is ready, create a connection with a spending budget and run:");
      info("  dvm wallet pair    # recommended for remote agents and chat");
      info("\nIf this CLI and the wallet are on the same trusted machine, pipe the connection");
      info("string in instead — it never reaches your shell history or 'ps' that way:");
      info(
        "  printf 'nostr+walletconnect://...' | dvm wallet setup --type nwc --budget '$20/month'"
      );
      info("  dvm wallet setup --type nwc --file ~/nwc.txt --budget '$20/month'");
    } else {
      json({
        step: "choose_wallet",
        wallets: NWC_WALLETS,
        recommended: FLOAT_WALLETS.map((w) => w.name),
        wallet: { configured: Boolean(loadConfig()?.nwcUri) },
        warning: NWC_FLOAT_CHOICE.warning,
        setupCommand: NWC_FLOAT_CHOICE.setupCommand,
        verifyCommand: NWC_FLOAT_CHOICE.verifyCommand,
        docsUrl: NWC_FLOAT_CHOICE.docsUrl,
        advisory: FLOAT_ADVISORY,
        requirement:
          "The wallet must be always on and must let you cap spending on the connection itself.",
        hint: "For a remote or chat-driven agent, run 'dvm wallet pair' and relay its private link. On one trusted machine, pipe the connection string into this command instead (or pass --file <path>); --nwc-uri works too but puts a spending credential in shell history and 'ps'.",
      });
    }
    return;
  }

  const { probe, balance, rate, warnings } = await verifyAndSaveWallet(
    nwcUri,
    opts.budget,
    opts.human
  );
  const funding = getFundingGuidance({ walletType: "nwc", balanceMsats: balance });

  if (!opts.defaultBudget || opts.defaultBudget === "skip") {
    const isSkip = opts.defaultBudget === "skip";
    if (opts.human) {
      printFloatHuman(probe, balance, rate, opts.budget, warnings);
      if (!isSkip) {
        info("\nOptionally set a per-request budget so paid jobs run without confirmation:");
        info(
          "  printf '...' | dvm wallet setup --type nwc --default-budget '$1.00'   # re-pipe the string"
        );
        info(
          "  printf '...' | dvm wallet setup --type nwc --default-budget skip      # or skip the budget"
        );
      }
      printFundingGuidance(funding);
    } else {
      json({
        step: isSkip ? "complete" : "configure_budget",
        walletType: "nwc",
        ...floatJson(probe, balance, rate, opts.budget, warnings),
        ...rateStaleFields(rate),
        ...(isSkip
          ? {}
          : {
              hint: "Re-run with --default-budget to set a per-request limit, or --default-budget skip. Either re-run needs the connection string again: pipe it in or pass --file <path>.",
            }),
        ...funding,
      });
    }
    return;
  }

  // Both nwc-uri and default-budget provided. The budget string is persisted
  // verbatim and converted at spend time, so validating it needs no BTC/USD rate.
  assertValidBudget(opts.defaultBudget);
  const defaultBudget = opts.defaultBudget;
  await updateConfig({
    reason: "wallet_setup_default_budget",
    patch: (current) => {
      if (!current) throw new DvmError("no_config", "No config found.", "Run: dvm init");
      return { set: { defaultBudget } };
    },
  });

  if (opts.human) {
    info("Setup complete!");
    printFloatHuman(probe, balance, rate, opts.budget, warnings);
    info(`  Per-request budget: ${opts.defaultBudget}`);
    printFundingGuidance(funding);
  } else {
    json({
      step: "complete",
      walletType: "nwc",
      ...floatJson(probe, balance, rate, opts.budget, warnings),
      defaultBudget: opts.defaultBudget,
      ...rateStaleFields(rate),
      ...funding,
    });
  }
}

/**
 * Connect the caller's Lightning float from an NWC connection string.
 *
 * The string arrives through the shared secret ladder: `--file`,
 * a positional (warned about), piped stdin, or a hidden prompt. It is resolved
 * before anything else runs, because `probeWalletConnection` writes to stderr
 * and a prompt underneath that reads as a hung command.
 */
export async function walletConnect(
  nwcUri: string | undefined,
  opts: WalletConnectOptions
): Promise<void> {
  const resolved = await resolveSecretInput({
    positional: nwcUri,
    file: opts.file,
    config: NWC_CONNECT_SECRET_CONFIG,
  });
  const uri = resolved.value.trim();
  if (!uri) throw missingNwcUriError("dvm wallet connect", { prompts: true });

  const { probe, balance, rate, warnings } = await verifyAndSaveWallet(uri, opts.budget, opts.human);
  const funding = getFundingGuidance({ walletType: "nwc", balanceMsats: balance });

  if (opts.human) {
    printFloatHuman(probe, balance, rate, opts.budget, warnings);
    printFundingGuidance(funding);
  } else {
    json({
      status: "connected",
      ...floatJson(probe, balance, rate, opts.budget, warnings),
      ...rateStaleFields(rate),
      ...funding,
    });
  }
}

export async function walletBalance(opts: WalletBalanceOptions): Promise<void> {
  const connectedTempo = await connectedTempoAccount();
  if (connectedTempo) await assertTempoBalanceRpcNetwork(connectedTempo);
  const { walletType, rate, rails, totalLnAndCashuMsats, cashuMints } = await probeWallets();
  // `probeWallets` describes configured payment rails, so a freshly initialized
  // agent wallet with no mint and no proofs does not produce a Cashu row. The
  // wallet file is the authority on whether that wallet nevertheless exists.
  const agentWallet = loadAgentWallet();
  const effectiveWalletType = walletType ?? (agentWallet ? "cashu" : null);

  const lightningProbe = rails.find((r) => r.rail === "lightning");
  const cashuProbe = rails.find((r) => r.rail === "cashu");
  const x402Probe = rails.find((r) => r.rail === "x402");
  const tempoProbe = rails.find((r) => r.rail === "tempo");
  // Every recorded channel is confirmed against the escrow before it is
  // reported. `opened: true` says only that this wallet once saw an open
  // settle, and a cooperative close it was told about — or one another machine
  // ran — leaves that flag exactly as it was, so a local read alone reports
  // collateral as locked long after the escrow paid it back. The reconcile is
  // also what retires such a record, which is the one surface that heals a
  // channel nothing else will ever clean up. It never broadcasts.
  // Resolved once, so every row can say whether the channel is this wallet's at
  // all: a record outlives the key that opened it, and reporting a stranger's
  // collateral as this wallet's is what made a lost key unreplaceable
  let tempoChannelAssociations: ReturnType<typeof listTempoChannelAssociations> = [];
  let tempoChannelStore: Record<string, unknown> | undefined;
  try {
    tempoChannelAssociations = listTempoChannelAssociations();
  } catch (err) {
    tempoChannelStore = unreadableChannelStore({
      rail: "Tempo",
      path: TEMPO_CHANNELS_FILE,
      error: err,
      fallback: {
        code: "tempo_channel_store_invalid",
        message: "The saved Tempo channel journal cannot be read safely.",
        hint: `Do not delete ${TEMPO_CHANNELS_FILE}; restore or repair it before signing another channel credential.`,
      },
    });
  }
  const tempoChannels = await Promise.all(
    tempoChannelAssociations.map(async (channel) => {
      // An unreadable descriptor leaves ownership unknown. Treat it as owned
      // so the reconcile still reports the unreadable row.
      const controller = await loadTempoChannelController(channel).catch(() => undefined);
      const owned = tempoChannelControlledBy(controller, connectedTempo?.address);
      const chain = await reconcileTempoChannelOnChain({
        association: channel,
        observeOnly: opts.observeOnly,
      });
      // A closed channel has already paid out, so whose key it was changes
      // nothing a caller can act on — only a record that may still hold
      // collateral is worth saying is out of this wallet's reach.
      const strandedHere = !owned && controller !== undefined && chain.status !== "closed";
      const readable = chain.status !== "unreadable";
      // The chain's figure is the truth for every channel the escrow knows
      // about. For the two it doesn't — a read that failed, and a provisional
      // open the escrow has no record of — its zero is an absence, not a
      // balance, so the row keeps reporting what this wallet's open committed.
      const chainKnowsChannel = readable && chain.status !== "unconfirmed";
      const depositMicro = chainKnowsChannel ? chain.depositMicro : Number(channel.deposit);
      const authorizedMicro = Number(channel.cumulativeAmount);
      const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
      return {
        endpoint: channel.endpoint,
        credit_id: channel.creditId,
        caller_pubkey: channel.callerPubkey,
        channel_id: channel.channelId,
        chain_id: channel.chainId,
        deposit_micro: depositMicro,
        authorized_micro: authorizedMicro,
        uncommitted_micro: Math.max(depositMicro - authorizedMicro, 0),
        ...(readable ? { settled_micro: chain.settledMicro } : {}),
        // What the escrow says, which is the only thing "locked" may rest on.
        chain_status: chain.status,
        ...(opts.observeOnly && {
          observation_only: true,
          would_retire: chain.status === "closed",
        }),
        // Whether this read retired the record — it is gone from the next one.
        retired: chain.retired,
        // Kept because it is what the local record claims, and an agent
        // comparing it with `chain_status` can see a stale one for what it is.
        opened: channel.opened,
        // Who the escrow would refund. Absent only when the descriptor is gone,
        // which is the one case ownership cannot be established from here.
        ...(controller ? { payer: controller.payer } : {}),
        controlled_by_connected_wallet: owned,
        display:
          tempoChannelDisplay(chain, channel.endpoint, {
            deposit: usd(depositMicro),
            authorized: usd(authorizedMicro),
          }) +
          (strandedHere
            ? ` ${foreignChannelClause(controller.payer, connectedTempo?.address)}`
            : ""),
        hint: strandedHere
          ? foreignChannelHint(channel.endpoint, channel.creditId, connectedTempo !== null)
          : tempoChannelHint(chain),
      };
    })
  );
  // The x402 twin of the block above, and it exists for the same reason: a
  // batch channel holds real USDC that only the payer that opened it can ever
  // withdraw, and until  it appeared on no caller read surface at all,
  // so reaching the timed exit meant already knowing a channel id. Every row is
  // chain-confirmed, and this rail spans chains, so each channel is followed to
  // its own rather than to the one the wallet is pinned to. A successful read
  // heals the local balance projection but never retires the record, because
  // that is the only local copy of the channel config a timed exit needs.
  const connectedX402 = await connectedX402Payer();
  // Read off the config rather than the probe: which chain `DVM_X402_RPC_URL`
  // speaks for is a local fact, and a rail whose balance read just failed still
  // has to scope that override correctly for every channel row below.
  const configuredX402Network = loadX402Wallet()?.network ?? X402_DEFAULT_NETWORK;
  const x402ChannelClients = new Map<string, X402ChannelClient>();
  let storedX402Channels: ReturnType<typeof listX402Channels> = [];
  let x402ChannelStore: Record<string, unknown> | undefined;
  try {
    storedX402Channels = listX402Channels();
  } catch (err) {
    x402ChannelStore = unreadableChannelStore({
      rail: "x402",
      path: X402_CHANNELS_FILE,
      error: err,
      fallback: {
        code: "x402_channel_store_invalid",
        message: "The saved x402 channel journal cannot be read safely.",
        hint: `Do not delete ${X402_CHANNELS_FILE}; restore or repair it before signing another channel voucher.`,
      },
    });
  }
  const x402Channels =
    storedX402Channels.length === 0
      ? []
      : await withX402ChannelLock(() =>
          Promise.all(
            storedX402Channels.map(async (channel) => {
              const owned = x402ChannelControlledBy(channel, connectedX402);
              const chain = await readX402ChannelOnChain({
                channel,
                configuredNetwork: configuredX402Network,
                clients: x402ChannelClients,
              });
              // A channel the contract holds nothing for has nothing left to reach, so
              // whose key opened it changes nothing a caller can act on. Only a record
              // that may still hold collateral is worth saying is out of reach.
              const strandedHere = !owned && chain.status !== "closed";
              return {
                endpoint: channel.endpoint,
                credit_id: channel.creditId,
                caller_pubkey: channel.callerPubkey,
                channel_id: channel.channelId,
                network: channel.network,
                ...(chain.depositMicro !== undefined ? { deposit_micro: chain.depositMicro } : {}),
                ...(chain.settledMicro !== undefined ? { settled_micro: chain.settledMicro } : {}),
                ...(chain.uncommittedMicro !== undefined
                  ? { uncommitted_micro: chain.uncommittedMicro }
                  : {}),
                ...(chain.pendingWithdrawalMicro !== undefined
                  ? { pending_withdrawal_micro: chain.pendingWithdrawalMicro }
                  : {}),
                // What the contract says, which is the only thing "locked" may rest on.
                chain_status: chain.status,
                // Only ever set beside a figure the contract did not supply: the record
                // took a local or DVM-reported balance that no chain read has confirmed
                // at the latest reconciliation.
                ...(chain.balanceUnreconciledAt !== undefined
                  ? { balance_unreconciled_at: chain.balanceUnreconciledAt }
                  : {}),
                // Who the contract would repay. Always known here, because the payer is
                // channel-id material rather than something a descriptor carries.
                payer: channel.config.payer,
                controlled_by_connected_wallet: owned,
                display:
                  x402ChannelDisplay(chain, channel) +
                  (strandedHere
                    ? ` ${foreignX402ChannelClause(channel.config.payer, connectedX402)}`
                    : ""),
                hint: [
                  x402ChannelCaveats(chain),
                  strandedHere ? foreignX402ChannelHint() : x402ChannelHint(chain),
                ]
                  .filter((part) => part.length > 0)
                  .join(" "),
              };
            })
          )
        );

  const tempoLedgerCredits = listCredits()
    .filter((credit) => credit.rail === "tempo" && credit.status === "active")
    .map((credit) => ({
      endpoint: credit.endpoint,
      credit_id: credit.creditId,
      remaining_micro: credit.remainingMicro,
      display: `Prepaid credit at ${credit.endpoint}: $${(credit.remainingMicro / 1_000_000).toFixed(2)} spendable at that DVM.`,
      hint: "This is the DVM's ledger balance, not the Tempo wallet balance or channel deposit.",
    }));

  // A configured-but-unreachable Lightning backend (e.g. NWC relay timed out)
  // was a throw in the pre-probe code so users saw the actual error. Preserve
  // that: `dvm doctor` is the new place to get a full diagnostic; ordinary
  // `dvm wallet balance` keeps its sharp failure. The production acceptance
  // observer needs the other rail identities even when NWC is offline, so its
  // explicit all-rail observation mode carries the Lightning diagnostic.
  if (!opts.observeOnly && lightningProbe?.configured && !lightningProbe.reachable) {
    const err = lightningProbe.error;
    throw new DvmError(
      err?.code ?? "lightning_unreachable",
      err?.message ?? "Lightning backend not reachable.",
      "Re-run 'dvm wallet connect' with the connection string piped in."
    );
  }

  // Lightning balance — only emit the block when the probe reached the backend.
  // A reachable float that wouldn't answer `get_balance` reports the balance as
  // unknown (mirroring the Tempo row below); coercing it to 0 would show a
  // healthy, funded wallet as empty.
  const lightningMsats = lightningProbe?.balanceMsats;
  const lightning = lightningProbe
    ? lightningProbe.reachable
      ? lightningMsats === undefined
        ? {
            msats: null,
            balance_unknown: true,
            display: `${probeRailLabel("lightning")}: balance unknown`,
            funding: NWC_FUNDING_FLOAT_ROLE,
          }
        : rate
          ? { ...monetaryJson(lightningMsats, rate), funding: NWC_FUNDING_FLOAT_ROLE }
          : { msats: lightningMsats, funding: NWC_FUNDING_FLOAT_ROLE }
      : opts.observeOnly
        ? unreachableRailJson(lightningProbe)
        : undefined
    : undefined;

  // Cashu — emit the block whenever mints are configured (probeWallets returns
  // a row in that case even at zero balance) or the agent wallet exists. The
  // latter is the initialized-but-not-yet-configured state: zero is known from
  // its empty proof store, and the remedy is to add the first mint.
  const cashuTotalMsats = cashuProbe?.balanceMsats ?? 0;
  const cashu = cashuProbe || agentWallet
    ? {
        totalMsats: cashuTotalMsats,
        byMint: (cashuProbe?.details?.byMint as Record<string, number> | undefined) ?? {},
        ...(cashuMints.length === 0 ? { hint: ADD_CASHU_MINT_HINT } : {}),
      }
    : undefined;

  // x402 — emit the block whenever the rail is configured, reachable or not.
  // dropping it on a failed probe made "no x402 wallet" and "an x402
  // wallet that's broken" the same JSON. The unreachable shape carries the
  // account, the diagnosis and the remedy, and no balance at all.
  //
  // on a reachable rail, name the dollar and the chain the balance
  // was read on, and on a zero say that the wrong dollar — or the right one on
  // another chain — reads exactly the same way. Branch on the probe's own
  // balance rather than the `?? 0` below, so an absent balance can never pose
  // as a wrong-asset zero.
  const x402Asset = x402Probe?.reachable
    ? resolveX402Asset(x402Probe.details?.network as string | undefined)
    : null;
  const x402 = x402Probe
    ? x402Probe.reachable
      ? {
          address: x402Probe.details?.address as string,
          network: x402Probe.details?.network as string | undefined,
          ...(x402Asset ? { asset: x402Asset.symbol, token: x402Asset.address } : {}),
          // and the endpoint the number came from, plus whether the
          // caller's own override put it there.
          ...rpcJson(x402Probe),
          balance_usdc: x402Probe.balanceUsdc ?? 0,
          ...(x402Asset && x402Probe.balanceUsdc === 0
            ? { hint: x402WrongAssetHint(x402Asset) }
            : {}),
        }
      : unreachableRailJson(x402Probe)
    : undefined;

  // Tempo: present block whether reachable or balance-unknown; an
  // unreachable one carries the same diagnosis fields as x402 above.
  let tempo: Record<string, unknown> | undefined;
  if (tempoProbe) {
    const balanceUnknown = !tempoProbe.reachable || tempoProbe.balanceUsdc === undefined;
    // name the settlement asset, and on a zero balance say that a
    // different Tempo dollar would read exactly the same way. Resolved
    // leniently — a malformed currency override already surfaces as the probe
    // error below, and must not abort a read-only balance report.
    const tempoNetwork = connectedTempo ? tempoAccountNetwork(connectedTempo) : "mainnet";
    const tempoAsset = tryResolveTempoAssetFor(tempoNetwork);
    tempo = {
      method: "tempo",
      network: tempoNetwork,
      network_label: tempoNetworkLabel(tempoNetwork),
      address: tempoProbe.details?.address as string,
      chain_id: tempoProbe.details?.chain_id as number,
      ...(tempoAsset ? { asset: tempoAsset.symbol, token: tempoAsset.address } : {}),
      // as on x402 above — which endpoint answered this read.
      ...rpcJson(tempoProbe),
      ...(balanceUnknown ? { balance_unknown: true } : { balance_usdc: tempoProbe.balanceUsdc }),
      ...(tempoAsset && tempoProbe.balanceUsdc === 0
        ? { hint: tempoWrongAssetHint(tempoAsset) }
        : {}),

      ...(tempoProbe.reachable ? {} : unreachableRailJson(tempoProbe)),
    };
  }

  // No rail or recoverable channel state at all. A channel record deliberately
  // outlives the key that opened it, and an unreadable store may hold those
  // records, so neither may be replaced with the generic "no wallet" error.
  if (
    rails.length === 0 &&
    tempoChannels.length === 0 &&
    x402Channels.length === 0 &&
    !tempoChannelStore &&
    !x402ChannelStore &&
    !agentWallet
  ) {
    throw new DvmError(
      "wallet_missing",
      "No agent wallet found.",
      "Run `dvm wallet init` first to generate a lock keypair."
    );
  }

  // Funding guidance always carries the safe-funding advisory, so attach it
  // whenever a Lightning/Cashu rail is detected. The fundingOptions array is
  // empty when balance is positive (advisory still shown).
  const funding = effectiveWalletType
    ? getFundingGuidance({
        walletType: effectiveWalletType,
        balanceMsats: totalLnAndCashuMsats,
        cashuMints,
        hasLightningBackend: !!lightningProbe?.reachable,
      })
    : undefined;

  if (opts.human) {
    if (lightning) {
      const amount =
        lightningMsats === undefined
          ? "balance unknown (the wallet didn't report one)"
          : rate
            ? formatAmount(lightningMsats, rate)
            : `${Math.round(lightningMsats / 1000)} sats`;
      info(`${probeRailLabel("lightning")}: ${amount}`);
      info(`  ${NWC_FUNDING_FLOAT_ROLE.display}`);
      info(`  ${NWC_FUNDING_FLOAT_ROLE.hint}`);
    }
    if (cashu) {
      info(`${probeRailLabel("cashu")}: ${Math.round(cashuTotalMsats / 1000)} sats`);
      for (const [url, msats] of Object.entries(cashu.byMint)) {
        info(`  ${url}: ${Math.round(msats / 1000)} sats`);
      }
      if (cashuMints.length === 0) info(`  ↳ ${ADD_CASHU_MINT_HINT}`);
    }
    if (x402 && x402Probe) {
      if (!x402Probe.reachable) {
        printUnreachableRailHuman(x402Probe);
      } else {
        const where = x402Asset ? ` on ${x402Asset.networkLabel}` : "";
        const balance = x402Probe.balanceUsdc ?? 0;
        info(
          `${probeRailLabel("x402")}: $${balance.toFixed(2)} ${x402Asset?.unit ?? "USDC"}${where} (${x402Probe.details?.address as string})`
        );
        // which endpoint answered, above the asset hint — an
        // override left on the wrong chain is one of the ways this reads $0.00.
        const endpoint = rpcEndpointLine(x402Probe);
        if (endpoint) info(`  ↳ ${endpoint}`);
        // a zero here reads the same whether the wallet is unfunded,
        // holds a dollar this rail doesn't read, or holds the right one on
        // another chain. Say which.
        if (x402Asset && x402Probe.balanceUsdc === 0) {
          info(`  ↳ ${x402WrongAssetHint(x402Asset)}`);
        }
      }
    }
    // Printed whether or not the rail above is configured: a channel recorded
    // here holds value even when the key that opened it is gone.
    for (const channel of x402Channels) {
      info(`  Channel: ${channel.display}`);
      info(`    ↳ ${channel.hint}`);
    }
    if (x402ChannelStore) printUnreadableChannelStoreHuman(x402ChannelStore);
    if (tempo) {
      if (tempoProbe && !tempoProbe.reachable) {
        printUnreachableRailHuman(tempoProbe);
      } else if (tempo.method === "tempo") {
        const network = connectedTempo ? tempoAccountNetwork(connectedTempo) : "mainnet";
        const asset = tryResolveTempoAssetFor(network);
        const balStr = tempo.balance_unknown
          ? "balance unknown"
          : `$${(tempo.balance_usdc as number).toFixed(2)} ${asset?.unit ?? "tokens"}`;
        info(
          `${probeRailLabel("tempo")}: ${balStr} on ${tempoNetworkLabel(network)} (${String(tempo.address)})`
        );
        const endpoint = tempoProbe ? rpcEndpointLine(tempoProbe) : null;
        if (endpoint) info(`  ↳ ${endpoint}`);
        // a zero here reads the same whether the wallet is unfunded
        // or holds a Tempo dollar this rail doesn't settle in. Say which.
        if (asset && tempo.balance_usdc === 0) info(`  ↳ ${tempoWrongAssetHint(asset)}`);
      } else {
        info(
          `${probeRailLabel("tempo")}/${String(tempo.method)}: ${(tempo.identifier as string | undefined) ?? "(no identifier)"}`
        );
      }
    }
    for (const channel of tempoChannels) {
      info(`  Channel: ${channel.display}`);
      info(`    ↳ ${channel.hint}`);
    }
    if (tempoChannelStore) printUnreadableChannelStoreHuman(tempoChannelStore);
    for (const credit of tempoLedgerCredits) {
      info(`  Credit: ${credit.display}`);
      info(`    ↳ ${credit.hint}`);
    }
    if (funding) printFundingGuidance(funding);
  } else {
    json({
      ...(effectiveWalletType ? { walletType: effectiveWalletType } : {}),
      ...(lightning ? { lightning } : {}),
      ...(cashu ? { cashu } : {}),
      ...(x402 ? { x402 } : {}),
      ...(x402Channels.length > 0 ? { x402_channels: x402Channels } : {}),
      ...(x402ChannelStore ? { x402_channel_store: x402ChannelStore } : {}),
      ...(tempo ? { tempo } : {}),
      ...(tempoChannels.length > 0 ? { tempo_channels: tempoChannels } : {}),
      ...(tempoChannelStore ? { tempo_channel_store: tempoChannelStore } : {}),
      ...(tempoLedgerCredits.length > 0 ? { prepaid_credits: tempoLedgerCredits } : {}),
      ...(funding ?? {}),
    });
  }
}

// Re-export so downstream consumers can import the probe shape from wallet.ts
export type { RailProbe };

/**
 * The endpoint facts a reachable on-chain rail carries, ready to spread into
 * its balance block. Empty for a rail that read no endpoint.
 */
function rpcJson(rail: RailProbe): Record<string, unknown> {
  const url = rail.details?.rpc_url;
  if (typeof url !== "string" || url.length === 0) return {};
  return { rpc_url: url, rpc_source: rail.details?.rpc_source };
}

/**
 * Describe one Tempo channel row from what the escrow said about it.
 *
 * Only a chain-confirmed `open` may use the word "locked": every other state is
 * either money that has left the escrow, money on its way out, or a channel
 * nobody has confirmed exists — and saying "locked" of any of them asserts the
 * escrow holds something nobody checked .
 */
function tempoChannelDisplay(
  chain: TempoChannelReconcileResult,
  endpoint: string,
  amounts: { deposit: string; authorized: string }
): string {
  switch (chain.status) {
    case "open":
      return `Tempo channel deposit at ${endpoint}: ${amounts.deposit} locked on-chain, ${amounts.authorized} cumulatively authorized.`;
    case "closing":
      return `Tempo channel at ${endpoint}: ${amounts.deposit} is still escrowed, and a close has been requested on-chain — it is in its 15-minute grace period.`;
    case "closed":
      return `Tempo channel at ${endpoint} is closed on-chain: no collateral is locked${closedRecordClause(chain)}.`;
    case "unconfirmed":
      return `Tempo channel at ${endpoint}: an open committing ${amounts.deposit} was signed but the escrow has no record of it, so this collateral may or may not be locked.`;
    case "unreadable":
      return `Tempo channel at ${endpoint}: the chain could not be read this run, so whether the ${amounts.deposit} this record last saw is still locked is unknown.`;
  }
}

/**
 * Describe one x402 channel row from what the settlement contract said.
 *
 * The same rule the Tempo rows follow: only a chain-confirmed `open` may use
 * the word "locked". Every other verdict is either value that has left the
 * contract, value on its way out, or a channel nobody has confirmed exists, and
 * saying "locked" of any of them asserts something nobody checked.
 */
function x402ChannelDisplay(
  chain: X402ChannelChainReport,
  channel: { endpoint: string; network: string }
): string {
  const where = x402NetworkLabel(channel.network);
  // Absent only on the two verdicts below, which is why they and no others
  // have to word themselves around not having one.
  const amount = usdMicro(chain.depositMicro);
  switch (chain.status) {
    case "open":
      return `x402 channel deposit at ${channel.endpoint}: ${amount ?? UNKNOWN_AMOUNT} locked on-chain on ${where}, of which ${usdMicro(chain.settledMicro) ?? UNKNOWN_AMOUNT} has already been claimed by the DVM.`;
    case "closing":
      return `x402 channel at ${channel.endpoint}: a timed exit for ${usdMicro(chain.pendingWithdrawalMicro) ?? UNKNOWN_AMOUNT} is in flight on ${where} and is inside its delay window.`;
    case "closed":
      return `x402 channel at ${channel.endpoint} holds nothing on ${where}: the contract has paid out everything it held, ${usdMicro(chain.settledMicro) ?? UNKNOWN_AMOUNT} of it to the DVM.`;
    case "unconfirmed":
      return `x402 channel at ${channel.endpoint}: the settlement contract on ${where} holds nothing for this channel and has no record of ever having held anything${chain.depositMicro !== undefined && chain.depositMicro > 0 ? `, though this wallet's own record still shows ${amount}` : ""}. A deposit that has not landed yet and a channel already emptied through its timed exit look identical from the chain, so this row cannot say which happened.`;
    case "unreadable":
      return amount === undefined
        ? `x402 channel at ${channel.endpoint}: ${where} could not be read this run and this wallet holds no figure of its own for the channel, so what the contract holds for it is unknown.`
        : `x402 channel at ${channel.endpoint}: ${where} could not be read this run, so whether the ${amount} this wallet last recorded is still held for it is unknown.`;
  }
}

/**
 * What is true of one x402 row's figures whoever owns the channel.
 *
 * Kept apart from the remedies below because the ownership branch *replaces*
 * one remedy with another — advice only the payer that opened the channel can
 * act on is wrong advice for anyone else — and these two would be lost with it.
 * Neither is about ownership: an endpoint that would not answer has to be
 * fixed before any row here means anything, and where the reported figure came
 * from is a property of the number itself.
 */
function x402ChannelCaveats(chain: X402ChannelChainReport): string {
  return [
    // The message carries the actual cause — a timeout, a 429, a DNS failure —
    // and the hint only the remedy. An agent debugging a channel that stays
    // unreadable needs the first to know whether retrying is the answer.
    chain.error?.message,
    chain.error?.hint,
    chain.balanceUnreconciledAt === undefined
      ? undefined
      : `The figure above is this wallet's own record. Its balance was last set locally or reported by the DVM on ${new Date(chain.balanceUnreconciledAt).toISOString()}, and the chain has not confirmed it since, so it may be higher than the contract ever held.`,
  ]
    .filter((part) => part !== undefined)
    .join(" ");
}

function x402ChannelHint(chain: X402ChannelChainReport): string {
  switch (chain.status) {
    case "open":
      return "This is on-chain channel collateral, not the DVM ledger balance. Drain the credit cooperatively with 'dvm credit drain', or start the timed exit with 'dvm wallet x402-withdraw-initiate --channel-id <id>' if the DVM is unavailable.";
    case "closing":
      return "'dvm wallet x402-withdraw-finalize --channel-id <id>' pays it out once the delay ends. The DVM may still claim value this wallet already authorized before then, so the payout can land below the figure above.";
    case "closed":
      return "Nothing further is needed here: the contract holds nothing for this channel. The record stays because it is this machine's only copy of the channel configuration a timed exit addresses the contract with.";
    case "unconfirmed":
      return "Nothing is locked here either way: the contract's balance for this channel is zero, so there is nothing to exit and nothing at risk. If you already finalized a timed exit on this channel, the money is back in the wallet and this row is the expected end state — check the x402 balance above. If instead a funding is still pending on this machine, 'dvm credit fund <dvm>' resumes it.";
    case "unreadable":
      return "Re-running 'dvm wallet balance' re-reads the contract. The record is kept meanwhile because it is the only route back to any collateral the contract does hold.";
  }
}

/**
 * The one sentence an x402 row needs when the channel is not this wallet's.
 *
 * Appended rather than substituted, exactly as the Tempo clause is: the
 * chain-state wording is still true of the channel, and an agent reading
 * `deposit_micro` needs to know both that the contract holds it and that this
 * machine cannot reach it.
 */
function foreignX402ChannelClause(payer: string, connected: string | null): string {
  return connected === null
    ? `It was opened by x402 wallet ${payer}, and no x402 key is connected here, so nothing on this machine can withdraw it.`
    : `It was opened by x402 wallet ${payer}, not the connected ${connected}, so nothing here can withdraw it.`;
}

/**
 * What to do about a channel the connected x402 key cannot act on.
 *
 * One route only, unlike the Tempo twin's two: the contract pays a withdrawal
 * back to the payer that opened the channel and to nobody else, and this rail
 * has no `--abandon` verb that retires a record without touching the chain.
 */
function foreignX402ChannelHint(): string {
  return "Reconnect that exact key ('dvm wallet x402-connect --key-file <path>', or DVM_X402_KEY=<key> dvm wallet x402-connect) to recover this collateral: the contract only ever pays a withdrawal back to the payer that opened the channel. This row blocks neither 'dvm wallet x402-disconnect' nor a replacement, because the key guard judges only the channels the connected key opened.";
}

function usdMicro(micro: number | undefined): string | undefined {
  return micro === undefined ? undefined : `$${(micro / 1_000_000).toFixed(2)}`;
}

/** Stands in for an amount neither the contract nor the local record could supply. */
const UNKNOWN_AMOUNT = "an unknown amount";

/**
 * The one sentence a row needs when the channel is not this wallet's.
 *
 * Appended rather than substituted: the chain-state wording above is still true
 * of the channel, and an agent reading `deposit_micro` needs to know both that
 * the escrow holds it and that this machine cannot reach it.
 */
function foreignChannelClause(payer: string, connected: string | undefined): string {
  return connected === undefined
    ? `It was opened by Tempo wallet ${payer}, and no Tempo key is connected here, so nothing on this machine can close it.`
    : `It was opened by Tempo wallet ${payer}, not the connected ${connected}, so nothing here can close it.`;
}

/**
 * What to do about a channel the connected Tempo key cannot act on.
 *
 * The `--abandon` route is offered only when a key is connected, because that
 * is the only state in which the exit treats this record as a stranger's and
 * retires it without touching the chain. With none connected it reads the
 * escrow like any other exit and refuses over a channel that still holds
 * collateral, which is what protects a key the caller can still restore.
 */
function foreignChannelHint(endpoint: string, creditId: string, connected: boolean): string {
  const abandon = [
    "dvm wallet tempo-exit",
    shellQuoteArg(endpoint),
    "--credit-id",
    shellQuoteArg(creditId),
    "--abandon",
  ].join(" ");
  const retire = connected
    ? `, or retire the record with '${abandon}' — which discards this machine's only descriptor for the channel, so the key would no longer recover it afterwards`
    : "";
  // `--force` rides on `connected` for the same reason `--abandon` does: it is
  // what the import actually needs in each state. With a key configured the
  // reconnect is a replacement and refuses without it; with none, the flag is
  // accepted and does nothing, which is advice that reads as required and is
  // not.
  return `Reconnect that exact key (${tempoKeyImportRoutes({ replacingConnectedKey: connected })}) to recover this collateral${retire}. Either way this row blocks neither 'dvm wallet tempo-disconnect' nor a replacement.`;
}

function tempoChannelHint(chain: TempoChannelReconcileResult): string {
  switch (chain.status) {
    case "open":
      return "This is on-chain channel collateral, not the DVM ledger balance. Drain the credit cooperatively, or use 'dvm wallet tempo-exit <dvm>' if the DVM is unavailable.";
    case "closing":
      return "'dvm wallet tempo-exit <dvm>' withdraws what remains once the grace period ends. The DVM may still settle vouchers this wallet already authorized before then, so the payout can land below the figure above.";
    case "closed":
      return chain.retired
        ? "Nothing further is needed here: this collateral has left the escrow, and the row is gone from the next read."
        : "Nothing is at risk here — this collateral has left the escrow — but the row survives this read, and re-running 'dvm wallet balance' is what clears it.";
    case "unconfirmed":
      return "'dvm wallet tempo-exit <dvm>' reads the chain and says which it is; it reports 'unconfirmed' and keeps the record while the escrow has no channel. 'dvm credit fund <dvm>' resumes a funding still pending here, and '--abandon' on that exit retires a record whose open is known never to have landed.";
    case "unreadable":
      return `${chain.error?.hint ? `${chain.error.hint} ` : ""}Re-running 'dvm wallet balance' re-reads the escrow, and retires this record if the channel has closed. The record is kept meanwhile because it is the only route back to any collateral the escrow does hold.`;
  }
}

/**
 * Why a chain-confirmed close left its local record behind, when it did.
 *
 * Two ways that happens, and they are worth telling apart: the payment scope
 * has since been taken over by a newer channel — whose record this now is, and
 * which must not be deleted — or the retire itself could not run this time.
 */
function closedRecordClause(chain: TempoChannelReconcileResult): string {
  if (chain.retired) return ", and its local recovery record has been retired";
  return chain.error
    ? ", but its local record could not be retired this run and was kept"
    : ", but its local record was kept because a newer channel now occupies its payment scope";
}

/**
 * The balance block for a rail that is configured but whose balance couldn't be
 * read.
 *
 * Two properties earn their keep. There is no balance field at all — not a
 * zero, which is the failure class  exists to prevent, and would here
 * be a fabricated one. And `balance_unknown` is positive evidence: an absent
 * `x402` key now means "no x402 wallet", so a reader never has to infer a
 * broken rail from a missing one.
 */
function unreachableRailJson(rail: RailProbe): Record<string, unknown> {
  const address = rail.details?.address as string | undefined;
  const network = rail.details?.network as string | undefined;
  return {
    ...(address ? { address } : {}),
    ...(network ? { network } : {}),
    balance_unknown: true,
    display: unreachableRailDisplay(rail),
    hint: unreachableRailHint(rail),
    ...(rail.error ? { error: rail.error } : {}),
  };
}

function unreadableChannelStore(args: {
  rail: "Tempo" | "x402";
  path: string;
  error: unknown;
  fallback: { code: string; message: string; hint: string };
}): Record<string, unknown> {
  const known = args.error instanceof DvmError ? args.error : null;
  const hint = known?.hint ?? args.fallback.hint;
  return {
    status: "unreadable",
    path: args.path,
    display: `Saved ${args.rail} channel rows are unavailable because ${args.path} could not be read safely.`,
    hint,
    error: {
      code: known?.code ?? args.fallback.code,
      message:
        known?.message ??
        (args.error instanceof Error ? args.error.message : args.fallback.message),
      ...(known?.display ? { display: known.display } : {}),
      ...(known?.hint ? { hint: known.hint } : {}),
      ...(known?.data ?? {}),
    },
  };
}

function printUnreadableChannelStoreHuman(store: Record<string, unknown>): void {
  info(String(store.display));
  info(`  ↳ ${String(store.hint)}`);
}

function printUnreachableRailHuman(rail: RailProbe): void {
  const address = rail.details?.address as string | undefined;
  info(`${probeRailLabel(rail.rail)}: balance unknown${address ? ` (${address})` : ""}`);
  info(`  ↳ ${unreachableRailDisplay(rail)} ${unreachableRailHint(rail)}`);
}

export async function walletDisconnect(opts: { human?: boolean }): Promise<void> {
  // The one command entitled to take the NWC connection string off this
  // machine, so it is the one that names it. `float` goes with it
  // because it describes that connection and nothing else — the alias and the
  // budget the caller stated when they connected it.
  //
  // `defaultBudget` deliberately does not. It is the per-request cap
  // every rail is checked against, not a property of the Lightning wallet, so
  // taking it out here silently raised the ceiling on ecash, Tempo and x402
  // spending as a side effect of disconnecting something else.
  const { previous } = await updateConfig({
    reason: "wallet_disconnect",
    authorize: authorizeProtectedRemoval("nwcUri"),
    patch: (current) => {
      if (!current) {
        throw new DvmError("no_config", "No config found.", "Run: dvm init");
      }
      return { unset: ["nwcUri", "float"] };
    },
  });
  const hadWallet = Boolean(previous?.nwcUri);

  const display = hadWallet
    ? "Lightning wallet disconnected. Its connection string is gone from this machine."
    : "No Lightning wallet was connected.";
  if (opts.human) {
    info(display);
  } else {
    json({ status: "disconnected", display });
  }
}


interface SetupWalletFacts {
  configured: boolean;
  address?: string;
}

interface SetupNetworkFacts {
  id: string;
  label: string;
}

interface SetupTokenFacts {
  symbol: string | null;
  label: string;
  address: string;
}

interface RailSetupFacts {
  wallet: SetupWalletFacts;
  network?: SetupNetworkFacts;
  token?: SetupTokenFacts;
}

interface SetupChoiceHumanRow {
  title: string;
  summary: string;
  bestFor: string;
  warning: string;
  command: string;
  setupCommand: string;
  verifyCommand: string;
  docsUrl: string;
  wallet: SetupWalletFacts;
  network?: SetupNetworkFacts;
  token?: SetupTokenFacts;
}

function railSetupChoice(onramp: RailOnramp, facts: RailSetupFacts) {
  const copy = railSetupCopy(onramp, facts);
  return {
    rail: onramp.rail,
    ...copy,
    warning: onramp.warning,
    noBitcoinNeeded: onramp.noBitcoinNeeded,
    recommended: false,
    command: `dvm wallet setup --rail ${onramp.rail}`,
    setupCommand: onramp.setupCommand,
    verifyCommand: onramp.verifyCommand,
    docsUrl: onramp.docsUrl,
    ...facts,
  };
}

function railSetupCopy(
  onramp: RailOnramp,
  facts: RailSetupFacts
): Pick<RailOnramp, "title" | "summary" | "bestFor"> {
  if (onramp.rail !== "x402" || !facts.network || !facts.token) {
    return { title: onramp.title, summary: onramp.summary, bestFor: onramp.bestFor };
  }

  const route = `${facts.token.label} on ${facts.network.label}`;
  return {
    title: `x402 — US dollars (${route})`,
    summary: `Pay in ${route}. No Bitcoin needed.`,
    bestFor: `Best when your current provider can withdraw ${facts.token.label} directly to ${facts.network.label}.`,
  };
}

async function railSetupFacts(rail: OnrampRail): Promise<RailSetupFacts> {
  if (rail === "x402") {
    const wallet = loadX402Wallet();
    const network = wallet?.network ?? X402_DEFAULT_NETWORK;
    const asset = resolveX402Asset(network);
    let address: string | undefined;
    if (wallet) {
      try {
        address = (await ensureAddress(wallet)).address;
      } catch {
        // A malformed legacy key remains "configured" so the verify command
        // can diagnose it, but no derived address is invented or leaked.
      }
    }
    return {
      wallet: { configured: Boolean(wallet), ...(address ? { address } : {}) },
      network: {
        id: network,
        label: asset?.networkLabel ?? x402NetworkLabel(network),
      },
      ...(asset
        ? {
            token: {
              symbol: asset.symbol,
              label: asset.label,
              address: asset.address,
            },
          }
        : {}),
    };
  }

  if (rail === "tempo") {
    const wallet = await connectedTempoAccount();
    const network = wallet ? tempoAccountNetwork(wallet) : "mainnet";
    const chain = resolveTempoNetwork(network);
    const asset = tryResolveTempoAssetFor(network);
    return {
      wallet: {
        configured: Boolean(wallet),
        ...(wallet ? { address: wallet.address } : {}),
      },
      network: { id: `eip155:${String(chain.chainId)}`, label: tempoNetworkLabel(network) },
      ...(asset
        ? { token: { symbol: asset.symbol, label: asset.label, address: asset.address } }
        : {}),
    };
  }

  return { wallet: { configured: Boolean(loadAgentWallet()) } };
}

function tryResolveTempoAssetFor(network: "mainnet" | "moderato") {
  try {
    return resolveTempoAsset(process.env, network);
  } catch {
    return null;
  }
}

function printSetupChoiceHuman(row: SetupChoiceHumanRow): void {
  info(`  ${row.title}`);
  info(`    ${row.summary}`);
  info(`    ${row.bestFor}`);
  info(`    Warning: ${row.warning}`);
  const configured = row.wallet.configured ? "configured" : "not configured";
  info(`    Local wallet: ${configured}${row.wallet.address ? ` · ${row.wallet.address}` : ""}`);
  if (row.network) info(`    Network: ${row.network.label} (${row.network.id})`);
  if (row.token) info(`    Token: ${row.token.label} (${row.token.address})`);
  info(`    Setup: ${row.setupCommand}`);
  info(`    Verify: ${row.verifyCommand}`);
  info(`    Funding guide: ${row.docsUrl}`);
  info(`    Full walkthrough: ${row.command}`);
  info("");
}

function emitRailOnramp(onramp: RailOnramp, facts: RailSetupFacts, human?: boolean): void {
  const row = railSetupChoice(onramp, facts);
  if (human) {
    info(`${row.title} — onramp\n`);
    info(`${row.bestFor}\n`);
    info(`Warning: ${row.warning}`);
    const configured = facts.wallet.configured ? "configured" : "not configured";
    info(`Local wallet: ${configured}${facts.wallet.address ? ` · ${facts.wallet.address}` : ""}`);
    if (facts.network) info(`Network: ${facts.network.label} (${facts.network.id})`);
    if (facts.token) info(`Token: ${facts.token.label} (${facts.token.address})`);
    info(`Setup: ${row.setupCommand}`);
    info(`Verify: ${row.verifyCommand}`);
    info(`Funding guide: ${row.docsUrl}\n`);
    for (let i = 0; i < onramp.steps.length; i++) {
      const s = onramp.steps[i];
      info(`  ${i + 1}. ${s.display}`);
      if (s.command) info(`     ${s.command}`);
      if (s.url) info(`     ${s.url}`);
      info(`     ${s.description}`);
    }
    info(`\n${SETUP_ADVISORY}`);
  } else {
    json({
      step: "onramp",
      ...row,
      steps: onramp.steps,
      advisory: SETUP_ADVISORY,
    });
  }
}

/**
 * The NWC string `wallet setup --type nwc` should act on, or `undefined` when
 * the caller supplied none and wants the walkthrough.
 *
 * Shaped like `wallet x402-connect`'s `readImportedKey`: a source the caller
 * *declared* (`--nwc-uri`, `--file`) is always read and always fails loudly,
 * while an undeclared stdin is read only when it could carry something. An
 * agent harness routinely hands its child an idle pipe that `isTTY` alone
 * can't tell from one about to deliver a credential, so a pipe that drains to
 * the timeout means "nothing was supplied" here rather than an error — the
 * walkthrough is what a caller with no string wants, and it is the more common
 * case on this command by far.
 */
async function readSetupNwcUri(opts: WalletSetupOptions): Promise<string | undefined> {
  const declared = Boolean(opts.nwcUri) || Boolean(opts.file);
  if (!declared && !hasPipedStdin()) return undefined;

  let resolved;
  try {
    resolved = await resolveSecretInput({
      positional: opts.nwcUri,
      file: opts.file,
      config: NWC_SETUP_SECRET_CONFIG,
    });
  } catch (err) {
    if (!declared && err instanceof DvmError && err.code === "no_input") return undefined;
    throw err;
  }
  const uri = resolved.value.trim();
  if (uri) return uri;
  if (!declared) return undefined;
  throw missingNwcUriError("dvm wallet setup --type nwc", { prompts: false });
}

/**
 * Every source came back empty. The remedy names the command the caller
 * actually ran, so the pipe example can be copied as-is, and only offers the
 * bare-run fallback the command actually has: `wallet connect` prompts,
 * `wallet setup` prints its walkthrough.
 */
function missingNwcUriError(command: string, opts: { prompts: boolean }): DvmError {
  const local = opts.prompts
    ? `Pipe it in (printf 'nostr+walletconnect://...' | ${command}), pass --file <path>, or run the command on a terminal to be prompted.`
    : `Pipe it in (printf 'nostr+walletconnect://...' | ${command}) or pass --file <path>. Running '${command}' with no connection string prints the guided walkthrough instead.`;
  return new DvmError(
    "no_input",
    "No NWC connection string provided.",
    `${local} For a remote or chat-driven agent, use 'dvm wallet pair' instead.`
  );
}

/**
 * Build the NWC input ladder's config for one verb.
 *
 * The string carries a `secret=` that authorizes spending, so it belongs in the
 * same input ladder as a mnemonic. Unlike a raw x402 key the positional is not
 * refused: every shipped runbook and every wallet app's copy-paste flow hands
 * the caller a bare URI, so refusing would break the onboarding path this rail
 * sits at the front of. It warns instead, in the wording `wallet recover` uses
 * — naming safe forms of the verb the caller ran, since the two verbs are not
 * substitutes for one another.
 */
function nwcSecretConfig(command: string, opts: { prompts: boolean }): SecretInputConfig {
  const forms: [string, string][] = [
    [`printf 'nostr+walletconnect://...' | ${command}`, "pipe via stdin"],
    [`${command} --file ~/nwc.txt`, "read from file"],
    ...(opts.prompts ? ([[command, "interactive prompt"]] as [string, string][]) : []),
    ["dvm wallet pair", "remote agent or chat"],
  ];
  const width = Math.max(...forms.map(([form]) => form.length));
  return {
    kind: "NWC connection string",
    promptLabel: "Enter NWC connection string (input hidden, press enter to submit):",
    warningCommands: forms.map(([form, note]) => `${form.padEnd(width)}   # ${note}`),
  };
}

/**
 * Verify a connection can actually serve as a float, then persist it.
 *
 * "Verify" means one round trip on one pool: `get_info` for capabilities,
 * `get_balance` for the number. A wallet that can't `pay_invoice` is rejected
 * outright — it cannot do the job. Everything else that's suspect (no
 * `lookup_invoice`, a phone-class host, no stated budget) is a warning, because
 * the user may be experimenting and a heuristic that guesses wrong shouldn't
 * block them.
 */
async function verifyAndSaveWallet(
  nwcUri: string,
  statedBudgetRaw?: string,
  human?: boolean
): Promise<{
  probe: FloatProbe;
  /** Undefined when the wallet answered `get_info` but not `get_balance`. */
  balance: number | undefined;
  rate: ResolvedBtcRate | null;
  warnings: FloatWarning[];
}> {
  const candidate = await probeWalletConnection(nwcUri, statedBudgetRaw, human);
  await updateConfig({
    reason: "wallet_connect",
    patch: (current) => {
      if (!current) throw new DvmError("no_config", "No config found.", "Run: dvm init");
      return { set: walletConnectionFields(candidate) };
    },
  });
  return candidate;
}

/**
 * Parse and probe an NWC candidate without changing local configuration.
 *
 * `human` only steers the progress notice — the probe itself is identical in
 * either output mode. It is threaded down from each caller's `--human` flag so
 * a redirected human-mode run still narrates the wait; see `progressNotice`.
 */
export async function probeWalletConnection(
  nwcUri: string,
  statedBudgetRaw?: string,
  human?: boolean
): Promise<ProbedWalletConnection> {
  const statedBudget = statedBudgetRaw ? parseStatedBudget(statedBudgetRaw).raw : undefined;

  let conn;
  try {
    conn = parseNwcUri(nwcUri);
  } catch (err) {
    throw toFloatError(err);
  }
  const connectedAt = new Date().toISOString();
  const float: Float = { conn, connectedAt, statedBudget };

  progressNotice("Verifying wallet connection...", human);
  const probe = await probeFloat({ float });
  if (!probe.reachable) {
    throw new DvmError(
      probe.error?.code ?? "float_wallet_offline",
      probe.error?.message ?? "The wallet did not respond.",
      probe.error?.hint ?? "Check that the wallet is online, then retry 'dvm wallet connect'.",
      {
        // The probe's own payload rides through — `next_step`, and for a
        // refusal the method and whether it was a permission or a cap. This is
        // also what `dvm wallet pair complete` relays, since it lets this
        // error propagate verbatim.
        ...(probe.error?.data ?? {}),
        display:
          probe.error?.display ?? "That Lightning wallet didn't answer, so nothing was saved.",
      }
    );
  }
  if (!probe.canPay) {
    throw new DvmError(
      "float_connection_method_missing",
      "This wallet connection cannot send payments — it did not advertise pay_invoice.",
      "Create a new connection in your wallet app with permission to send payments, then reconnect it.",
      {
        display:
          "This connection was created without permission to send payments, so the agent couldn't top itself up with it. Nothing was saved.",
        next_step:
          "In your wallet app, create a new connection and allow it to send payments, then reconnect it.",
        method: "pay_invoice",
        advertised_methods: probe.methods,
      }
    );
  }

  const warnings = collectFloatWarnings(probe, conn.relays, statedBudget);

  // The rate only renders the USD half of the balance line. Wallet setup is the
  // human path, and no money moves here — a CoinGecko outage degrades the
  // balance to sats rather than blocking the wallet from connecting.
  const rate = await tryResolveBtcUsdRate();

  // `probe.balanceMsats` is deliberately undefined when the balance couldn't be
  // read — a connected wallet with an unreadable balance is not an empty one.
  return {
    nwcUri,
    conn,
    connectedAt,
    statedBudget,
    probe,
    balance: probe.balanceMsats,
    rate,
    warnings,
  };
}

export function walletConnectionFields(
  candidate: ProbedWalletConnection
): Required<Pick<Config, "nwcUri" | "float">> {
  return {
    nwcUri: candidate.nwcUri,
    float: {
      connectedAt: candidate.connectedAt,
      ...(candidate.statedBudget ? { statedBudget: candidate.statedBudget } : {}),
      ...(candidate.probe.alias ? { alias: candidate.probe.alias } : {}),
      methods: candidate.probe.methods,
    },
  };
}

function collectFloatWarnings(
  probe: FloatProbe,
  relays: string[],
  statedBudget?: string
): FloatWarning[] {
  const warnings: FloatWarning[] = [];

  const unsuitable = unsuitableFloatWallet({ relays, alias: probe.alias });
  if (unsuitable) warnings.push({ code: "float_host_unsuitable", display: unsuitable.display });

  if (!probe.canReconcile) {
    // Without lookup_invoice a lost response can never be resolved, so an
    // interrupted payment ends as "we don't know" and needs a human to check
    // the wallet's own history.
    warnings.push({
      code: "float_no_reconcile",
      display:
        "This wallet can't be asked about past payments, so if a top-up is interrupted you'll have to check the wallet's own history to see whether it went through.",
    });
  }

  if (!statedBudget) {
    warnings.push({
      code: "float_budget_unstated",
      display:
        "No wallet-side spending policy is recorded. Set one in your wallet app, confirm whether it counts routing fees, then re-connect with --budget to note it here. dvm's local caps check invoice principal, but NIP-47 cannot set a routing-fee ceiling; the wallet chooses the route and fee.",
    });
  }

  return warnings;
}

function printFloatHuman(
  probe: FloatProbe,
  balance: number | undefined,
  rate: ResolvedBtcRate | null,
  statedBudget: string | undefined,
  warnings: FloatWarning[]
): void {
  info(`Lightning float connected: ${probe.alias ?? "unknown wallet"}`);
  info(`  ${NWC_FUNDING_FLOAT_ROLE.display}`);
  info(`  ${NWC_FUNDING_FLOAT_ROLE.hint}`);
  info(`  Balance: ${balanceLine(balance, rate)}`);
  info(
    `  Wallet budget: ${statedBudget ? `${statedBudget} (as you reported it)` : "not recorded"}`
  );
  info(
    `  Supported methods: ${probe.methods.length > 0 ? probe.methods.join(", ") : "unreported"}`
  );
  if (probe.walletReportedBudget) {
    info(`  Wallet-reported budget: ${JSON.stringify(probe.walletReportedBudget)}`);
  }
  for (const w of warnings) info(`\n  Warning: ${w.display}`);
}

function floatJson(
  probe: FloatProbe,
  balance: number | undefined,
  rate: ResolvedBtcRate | null,
  statedBudget: string | undefined,
  warnings: FloatWarning[]
): Record<string, unknown> {
  return {
    alias: probe.alias ?? null,
    balance: balanceJson(balance, rate),
    methods: probe.methods,
    float: {
      can_pay: probe.canPay,
      can_reconcile: probe.canReconcile,
      budget: floatBudgetJson({ statedBudget }, probe.walletReportedBudget),
      ...NWC_FUNDING_FLOAT_ROLE,
      display: `Lightning float connected${probe.alias ? ` (${probe.alias})` : ""}. ${NWC_FUNDING_FLOAT_ROLE.display}`,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Balance for a human: USD when a rate resolved, sats-only when none did, and
 * an explicit "unknown" when the wallet never reported one — a connected wallet
 * whose balance we couldn't read is not a wallet holding nothing.
 */
function balanceLine(msats: number | undefined, rate: ResolvedBtcRate | null): string {
  if (msats === undefined) return "unknown (the wallet didn't report one)";
  if (!rate) return `${Math.round(msats / 1000)} sats (BTC/USD rate unavailable)`;
  const notice = staleRateNotice(rate);
  return `${formatAmount(msats, rate.rate)}${notice ? ` — rate cached ${notice.age}` : ""}`;
}

function balanceJson(
  msats: number | undefined,
  rate: ResolvedBtcRate | null
): Record<string, unknown> {
  if (msats === undefined) {
    return {
      msats: null,
      balance_unknown: true,
      display: "Balance unknown — the wallet is connected but didn't report one.",
      hint: "The connection may not include the get_balance permission. It can still pay invoices; check the balance in the wallet app.",
    };
  }
  if (!rate) return { msats, display: `${Math.round(msats / 1000)} sats` };
  return monetaryJson(msats, rate.rate);
}

/** `rate_stale` block for the wallet JSON, or nothing when the rate is live/absent. */
function rateStaleFields(rate: ResolvedBtcRate | null): { rate_stale?: StaleRateNotice } {
  const notice = staleRateNotice(rate);
  return notice ? { rate_stale: notice } : {};
}
