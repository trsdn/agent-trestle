# Changelog

All notable changes to Agent Trestle are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the version remains below `1.0.0`, the public API and command surface
are not yet stable and may change without a major version bump.

## [Unreleased]

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

[Unreleased]: https://github.com/trsdn/agent-trestle/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/trsdn/agent-trestle/releases/tag/v0.1.0
