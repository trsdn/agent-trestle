# Changelog

All notable changes to Agent Trestle are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the version remains below `1.0.0`, the public API and command surface
are not yet stable and may change without a major version bump.

## [Unreleased]

### Added

- Added a CodeQL workflow for JavaScript and TypeScript analysis on pushes,
  pull requests, a weekly schedule, and manual runs.
- Added `agent-trestle run --manifest FILE`, a closed versioned task-manifest
  schema, manifest validation, a documented example manifest, and new
  `./manifest`, `./run`, and `./schemas/manifest.json` exports.
- Added coverage tooling built on Node's built-in test coverage, enforcing 90%
  line, 78% branch, and 86% function floors over `src/` with
  `npm run test:coverage` and publishing `coverage/lcov.info` from CI. The floors
  are checked by parsing lcov rather than through Node's `--test-coverage-*`
  flags, which only exist from v22.8, so the gate also runs on the Node 20 floor.
- Added hermetic test scratch roots that namespace fixtures by label, host, PID,
  and random bytes, purge stale containers, and clean up best-effort on exit and
  termination signals.
- Added runtime audit recording for dispatch, run, review, and fleet commands,
  with per-actor hash-chained segments under `.trestle/audit/` and explicit
  `--no-audit` opt-outs.
- Added optional `agent-trestle run --isolate` worktree isolation, creating a
  per-task Git worktree and branch under `.trestle/worktrees/` or a supplied
  `--worktree-root`.
- Added a dashboard project data provider that reconstructs runs, tasks,
  reviews, and audit integrity results from `.trestle/audit/` when
  `agent-trestle dashboard` is run without `--data`.
- Added gated `review --merge` support that creates a constructed merge commit
  from the exact content reviewed, with ownership checks, audit records, and
  compare-and-swap ref updates.
- Added a closed ownership-policy schema, loader, example policy, and
  `./schemas/ownership.json` export for attributing mergeable paths to actors.
- Added a per-export API stability table documenting provisional and
  experimental subpath exports, including the especially unstable `./audit` and
  `./scheduler` APIs.
- Conformance with the trsdn Repository Quality Standard v1.7.0.
  `.github/conformance.yml` records the assessment result,
  `docs/self-assessment.md` holds the per-criterion evidence,
  `.github/badges/conformance.svg` is generated from the record, and
  `.github/workflows/conformance.yml` fails the build when the two disagree or
  when the assessment ages past the review cadence.
- A self-hosted repository statistics card, generated on a schedule by
  `.github/workflows/stats.yml` and committed to the `stats` branch, so README
  activity is not fetched from a third-party rendering service at read time.
- `.github/github-app.yml`, an intentional repository-scoped agent
  configuration that delegates to `AGENTS.md` rather than restating it, and
  disables remote control of sessions.
- README sections declaring the primary language and localization scope, the
  accessibility properties of the CLI and dashboard together with their known
  limitations, and the privacy posture — what is collected (nothing), every
  outbound destination and its purpose, where state and audit records live, and
  what is retained.
- `AGENTS.md` sections naming the forbidden and high-risk operations (history
  rewriting, force pushes, deletion, destructive filesystem commands,
  releasing, publishing, deployment, repository settings, secret handling), the
  generated and machine-owned paths that must not be hand-edited, and the
  attribution and review expectations for agent-authored changes.
- `test/unit/dashboard-accessibility.test.mjs`, regression coverage for the
  dashboard's document language, landmarks, skip link, focus affordance,
  accessible names, empty-state announcements, relative text sizing, and the
  rule that status is never conveyed by colour alone.
- `AGENTS.md`, an orientation file for coding agents. It records the verified
  lint, test and packaging commands, notes that `npm ci` cannot work in a
  zero-dependency repository with no lockfile, sketches the runtime boundaries,
  and links to `CONTRIBUTING.md` and `docs/architecture.md` for the conventions
  and invariants rather than restating them.

### Changed

- Renamed `test/helpers/scratch` to `test/helpers/scratch.mjs` and gave every
  importer the explicit extension. The extensionless file resolved, but relied
  on the loader inferring a module type it had no extension to declare.
- Pinned the release and CodeQL workflows to action commit SHAs, matching the
  CI workflow, so no workflow in the repository still trusts a mutable tag.
- Wired manifest execution through the scheduler so task graphs run in
  dependency order, respect `--concurrency`, support stop-condition convergence,
  and fail invalid graphs before spawning any agent.
- Propagated abort signals through dispatch and Copilot process execution so
  interrupted manifest runs tear down child process trees through the existing
  supervision path.
- Extended the dependency-free lint pass with JavaScript quote-style checking
  and normalized project strings to the double-quote convention where doing so
  does not introduce extra escapes.
