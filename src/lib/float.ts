/**
 * NIP-47 does not guarantee a budget-read method or a per-payment routing-fee
 * ceiling. User-stated budget metadata is descriptive, wallet-volunteered
 * fields are attributed, and CLI caps enforce known principal only. The wallet
 * chooses the route; whether its connection policy counts the fee is unknown.
 */
import { enforceGlobalBudget, recordSpend } from "./budget-ledger";
import { DvmError } from "@dvmkit/sdk/internal";
import { sha256hex } from "@dvmkit/sdk/internal";
import {
  type Config,
  loadConfig,
} from "./identity";
import type {
  LightningBackend,
  LightningPayment,
  LightningTransactionSnapshot,
  LightningWalletInfo,
} from "@dvmkit/sdk/internal";
import {
  type NwcConnection,
  NwcError,
  type NwcRequestOptions,
  parseNwcUri,
  withNwcPool,
} from "@dvmkit/sdk/internal";
import { NwcBackend } from "@dvmkit/sdk/internal";
import {
  info,
  progress,
} from "./output";

export interface FloatMetadata {
  /**
   * The wallet-side budget the user told us they set, verbatim (e.g. "$20/month").
   * Display only — the CLI does not rely on querying the wallet for its real cap,
   * and the two can drift apart.
   */
  statedBudget?: string;
  /** ISO timestamp of the successful connect. */
  connectedAt: string;
  /** Wallet alias at connect time. */
  alias?: string;
  /** Methods the wallet advertised at connect time. */
  methods?: string[];
}

export interface Float extends FloatMetadata {
  conn: NwcConnection;
}

export interface FloatPayment {
  /** Whether the wallet answered directly or the outcome had to be reconciled. */
  outcome: "paid" | "reconciled" | "republished";
  /** Invoice principal in millisatoshis. */
  principalMsats: number;
  /** Wallet-reported routing fee in millisatoshis, or null when unreported. */
  routingFeeMsats: number | null;
  /** Total wallet fee derived from an exact balance delta, or null when unprovable. */
  totalWalletFeeMsats: number | null;
  /** Wallet fee not itemized as routing, or null when that split is unprovable. */
  unitemizedWalletFeeMsats: number | null;
  /** Exact wallet debit in millisatoshis, or null when wallet evidence is ambiguous. */
  walletDebitMsats: number | null;
}

/** JSON-safe representation of a float payment; intentionally excludes the preimage. */
export interface FloatPaymentJson {
  outcome: FloatPayment["outcome"];
  principal_sats: number;
  routing_fee_sats: number | null;
  total_wallet_fee_sats: number | null;
  unitemized_wallet_fee_sats: number | null;
  wallet_debit_sats: number | null;
}

export function floatPaymentJson(payment: FloatPayment): FloatPaymentJson {
  return {
    outcome: payment.outcome,
    principal_sats: payment.principalMsats / 1000,
    routing_fee_sats: payment.routingFeeMsats === null ? null : payment.routingFeeMsats / 1000,
    total_wallet_fee_sats:
      payment.totalWalletFeeMsats === null ? null : payment.totalWalletFeeMsats / 1000,
    unitemized_wallet_fee_sats:
      payment.unitemizedWalletFeeMsats === null
        ? null
        : payment.unitemizedWalletFeeMsats / 1000,
    wallet_debit_sats: payment.walletDebitMsats === null ? null : payment.walletDebitMsats / 1000,
  };
}

export function floatPaymentDisplay(payment: FloatPayment): string {
  const principal = formatSats(payment.principalMsats);
  if (payment.walletDebitMsats === null) {
    const routing =
      payment.routingFeeMsats === null
        ? "The wallet did not report its routing fee."
        : `The wallet reported ${formatSats(payment.routingFeeMsats)} of routing fee.`;
    return `Invoice principal ${principal}; the total wallet debit and total wallet fee are unknown. ${routing}`;
  }
  if (payment.totalWalletFeeMsats === null) {
    return `${formatSats(payment.walletDebitMsats)} went out for invoice principal ${principal}; the total wallet fee is unknown.`;
  }
  const totalFee = formatSats(payment.totalWalletFeeMsats);
  if (payment.routingFeeMsats === null) {
    return `${formatSats(payment.walletDebitMsats)} went out: invoice principal ${principal} and total wallet fee ${totalFee}. The wallet did not report its routing fee, so the fee split is unknown.`;
  }
  const routing = formatSats(payment.routingFeeMsats);
  if (payment.unitemizedWalletFeeMsats === null) {
    return `${formatSats(payment.walletDebitMsats)} went out: invoice principal ${principal} and total wallet fee ${totalFee}. The wallet reported ${routing} of routing fee; the remaining fee split is unknown.`;
  }
  return `${formatSats(payment.walletDebitMsats)} went out: invoice principal ${principal} and total wallet fee ${totalFee} (${routing} wallet-reported routing fee and ${formatSats(payment.unitemizedWalletFeeMsats)} unitemized wallet fee).`;
}

