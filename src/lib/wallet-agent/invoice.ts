import { bech32 } from "@scure/base";
import { DvmError, type AgentWallet } from "@dvmkit/sdk/internal";

export function invoiceDestination(destination: string): string | undefined {
  const invoice = destination.replace(/^lightning:/i, "").toLowerCase();
  return !invoice.includes("@") && /^ln(bcrt|tbs|tb|bc)([0-9]+[munp]?)?1[02-9ac-hj-np-z]+$/.test(invoice)
    ? invoice : undefined;
}

function invalidInvoice(message: string): never {
  throw new DvmError("invalid_invoice", `${message} No money moved.`,
    "Ask for a valid mainnet invoice with an amount, then run `dvm wallet cash-out <invoice>`.");
}

/** Read payment constraints locally; full signature/payment validation remains with the mint. */
export function invoiceAmountSats(invoice: string, now = Date.now()): number {
  let decoded;
  try { decoded = bech32.decode(invoice as `${string}1${string}`, false); }
  catch { return invalidInvoice("The invoice has invalid Bech32 encoding or checksum."); }
  const header = /^ln(bcrt|tbs|tb|bc)([0-9]+)?([munp]?)$/.exec(decoded.prefix);
  if (!header || header[1] !== "bc") return invalidInvoice("The invoice is on the wrong network; this wallet pays Bitcoin mainnet invoices.");
  if (!header[2]) return invalidInvoice("An amountless invoice cannot be cashed out.");
  const scale: Record<string, bigint> = { "": 1_000_000_000_000n, m: 1_000_000_000n, u: 1_000_000n, n: 1000n, p: 1n };
  const picoBtc = BigInt(header[2]) * scale[header[3]];
  if (picoBtc <= 0n || picoBtc % 10n !== 0n) return invalidInvoice("The invoice amount must be positive and represent whole millisatoshis.");
  // A sat-denominated mint rounds the Lightning millisatoshi amount up to sats.
  const sats = Number((picoBtc + 9999n) / 10000n);
  const words = decoded.words;
  const end = words.length - 104; // Compact signature occupies 104 five-bit words.
  if (end < 7 || !Number.isSafeInteger(sats)) return invalidInvoice("The invoice has invalid payment data or amount.");
  const integer = (data: number[]) => data.reduce((value, word) => value * 32 + word, 0);
  const timestamp = integer(words.slice(0, 7));
  let expiry = 3600;
  let hasExpiry = false;
  for (let pos = 7; pos < end;) {
    if (pos + 3 > end) return invalidInvoice("The invoice has a truncated tagged field.");
    const tag = words[pos], length = words[pos + 1] * 32 + words[pos + 2];
    pos += 3;
    if (pos + length > end) return invalidInvoice("The invoice has a truncated tagged field.");
    if (tag === 6) {
      if (hasExpiry || length === 0) return invalidInvoice("The invoice has an invalid expiry field.");
      expiry = integer(words.slice(pos, pos + length));
      hasExpiry = true;
    }
    pos += length;
  }
  if (!Number.isSafeInteger(timestamp + expiry)) return invalidInvoice("The invoice expiry is out of range.");
  const remainingMs = (timestamp + expiry) * 1000 - now;
  if (remainingMs <= 0) return invalidInvoice("The invoice has expired.");
  if (remainingMs < 60_000) return invalidInvoice("The invoice expires in less than 60 seconds.");
  return sats;
}

export function assertInvoiceNotPending(wallet: AgentWallet, invoice: string): void {
  const normalized = invoiceDestination(invoice);
  if (normalized && wallet.pending_melts.some((entry) => invoiceDestination(entry.bolt11) === normalized)) {
    throw new DvmError("cash_out_pending", "This invoice already has a cash-out in flight. No money moved.",
      "Run `dvm wallet show` to reconcile it before retrying.");
  }
}
