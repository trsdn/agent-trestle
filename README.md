# Agent Trestle

[![License](https://img.shields.io/github/license/trsdn/agent-trestle)](LICENSE)
[![Node.js](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Ftrsdn%2Fagent-trestle%2Fmain%2Fpackage.json&query=%24.engines.node&label=node&color=brightgreen)](package.json)
[![CI](https://github.com/trsdn/agent-trestle/actions/workflows/ci.yml/badge.svg)](https://github.com/trsdn/agent-trestle/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/trsdn/agent-trestle?include_prereleases&sort=semver)](https://github.com/trsdn/agent-trestle/releases)
[![trsdn standard](.github/badges/conformance.svg)](.github/conformance.yml)

**Local-first orchestration for GitHub Copilot CLI agents.**

Agent Trestle coordinates multiple Copilot CLI agents against one repository
without giving them free rein. It provides deterministic routing, bounded
execution loops, isolated Git worktrees, review gates, file-backed state,
tamper-evident audit records, and a read-only local dashboard.

Everything runs on your machine. There is no hosted service, no telemetry, and
no npm dependency tree — only Node.js built-ins plus the `git` and Copilot CLI
executables you already have installed.

> [!NOTE]
> **Project status: pre-release.** The command surface is functional but not
> yet API-stable while the version remains below `1.0.0`. Merging refuses by
> default and requires several explicit opt-ins — see
> [merge semantics](docs/merge-semantics.md).

---

## Why it exists

Running one agent is easy. Running several against a shared repository creates
problems that a prompt cannot solve:

| Problem | How Agent Trestle addresses it |
| --- | --- |
| Two agents edit the same files | Isolated Git worktrees per task, plus ownership policy enforcement |
| An agent loops forever | A bounded scheduler with explicit, declared stop conditions |
| A failed process looks like success | Process failure is preserved end-to-end and cannot be reported as task success |
| Approved code differs from merged code | An exact-diff review gate binds approval to specific content, and merging is opt-in, off by default, and refuses on any drift |
| Parallel writers corrupt the log | Independent per-writer audit segments instead of one global hash chain |
| Agents quietly gain broad permissions | Unrestricted tools, paths, URLs, and auto-merge are all opt-in |

## Requirements

- **Node.js ≥ 20** (developed and CI-tested on 20 and 22)
- **Git**
- **GitHub Copilot CLI** on your `PATH`
- **Linux or macOS.** Windows is refused at install time: `package.json`
  declares `"os": ["!win32"]`, so npm exits with `EBADPLATFORM`. The worktree
  fleet requires POSIX ownership semantics, process-group termination has no
  Windows equivalent, and the state lock protocol assumes POSIX unlink
  semantics — see
  [platform support](docs/security-model.md#platform-support).
  From a Windows host, run under **WSL2** with the checkout on the Linux
  filesystem (not `/mnt/c`); every guarantee holds there unchanged.

## Install

```bash
npm install -g agent-trestle
```

The executable is intentionally named only `agent-trestle`, never `trestle`, to
avoid colliding with existing npm packages that already install a `trestle`
binary.

To work on agent-trestle itself, install it from a local clone:

```bash
git clone https://github.com/trsdn/agent-trestle.git
cd agent-trestle
npm link          # exposes the `agent-trestle` binary
```

Tagged releases also attach a packed tarball, so a release can be installed
without npm or a clone:

```bash
npm install -g https://github.com/trsdn/agent-trestle/releases/download/vX.Y.Z/agent-trestle-X.Y.Z.tgz
```

Every release tarball is built, smoke-tested in a clean install, and published
by [the release workflow](.github/workflows/release.yml); `agent-trestle
--version` reports the version that was tagged.

## Quickstart

```bash
# 1. Scaffold .trestle/config.json and a starter agent definition
agent-trestle init

# 2. Confirm the configuration is well-formed
agent-trestle validate

# 3. Confirm the project configuration and Copilot CLI are usable
agent-trestle doctor

# 4. See which agent a given route resolves to, without running anything
agent-trestle resolve --project example-project --workstream main --role builder

# 5. Run one agent, once
agent-trestle dispatch \
  --project example-project \
  --workstream main \
  --role builder \
  --prompt "Add a regression test for the config loader"

# 6. Or run a whole task graph in dependency order. Copy the worked example
#    first — `init` does not write a manifest.
cp node_modules/agent-trestle/examples/task-manifest.json tasks.json
agent-trestle run --manifest tasks.json --concurrency 2
```

`init` writes a minimal project configuration:

```json
{
  "version": 1,
  "project": { "id": "example-project" },
  "workstreams": [
    {
      "id": "main",
      "path": ".",
      "roles": [{ "id": "builder", "agent": "example-builder" }]
    }
  ]
}
```

Roles map to agent definitions in `.github/agents/*.agent.md`. A complete
working example lives in [`examples/minimal`](examples/minimal).

Every terminating command accepts `--json`, and errors are emitted to stderr in
a stable shape, so the CLI composes cleanly with scripts:

```json
{ "ok": false, "error": { "code": "OWNERSHIP_VIOLATION", "message": "..." } }
```

## Command surface

| Command | Purpose |
| --- | --- |
| `init` | Scaffold `.trestle/` configuration into a project |
| `validate` | Check configuration against the schema |
| `doctor` | Verify the local environment and Copilot binary |
| `resolve` | Show the agent a route resolves to, without executing |
| `dispatch` | Resolve one agent and run one Copilot process |
| `run` | Execute a task manifest as a dependency-ordered agent graph |
| `review` | Run an exact-diff review gate; merging is opt-in and gated |
| `fleet` | Create, remove, and prune isolated Git worktrees |
| `dashboard` | Serve a read-only local dashboard (binds `127.0.0.1` only) |
| `state-server` | Run the workstream state store over stdio JSON-RPC/MCP |
| `state-lock` / `state-unlock` | Inspect and recover stale state locks |

Exit codes are stable: `0` success, `1` operation failed, `2` bad arguments,
`3` reserved (no longer emitted), `4` environment check failed, `5` policy or
review blocked the operation. Full details in [docs/commands.md](docs/commands.md).

## Public API stability

The package is pre-`1.0.0`. SemVer still applies, but exported module
signatures may change before `1.0.0` without a major version bump. Treat the
exports below as versioned by package release, not as frozen interfaces. The
configuration schema's `version: 1` is a schema-contract version and is separate
from the npm package version.

| Export | Stability | Notes |
| --- | --- | --- |
| `.` | Provisional | Barrel export for the current modules. Prefer narrower subpath imports when possible. |
| `./config` | Provisional | Configuration loading and schema validation are part of the documented command surface, but option names may still narrow. |
| `./copilot` | Provisional | Process adapter contracts may change as Copilot CLI integration hardens. |
| `./dispatch` | Provisional | Routing is usable, but task execution policy remains pre-`1.0.0`. |
| `./manifest` | Provisional | The task-manifest contract is `version: 1` and closed, but validation may tighten before `1.0.0`. |
| `./ownership` | Provisional | Ownership checks are security-sensitive and may tighten without a major version bump before `1.0.0`. |
| `./review` | Provisional | Exact-diff review is implemented; programmatic merge remains opt-in and may tighten. |
| `./run` | Provisional | Drives the manifest task graph behind `agent-trestle run`. The reported result shape may gain fields. |
| `./state` | Provisional | State isolation and lock recovery contracts may change while the MCP surface matures. |
| `./worktrees` | Provisional | Fleet containment may tighten as platform support is refined. |
| `./dashboard` | Experimental | Read-only local dashboard APIs are intended for local inspection, not remote embedding. |
| `./audit` | Experimental; avoid consumer coupling | Reached at runtime by `run` and `review`, which record provenance through it. Signatures may still change. |
| `./scheduler` | Experimental | Now reached by `agent-trestle run` through `./run`. Signatures may still change as stop-condition policy matures. |
| `./schemas/config.json` | Provisional schema contract | Exposes the current `version: 1` configuration schema. Schema v1 is not the same as package `1.0.0`. |
| `./schemas/manifest.json` | Provisional schema contract | Exposes the current `version: 1` task-manifest schema. |
| `./schemas/ownership.json` | Provisional schema contract | Exposes the current `version: 1` ownership-policy schema used by `review --merge`. |

## Security posture

Agent Trestle launches AI agents that can read and modify repositories, so it
defaults to least privilege:

- unrestricted tools, filesystem paths, and URLs are **disabled** by default;
- non-interactive execution requires an explicit policy;
- merge refuses by default — `review --merge` additionally requires
  `permissions.autoMerge`, an explicit ownership policy and actor, a passing
  exact-diff review, and a base ref that has not moved
  ([merge semantics](docs/merge-semantics.md));
- the dashboard binds only to `127.0.0.1`;
- state and audit paths are constrained to configured project roots;
- worktree operations **fail closed** with `INSECURE_CONTAINMENT` rather than
  run against a path whose ownership cannot be proven.

If you find a vulnerability, do not open a public issue; follow the private
reporting process in [SECURITY.md](SECURITY.md). Read
[docs/security-model.md](docs/security-model.md) for the threat model.

## Documentation

| Document | Contents |
| --- | --- |
| [Architecture](docs/architecture.md) | Runtime boundaries and safety invariants |
| [Configuration](docs/configuration.md) | `.trestle/config.json` schema and keys |
| [Commands](docs/commands.md) | Full CLI reference, exit codes, recovery contracts |
| [Security model](docs/security-model.md) | Threat model and containment guarantees |
| [Merge semantics](docs/merge-semantics.md) | What `review --merge` guarantees, and the races it closes |
| [Provenance](docs/provenance.md) | Clean-room-style development process and its limits |
| [Provenance audit](docs/provenance-audit.md) | Findings of the targeted audit |
| [Name clearance](docs/name-clearance.md) | Why the binary is named `agent-trestle` |
| [Downstream migration](docs/downstream-migration.md) | Golden-diff contract for the first external consumer |
| [Self-assessment](docs/self-assessment.md) | Per-criterion evidence for the repository standard conformance record |

## Development

```bash
npm run lint      # dependency-free syntax, JSON, and whitespace checks
npm test          # full Node built-in test runner suite
npm run test:coverage  # suite plus the src/ coverage floors
npm run check     # lint + test + packaging verification
```

There is no ESLint or Prettier by design — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). `npm run lint` is implemented
in [`scripts/lint.mjs`](scripts/lint.mjs) using only Node built-ins.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Privacy and data protection

Agent Trestle collects nothing. There is no telemetry, no analytics, and no
crash reporting — not disabled by default, but absent from the codebase.

**Outbound network destinations.** Agent Trestle itself opens exactly one
socket: the dashboard listener, bound to `127.0.0.1` and reachable only from
your machine. It makes no outbound request of its own. The two processes it
launches do talk to the network on your behalf:

| Process | Destination | Purpose |
| --- | --- | --- |
| `git` | Whatever remotes your repository configures | Fetch, push, worktree operations you invoke |
| GitHub Copilot CLI | GitHub and the model providers GitHub routes to | Executes the prompt you dispatched |

Prompts, and whatever repository content an agent chooses to read while
answering them, are therefore sent to GitHub and its model providers by the
Copilot CLI, under GitHub's terms — not by Agent Trestle. Copilot URL access is
disabled unless a policy explicitly enables it.

**Where data is stored.** Everything is a file under your project root, so you
can inspect, back up, or delete it with ordinary tools:

| Path | Contents |
| --- | --- |
| `.trestle/config.json` | Project configuration you wrote |
| `.trestle/config/` | Resolved configuration artifacts |
| `.trestle/state/project/`, `.trestle/state/workstreams/<id>/` | File-backed workstream state |
| Audit root (an explicit absolute path you pass) | Per-run, per-writer audit segments |

**Retention.** Nothing expires on its own and nothing is uploaded. State and
audit records live until you delete the directory; `fleet prune` removes
worktrees, and removing `.trestle/state` discards state. Audit segments are
retained deliberately, because a tamper-evident record that silently expires is
not a record.

Logs and error output are redacted before they are written — see
[the security model](docs/security-model.md).

## Accessibility

- **The CLI emits plain text.** No ANSI colour, no cursor control, and no
  Unicode decoration is written to `stdout` or `stderr`, so output stays usable
  in a screen reader, a pipe, a log file, and a terminal without colour
  support. `--json` gives the same information in a machine-readable shape.
  Meaning is carried by words and by stable exit codes, never by colour.
- **The dashboard is keyboard-operable.** It is a static, read-only document
  with no custom widgets: a skip link is the first focusable element, focus
  order follows the document, and focus indicators are the platform defaults
  plus an explicit style on navigation links.
- **The dashboard exposes names and roles.** Landmarks (`header`, `nav`,
  `main`, `footer`), `aria-labelledby` on every section, `aria-label` on card
  lists, `role="status"` on empty states, and a `lang` attribute on the
  document.
- **Text scales and contrast is deliberate.** Sizing is in `rem` so platform
  text-size settings apply, layout reflows below 35rem, and light and dark
  palettes are both defined. Run status is a coloured badge *containing the
  status word*, so no state is conveyed by colour alone.
- **Known limitations.** The accessibility of the dashboard is covered by
  automated regression tests over the rendered markup, not by an audit with
  assistive technology. Contrast ratios were chosen by inspection and have not
  been measured against WCAG thresholds by a tool.

## Language

The primary user-facing language is **English**, and it is the only language
supported. Agent Trestle ships no message catalogs and no locale negotiation;
CLI output, the dashboard, error codes, and documentation are English-only.
Timestamps are emitted as ISO 8601 rather than locale-formatted, because they
are an interchange format read by machines as often as by people.

Contributor surfaces — code, comments, identifiers, commit messages, issues,
pull requests, and release notes — are English as well.

## Repository activity

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/trsdn/agent-trestle/stats/.github/stats/repo-card-dark.svg">
  <img alt="Repository statistics for trsdn/agent-trestle" src="https://raw.githubusercontent.com/trsdn/agent-trestle/stats/.github/stats/repo-card.svg">
</picture>

The card is generated on a schedule by
[`.github/workflows/stats.yml`](.github/workflows/stats.yml) and committed to
the `stats` branch. No third-party statistics service renders it.

## Repository standard

This repository is assessed against the
[trsdn Repository Quality Standard](https://github.com/trsdn/.github/blob/main/docs/repository-quality-standard.md).
The result is recorded in [`.github/conformance.yml`](.github/conformance.yml),
the badge above is generated from that record, and
[docs/self-assessment.md](docs/self-assessment.md) holds the per-criterion
evidence. [`.github/workflows/conformance.yml`](.github/workflows/conformance.yml)
fails the build if record and badge disagree, or if the assessment ages past the
review cadence.

## Provenance

This is an engineering clean-room-style implementation. The provenance audit
records the 2026-08-14 baseline and a current-tree inventory, including the
limits of what can be verified without access to the private predecessor project.
It is **not** formal legal clearance. See
[the provenance audit](docs/provenance-audit.md).

## License

[MIT](LICENSE) © trsdn
