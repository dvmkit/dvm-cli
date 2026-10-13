# Set up and fund a wallet

Use this procedure when the task needs wallet setup, connection, funding, or a balance check. First inspect the existing state with `dvm doctor` and `dvm wallet setup`. Reuse a working setup; do not create a new wallet or change rails just because a different example is familiar.

## Choose the funding route

If the route is already chosen and supports the task, continue with it. Otherwise, establish the missing preferences: dollars or a small Bitcoin balance, tolerance for custody and public transactions, and a one-off deposit or standing replenishment under a cap. Do not force a questionnaire when the user has already answered these points.

Use the setup output's supported routes, `bestFor`, network, asset, and next command. No rail is the default. Fetch [funding](https://dvmkit.com/docs/funding.md) when routing from an exchange or another wallet; do not name supported withdrawal networks from memory. Have the user check the sending wallet's actual network and asset before transferring.

## Connect without exposing credentials

For a remote human connecting a Lightning wallet, use `dvm wallet pair`. Relay its verification instructions and private pairing link to that user, then follow the returned command. Never ask them to paste an NWC connection string into chat.

For a trusted local connection, pass credentials through the CLI's documented file or stdin option. Stablecoin private keys also support named environment variables. Do not interpolate a secret literal into a shell command, even when piping it: that can still enter command history or logs. A secret typed as an argument can also enter the process list. Treat it as exposed and arrange credential rotation; deleting the visible message is not recovery.

## Fund within authorization

Check the required amount and existing balance before topping up. Wallet funding and job payments both count toward spending caps; leave enough authorized headroom for both. Quote shell amounts containing a dollar sign, for example `dvm wallet fund '$5'`, so the shell does not substitute them.

For autonomous funding, follow the output until it reports the observed result. For human-assisted funding, send one short explanation, the exact invoice or address in its own code block, and the QR separately if supported. Never present a payment request as proof that funding completed. Confirm the balance through the CLI before continuing the job.

If funding or settlement is uncertain, keep its records and enter [recovery](recovery.md) before initiating another deposit. A low balance alone does not prove the previous attempt moved no money.

## Tests and completion

For disposable tests, use a separate `DVM_CONFIG_DIR` and explicitly select a supported test network. A development server or fresh config does not make funds fake. Keep the test state until payments and refunds are resolved; never replace the user's normal configuration with it.

Success means the intended wallet is connected on the intended network and its observed balance can fund the authorized task. Return to [calling](calling.md) or [credit](credit.md). For connection options, funding rails, and withdrawal procedures, read [wallets](https://dvmkit.com/docs/wallets.md) and [budgets](https://dvmkit.com/docs/budgets.md).

## Audit local history

Use `dvm wallet history` for durable spending, completed refunds/losses, and active recovery. `total_usd` is the displayed page's budget valuation, including funding once; draws, refunds, losses, and recovery do not add another outflow. A BTC-equivalent valuation does not establish the native payment rail. Preserve unknown currency and fee fields. Continue with `next_cursor` and the same filters; a stale continuation requires restarting, while `--offset` assumes unchanged records. History reads scan the retained archive even when the output page is short.
