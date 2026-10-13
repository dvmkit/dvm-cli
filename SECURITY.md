# Security policy

## Reporting a vulnerability

**Do not open a public issue, discussion, or pull request for a suspected vulnerability.** Use [GitHub private vulnerability reporting](https://github.com/dvmkit/dvm-cli/security/advisories/new) from this repository's Security tab. It is the only reporting route.

Include the affected `dvm` and Node.js versions, operating system and architecture, exact command, safe reproduction steps, reachable impact, and any suggested mitigation. Use synthetic values and never send an API key, wallet private key, seed phrase, recovery mnemonic, Cashu token or proof with value, Nostr Wallet Connect string, job token, access token, real payment data, customer content, or unredacted logs.

Stop testing if a proof moves funds, reaches another person's balance, exposes data that is not yours, or could degrade a running service. Do not access, change, or delete another person's data.

## Scope and supported versions

This policy covers the source in this repository and the latest published `@dvmkit/dvm-cli` release. Vulnerabilities in the hosted dvmkit platform or another dvmkit package may use the same private reporting route and will be routed internally.

Security fixes target the latest published release; there is no long-term-support or backport promise. We will assess reports as soon as practical, but this policy makes no response or remediation-time commitment.

## Coordinated disclosure

Give maintainers a reasonable opportunity to investigate and fix a report before publishing it. DVM Technologies Ltd will not pursue legal action over good-faith research that stays within this policy, avoids other people's data and service degradation, and allows a reasonable opportunity for remediation.