/** Warning shown before paying when no wallet-side connection budget was recorded. */
export function unrecordedFloatBudgetWarning(
  float: Pick<Float, "statedBudget">
): string | undefined {
  if (float.statedBudget) return undefined;
  return "No wallet-side spending policy is recorded for this NWC connection. dvm checks the invoice principal against its local budget, but NIP-47 cannot set a per-payment routing-fee ceiling; the wallet chooses the route and fee.";
}

export type FloatBudgetWarningOperation = "credit_funding" | "pocket_refill";

export interface FloatBudgetWarningArgs {
  float: Pick<Float, "statedBudget">;
  operation: FloatBudgetWarningOperation;
  principalMsats: number;
  human?: boolean;
}

/**
 * Emit the missing-policy warning before an autonomous float payment.
 *
 * JSON mode uses a structured stderr event so an agent can observe the warning
 * before money moves without corrupting the command's terminal stdout object.
 * Human mode keeps the same warning as prose.
 */
export function emitFloatBudgetWarning(args: FloatBudgetWarningArgs): void {
  const warning = unrecordedFloatBudgetWarning(args.float);
  if (!warning) return;
  if (args.human) {
    const label =
      args.operation === "credit_funding" ? "Lightning credit funding" : "Ecash pocket refill";
    info(`${label} warning: ${warning}`);
    return;
  }
  progress({
    event: "warning",
    code: "float_budget_unstated",
    operation: args.operation,
    principal_sats: args.principalMsats / 1000,
    routing_fee_ceiling_sats: null,
    routing_fee_inclusion: "unknown",
    display: warning,
    hint: "Set a connection policy in the wallet app, confirm whether it counts routing fees, then reconnect with --budget to record it for dvm.",
  });
}

/** Stable CLI contract explaining an NWC float's funding-only role. */
export interface NwcFundingFloatRole {

  readonly role: "nwc_funding_float";
  /** Funding paths this connection can pay for. */
  readonly uses: readonly ("cashu_wallet_topups" | "eligible_prepaid_credit_funding")[];
  /** Whether this connection is selectable as a direct `dvm request` rail. */
  readonly direct_request_rail: false;

  readonly display: string;

  readonly hint: string;
}

export const NWC_FUNDING_FLOAT_ROLE: NwcFundingFloatRole = {
  role: "nwc_funding_float",
  uses: ["cashu_wallet_topups", "eligible_prepaid_credit_funding"],
  direct_request_rail: false,
  display:
    "This connected Lightning wallet is an NWC funding float: it funds ecash wallet top-ups and eligible prepaid credits directly, not direct dvm request payments.",
  hint: "dvm request uses ecash, Tempo stablecoin, or x402 stablecoin. Prepaid-credit funding is selected automatically: ecash below a DVM's advertised Lightning floor, this wallet directly when eligible. dvm checks Lightning invoice principal against local caps; the wallet chooses the route and routing fee.",
};

export interface FloatProbe {
  reachable: boolean;
  alias?: string;
  methods: string[];
  /** The wallet advertises `pay_invoice` — without it the float cannot fund. */
  canPay: boolean;
  /**
   * The wallet advertises `make_invoice` — without it a *receive* connection
   * cannot issue the invoice it exists to issue. The mirror of `canPay`: a
   * receive-only connection (the first-party hub, the billing wallet) has no
   * `pay_invoice` by design, so `canPay` is the wrong health signal for it.
   */
  canInvoice: boolean;
  /**
   * The wallet advertises `lookup_invoice`. Without it a lost response can never
   * be reconciled, so every unknown outcome ends as `float_payment_unknown`.
   */
  canReconcile: boolean;
  balanceMsats?: number;
  /** Budget fields the wallet volunteered — never required, never synthesised. */
  walletReportedBudget?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    display: string;
    hint?: string;
    /**
     * The mapped `DvmError`'s full relay payload — `next_step`, and whatever
     * the failure knew about itself (`method`, `restriction`, …). Carried
     * whole so a caller that re-throws this as a `DvmError` hands the agent
     * the same fields it would have got from the failure directly.
     */
    data?: Record<string, unknown>;
  };
}

