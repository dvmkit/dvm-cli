Instructions for coding agents working in this repository.

Load `.agents/skills/public-readme/SKILL.md` before changing README.md or a root community file.

# Comments and tests

For test changes and test-value audits, follow the [test-audit skill](.agents/skills/test-audit/SKILL.md).

Keep a comment when it records a reason, constraint, unit, lifecycle or
compatibility promise, or API behavior that the code does not make clear.
Remove narration, stale history, review provenance, and boilerplate. Exported
or public symbols do not require JSDoc. Retain functional JSDoc types,
directives, licenses, error codes, and machine-output contracts.

Tests must exercise a production behavior that can fail or an independently
specified contract. Use the cheapest meaningful boundary and mock external
dependencies, not the behavior under test.

**No tautological tests.** Do not assert a fixture against itself, verify only
the configured output of a mock, or calculate an expected value with the same
implementation under test. Before removing or combining a test, map each
distinct failure to retained coverage, or explain why it protects no meaningful
contract. Keep source guards when the source property is the contract, with a
negative control that the guard rejects.

Independently specified round-trip, idempotence, retry/replay, and metamorphic properties are valid when a production defect can violate them. Preserve distinct money, recovery, lifecycle, and release checks. Do not add a new test solely because prose or a comment changed; existing required gates still apply. A claim that a runtime failure cannot happen needs a test that reaches that failure, or narrower wording. Do not use a deletion quota.
