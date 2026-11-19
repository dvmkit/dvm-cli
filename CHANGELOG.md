# Changelog

## Unreleased

### Features

* Define an additive JSON contract for core job actions, recovery identifiers and states, and existing recovery commands in the bundled recovery guide. Pay and refund `amount_msats` remain provisional; unknown action types require human review.
* Remove the never-emitted `approve` action declaration. Pre-1.0 breaking contract changes require migration notes and a minor version bump.

### Bug Fixes

* Failed Cashu spend preparation replaces raw dependency errors with bounded explanations and redacts mint URLs in attempt entries and summaries. Error and reason codes remain unchanged; consumers parsing failure prose should use those codes and follow recovery hints instead. Summaries are limited to 4,096 characters, while every ordered attempt remains available.
* x402 credit funding and cooperative refunds discard settlement state naming another channel or carrying an amount above the uint256 maximum. Funding resumed after a restart checks the saved payment's channel, and discarded state does not turn an accepted funding into a failed payment.
* `wallet release` reports the original output lock policy when recovering an interrupted swap. JSON consumers must handle `output_mode: "mixed"` when returned outputs have different policies across mints; the new `mints[].output_mode` reports `locked`, `unlocked`, or `null` when that mint returned no new outputs. When no mint returns outputs, the top-level field retains the requested policy.

## [0.22.1](https://github.com/dvmkit/dvm-cli/compare/v0.22.0...v0.22.1) (2026-11-19)


### Bug Fixes

