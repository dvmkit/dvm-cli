import { X402Asset } from "@dvmkit/sdk/internal";

/**
 * Why a funded-looking x402 wallet reads zero: the rail reads one contract on
 * one chain, and both halves of that are easy to get wrong.
 *
 * Phrased around what the rail does accept rather than around a list of
 * candidate wrong contracts — that covers every wrong-dollar case, including
 * ones that don't exist yet, and needs no maintenance. The confusable ticker
 * is named without its address for the same reason: it's a warning, not a
 * second thing to send money to.
 */
export function x402WrongAssetHint(asset: X402Asset): string {
  const wrongToken = asset.confusable
    ? `Another dollar on ${asset.networkLabel} — ${asset.confusable}, the legacy bridged dollar, or any other stablecoin — is a different contract and will never show up here, however much of it your wallet says you hold.`
    : `Another dollar on ${asset.networkLabel} is a different contract and will never show up here, however much of it your wallet says you hold.`;
  return `This rail reads only ${asset.label} (${asset.address}) on ${asset.networkLabel}. ${wrongToken} USDC on a different chain is invisible here too — this wallet reads ${asset.networkLabel} alone. If you funded the wrong one, swap it to ${asset.label} on ${asset.networkLabel}, or bridge the funds across to ${asset.networkLabel}; either way they land where this rail can spend them.`;
}