export interface StatedBudget {

  raw: string;

  period?: "day" | "week" | "month" | "year";

  display: string;
}

const BUDGET_PERIODS: Record<string, StatedBudget["period"]> = {
  day: "day",
  daily: "day",
  week: "week",
  weekly: "week",
  month: "month",
  monthly: "month",
  year: "year",
  yearly: "year",
};

/** Load the configured float, or null when none is connected. */
export function loadFloat(config?: Config | null): Float | null {
  const cfg = config === undefined ? loadConfig() : config;
  if (!cfg?.nwcUri) return null;
  let conn: NwcConnection;
  try {
    conn = parseNwcUri(cfg.nwcUri);
  } catch (err) {
    throw toFloatError(err);
  }
  return {
    conn,
    connectedAt: cfg.float?.connectedAt ?? "",
    statedBudget: cfg.float?.statedBudget,
    alias: cfg.float?.alias,
    methods: cfg.float?.methods,
  };
}

/** Load the configured float, throwing a relayable error when none is connected. */
export function requireFloat(config?: Config | null): Float {
  const float = loadFloat(config);
  if (!float) {
    throw new DvmError(
      "float_not_connected",
      "No Lightning wallet is connected.",
      "Connect one with 'dvm wallet connect' (pipe the connection string in, or pass --file <path>), or run 'dvm wallet setup --type nwc' for a walkthrough.",
      {
        display:
          "This agent has no Lightning wallet connected, so it can't top itself up. A human needs to connect one first.",
      }
    );
  }
  return float;
}

/**
 * Check a planned float spend against the CLI's own budget caps *before* any
 * money moves or any mint quote is opened, and return the BTC/USD rate to
 * thread into {@link recordFloatSpend} so the check and the debit price
 * identically.
 *
 * This checks known invoice principal only. The wallet's connection policy is
 * the hard outer control: NIP-47 cannot attach a routing-fee ceiling here.
 */
export async function assertFloatBudget(plannedMsats: number): Promise<number> {
  return enforceGlobalBudget({ plannedMsats });
}

/** Record a settled float top-up against the shared spend ledger. */
export function recordFloatSpend(params: {
  principalMsats: number;
  routingFeeMsats: number | null;
  totalWalletFeeMsats?: number | null;
  unitemizedWalletFeeMsats?: number | null;
  walletDebitMsats?: number | null;
  btcRate: number;
  /** Stable handle for the funding — a mint quote id, or a credit reference. */
  reference: string;
  /** Where the sats went — a mint URL, or a DVM endpoint. */
  counterparty: string;
  label?: string;
}): void {
  const walletDebitMsats = params.walletDebitMsats ?? null;
  recordSpend({
    kind: "float_fund",
    // The legacy `msats` field drives cap arithmetic. Use the exact debit when
    // read-only evidence proved it; otherwise retain the known principal and
    // mark the total unknown in the component fields below.
    msats: walletDebitMsats ?? params.principalMsats,
    principalMsats: params.principalMsats,
    routingFeeMsats: params.routingFeeMsats,
    totalWalletFeeMsats: params.totalWalletFeeMsats ?? null,
    unitemizedWalletFeeMsats: params.unitemizedWalletFeeMsats ?? null,
    walletDebitMsats,
    btcRate: params.btcRate,
    jobId: params.reference,
    providerEndpoint: params.counterparty,
    label: params.label ?? `float top-up · ${params.counterparty}`,
  });
}

/**
 * Pay a bolt11 from the float, with the no-double-pay discipline of
 * {@link payInvoiceReconciling} and wallet failures mapped into relayable
 * `DvmError`s.
 */
