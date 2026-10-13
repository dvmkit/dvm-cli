/**
 * `dvm config reset` and `dvm config rollback` — the two deliberate,
 * confirmation-gated ways to move the caller's whole configuration.
 *
 * Between them they replace the one thing `dvm init --force` used to do, split
 * so that each half states what it destroys. Reset clears *settings* and cannot
 * reach a credential: it refuses outright while a wallet is connected and names
 * the disconnect that owns it. Rollback can remove credentials, because a
 * stored copy taken before a connect simply does not hold them, so it is held
 * to the same standard as a disconnect: it names which credentials would go,
 * runs the liability preflights that rail's own disconnect runs, takes an
 * authorization for exactly those, and leaves the departures in the trail.
 * Neither command prints a value out of a stored copy.
 */

import {
  CONFIG_FILE,
  DvmError,
} from "@dvmkit/sdk/internal";
import {
  authorizeProtectedRemoval,
  type ConfigBackupInfo,
  type ConfigField,
  configSnapshotPath,
  type ConfigSnapshotSlot,
  describeConfigBackup,
  planConfigReset,
  type ProtectedTarget,
} from "../lib/config-mutation";
import {
  type Config,
  type ConfigRollbackPreview,
  loadConfig,
  pinConfigSnapshot,
  previewConfigRollback,
  retireConfigBackup,
  rollbackConfig,
  updateConfig,
} from "../lib/identity";
import {
  info,
  json,
} from "../lib/output";
import { createInterface } from "node:readline";

export interface ConfigResetOptions {
  /** Confirm the clear without a prompt. The agent path — required outside an interactive terminal. */
  yes?: boolean;
  human?: boolean;
}

export interface ConfigRollbackOptions {
  /** Which stored copy to restore: `backup` (the rolling one) or `pinned`. Defaults to `backup`. */
  slot?: string;
  /** Confirm the restore without a prompt. Without it this only reports what would be restored. */
  yes?: boolean;
  human?: boolean;
}

/**
 * Clear caller settings, keeping every credential and the identity selection.
 *
 * The order is the contract. The wallet gate runs first, so a caller with a
 * rail still connected is sent to that rail's disconnect rather than having a
 * reset quietly work around the check that disconnect exists to run. Then the
 * exact fields are named and confirmed. Only then does the state being cleared
 * go into the pinned snapshot — the copy no ordinary command overwrites — and
 * the clear itself runs through the protected gate, so the trail says what left
 * and the rolling copy is authored without it.
 */
export async function configReset(opts: ConfigResetOptions): Promise<void> {
  const config = loadConfig();
  if (!config) throw new DvmError("no_config", "No config found.", "Run: dvm init");

  assertNoConnectedRails(config);
  const plan = planConfigReset(config);

  if (plan.clear.length === 0) {
    const display =
      "There are no caller settings to clear; the configuration is already at its defaults.";
    if (opts.human) {
      info(display);
      return;
    }
    json({
      status: "already_clear",
      applied: false,
      cleared: [],
      preserved: plan.preserved,
      display,
      hint: "Nothing was written. 'dvm doctor' reports what is configured on this machine.",
    });
    return;
  }

  if (!(await confirmReset(plan.clear, plan.preserved, opts))) return;

  // First writer wins on the pin, so a second reset cannot bury the state worth
  // recovering under its own aftermath. When an earlier one is already in the
  // slot this one takes none, and the undo it offers has to be the rolling copy
  // instead: pointing at a pin from some older reset would restore a
  // configuration this caller never asked for.
  const takenNow = await pinConfigSnapshot("config_reset");
  const pinned = takenNow ?? describeConfigBackup("pinned");

  let cleared: ConfigField[] = [];
  const result = await withPinRetiredOnRefusal(takenNow, () =>
    updateConfig({
      reason: "config_reset",
      // Deliberately no `authorize`. The patch below names
      // settings only, so today the grant would be a no-op — and the day a rail
      // is added to the schema without being added to `PROTECTED_CONFIG_FIELDS`
      // and to `CONNECTED_RAILS`, a blanket grant turns the refusal that would
      // have caught it into a silent credential removal. Without one this fails
      // closed with `config_protected_field`.
      //
      // The pin was taken a moment ago and is the survivor of this command, so
      // only the rolling copy is swept.
      sweepSlots: ["backup"],
      patch: (current) => {
        // Re-read under the lock: a rail connected between the gate above and
        // this write must still send the caller to its disconnect.
        if (current) assertNoConnectedRails(current);
        cleared = planConfigReset(current ?? {}).clear;
        return { unset: cleared };
      },
    })
  );

  const undo = takenNow ? "dvm config rollback --slot pinned --yes" : "dvm config rollback --yes";
  const display = `Cleared ${describeFields(cleared)} from your caller settings. Wallet credentials and your signing identity were not touched.`;
  const hint = takenNow
    ? `The configuration as it stood is stored at ${takenNow.path}; '${undo}' puts it back.`
    : `An earlier snapshot already occupies the pinned slot, so this reset took none. What it cleared is in the rolling copy at ${configSnapshotPath("backup")}, which '${undo}' restores until the next command that changes anything replaces it.`;

  if (opts.human) {
    info(display);
    info(hint);
    return;
  }
  json({
    status: "reset",
    applied: true,
    cleared,
    preserved: planConfigReset(result.config).preserved,
    changed: result.changed,
    pinnedSnapshot: snapshotJson(pinned),
    pinnedByThisReset: takenNow !== null,
    undoCommand: undo,
    display,
    hint,
  });
}

