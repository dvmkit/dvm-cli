import { isSignableExactRequirement } from "@dvmkit/sdk/internal";
import { randomBytes } from "node:crypto";

import { resolveBtcUsdRate } from "../btc-rate";

import { costAnchor } from "../currency";
import { formatUsd, msatsToUsdc, usdcToMsats } from "@dvmkit/sdk/internal";

import { DvmError } from "@dvmkit/sdk/internal";

import { info } from "../output";

import { X402_EXACT_AUTHORIZATION_TTL_SECONDS } from "@dvmkit/sdk/internal";

import { maxAdvertisedMicro, withinAdvertisedTolerance } from "@dvmkit/sdk/internal";

import { x402NetworkByCaip2 } from "@dvmkit/sdk/internal";

import { buildPaymentRequirements, chainIdFromCaip2, encodePayment, type PaymentPayload, type PaymentPayloadV1, type PaymentPayloadV2, type PaymentRequired, type PaymentRequirementsV2, type ResourceInfo, usdcContractFor, usdcDomainNameFor, usdcDomainVersionFor, X402_V1_VERSION, X402_VERSION, x402NetworkToCaip2, type X402Version } from "@dvmkit/sdk/internal";

import type { X402Wallet } from "@dvmkit/sdk/internal";

import { ensureAddress } from "@dvmkit/sdk/internal";

export interface X402PaymentRequest {
  amountMsats: number;
  /**
   * Exact USDC micro-unit amount advertised by the server's x402
   * `maxAmountRequired`. When present, this is the amount the caller signs;
   * `amountMsats` and `btcRate` only provide the local sanity ceiling and
   * ledger conversion.
   */
  requiredUsdcMicro?: string;
  payTo: string;
  /** CAIP-2 chain id (`eip155:8453`). */
  network: string;

  asset?: string;
  /** Versioned challenge selected from `PAYMENT-REQUIRED` or the legacy 402 body. */
  paymentRequired?: PaymentRequired;
  /** Current resource metadata when constructing a v2 payload without a full challenge. */
  resource?: ResourceInfo;
  /** Explicit protocol version for non-HTTP challenges such as mid-job requests. */
  x402Version?: X402Version;
  /**
   * Server-issued EIP-3009 `bytes32` nonce (0x-prefixed 32-byte hex) for the
   * `TransferWithAuthorization` signature. When set, this exact
   * value is signed and embedded in the payload instead of a client-generated
   * one — used by the mid-job responder to honour the per-job binding the
   * server requested. Absent on the upfront path (no job exists yet at
   * challenge-issue time), in which case the client generates its own.
   */
  nonce?: string;
  /**
   * BTC/USD rate the caller already resolved for this spend. It prices the
   * local safety ceiling and converts the signed USDC amount back to msats for
   * the budget ledger. Omit (or pass 0) and the rate is resolved here instead.
   */
  btcRate?: number;
}

export interface X402PaymentProof {
  /** Base64-encoded payment payload for the selected protocol header. */
  paymentHeader: string;
  /** Protocol version that selects `PAYMENT-SIGNATURE` (v2) or `X-PAYMENT` (v1). */
  x402Version: X402Version;
  /** Exact USDC micro-unit amount carried by the signed authorization. */
  amountUsdcMicro: string;
  /** Signed amount converted to msats at the caller's safety-check rate. */
  amountMsats: number;
  /** BTC/USD rate used for the safety check and ledger conversion. */
  btcRate: number;
}

/**
 * Signs the selected USDC amount and returns a v1 or v2 payment header. Refuses
 * malformed or excessive advertisements before signing. Unsupported networks
 * or an unavailable BTC/USD rate return null for rail fallback; build failures
 * have a typed error. A cached rate can price the ceiling and budget ledger.
 */
