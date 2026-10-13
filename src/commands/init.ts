import {
  CONFIG_DIR,
  CONFIG_FILE,
  ensureConfigDir,
  repairConfigDirMode,
} from "@dvmkit/sdk/internal";
import {
  type CreditPosture,
  ensureConfig,
  updateConfig,
} from "../lib/identity";
import {
  info,
  json,
} from "../lib/output";
import { DEFAULT_CREDIT_POSTURE } from "../lib/credit-policy";
import { createInterface } from "node:readline";

import { describeExisting, detectSetupState, isPartialSetup } from "../lib/caller-state";
import { DEFAULT_FEEDBACK_POSTURE } from "../lib/feedback-nudges";
import { ensureDefaultIdentity } from "./identity";

export interface InitOptions {
  human?: boolean;
  /**
   * Skip provisioning a default signing identity. Wired via
   * commander's `--no-identity`, so the flag's absence means "yes, provision"
   * (`identity` defaults to `true`).
   */
  identity?: boolean;
  askPosture?: () => Promise<CreditPosture | undefined>;
}

/**
 * Create whatever caller setup is missing, and change nothing that is already
 * there.
 *
 * Every step is additive and separately idempotent: the state directory is
 * created and tightened to 0700, `config.json` is written only when there is no
 * file at all, a default signing identity is generated only when
 * `identities.json` is absent, and the one question setup asks is asked only
 * while it has no answer on record. Running it a second time on a configured
 * machine is a no-op that reports what it found.
 *
 * Settings are cleared by `dvm
 * config reset`, and credentials leave through the disconnect that owns them.
 */
export async function init(opts: InitOptions): Promise<void> {
  const setupState = detectSetupState();

  // Ahead of everything else: every `~/.dvm` created before  is 0755,
  // and re-running `dvm init` is the natural way a user or their agent reaches
  // the repair.
  ensureConfigDir();
  const dirMode = repairConfigDirMode();
  const configDir = {
    path: CONFIG_DIR,
    mode: dirMode.modeOctal,
    repaired: dirMode.repaired,
  };
  if (opts.human && dirMode.repaired) {
    info(
      `Tightened permissions on ${CONFIG_DIR} from ${dirMode.previousModeOctal} to 0700 (owner-only).`
    );
  }

  const { config: existing, created } = await ensureConfig({}, "init");

  // ask the consent question once, so an interactive setup never
  // meets the default cold — and only while there is no answer recorded, so a
  // re-run on a configured machine never asks a caller to restate a choice they
  // already made. Non-interactive and JSON runs write nothing and resolve to
  // `suggest`: the agent path is the primary one, and a prompt it can't see
  // would hang it.
  const posture =
    existing.credit?.posture === undefined
      ? opts.askPosture
        ? await opts.askPosture()
        : await askCreditPosture(opts)
      : undefined;
  if (posture !== undefined) {
    // Field-scoped, so the answer lands on `credit.posture` and touches nothing
    // else in the block — or anywhere else in the file.
    await updateConfig({
      reason: "init_credit_posture",
      patch: (current) => ({ set: { credit: { ...current?.credit, posture } } }),
    });
  }

  const provisioned = opts.identity === false ? null : await ensureDefaultIdentity();
  const creditPosture = existing.credit?.posture ?? posture ?? DEFAULT_CREDIT_POSTURE;
  const feedbackPosture = existing.feedback?.posture ?? DEFAULT_FEEDBACK_POSTURE;

  if (opts.human) {
    if (created && isPartialSetup(setupState)) {
      info(
        `Found existing ${describeExisting(setupState)} in ${CONFIG_DIR}, but no config, identity, or wallet.`
      );
      info("Creating the missing setup files and preserving existing history.");
    }
    info(created ? `Config written to ${CONFIG_FILE}` : `Config already exists at ${CONFIG_FILE}`);
    if (!created) info("Nothing already configured was changed.");
    if (provisioned) {
      info(`Generated a default signing identity (pubkey: ${provisioned.entry.pubkey}).`);
      info("DVMs that require signed requests will recognize you by this key.");
    }
    if (setupState.missing.wallet) {
      info("Next step: run 'dvm wallet setup' to connect a wallet.");
    }
    if (!created) {
      info(
        "To clear your caller settings, run 'dvm config reset'. Wallet credentials leave only through 'dvm wallet disconnect', 'dvm wallet tempo-disconnect' and 'dvm wallet x402-disconnect'."
      );
    }
    return;
  }

  json({
    status: created ? "created" : "exists",
    path: CONFIG_FILE,
    configDir,
    setupState,
    ...(provisioned
      ? { identity: { name: provisioned.name, pubkey: provisioned.entry.pubkey } }
      : {}),
    // Only where there is one. A re-run on a machine that already has a wallet
    // has nothing left to point at, and naming a step that is already done is
    // how an agent ends up walking a caller back through setup.
    ...(setupState.missing.wallet ? { nextStep: "wallet_setup" } : {}),
    // state the posture a zero-config caller now has, so an agent
    // learns the rule at setup rather than from the first suppressed purchase.
    creditPosture,
    // same contract for feedback nudges — on by default, ask-first,
    // and the knob is stated here rather than discovered at the first nudge.
    feedbackPosture,
    display: created
      ? "Local setup is ready. Nothing has been funded yet, so nothing can be spent yet."
      : "Setup was already in place, and this run changed nothing that was already configured.",
    hint: created
      ? "Run 'dvm wallet setup' to connect a wallet before submitting jobs. Prepaid credit is never bought without your say-so: jobs that could use one say so, 'dvm credit fund <dvm>' opens one, and 'dvm credit posture auto' hands that over. Feedback nudges are on by default: high-signal job terminals invite 'dvm feedback', sending waits for your user's yes, and 'dvm feedback --posture auto|off' changes that."
      : "Running 'dvm init' again only adds what is missing. To clear caller settings back to their defaults, run 'dvm config reset'; wallet credentials and the identity selection leave only through 'dvm wallet disconnect', 'dvm wallet tempo-disconnect', 'dvm wallet x402-disconnect' and 'dvm identity use'.",
  });
}

/**
 * The one consent question interactive setup asks.
 *
 * Returns `undefined` — writing nothing, so the default applies — for every
 * non-interactive run: JSON mode, a pipe, a CI shell. `dvm` is driven by agents
 * far more often than by hands, and a prompt an agent can't see is a hang.
 */
async function askCreditPosture(opts: InitOptions): Promise<CreditPosture | undefined> {
  if (!opts.human || !process.stdin.isTTY || !process.stdout.isTTY) return undefined;

  info("");
  info(
    "Some DVMs offer prepaid credit: one payment covers a run of jobs and reduces per-job fees."
  );
  info(
    "By default nothing is bought for you — a job that could have used credit says so, and you fund it yourself."
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question("Buy prepaid credit automatically instead? (y/N) ", (reply) => {
      rl.close();
      resolve(reply);
    });
  });
  const wantsAuto = answer.trim().toLowerCase().startsWith("y");
  info(
    wantsAuto
      ? "Credit will be bought automatically within the trust-tier caps, and every purchase reports its amount, route and reason. Change it any time with 'dvm credit posture suggest'."
      : "Credit stays opt-in per purchase. 'dvm credit fund <dvm>' buys one; 'dvm credit posture auto' hands that over later."
  );
  return wantsAuto ? "auto" : DEFAULT_CREDIT_POSTURE;
}
