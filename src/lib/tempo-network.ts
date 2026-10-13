import {
  DvmError,
  type MppxChallenge,
  resolveTempoNetwork,
  type TempoAccount,
  type TempoChannelAssociation,
  type TempoNetwork,
} from "@dvmkit/sdk/internal";
import {
  loadConfig,
} from "./identity";

export function resolveTempoNetworkSelection(
  flagValue: string | undefined,
  envValue: string | undefined = process.env.DVM_TEMPO_NETWORK
): TempoNetwork {
  const flag = parseTempoNetwork(flagValue, "--network");
  const env = parseTempoNetwork(envValue, "DVM_TEMPO_NETWORK");
  if (flag && env && flag !== env) {
    throw new DvmError(
      "tempo_network_conflict",
      `--network selects ${flag}, but DVM_TEMPO_NETWORK selects ${env}.`,
      "Use one Tempo network in both places, or unset DVM_TEMPO_NETWORK before retrying. No wallet was changed.",
      { flag_network: flag, env_network: env }
    );
  }
  return flag ?? env ?? "mainnet";
}

/** Resolve a stored account's network, preserving the legacy mainnet default. */
export function tempoAccountNetwork(account: Pick<TempoAccount, "network">): TempoNetwork {
  return account.network ?? "mainnet";
}

export function tempoNetworkLabel(network: TempoNetwork): string {
  return network === "moderato" ? "Tempo Testnet (Moderato)" : "Tempo mainnet";
}

export function tempoNetworkFromChainId(chainId: number | undefined): TempoNetwork {
  return chainId === resolveTempoNetwork("moderato").chainId ? "moderato" : "mainnet";
}

/** Return the configured wallet network without deriving or exposing its key. */
export function configuredTempoNetwork(): TempoNetwork | null {
  const tempo = loadConfig()?.tempo;
  if (tempo?.method !== "tempo") return null;
  return parseTempoNetwork(tempo.network, "config.tempo.network") ?? "mainnet";
}

/**
 * Refuse Tempo challenges for a chain other than the connected wallet's chain.
 * A missing chain keeps mppx's legacy mainnet meaning, so a Moderato wallet
 * also refuses an unstamped challenge rather than letting a default choose.
 */
export function assertTempoChallengeNetwork(
  challenges: readonly MppxChallenge[],
  network: TempoNetwork,
  intents?: readonly string[]
): void {
  const expected = resolveTempoNetwork(network);
  const acceptedIntents = intents ? new Set(intents) : null;
  for (const challenge of challenges) {
    if (challenge.method !== "tempo" || (acceptedIntents && !acceptedIntents.has(challenge.intent)))
      continue;
    const chainId = tempoChallengeChainId(challenge) ?? resolveTempoNetwork("mainnet").chainId;
    if (chainId === expected.chainId) continue;
    throw new DvmError(
      "tempo_network_mismatch",
      `The DVM requested a Tempo payment on chain ${String(chainId)}, but this wallet is configured for ${tempoNetworkLabel(network)} (chain ${String(expected.chainId)}).`,
      `Nothing was signed or paid. Connect a wallet for the DVM's chain, or use a DVM configured for ${tempoNetworkLabel(network)}.`,
      {
        wallet_network: network,
        wallet_chain_id: expected.chainId,
        challenge_chain_id: chainId,
        challenge_intent: challenge.intent,
        payment_signed: false,
      }
    );
  }
}

export function assertConfiguredTempoChallengeNetwork(
  challenges: readonly MppxChallenge[],
  intents?: readonly string[]
): void {
  const network = configuredTempoNetwork();
  if (network) assertTempoChallengeNetwork(challenges, network, intents);
}

export function assertTempoChannelNetwork(
  association: Pick<TempoChannelAssociation, "chainId">,
  account: Pick<TempoAccount, "network">
): void {
  const network = tempoAccountNetwork(account);
  const walletChainId = resolveTempoNetwork(network).chainId;
  if (association.chainId === walletChainId) return;
  throw new DvmError(
    "tempo_channel_network_mismatch",
    `The stored Tempo channel is on chain ${String(association.chainId)}, but the connected wallet selects ${tempoNetworkLabel(network)} (chain ${String(walletChainId)}).`,
    "Nothing was read, signed, or broadcast. Reconnect the wallet on the stored channel's network before retrying this exit.",
    {
      channel_chain_id: association.chainId,
      wallet_network: network,
      wallet_chain_id: walletChainId,
      transaction_broadcast: false,
    }
  );
}

/** Read either generic-header or method-parsed mppx chain metadata. */
export function tempoChallengeChainId(challenge: MppxChallenge): number | undefined {
  const request = challenge.request as Record<string, unknown>;
  const direct = request.chainId;
  if (typeof direct === "number" && Number.isSafeInteger(direct) && direct > 0) return direct;
  const details = request.methodDetails;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const nested = (details as Record<string, unknown>).chainId;
    if (typeof nested === "number" && Number.isSafeInteger(nested) && nested > 0) return nested;
  }
  return undefined;
}

function parseTempoNetwork(value: string | undefined, source: string): TempoNetwork | undefined {
  if (value === undefined) return undefined;
  if (value === "mainnet" || value === "moderato") return value;
  throw new DvmError(
    "invalid_tempo_network",
    `${source} must be 'mainnet' or 'moderato'; got '${value}'.`,
    "Choose --network mainnet for live funds or --network moderato for faucet-funded testing. No wallet was changed.",
    { source, value }
  );
}
