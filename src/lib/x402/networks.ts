import { x402NetworkByCaip2, X402_NETWORKS } from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";

/** Name a chain for relayable copy, falling back to its raw CAIP-2 id. */
export function x402NetworkLabel(network: string): string {
  const spec = x402NetworkByCaip2(network);
  return spec ? `${spec.label} (${network})` : network;
}

/**
 * The accepted chains as one printable list — `eip155:8453 (Base), …`.
 *
 * CAIP-2 first because that's what `--network` takes; the label follows so a
 * human reading the relayed error recognises the chain without looking up a
 * number.
 */
export function x402NetworkListForCopy(): string {
  return X402_NETWORKS.map((n) => `${n.caip2} (${n.label})`).join(", ");
}

/**
 * Throw unless `network` is a chain this rail can both pay and read on.
 *
 * Called at connect time, on the way into config — the whole point is that an
 * unsupported chain never gets persisted, because its only later symptom is a
 * balance read that fails and a wallet that reports as broken. Deliberately
 * *not* called on load: a config already carrying an unsupported chain has to
 * stay loadable so `dvm doctor` can diagnose it rather than crash on it.
 */
export function assertSupportedX402Network(network: string): void {
  if (x402NetworkByCaip2(network)) return;
  throw new DvmError(
    "unsupported_network",
    `Unsupported x402 network: ${network}.`,
    `${x402SupportedNetworksHint()} If a wallet is connected, run 'dvm wallet x402-network <caip2>'. For a first connection, pass --network to 'dvm wallet x402-connect'.`
  );
}

/** The one sentence naming what the rail accepts, shared by every surface that has to say it. */
export function x402SupportedNetworksHint(): string {
  return `This rail settles native USDC on: ${x402NetworkListForCopy()}.`;
}