/**
 * Teaching the caller's config which hostnames are one DVM.
 *
 * `config.credit.perDvm` is keyed by the origin the caller typed, and a DVM
 * reachable at more than one hostname therefore gets one entry per spelling.
 *  solved the same split for the credit record by stamping the DVM's
 * identity onto it; this is that mechanism applied to hand-edited config, with
 * the two differences config demands: the keys stay readable, and the identity
 * has to be *attested* before one entry may govern another spelling.
 *
 * Lives outside `credit-policy.ts` on purpose — that module is pure, and this
 * one writes. It touches config only: `updateConfig` takes the config lock and
 * `withCreditLock` refuses an async body, so nothing here may run inside a
 * credit-store lock and nothing here reaches for one.
 */
import {
  attestedDvmIdentity,
  type AttestedDvmIdentity,
  type CreditFundRail,
  isCreditFundRail,
  normalizeCreditEndpoint,
  type ProviderInfo,
} from "@dvmkit/sdk/internal";
import {
  type Config,
  type CreditConfig,
  updateConfig,
} from "./identity";

import { buildCreditRailPinConflict, noteCreditRailPinConflict } from "./credit-notice";

/**
 * This DVM's attested identity, as the `/v1/info` already in hand presents it.
 *
 * Memoised per parsed `/v1/info`, because one request resolves a posture, a
 * rail pin and a trust ladder off the same block and each would otherwise pay
 * for the attestation's signature check again.
 */
export function providerDvmIdentity(
  providerInfo: ProviderInfo | undefined
): AttestedDvmIdentity | undefined {
  const builder = providerInfo?.builder;
  if (!builder) return undefined;
  const memo = identityMemo.get(builder);
  if (memo !== undefined) return memo ?? undefined;
  const identity = attestedDvmIdentity(builder);
  identityMemo.set(builder, identity ?? null);
  return identity;
}

type PerDvmEntry = NonNullable<CreditConfig["perDvm"]>[string];

/**
 * Stamp this DVM's attested identity onto the entry keyed at its origin, and
 * clear funding-rail pins that two spellings of it disagree on.
 *
 * Idempotent, and that is what makes the notice a one-time one without a
 * ledger to remember it by: once the pins are gone there is no conflict left
 * to re-announce. A caller who re-pins afterwards is told at the moment they
 * type it — see `creditRail` — rather than silently having it dropped again.
 *
 * Posture is deliberately *not* written back. Two spellings disagreeing on
 * posture resolve most-restrictive on every read, which needs no edit; folding
 * a caller's `auto` into `off` on disk would destroy an intent the read
 * already handles.
 *
 * Best-effort: an unattested DVM, an absent config or a config another process
 * holds the lock on all leave the file untouched. Never throws.
 */
export async function reconcilePerDvmIdentity(args: {
  endpoint: string;
  identity: AttestedDvmIdentity | undefined;
  config: CreditConfig | undefined;
  dvm: string;
  human?: boolean;
}): Promise<void> {
  const identity = args.identity;
  if (!identity) return;
  const key = normalizeCreditEndpoint(args.endpoint);
  const planned = planReconciliation(args.config, key, identity);
  if (!planned) return;

  let committed: CreditConfig | undefined;
  try {
    const result = await updateConfig({
      reason: "credit_dvm_identity",
      patch: (current: Config | null) => {
        // Re-planned against the config as reloaded inside the lock: a snapshot
        // read before it may already be stale.
        const fresh = planReconciliation(current?.credit, key, identity);
        if (!fresh) return {};
        return { set: { credit: { ...(current?.credit ?? {}), perDvm: fresh.perDvm } } };
      },
    });
    committed = result.config.credit;
  } catch {
    // Keying is a convenience, never a gate on the job that triggered it.
    return;
  }
  if (planned.droppedRails) {
    // Dropping the per-DVM pins exposes the layer below rather than the amount
    // rule outright, so the notice names whichever one now decides.
    const global = committed?.fundingRail;
    noteCreditRailPinConflict(
      buildCreditRailPinConflict({
        dvm: args.dvm,
        endpoint: key,
        formerRails: planned.droppedRails.rails,
        endpoints: planned.droppedRails.endpoints,
        ...(isCreditFundRail(global) ? { nowRail: global } : {}),
      }),
      args.human
    );
  }
}


const identityMemo = new WeakMap<object, AttestedDvmIdentity | null>();

interface PlannedReconciliation {
  perDvm: NonNullable<CreditConfig["perDvm"]>;
  droppedRails?: { rails: CreditFundRail[]; endpoints: string[] };
}

function planReconciliation(
  credit: CreditConfig | undefined,
  key: string,
  identity: AttestedDvmIdentity
): PlannedReconciliation | undefined {
  const perDvm = credit?.perDvm;
  if (!perDvm) return undefined;
  const next: Record<string, PerDvmEntry> = {};
  let changed = false;
  for (const [origin, entry] of Object.entries(perDvm)) {
    // Everything the CLI has no opinion about survives: this is the caller's
    // file, and a field a newer build wrote must not vanish through an older
    // one's migration.
    if (normalizeCreditEndpoint(origin) !== key) {
      next[origin] = entry;
      continue;
    }
    const stamped: PerDvmEntry = { ...entry };
    if (stamped.dvmId !== identity.dvmId) {
      stamped.dvmId = identity.dvmId;
      changed = true;
    }
    if (stamped.builderPubkey?.trim().toLowerCase() !== identity.builderPubkey) {
      stamped.builderPubkey = identity.builderPubkey;
      changed = true;
    }
    next[origin] = stamped;
  }

  const siblings = Object.entries(next).filter(
    ([, entry]) =>
      entry.dvmId === identity.dvmId &&
      entry.builderPubkey?.trim().toLowerCase() === identity.builderPubkey
  );
  const pinned = siblings.flatMap(([origin, entry]) =>
    isCreditFundRail(entry.fundingRail) ? [[origin, entry.fundingRail] as const] : []
  );
  const rails = [...new Set(pinned.map(([, rail]) => rail))];
  let droppedRails: PlannedReconciliation["droppedRails"];
  if (rails.length > 1) {
    // Two pins on one DVM is not a pin. Neither can be honoured, so both go and
    // the caller is told what they were.
    droppedRails = { rails, endpoints: pinned.map(([origin]) => origin) };
    for (const [origin] of pinned) {
      const { fundingRail: _dropped, ...rest } = next[origin];
      next[origin] = rest;
    }
    changed = true;
  }
  if (!changed) return undefined;
  return { perDvm: next, ...(droppedRails ? { droppedRails } : {}) };
}
