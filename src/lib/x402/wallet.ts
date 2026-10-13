import { ensureAddress, X402RepinnedWallet, X402ConnectedWallet } from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";

import { isValidEvmPrivateKey } from "@dvmkit/sdk/internal";

import { authorizeProtectedRemoval } from "../config-mutation";
import { loadConfig, updateConfig } from "../identity";

import { x402WalletFromConfig } from "@dvmkit/sdk/internal";

import { withX402ChannelLock } from "@dvmkit/sdk/internal";

import { assertSupportedX402Network } from "./networks";

import { X402_DEFAULT_NETWORK } from "@dvmkit/sdk/internal";

import type { X402Wallet } from "@dvmkit/sdk/internal";

export function loadX402Wallet(): X402Wallet | null {
  return x402WalletFromConfig(loadConfig());
}

/** Local ownership read; returns null for an absent or unusable configured key. */
export async function connectedX402Payer(): Promise<string | null> {
  const wallet = loadX402Wallet();
  if (!wallet) return null;
  return (await ensureAddress(wallet)).address;
}

/**
 * Change only the settlement-chain pin on a connected x402 wallet.
 *
 * Existing channels carry their own network, so changing the default for new
 * payments neither strands them nor requires the replacement safety checks.
 * The private key stays byte-for-byte unchanged in the atomic config write.
 */
export async function repinX402WalletNetwork(network: string): Promise<X402RepinnedWallet> {
  // Match x402-connect's ordering: reject a bad chain before inspecting any
  // wallet credential or config state.
  assertSupportedX402Network(network);
  // Channel lock outside, config lock inside — the tree-wide order that keeps
  // the config lock innermost. The channel lock serializes against
  // connect/disconnect; the config lock is taken by `updateConfig`, which
  // reloads the file under it, so a disconnect that won the channel lock cannot
  // be undone here by writing back a key read earlier.
  return withX402ChannelLock(async () => {
    const { previous } = await updateConfig({
      reason: "x402_wallet_repin",
      patch: (current) => {
        if (!current) throw new DvmError("no_config", "No config found.", "Run: dvm init");
        const privateKey = current.x402?.privateKey;
        if (privateKey === undefined) throw x402WalletMissingError();
        if (!isValidEvmPrivateKey(privateKey)) throw invalidX402PrivateKey();
        return { set: { x402: { privateKey, network } } };
      },
    });

    const stored = previous?.x402;
    if (stored === undefined) throw x402WalletMissingError();
    if (!isValidEvmPrivateKey(stored.privateKey)) throw invalidX402PrivateKey();
    const { privateKeyToAccount } = await import("viem/accounts");
    return {
      address: privateKeyToAccount(stored.privateKey).address,
      previousNetwork: stored.network ?? X402_DEFAULT_NETWORK,
      network,
    };
  });
}

/**
 * Persist the caller's x402 keypair, optionally pinned to a chain.
 *
 * The chain is validated here rather than at the call site because this is the
 * only door into config: an unsupported chain persists silently and then shows
 * up as a balance read that fails, which reads like a broken wallet rather
 * than a bad flag.
 *
 * An omitted `network` keeps whatever chain was already configured.
 * Re-connecting is how a caller rotates a key, and writing `undefined` over the
 * pinned chain moved them to Base with no warning — the CLI carried on reading
 * balances and signing on a chain they never chose.
 */
export async function saveX402Wallet(
  privateKey: string,
  network?: string
): Promise<X402ConnectedWallet> {
  if (network !== undefined) assertSupportedX402Network(network);
  if (!isValidEvmPrivateKey(privateKey)) throw invalidX402PrivateKey();
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(privateKey);
  let resolved: string | undefined;
  await updateConfig({
    reason: "x402_wallet_connect",
    patch: (current) => {
      resolved = network ?? current?.x402?.network;
      return {
        set: { x402: resolved === undefined ? { privateKey } : { privateKey, network: resolved } },
      };
    },
  });
  // A fresh connect still persists an unpinned wallet, so `loadX402Wallet`'s own
  // default stays the read-side backstop; the caller is told the chain it will
  // actually pay on rather than recomputing that default a second time.
  return { address: account.address, network: resolved ?? X402_DEFAULT_NETWORK };
}

/**
 * Take the x402 signing key off this machine.
 *
 * The one path entitled to remove it, so it is the one that names the field
 * and the rollback generation retained by the same write is
 * written without it, so `config.json.bak` cannot resurrect a key the caller
 * just disconnected.
 */
export async function removeX402Wallet(): Promise<void> {
  await updateConfig({
    reason: "x402_wallet_disconnect",
    authorize: authorizeProtectedRemoval("x402"),
    patch: () => ({ unset: ["x402"] }),
  });
}

function invalidX402PrivateKey(): DvmError {
  return new DvmError(
    "invalid_key",
    "Invalid secp256k1 private key.",
    "Reconnect with `dvm wallet x402-connect --key-file <path>`, set DVM_X402_KEY, or pipe a valid 0x-prefixed 32-byte secp256k1 private key through stdin."
  );
}

/** The shared refusal for a command that needs a connected x402 wallet. */
function x402WalletMissingError(): DvmError {
  return new DvmError(
    "x402_wallet_missing",
    "No x402 wallet is connected.",
    "Run 'dvm wallet x402-connect' to create one, or add --key-file <path> to import a key you already hold."
  );
}