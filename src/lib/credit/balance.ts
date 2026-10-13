
import {
  formatFiat,
} from "@dvmkit/sdk";
import { automaticCreditBoundRail } from "../credit-policy";
import {
  type CreditOpResult,
  type CreditWire,
  DvmError,
  listCredits,
  listImplicitCredits,
  listPendingFundings,
  loadCredit,
  loadImplicitCredits,
  recordBalanceResponse,
  recordFundingMenuSnapshot,
  signDvmRequestData,
  signedRequestDomain,
} from "@dvmkit/sdk/internal";
import {
  loadConfig,
} from "../identity";
import {
  resolveSigningIdentity,
} from "../cli-identity-resolve";
import { pollPendingCreditFundings } from "../credit-fund";
import {
  repeatUseCreditHint,
} from "../credit-guidance";
import {
  headroomJson,
} from "../credit-headroom";
import {
  providerDvmIdentity,
} from "../credit-per-dvm";
import {
  creditDrainCommand,
} from "../credit-reclaim";
import {
  createDvmTransport,
} from "../transport";
import {
  dvmLabelFromEndpoint,
} from "../../commands/wallet-history";
import { renderCreditBalance } from "../../commands/credit/render";
import {
  resolveCreditEndpoint,
  creditOp,
  advisoryBtcRate,
  implicitCreditJson,
  CreditCurrencyTotals,
  currencyTotal,
  sortedCurrencyTotals,
  creditCurrencyTotalsJson,
  currencyTotalsDisplay,
  headroomReader,
  HeadroomReader,
} from "./shared";
import type { CreditBalanceOptions } from "./options";

/**
 * Live signed balance read against one DVM (or every tracked one). Reconciles
 * the local store unless the caller explicitly requests observation-only mode.
 */
export async function runCreditBalance(
  dvm: string | undefined,
  opts: CreditBalanceOptions
): Promise<void> {
  if (opts.creditId && !dvm) {
    throw new DvmError(
      "invalid_argument",
      "--credit-id requires a DVM.",
      "Run 'dvm credit balance <dvm> --credit-id <id>' so the credit is selected at exactly one machine."
    );
  }
  if (opts.selectionOnly && !opts.creditId)
    throw new DvmError("invalid_argument", "--selection-only requires --credit-id.");
  if (opts.selectionOnly && opts.observeOnly)
    throw new DvmError(
      "invalid_argument",
      "--selection-only and --observe-only cannot be combined."
    );
  const signer = resolveSigningIdentity({ as: opts.as, config: loadConfig() });
  const endpoints = dvm
    ? [resolveCreditEndpoint(dvm)]
    : [
        ...new Set([
          ...listCredits().map((c) => c.endpoint),
          ...listImplicitCredits()
            .filter((credit) => credit.callerPubkey === signer.pubkey)
            .map((credit) => credit.endpoint),
          ...listPendingFundings({ callerPubkey: signer.pubkey }).map(
            (funding) => funding.endpoint
          ),
        ]),
      ];

  if (endpoints.length === 0) {
    const message = "No prepaid credits tracked, and no DVM was named.";
    renderCreditBalance({
      human: opts.human === true,
      humanLines: [message, "Pass a DVM to query directly: dvm credit balance <dvm>."],
      json: {
        credits: [],
        count: 0,
        display: message,
        hint: "Pass a DVM (name, @favorite, or URL) to query one directly: 'dvm credit balance <dvm>'.",
      },
    });
    return;
  }

  const transport = createDvmTransport();
  const headroomOf = headroomReader();
  const advisoryRate = advisoryBtcRateOnce();
  const reads: EndpointBalance[] = [];
  try {
    for (const endpoint of endpoints) {
      try {
        reads.push(
          await balanceAt(
            transport,
            endpoint,
            signer,
            headroomOf,
            advisoryRate,
            opts.creditId,
            opts.observeOnly,
            opts.selectionOnly
          )
        );
      } catch (err) {
        // In the no-arg sweep, one unreachable DVM must not abort the whole
        // listing — emit an error row and keep going. A named DVM still
        // throws: the caller asked about exactly that one.
        if (dvm) throw err;
        const label = dvmLabelFromEndpoint(endpoint);
        const message = err instanceof Error ? err.message : String(err);
        reads.push({
          rows: [
            {
              endpoint,
              dvm: label,
              error: err instanceof DvmError ? err.code : "unreachable",
              display: `${label} could not be reached (${message}) — its balance is unknown, not gone.`,
            },
          ],
        });
      }
    }
  } finally {
    transport.close();
  }

  const rows = reads.flatMap((read) => read.rows);
  const machines = reads.map((read) => read.machine).filter((m) => m !== undefined);
  // Only a successful signed balance response demonstrates that this DVM
  // supports credit. A `credit_not_supported` row must not receive guidance
  // that invites the caller to expect a balance it cannot hold.
  const creditHint = machines.length > 0 ? repeatUseCreditHint(dvm ?? "<dvm>") : undefined;
  const totals = wireCreditCurrencyTotals(rows);
  const display =
    rows.length === 0
      ? "No credits held at the queried DVM(s)."
      : totals.length > 0
        ? currencyTotalsDisplay(totals, "server")
        : "No credit balance totals were returned; see the per-DVM rows for details.";
  const humanLines: string[] = [];
  if (rows.length === 0) humanLines.push("No credits held at the queried DVM(s).");
  for (const read of reads) {
    for (const r of read.rows) {
      humanLines.push(`  ${typeof r.display === "string" ? r.display : ""}`);
    }
      // One headroom line per machine, under its rows — the figure describes the
      // DVM, so repeating it per credit would just be the same sentence N times.
    const headroom = read.machine?.headroom as { display?: unknown } | undefined;
    if (typeof headroom?.display === "string") humanLines.push(`    ${headroom.display}`);
  }
  if (rows.length > 0) humanLines.push(`  ${display}`);
  if (creditHint) humanLines.push(`  ${creditHint}`);
  renderCreditBalance({
    human: opts.human === true,
    humanLines,
    json: {
      credits: rows,
      count: rows.length,
      totals_by_currency: totals.map((total) => creditCurrencyTotalsJson(total, "server")),
      dvms: machines,
      display,
      hint: "Balances come from signed server reads or countersigned job receipts. `drawable: true` identifies value job draws can use; every untracked prepaid sibling carries the exact `drain_command` that reclaims it, while `kind: implicit` rows have no drain path. Each entry in `dvms` says what may be funded at that machine now. Expired prepaid credit remains reclaimable; a lost implicit balance does not.",
      ...(creditHint ? { credit_hint: creditHint } : {}),
    },
  });
}