* **cli:** reconcile mandate payments from cached history ([7ae1d6d](https://github.com/dvmkit/dvm-cli/commit/7ae1d6d6c7449090907ed4e89bd9917584c99c10))

## [0.22.0](https://github.com/dvmkit/dvm-cli/compare/v0.21.0...v0.22.0) (2026-11-19)


### Features

* **wallet:** collect relayed funding invoices in the foreground ([39b5210](https://github.com/dvmkit/dvm-cli/commit/39b521017ec79ada63cee1778b4565cd5d8ed0a6))


### Bug Fixes

* **credit:** report timed-out drains with same-ID retry guidance ([42f0f81](https://github.com/dvmkit/dvm-cli/commit/42f0f81de266503d972c98f04180345a67552dd4))
* make config pin preservation explicit ([f49d899](https://github.com/dvmkit/dvm-cli/commit/f49d899241a96618457cf124f05b2e6ad8cd4a37))
* **messages:** retry gateway errors during job waits ([78032c0](https://github.com/dvmkit/dvm-cli/commit/78032c0178ce6e513a4fcd59197eac3e06042490))
* **messages:** retry mandate guard reads during waits ([02345ee](https://github.com/dvmkit/dvm-cli/commit/02345ee7d70a75acf41efb6c50d4a58374ff236a))
* **messages:** verify mandate payment links before warning ([2c7c981](https://github.com/dvmkit/dvm-cli/commit/2c7c981f03dedc3b70266a258f2864bf4b16ae4f))
* **transport:** give failed status reads a safe retry hint ([23717e3](https://github.com/dvmkit/dvm-cli/commit/23717e3f5ace44e4602b77ac5271b56d5723f7e7))

## [0.21.0](https://github.com/dvmkit/dvm-cli/compare/v0.20.0...v0.21.0) (2026-11-17)


### Features

* **messages:** recognise mandate-paid asks and keep them within the signed limits ([#121](https://github.com/dvmkit/dvm-cli/issues/121)) ([c21eb65](https://github.com/dvmkit/dvm-cli/commit/c21eb6580985bee8ed50e53d791ff7b64dd5a9df))
* **request:** sign a standing mandate when auto-pay limits pay from credit ([#119](https://github.com/dvmkit/dvm-cli/issues/119)) ([1f2f67b](https://github.com/dvmkit/dvm-cli/commit/1f2f67bd7b459138c8a36bce041e8743614e10c6))


### Bug Fixes

* **credit:** try landed credit before asking for a choice, and give usable commands in the hint ([#122](https://github.com/dvmkit/dvm-cli/issues/122)) ([5ee4568](https://github.com/dvmkit/dvm-cli/commit/5ee4568504e024a81d0731c1d0e2ab1a66e68beb))

## [0.20.0](https://github.com/dvmkit/dvm-cli/compare/v0.19.2...v0.20.0) (2026-11-17)


### Features

* **credit:** support manual Lightning invoice funding ([0891cac](https://github.com/dvmkit/dvm-cli/commit/0891cacd1e74094ac2ad04f081a051f433821098))
* **wallet:** itemise Cashu mint fees in job results and cash-out ([704285c](https://github.com/dvmkit/dvm-cli/commit/704285c189827c403c80d9e2edab62bcc3d89a6e))


### Bug Fixes

* **credit:** honor advertised card funding minimums ([e7ceef1](https://github.com/dvmkit/dvm-cli/commit/e7ceef15dbff3e87ccbf305ea7fc223753682881))
* **credit:** reconcile expired automatic Lightning funding before retiring it ([1ad1a10](https://github.com/dvmkit/dvm-cli/commit/1ad1a10aabb8020f0ef9c77011c84d704137ff88))
* **credit:** refuse a replacement Lightning invoice unless the wallet proves the original unpaid ([b78fc48](https://github.com/dvmkit/dvm-cli/commit/b78fc480d2dad913eda18edabed96f23e9b95cbc))
* **credit:** report paid Lightning refusals in balance output ([52b93a6](https://github.com/dvmkit/dvm-cli/commit/52b93a609880539deff9910a65c378a768763543))
* **errors:** name an internal error's throw site and keep its details in a private log ([#116](https://github.com/dvmkit/dvm-cli/issues/116)) ([6d5aaea](https://github.com/dvmkit/dvm-cli/commit/6d5aaea52743a69639682b976b908f54380113f5))
* **messages:** accept compound --until durations and report a malformed one as invalid arguments ([#117](https://github.com/dvmkit/dvm-cli/issues/117)) ([78762c4](https://github.com/dvmkit/dvm-cli/commit/78762c49da5637da7f41a8804a5e65bfb7b116c8))
* **messages:** keep a wait attached through a provider that is briefly unreachable ([#118](https://github.com/dvmkit/dvm-cli/issues/118)) ([359fc5d](https://github.com/dvmkit/dvm-cli/commit/359fc5d81b3cb50a605c428d1712f7088c53d150))
* **receipts:** resolve currency from matching rail prices ([766be94](https://github.com/dvmkit/dvm-cli/commit/766be941fe078671214f1bf150946dfbd85adeb2))
* **setup:** exclude missing wallets from partial setup warnings ([6d83ba8](https://github.com/dvmkit/dvm-cli/commit/6d83ba8b346a7d935478ee33795e64c5c985177e))
* **wallet:** bound failed Cashu spend diagnostics ([47aa613](https://github.com/dvmkit/dvm-cli/commit/47aa6131c4a48e3e5246a80e8a43d23e289bd120))
* **wallet:** reuse the unpaid melt quote when cashing out a fixed invoice ([f7c9274](https://github.com/dvmkit/dvm-cli/commit/f7c9274a49e5f96ed1991065fd879bf933f464d6))

## [0.19.2](https://github.com/dvmkit/dvm-cli/compare/v0.19.1...v0.19.2) (2026-11-16)


### Bug Fixes

* **credit:** book card-funded credit draws and explain unusable upfront debits ([acd824f](https://github.com/dvmkit/dvm-cli/commit/acd824f6a8493cb7549066e7671ee1bcc2248a34))
* **wallet:** receive Cashu tokens through stdin ([430c1d8](https://github.com/dvmkit/dvm-cli/commit/430c1d8756e3b6f39a2b0e56c0e63bb0378d9bb8))

## [0.19.1](https://github.com/dvmkit/dvm-cli/compare/v0.19.0...v0.19.1) (2026-11-15)


### Bug Fixes

* **jobs:** explain unattended payment expiry ([db950e7](https://github.com/dvmkit/dvm-cli/commit/db950e7be080aa1bd79ac77f5fd8a98d7a556918))
* **output:** preserve command warnings on JSON errors ([d3cb9a6](https://github.com/dvmkit/dvm-cli/commit/d3cb9a666e9f556149095b1dcd62b0145091841a))
* **wallet:** keep unpaid funding quotes until the mint confirms they are gone ([f661514](https://github.com/dvmkit/dvm-cli/commit/f661514b07bf83dcaa5838f4a796ce738e673abf))

## [0.19.0](https://github.com/dvmkit/dvm-cli/compare/v0.18.0...v0.19.0) (2026-11-12)


### Features

* **credit:** top up prepaid credit by card through a hosted checkout link ([#92](https://github.com/dvmkit/dvm-cli/issues/92)) ([9b181a9](https://github.com/dvmkit/dvm-cli/commit/9b181a9917ba5a359d552631bc8284520b422bea))

## [0.18.0](https://github.com/dvmkit/dvm-cli/compare/v0.17.0...v0.18.0) (2026-11-12)


### ⚠ BREAKING CHANGES

* **messages:** `dvm messages <job> --wait` no longer prints a single JSON document. Read stdout line by line: act on the `next_action` of the last line (`event: "result"`), or handle its `error` (`event: "error"`). Collect messages and auto-payments from the `message` and `payment` lines instead of the removed `messages` and `auto_payments` arrays.

### Features

* **messages:** stream --wait events as JSON lines ([#89](https://github.com/dvmkit/dvm-cli/issues/89)) ([d3db1ad](https://github.com/dvmkit/dvm-cli/commit/d3db1ad8aea7d57dbc8f72d17e860032006ff201))
* **pay:** approve a new total budget for a running job ([#90](https://github.com/dvmkit/dvm-cli/issues/90)) ([965e3b4](https://github.com/dvmkit/dvm-cli/commit/965e3b4a33bd42f92695386e6cdd4953c75f9eab))


### Bug Fixes

* **budget:** hold a dollar budget to dollar-priced asks in dollars ([#88](https://github.com/dvmkit/dvm-cli/issues/88)) ([bf533f8](https://github.com/dvmkit/dvm-cli/commit/bf533f89ad1350f48456e025f61b79c60dc38789))
* **credit:** show the prepaid-credit suggestion once a week per DVM, only after a paid request ([#87](https://github.com/dvmkit/dvm-cli/issues/87)) ([a8a4f51](https://github.com/dvmkit/dvm-cli/commit/a8a4f515200fbf0c8f5d95a8c7e4a76d7d74f08d))
* **messages:** state the true reason in wait, budget and credit next steps ([#86](https://github.com/dvmkit/dvm-cli/issues/86)) ([690c8cf](https://github.com/dvmkit/dvm-cli/commit/690c8cfc8ee6020fc79feb4010e50db967ffde7a))

## [0.17.0](https://github.com/dvmkit/dvm-cli/compare/v0.16.0...v0.17.0) (2026-11-12)


### Features

* tell the caller what is left in the agent wallet when a job ends ([#84](https://github.com/dvmkit/dvm-cli/issues/84)) ([a87f134](https://github.com/dvmkit/dvm-cli/commit/a87f134e87495764ea78ee04639a9a4f9df09292))
* **wallet:** let cash-out pay a Lightning invoice ([#83](https://github.com/dvmkit/dvm-cli/issues/83)) ([09c0a21](https://github.com/dvmkit/dvm-cli/commit/09c0a2121d537f4cd9bd452047b35da8c65dedf6))

## [0.16.0](https://github.com/dvmkit/dvm-cli/compare/v0.15.3...v0.16.0) (2026-11-12)


### Features

* **wallet:** hand off funding invoices without waiting ([b11cfef](https://github.com/dvmkit/dvm-cli/commit/b11cfef56d7afdce90528fbb0f0d01e4442977cd))


### Bug Fixes

* compare USD quote limits across payment rails ([a507961](https://github.com/dvmkit/dvm-cli/commit/a5079610170dec6bcef8a10c51c275df7eb8d55b))
* **credit:** bind x402 settlement state to the paid channel ([d6a6ffa](https://github.com/dvmkit/dvm-cli/commit/d6a6ffaad8b4667461ad094d6f1ea871afba5652))
* **credit:** suggest wallet invoices for Lightning funding refusals ([ea7d665](https://github.com/dvmkit/dvm-cli/commit/ea7d6651b68f28da28ff7d8f0e5fb57e3d173fb5))
* preserve accepted job access when local saves fail ([fd202f8](https://github.com/dvmkit/dvm-cli/commit/fd202f81492dc7f8ec83cf6cbed677155a4cf717))

## [0.15.3](https://github.com/dvmkit/dvm-cli/compare/v0.15.2...v0.15.3) (2026-11-07)


### Bug Fixes

* **credit:** report already drained for a repeat tempo drain ([1469652](https://github.com/dvmkit/dvm-cli/commit/1469652aa18330b6660d388147dce7eee593674a))
* drain verification diagnostics before exiting ([a65ee22](https://github.com/dvmkit/dvm-cli/commit/a65ee22fd97b1703368f00b1973df169de7458b9))
* make reserve release swaps recoverable ([d9f5e6a](https://github.com/dvmkit/dvm-cli/commit/d9f5e6a4da12cce0c40a76896141bb6d1163c5da))
* retry job storage locks and preserve accepted outcomes ([5e0216e](https://github.com/dvmkit/dvm-cli/commit/5e0216e2516f635684ebdbfd25d74ee129544935))

## [0.15.2](https://github.com/dvmkit/dvm-cli/compare/v0.15.1...v0.15.2) (2026-11-07)


### Bug Fixes

* reconcile job read actions with local payment state ([cc1298a](https://github.com/dvmkit/dvm-cli/commit/cc1298a0a65c7e64821963889ab646258fbc6ead))
* reflect credit posture in drawability reports ([29c0ab8](https://github.com/dvmkit/dvm-cli/commit/29c0ab85d24181dd7b6b88c28afb22c31a1cebe2))
* report live implicit balances as released credit ([633ec55](https://github.com/dvmkit/dvm-cli/commit/633ec55b0d3a72f55aeef672653d7ca0e3f9f87c))
* **request:** preserve definitive refusals with request IDs ([d845b0d](https://github.com/dvmkit/dvm-cli/commit/d845b0d9a72848560b0b90859170284d52bfcdd4))
* **request:** report requests refused before sending as not submitted ([fa53244](https://github.com/dvmkit/dvm-cli/commit/fa532445ea26bd61b78f24d1c3a57a2e261b0630))
* surface finished artifacts on ended jobs ([b7a933a](https://github.com/dvmkit/dvm-cli/commit/b7a933ad939178d47386d6d335c6d3d8469c86cc))
* **wallet:** persist reclaim swap outputs before the mint call ([c07d34e](https://github.com/dvmkit/dvm-cli/commit/c07d34e67d1ae8a913d9ecaa2a22999973559fa8))

## [0.15.1](https://github.com/dvmkit/dvm-cli/compare/v0.15.0...v0.15.1) (2026-11-06)


### Bug Fixes

* **payments:** never pay an open ask twice after a lost delivery ([#61](https://github.com/dvmkit/dvm-cli/issues/61)) ([3b3acf7](https://github.com/dvmkit/dvm-cli/commit/3b3acf7c443e24028214c366d292c576a75b3c5c))

## [0.15.0](https://github.com/dvmkit/dvm-cli/compare/v0.14.0...v0.15.0) (2026-11-06)


### Features

* **credit:** exempt card top-ups from the first-contact trust cap ([8d01b54](https://github.com/dvmkit/dvm-cli/commit/8d01b547ea82df18c4f8e3ccf6c8bf5176cdde44))
* enforce CLI error-code compatibility ([0a82184](https://github.com/dvmkit/dvm-cli/commit/0a821844266cfdf4f5f1fce1155886530d02db72))
* stabilize core job recovery contracts ([1aef1a8](https://github.com/dvmkit/dvm-cli/commit/1aef1a8105a983acb9c1cc101639acffbdfa6f0b))


### Bug Fixes

* **credit:** show card funding minimum and approval guidance ([654a828](https://github.com/dvmkit/dvm-cli/commit/654a82828bf17299601b8c242196762f673bd568))
* **credit:** stop false funding warnings and explain the real ones ([#60](https://github.com/dvmkit/dvm-cli/issues/60)) ([7a11f39](https://github.com/dvmkit/dvm-cli/commit/7a11f39f0fe106c4a283e1781acbca8209e4aa13))
* **discovery:** preserve job access after timeouts ([ef4e7cc](https://github.com/dvmkit/dvm-cli/commit/ef4e7ccc1cf9f5cfb8bd93d5e2a8452345a8eb97))
* **receipts:** show charges in fiat and explain every unlabelled amount ([#59](https://github.com/dvmkit/dvm-cli/issues/59)) ([4633aa3](https://github.com/dvmkit/dvm-cli/commit/4633aa349242d67a6ff0363c8b8645e10a37b575))

## [0.14.0](https://github.com/dvmkit/dvm-cli/compare/v0.13.0...v0.14.0) (2026-11-03)


### Features

* hand unpaid asks to the agent and add dvm decline ([#51](https://github.com/dvmkit/dvm-cli/issues/51)) ([1371278](https://github.com/dvmkit/dvm-cli/commit/1371278a48886f9be526dd4d803ef097dae8a569))

## [0.13.0](https://github.com/dvmkit/dvm-cli/compare/v0.12.1...v0.13.0) (2026-11-02)


### Features

* **credit:** fund and refund prepaid credit by card through Stripe Link ([#50](https://github.com/dvmkit/dvm-cli/issues/50)) ([531c505](https://github.com/dvmkit/dvm-cli/commit/531c505b0489bb2be9f4c4508a7a750f491dbbc9))

## [0.12.1](https://github.com/dvmkit/dvm-cli/compare/v0.12.0...v0.12.1) (2026-11-02)


### Bug Fixes

* **credit:** scope draw price checks to capabilities ([1ffd9bd](https://github.com/dvmkit/dvm-cli/commit/1ffd9bd1e1c00a66226aeab3d9f9e0ba91933cf0))
* distinguish provider failures from caller cancellations ([52f59b5](https://github.com/dvmkit/dvm-cli/commit/52f59b5aae0e8ace98bfb6a97f0a4ea7ab94130c))
* include accepted job recovery in payment errors ([59da545](https://github.com/dvmkit/dvm-cli/commit/59da545bfa66879bd2b88052bf5bf8b7915a1f0a))
* **payments:** keep stablecoin receipt comparisons unknown ([f6cb230](https://github.com/dvmkit/dvm-cli/commit/f6cb23050413ca365b0174b198ef8ccaf388a85c))
* report terminal job settlement outcomes ([ab1e380](https://github.com/dvmkit/dvm-cli/commit/ab1e3800c5140df8eca4f20b7763e32ed5d695a8))
* resolve capability URLs against provider endpoints ([9e44fde](https://github.com/dvmkit/dvm-cli/commit/9e44fde8dc8e805ac8f3f5d82804bee8accb395b))

## [0.12.0](https://github.com/dvmkit/dvm-cli/compare/v0.11.3...v0.12.0) (2026-10-30)


### Features

* explain metered auto-pay limits ([d4cf491](https://github.com/dvmkit/dvm-cli/commit/d4cf4913c279a5bf163d7d3e39d07db1812e50e1))

## [0.11.3](https://github.com/dvmkit/dvm-cli/compare/v0.11.2...v0.11.3) (2026-10-28)


### Bug Fixes

* preserve mint diagnostics after successful Cashu fallback ([c3374e7](https://github.com/dvmkit/dvm-cli/commit/c3374e72d245aefd39b87972e9c8b43f0b585619))

## [0.11.2](https://github.com/dvmkit/dvm-cli/compare/v0.11.1...v0.11.2) (2026-10-26)


### Bug Fixes

* **discovery:** keep operator ownership in search and browse output ([#35](https://github.com/dvmkit/dvm-cli/issues/35)) ([1d6869d](https://github.com/dvmkit/dvm-cli/commit/1d6869d8c2bdcbaa5311557b495e933417e99613))
* **output:** mark provider provenance on the remaining provider-supplied fields ([#36](https://github.com/dvmkit/dvm-cli/issues/36)) ([a707167](https://github.com/dvmkit/dvm-cli/commit/a707167286bc4aaa182a4b6a96bc1c3320a11c51))

## [0.11.1](https://github.com/dvmkit/dvm-cli/compare/v0.11.0...v0.11.1) (2026-10-26)


### Bug Fixes

* mark provider prose in prompt choices and schemas ([#34](https://github.com/dvmkit/dvm-cli/issues/34)) ([1108226](https://github.com/dvmkit/dvm-cli/commit/1108226e0c1156164dc1db5fc5af72ae94976983))

## [0.11.0](https://github.com/dvmkit/dvm-cli/compare/v0.10.0...v0.11.0) (2026-10-25)


### Features

* relay caller deadlines with SDK 0.14.2 ([#28](https://github.com/dvmkit/dvm-cli/issues/28)) ([d919e11](https://github.com/dvmkit/dvm-cli/commit/d919e11830a6c20142f082079d4887eb9a8cd596))
* show itemized job spending in status ([#25](https://github.com/dvmkit/dvm-cli/issues/25)) ([74a6a18](https://github.com/dvmkit/dvm-cli/commit/74a6a18dd886949f66b661755841290e26dfb4fb))
* show next steps in human job output ([#23](https://github.com/dvmkit/dvm-cli/issues/23)) ([0db413c](https://github.com/dvmkit/dvm-cli/commit/0db413cc90ec2fdc92bc1cf88be2bf8a6ffb855d))
* verify downloaded files against signed receipts ([#22](https://github.com/dvmkit/dvm-cli/issues/22)) ([5e54814](https://github.com/dvmkit/dvm-cli/commit/5e54814d08b8477b2937161fb4682d064422ee25))
* wait for long jobs within stored payment policy ([#26](https://github.com/dvmkit/dvm-cli/issues/26)) ([9ce8515](https://github.com/dvmkit/dvm-cli/commit/9ce8515fece9748319811f66b1815534c089e5f9))


### Bug Fixes

* delay retries for uncertain job payments ([#29](https://github.com/dvmkit/dvm-cli/issues/29)) ([208ba1c](https://github.com/dvmkit/dvm-cli/commit/208ba1cddfcf4f1ebe0a74c2dc6821751f701332))
* **payments:** count upfront credit draws toward job limits ([094c268](https://github.com/dvmkit/dvm-cli/commit/094c2686441a412e40df53a84950f4b3f1a8b471))
* **payments:** restore upfront rail accounting during recovery ([5d94cf5](https://github.com/dvmkit/dvm-cli/commit/5d94cf5e78b27f381b6567af4a0a2646690dfb24))
* refresh pending payment requests before paying ([7fc7a90](https://github.com/dvmkit/dvm-cli/commit/7fc7a90d90977ead1f22df80dd40f867c52f50ed))

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
