/**
 * `dvm wallet set-default-rail <rail>` — persist the user's preferred rail for
 * `dvm request` upfront payments. The selector consults this when
 * multiple rails are locally configured AND advertised by the DVM; explicit
 * `--rail` on a call still overrides.
 */

import {
  DvmError,
  RAIL_FLAGS,
  type RailFlag,
} from "@dvmkit/sdk/internal";
import {
  info,
  json,
} from "../lib/output";
import {
  loadConfig,
  updateConfig,
} from "../lib/identity";

const REQUEST_RAIL_SCOPE = "request_upfront_payment";

/** Relayable boundary between request rail choice and prepaid-credit funding. */
const REQUEST_RAIL_HINT =
  "This affects dvm request upfront payments only. Prepaid-credit funding is selected separately and automatically: ecash below a DVM's advertised Lightning floor, a connected Lightning wallet directly when eligible.";

export interface WalletSetDefaultRailOptions {
  human?: boolean;
  clear?: boolean;
}

export async function walletSetDefaultRail(
  rail: string | undefined,
  opts: WalletSetDefaultRailOptions
): Promise<void> {
  const config = loadConfig();
  if (!config) {
    throw new DvmError("no_config", "No config found.", "Run `dvm init` first.");
  }

  if (opts.clear) {
    await updateConfig({
      reason: "wallet_clear_default_rail",
      patch: () => ({ unset: ["defaultRail"] }),
    });
    if (opts.human) {
      info("Per-call request rail cleared. `dvm request` will use the issue-spec order.");
      info(REQUEST_RAIL_HINT);
    } else {
      json({
        status: "cleared",
        scope: REQUEST_RAIL_SCOPE,
        display: "Per-call request rail cleared.",
        hint: `${REQUEST_RAIL_HINT} Pass \`--rail <rail>\` per call, or set a new request rail with \`dvm wallet set-default-rail <rail>\`.`,
      });
    }
    return;
  }

  if (!rail) {
    throw new DvmError(
      "missing_rail",
      "Missing rail argument.",
      `Pass one of: ${RAIL_FLAGS.join(", ")}. Or pass --clear to clear the existing default.`
    );
  }

  if (!RAIL_FLAGS.includes(rail as RailFlag)) {
    throw new DvmError(
      "invalid_rail",
      `Unknown rail: ${rail}.`,
      `Supported rails: ${RAIL_FLAGS.join(", ")}.`
    );
  }

  await updateConfig({
    reason: "wallet_set_default_rail",
    patch: () => ({ set: { defaultRail: rail as RailFlag } }),
  });

  if (opts.human) {
    info(`Per-call request rail set to ${rail}.`);
    info(REQUEST_RAIL_HINT);
    info("Override per call with `--rail <rail>`.");
  } else {
    json({
      status: "set",
      default_rail: rail,
      scope: REQUEST_RAIL_SCOPE,
      display: `Per-call request rail: ${rail}.`,
      hint: `${REQUEST_RAIL_HINT} Pass \`--rail <rail>\` per call to override.`,
    });
  }
}