interface EndpointBalance {
  rows: Record<string, unknown>[];
  /**
   * The machine's own entry — its funding headroom, absent when nothing was
   * read (unreachable, or credit not offered here).
   */
  machine?: Record<string, unknown>;
}

async function balanceAt(
  transport: ReturnType<typeof createDvmTransport>,
  endpoint: string,
  signer: { privkey: string; pubkey: string },
  headroomOf: HeadroomReader,
  advisoryRate: () => Promise<number | undefined>,
  creditId?: string,
  observeOnly = false,
  selectionOnly = false
): Promise<EndpointBalance> {
  // Poll the exact persisted `(credit_id, fund_id)` before the generic balance
  // read. A paid invoice then yields its fund response, updates the projection,
  // and retires the pending record without asking the wallet to pay again.
  if (!observeOnly && !selectionOnly) {
    await pollPendingCreditFundings({
      transport,
      ref: { endpoint },
      signing: signer,
    }).catch(() => undefined);
  }

  const providerInfo = await transport.describe({ endpoint }).catch(() => undefined);
  const identity = providerDvmIdentity(providerInfo);
  if (!providerInfo)
    throw new DvmError("provider_unavailable", "Could not read provider metadata.");
  const implicitCredits = loadImplicitCredits(endpoint, signer.pubkey, identity).filter(
    (credit) => !creditId || credit.creditId === creditId
  );
  const signCredit = (body: Record<string, unknown>) =>
    signDvmRequestData(
      signer.privkey,
      body,
      signedRequestDomain({
        provider: providerInfo,
        endpoint,
        method: "POST",
        path: "v1/credit",
        capability: null,
      })
    );
  let result: CreditOpResult;
  try {
    const selected = await creditOp(
      transport,
      endpoint,
      signCredit({
        op: "balance",
        ...(creditId ? { credit_id: creditId } : {}),
      })
    );
    if (!creditId) {
      result = selected;
    } else {
      // The exact read proves this caller owns the requested credit. Follow it
      // with the full live list so adopting that credit keeps every previous
      // row visible as a sibling instead of turning selection into data loss.
      const all = await creditOp(transport, endpoint, signCredit({ op: "balance" }));
      result = {
        ...all,
        ...(selected.credit ? { credit: selected.credit } : {}),
        credits: all.credits ?? selected.credits,
        menu: all.menu ?? selected.menu,
      };
    }
  } catch (err) {
    if (err instanceof DvmError && err.code === "credit_not_supported") {
      const rows = implicitCredits.map(implicitCreditJson);
      return {
        rows:
          rows.length > 0
            ? rows
            : [
                {
                  endpoint,
                  dvm: dvmLabelFromEndpoint(endpoint),
                  supported: false,
                  display: `${dvmLabelFromEndpoint(endpoint)} does not offer prepaid credit and no released per-call balance is tracked locally.`,
                },
              ],
      };
    }
    throw err;
  }

  // Reconcile the local projection from the server's word. Its primary is the
  // normal draw target; an exact caller selection deliberately overrides it.
  const stored = loadCredit(endpoint, signer.pubkey, identity);
  // The menu the server just echoed, else whatever a quote left behind. An
  // absent echo is a pre- server saying nothing, never "no menu here".
  const menu = result.menu ?? stored?.menu;
  // The live description supplies both the audience required to sign this read
  // and the current builder and Cashu offer used for route availability.
  const builderPubkey =
    providerInfo.builder?.pubkey ?? stored?.builderPubkey ?? headroomOf.builderPubkeyAt(endpoint);
  // Persist the exact menu the DVM sent even when it names no credit. A later
  // absent menu is an old server saying nothing, so it never clears this local
  // guidance cache.
  if (result.menu && !observeOnly) {
    recordFundingMenuSnapshot({
      endpoint,
      ...(identity ? { identity } : {}),
      callerPubkey: signer.pubkey,
      menu: result.menu,
      ...(builderPubkey ? { builderPubkey } : {}),
    });
  }
  const credits = result.credits ?? [];
  // `imp:` rows belong only to the receipt-backed namespace. A credit-capable
  // DVM includes them in its live balance response, but adopting one here
  // would give it prepaid refill/drain semantics and leave a second drawable
  // record behind after its receipt-backed row settles to zero.
  const prepaidCredits = credits.filter((credit) => !credit.credit_id.startsWith("imp:"));
  const prepaidPrimary =
    result.credit && !result.credit.credit_id.startsWith("imp:") ? result.credit : undefined;
  const currentStored = observeOnly
    ? stored
    : recordBalanceResponse({
        endpoint,
        ...(identity ? { identity } : {}),
        callerPubkey: signer.pubkey,
        credits: prepaidCredits,
        ...(prepaidPrimary ? { primary: prepaidPrimary } : {}),
        ...(stored ? { targetMicro: stored.targetMicro } : {}),
        // Recorded so a credit adopted through a balance read knows the builder's
        // bounds — otherwise its headroom reads "bounds unknown" forever, which is
        // exactly the question the block exists to answer.
        ...(menu ? { menu } : {}),
        ...(builderPubkey ? { builderPubkey } : {}),
        ...(creditId ? { selectPrimary: true } : {}),
      });
  // `recordFundResponse` can adopt a different credit id and clears the old
  // credit's immutable rail binding when it does. Re-read before diagnosing
  // the effective route so a live balance never carries a stale binding.
  const currentBoundRail = automaticCreditBoundRail(currentStored);
  // The trust cap bounds what this caller has parked at one machine, so it is
  // measured against every credit held there, not one row's balance: implicit
  // N=1 funding mints a credit per paid job, and a per-row figure would let each
  // drawn-down row claim the whole cap over again. Expired balances count — they
  // are still value sitting with that builder, which is what the cap is about.
  const heldMicro = credits
    .filter((credit) => !menu || credit.currency === menu.currency)
    .reduce((sum, credit) => sum + Math.max(credit.remaining_micro, 0), 0);
  // The ecash pocket is denominated in sats, so route availability can only say
  // whether it covers a fiat funding with an advisory rate in hand —
  // which is why this live read, unlike the offline `credit list`, resolves one.
  // Only when the menu names the rail and `describe` answered: this is a network
  // read, and neither a DVM that takes no ecash nor a degraded read that never
  // learned the mint offer can reach a coverage answer for it to inform.
  const btcRate = menu?.funding.includes("cashu") ? await advisoryRate() : undefined;
  const headroom = headroomOf.of({
    endpoint,
    signingPubkey: signer.pubkey,
    balanceMicro: heldMicro,
    ...(menu ? { menu } : {}),
    ...(builderPubkey ? { builderPubkey } : {}),
    providerInfo,
    ...(currentBoundRail ? { boundRail: currentBoundRail } : {}),
    ...(btcRate !== undefined ? { btcRate } : {}),
  });

  const liveIds = new Set(credits.map((credit) => credit.credit_id));
  return {
    rows: [
      ...credits.map((credit) =>
        wireCreditJson(
          endpoint,
          credit,
          credit.credit_id === currentStored?.creditId && currentStored.selectionCleared !== true
        )
      ),
      ...implicitCredits.filter((credit) => !liveIds.has(credit.creditId)).map(implicitCreditJson),
    ],
    // Emitted even when `credits` is empty: the server just stated its menu, so
    // this read answers "what could I open here" without a second round trip.
    machine: {
      endpoint,
      dvm: dvmLabelFromEndpoint(endpoint),
      credit_count: credits.length,
      headroom: headroomJson(headroom),
    },
  };
}

