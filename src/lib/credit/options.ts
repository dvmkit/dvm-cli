
export interface CreditListOptions {
  human?: boolean;
}

export interface CreditPostureOptions {
  human?: boolean;
  /** Scope the posture to one DVM instead of every DVM (name, @favorite, or URL). */
  dvm?: string;
  /** Remove the posture override at one DVM and inherit the global/default posture. */
  clear?: boolean;
}

export interface CreditRailOptions {
  human?: boolean;
  /** Scope the funding-rail pin to one DVM instead of every DVM. */
  dvm?: string;
  /** Remove the pin and return this scope to the next layer or the amount rule. */
  clear?: boolean;
}

export interface CreditBalanceOptions {
  human?: boolean;
  /** Caller signing identity ( resolution ladder when unset). */
  as?: string;
  /** Query this exact caller-owned credit; selects it unless observation-only. */
  creditId?: string;
  /** Observe signed server state without polling funding or changing local state. */
  observeOnly?: boolean;
  /** Select the exact signed credit without polling pending funding. */
  selectionOnly?: boolean;
}

export interface CreditDeselectOptions {
  human?: boolean;
  creditId: string;
  as?: string;
}

export interface CreditFundOptions {
  human?: boolean;
  /** Caller signing identity ( resolution ladder when unset). */
  as?: string;
  /** How much to load, e.g. `$2` or `0.50`. Defaults to the tracked refill gap. */
  amount?: string;
  /**
   * Size the funding to a known workload instead of a figure: N jobs' worth at
   * this DVM's price. Mutually exclusive with `amount`.
   */
  targetJobs?: string;
  /**
   * Name the over-trust funding. An explicit amount that would leave more on
   * deposit than the trust tier permits is refused unless this is set, or a
   * `trustOverrides` pre-grant covers the DVM's builder pubkey.
   */
  overTrust?: boolean;
  rail?: string;
  /**
   * Force a one-shot or reusable stablecoin instrument instead of letting the
   * rail's own preference pick. Both modes fund prepaid credit.
   */
  fundingMode?: string;
  creditId?: string;
  /** Pin a Cashu funding to one DVM-accepted mint. */
  cashuMint?: string;
  /** Maximum Cashu token principal, in sats, for this funding. */
  maxCashuPrincipalSats?: string;
  /** Maximum Cashu swap fee, in sats, for this funding. */
  maxCashuFeeSats?: string;
}

export interface CreditDrainOptions {
  human?: boolean;
  /** Caller signing identity ( resolution ladder when unset). */
  as?: string;
  creditId?: string;
  /**
   * Re-post one specific drain id rather than the one recorded for the credit.
   * The way back to a drain this store can't attribute on its own — an entry
   * written before drains carried their credit id, or an id the caller has
   * only from an earlier command's output.
   */
  drainId?: string;
  /**
   * Retire an exact stale local x402 drain marker from verified terminal
   * receipts without posting it to the DVM. Intended for proof-backed
   * recovery tooling that already holds the independently verified chain
   * transaction the ordinary poll would otherwise recover.
   */
  recoverFromReceipts?: boolean;
  /** Payout rail: `cashu`, `x402`, or cooperative `tempo`. */
  method?: string;
  /**
   * EVM address to refund to on a one-payment stablecoin credit — an x402
   * `exact` authorization or a Tempo charge. A channel-backed credit
   * fixes its payer in the channel and takes no address. Defaults to the wallet
   * already connected on the rail being drained.
   */
  address?: string;
}

export interface CreditReceiptsOptions {
  human?: boolean;
  /** Caller signing identity whose stored evidence to read ( ladder when unset). */
  as?: string;
  drainId?: string;
  /** Write the raw bundles to stdout as JSONL, un-enveloped, for a third party. */
  export?: boolean;
  /** Grade against the DVM's live `/v1/info#builder` instead of the pinned anchor. */
  refetch?: boolean;
}