export async function payViaFloat(params: {
  bolt11: string;
  amountMsats: number;
  float: Float;
  timeoutMs?: number;
}): Promise<FloatPayment> {
  try {
    return await withNwcPool(
      params.float.conn,
      (opts) =>
        payViaLightningBackend({
          bolt11: params.bolt11,
          amountMsats: params.amountMsats,
          backend: backendFor(params.float, opts),
        }),
      params.timeoutMs
    );
  } catch (err) {
    throw toFloatError(err);
  }
}

const FLOAT_TRANSACTION_LIMIT = 100;
const FLOAT_HISTORY_LOOKBACK_SECONDS = 300;

interface FloatWalletSnapshot {
  balanceMsats: number;
  transactions: LightningTransactionSnapshot[];
}

/**
 * Pay through an injected backend while surrounding the payment with stable,
 * bounded read-only evidence.
 */
export async function payViaLightningBackend(params: {
  bolt11: string;
  amountMsats: number;
  backend: LightningBackend;
  now?: () => number;
}): Promise<FloatPayment> {
  const now = params.now ?? (() => Date.now());
  const historyFrom = Math.max(
    0,
    Math.floor(now() / 1000) - FLOAT_HISTORY_LOOKBACK_SECONDS
  );
  const before = await stableWalletSnapshot(params.backend, historyFrom);
  const payment = await params.backend.payInvoice(params.bolt11, params.amountMsats);
  const fallback = paymentWithoutAuthoritativeDebit(payment, params.amountMsats);
  if (!before) return fallback;
  const after = await stableWalletSnapshot(params.backend, historyFrom);
  if (!after) return fallback;
  return paymentFromEvidence(params, payment, before, after);
}

function paymentWithoutAuthoritativeDebit(
  payment: LightningPayment,
  principalMsats: number
): FloatPayment {
  return {
    outcome: payment.outcome,
    principalMsats,
    routingFeeMsats: payment.feesPaidMsats ?? null,
    totalWalletFeeMsats: null,
    unitemizedWalletFeeMsats: null,
    walletDebitMsats: null,
  };
}

async function stableWalletSnapshot(
  backend: LightningBackend,
  from: number
): Promise<FloatWalletSnapshot | undefined> {
  if (!backend.listTransactions) return undefined;
  try {
    const first = await walletSnapshot(backend, from);
    const second = await walletSnapshot(backend, from);
    return sameWalletSnapshot(first, second) ? second : undefined;
  } catch {
    // Payment accounting is supplemental evidence. A read failure must never
    // discard a successful payment or tempt the caller to pay it again.
    return undefined;
  }
}

async function walletSnapshot(
  backend: LightningBackend,
  from: number
): Promise<FloatWalletSnapshot> {
  const balanceMsats = await backend.getBalance();
  if (!Number.isSafeInteger(balanceMsats) || balanceMsats < 0) {
    throw new NwcError("invalid_response", "Wallet returned an invalid balance.");
  }
  const transactions = await backend.listTransactions!({
    from,
    limit: FLOAT_TRANSACTION_LIMIT + 1,
  });
  if (transactions.length > FLOAT_TRANSACTION_LIMIT) {
    throw new NwcError("invalid_response", "Wallet transaction snapshot exceeded its limit.");
  }
  return {
    balanceMsats,
    transactions: [...transactions].sort((left, right) =>
      left.fingerprint.localeCompare(right.fingerprint)
    ),
  };
}

function sameWalletSnapshot(left: FloatWalletSnapshot, right: FloatWalletSnapshot): boolean {
  return (
    left.balanceMsats === right.balanceMsats &&
    left.transactions.length === right.transactions.length &&
    left.transactions.every(
      (transaction, index) => transaction.fingerprint === right.transactions[index]?.fingerprint
    )
  );
}

