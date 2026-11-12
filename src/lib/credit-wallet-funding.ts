export function walletInvoiceFundingAdvice(amountMicro: number): { command: string; text: string } {
  // Commands must preserve micro-unit precision; display rounding can change the requested amount.
  const amount = (amountMicro / 1_000_000).toFixed(6).replace(/(\.\d{2,}?)0+$/, "$1");
  const command = `dvm wallet fund '$${amount}' --no-float`;
  return {
    command,
    text: `Run ${command} to get one invoice to pay from any Lightning wallet, then pay the job from the agent's ecash wallet.`,
  };
}
