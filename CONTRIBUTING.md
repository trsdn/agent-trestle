# Contributing to Agent Trestle

Thanks for your interest in improving Agent Trestle. This document explains how
to set up the project, what the review bar is, and the constraints that are
non-negotiable because of the project's clean-room provenance and security
posture.

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting security issues

**Do not open a public issue for a vulnerability.** Follow the reporting
process in [SECURITY.md](SECURITY.md), which links to the repository's private
GitHub advisory intake.

## Development setup

Requirements: Node.js ≥ 20 (use `.nvmrc` for the recommended version), Git, and
the GitHub Copilot CLI on your `PATH`. Linux or macOS — Windows is refused at
install time by `"os": ["!win32"]`, because the worktree fleet requires POSIX
ownership semantics, process-group termination has no Windows equivalent, and
the state lock protocol assumes POSIX unlink semantics. See
[platform support](docs/security-model.md#platform-support).

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
| `npm run lint` | Dependency-free syntax, JSON, whitespace, and quote-style checks |
| `npm run lint:fix` | Auto-repairs whitespace and quote-style problems |
| `npm test` | Full suite via the Node built-in test runner |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Integration tests only |
| `npm run test:coverage` | Full suite plus the `src/` coverage floors |
| `npm run check` | Lint + tests + packaging verification |

Run `npm run check` before pushing. CI runs the same commands on Node 20 and 22
across Linux and macOS, and enforces coverage thresholds in a separate
`Coverage` job on the `.nvmrc` runtime.

## Continuous integration and action pinning

Every GitHub Actions step **must be pinned to a full commit SHA**, never to a
mutable tag or branch:

```yaml
- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
```

Keep the human-readable version as a trailing comment so the intent stays
obvious and Dependabot can track it. A tag can be moved by its owner, so a
tag reference means an upstream retag silently changes what executes inside a
workflow that has access to this repository. That is a supply-chain risk this
project does not accept, and it is the same fail-closed reasoning applied
everywhere else in the codebase.

Resolve a SHA before adding an action:

```bash
gh api repos/OWNER/REPO/git/ref/tags/vN -q '.object.sha'
```

If the tag is annotated, dereference it with
`gh api repos/OWNER/REPO/git/tags/<sha> -q '.object.sha'` to get the commit.

Workflows must also declare least-privilege `permissions:`. Grant write scopes
on the individual job that needs them, never at workflow level — see
[`.github/workflows/codeql.yml`](.github/workflows/codeql.yml), which scopes
`security-events: write` to its analysis job only.

Dependency and code scanning are automated:
[`.github/dependabot.yml`](.github/dependabot.yml) tracks the npm and
github-actions ecosystems weekly, and
[`.github/workflows/codeql.yml`](.github/workflows/codeql.yml) runs CodeQL on
pushes to `main`, on pull requests, and weekly.

## The zero-dependency rule

Agent Trestle ships with **no npm runtime or development dependencies**, and
this is a deliberate constraint tied to its provenance posture, not an
accident. That is why linting is a small script built on Node built-ins
([`scripts/lint.mjs`](scripts/lint.mjs)) rather than ESLint and Prettier, and
why coverage is measured by [`scripts/coverage.mjs`](scripts/coverage.mjs)
wrapping Node's own `--experimental-test-coverage` rather than by `c8` or `nyc`.

This applies to `dependencies`, `devDependencies` and `optionalDependencies`
alike: `package.json` declares none of them, and the Dependabot npm entry exists
only so that anything introduced later is tracked from the moment it lands.

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

### Publishing to npm

The release workflow also publishes to the npm registry, using
[trusted publishing](https://docs.npmjs.com/trusted-publishers): GitHub mints a
short-lived OIDC token for the workflow, so no npm token is stored in this
repository, and npm attaches a provenance attestation to every published
version. Pre-release versions go to the `next` dist-tag, everything else to
`latest`. Re-running a release for an already published version is a no-op.

That job only runs when the repository variable `NPM_PUBLISH` is set to
`enabled`, because npm accepts a trusted publisher only for a package that
already exists. The name was claimed on 2026-08-24 by publishing
`agent-trestle@0.2.0` from a maintainer account, and `NPM_PUBLISH` has been
`enabled` ever since. That bootstrap is done and does not need repeating unless
the package is renamed, in which case:

1. Confirm the name decision first. Distributing a package under a name is the
   step that carries trademark exposure, and the gate in
   [name clearance](docs/name-clearance.md) is not fully satisfied.
2. Download the tarball from the newest GitHub release rather than packing
   locally, so the first published bytes are the ones CI built and smoke-tested:
   `gh release download vX.Y.Z --pattern '*.tgz'`.
3. Authenticate against npmjs.com. A machine whose `~/.npmrc` sets a `registry`
   other than npmjs.org authenticates against that host instead, so point npm at
   a scratch config first:
   `printf 'registry=https://registry.npmjs.org/\n' > /tmp/npmrc-bootstrap` and
   export `NPM_CONFIG_USERCONFIG=/tmp/npmrc-bootstrap` for every command below.
   Use `npm login --auth-type=legacy`, which prompts for the authenticator code
   in the terminal. Do not use the default `--auth-type=web` while already
   signed in to npmjs.com in the browser: npm sends you to
   `/login?next=/login/cli/<uuid>`, the site drops the `next` parameter for an
   authenticated session, and `/login/cli/<uuid>` then answers `Unauthorized`
   while the CLI polls forever. A granular access token with *read and write*
   on *all packages* works too, appended as
   `//registry.npmjs.org/:_authToken=<token>`; because the account enforces 2FA
   for publishing, such a token must have *Bypass 2FA* set. Confirm with
   `npm whoami` before continuing.
4. `npm publish agent-trestle-X.Y.Z.tgz --access public`. This first version
   carries no provenance; npm cannot attach one to a pre-packed tarball.
5. On npmjs.com, open the package settings and add a trusted publisher:
   organization/user `trsdn`, repository `agent-trestle`, workflow filename
   `release.yml`, environment empty. If you set an environment there, the
   `publish-npm` job must declare the same one.
6. Under *Publishing access*, select *Require two-factor authentication and
   disallow tokens*, so the OIDC workflow becomes the only publishing path.
   Revoke the bootstrap token and delete the scratch config now.
7. Set the repository variable: `gh variable set NPM_PUBLISH --body enabled`.
8. Update the install section of [`README.md`](README.md) and the registry row
   in [name clearance](docs/name-clearance.md).

From the next tag onwards, publishing is fully automated and no longer touches
a maintainer's credentials.

## Documentation

Documentation lives in [`docs/`](docs). Prose wraps at 80 columns, matching
`.editorconfig`. If you change CLI behaviour, `docs/commands.md` must change in
the same pull request — a command surface that disagrees with its
documentation is treated as a bug.
