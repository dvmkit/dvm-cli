import { DvmError } from "@dvmkit/sdk/internal";

/**
 * Validate a caller-pinned Cashu mint against the DVM's advertised
 * allowlist and narrow the spend allowlist to it. Restrict semantics: returns a
 * single-entry list so the spend draws only from the pin — no fallback to
 * another mint. Matching is trailing-slash-insensitive, and the returned entry
 * is the DVM's canonical advertised string (so `selectProofsForSpend`'s
 * `p.mint === mint` filter keeps matching the proofs already on disk).
 *
 * Throws a structured `mint_not_allowed` {@link DvmError} naming the allowed
 * mints when the pin isn't in the advertised allowlist (or the DVM accepts no
 * Cashu mints at all).
 */
export function applyMintPin(advertised: string[], pinnedMint: string): string[] {
  const target = normalizeMintUrl(pinnedMint);
  const match = advertised.find((m) => normalizeMintUrl(m) === target);
  if (!match) {
    const allowed = advertised.length > 0 ? advertised.join(", ") : "(none)";
    const display =
      advertised.length > 0
        ? `The DVM does not accept mint ${pinnedMint}.`
        : `This DVM accepts no Cashu mints, so --mint ${pinnedMint} can't be honoured.`;
    throw new DvmError(
      "mint_not_allowed",
      `Mint ${pinnedMint} is not in this DVM's accepted mints.`,
      `Pin one of the DVM's accepted mints with --mint: ${allowed}.`,
      {
        anchor: "mint_not_allowed",
        display,
        requested_mint: pinnedMint,
        allowed_mints: advertised,
      }
    );
  }
  return [match];
}

function normalizeMintUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