export async function tryX402Payment(
  request: X402PaymentRequest,
  wallet: X402Wallet
): Promise<X402PaymentProof | null> {
  const selection = selectPaymentRequirement(request);
  let networkSlug: string;
  let networkCaip2: string;
  let chainId: number;
  let usdc: `0x${string}` | undefined;
  try {
    networkCaip2 = x402NetworkToCaip2(selection.network);
    const mapped = x402NetworkByCaip2(networkCaip2);
    networkSlug = mapped?.slug ?? selection.network;
    chainId = chainIdFromCaip2(networkCaip2);
    usdc = usdcContractFor(networkSlug);
  } catch (err) {
    throw new DvmError(
      "x402_build_failed",
      `Could not resolve x402 network from '${selection.network}': ${err instanceof Error ? err.message : String(err)}`,
      "Check that the DVM's advertised x402.network is a CAIP-2 chain id (e.g. 'eip155:8453' for Base)."
    );
  }
  // Unknown chains are a soft-fall-through, not an error — the local wallet
  // may not cover every chain the DVM advertises, and the caller should be
  // free to try another rail.
  if (!usdc) return null;

  const rate = await priceableRate(request.btcRate);
  // No BTC/USD rate means the caller cannot bound the advertised amount.
  if (rate === null) return null;

  const localUsdcMicro = BigInt(msatsToUsdc(request.amountMsats, rate));
  const requiredUsdcMicro = resolveRequiredUsdcMicro(selection.amount, localUsdcMicro);
  const signedAmountMsats = usdcToMsats(Number(requiredUsdcMicro) / 1e6, rate);

  try {
    const w = await ensureAddress(wallet);
    const validAfter = 0n;
    const validBefore = BigInt(
      Math.floor(Date.now() / 1000) + X402_EXACT_AUTHORIZATION_TTL_SECONDS
    );
    const nonce = request.nonce ?? `0x${randomBytes(32).toString("hex")}`;

    const domainName =
      selectedDomainField(selection.accepted?.extra?.name, "name") ??
      usdcDomainNameFor(networkSlug) ??
      "USD Coin";
    const domainVersion =
      selectedDomainField(selection.accepted?.extra?.version, "version") ??
      usdcDomainVersionFor(networkSlug) ??
      "2";

    const { signTypedData } = await import("viem/accounts");
    const signature = await signTypedData({
      privateKey: w.privateKey as `0x${string}`,
      domain: {
        name: domainName,
        version: domainVersion,
        chainId,
        verifyingContract: usdc,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: w.address as `0x${string}`,
        to: selection.payTo as `0x${string}`,
        value: requiredUsdcMicro,
        validAfter,
        validBefore,
        nonce: nonce as `0x${string}`,
      },
    });

    const exactPayload = {
      signature,
      payload: {
        authorization: {
          from: w.address,
          to: selection.payTo,
          value: requiredUsdcMicro.toString(),
          validAfter: validAfter.toString(),
          validBefore: validBefore.toString(),
          nonce,
        },
      },
    };
    const payload: PaymentPayload =
      selection.version === X402_V1_VERSION
        ? ({
            x402Version: X402_V1_VERSION,
            scheme: "exact",
            network: networkSlug,
            payload: { signature: exactPayload.signature, ...exactPayload.payload },
          } satisfies PaymentPayloadV1)
        : ({
            x402Version: X402_VERSION,
            ...(selection.resource ? { resource: selection.resource } : {}),
            accepted:
              selection.accepted ??
              buildPaymentRequirements({
                x402Config: {
                  payTo: selection.payTo,
                  network: networkCaip2,
                  ...(selection.asset ? { asset: selection.asset } : {}),
                },
                requiredUsdcMicro,
                resource: selection.resource?.url ?? "",
                version: X402_VERSION,
              }),
            payload: { signature: exactPayload.signature, ...exactPayload.payload },
            extensions: selection.extensions ?? {},
          } satisfies PaymentPayloadV2);
    return {
      paymentHeader: encodePayment(payload),
      x402Version: selection.version,
      amountUsdcMicro: requiredUsdcMicro.toString(),
      amountMsats: signedAmountMsats,
      btcRate: rate,
    };
  } catch (err) {
    throw new DvmError(
      "x402_build_failed",
      `Failed to build x402 payment: ${err instanceof Error ? err.message : String(err)}`,
      "Check the configured x402 private key and RPC reachability for the target chain."
    );
  }
}

interface SelectedPaymentRequirement {
  version: X402Version;
  network: string;
  amount?: string;
  payTo: string;
  asset?: string;
  accepted?: PaymentRequirementsV2;
  resource?: ResourceInfo;
  extensions?: Record<string, unknown>;
}

