# Changelog

## [0.10.0](https://github.com/dvmkit/dvm-cli/compare/v0.9.2...v0.10.0) (2026-10-22)


### Features

* relay prompt choices in respond actions ([#21](https://github.com/dvmkit/dvm-cli/issues/21)) ([031afcf](https://github.com/dvmkit/dvm-cli/commit/031afcf8810446360f7814e26993674caddb7090))


### Bug Fixes

* **credit:** reconcile delayed receipts during job reads ([#14](https://github.com/dvmkit/dvm-cli/issues/14)) ([b56eea0](https://github.com/dvmkit/dvm-cli/commit/b56eea0e9f7f38042b3b18d0d7779b11dbc40b08))
* **credit:** reconcile signed mid-job funding ([48b56d3](https://github.com/dvmkit/dvm-cli/commit/48b56d3a4a1d5bde1ad07864a1b32853b01f1762))
* preserve caller state on Windows and verify runtime compatibility ([6368bee](https://github.com/dvmkit/dvm-cli/commit/6368beed5f0aade62a9887e1f8e8ab9f4851a837))

## [0.9.2](https://github.com/dvmkit/dvm-cli/compare/v0.9.1...v0.9.2) (2026-10-21)


### Bug Fixes

* preserve refused ecash funding for recovery ([3129ba9](https://github.com/dvmkit/dvm-cli/commit/3129ba9d7ab8a34556d7cf191c89dc63e2f063ff))

## [0.9.1](https://github.com/dvmkit/dvm-cli/compare/v0.9.0...v0.9.1) (2026-10-20)


### Bug Fixes

* **skill:** describe the dvm skill by the jobs it serves ([16cc632](https://github.com/dvmkit/dvm-cli/commit/16cc6321762b755394af7067d366794d06a004b6))

## [0.9.0](https://github.com/dvmkit/dvm-cli/compare/v0.9.0-rc.1...v0.9.0) (2026-10-20)


### Bug Fixes

* **deps:** use the stable SDK runtime ([452f6e7](https://github.com/dvmkit/dvm-cli/commit/452f6e74e132a16b83d6471eabe78bf50c5bd328))

## [0.9.0-rc.1](https://github.com/dvmkit/dvm-cli/compare/v0.8.2...v0.9.0-rc.1) (2026-10-20)


### Features

* pay mid-job requests from prepaid balance ([bbe42c0](https://github.com/dvmkit/dvm-cli/commit/bbe42c05c89be58ebacf9731ccdfe1fc3688214d))

## [0.8.2](https://github.com/dvmkit/dvm-cli/compare/v0.8.1...v0.8.2) (2026-10-20)


### Bug Fixes

* sign authenticated discovery requests ([1e03168](https://github.com/dvmkit/dvm-cli/commit/1e031682d3b2b4cc1f2e16c26fb06258ec77ae63))

## [0.8.1](https://github.com/dvmkit/dvm-cli/compare/v0.8.0...v0.8.1) (2026-10-18)


### Bug Fixes

* stop polling drains that require a timed exit ([#3](https://github.com/dvmkit/dvm-cli/issues/3)) ([9d6a088](https://github.com/dvmkit/dvm-cli/commit/9d6a0885ffd1b8a207b7926757b15757ea8eff40))

## 0.8.0 (2026-10-14)

This is the first stable-channel (`latest`) release from the new standalone repository. The CLI remains pre-1.0 alpha software: use small balances and review spending regularly.

### Included

- The `dvm` CLI discovers pay-per-use services, submits jobs, manages payments, and retrieves results. Commands return structured JSON by default; `--human` enables direct terminal reading.
- The complete bundled `skills/dvm` directory provides calling, wallet, prepaid-credit, and recovery procedures for agents.

### Compatibility and upgrade

Requires Node.js 22 or later and uses exactly `@dvmkit/sdk` 0.8.0. The stable channel does not imply a 1.0 compatibility guarantee; breaking changes will be announced in these release notes.

Update an existing global installation with `npm update --global @dvmkit/dvm-cli`. Then recopy the complete bundled `skills/dvm` directory, including its procedure files, into your agent's skill directory so the skill and CLI stay on the same package version. For a first installation, run `npm install --global @dvmkit/dvm-cli`, then `dvm init`; setup does not fund a wallet.

## 0.7.0 (2026-10-11)


### Features

* give credit-funded paid submits a generated request id


### Documentation

* document promoting a release-candidate line to stable

## 0.7.0-rc.3 (2026-10-11)


### Features

* verify provider job identity and never re-pay on an identity failure

## 0.7.0-rc.2 (2026-10-04)


### Bug Fixes

* **deps:** align caller with testnet withdrawal SDK

## 0.7.0-rc.1 (2026-10-03)


### Bug Fixes

* bind installed history fixture to shared ledger APIs


### Code Refactoring

* own caller orchestration and presentation

## 0.6.0 (2026-10-02)


### Features

* **wallet:** preserve spending and completed recovery history

## 0.5.0 (2026-10-02)


### Features

* report provider content expiry and availability

## 0.4.2 (2026-10-01)

- Update the SDK to 0.3.2-rc.10 so unresolved refund descriptors remain recoverable across credit rollovers without a count limit. Credit storage and recovery output remain compatible; previously evicted descriptors cannot be reconstructed by upgrading. Package and publication checks now exercise ten unresolved refunds through the installed caller.

- Explain when automatic credit funding is skipped because the service does not publish Bitcoin pricing.

## 0.4.1 (2026-09-28)


### Bug Fixes

* **skill:** load caller procedures on demand

## 0.4.0 (2026-09-26)


### Features

* **discovery:** render trust and capability rows
* **feedback:** submit receipt-backed job verdicts


### Bug Fixes

* **discovery:** accept unbounded trust history windows

## 0.3.0 (2026-09-21)


### Features

* add network-aware Tempo test wallets


### Bug Fixes

* wait through npm release processing

## 0.2.1 (2026-09-20)


### Bug Fixes

* bound capability expansion probes
* keep pending wallet operations visible with clear retry guidance when their outcome is unknown
* keep non-interactive JSON output free of progress messages while retaining interactive and human-mode notices
* preserve saved providers during concurrent CLI use and report unreadable data without overwriting it
* recover wallet funding and cash-out operations after interruptions, expired invoices, mint outages, and rate limits
* **release:** retry consumer registry propagation
* retain polling messages across repeated reads, including anonymous jobs
* validate discovery numeric options


### Maintenance

* share search and browse job handling while preserving their distinct output formats
* update the DVM SDK and Cashu dependencies and support Node.js 22 or newer

## 0.2.0 (2026-09-13)


### Features

* add exact mid-job payment controls


### Bug Fixes

* **release:** retry registry propagation

## 0.1.5 (2026-09-05)


### Features

* depend on the published SDK package and retire the vendored modules

## 0.1.4 (2026-09-04)


### Bug Fixes

* publish the caller as @dvmkit/dvm-cli

## 0.1.3 (2026-09-03)


### Bug Fixes

* compare Tempo dollar limits in native units

## 0.1.2 (2026-09-03)


### Bug Fixes

* **cli:** await asynchronous command actions

## 0.1.1 (2026-09-01)


### Bug Fixes

* **release:** recover release bookkeeping
* restore inherited credit posture

## 0.1.0 (2026-09-01)


### Bug Fixes

* preserve release candidate metadata


### Miscellaneous Chores

* **release:** prepare stable CLI release

## 0.1.0-rc.1 (2026-08-31)


### Features

* add client compatibility and standalone verification


### Bug Fixes

* allow public GitHub squash identities


### Continuous Integration

* complete the release candidate lifecycle
