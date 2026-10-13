import {
  DvmError,
} from "@dvmkit/sdk/internal";
import {
  info,
} from "./output";

import { defaultQrImagePath, renderQrPng, renderQrTerminal } from "./qr";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface FundingRelayInstruction {
  copy_text: string;
  /** Whether the value must be relayed outside surrounding prose. */
  standalone: true;
}

export interface StablecoinFundingHandoff {
  address: string;
  /** Exact bytes encoded by both terminal and PNG QRs. */
  qrPayload: string;
  /** PNG path, present for JSON output and explicit human overrides. */
  qrImagePath?: string;
  /** Terminal QR, present only for human output. */
  terminalQr?: string;
  /** Machine-readable standalone-copy instruction. */
  relay: FundingRelayInstruction;
  /** Inspectable ERC-681 URI when the command knows an amount. */
  erc681Uri?: string;
}

export interface PrepareStablecoinHandoffOptions {
  address: string;
  /** Rail name used only to make the default temporary filename discoverable. */
  rail: "tempo" | "x402";
  human: boolean;
  /** Explicit PNG destination. Human output writes no PNG when omitted. */
  qrImagePath?: string;
  /** Inspectable ERC-681 URI; raw address remains the QR fallback until verified. */
  erc681Uri?: string;
}

export interface StablecoinFundingHandoffJson {
  address: string;
  /** Exact payload encoded in the QR. */
  qr_payload: string;
  /** PNG artifact an agent can attach separately. */
  qr_image_path: string;
  /** Standalone-copy instruction for the recipient. */
  relay: FundingRelayInstruction;
  /** Inspectable ERC-681 URI when an amount is known. */
  erc681_uri?: string;
}

/** A positive stablecoin amount represented without floating-point rounding. */
export interface StablecoinAmount {
  usd: number;
  /** Exact six-decimal token base units. */
  atomic: bigint;
}

/**
 * Prepare one stablecoin handoff. Stablecoin QRs deliberately encode the raw
 * address until a target wallet has been verified with the ERC-681 form.
 */
export async function prepareStablecoinFundingHandoff(
  opts: PrepareStablecoinHandoffOptions
): Promise<StablecoinFundingHandoff> {
  assertEvmAddress(opts.address, "recipient address");
  const qrPayload = opts.address;
  const qrImagePath = opts.human
    ? opts.qrImagePath
    : (opts.qrImagePath ?? defaultQrImagePath(`dvm-wallet-${opts.rail}`));

  try {
    const [terminalQr] = await Promise.all([
      opts.human ? renderQrTerminal(qrPayload) : Promise.resolve(undefined),
      qrImagePath ? renderQrPng(qrPayload, qrImagePath) : Promise.resolve(),
    ]);
    return {
      address: opts.address,
      qrPayload,
      ...(qrImagePath ? { qrImagePath } : {}),
      ...(terminalQr ? { terminalQr } : {}),
      relay: { copy_text: opts.address, standalone: true },
      ...(opts.erc681Uri ? { erc681Uri: opts.erc681Uri } : {}),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new DvmError(
      "qr_render_failed",
      `Failed to render the ${opts.rail} funding QR${qrImagePath ? ` at ${qrImagePath}` : ""}: ${detail}`,
      qrImagePath
        ? "Check that the path is writable, or omit --qr-image to use a temporary PNG path."
        : "Retry the command; no usable QR handoff was produced."
    );
  }
}

/** Return the stable machine fields for a prepared JSON-mode handoff. */
export function stablecoinFundingHandoffJson(
  handoff: StablecoinFundingHandoff
): StablecoinFundingHandoffJson {
  if (!handoff.qrImagePath) {
    throw new DvmError(
      "qr_render_failed",
      "The stablecoin funding QR PNG was not produced.",
      "Retry without --human so the command can create an agent-relay PNG."
    );
  }
  return {
    address: handoff.address,
    qr_payload: handoff.qrPayload,
    qr_image_path: handoff.qrImagePath,
    relay: handoff.relay,
    ...(handoff.erc681Uri ? { erc681_uri: handoff.erc681Uri } : {}),
  };
}

/** Print the exact address alone, followed by its terminal QR and optional PNG path. */
export function printStablecoinFundingHandoff(handoff: StablecoinFundingHandoff): void {
  if (!handoff.terminalQr) {
    throw new DvmError(
      "qr_render_failed",
      "The terminal funding QR was not produced.",
      "Retry the command without --human to create an agent-relay PNG instead."
    );
  }
  info("");
  info(handoff.address);
  info("");
  info(handoff.terminalQr);
  if (handoff.qrImagePath) info(`QR PNG written to ${handoff.qrImagePath}`);
}

/** Build an ERC-681 ERC-20 `transfer` URI with an atomic token amount. */
export function buildErc681TokenTransferUri(args: {
  chainId: number;
  token: string;
  recipient: string;
  atomicAmount: bigint;
}): string {
  assertEvmAddress(args.token, "token contract");
  assertEvmAddress(args.recipient, "recipient address");
  if (!Number.isSafeInteger(args.chainId) || args.chainId <= 0) {
    throw new DvmError("invalid_chain_id", `Invalid ERC-681 chain ID: ${String(args.chainId)}.`);
  }
  if (args.atomicAmount <= 0n) {
    throw new DvmError("invalid_amount", "ERC-681 token amount must be positive.");
  }
  return `ethereum:${args.token}@${String(args.chainId)}/transfer?address=${args.recipient}&uint256=${args.atomicAmount.toString()}`;
}

/** Parse a `$2`, `2`, or `0.50` stablecoin amount into six-decimal base units. */
export function parseStablecoinAmount(raw: string): StablecoinAmount {
  const match = /^\$?(\d+)(?:\.(\d{1,6}))?$/.exec(raw.trim());
  if (!match) throw invalidStablecoinAmount(raw);
  const whole = BigInt(match[1]);
  const fraction = BigInt((match.at(2) ?? "").padEnd(6, "0"));
  const atomic = whole * 1_000_000n + fraction;
  if (atomic <= 0n || atomic > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidStablecoinAmount(raw);
  return { usd: Number(atomic) / 1_000_000, atomic };
}

function assertEvmAddress(value: string, label: string): void {
  if (EVM_ADDRESS.test(value)) return;
  throw new DvmError(
    "invalid_address",
    `Invalid ${label}: expected a 20-byte 0x-prefixed EVM address.`,
    "Use the exact public recipient address. Never supply a private key or mnemonic."
  );
}

function invalidStablecoinAmount(raw: string): DvmError {
  return new DvmError(
    "invalid_amount",
    `Invalid stablecoin amount: "${raw}".`,
    "Pass a positive dollar amount with at most six decimal places, e.g. '$5'."
  );
}
