import { isImplicitCreditId } from "./draw-funding";
import { loadFloat } from "./float";
import { formatUsd, getLastKnownBtcRate, loadAgentWallet, msatsToUsd,
  getX402Balance, ensureAddress, getTempoUsdcBalance } from "@dvmkit/sdk/internal";
import { formatSats } from "./currency";
import { loadConfig } from "./identity";
import type { JobRecord } from "./job-store";
import { loadMessages } from "./messages";
import { isTerminalJobStatus } from "./next-action";
import { localInputFee } from "./wallet-keyset-fees";

export interface WalletRemaining {
  rail: "cashu" | "x402" | "tempo";
  amount_sats?: number;
  amount_usdc?: number;
  usd?: string;
  can_send_back: boolean;
  invoice_amount_sats?: number;
  hint?: string;
  display: string;
}

/** Optional current wallet balance, never a second job charge or a historical refund amount. */
export async function walletRemaining(job: JobRecord): Promise<WalletRemaining | undefined> {
  try {
    if (!isTerminalJobStatus(job.status)) return;
    const payments = loadMessages(job.id).filter((message) => message.type === "payment")
      .filter((message) => message.from === "requester").map((message) => message.content);
    const suppliedToken = payments.some((payment) => payment.cashu_token && !payment.cashu_request_id);
    const localRail = payments.map((payment) => payment.credit && !isImplicitCreditId(payment.credit.credit_id) ? "credit"
      : payment.tempo_credential ? "tempo" : payment.x402_payment ? "x402"
        : payment.cashu_token && payment.cashu_request_id ? "cashu" : undefined).filter(Boolean).at(-1)
      ?? job.paymentMethod ?? (typeof job.upfrontRailPayment === "object" ? job.upfrontRailPayment.method : undefined);
    const creditIds = [job.upfrontPayment?.credit_id, job.receipt?.credit?.credit_id];
    const callerCredit = (job.creditBinding && (!("creditId" in job.creditBinding) || !isImplicitCreditId(job.creditBinding.creditId))) || creditIds.some((id) => id && !isImplicitCreditId(id));
    const rail = localRail ?? (callerCredit ? "credit" : suppliedToken ? undefined
      : job.upfrontPayment?.rail ?? (job.receipt && job.receipt.paid.msats > 0 ? job.receipt.paid.rail : undefined));
    if (rail === "cashu") {
      try {
        if (loadFloat() !== null) return;
      } catch { /* An unreadable float cannot fund the pocket. */ }
      return cashuRemaining();
    }
    if (rail !== "x402" && rail !== "tempo") return;
    return await stablecoinRemaining(rail);
  } catch { return; }
}

function cashuRemaining(): WalletRemaining | undefined {
  const wallet = loadAgentWallet();
  if (!wallet) return;
  const proofs = wallet.proofs.filter((proof) => proof.status === "valid" && !proof.reserved_for
    && (proof.locked_to_pubkey === null || proof.locked_to_pubkey === wallet.lock_pubkey));
  const sats = proofs.reduce((sum, proof) => sum + proof.amount, 0);
  if (sats <= 0) return;
  const cached = getLastKnownBtcRate();
  const rate = cached && Date.now() - cached.cachedAt <= 24 * 60 * 60 * 1000 ? cached.rate : undefined;
  const amount = (value: number) => rate ? `$${formatUsd(msatsToUsd(value * 1000, rate))}` : formatSats(value * 1000);
  let invoiceSats = 0;
  // A single invoice can be melted at one mint only. Use the largest locally priced holding.
  for (const mint of new Set(proofs.map((proof) => proof.mint))) {
    const inputs = proofs.filter((proof) => proof.mint === mint);
    const fee = localInputFee(mint, inputs.map((proof) => proof.id));
    if (fee === undefined) continue;
    const balance = inputs.reduce((sum, proof) => sum + proof.amount, 0);
    invoiceSats = Math.max(invoiceSats, Math.floor(balance - fee - Math.max(2, balance * 0.01)));
  }
  let invoiceUsd: number | undefined;
  if (rate && invoiceSats > 0) {
    const cents = Math.floor(msatsToUsd(invoiceSats * 1000, rate) * 100);
    invoiceUsd = cents / 100;
    invoiceSats = Math.ceil(cents * 1_000_000 / rate);
  }
  const canSend = sats > 100;
  const invoiceDisplay = invoiceUsd === undefined ? amount(invoiceSats) : `$${formatUsd(invoiceUsd)}`;
  const offer = invoiceSats > 0 ? ` or an invoice for ${invoiceDisplay}` : "";
  return {
    rail: "cashu", amount_sats: sats, ...(rate ? { usd: amount(sats) } : {}), can_send_back: canSend,
    ...(canSend ? {
      ...(invoiceSats > 0 ? { invoice_amount_sats: invoiceSats } : {}),
      hint: "Run dvm wallet cash-out <lightning-address> --all or dvm wallet cash-out <invoice>.",
    } : {}),
    display: `${amount(sats)} of what you paid is left over from this job. ` + (canSend
      ? `I can keep it for your next job, or send it back to you; for that I need your Lightning address${offer}.`
      : "I'll keep it for your next job."),
  };
}

async function stablecoinRemaining(rail: "x402" | "tempo"): Promise<WalletRemaining | undefined> {
  const config = loadConfig();
  if (config?.[rail]?.generated !== true) return;
  let timer: ReturnType<typeof setTimeout> | number | undefined;
  try {
    const balance = await Promise.race([
      (async () => {
        if (rail === "x402") {
          const { loadX402Wallet } = await import("./x402/wallet");
          const wallet = loadX402Wallet();
          if (!wallet) return;
          return (await getX402Balance(await ensureAddress(wallet))).usdc;
        }
        const { connectedTempoAccount } = await import("./payment-rails/tempo-wallet");
        const account = await connectedTempoAccount();
        if (account) return (await getTempoUsdcBalance(account)).usdc;
      })(),
      new Promise<undefined>((resolve) => { timer = setTimeout(resolve, 3000); }),
    ]);
    if (balance === undefined || !Number.isFinite(balance) || balance <= 0) return;
    const usd = `$${formatUsd(balance)}`;
    return { rail, amount_usdc: balance, usd, can_send_back: false,
      display: `${usd} of what you paid is left over from this job. I'll keep it for your next job.` };
  } finally { clearTimeout(timer); }
}
