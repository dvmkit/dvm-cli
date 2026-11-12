import { bech32 } from "@scure/base";

// Signed 60-sat invoice, timestamp 1790000000, explicit expiry 31536000 seconds.
export const CASH_OUT_INVOICE = "lnbc600n1p4tzwuqpp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsdq6vdshx6pqda6hggrxd9u8gatjv5xq97zvuqcqpfeasysxwnvj3hf5uyzff445spcpzrg6z39jn9qaut45rdl3afvcvquv92wuq6h4qtlxnc2g9s68cnhq0csgs8n9v7vnu02rz8g4ppfesphlawef";

// BOLT11's coffee vector: 250000 sats, timestamp 1496314658, expiry 60 seconds.
// https://github.com/lightning/bolts/blob/master/11-payment-encoding.md#examples
export const EXPIRED_INVOICE = "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";

// Header variants exercise refusals before signature validation at the mint.
export function invoiceHeader(prefix: string): string {
  return bech32.encode(prefix, bech32.decode(CASH_OUT_INVOICE as `${string}1${string}`, false).words, false);
}
