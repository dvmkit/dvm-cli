# Use and reclaim prepaid credit

Use this procedure for repeated work at a service, an existing credit balance, credit settings, or reclaiming unused funds. Ordinary per-call payment does not require prepayment. A suggestion to fund credit is an offer to consider, not permission to buy it.

## Inspect before funding

Read `dvm credit list` and `dvm credit balance <dvm>` for the selected provider and signing identity. Establish the active balance, any sibling balances, and the effective posture. Reuse funds already held before proposing new funding.

Explain the distinction that affects consent: drawing existing credit spends a balance already parked at the provider; funding or refilling it moves new money. The CLI can draw held credit without `--auto-pay`. Posture `off` stops drawing as well as funding; a per-job budget can also prevent a draw. When output says credit was skipped, relay its reason instead of claiming the provider refused it.

## Fund or change posture

For planned repeat work, use the provider's offer and a workload-sized target such as `--target-jobs`, bounded by the user's cap. Present the amount, rail, and refund implications before a new purchase. Enabling posture `auto` is standing authorization, so establish its scope and limits first; do not enable it merely to remove a prompt.

Use only a funding route offered by the provider and supported by the wallet. Lightning may fund prepaid credit directly when its advertised floor is met. Stablecoin funding can use a reusable channel or an explicitly admitted one-payment instrument; these have different reclaim paths. Read the [credit funding contract](https://dvmkit.com/docs/credits.md) before choosing an instrument. Do not silently switch the rail or instrument of an existing balance.

After funding or an automatic refill, inspect every funding result, not just the first. One command may produce more than one purchase. Report the actual completed spend and anything incomplete separately. An unknown or pending settlement must go through [recovery](recovery.md), not another funding command.

When `credit_funding_skipped` reports unavailable BTC/USD pricing, relay its `display` and `hint`. Automatic funding remains enabled, and this request follows the ordinary per-call payment path; the notice does not report a prepaid purchase or authorize another one.

## Draw and reclaim

Return to [calling](calling.md) for jobs. Keep the same signing identity. If the CLI reconciles funding onto another credit ID, inspect that named balance and follow its selection guidance before the next job; do not buy again to make the balance appear.

To reclaim unused credit, inspect the balance and use `dvm credit drain <dvm>` with the indicated credit ID when necessary. Distinguish a requested refund, a pending settlement, and funds actually returned. Provider-marked refund text is the provider's account of events; it does not override the CLI's verified state.

If the provider cannot answer, the available recovery depends on the original funding instrument. Channel exits can recover remaining collateral after the required delay; one-payment funding may depend on a provider refund. Follow [recovery](recovery.md) and the published contract before promising an amount or a completion time. Expiry alone is not proof of a refund or continued recoverability.

Success means the selected credit can fund the intended jobs, the posture matches the user's authorization, or the reclaim has a verified result. Keep pending obligations explicit. Exact flags, posture scope, expiry, and settlement behavior live in [credits](https://dvmkit.com/docs/credits.md).

## Keep offline reclaim evidence

Read `dvm credit receipts <dvm>` or export with `--export`; archived completed refunds remain available after the working projection drops older bundles. Keep the original caller signing identity and endpoint. Exports preserve signed receipts and their pinned builder anchor for offline verification, with native settlement fields and honest unknowns. A local settlement timestamp is an unsigned observation, separate from receipt authentication. Unsupported receipt or identity fields fail export rather than stripping signed fields or exposing recovery credentials; use `--drain-id` to select a supported bundle. Pending recovery stays pending and belongs in the recovery procedure.
