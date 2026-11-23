import {
  DvmError,
  dvmLocationIdentity,
  listCredits,
  listX402Channels,
  normalizeCreditEndpoint,
  type AttestedDvmIdentity,
} from "@dvmkit/sdk/internal";

export function resolveX402CreditChannel(args: {
  endpoint: string;
  callerPubkey: string;
  creditId: string;
  identity?: AttestedDvmIdentity;
}) {
  const origin = normalizeCreditEndpoint(args.endpoint);
  const candidates = listCredits()
    .filter((credit) => credit.callerPubkey === args.callerPubkey && (
      credit.creditId === args.creditId ||
      credit.siblingCredits?.some((sibling) => sibling.creditId === args.creditId)
    ))
    .map((credit) => {
      const identity = dvmLocationIdentity(credit);
      const aliases = identity && Array.isArray(credit.endpointAliases)
        ? credit.endpointAliases.filter((alias) => typeof alias === "string")
        : [];
      const origins = [credit.endpoint, ...aliases].map(normalizeCreditEndpoint);
      const atOrigin = origins.includes(origin);
      const matchesIdentity = args.identity && identity &&
        identity.dvmId === args.identity.dvmId && identity.builderPubkey === args.identity.builderPubkey;
      return { credit, identity, origins, atOrigin, matchesIdentity };
    });
  const attested = candidates.filter(({ matchesIdentity }) => matchesIdentity);
  const atOrigin = candidates.filter((candidate) => candidate.atOrigin);
  if (attested.length === 0 && args.identity && atOrigin.some(({ identity }) => identity)) {
    throw new DvmError("x402_channel_mismatch", `The current attestation conflicts with the recorded DVM for credit ${args.creditId}.`);
  }
  const credits = attested.length ? attested : atOrigin;
  const match = credits[0];
  const origins = new Set([origin, ...(match?.origins ?? [])]);
  const records = listX402Channels().filter((channel) =>
    channel.callerPubkey === args.callerPubkey && channel.creditId === args.creditId
  );
  const channels = records.filter((channel) => origins.has(normalizeCreditEndpoint(channel.endpoint)));
  if (credits.length > 1 || channels.length > 1) {
    throw new DvmError(
      "x402_channel_ambiguous",
      `More than one local binding matches x402 credit ${args.creditId}.`,
      "Use the credit ID at its recorded origin, or use the channel ID for a timed on-chain withdrawal.",
      { credit_id: args.creditId, channel_ids: channels.map(({ channelId }) => channelId).sort() }
    );
  }
  const recorded = channels[0];
  if (recorded) {
    const recordedOrigin = normalizeCreditEndpoint(recorded.endpoint);
    // SDK channel rows have no identity field. An origin claimed by multiple
    // credit owners cannot attest which owner wrote the row.
    const owners = candidates.filter((candidate) => candidate.origins.includes(recordedOrigin));
    const tied = args.identity
      ? owners.length === 1 && owners[0] === match && match.matchesIdentity
      : recordedOrigin === origin;
    if (!tied) throw missingX402CreditChannel(args.creditId);
  } else if (records.length > 0) {
    throw missingX402CreditChannel(args.creditId);
  }
  return { recorded, credit: match?.credit, identity: match?.identity };
}

export function missingX402CreditChannel(creditId: string) {
  return new DvmError(
    "x402_channel_mismatch",
    `No recorded x402 channel can be attributed to credit ${creditId}.`,
    "Use the credit's original local channel record to retry, or use its channel ID for a timed on-chain withdrawal.",
    { credit_id: creditId }
  );
}
