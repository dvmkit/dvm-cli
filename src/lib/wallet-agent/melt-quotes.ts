import { invoiceDestination } from "./invoice";
import { journalFile } from "./journal-file";

/**
 * An unpaid melt quote a mint issued for a fixed invoice. Some mints refuse a
 * second quote for the same invoice, so a quote obtained by a dry run, a
 * fee-cap refusal, or a melt that never committed has to be found again by the
 * next run. Holds no proofs and commits nothing: the mint's own quote state is
 * checked before any reuse.
 */
export interface StoredMeltQuote {
  mint: string;
  quote_id: string;
  /** Normalised invoice, as `invoiceDestination` returns it. */
  bolt11: string;
  amount_sats: number;
  fee_reserve_sats: number;
  /** Quote expiry as unix seconds, when the mint supplied one. */
  expires_at: number | null;
  created_at: string;
}

const quotes = journalFile<StoredMeltQuote>("melt-quotes.json");

/** Entries without a mint-supplied expiry are dropped after this long. */
const UNDATED_QUOTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function normalise(bolt11: string): string {
  return invoiceDestination(bolt11) ?? bolt11.toLowerCase();
}

function isStale(entry: StoredMeltQuote, nowMs: number): boolean {
  if (typeof entry.expires_at === "number") return entry.expires_at * 1000 <= nowMs;
  const created = Date.parse(entry.created_at);
  return !Number.isFinite(created) || created + UNDATED_QUOTE_TTL_MS <= nowMs;
}

function isEntry(value: unknown): value is StoredMeltQuote {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<StoredMeltQuote>;
  return (
    typeof entry.mint === "string" &&
    typeof entry.quote_id === "string" &&
    entry.quote_id.length > 0 &&
    typeof entry.bolt11 === "string" &&
    typeof entry.created_at === "string"
  );
}

/** The live quote this wallet holds for the invoice at the mint, if any. */
export function storedMeltQuote(mint: string, bolt11: string, nowMs: number): StoredMeltQuote | undefined {
  const invoice = normalise(bolt11);
  return quotes
    .read()
    .filter(isEntry)
    .find((entry) => entry.mint === mint && entry.bolt11 === invoice && !isStale(entry, nowMs));
}

/** Record a quote, replacing any earlier one for the same mint and invoice. */
export function rememberMeltQuote(
  entry: Omit<StoredMeltQuote, "bolt11" | "created_at"> & { bolt11: string },
  nowMs: number
): void {
  const invoice = normalise(entry.bolt11);
  quotes.withLock(() => {
    const kept = quotes
      .read()
      .filter(isEntry)
      .filter((held) => !isStale(held, nowMs) && !(held.mint === entry.mint && held.bolt11 === invoice));
    quotes.write([...kept, { ...entry, bolt11: invoice, created_at: new Date(nowMs).toISOString() }]);
  });
}

/**
 * Drop the quote for a mint and invoice. With `quoteId`, drop only that quote:
 * a concurrent run may already have replaced it.
 */
export function forgetMeltQuote(mint: string, bolt11: string, quoteId?: string): void {
  const invoice = normalise(bolt11);
  const matches = (held: StoredMeltQuote) =>
    held.mint === mint && held.bolt11 === invoice && (quoteId === undefined || held.quote_id === quoteId);
  if (!quotes.read().filter(isEntry).some(matches)) return;
  quotes.withLock(() => quotes.write(quotes.read().filter(isEntry).filter((held) => !matches(held))));
}