function paymentFromEvidence(
  params: { bolt11: string; amountMsats: number },
  payment: LightningPayment,
  before: FloatWalletSnapshot,
  after: FloatWalletSnapshot
): FloatPayment {
  const fallback = paymentWithoutAuthoritativeDebit(payment, params.amountMsats);
  const appended = appendedTransactions(before.transactions, after.transactions);
  if (appended.length !== 1) return fallback;
  const transaction = appended[0];
  if (
    transaction.type !== "outgoing" ||
    transaction.invoiceHash !== sha256hex(params.bolt11) ||
    transaction.amountMsats !== params.amountMsats ||
    transaction.settledAt === undefined
  ) {
    return fallback;
  }

  const responseRoutingFee = payment.feesPaidMsats;
  const historyRoutingFee = transaction.feesPaidMsats;
  if (
    responseRoutingFee !== undefined &&
    historyRoutingFee !== undefined &&
    responseRoutingFee !== historyRoutingFee
  ) {
    return fallback;
  }
  const routingFeeMsats = historyRoutingFee ?? responseRoutingFee ?? null;
  const walletDebitMsats = before.balanceMsats - after.balanceMsats;
  if (!Number.isSafeInteger(walletDebitMsats) || walletDebitMsats < params.amountMsats) {
    return fallback;
  }
  const totalWalletFeeMsats = walletDebitMsats - params.amountMsats;
  if (routingFeeMsats !== null && routingFeeMsats > totalWalletFeeMsats) return fallback;
  return {
    outcome: payment.outcome,
    principalMsats: params.amountMsats,
    routingFeeMsats,
    totalWalletFeeMsats,
    unitemizedWalletFeeMsats:
      routingFeeMsats === null ? null : totalWalletFeeMsats - routingFeeMsats,
    walletDebitMsats,
  };
}

function appendedTransactions(
  before: readonly LightningTransactionSnapshot[],
  after: readonly LightningTransactionSnapshot[]
): LightningTransactionSnapshot[] {
  const remaining = new Map<string, number>();
  for (const transaction of before) {
    remaining.set(transaction.fingerprint, (remaining.get(transaction.fingerprint) ?? 0) + 1);
  }
  const nextCounts = new Map<string, number>();
  for (const transaction of after) {
    nextCounts.set(transaction.fingerprint, (nextCounts.get(transaction.fingerprint) ?? 0) + 1);
  }
  if ([...remaining].some(([fingerprint, count]) => (nextCounts.get(fingerprint) ?? 0) < count)) {
    return [];
  }
  return after.filter((transaction) => {
    const count = remaining.get(transaction.fingerprint) ?? 0;
    if (count === 0) return true;
    remaining.set(transaction.fingerprint, count - 1);
    return false;
  });
}

/**
 * The whole funding leg for callers that already hold an invoice: cap check →
 * pay → ledger. The mint-quote path in `wallet-agent/fund.ts` splits these
 * apart because it must check the cap before opening a quote, but anything
 * handed a ready bolt11 (the credit-funding leg) should use this.
 */
export async function fundViaFloat(params: {
  bolt11: string;
  amountMsats: number;
  reference: string;
  counterparty: string;
  label?: string;
  float?: Float;
  timeoutMs?: number;
}): Promise<FloatPayment & { btcRate: number }> {
  const float = params.float ?? requireFloat();
  const btcRate = await assertFloatBudget(params.amountMsats);
  const payment = await payViaFloat({
    bolt11: params.bolt11,
    amountMsats: params.amountMsats,
    float,
    timeoutMs: params.timeoutMs,
  });
  recordFloatSpend({
    principalMsats: payment.principalMsats,
    routingFeeMsats: payment.routingFeeMsats,
    totalWalletFeeMsats: payment.totalWalletFeeMsats,
    unitemizedWalletFeeMsats: payment.unitemizedWalletFeeMsats,
    walletDebitMsats: payment.walletDebitMsats,
    btcRate,
    reference: params.reference,
    counterparty: params.counterparty,
    label: params.label,
  });
  return { ...payment, btcRate };
}

/**
 * One-pool reachability probe: `get_info` for capabilities, `get_balance` for
 * the number. Never throws — a dead wallet comes back as `reachable: false`
 * with a relayable error, because both callers (`dvm doctor`, the platform
 * cron) are reporters.
 */
export async function probeFloat(params: {
  float: Float;
  timeoutMs?: number;
}): Promise<FloatProbe> {
  const { float, timeoutMs } = params;
  return withNwcPool(float.conn, (opts) => probeOnPool(float, opts), timeoutMs);
}

