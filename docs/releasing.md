# Releasing `@dvmkit/dvm-cli`

Release-please prepares the reviewed version and changelog pull request from Conventional Commits. It does not create a tag, GitHub release, or npm publication.

## Verification gate

`npm run verify` is the complete local and CI gate. It checks the toolchain and the repository's files, history, and optional pull-request input in the checkout, then copies only tracked and unignored source into an isolated directory and installs from the lockfile with lifecycle scripts disabled. That clean source tree runs lint, build, typecheck, the full unit and standalone contract suite, packed-package installation and upgrade checks, packed-artifact safety, and the release contract exactly once. Only after the complete gate passes does it copy the verified `dist` back to the checkout, where the release job packs it without rebuilding.

The split retains each previous guarantee without repeating the full source suite:

| Guarantee | Retained check |
| --- | --- |
| Missing source input or reliance on ignored output | The isolated copy excludes ignored `dist` and `node_modules`; its locked install owns the only build, typecheck, and test pass. |
| Missing packaged runtime dependency or broken binary | Package smoke installs the clean-built tarball into a new consumer and runs its version and help commands. |
| Broken bundled skill or upgrade regression | Package smoke upgrades a legacy package fixture and compares the installed skill with the clean source bytes. |
| Unsafe repository source or metadata | The checkout scan retains repository files, Git history, and CI pull-request input. |
| Unsafe published bytes | The pack-only scan inspects the tarball produced from the clean build. |
| Release packaging from stale output | The checkout's `dist` is replaced only with the clean tree's output after every source and consumer check passes. |

Allow about 90 seconds for the full gate. See [Development](./development.md) for the pinned toolchain and locked-install commands.

## Creating a release

After the release pull request is merged, a maintainer creates the one immutable signed tag from the default-branch tip.

For an exact release candidate, put a one-shot `Release-As: X.Y.Z-rc.N` footer on the triggering Conventional Commit. Release-please uses that footer only for the next release pull request; the checked-in configuration stays on normal Conventional Commit versioning. Promote a release-candidate line to stable the same way, with `Release-As: X.Y.Z`.

A squash merge whose commit message is set by the merging tool, rather than taken from the branch commits, drops that footer. In that case put the triggering commit, footer included, between `BEGIN_COMMIT_OVERRIDE` and `END_COMMIT_OVERRIDE` lines in the pull request description. Release-please reads that block in place of the merged commit's message, and can also restore Conventional Commit headers the merge message hid.

```sh
node scripts/pinned-npm.mjs run release:tag -- --tag v1.2.3 --dry-run
node scripts/pinned-npm.mjs run release:tag -- --tag v1.2.3
git push origin v1.2.3
```

The local command fails unless the worktree is clean, `HEAD` equals the current `origin` default-branch tip, the release-please manifest and package versions agree, the exact stable or release-candidate tag is absent locally and remotely, and Git can create and verify an annotated signature. The dry run performs the same checks, including an isolated signing probe, without adding a tag to this repository.

Only `vX.Y.Z` publishes with npm dist-tag `latest`. Only `vX.Y.Z-rc.N` publishes with npm dist-tag `next`. A pushed tag goes through the GitHub-hosted release workflow. Its build job uses Node 22.18.0 and the repository-pinned npm 10.9.3 to install, run the full gate, pack twice, and upload just the identical tarball and its SHA-256 digest manifest for one day. The publish job is the only job with OIDC, and uses integrity-pinned npm 11.16.0 because npm’s trusted-publishing flow requires npm 11.5.1 or newer. It validates the downloaded artifact against its tag, version, dist-tag, digest, and package file list before publishing that exact tarball. It then installs the exact registry version into a clean directory and checks `dvm --version` and the bundled skill. The GitHub release job runs only after publication and creates notes for the existing tag.

Manual dispatch accepts an existing signed tag and runs the no-publish build path. Setting `github_release_recovery` to true also runs the GitHub-release and release-pull-request-label step, but only after that exact tag verifies and builds successfully. It cannot publish or create a tag. A release candidate therefore still requires a reviewed and signed `vX.Y.Z-rc.N` tag.

Package verification exercises refund recovery through the clean installed caller against a local fake provider: ten unresolved drains across credit rollovers, a lost POST reply, replay of each saved payout, and cleanup of only the resolved descriptor. The publish job repeats this acceptance against the exact registry version and records the caller and SDK versions. To repeat it locally after an exact-version install, run `node scripts/refund-recovery-smoke.mjs /path/to/consumer/node_modules/@dvmkit/dvm-cli` from the matching release checkout. The probe uses a disposable configuration and no real payments; it never prints signing material. An SDK upgrade retains unresolved descriptors still present locally, but cannot reconstruct records already evicted by an older version.

## External setup before the first release

