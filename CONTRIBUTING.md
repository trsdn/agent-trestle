# Contributing to Agent Trestle

Thanks for your interest in improving Agent Trestle. This document explains how
to set up the project, what the review bar is, and the constraints that are
non-negotiable because of the project's clean-room provenance and security
posture.

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting security issues

**Do not open a public issue for a vulnerability.** Follow the private process
in [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Node.js ≥ 20 (use `.nvmrc` for the recommended version), Git, and
the GitHub Copilot CLI on your `PATH`. Linux or macOS — the worktree fleet
requires POSIX ownership semantics and fails closed on Windows.

```bash
git clone https://github.com/trsdn/agent-trestle.git
cd agent-trestle
nvm use              # optional, honours .nvmrc
npm link             # exposes the `agent-trestle` binary locally
```

There is no install step for dependencies, because there are none.

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm run lint` | Dependency-free syntax, JSON, and whitespace checks |
| `npm run lint:fix` | Auto-repairs whitespace problems |
| `npm test` | Full suite via the Node built-in test runner |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Integration tests only |
| `npm run test:coverage` | Full suite plus coverage thresholds (needs Node 22) |
| `npm run check` | Lint + tests + packaging verification |

Run `npm run check` before pushing. CI runs the same commands on Node 20 and 22
across Linux and macOS, and enforces coverage thresholds in a separate
`Coverage` job on the `.nvmrc` runtime.

## The zero-dependency rule

Agent Trestle ships with **no npm runtime or development dependencies**, and
this is a deliberate constraint tied to its provenance posture, not an
accident. That is why linting is a small script built on Node built-ins
([`scripts/lint.mjs`](scripts/lint.mjs)) rather than ESLint and Prettier.

A pull request that adds a dependency needs to justify why a Node built-in
cannot do the job, and must update
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) in the same change.

## Provenance rules

This is a clean-room-style implementation. Contributions must not include
source copied from tools whose licensing or provenance has not been cleared.

Behavioural compatibility with an external command or protocol does **not**
grant permission to copy its implementation. If you vendor anything — code,
generated assets, or copied examples — record it in
`THIRD_PARTY_NOTICES.md` as part of the same pull request.

## Security invariants

These hold across every change. A pull request that weakens one will be
rejected unless the weakening is opt-in and explicitly documented:

1. Unknown configuration fails explicitly rather than being ignored.
2. Process failure can never be represented as task success.
3. Broad permissions — tools, paths, URLs, non-interactive execution,
   auto-merge — stay opt-in and default to off.
4. Reviewed content must be exactly the content that merges.
5. Ownership violations cannot merge.
6. Parallel writers cannot corrupt audit integrity.
7. A workstream cannot read or mutate another workstream's state.
8. Containment failures fail **closed**, never open.

## Tests

Every behavioural change needs test coverage.

- `test/unit/` — module-level tests with no process spawning.
- `test/integration/` — tests that exercise the CLI, packaging, or Git.

Tests create scratch state under `test/.work/` and `test/.artifacts/`, both of
which are gitignored. Tests must be self-contained: set up your own fixtures
and Git identity, and never depend on the developer's global Git config.

## Commit and pull request conventions

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```text
feat: add stop-condition telemetry to the scheduler
fix: fail closed when a worktree root is group-writable
docs: clarify the state-unlock recovery contract
test: cover malformed tokenless lock recovery
chore: update CI matrix to Node 22
```

For pull requests:

- keep the change focused; unrelated cleanups belong in their own PR;
- fill in the pull request template, including the security impact section;
- add a `CHANGELOG.md` entry under `Unreleased`;
- update `docs/` when you change the command surface, configuration schema, or
  security model.

## Releasing

Releases are cut from tags and published by
[`.github/workflows/release.yml`](.github/workflows/release.yml); nothing is
uploaded by hand.

1. Move the `Unreleased` changelog entries under a `## [X.Y.Z] — YYYY-MM-DD`
   heading and set the same version in `package.json`.
2. Merge that change, then tag the merge commit `vX.Y.Z` and push the tag.
3. The workflow verifies that the tag, `package.json` version, and changelog
   section agree (`node scripts/release.mjs verify --tag vX.Y.Z`), runs lint
   and the full suite, packs the tarball, installs it into a clean consumer,
   asserts that the installed CLI reports the tagged version and links back to
   this repository, and publishes the GitHub release with the changelog
   section as notes and the tarball attached.

A mismatch between tag, manifest, and changelog fails the release before any
artifact is published. Versions below `1.0.0` and any tag with a pre-release
suffix are marked as pre-releases. Existing tags can be re-published through
the workflow's manual dispatch input.

## Documentation

Documentation lives in [`docs/`](docs). Prose wraps at 80 columns, matching
`.editorconfig`. If you change CLI behaviour, `docs/commands.md` must change in
the same pull request — a command surface that disagrees with its
documentation is treated as a bug.