async function probeOnPool(float: Float, opts: NwcRequestOptions): Promise<FloatProbe> {
  const backend = backendFor(float, opts);
  let info: LightningWalletInfo;
  try {
    info = await backend.getInfo();
  } catch (err) {
    const mapped = toFloatError(err);
    return {
      reachable: false,
      methods: [],
      canPay: false,
      canInvoice: false,
      canReconcile: false,
      error: {
        code: mapped.code,
        message: mapped.message,
        display: typeof mapped.data?.display === "string" ? mapped.data.display : mapped.message,
        hint: mapped.hint,
        ...(mapped.data ? { data: mapped.data } : {}),
      },
    };
  }

  const probe: FloatProbe = {
    reachable: true,
    alias: info.alias,
    methods: info.methods,
    canPay: supportsMethod(info.methods, "pay_invoice"),
    canInvoice: supportsMethod(info.methods, "make_invoice"),
    canReconcile: supportsMethod(info.methods, "lookup_invoice"),
  };
  if (info.walletReportedBudget) probe.walletReportedBudget = info.walletReportedBudget;

  // A wallet that answered `get_info` is reachable; a balance we couldn't read
  // is a missing number, not a dead float.
  try {
    probe.balanceMsats = await backend.getBalance();
  } catch {
    // left undefined
  }
  return probe;
}

function backendFor(float: Float, opts: NwcRequestOptions): LightningBackend {
  return new NwcBackend(float.conn, opts);
}

function formatSats(msats: number): string {
  const sats = msats / 1000;
  return `${Number.isInteger(sats) ? sats.toLocaleString("en-US") : String(sats)} sats`;
}

/**
 * Validate and describe the budget the user says they set on the wallet side.
 *
 * Deliberately permissive: this is a note-to-self, not a cap the CLI enforces,
 * and rejecting a wallet's own phrasing would be worse than storing it verbatim.
 */
export function parseStatedBudget(raw: string): StatedBudget {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 64) {
    throw new DvmError(
      "invalid_budget",
      `Invalid budget: "${raw}".`,
      "Pass the cap you set on the wallet, e.g. --budget '$20/month' or --budget '50000 sats/week'.",
      { display: "That budget didn't look like an amount — try something like '$20/month'." }
    );
  }

  const slash = trimmed.lastIndexOf("/");
  if (slash === -1) return { raw: trimmed, display: trimmed };

  const suffix = trimmed
    .slice(slash + 1)
    .trim()
    .toLowerCase();
  const period = BUDGET_PERIODS[suffix];
  if (!period) {
    throw new DvmError(
      "invalid_budget",
      `Unknown budget period: "${suffix}".`,
      "Use one of day, week, month, or year — e.g. --budget '$20/month'.",
      {
        display: `"${suffix}" isn't a period we recognise. Use day, week, month, or year.`,
      }
    );
  }
  return { raw: trimmed, period, display: trimmed };
}

/**
 * The `budget` block attached to float JSON output.
 *
 * `stated` is the user's own note; `wallet_reported` only appears when a wallet
 * volunteered non-spec fields. There is deliberately no "remaining" — the CLI
 * does not rely on a budget-read method, and a fabricated number here would be
 * spent against.
 */
export function floatBudgetJson(
  float: Pick<Float, "statedBudget">,
  walletReported?: Record<string, unknown>
): Record<string, unknown> {
  const stated = float.statedBudget;
  return {
    stated: stated ?? null,
    source: "user_stated",
    routing_fee_inclusion: "unknown",
    ...(walletReported ? { wallet_reported: { _source: "wallet", ...walletReported } } : {}),
    display: stated
      ? `Wallet connection budget: ${stated} (as you reported it — not a live wallet reading)`
      : "No wallet budget recorded. Set one in your wallet app, then re-connect with --budget to note it here.",
    hint: "The wallet enforces its connection policy, but dvm does not know whether that policy counts routing fees. dvm checks invoice principal against its own local caps; NIP-47 cannot set a per-payment routing-fee ceiling.",
  };
}

/**
 * Map any NWC-layer failure onto a `DvmError` an agent can relay verbatim.
 *
 * Both namespaces land here: our own transport codes (lowercase) and the
 * wallet's NIP-47 codes (uppercase). Anything unrecognised degrades to a
 * generic wallet error rather than leaking a raw string.
 */
