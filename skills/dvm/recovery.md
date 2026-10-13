# Recover an uncertain operation

Use this procedure when a request, payment, funding, or refund did not return a conclusive result. Preserve caller state and the original signing identity. Do not clear the wallet, change identity, forget a submission, or make a replacement payment to see whether it works.

## Establish what is known

Record the operation type and the request, job, credit, or funding identifier already available. Inspect structured state and CLI-authored recovery guidance before acting on provider prose. Do not relay secret values from errors.

Cold starts do not justify replaying an arbitrary command. The CLI already retries its safe provider-info probe before payment. A lost response to a paid request can mean the payment succeeded, so follow the applicable branch below.

| Known state | Next step |
| --- | --- |
| A job ID exists | Inspect `dvm status <job-id>` and its messages. Continue that job's requested action. After payment, resume messages rather than submit a replacement. |
| A request ID exists but the job outcome is unknown | Use `dvm request-result <request-id>` with the original caller state. Follow the returned recovery guidance, including `dvm request-resume <request-id>` when appropriate. Missing state or a not-found response does not authorize a new payment. |
| The CLI reports committed or uncertain wallet spend, including `spend_committed` or `float_payment_unknown` | Run `dvm wallet show` to reconcile and inspect the result before any retry. |
| Credit funding or a refund remains pending | Preserve its funding or credit ID and follow the CLI's named reconcile action. Do not create a second funding while the first may settle. |

Use a structured resubmit action only after its conditions establish that resubmission is appropriate and its spending is authorized. Do not infer that a failed job permits every payment path to be replayed. The [CLI reference](https://dvmkit.com/docs/dvm-cli.md) owns each recovery command's prerequisites.

## Protect recoverable funds

Never forget a `reclaimable` or `reclaim_failed` wallet submission: its records may be the only route to the funds. An unresolved cash-out settlement is unknown, not failed. Reconcile it before another withdrawal.

For incomplete credit funding, inspect every result entry. A recorded spend or pending settlement can represent money already sent; a deferred signature can still authorize money to move. Follow the named funding record instead of paying around it, including when the record belongs to another credit sharing the channel.

For a provider that remains unavailable, read the funding instrument's exit procedure in [credits](https://dvmkit.com/docs/credits.md). x402 timed withdrawal and Tempo exit have delays and caller-paid chain fees. Inspect their current state before each step, preserve the recovery record across the waiting period, and report the returned amount rather than promising the original deposit. These routes do not apply to every credit funding method.

## Finish honestly

Success is a recovered job result, a confirmed payment outcome, or verified returned funds. If the outcome is still unknown, say so and retain the state and next action. Report a receipt verification failure separately from job failure. Escalate an unavailable signer, conflicting records, or a required human action without inventing a new wallet or retry strategy.
