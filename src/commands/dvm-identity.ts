/**
 * Resolved `(dvmId, capability)` pair threaded through `request` / `quote`
 * dispatch helpers. Held as a struct so callers don't mutate the
 * user-facing `RequestOptions` to plumb resolution results between layers.
 */
export interface DvmIdentity {
  /** Owner-qualified DVM identifier, absent for endpoint-only calls and bare local favorites. */
  dvmId?: string;
  /** Capability name resolved against `/v1/info.capabilities`. */
  capability: string;
}

/**
 * Build the `{ dvm_id, capability, identifier }` identity envelope spread
 * into JSON output by every command that addresses a specific capability.
 * The slash-form `identifier` is only emitted for an
 * owner-qualified reference; endpoint-only calls never fabricate one from
 * provider metadata. `dvm_id` and `capability` are kept separately so callers
 * can branch without re-parsing.
 *
 * All three fields are omitted when their inputs are missing — older job
 * records missing the fields won't synthesise an `identifier`.
 */
export function dvmIdentity(
  dvmId: string | undefined,
  capability: string | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (dvmId) out.dvm_id = dvmId;
  if (capability) out.capability = capability;
  if (dvmId && capability) out.identifier = `${dvmId}/${capability}`;
  return out;
}