export function toFloatError(err: unknown): DvmError {
  if (err instanceof DvmError) return err;
  if (!(err instanceof NwcError)) {
    const message = err instanceof Error ? err.message : String(err);
    return new DvmError("float_wallet_error", message, RETRY_HINT, {
      display: "The Lightning wallet couldn't be reached. Nothing was charged.",
    });
  }

  switch (err.code.toUpperCase()) {
    case "QUOTA_EXCEEDED":
      return new DvmError(
        "float_quota_exceeded",
        "The Lightning wallet refused the payment: its spending budget is exhausted.",
        "Raise the budget on this connection in your wallet app (or wait for it to renew), then retry.",
        {
          display:
            "Your Lightning wallet has hit the spending limit you set on this connection, so it declined the top-up. Nothing was charged.",
          next_step: "Raise the limit in your wallet app, or wait for the budget period to reset.",
        }
      );
    case "INSUFFICIENT_BALANCE":
      return new DvmError(
        "float_insufficient_balance",
        "The Lightning wallet does not have enough balance for this payment.",
        "Top up the wallet itself, then retry — or fund a smaller amount.",
        {
          display:
            "Your Lightning wallet doesn't have enough funds for this top-up. Nothing was charged.",
          next_step: "Add funds to the wallet, or ask for a smaller amount.",
        }
      );

    case "UNAUTHORIZED":
      return new DvmError(
        "float_unauthorized",
        "The Lightning wallet rejected this connection.",
        "The connection was probably revoked or expired. Create a fresh one in your wallet app and pipe it into 'dvm wallet connect'.",
        {
          display:
            "The connection to your Lightning wallet is no longer valid — it looks revoked or expired. Nothing was charged.",
          next_step: "Create a new connection in your wallet app and reconnect it.",
          ...methodFields(err),
        }
      );
    case "RESTRICTED":
      return restrictedError(err);
    case "RATE_LIMITED":
      return new DvmError(
        "float_rate_limited",
        "The Lightning wallet is rate limiting this connection.",
        "Wait a moment and retry.",
        { display: "Your Lightning wallet asked us to slow down. Nothing was charged." }
      );
    case "NOT_IMPLEMENTED":
      return new DvmError(
        "float_method_unsupported",
        "The Lightning wallet does not support the operation the float needs.",
        "Use a wallet that supports pay_invoice and lookup_invoice — see public SDK documentation for the recommended bench.",
        {
          display: "Your Lightning wallet doesn't support automatic payments. Nothing was charged.",
          next_step:
            "Switch to a wallet that can pay invoices over a connection, such as Alby Hub.",
        }
      );

    case "PAYMENT_FAILED":
      return new DvmError(
        "float_payment_failed",
        err.message
          ? `The Lightning wallet tried to pay and failed: ${err.message}`
          : "The Lightning wallet tried to pay and failed.",
        "The wallet's own reason is in the message. Transient routing failures can succeed on a retry; a very small amount may be below what the route can carry at all — those can be covered with ecash instead ('dvm wallet fund').",
        {
          display: err.message
            ? `Your Lightning wallet tried to send the payment and it didn't go through. Nothing was charged. The wallet said: ${err.message}`
            : "Your Lightning wallet tried to send the payment and it didn't go through. Nothing was charged.",
          ...(err.message ? { wallet_message: err.message } : {}),
        }
      );
    case "PAYMENT_UNKNOWN":
      return new DvmError(
        "float_payment_unknown",
        "The wallet never confirmed whether the payment went through.",
        "Check the wallet's own transaction list before retrying — retrying blind could pay twice.",
        {
          display:
            "We couldn't confirm whether your Lightning wallet sent this payment. Check the wallet's transaction history before trying again — trying again blind could pay twice.",
          next_step: "Open your wallet app and look for a recent outgoing payment.",
        }
      );
    case "TIMEOUT":
      return new DvmError(
        "float_wallet_offline",
        "The Lightning wallet did not respond in time.",
        "The wallet must be online and reachable. Phone wallets sleep with the phone — use an always-on wallet for a float.",
        {
          display:
            "Your Lightning wallet didn't answer, so the top-up didn't happen. Nothing was charged.",
          next_step:
            "Make sure the wallet is running and online. Wallets on a phone go to sleep and can't be used this way.",
        }
      );
    // Two transport failures, one story for the reader: nothing reached the
    // wallet. They stay distinct inside `payInvoiceReconciling`, where only
    // `relay_unreachable` proves the request was never transmitted.
    case "RELAY_UNREACHABLE":
    case "PUBLISH_REJECTED":
      return new DvmError(
        "float_relay_unreachable",
        "None of the wallet's relays accepted the request.",
        "Check network connectivity, or reconnect with a connection string that lists more than one relay.",
        {
          display:
            "We couldn't reach the servers your Lightning wallet listens on. Nothing was charged.",
          next_step: "Check your internet connection and try again.",
        }
      );
    case "INVALID_URI":
      return new DvmError(
        "float_invalid_uri",
        `The NWC connection string is malformed: ${err.message}`,
        "Copy a fresh connection string from your wallet app and pipe it into 'dvm wallet connect'.",
        {
          display:
            "The saved connection to your Lightning wallet is unreadable. A human needs to reconnect it.",
        }
      );
    default:
      return new DvmError("float_wallet_error", err.message, RETRY_HINT, {
        display: "Your Lightning wallet returned an error. Nothing was charged.",
        wallet_error_code: err.code,
      });
  }
}