For this public repository, configure the npm trusted publisher for `@dvmkit/dvm-cli` with GitHub organization `dvmkit`, repository `dvm-cli`, workflow filename `release.yml`, environment `npm-release`, and allowed action `npm publish` only. The publisher runs only on GitHub-hosted runners. Configure the `npm-release` GitHub environment for selected branches and tags with a tag rule of `v*`. Require human review in the `npm-release` environment before publication. The release maintainer may approve their own deployment; leave prevention of self-review disabled. Configure one tag ruleset that lets only the release maintainer create `v*` tags and a second ruleset that lets nobody update or delete them. The workflow independently verifies the annotated SSH tag signature against the committed signer allow-list. No npm token belongs in GitHub secrets or this workflow.

Release-please is disabled until the repository variable `RELEASE_PLEASE_ENABLED` is exactly `true`. Before enabling it, create repository labels `autorelease: pending` and `autorelease: tagged`, then create a GitHub App installed only on `dvmkit/dvm-cli`, with repository permissions `contents: write`, `issues: write`, and `pull requests: write`; grant no unrelated repository permissions. Create an App private key and store its complete PEM value in the repository secret `RELEASE_PLEASE_APP_PRIVATE_KEY`. Store the numeric App ID, not the client ID, in the repository variable `RELEASE_PLEASE_APP_ID`. Keep `RELEASE_PLEASE_ENABLED` unset or false until the App installation and both values are configured. The workflow mints a short-lived installation token narrowed to this repository and those three permissions, then passes it directly to release-please. This lets release PR CI run automatically after release-please creates or updates its PR, without a PAT or another human approving a second workflow trigger.

The npm UI may require an existing package before it permits trusted-publisher configuration. Do not bootstrap or publish `@dvmkit/dvm-cli` through another path to work around that limitation without a separate explicit operator decision. A one-time bootstrap must still bind the reviewed tarball bytes, use a non-default dist-tag, and leave the normal signed-tag trusted-publishing path unchanged for every subsequent version.

### Renaming the published package

The package was renamed from `@dvmkit/cli`, which is deprecated on npm with an upgrade command.

### npm provenance

The release workflow publishes through npm trusted publishing with OIDC. It does not pass `--provenance` or disable provenance. npm automatically generates provenance attestations for releases published from this public repository through trusted publishing. See npm’s [automatic provenance documentation](https://docs.npmjs.com/trusted-publishers/#automatic-provenance-generation). Confirm the attestation on the npm version page after publication before claiming provenance for that release; repository visibility alone does not add attestations to older versions.

After npm publication, the GitHub release job creates or verifies the release for the existing signed tag, finds the one merged release-please pull request associated with that tag commit, adds `autorelease: tagged`, then removes `autorelease: pending`. The add-before-remove order fails closed, and the final assertion makes reruns idempotent. Without this transition release-please treats the merged pull request as untagged and refuses to prepare the next version.

## Recovery

Never move, replace, or unpublish a release version. If build or pre-publish checks fail, fix only release infrastructure and rerun the same immutable tag once the correction is reviewed. Before publishing, every run queries the exact npm version. An existing version is accepted only when its downloaded registry tarball is byte-for-byte identical to the reviewed artifact and the expected `latest` or `next` dist-tag points to it; a mismatch fails closed without another publish attempt.

npm may hold a new upload for malware scanning: npm reports that processing takes around five minutes, can exceed 15 minutes, and has no fixed completion SLA ([npm announcement](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/)). The release job therefore gives publication visibility and exact-version consumer installation separate 30-minute wall-clock windows. Registry reads have 30-second request timeouts, including response bodies; each clean install attempt has a two-minute process timeout. The upload subprocess and its descendants share the remaining publication window. The workflow job has 75 minutes for both windows plus artifact setup. An accepted upload is attempted once in an invocation. Missing metadata or an archive still being processed is polled every 15 seconds until the visibility deadline, and a timeout says that npm may still be processing the upload rather than implying that publication failed.

When visibility times out, keep the reviewed archive and check it without publishing: `node scripts/publish-release.mjs --archive /path/to/dvmkit-dvm-cli-X.Y.Z.tgz --dist-tag latest --check true` (use `next` for an RC). This command downloads the exact public archive, compares its SHA-256 bytes, and verifies the expected dist-tag. A byte or tag mismatch fails closed. Matching metadata with a missing archive is reported as processing. Missing metadata is reported only as not visible because that response cannot distinguish an upload still processing from a version that was never uploaded. Do not rerun publication while the check says processing. If the exact version remains absent, the tag-without-npm recovery is the same immutable path: repair trusted-publisher or environment configuration, then rerun `Release package` for the existing signed tag; do not retag. A rerun checks the exact version before publication and never republishes an exact match.

If npm has accepted a bad version, deprecate that exact version, return the affected dist-tag to the last good version, and publish a new fixed version. GitHub release creation can be rerun for a successfully published tag when the release notes or release-pull-request-label step alone failed: manually dispatch `Release package` with that existing tag and `github_release_recovery` set to true.
