import { DvmError, formatUsd, isValidEvmPrivateKey, maxAdvertisedMicro, tempoChallengeAmountMicro, withinAdvertisedTolerance, type MppxChallenge, type MppxCredential } from "@dvmkit/sdk/internal";
import { costAnchor } from "../currency";
import { info } from "../output";

export interface BuildTempoCredentialArgs {
  /** mppx challenges from the DVM (one per advertised method/intent). */
  challenges: readonly MppxChallenge[];
  /** 0x-prefixed 32-byte hex private key for the Tempo EVM account. */
  privateKey: string;
  /**
   * What the caller believes it is buying, in USD micro-units — the quoted
   * price, the funding amount, the mid-job ask. Required: the challenge amount
   * is signed verbatim, so without a basis there is nothing to refuse an
   * over-advertisement against, and every local cap would have been applied to
   * a figure the wallet never signs.
   */
  basisMicro: number;
  /**
   * When `"throw"`, surfaces failures as `DvmError(...)`; when `"null"`
   * (mid-job default), logs the failure via `info(...)` and returns null so the
   * responder falls through to `needs-approval`.
   */
  onError?: "throw" | "null";
}

/**
 * Select the Tempo charge challenge from {@link BuildTempoCredentialArgs.challenges}
 * (if any), refuse an amount the caller never agreed to, then build a
 * credential against it and return the structured `Credential.Credential`.
 * Returns null when no Tempo challenge is offered OR the credential build fails
 * and `onError !== "throw"`.
 */
export async function buildTempoCredential(
  args: BuildTempoCredentialArgs
): Promise<MppxCredential | null> {
  const mode = args.onError ?? "null";
  const challenge = args.challenges.find((c) => c.method === "tempo" && c.intent === "charge");
  if (!challenge) return null;

  if (!isValidEvmPrivateKey(args.privateKey)) {
    return fail(mode, {
      code: "tempo_credential_failed",
      message: "tempo wallet apiKey is missing or not a valid secp256k1 private key",
      hint: "Reconnect with `dvm wallet tempo-connect --key-file <path>`, or `DVM_TEMPO_KEY=<key> dvm wallet tempo-connect` — routes that keep the key out of shell history and ps, unlike `--api-key`. Or regenerate via `dvm wallet fund $X --rail tempo`.",
    });
  }

  // Before the signature, not after: an mppx credential is single-use spend
  // authority, so a refusal that arrives once it exists is a refusal that came
  // too late to be worth anything.
  const refusal = amountRefusal(challenge, args.basisMicro);
  if (refusal) return fail(mode, refusal);

  try {
    const [{ tempo }, { Credential }, { privateKeyToAccount }] = await Promise.all([
      import("mppx/client"),
      import("mppx"),
      import("viem/accounts"),
    ]);
    const account = privateKeyToAccount(args.privateKey);
    const method = tempo.charge({ account });
    // mppx's createCredential is precisely typed per method; our wire-side
    // challenges are the open union, so cast at the call boundary.
    const serialized = await method.createCredential({
      challenge: challenge as Parameters<typeof method.createCredential>[0]["challenge"],
      context: { account },
    });
    return Credential.deserialize(serialized);
  } catch (err) {
    return fail(mode, {
      code: "tempo_credential_failed",
      message: `tempo credential construction failed — ${err instanceof Error ? err.message : String(err)}`,
      hint: "Verify viem version + Tempo RPC reachability.",
    });
  }
}

interface TempoRefusal {
  code: string;
  message: string;
  hint: string;
  data?: Record<string, unknown>;
}

/**
 * Refuse a challenge whose amount is unreadable, or more than the shared
 * stablecoin tolerance above what the caller thinks it is buying. `undefined`
 * when the advertisement is close enough to sign.
 */
function amountRefusal(challenge: MppxChallenge, basisMicro: number): TempoRefusal | undefined {
  let advertised: bigint;
  try {
    advertised = tempoChallengeAmountMicro(challenge);
  } catch (err) {
    if (!(err instanceof DvmError)) throw err;
    return { code: err.code, message: err.message, hint: err.hint ?? "" };
  }

  const local = BigInt(Math.max(0, Math.round(basisMicro)));
  if (withinAdvertisedTolerance(advertised, local)) return undefined;

  const advertisedUsd = Number(advertised) / 1e6;
  const localUsd = Number(local) / 1e6;
  return {
    code: "tempo_amount_exceeds_limit",
    message: `The DVM's Tempo charge ($${formatUsd(advertisedUsd)}) is more than 10% above the caller's local price ($${formatUsd(localUsd)}).`,
    hint: "Nothing was signed. Refresh the quote or ask the DVM operator to check its BTC/USD rate.",
    data: {
      advertised_usdc_microunits: advertised.toString(),
      local_usdc_microunits: local.toString(),
      max_usdc_microunits: maxAdvertisedMicro(local).toString(),
      anchor: costAnchor(advertisedUsd),
      display: `Payment refused: $${formatUsd(advertisedUsd)} exceeds the 10% safety margin over the caller's $${formatUsd(localUsd)} estimate.`,
    },
  };
}

function fail(mode: "throw" | "null", refusal: TempoRefusal): null {
  if (mode === "throw") {
    throw new DvmError(refusal.code, refusal.message, refusal.hint, refusal.data);
  }
  // Real money is at stake — log so the operator sees the failure mode
  // rather than discovering a silent fall-through to needs-approval.
  info(`Tempo: ${refusal.message}`);
  return null;
}