/**
 * The same rate for one balance sweep, resolved at most once however many DVMs
 * the sweep queries, and only if one of them asks for it.
 */
function advisoryBtcRateOnce(): () => Promise<number | undefined> {
  let pending: Promise<number | undefined> | undefined;
  return () => (pending ??= advisoryBtcRate());
}

function wireCreditJson(
  endpoint: string,
  credit: CreditWire,
  tracked: boolean
): Record<string, unknown> {
  const label = dvmLabelFromEndpoint(endpoint);
  const unbacked = credit.status === "unbacked";
  const amount = formatFiat(
    (unbacked ? credit.balance_micro : credit.remaining_micro) / 1_000_000,
    credit.currency
  );
  const state = unbacked
    ? "closed — backing finalized before collection"
    : credit.reconciliation_pending
      ? "backing reconciliation pending"
      : credit.expired
        ? "expired — balance reclaimable"
        : "spendable";
  const command = creditDrainCommand(endpoint, credit.credit_id);
  return {
    endpoint,
    dvm: label,
    ...credit,
    tracked,
    drawable: tracked && !credit.expired && !unbacked && !credit.reconciliation_pending,
    ...(!tracked && credit.drainable ? { drain_command: command } : {}),
    display: tracked
      ? unbacked
        ? `${amount} of former credit at ${label} (${state}; no action is available).`
        : credit.reconciliation_pending
          ? `${amount} of credit at ${label} (${state}, tracked locally but not drawable).`
          : credit.expired
            ? `${amount} of credit at ${label} (${state}, tracked locally but not drawable).`
            : `${amount} of credit at ${label} (${state}, tracked for draws).`
      : `${amount} on sibling credit ${credit.credit_id} at ${label} (${state}, not used for draws).`,
    ...(!tracked && credit.drainable ? { hint: `Reclaim it with this command: ${command}` } : {}),
  };
}

function wireCreditCurrencyTotals(rows: Record<string, unknown>[]): CreditCurrencyTotals[] {
  const totals = new Map<string, CreditCurrencyTotals>();
  for (const row of rows) {
    if (
      typeof row.currency !== "string" ||
      typeof row.remaining_micro !== "number" ||
      (row.tracked !== true && row.tracked !== false)
    ) {
      continue;
    }
    const total = currencyTotal(totals, row.currency);
    if (row.tracked) total.trackedCount += 1;
    else total.siblingCount += 1;
    if (row.expired === true) continue;
    if (row.drawable === true) total.drawableMicro += Math.max(row.remaining_micro, 0);
    else if (!row.tracked && row.drainable === true) {
      total.siblingSpendableMicro += Math.max(row.remaining_micro, 0);
    }
  }
  return sortedCurrencyTotals(totals);
}
