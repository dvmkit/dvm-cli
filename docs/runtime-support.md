# Runtime compatibility

The published caller declares Node.js `>=22`. Contributor verification uses the
exact Node version in `.nvmrc` and npm version in `packageManager`; those pins do
not restrict consumer npm or require consumers to use that exact Node release.

Every trusted pull request, master push, and manual Verify run builds and verifies
once with the contributor toolchain. It packs the resulting verified `dist` and
shares one archive, with SHA-256 metadata and one-day artifact retention, across:

| Runner | Node versions |
| --- | --- |
| `ubuntu-latest` | 22.0.0, latest 22, latest 24, latest 26 |
| `macos-latest` | 22.0.0, latest 22, latest 24, latest 26 |
| `windows-latest` | 22.0.0, latest 22, latest 24, latest 26 |

The matrix tests the declared minimum and current maintained even-numbered
majors through 26. Adding a future maintained major requires an explicit matrix
update. The engine declaration permits newer releases; it is not a claim that
CI has tested every future release. The latest runner labels use GitHub-hosted
default architectures (currently Linux and Windows x64, and macOS arm64).
Other operating systems, architectures, and odd-numbered Node releases are not
covered by this grid. Runner label migrations can change that architecture scope.

Each cell uses consumer npm, disables lifecycle scripts, upgrades a disposable
legacy install to the shared archive, resolves the bundled skill, invokes npm's
real launcher (including Windows `.cmd`), and checks version, help, JSON errors,
and a free request followed by a status poll against a loopback service. Config,
identity, and job state live in temporary directories with spaces. No real
payments or production endpoints are used. Source dependencies, rebuilding, and
repacking the shared archive are excluded from runtime cells. The full source,
wallet, recovery, package, and release gates remain in the verified build job.

The required `verify` check succeeds only when the build and all twelve runtime
cells succeed. Failed, cancelled, or skipped dependencies fail the aggregate.
Outside-fork pull requests retain the repository's existing skipped-job policy.
Captured dependency and CLI failure output is withheld from public runtime logs
because it may contain machine paths or secrets; the failing phase is reported.

To reproduce after a successful contributor verification:

```sh
node scripts/pinned-npm.mjs run artifact:runtime
node scripts/runtime-smoke.mjs .artifacts/runtime
```

Run the second command with each consumer Node installation to test that runtime.
It uses the npm shipped alongside that Node installation unless invoked through
npm, in which case it uses the active npm executable.
