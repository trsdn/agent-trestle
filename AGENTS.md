# AGENTS.md

Orientation for coding agents working in this repository. Humans should start
with [CONTRIBUTING.md](CONTRIBUTING.md) — this file does not replace it and
deliberately does not restate the review bar, the provenance rules, or the
security invariants. Where a rule already exists there, this file links to it.

Every command below was executed on this repository before being written down.

## Setup: there is no install step

Agent Trestle has **zero npm dependencies**, runtime or development. There is
no `node_modules`, and no `package-lock.json`.

Consequences an agent must not get wrong:

- **`npm ci` fails here**, and that is correct, not a broken checkout. It exits
  non-zero with `The 'npm ci' command can only install with an existing
  package-lock.json`. Do not "fix" this by generating a lockfile or by adding
  dependencies.
- **`npm install` is unnecessary.** Clone and run the commands directly.
- Adding any dependency is a reviewable decision with its own bar; see
  [the zero-dependency rule](CONTRIBUTING.md#the-zero-dependency-rule).

Requirements: Node.js ≥ 20 (`.nvmrc` pins 22), Git, Linux or macOS. Windows is
refused at install time by `"os": ["!win32"]` in `package.json`: audit and state
writes require `O_NOFOLLOW`, the worktree fleet requires POSIX ownership
semantics, and process-group termination has no Windows equivalent. See
[platform support](docs/security-model.md#platform-support).
`npm link` exposes the `agent-trestle` binary locally.

## Commands

All of these were run and passed on Node 22.22.3 / npm 10.9.8.

| Command | What it does | Verified result |
| --- | --- | --- |
| `npm run lint` | Syntax, JSON, whitespace and quote-style checks, no deps | `Lint passed: 112 file(s) checked.` |
| `npm run lint:fix` | Auto-repairs whitespace and quote-style problems | prints `Fixed N file(s):` |
| `npm test` | Full suite (`node --test`) | 327 tests, 325 pass, 2 skipped |
| `npm run test:unit` | `test/unit/` only | 252 tests, 250 pass, 2 skipped |
| `npm run test:integration` | `test/integration/` only | 73 tests, 73 pass |
| `npm run test:coverage` | Full suite plus the `src/` floors, any supported Node | 91.95% lines, 82.89% branches, 91.78% functions |
| `npm run check` | `lint` + `test` + `npm pack --dry-run` | exit 0 |

Auto-fix is `npm run lint:fix`, never `npm run lint --fix`: npm consumes the
`--fix` itself, so the script sees no flag, rewrites nothing, and still exits 0.
The `Fixed N file(s):` line is the only confirmation the pass actually ran.

`npm run check` is the gate to run before pushing. There is **no build step**:
the package ships `src/` as-is, so `npm pack --dry-run` is what stands in for a
build, and it is already part of `check`.

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the same commands as
four jobs: `Lint`, `Test` across a matrix of Node 20 and 22 on
`ubuntu-latest` and `macos-latest`, `Package` (`npm pack --dry-run`), and
`Coverage`. Windows is excluded on purpose — the package refuses to install
there at all (`"os": ["!win32"]`), and the POSIX primitives behind audit, state,
the worktree fleet and process-group termination have no Windows equivalent.
Coverage thresholds run only on the
`.nvmrc` runtime, because the built-in threshold flags need Node 22 while the
suite itself must still pass on the Node 20 floor. So `npm run check` locally
plus Node 20 compatibility is what CI will hold you to.

`test:coverage` measured 91.36% lines, 82.85% branches and 90.49% functions
against thresholds of 88 / 78 / 86, and needs Node 22 because the built-in
coverage threshold flags are not available on the Node 20 floor.

The two skipped tests are gated on a real Copilot CLI and stay skipped unless
`TRESTLE_REAL_COPILOT_SMOKE` / `TRESTLE_REAL_COPILOT_REVIEW_SMOKE` are set.
Leave them skipped.

### Known flakiness under parallel load

`node --test` runs files concurrently, and a few timing-sensitive tests around
process-tree termination and scheduler settlement fail intermittently on a
loaded machine. In five full-suite runs here, two runs each reported one or two
such failures; the same files passed on every isolated re-run.

If a test fails, re-run it in isolation before assuming you broke it:

```bash
node --test test/unit/<file>.test.mjs   # isolated re-run
node --test --test-concurrency=1        # full suite, serially (0 failures)
```

Do **not** delete, skip, or loosen an assertion to make a flake go away, and do
not weaken CI to match. If a flake is real and reproducible, it belongs in its
own issue and its own pull request.

## Architecture in brief

Project-owned configuration is separated from reusable runtime code:

```text
.trestle project configuration
  -> deterministic workstream/role routing
  -> GitHub Copilot CLI process adapter
  -> bounded scheduler or isolated worktree fleet
  -> exact-diff review and ownership enforcement
  -> state and per-run audit segments
  -> read-only local dashboard
```

Each stage is a directory under `src/`. `audit`, `config`, `copilot`,
`dashboard`, `dispatch`, `ownership`, `review`, `sandbox`, `scheduler`, `state`
and `worktrees` are public subpath exports declared in `package.json`; `cli`,
`process` and `security` are internal. The CLI entry point is
`src/cli/agent-trestle.mjs`.

The boundaries and the safety invariants that hold across every change are
specified in [docs/architecture.md](docs/architecture.md) and, for
contributors, in
[security invariants](CONTRIBUTING.md#security-invariants). Read them before
touching dispatch, review, ownership, state or audit: several are the reason
code is shaped the way it is, in particular that containment failures fail
**closed** and that process failure can never be reported as task success.

Supporting scripts are dependency-free Node programs:

- `scripts/lint.mjs` — the lint pass (`node --check`, JSON parse, whitespace).
- `scripts/release.mjs` — `verify --tag vX.Y.Z` asserts that the tag,
  `package.json` version and `CHANGELOG.md` section agree; `notes --tag vX.Y.Z`
  emits the changelog section used as release notes.

## Conventions

Follow [CONTRIBUTING.md](CONTRIBUTING.md). The points most often missed by an
agent:

- **Conventional Commits** for every commit message.
- **Every behavioural change needs a test.** `test/unit/` must not spawn
  processes; `test/integration/` exercises the CLI, packaging or Git.
- **Tests must be self-contained** — build your own fixtures and Git identity,
  never rely on the developer's global Git config. Scratch state goes under
  `test/.work/` and `test/.artifacts/`, both gitignored.
- **Add a `CHANGELOG.md` entry under `Unreleased`.**
- **Update `docs/` in the same pull request** when the command surface,
  configuration schema or security model changes. `docs/commands.md`
  disagreeing with actual CLI behaviour is treated as a bug.
- **Formatting follows `.editorconfig`**: UTF-8, LF, final newline, two-space
  indent, no trailing whitespace; 100 columns for `.mjs`/`.js`/`.json` and 80
  for Markdown prose. `npm run lint:fix` repairs whitespace only.
- **Keep the change focused.** Unrelated cleanups belong in their own pull
  request.
- The config schema is closed (`additionalProperties: false`) on purpose.
  Unknown configuration must fail explicitly rather than be ignored.

## Forbidden and high-risk operations

These are not style preferences. Each one is either unrecoverable, or it moves
a decision outside the review that is supposed to authorise it.

**Never, without an explicit instruction from a maintainer in the current
request:**

- **Rewrite published history.** No `git rebase`, `git commit --amend`,
  `git reset --hard`, or `git filter-branch` against commits that are already
  pushed. Add a new commit instead.
- **Force-push anything.** `git push --force` and `--force-with-lease` are both
  out of scope for an agent. `main` rejects them, and a feature branch that is
  already under review is somebody else's context.
- **Delete branches, tags, worktrees, or remotes**, or run `git clean -xdf`.
  Untracked files in this repository are frequently the only copy of something.
- **Run destructive filesystem commands** outside `test/.work/` and
  `test/.artifacts/`. Nothing else in the tree is scratch space.
- **Release or publish.** Do not create `v*` tags, do not run `npm publish`,
  and do not invoke `gh release create`. Releases are produced only by
  [`.github/workflows/release.yml`](.github/workflows/release.yml); see
  [Releasing and publishing](#releasing-and-publishing).
- **Deploy anything.** There is no deployment target, so any command that looks
  like one is a mistake.
- **Touch repository settings**: branch protection, required checks, secrets,
  variables, or visibility.

**Secrets:**

- Never commit a credential, token, or key, not even a placeholder that looks
  real. Secret scanning with push protection is enabled and will block it, but
  the rule exists so it never gets that far.
- Never add a registry token to this repository. Publishing authenticates
  through OIDC precisely so that no such credential exists.
- Never echo, log, or persist an environment variable that may hold a
  credential, and never weaken the prompt/secret redaction in
  `src/copilot/process-adapter.mjs` or `src/review/process-adapter.mjs`.

**Weakening a safety property counts as a destructive change.** Do not delete,
skip, or loosen a test to make it pass, do not relax the coverage thresholds,
do not turn a fail-closed path into a warning, and do not remove a required CI
check. If an invariant genuinely needs to change, that is its own pull request
with its own argument.

## Generated and machine-owned paths

Do not hand-edit these; regenerate them or change their source instead.

| Path | Owner |
| --- | --- |
| `.github/badges/conformance.svg` | Generated from `.github/conformance.yml` by the conformance workflow |
| `.github/stats/` on the `stats` branch | Generated by [`.github/workflows/stats.yml`](.github/workflows/stats.yml) |
| `test/.work/`, `test/.artifacts/` | Scratch space owned by the test suite; gitignored |

`.github/conformance.yml` is hand-maintained, but only as the *result of an
assessment*. Do not flip a criterion to `pass` to make the check green — the
check validates the record's shape, not its honesty, and the per-criterion
rationale in [docs/self-assessment.md](docs/self-assessment.md) has to stay
true alongside it.

There is no vendored code in this repository, because there are no
dependencies.

## Attribution and review of agent-authored changes

Agent-authored changes are held to the same bar as any other change, and they
are labelled so a reviewer knows what they are reading.

- Add a `Co-authored-by:` trailer naming the agent to every commit an agent
  authors. Conventional Commits still apply to the subject line.
- State in the pull request body that the change was agent-authored, and what
  was verified — which commands were run, and their result.
- An agent may not approve or merge a pull request, including its own. Every
  agent-authored change is reviewed by a human against
  [the review bar](CONTRIBUTING.md#commit-and-pull-request-conventions).
- Do not claim a command succeeded without running it. `npm run check` is the
  single command that stands behind such a claim.

## Releasing and publishing

Do not release by hand and do not run `npm publish` locally.
[`.github/workflows/release.yml`](.github/workflows/release.yml) is triggered by
a `v*` tag and runs three jobs in order: `verify` (tag/manifest/changelog
agreement via `scripts/release.mjs verify`, lint, full suite, `npm pack`, then a
smoke test that installs the tarball into a clean consumer and asserts the
installed CLI reports the tagged version), `publish` (the GitHub release, with
the changelog section as notes and the tarball attached), and `publish-npm`.

`publish-npm` uses npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers): the job holds
`id-token: write`, GitHub mints a short-lived OIDC token, and **no npm
credential is stored in this repository**. Two details are deliberate and must
not be "tidied up":

- **`--provenance` is never passed.** Trusted publishing attaches provenance on
  its own. Because the repository holds no registry token, an attestation can
  only have come from OIDC, so a final step *asserts the published version
  carries an attestation and fails the release if it does not*. That check is
  the real guarantee; adding the flag would defeat its purpose by making the
  attestation prove nothing about how the publish was authenticated.
- **The job is gated on the repository variable `NPM_PUBLISH`** and queries the
  registry first, so re-running a release for an already published version is a
  no-op rather than an error.

The full procedure, including the one-time npm bootstrap and the `NPM_PUBLISH`
repository variable, is in
[Releasing](CONTRIBUTING.md#releasing).
