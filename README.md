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
> **Project status: pre-release (`0.1.0`).** The command surface is
> functional but not yet API-stable. `run` and CLI-driven review merge are
> deliberately unimplemented and exit with `NOT_SUPPORTED`.

---

## Why it exists

Running one agent is easy. Running several against a shared repository creates
problems that a prompt cannot solve:

| Problem | How Agent Trestle addresses it |
| --- | --- |
| Two agents edit the same files | Isolated Git worktrees per task, plus ownership policy enforcement |
| An agent loops forever | A bounded scheduler with explicit, declared stop conditions |
| A failed process looks like success | Process failure is preserved end-to-end and cannot be reported as task success |
| Approved code differs from merged code | An exact-diff review gate binds approval to specific content, and the CLI exposes no merge path at all |
| Parallel writers corrupt the log | Independent per-writer audit segments instead of one global hash chain |
| Agents quietly gain broad permissions | Unrestricted tools, paths, URLs, and auto-merge are all opt-in |

## Requirements

- **Node.js ≥ 20** (developed and CI-tested on 20 and 22)
- **Git**
- **GitHub Copilot CLI** on your `PATH`
- **Linux or macOS.** The worktree fleet requires POSIX ownership semantics and
  fails closed on Windows.

## Install

The package is not yet published to npm. Install it from a local clone:

```bash
git clone https://github.com/trsdn/agent-trestle.git
cd agent-trestle
npm link          # exposes the `agent-trestle` binary
```

The executable is intentionally named only `agent-trestle`, never `trestle`, to
avoid colliding with existing npm packages that already install a `trestle`
binary.

## Quickstart

```bash
# 1. Scaffold .trestle/config.json and a starter agent definition
agent-trestle init

# 2. Confirm the configuration is well-formed
agent-trestle validate

# 3. Confirm the environment (Node, Git, Copilot CLI) is usable
agent-trestle doctor

# 4. See which agent a given route resolves to, without running anything
agent-trestle resolve --project example-project --workstream main --role builder

# 5. Run one agent, once
agent-trestle dispatch \
  --project example-project \
  --workstream main \
  --role builder \
  --prompt "Add a regression test for the config loader"
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
{ "ok": false, "error": { "code": "NOT_SUPPORTED", "message": "..." } }
```

## Command surface

| Command | Purpose |
| --- | --- |
| `init` | Scaffold `.trestle/` configuration into a project |
| `validate` | Check configuration against the schema |
| `doctor` | Verify the local environment and Copilot binary |
| `resolve` | Show the agent a route resolves to, without executing |
| `dispatch` | Resolve one agent and run one Copilot process |
| `review` | Run a read-only exact-diff review gate |
| `fleet` | Create, remove, and prune isolated Git worktrees |
| `dashboard` | Serve a read-only local dashboard (binds `127.0.0.1` only) |
| `state-server` | Run the workstream state store over stdio JSON-RPC/MCP |
| `state-lock` / `state-unlock` | Inspect and recover stale state locks |
| `run` | Reserved; exits `NOT_SUPPORTED` until the task-manifest contract is stable |

Exit codes are stable: `0` success, `1` operation failed, `2` bad arguments,
`3` unsupported feature, `4` environment check failed, `5` policy or review
blocked the operation. Full details in [docs/commands.md](docs/commands.md).

## Security posture

Agent Trestle launches AI agents that can read and modify repositories, so it
defaults to least privilege:

- unrestricted tools, filesystem paths, and URLs are **disabled** by default;
- non-interactive execution requires an explicit policy;
- the CLI exposes no merge path at all — `review --merge` returns
  `NOT_SUPPORTED`, and programmatic merge additionally requires an exact-diff
  passing review plus explicit `permissions.autoMerge`;
- the dashboard binds only to `127.0.0.1`;
- state and audit paths are constrained to configured project roots;
- worktree operations **fail closed** with `INSECURE_CONTAINMENT` rather than
  run against a path whose ownership cannot be proven.

Read [SECURITY.md](SECURITY.md) for the reporting process and
[docs/security-model.md](docs/security-model.md) for the threat model.

## Documentation

| Document | Contents |
| --- | --- |
| [Architecture](docs/architecture.md) | Runtime boundaries and safety invariants |
| [Configuration](docs/configuration.md) | `.trestle/config.json` schema and keys |
| [Commands](docs/commands.md) | Full CLI reference, exit codes, recovery contracts |
| [Security model](docs/security-model.md) | Threat model and containment guarantees |
| [Provenance](docs/provenance.md) | Clean-room development process |
| [Provenance audit](docs/provenance-audit.md) | Findings of the targeted audit |
| [Name clearance](docs/name-clearance.md) | Why the binary is named `agent-trestle` |
| [Downstream migration](docs/downstream-migration.md) | Golden-diff contract for the first external consumer |

## Development

```bash
npm run lint      # dependency-free syntax, JSON, and whitespace checks
npm test          # full Node built-in test runner suite
npm run check     # lint + test + packaging verification
```

There is no ESLint or Prettier by design — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). `npm run lint` is implemented
in [`scripts/lint.mjs`](scripts/lint.mjs) using only Node built-ins.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Provenance

This is an engineering clean-room-style implementation. A targeted provenance
audit found no copied implementation in the reviewed scope; that engineering
finding is **not** formal legal clearance, and it covers the 2026-08-14 baseline
(commit `eb853c5`) only — files added and modified since then are not yet
covered. See [the provenance audit](docs/provenance-audit.md).

## License

[MIT](LICENSE) © trsdn
