# Development

Use the exact Node.js release in `.nvmrc`. Install with `node scripts/pinned-npm.mjs ci --ignore-scripts`, then run the same local gate as CI with `node scripts/pinned-npm.mjs run verify`. The bootstrap downloads the exact npm release declared in `package.json`, verifies its integrity before every extraction, and keeps it under the ignored repository-local `.tooling/` directory.

`npm run verify` checks repository metadata in the checkout, copies only tracked and unignored source into an isolated directory, installs its locked dependencies, and runs lint, build, typecheck, the full test suite, package/upgrade smoke, packed-artifact safety, and release checks there. The clean source tree owns the only complete build and test pass, so verification cannot reuse the checkout's `node_modules` or pre-existing `dist`; after every check passes, its verified `dist` replaces the checkout's build output for release packaging.

Release automation is documented in [docs/releasing.md](./releasing.md). It prepares a reviewed release pull request and only a separately signed immutable tag can enter the GitHub-hosted npm trusted-publishing path.

## CLI error-code inventory

`cli-error-codes.json` records CLI-authored JSON error codes. The compatibility
baseline is additive: a code may be added, but removing or renaming an inventoried
code fails verification. This covers names, including the local `internal`
fallback, rather than error prose, the conditions that raise an error, or
`next_action` and recovery fields. Provider-owned codes and unchanged dependency
errors carry no CLI compatibility promise. A name authored locally remains in
the inventory even if a provider can also emit that name.

Check the committed baseline without rewriting it:

```sh
node scripts/pinned-npm.mjs run check:error-codes
```

After adding a locally authored code, extend the baseline and commit it with the
source change:

```sh
node scripts/pinned-npm.mjs run update:error-codes
node scripts/pinned-npm.mjs run check:error-codes
```

The update sorts and deduplicates discovered codes and refuses removals before
writing. It cannot turn a rename into an additive change by deleting the old
promise. Normal verification and CI run only the check command.

Discovery parses production TypeScript under `src`, excluding tests, fixtures,
test support, declarations, and dependency source. It traces constructor arguments,
local constants and maps, helper calls, returned error objects, subclass `super`
calls, and error-envelope fallbacks. The existing upload fallback constructs
`http_${status.toString()}` dynamically; its `http_${number}` family is recorded
separately from finite codes.

This is a bounded static analysis. An unresolved construction fails instead of
being treated as a provider code. `scripts/error-code-relays.json` records reviewed
remote/dependency code projections and exceptional local result flows, each bound
to a source file, enclosing function, expression, and property path with a reason.
The local flows trace the card settlement callback and the probe timeout's input;
the timeout flow pins its reviewed wrapper with a SHA-256 guard, so a changed
implementation requires review. SDK lock and pool wrappers preserve their callback
results. When a construction changes, extend the analyzer or review the precise
source classification. Do not
exclude a local code to make the check pass. Stale classifications also fail.
