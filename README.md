# dvm

The command-line client and agent skill for Digital Vending Machines: pay-per-use HTTPS services that AI agents can find, pay, and call with no account or API key.

Alpha software: run with small balances and review spend regularly. This is a pre-1.0 alpha; breaking changes are announced in the [release notes](./CHANGELOG.md).

Requires Node.js 22 or later.

## Install

```sh
npm install --global @dvmkit/dvm-cli
dvm init
```

`dvm init` returns JSON with `status: "created"` on first setup and the message "Local setup is ready. Nothing has been funded yet, so nothing can be spent yet." It also reports the configuration path and wallet setup steps.

## For agents

Copy the bundled [`dvm` skill](skills/dvm/SKILL.md) into your agent's skill directory. For Claude Code:

```sh
mkdir -p ~/.claude/skills
cp -R "$(npm root --global)/@dvmkit/dvm-cli/skills/dvm" ~/.claude/skills/
```

Codex uses `~/.codex/skills/` and other Agent Skills harnesses use `~/.agents/skills/`; [agent setup](https://dvmkit.com/docs/agent-setup) has the full list. Load the copied skill before asking your agent to run a job.

Keep the skill and CLI on the same package version. After `npm update --global @dvmkit/dvm-cli`, copy the skill again.

## First job

For a first job, ask your agent: "Load the dvm skill, find a service for my task, and show me its price before spending." The skill's calling procedure takes over from discovery through submitting a job and retrieving its result. If payment is needed, its wallet procedure explains the human steps for connecting or funding a wallet. Commands return structured JSON by default; use `--human` for direct terminal reading.

## What's in the package

| Entry point | Purpose |
| --- | --- |
| `dvm` | Discover services, submit jobs, manage payments, and retrieve results. |
| `skills/dvm` | Teach your agent the calling, wallet, credit, and recovery procedures. |

Reference: every command, flag, JSON shape, and error code is in the [dvm CLI reference](https://dvmkit.com/docs/dvm-cli).

## Next steps

- [Agent setup](https://dvmkit.com/docs/agent-setup): load the skill in your agent's harness.
- [Wallets](https://dvmkit.com/docs/wallets): connect a wallet when a job needs payment.
- [Budgets](https://dvmkit.com/docs/budgets): set limits before spending.

## Development

See [docs/development.md](docs/development.md) for building and verifying this repository.
Release automation is documented in [docs/releasing.md](docs/releasing.md).

## Community

Bug reports and discussions are welcome, but this repository does not accept unsolicited pull requests, including documentation and typo fixes. See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution policy and reporting routes.

Report suspected vulnerabilities only through the private route in [SECURITY.md](SECURITY.md).

See [SUPPORT.md](SUPPORT.md) for support boundaries and the [Code of Conduct](CODE_OF_CONDUCT.md) for community expectations.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
See [TRADEMARKS.md](TRADEMARKS.md) for the distinction between Apache-licensed code and dvmkit names and marks.
