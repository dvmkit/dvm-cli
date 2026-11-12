import type { Wallet } from "@cashu/cashu-ts";
import { journalFile } from "./wallet-agent/journal-file";

interface KeysetFee { mint: string; id: string; ppk: number }
const fees = journalFile<KeysetFee>("wallet-keyset-fees.json");

/** Retain public metadata from an already loaded mint; reporting must never contact it. */
export function rememberKeysetFees(mint: string, wallet: Wallet): void {
  try {
    const rows = wallet.keyChain.getKeysets().map((keyset) => ({
      mint, id: keyset.id, ppk: keyset.fee,
    })).filter((row) => Number.isFinite(row.ppk) && row.ppk >= 0);
    if (!rows.length) return;
    fees.withLock(() => fees.write([
      ...fees.read().filter((row) => !rows.some((next) => next.mint === row.mint && next.id === row.id)),
      ...rows,
    ]));
  } catch { /* Optional reporting metadata must not interrupt a payment. */ }
}

export function localInputFee(mint: string, ids: string[]): number | undefined {
  const rows = fees.read();
  let ppk = 0;
  for (const id of ids) {
    const row = rows.find((entry) => entry.mint === mint && entry.id === id);
    if (!row || !Number.isFinite(row.ppk) || row.ppk < 0) return undefined;
    ppk += row.ppk;
  }
  return Math.ceil(ppk / 1000);
}