/**
 * Restore a stored copy of the configuration over the current one.
 *
 * Without `--yes` this is the inspection, and the inspection has to answer the
 * question a caller actually has: not how big the copy is, but *which
 * credentials it predates*. A rolling copy taken before a wallet was connected
 * does not hold that connection string, so restoring it takes the wallet off
 * the machine as surely as a disconnect would. So the checkpoint names those
 * fields, from {@link previewConfigRollback}, which reads the copy in process
 * and returns names alone. There is still no path from this command to a value
 * inside one.
 *
 * A restore that would remove a credential then goes through everything a
 * removal goes through: the rail's own liability preflight, an authorization
 * naming exactly the fields the caller was shown, and a `removed` entry in the
 * audit trail.
 */
export async function configRollback(opts: ConfigRollbackOptions): Promise<void> {
  const slot = parseSlot(opts.slot);
  const stored = describeConfigBackup(slot);
  if (!stored) {
    throw new DvmError(
      "config_no_rollback",
      `No ${slotLabel(slot)} of the configuration is stored.`,
      slot === "pinned"
        ? `A pinned snapshot is taken by 'dvm config reset', and nothing but an explicit restore removes it. The rolling copy at ${configSnapshotPath("backup")} is written before each ordinary change — try '--slot backup'.`
        : `A rollback copy is written at ${configSnapshotPath("backup")} before each change, so there is one to restore only after a change has been made on this machine.`
    );
  }
  const preview = previewConfigRollback(slot);
  if (!preview) {
    throw new DvmError(
      "config_rollback_corrupt",
      `The stored copy at ${configSnapshotPath(slot)} is not readable as a configuration.`,
      "Nothing was changed. Inspect that file yourself, or remove it and continue with the configuration you have."
    );
  }

  if (!(await confirmRollback(stored, preview, opts))) return;

  // Same order a disconnect uses: prove nothing gets stranded, then remove.
  const { changed, removed } = await withStrandingChecked(preview.removing, () =>
    rollbackConfig("config_rollback", slot, grantFor(preview.removing))
  );

  const display = `Restored the configuration stored at ${stored.path} (taken ${stored.modifiedAt}).${
    removed.length > 0 ? ` ${describeRemoval(removed)} no longer on this machine.` : ""
  }`;
  const hint =
    slot === "pinned"
      ? "That snapshot has been consumed; the configuration it replaced is now the rolling copy, so this restore is itself undoable once with 'dvm config rollback --yes'. Run 'dvm doctor' to check the restored rails."
      : "The configuration it replaced is now the rolling copy, so this restore is itself undoable once. Run 'dvm doctor' to check the restored rails.";

  if (opts.human) {
    info(display);
    info(`Fields changed: ${changed.length === 0 ? "none" : changed.join(", ")}`);
    info(hint);
    return;
  }
  json({
    status: "restored",
    applied: true,
    slot,
    changed,
    removed,
    from: snapshotJson(stored),
    display,
    hint,
  });
}

/**
 * Refuse while any rail is still connected, naming the disconnect that owns it.
 *
 * Reset is not a way round a wallet safety check. Each disconnect runs its own
 * liability preflight — a Tempo channel that still holds collateral, an x402
 * channel with a timed withdrawal in flight — and a reset able to drop the key
 * without them would strand exactly the funds those checks exist to protect.
 */
function assertNoConnectedRails(config: Config): void {
  const connected = CONNECTED_RAILS.filter((rail) => config[rail.field] !== undefined);
  if (connected.length === 0) return;

  const names = joinList(connected.map((rail) => rail.label));
  const verb = connected.length === 1 ? "is" : "are";
  const commands = joinList(connected.map((rail) => `'${rail.command}'`));
  throw new DvmError(
    "config_reset_blocked",
    `${names} ${verb} still connected, so a settings reset would leave the part that matters behind.`,
    `Nothing was written. Disconnect first — ${commands} — then run 'dvm config reset' again. Each disconnect checks for money only that credential can move before it removes it, which is why a reset will not do it for you.`,
    {
      anchor: "config_reset_blocked",
      rails: connected.map((rail) => rail.field),
      commands: connected.map((rail) => rail.command),
    },
    `${names} ${verb} still connected to this machine, and a reset deliberately cannot remove either the connection or the keys. Disconnecting is its own step because each disconnect first checks whether there is money on that rail only this credential can move.`
  );
}

