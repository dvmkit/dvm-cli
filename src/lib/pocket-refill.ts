/**
 * Healthy-moment refill for the agent's ecash pocket (spec §8).
 *
 * The pocket is agent plumbing, never a second human funding step: when the
 * spendable held-ecash balance drops below 25% of the pocket target (default
 * $5, `config.json#credit.pocketTarget`), the connected Lightning float pays a
 * mint invoice under the NWC cap and the proofs land P2PK-locked — the same
 * flow as `dvm wallet fund`, minus the CLI. Priming happens here, right after
 * a successful job, so the pocket is ready *before* a sub-floor funding needs
 * it rather than after one has already dead-ended.
 *
 * Opportunistic by contract: every failure — no wallet, no float, budget cap,
 * mint outage, rate outage — delays the refill and never surfaces past an
 * `info` line. A crash mid-refill leaves a `PendingMint` the next
 * wallet-touching command's sweep recovers, exactly like the CLI flow.
 */

import {
  assertFloatBudget,
  emitFloatBudgetWarning,
  type Float,
  floatPaymentDisplay,
  loadFloat,
  payViaFloat,
  recordFloatSpend,
} from "./float";
import {
  effectiveFundingMint,
  effectiveMints,
  formatUsd,
  loadAgentWallet,
  microToSats,
  msatsToMicro,
} from "@dvmkit/sdk/internal";
import {
  info,
} from "./output";
import {
  loadConfig,
} from "./identity";
import { fundAgentWallet } from "./wallet-agent/fund";
import { resolveFundMint } from "./wallet-agent/mint-selection";
import { sweepPendingMints } from "./wallet-agent/recovery";
import { needsPocketRefill, pocketTargetMicro } from "./credit-policy";
import { tryResolveBtcUsdRate } from "./btc-rate";

/**
 * Bounded wait for the mint to observe the float's payment. Deliberately far
 * below the CLI flow's default: this runs inline after a job, and a slow mint
 * only delays the refill — the paid quote stays recoverable on the sweep.
 */
const POCKET_REFILL_TIMEOUT_MS = 60_000;

/**
 * Top the ecash pocket back up to target when it is below the low-water mark
 * and a float is connected to pay for it. Never throws.
 */
export async function refillPocketIfLow(opts?: {
  float?: Float | null;
  human?: boolean;
}): Promise<void> {
  try {
    await refill(opts);
  } catch (err) {
    info(
      `Ecash pocket refill skipped (job outcome unaffected): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function refill(opts?: { float?: Float | null; human?: boolean }): Promise<void> {
  const wallet = loadAgentWallet();
  if (!wallet) return;
  // The autonomous flow is float-pays-mint by definition: with no float there
  // is nobody to pay the invoice, and relaying one from a post-job hook would
  // be a human step this path exists to avoid.
  const float = opts?.float === undefined ? loadFloat() : opts.float;
  if (!float) return;

  // Recover any prior crash first — a swept-back pending mint may already put
  // the balance over the mark, and skipping the sweep could double-fund the
  // same low-water reading.
  await sweepPendingMints().catch(() => undefined);

  const fresh = loadAgentWallet() ?? wallet;
  const spendableSats = fresh.proofs
    .filter((p) => p.status === "valid" && p.reserved_for === undefined)
    .reduce((sum, p) => sum + p.amount, 0);

  const rate = (await tryResolveBtcUsdRate())?.rate ?? 0;
  if (rate <= 0) return;
  const balanceMicro = msatsToMicro(spendableSats * 1000, rate);
  const targetMicro = pocketTargetMicro(loadConfig()?.credit ?? undefined);
  if (!needsPocketRefill(balanceMicro, targetMicro)) return;

  const fundSats = microToSats(targetMicro - balanceMicro, rate);
  // Cap check before the mint quote opens — same ordering as every other
  // float spend, so a refusal leaves no pending state behind.
  let btcRate: number;
  try {
    btcRate = await assertFloatBudget(fundSats * 1000);
  } catch (err) {
    info(
      `Ecash pocket refill deferred by the local budget cap: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  const funding = effectiveFundingMint(fresh.mints);
  const selection = await resolveFundMint({
    preferred: funding.url,
    explicit: false,
    configured: effectiveMints(fresh),
    sats: fundSats,
  });
  const mintUrl = selection.url;
  let quoteId: string | undefined;
  const result = await fundAgentWallet(fundSats, {
    mintUrl,
    timeoutMs: POCKET_REFILL_TIMEOUT_MS,
    payInvoice: (invoice, quote) => {
      quoteId = quote.quote;
      emitFloatBudgetWarning({
        float,
        operation: "pocket_refill",
        principalMsats: fundSats * 1000,
        human: opts?.human,
      });
      return payViaFloat({ bolt11: invoice, amountMsats: fundSats * 1000, float });
    },
    onFloatPayment: (payment) => {
      // Same deliberate gap as the CLI flow: a lost-response payment goes
      // unrecorded (under-counts) rather than a never-sent one recorded.
      recordFloatSpend({
        principalMsats: payment.principalMsats,
        routingFeeMsats: payment.routingFeeMsats,
        totalWalletFeeMsats: payment.totalWalletFeeMsats,
        unitemizedWalletFeeMsats: payment.unitemizedWalletFeeMsats,
        walletDebitMsats: payment.walletDebitMsats,
        btcRate,
        reference: quoteId ?? `float:${mintUrl}`,
        counterparty: mintUrl,
        label: `pocket refill · ${mintUrl}`,
      });
    },
  });

  const minted = result.proofs.reduce((sum, p) => sum + p.amount, 0);
  info(
    `Refilled the agent's ecash pocket: ${minted} sats minted at ${mintUrl} from your Lightning wallet ` +
      `(pocket target $${formatUsd(targetMicro / 1_000_000)}). ${result.float_payment ? floatPaymentDisplay(result.float_payment) : ""}`
  );
}
