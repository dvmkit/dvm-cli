# Contributing to dvm

**This repository does not accept unsolicited pull requests, including documentation and typo fixes.** Outside pull requests are closed automatically without maintainer review. Issues and discussions are welcome: send a reproducible bug to the issue tracker, take features and design questions to [Discussions](https://github.com/dvmkit/dvm-cli/discussions), and report suspected vulnerabilities only through the private route in [SECURITY.md](SECURITY.md).

## What to send

| You have | Send |
| --- | --- |
| A reproducible CLI defect | A [bug report](https://github.com/dvmkit/dvm-cli/issues/new/choose) with the exact command and minimal case |
| Wrong or unclear documentation, including a typo | A [documentation report](https://github.com/dvmkit/dvm-cli/issues/new/choose); we will fix it |
| A feature idea, design question, or use case that does not fit | A [discussion](https://github.com/dvmkit/dvm-cli/discussions) |
| A suspected vulnerability | A private report through [SECURITY.md](SECURITY.md), never a public issue |
| Account, billing, or hosted dvmkit service trouble | The route in [SUPPORT.md](SUPPORT.md) |

A useful bug report names the operating system and architecture, shell, `dvm` and Node.js versions, exact command, expected and actual behaviour, and the smallest case that reproduces the failure. A failing test is welcome as an issue attachment or gist, but never as a pull request; use synthetic values and remove credentials, wallet material, job tokens, real payment data, and customer data.

## How fixes are made

Agents do research, implementation, and first review in this repository. A maintainer reproduces the reported behaviour, reviews the resulting change, and merges it, which is why a good reproduction is worth more to us than a patch.

Accepting an issue means only that the report is understood and worth tracking; it is not a delivery promise. Maintainers may implement a request themselves, choose a different design, or decline it, and reporting an issue does not confer roadmap or product-design authority.

## Pull requests

The closing workflow comments with the correct destination and closes unsolicited outside pull requests without checking out or executing their contents. Branches pushed to this repository and pull requests from maintainers, collaborators, and organisation members are not affected.

## Licensing and sign-off

The code is licensed under the [Apache License 2.0](LICENSE), which permits commercial use and includes an express patent licence for accepted contributions. That patent licence terminates for a party that brings patent litigation alleging that the work or an incorporated contribution infringes a patent, as section 3 explains.

Material intentionally submitted for inclusion in the project is offered under Apache-2.0 unless it is explicitly marked otherwise, as section 5 explains.

There is no contributor licence agreement. DCO sign-off and `Signed-off-by` trailers are neither required nor used while unsolicited pull requests are closed.

The licence grants rights in the code, not the dvmkit names or marks; see [TRADEMARKS.md](TRADEMARKS.md).

## Conduct

Participation in issues and discussions is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
