import type { JobReceipt, JobStatus, Message, ProviderRef, Transport } from "@dvmkit/sdk/internal";

/**
 * The credit currency a piece settlement is denominated in, for reads with no
 * local job record (portable access). The receipt names no currency, so take
 * the provider's own: the job's upfront draw, its latest ask, then `/v1/info`.
 * Read only when the receipt carries a settlement; a failed read returns
 * nothing, and the display falls back to the amount labelled "(currency not
 * recorded)" with a hint explaining why.
 */
export async function providerCurrency(args: {
  receipt?: JobReceipt;
  status?: Pick<JobStatus, "upfrontPayment">;
  messages?: Message[];
  transport: Transport;
  ref: ProviderRef;
}): Promise<string | undefined> {
  if (!args.receipt?.settlement) return undefined;
  const upfront = args.status?.upfrontPayment?.currency;
  if (upfront) return upfront;
  const ask = [...(args.messages ?? [])].sort((a, b) => a.seq - b.seq)
    .findLast((message) => message.from === "provider" && message.type === "payment-request" && message.content.credit?.currency);
  if (ask?.type === "payment-request" && ask.content.credit) return ask.content.credit.currency;
  try {
    return (await args.transport.describe(args.ref, { timeoutMs: 5000 })).credit?.currency;
  } catch {
    return undefined;
  }
}