function selectPaymentRequirement(request: X402PaymentRequest): SelectedPaymentRequirement {
  const challenge = request.paymentRequired;
  if (challenge?.x402Version === X402_VERSION) {
    const accepted = challenge.accepts.find(isSignableExactRequirement);
    if (!accepted) {
      throw invalidChallenge("The DVM's v2 x402 challenge has no exact EIP-3009 requirement.");
    }
    return {
      version: X402_VERSION,
      network: accepted.network,
      amount: accepted.amount,
      payTo: accepted.payTo,
      asset: accepted.asset,
      accepted,
      resource: challenge.resource,
      extensions: challenge.extensions,
    };
  }
  if (challenge?.x402Version === X402_V1_VERSION) {
    const accepted = challenge.accepts.find((candidate) => candidate.scheme === "exact");
    if (!accepted) throw invalidChallenge("The DVM's v1 x402 challenge has no exact requirement.");
    return {
      version: X402_V1_VERSION,
      network: accepted.network,
      amount: accepted.maxAmountRequired,
      payTo: accepted.payTo,
      asset: accepted.asset,
    };
  }
  return {
    version: request.x402Version ?? X402_V1_VERSION,
    network: request.network,
    amount: request.requiredUsdcMicro,
    payTo: request.payTo,
    asset: request.asset,
    resource: request.resource,
  };
}

function invalidChallenge(message: string): DvmError {
  return new DvmError(
    "x402_build_failed",
    message,
    "Ask the DVM operator to advertise an exact x402 payment requirement."
  );
}

function selectedDomainField(value: unknown, field: string): string | undefined {
  // Absent and explicitly null both mean "unadvertised" per the v2 schema, so
  // both fall through to the network's known USDC domain.
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.length > 0) return value;
  throw invalidChallenge(`The DVM advertised an invalid x402 ${field}.`);
}

function resolveRequiredUsdcMicro(advertised: string | undefined, localUsdcMicro: bigint): bigint {
  if (advertised === undefined) return localUsdcMicro;
  if (!/^[1-9]\d*$/.test(advertised)) {
    throw new DvmError(
      "x402_amount_invalid",
      `The DVM advertised an invalid x402 maxAmountRequired: '${advertised}'.`,
      "Do not sign this payment. Ask the DVM operator to return a positive integer number of USDC micro-units."
    );
  }

  const required = BigInt(advertised);
  if (withinAdvertisedTolerance(required, localUsdcMicro)) return required;

  const advertisedUsd = Number(required) / 1e6;
  const localUsd = Number(localUsdcMicro) / 1e6;
  throw new DvmError(
    "x402_amount_exceeds_limit",
    `The DVM's x402 charge ($${formatUsd(advertisedUsd)} USDC) is more than 10% above the caller's local price ($${formatUsd(localUsd)} USDC).`,
    "The payment was not signed. Refresh the quote or ask the DVM operator to check its BTC/USD rate.",
    {
      advertised_usdc_microunits: required.toString(),
      local_usdc_microunits: localUsdcMicro.toString(),
      max_usdc_microunits: maxAdvertisedMicro(localUsdcMicro).toString(),
      anchor: costAnchor(advertisedUsd),
      display: `Payment refused: $${formatUsd(advertisedUsd)} USDC exceeds the 10% safety margin over the caller's $${formatUsd(localUsd)} USDC estimate.`,
    }
  );
}

/**
 * The BTC/USD rate to check and account for this payload against, or null when
 * there is none — the caller's pre-resolved rate if it has one, else a freshly
 * resolved (or last-cached) one. Kept outside the build `try` so a
 * `rate_unavailable` is answered by skipping the rail, not by re-wrapping it
 * as `x402_build_failed`.
 */
async function priceableRate(btcRate: number | undefined): Promise<number | null> {
  if (btcRate && btcRate > 0) return btcRate;
  try {
    return (await resolveBtcUsdRate("payment")).rate;
  } catch (err) {
    if (err instanceof DvmError && err.code === "rate_unavailable") {
      info(
        "Skipping the x402 rail: it prices in USDC and the BTC/USD rate is unavailable (no cached rate on this machine). Trying the remaining rails."
      );
      return null;
    }
    throw err;
  }
}