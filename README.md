# Agent Trestle

[![CI](https://github.com/trsdn/agent-trestle/actions/workflows/ci.yml/badge.svg)](https://github.com/trsdn/agent-trestle/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-zero-brightgreen.svg)](THIRD_PARTY_NOTICES.md)

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
- **Linux or macOS.** The worktree fleet requires POSIX ownership semantics and
  fails closed on Windows.

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

## Provenance

This is an engineering clean-room-style implementation. The provenance audit
records the 2026-08-14 baseline and a current-tree inventory, including the
limits of what can be verified without access to the private predecessor project.
It is **not** formal legal clearance. See
[the provenance audit](docs/provenance-audit.md).

## License

[MIT](LICENSE) © trsdn
