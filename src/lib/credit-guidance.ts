export function repeatUseCreditHint(dvm: string): string {
  return (
    "First paid use settles per-call; ordinary repeat jobs use eligible credit automatically. " +
    `For 2+ calls, returning later, or a batch, inspect signed balance and funding headroom with 'dvm credit balance ${dvm}'; manually fund only user-authorized prepay/batches or a degraded mint.`
  );
}