/** The three rails whose credentials a reset must never reach, and who owns removing each. */
const CONNECTED_RAILS: readonly {
  field: "nwcUri" | "tempo" | "x402";
  label: string;
  command: string;
}[] = [
  { field: "nwcUri", label: "a Lightning wallet", command: "dvm wallet disconnect" },
  { field: "tempo", label: "a Tempo wallet", command: "dvm wallet tempo-disconnect" },
  { field: "x402", label: "an x402 wallet", command: "dvm wallet x402-disconnect" },
];

/**
 * Gate the clear on an explicit confirmation that names every field.
 *
 * Interactive humans answer a prompt on stderr, so stdout stays JSON-clean.
 * Everything else — an agent, a pipe, a CI shell — gets the checkpoint: the
 * exact field list, the command that carries it out, and no write. Returning
 * false rather than throwing keeps a checkpoint distinguishable from a refusal.
 */
async function confirmReset(
  fields: readonly ConfigField[],
  preserved: readonly string[],
  opts: ConfigResetOptions
): Promise<boolean> {
  if (opts.yes) return true;

  const consequence = `This clears ${describeFields(fields)}. Wallet credentials and your signing identity are not touched, and the configuration as it stands is stored first so it can be put back.`;

  if (opts.human && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise<string>((reply) => {
      rl.question(`${consequence} Clear them? (y/N) `, (typed) => {
        rl.close();
        reply(typed.trim().toLowerCase());
      });
    });
    if (answer.startsWith("y")) return true;
    throw new DvmError("cancelled", "Reset cancelled.", "Nothing was written.");
  }

  const display = `Ready to clear ${describeFields(fields)} from ${CONFIG_FILE}. Nothing has been changed yet.`;
  if (opts.human) {
    info(display);
    info("Re-run with --yes to carry it out: dvm config reset --yes");
    return false;
  }
  json({
    status: "awaiting_confirmation",
    applied: false,
    cleared: [],
    fields,
    preserved,
    nextCommand: "dvm config reset --yes",
    display,
    hint: `${consequence} Re-run with --yes to carry it out.`,
  });
  return false;
}

/**
 * The same checkpoint for a restore, over the copy's metadata *and* the
 * credentials it turns out not to hold.
 *
 * The second half is the one that decides the answer. "512 bytes, taken on
 * Tuesday" tells a caller nothing about whether restoring it costs them a
 * wallet; "this copy predates your x402 key" tells them exactly that.
 */
