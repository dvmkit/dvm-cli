import { TempoAccount, TempoNetwork, tryResolveTempoAsset, RailAsset } from "@dvmkit/sdk/internal";
/**
 * Imported and generated keys share `config.tempo`. Records without a network
 * retain the mainnet default. Balance reads target the configured token.
 */

import { DvmError } from "@dvmkit/sdk/internal";

import { loadConfig, updateConfig } from "../identity";

import { tempoAccountFromConfig } from "@dvmkit/sdk/internal";

/**
 * Whether `dvm wallet balance` answers "how much of this token do I hold?".
 *
 * That command reads only the rail's configured settlement asset (see
 * {@link resolveRailAsset}), so pointing at it is right when the token in
 * question *is* that asset and misleading otherwise: a channel opened on a
 * testnet, or under a different `DVM_TEMPO_CURRENCY`, reads a
 * believable zero against a contract the reader never asked about.
 */
export function tempoBalanceCheckHint(token: string): string {
  const configured = tryResolveTempoAsset();
  if (configured?.address.toLowerCase() === token.toLowerCase()) {
    return "This channel's token is the rail's configured settlement asset, so 'dvm wallet balance' reads it.";
  }
  return `'dvm wallet balance' reads the rail's configured settlement asset (${configured?.address ?? "unresolvable in this environment"}) rather than this channel's token (${token}), so query that contract directly for the balance that matters here.`;
}

/**
 * Why a funded-looking Tempo wallet reads zero here: the rail settles in one
 * asset and the balance query only ever sees that contract.
 *
 * Deliberately asset-agnostic on the wrong side — it names what the rail
 * accepts rather than probing a hardcoded USDT0 contract, which covers every
 * wrong-asset case and needs no maintenance as Tempo's token set grows
 */
export function tempoWrongAssetHint(asset: RailAsset): string {
  return `This rail settles only in ${asset.label} (${asset.address}) on Tempo. Another Tempo dollar — USDT0 or any other stablecoin — is a different contract and will never show up here, however much of it your wallet says you hold. If you funded with the wrong one, swap it to ${asset.label} on Tempo (an on-chain swap, fees are sub-cent) or send ${asset.label} to this address.`;
}

/**
 * Load the connected Tempo account from `~/.dvm/config.json::tempo` when the
 * method is `tempo` and the apiKey is a valid secp256k1 scalar. Returns null
 * when no usable Tempo wallet is configured.
 */
export async function connectedTempoAccount(): Promise<TempoAccount | null> {
  const config = loadConfig();
  return tempoAccountFromConfig(config);
}

/**
 * Generate a fresh EVM keypair via viem and persist it as the Tempo wallet.
 * Throws `tempo_wallet_exists` when a Tempo wallet is already configured —
 * mirroring the `dvm wallet init` no-overwrite default. Callers should
 * surface the error with a hint pointing at `tempo-disconnect` or `--force`.
 */
export async function generateTempoKey(
  opts: {
    force?: boolean;
    network?: TempoNetwork;
    /** Complete fallible handoff work before the new key is committed. */
    beforePersist?: (account: TempoAccount) => Promise<void>;
  } = {}
): Promise<TempoAccount> {
  const config = loadConfig();
  if (!config) {
    throw new DvmError(
      "no_config",
      "No config found.",
      "Run `dvm init` before generating a Tempo wallet."
    );
  }
  const existing = await tempoAccountFromConfig(config);
  if (existing && !opts.force) {
    throw new DvmError(
      "tempo_wallet_exists",
      `Tempo wallet already configured (address ${existing.address}).`,
      "Pass `--force` to replace, or run `dvm wallet tempo-disconnect` to clear it first."
    );
  }
  if (existing && opts.force) {
    // Imported here rather than at the top of the file: the gate reaches the
    // escrow through `tempo-session`, which imports this module back for its
    // account type and its balance copy. A static edge would close that cycle.
    const { assertTempoWalletIdle } = await import("./tempo-lifecycle");
    await assertTempoWalletIdle("replace");
  }
  const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const generated = {
    privateKey,
    address: account.address.toLowerCase() as `0x${string}`,
    network: opts.network ?? "mainnet",
  };
  await opts.beforePersist?.(generated);
  await updateConfig({
    reason: "tempo_wallet_generate",
    patch: () => ({
      set: {
        tempo: { method: "tempo", apiKey: privateKey, network: generated.network },
      },
    }),
  });
  return generated;
}