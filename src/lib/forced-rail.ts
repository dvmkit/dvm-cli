import { DvmError, RAIL_FLAGS, type RailFlag } from "@dvmkit/sdk/internal";

/** Parse an optional exact rail selection without treating an empty value as fallback consent. */
export function parseForcedRail(raw: string | undefined): RailFlag | undefined {
  if (raw === undefined) return undefined;
  const rail = raw.trim().toLowerCase();
  if (!RAIL_FLAGS.includes(rail as RailFlag)) {
    throw new DvmError(
      "invalid_rail",
      `Unknown --rail value: ${raw}`,
      `Supported rails: ${RAIL_FLAGS.join(", ")}.`
    );
  }
  return rail as RailFlag;
}