const RETRY_HINT = "Run 'dvm doctor' to check the wallet connection, then retry.";

/**
 * The `RESTRICTED` branch of {@link toFloatError}.
 *
 * NIP-47 gives one code to two wallet-side settings with two different
 * remedies: a permission the connection was never granted, and a spending cap
 * it just crossed. The wallet's own words are the only thing that separates
 * them, so — as with `PAYMENT_FAILED` — they choose the hint rather
 * than being flattened into a single guess.
 */
function restrictedError(err: NwcError): DvmError {
  const budget = BUDGET_WORDING.test(err.message);
  const method = err.method;
  const doing = describeNwcMethod(method);
  const walletFields = {
    restriction: budget ? "budget" : "permission",
    ...methodFields(err),
    ...(err.message ? { wallet_message: err.message } : {}),
  };

  if (budget) {
    return new DvmError(
      "float_connection_restricted",
      method
        ? `The Lightning wallet refused this connection's ${method} call: ${err.message}`
        : `The Lightning wallet refused this connection: ${err.message}`,
      "The wallet's own words point at the spending limit set on this connection, not a missing permission. Raise that limit in your wallet app — recreating the connection carries the same limit over.",
      {
        display:
          "Your Lightning wallet blocked this because of the spending limit set on this connection. Nothing was charged.",
        next_step: "In your wallet app, open this connection and raise its spending limit.",
        ...walletFields,
      }
    );
  }

  return new DvmError(
    "float_connection_restricted",
    method
      ? `The Lightning wallet recognises this connection but will not let it call ${method}.`
      : "The Lightning wallet recognises this connection but will not let it do this.",
    `The connection itself is still valid, so recreating it changes nothing on its own. In your wallet app, edit this connection to allow ${method ?? "the operation"} — or raise its spending limit, if that is what it caps — then retry.`,
    {
      display: `Your Lightning wallet knows this connection but has not allowed it to ${doing}. Nothing was charged.`,
      next_step: `In your wallet app, open this connection's permissions and allow it to ${doing}. You do not need to create a new connection.`,
      ...walletFields,
    }
  );
}

function methodFields(err: NwcError): { method?: string } {
  return err.method ? { method: err.method } : {};
}

/**
 * A NIP-47 method in words a non-Bitcoiner can act on — this is the half of
 * the remedy a caller reads out to the human who owns the wallet app.
 */
function describeNwcMethod(method: string | undefined): string {
  switch (method) {
    case "pay_invoice":
      return "send payments";
    case "make_invoice":
      return "create invoices";
    case "lookup_invoice":
      return "look up past payments";
    case "get_balance":
      return "read its balance";
    case "get_info":
      return "read the wallet's details";
    default:
      return method ? `use ${method}` : "do what the agent needs";
  }
}

/**
 * Wording that means the wallet refused on a spending cap rather than a permission.
 *
 * The nouns take `\w*` so plurals and participles ("limits", "budgeted") match —
 * `cap` is the exception, kept to `caps?|capped` because `cap\w*` would swallow
 * "capable" and route a plain permission refusal to the wrong remedy.
 */
const BUDGET_WORDING = /\b(budget\w*|quota\w*|limit\w*|caps?|capped|allowance\w*|exceed\w*)\b/i;

function supportsMethod(methods: string[], method: string): boolean {
  // Some wallets namespace their advertised methods (e.g. "nip47.pay_invoice"),
  // and an empty list means the wallet declined to say — assume capable rather
  // than blocking a working connection on a cosmetic difference.
  if (methods.length === 0) return true;
  return methods.some((m) => m === method || m.endsWith(`.${method}`));
}
