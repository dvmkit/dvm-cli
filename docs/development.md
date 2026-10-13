# Development

Use the exact Node.js release in `.nvmrc`. Install with `node scripts/pinned-npm.mjs ci --ignore-scripts`, then run the same local gate as CI with `node scripts/pinned-npm.mjs run verify`. The bootstrap downloads the exact npm release declared in `package.json`, verifies its integrity before every extraction, and keeps it under the ignored repository-local `.tooling/` directory.

`npm run verify` checks repository metadata in the checkout, copies only tracked and unignored source into an isolated directory, installs its locked dependencies, and runs lint, build, typecheck, the full test suite, package/upgrade smoke, packed-artifact safety, and release checks there. The clean source tree owns the only complete build and test pass, so verification cannot reuse the checkout's `node_modules` or pre-existing `dist`; after every check passes, its verified `dist` replaces the checkout's build output for release packaging.

Release automation is documented in [docs/releasing.md](./releasing.md). It prepares a reviewed release pull request and only a separately signed immutable tag can enter the GitHub-hosted npm trusted-publishing path.