async function confirmRollback(
  stored: ConfigBackupInfo,
  preview: ConfigRollbackPreview,
  opts: ConfigRollbackOptions
): Promise<boolean> {
  const losing =
    preview.removing.length > 0
      ? ` That copy predates ${joinList(preview.removing.map((target) => `\`${target}\``))}, so restoring it takes ${preview.removing.length === 1 ? "that credential" : "those credentials"} off this machine.`
      : "";
  const consequence = `Restoring it replaces every setting and credential currently in ${CONFIG_FILE} with the ones that copy holds.${losing}`;

  if (opts.yes) return true;

  if (opts.human && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise<string>((reply) => {
      rl.question(`${consequence} Restore it? (y/N) `, (typed) => {
        rl.close();
        reply(typed.trim().toLowerCase());
      });
    });
    if (answer.startsWith("y")) return true;
    throw new DvmError("cancelled", "Rollback cancelled.", "Nothing was written.");
  }

  const display = `A ${slotLabel(stored.slot)} of your configuration was stored ${stored.modifiedAt} at ${stored.path} (${stored.bytes} bytes).${losing} Nothing has been changed yet.`;
  if (opts.human) {
    info(display);
    info(`Re-run with --yes to restore it: dvm config rollback --slot ${stored.slot} --yes`);
    return false;
  }
  json({
    status: "awaiting_confirmation",
    applied: false,
    slot: stored.slot,
    removing: preview.removing,
    changed: preview.changed,
    from: snapshotJson(stored),
    nextCommand: `dvm config rollback --slot ${stored.slot} --yes`,
    display,
    hint: `${consequence} Its contents are never printed: it holds the same wallet credentials the live configuration does. Re-run with --yes to restore it.`,
  });
  return false;
}

/**
 * Run the liability preflight that stands between each departing credential and
 * money only it can move.
 *
 * Exactly the checks the owning disconnect runs, in the same order and inside
 * the same lock, because a restore that drops a key is that disconnect by
 * another name. Skipping them would leave an open channel's balance behind a
 * timed exit nobody holds the key for. The imports are dynamic so the common
 * case — a restore that removes nothing — never pays for the chain-reading
 * modules.
 */
async function withStrandingChecked<T>(
  removing: readonly ProtectedTarget[],
  commit: () => Promise<T>
): Promise<T> {
  const leaving = new Set(removing.map((target) => target.split(".")[0]));

  if (leaving.has("tempo")) {
    const { assertTempoWalletIdle } = await import("../lib/payment-rails/tempo-lifecycle");
    await assertTempoWalletIdle("disconnect");
  }
  if (!leaving.has("x402")) return commit();

  const { withX402ChannelLock, listPendingX402Fundings, x402PendingUnsettled } =
    await import("@dvmkit/sdk/internal");
  const { assertX402WalletIdle } = await import("../lib/x402/lifecycle");
  const { ensureAddress } = await import("@dvmkit/sdk/internal");
  const { loadX402Wallet } = await import("../lib/x402/wallet");
  // Channel lock outside, config lock inside — the tree-wide order that keeps
  // the config lock innermost, and what stops a funding signing a voucher
  // between the check and the moment the key it signed with stops being the
  // configured one.
  return withX402ChannelLock(async () => {
    const unsettled = listPendingX402Fundings().filter((entry) => x402PendingUnsettled(entry));
    if (unsettled.length > 0) {
      throw new DvmError(
        "x402_pending_fundings",
        `Restoring that copy would drop the x402 key while ${unsettled.length === 1 ? "a signed voucher is" : `${unsettled.length} signed vouchers are`} still unacknowledged.`,
        "Nothing was restored. Only this key can settle or exit those channels. Wait for them to settle, or discard the vouchers deliberately with 'dvm wallet x402-clear-pending' first.",
        {
          anchor: "x402_pending_fundings",
          pending: unsettled.length,
        }
      );
    }
    const wallet = loadX402Wallet();
    if (wallet) {
      const addressed = await ensureAddress(wallet);
      await assertX402WalletIdle(
        { address: addressed.address, network: addressed.network },
        "disconnect"
      );
    }
    return commit();
  });
}

/**
 * Authorize exactly the removals the caller was shown, or nothing at all.
 *
 * Naming the targets rather than reaching for a blanket grant is what makes the
 * commit disagree loudly with a preview it no longer matches: if the stored
 * copy changed under us, the gate finds a removal this grant does not name and
 * refuses instead of quietly taking one more credential than was confirmed.
 */
function grantFor(removing: readonly ProtectedTarget[]) {
  if (removing.length === 0) return undefined;
  return authorizeProtectedRemoval(...(removing as [ProtectedTarget, ...ProtectedTarget[]]));
}

/**
 * Take back a pin this command has just written when the change it was taken
 * for does not land.
 *
 * `pinConfigSnapshot` commits in its own lock acquisition, so a rail connected
 * in the window before `updateConfig` re-runs the gate would leave a
 * first-writer-wins snapshot of that plaintext credential behind for good, on a
 * command that refused. A refusal writes nothing, and that has to include this.
 */
async function withPinRetiredOnRefusal<T>(
  takenNow: ConfigBackupInfo | null,
  commit: () => Promise<T>
): Promise<T> {
  try {
    return await commit();
  } catch (err) {
    if (takenNow) await retireConfigBackup("config_reset:refused", "pinned");
    throw err;
  }
}

/** Stat-only view of a stored copy. Deliberately carries no field of the config itself. */
function snapshotJson(stored: ConfigBackupInfo | null): Record<string, unknown> | null {
  if (!stored) return null;
  return {
    path: stored.path,
    slot: stored.slot,
    bytes: stored.bytes,
    modifiedAt: stored.modifiedAt,
    modeOctal: stored.modeOctal,
    ownerOnly: stored.ownerOnly,
  };
}

function parseSlot(slot: string | undefined): ConfigSnapshotSlot {
  if (slot === undefined || slot === "backup") return "backup";
  if (slot === "pinned") return "pinned";
  throw new DvmError(
    "invalid_argument",
    `Unknown rollback slot '${slot}'.`,
    "Pass --slot backup (the rolling copy written before each change) or --slot pinned (the snapshot 'dvm config reset' takes)."
  );
}

function slotLabel(slot: ConfigSnapshotSlot): string {
  return slot === "pinned" ? "pinned snapshot" : "rollback copy";
}

function describeFields(fields: readonly ConfigField[]): string {
  return fields.length === 1
    ? `the '${fields[0]}' setting`
    : `these settings: ${fields.join(", ")}`;
}

function describeRemoval(removed: readonly ProtectedTarget[]): string {
  return `${joinList(removed.map((target) => `\`${target}\``))} ${removed.length === 1 ? "is" : "are"}`;
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
