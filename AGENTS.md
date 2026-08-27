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

Requirements: Node.js ≥ 20 (`.nvmrc` pins 22), Git, Linux or macOS. The
worktree fleet needs POSIX ownership semantics and fails closed on Windows.
`npm link` exposes the `agent-trestle` binary locally.

## Commands

All of these were run and passed on Node 22.22.3 / npm 10.9.8.

| Command | What it does | Verified result |
| --- | --- | --- |
| `npm run lint` | Syntax, JSON and whitespace checks, no deps | `Lint passed: 87 file(s) checked.` |
| `npm run lint:fix` | Auto-repairs whitespace problems | — |
| `npm test` | Full suite (`node --test`) | 244 tests, 242 pass, 2 skipped |
| `npm run test:unit` | `test/unit/` only | 209 tests, 207 pass, 2 skipped |
| `npm run test:integration` | `test/integration/` only | 34 tests, 34 pass |
| `npm run test:coverage` | Full suite plus thresholds; Node 22 | 91.36% lines, 82.85% branches |
| `npm run check` | `lint` + `test` + `npm pack --dry-run` | exit 0 |

`npm run check` is the gate to run before pushing. There is **no build step**:
the package ships `src/` as-is, so `npm pack --dry-run` is what stands in for a
build, and it is already part of `check`.

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
`dashboard`, `dispatch`, `ownership`, `review`, `scheduler`, `state` and
`worktrees` are public subpath exports declared in `package.json`; `cli`,
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

## Releasing and publishing

Do not release by hand and do not run `npm publish` locally.
[`.github/workflows/release.yml`](.github/workflows/release.yml) is triggered by
a `v*` tag, verifies tag/manifest/changelog agreement, runs lint and tests,
packs the tarball, smoke-tests it in a clean consumer, publishes the GitHub
release with changelog notes, and then publishes to npm through
[trusted publishing](https://docs.npmjs.com/trusted-publishers) — OIDC, no
stored registry token. Republishing an existing version is a no-op.

The full procedure, including the one-time npm bootstrap and the `NPM_PUBLISH`
repository variable, is in
[Releasing](CONTRIBUTING.md#releasing).