- Declared the platform constraint in `package.json` with `"os": ["!win32"]`,
  matching the POSIX ownership requirement documented in the README.
- Pinned GitHub Actions by commit SHA in CI and CodeQL workflows, added a
  coverage job, and enabled required status checks for the default branch.
- Documented the continuous-integration action-pinning policy in
  `CONTRIBUTING.md`, including SHA resolution, Dependabot comments, and
  least-privilege workflow permissions.
- Strengthened the zero-dependency contribution policy to cover runtime,
  development, and optional npm dependencies, and to cite both linting and
  coverage as Node built-in implementations.
- Bound isolated worktree lifetime to task outcomes: completed tasks remove
  their worktrees, failed tasks retain them for inspection, and interrupted runs
  clean up registered worktrees before returning.
- Kept `dashboard --data FILE` for offline inspection while making project audit
  records the default live dashboard source and reporting the selected source in
  command output.
- Updated merge-related security posture documentation so the CLI merge path is
  described as explicit opt-in rather than unavailable.
- Rewrote the security reporting policy with a direct private advisory link,
  supported-version statement, response expectations, coordinated-disclosure
  policy, and scoped threat model.
- Refreshed the provenance audit with the current tracked-file inventory, the
  delta since the original baseline, and explicit limits on what can be verified
  without access to the private predecessor project.
- The README badge block now follows the standard's order — license, runtime,
  CI, release, conformance — and every badge derives its value from an
  authoritative source instead of restating a hand-maintained one. The status
  note no longer repeats the version number, which had already drifted from
  `package.json`.

### Fixed

- A failed state-root initialisation no longer leaves directory creation running
  in the background. `health()` pinned the project, workstream, and config roots
  with `Promise.all`, which rejects on the first failure without stopping the
  others, so a caller that cleared its state root after a rejection raced the
  pins that were still creating their directories and saw a spurious
  `ENOTEMPTY`. Pins now settle before the failure is rethrown, and the pins that
  did succeed are released instead of dropped, which also closes a directory
  descriptor that leaked on every failed initialisation.

- Removed fixed shared test scratch paths, so unit and integration tests no
  longer interfere through leftover `test/.artifacts` or `test/.work` state.
- Made stale scratch-root purging best effort so concurrent test workers cannot
  fail each other when one removes a container while another is inspecting it.
- Fixed reviewer process spawning under coverage by giving Node a mutable copy of
  the scrubbed environment while preserving the allowlist.
- Fixed `run --isolate` discarding all agent work: worktree release ran
  `git worktree remove` without committing, which failed on any task that wrote
  files, stranding the worktree and reporting a successful run as failed. Task
  output is now committed to the task branch before removal.
- Fixed `run --isolate` failing on every task from the second run of a manifest
  that declares `id`, because worktree removal leaves the branch behind and the
  branch name was derived from the manifest id. Isolation now uses a
  per-invocation run id.
- Fixed a failed task being misreported as interrupted. Classification consulted
  the scheduler's shared abort signal, which is raised for siblings when any task
  fails; it now prefers the task's own execution state.
- Fixed the coverage gate silently passing on a malformed LCOV report, where a
  non-numeric record produced `NaN` and compared false against the floor. Counts
  are now parsed strictly and the gate fails closed.
- Fixed the lint quote scanner misreading a regular expression at the start of a
  statement following `}` as a division, which could mask quote violations.
- Fixed the dashboard failing permanently once history grew past the model's
  bounds: audit entries are produced per run and task, so collections are now
  trimmed before normalization instead of raising `RangeError` on every request.
- Fixed dashboard run selection dropping recent activity, because run ids were
  sorted lexicographically by command prefix rather than by time.
- Fixed the shipped `examples/task-manifest.json` referencing a `promptFile` that
  did not exist, which made the documented example fail when copied verbatim.
- Stopped the README pinning a hard-coded version in its status banner, which had
  already drifted behind `package.json`. The banner now states the pre-`1.0.0`
  stability contract instead of a number that goes stale every release, matching
  how the supported-versions table in `SECURITY.md` is worded.

### Security

- Allowed `--ownership` to reference a policy outside the repository, so the
  document that authorizes a merge no longer has to live in a directory the
  producing agent can write. Out-of-repo policies get the same pinned,
  symlink-safe read.
- Refused `review --merge` when the reviewed diff modifies the ownership policy
  or `.trestle/config.json`, so a branch cannot install the rules that approve
  it. Reported as `governance-self-modification`.
- Documented known limitations in `SECURITY.md`, including custom reviewer
  definitions being read from the working tree rather than the reviewed base.

## [0.2.1] — 2026-08-24

