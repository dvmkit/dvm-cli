import { DvmError } from "@dvmkit/sdk/internal";
/** Rendering stays separate from data-only probes; status and recovery hints share this vocabulary. */

import { probeRailLabel, railLabelAtSentenceStart } from "./rail-labels";
import type {
  RailProbe,
} from "./wallet-probe";
type ProbeRail = RailProbe["rail"];

/**
 * ` via <endpoint>` for a balance a rail read over RPC, else `""`.
 *
 * Sits directly against the amount wherever one is rendered, because the point
 * is provenance: this number came from *here*. An endpoint pointed at the
 * wrong chain answers with a plausible $0.00 and nothing else says so.
 */
export function rpcEndpointSuffix(rail: RailProbe): string {
  const url = rail.details?.rpc_url;
  return typeof url === "string" && url.length > 0 ? ` via ${url}` : "";
}

/**
 * The `--human` line naming the endpoint a balance was read from, and which
 * knob put it there — the caller's own override, or the bundled default. Null
 * for a rail that read no endpoint.
 */
export function rpcEndpointLine(rail: RailProbe): string | null {
  const url = rail.details?.rpc_url;
  if (typeof url !== "string" || url.length === 0) return null;
  const source = rail.details?.rpc_source === "override" ? rpcOverrideEnvVar(rail.rail) : null;
  return `read from ${url} (${source ?? "bundled default"})`;
}

/** Unsupported chains need configuration changes rather than an unreachable-RPC diagnosis. */
export function unreachableRailDisplay(rail: RailProbe): string {
  if (rail.error?.code === "x402_unsupported_network") {
    const network = rail.details?.network;
    return typeof network === "string"
      ? `x402 rail is configured for ${network}, a chain it can't settle on.`
      : "x402 rail is configured for a chain it can't settle on.";
  }
  return (
    nwcRejectionDisplay(rail) ??
    `${railLabelAtSentenceStart(probeRailLabel(rail.rail))} rail is configured but not reachable.`
  );
}

/** Revoked connections need replacement; restricted connections need permission or budget changes. */
export function nwcRejectionDisplay(rail: RailProbe): string | null {
  switch (rail.error?.code) {
    case "float_unauthorized":
      return "The Lightning wallet no longer recognises this connection — it looks revoked or expired.";
    case "float_connection_restricted":
      return "The Lightning wallet recognises this connection but won't let it do what the agent needs.";
    default:
      return null;
  }
}

/**
 * The remedy for an unreachable rail. A probe that diagnosed the failure
 * itself carries its own hint; the per-rail default is what to try
 * when all we know is that the rail didn't answer.
 */
export function unreachableRailHint(rail: RailProbe): string {
  if (rail.error?.hint) return rail.error.hint;
  switch (rail.rail) {
    case "lightning":
      return "Re-run 'dvm wallet connect' with the connection string piped in.";
    case "cashu":
      return "Check mint health with 'dvm wallet mint-health'.";
    case "x402":
      // A slow rate-limited public endpoint trips the probe timeout, which
      // carries no DvmError — so the generic remedy names the override too,
      // or that case still reads as a broken install.
      return "Check DVM_X402_RPC_URL, or ensure viem is installed.";
    case "tempo":
      // A usable key is already connected here; reimporting it does not repair a failed RPC read.
      return "Check DVM_TEMPO_RPC_URL, or ensure viem is installed.";
  }
}

/**
 * Key-import hints use a file or environment variable rather than a positional spending key.
 * Replacing an already connected key requires --force so the suggested command can run.
 */
export function tempoKeyImportRoutes(opts: { replacingConnectedKey: boolean }): string {
  const force = opts.replacingConnectedKey ? " --force" : "";
  return `'dvm wallet tempo-connect --key-file <path>${force}', or DVM_TEMPO_KEY=<key> dvm wallet tempo-connect${force}`;
}

/** With no connected key to replace, the exit recovery hint omits --force. */
export const TEMPO_EXIT_KEY_MISSING_HINT = `Reconnect that exact key (${tempoKeyImportRoutes({ replacingConnectedKey: false })}) before attempting an on-chain exit.`;

function rpcOverrideEnvVar(rail: ProbeRail): string | null {
  switch (rail) {
    case "x402":
      return "DVM_X402_RPC_URL";
    case "tempo":
      return "DVM_TEMPO_RPC_URL";
    default:
      return null;
  }
}

/** SDK exit guards provide facts; key import commands belong to the caller. */
export function tempoExitRecoveryError(error: DvmError, connected: boolean): DvmError {
  let hint: string;
  if (error.code === "tempo_wallet_mismatch") {
    hint = `Reconnect the key that opened this channel (${tempoKeyImportRoutes({ replacingConnectedKey: true })}), or use --abandon to retire this other wallet's local record without reading the chain or broadcasting.`;
  } else if (error.code === "tempo_wallet_missing") {
    hint = TEMPO_EXIT_KEY_MISSING_HINT;
  } else if (error.code === "tempo_channel_on_chain" && !connected) {
    hint = `Reconnect the key that opened this channel (${tempoKeyImportRoutes({ replacingConnectedKey: false })}) before attempting an on-chain exit.`;
  } else {
    return error;
  }
  return new DvmError(error.code, error.message, hint, error.data, error.display);
}