This release ships no code changes. It is the first version published to npm
through the automated pipeline, so unlike `0.2.0` it carries a provenance
attestation that ties the published artifact to the workflow run that built it.

### Added

- npm publishing in the release workflow, using npm trusted publishing (OIDC),
  so no registry token is stored in the repository and every published version
  carries a provenance attestation. Pre-release versions go to the `next`
  dist-tag, everything else to `latest`, and re-running a release for an
  already published version is a no-op. The job stays dormant until the
  repository variable `NPM_PUBLISH` is set to `enabled`.
- A release check that fails the run when a version it just published carries
  no provenance attestation. Trusted publisher configuration lives on npmjs.com
  and npm exposes no API to read it back, so a missing or mismatched publisher
  would otherwise degrade silently into an unattested release.

### Changed

- `agent-trestle` installs from npm: `npm install -g agent-trestle`. The clone
  route is retained for working on Agent Trestle itself and the release tarball
  for installing without a registry.

### Fixed

- The name-clearance release gate claimed that the npm name had been reserved
  by publishing `0.1.0`. No version was ever published at that point. The gate
  now records the reservation that `0.2.0` actually made, matching the
  availability table in the same document.

## [0.2.0] — 2026-08-24

### Added

- Release automation: pushing a `vX.Y.Z` tag runs `.github/workflows/release.yml`,
  which checks that the tag, `package.json` version, and changelog section
  agree, runs lint and tests, packs the tarball, smoke-tests it in a clean
  install, and publishes a GitHub release carrying the changelog notes and the
  tarball as an asset. The workflow can also be dispatched for an existing tag.
- `scripts/release.mjs`, a dependency-free `verify` and `notes` helper used by
  the release workflow, covered by `test/unit/release-metadata.test.mjs`.
- A `Coverage` CI job and `npm run test:coverage`, enforcing line, branch, and
  function thresholds through the Node built-in coverage reporter. The job
  closes a gap where `Coverage` was a required status check that no workflow
  produced, which left every pull request waiting forever.

### Changed

- `--help` now states the version and links the repository and issue tracker,
  and `--version --json` additionally reports `repository`, `bugs`, and
  `license`. Plain `--version` still prints only the version string.
- `SECURITY.md` now documents supported versions, the private advisory
  reporting path, response targets, reporting scope, and disclosure
  expectations, replacing the placeholder that pointed at a channel to be
  configured "after publication".

## [0.1.0] — 2026-08-20

### Added

- First public release. The repository is public and the package is
  publishable; `package.json` no longer carries `"private": true`.
- Continuous integration on GitHub Actions: lint, tests on Node 20 and 22
  across Linux and macOS, and packaging verification.
- Dependency-free lint pass (`npm run lint`) covering module syntax, JSON
  validity, and whitespace hygiene, implemented with Node built-ins only.
- Repository scaffolding: issue templates, pull request template, `CODEOWNERS`,
  Dependabot configuration, `.editorconfig`, and `.nvmrc`.
- This changelog.

### Changed

- Rewrote `README.md` with project status, requirements, an install path, a
  verified quickstart, a command reference, and a documentation index.
- Expanded `CONTRIBUTING.md` with development setup, the zero-dependency rule,
  provenance rules, security invariants, and commit conventions.
- Expanded `CODE_OF_CONDUCT.md` with scope, a reporting channel, and a
  proportionate enforcement ladder.
- Added `repository`, `bugs`, `homepage`, `keywords`, and `author` metadata to
  `package.json`; `npm run check` now also runs the lint pass.
- Consolidated the remaining root-level tests into `test/unit/`, so all tests
  live under `test/unit/` or `test/integration/`.

### Fixed

- Ignored `fleet/`, `repo/`, `.trestle/state/`, and `test/.artifacts/`, which
  are runtime and test artifacts that were previously left untracked in the
  working tree.

## 0.0.0-private — 2026-08-14

### Added

- Initial orchestration runtime: configuration loading and validation,
  deterministic dispatch routing, a bounded scheduler, isolated Git worktree
  fleets, an exact-diff review gate, ownership policy enforcement, a
  file-backed state store with MCP/stdio access, segmented audit logging, and a
  read-only local dashboard.
- CLI surface: `init`, `validate`, `doctor`, `resolve`, `dispatch`, `review`,
  `fleet`, `dashboard`, `state-server`, `state-lock`, and `state-unlock`.
- Hardening of the config, agent, and skill loaders against symlink traversal.
- Least-privilege permission defaults, with unrestricted tools, paths, URLs,
  non-interactive execution, and auto-merge all opt-in.

[Unreleased]: https://github.com/trsdn/agent-trestle/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/trsdn/agent-trestle/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/trsdn/agent-trestle/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/trsdn/agent-trestle/releases/tag/v0.1.0
