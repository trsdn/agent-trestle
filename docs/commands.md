# CLI commands

All terminating commands accept `--json`. Errors are emitted to stderr as
`{"ok":false,"error":{"code":"...","message":"..."}}`.

## Global options

Accepted by every command:

- `--root PATH` — project root (default: current directory).
- `--json` — machine-readable output where the command terminates.
- `--help` — print usage and exit 0.
- `--version` — print the package version and exit 0.

Unknown options are rejected with exit code 2 *before* any command side effect.

## Commands

- `agent-trestle init [--root PATH] [--force]`
- `agent-trestle validate [--root PATH]`
- `agent-trestle doctor [--root PATH] [--binary PATH]`
- `agent-trestle resolve --project ID --workstream ID --role ID`
- `agent-trestle dispatch --project ID --workstream ID --role ID
  (--prompt TEXT | --prompt-file FILE) [--skill ID ...] [--binary PATH]
  [--sandbox] [--no-audit]`
  where `--binary` overrides `config.copilot.binary` for this invocation and
  `--sandbox` runs the agent inside the configured container sandbox. See
  [Container sandbox](#container-sandbox).
- `agent-trestle review --base REF --head REF --producer ID --reviewer ID
  [--attempts N] [--timeout-ms MS] [--no-audit]`
  runs a read-only exact-diff gate. `--attempts` defaults to 1 and
  `--timeout-ms` to 120000.
  Adding `--merge --ownership FILE --actor ID` performs a gated merge; it
  refuses unless `permissions.autoMerge` is enabled and every changed path is
  owned by the actor. See [Merge semantics](merge-semantics.md).
- `agent-trestle fleet create --worktree-root PATH --id ID
  [--start-point REF]`
- `agent-trestle fleet remove --worktree-root PATH --id ID --path PATH
  [--force] [--outcome failed]`
- `agent-trestle fleet prune --worktree-root PATH`
- `agent-trestle dashboard [--data FILE] [--port PORT]`. With no `--data` it
  reads the project's own runtime records from `.trestle/audit/`; `--data`
  renders an exported record instead. The CLI exposes no `--host` flag, so it
  always binds `127.0.0.1`.
- `agent-trestle state-server --workstream ID --schemas FILE` runs stdio JSON-RPC/MCP
  and writes no non-protocol output to stdout.
- `agent-trestle state-lock --workstream ID --namespace NS --key KEY
  [--scope project|workstream]` reports per-key lock identity and recovery
  assessment (`token`, `pid`, `host`, `epoch`/`acquiredAt`, `ageMs`,
  immutable `ino`/`dev`, liveness/status). When the lock is recoverable it also
  emits an executable `unlock` hint (`tool`, `arguments`, `cli`) that is runnable
  exactly as returned. A stale recovery barrier is reported separately with a
  `recoveryUnlock` hint.
- `agent-trestle state-unlock --workstream ID --namespace NS --key KEY
  (--expected-token TOKEN [--expected-inode N] [--expected-device N]
  | --expected-inode N --expected-device N) [--recovery]
  [--scope project|workstream]` is the fail-closed operator recovery path for
  stale locks. A well-formed lock is cleared by its exact
  `--expected-token` (optionally pinned further with
  `--expected-inode`/`--expected-device`). A **malformed** (tokenless) lock —
  for example a zero-length file left when a crash interrupts lock creation —
  has no token to present, so it is cleared instead by pinning its immutable
  file identity: both `--expected-inode` **and** `--expected-device`. Use
  `--recovery` only with the separate recovery-barrier hint. It refuses to clear
  live locks, valid tokened locks without their token, and revalidates the
  target and every parent directory immediately before pathname unlinking,
  failing closed (`LOCK_REPLACED`) if the file or an intermediate parent was
  swapped in the checked window. Node does not provide a portable atomic
  directory-capability unlink; automatic stale deletion is therefore disabled,
  and the operator must quiesce the state directory if the final syscall window
  is in the threat model.
- `agent-trestle run --manifest FILE [--concurrency N] [--binary PATH]
  [--isolate] [--worktree-root PATH] [--sandbox] [--no-audit]`
  executes a task manifest: a dependency-ordered graph of agent dispatches.
  See [Task manifests](#task-manifests) below.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | Success or a persistent server started |
| 1 | Operation or dispatched process failed |
| 2 | Invalid command or arguments |
| 3 | Reserved. Previously "recognized feature is not yet supported"; no command emits it now that `run` is implemented, and it will not be reused for another meaning |
| 4 | Environment/doctor check failed |
| 5 | Policy or review blocked the requested operation |

`dispatch` preserves process failure as exit code 1. A non-passing review exits
5. `run` exits 2 for a manifest that cannot produce a runnable graph, 1 when a
task fails, and 5 when the graph is blocked. The state server uses JSON-RPC error
objects after startup.

## Audit records

`dispatch`, `run`, `review` and `fleet` write tamper-evident audit segments under
`.trestle/audit/` (already gitignored). Emission is **on by default** and each
command accepts `--no-audit` to suppress it.

Segments are NDJSON with a per-writer hash chain, laid out as
`.trestle/audit/runs/<runId>/tasks/<taskId>/segments/<writerId>--<segmentId>.ndjson`.
Writers are scoped per actor rather than funnelled through one global chain,
because independent segments are what allow parallel writers to append without
corrupting each other. Reconstruct a task's record with `reconcileAuditTask`
from the `agent-trestle/audit` export.

| Command | `runId` | `taskId` | `writerId` | Events |
|---|---|---|---|---|
| `dispatch` | generated `dispatch-…` | `project.workstream.role` | `dispatch` | `dispatch.started`, `dispatch.settled` |
| `run` | manifest `id`, else generated | `run` | `run` | `run.started`, `run.settled` |
| `run` (per task) | as above | manifest task `id` | `dispatch` | `dispatch.started`, `dispatch.settled` |
| `review` | generated `review-…` | `review` | `review` | `review.started`, `review.settled` |
| `fleet` | generated `fleet-…` | `fleet` | `fleet` | `fleet.created`, `fleet.removed`, `fleet.pruned` |
| `run` (isolated task) | as run | manifest task `id` | `dispatch` | `worktree.created`, `worktree.released`, `worktree.retained` |

`dispatch.started` is written *before* the process starts and records the
resolved route, agent, selected skills, the effective permission set, the
permission arguments actually passed, the working directory and the binary — so
a dispatch that never settles still leaves evidence of what was granted.
`dispatch.settled` records the terminal outcome including a non-zero exit.
`review.settled` records the exact diff hash that was gated on, the pinned base
and head OIDs, the changed paths and the verdict.

Raw `stdout`/`stderr` are never copied into a record: an audit segment is an
integrity record, not a log sink.

**An audit write failure fails the command.** It is never downgraded to a
warning, because a success-shaped result with no audit trail is exactly the
outcome the subsystem exists to prevent. The failure surfaces with code
`AUDIT_WRITE_FAILED`.

## Dashboard runtime records

`agent-trestle dashboard` is a read-only view with no authority to mutate or
merge work. With no `--data` argument it reconstructs its model from the audit
segments the runtime already wrote under `.trestle/audit/`, so the view cannot
drift from what actually happened. `--data FILE` still renders an exported
record for offline inspection.

Reconstruction is bounded: at most the 50 most recent runs are read, each
collection is trimmed to the configured item limit before normalization, and the
normalizer then enforces total bytes, item count, string length and nesting depth
— rejecting anything still over the limit rather than silently truncating it. A
segment whose hash chain fails verification is reported as a failed `audit`
entry rather than aborting the page — surfacing tampering is the point.

The model is a set of record collections. A worked example is in
[`examples/dashboard-record.json`](../examples/dashboard-record.json).

| Collection | Contents |
|---|---|
| `projects` | `{ id, kind, name }` derived from dispatched routes |
| `workstreams` | `{ id, kind, name, project }` |
| `runs` | `{ id, kind, name, status, startedAt, finishedAt, concurrency, taskCount, failedTask? }` |
| `tasks` | `{ id, kind, name, runId, status, startedAt, finishedAt, dispatches, project, workstream, role, agent, exitCode, message, worktree?, branch? }` |
| `reviews` | `{ id, kind, name, status, baseRef, headRef, reviewedDiffHash, timestamp }` |
| `audit` | `{ id, kind, name, status, segments, records, reconciliationHash }` per reconciled task |
| `failures` | Derived from any run, task or review whose status is `failed`, `blocked` or `rejected` |
| `generatedAt` | ISO timestamp of the render |

A `dispatch` invoked outside `run` has no run-level writer, so a run entry is
synthesized from its tasks rather than dropping them from the view.

## Task manifests

`run` takes a versioned JSON manifest describing a task graph. The contract is
defined by [`schemas/manifest.schema.json`](../schemas/manifest.schema.json),
which is closed: unknown keys are rejected rather than ignored. A worked example
is in [`examples/task-manifest.json`](../examples/task-manifest.json).

Policy lives in the manifest, not in `.trestle/config.json`. Per-run stop
conditions are execution policy, so the project config schema stays small and
closed while the manifest carries what varies per run.

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | Must be `1`. |
| `id` | no | Run identifier, used to scope run records. |
| `tasks[].id` | yes | Unique lowercase task ID. |
| `tasks[].route` | yes | Explicit `project`, `workstream` and `role`. Never inferred. |
| `tasks[].prompt` | one of | Literal prompt text. |
| `tasks[].promptFile` | one of | Prompt path, resolved inside the project root. |
| `tasks[].skills` | no | Skills requested for this task. |
| `tasks[].dependsOn` | no | Task IDs that must complete first. |
| `tasks[].stop` | no | At least one of `maxRounds`, `maxDurationMs`, `maxNoOpRounds`. |

Exactly one of `prompt` and `promptFile` must be present. A `promptFile` is read
through the same pinned-directory checks as project configuration, so a path
that escapes the project root, or a symlink swapped mid-read, fails closed.

### Execution semantics

- Tasks run in dependency order. `--concurrency N` bounds how many run at once
  and **defaults to 1**, preserving the least-surprise behaviour of `dispatch`.
- A task with no `stop` object runs exactly once.
- A task with a `stop` object runs repeated rounds until it converges or hits a
  declared bound. Convergence is measured with a work signature over the
  workstream's Git state (`HEAD` plus `git status`), so a round that changed
  nothing terminates the task with reason `no-op`. Other reasons are
  `max-rounds` and `max-duration`.
- A non-zero exit, a timeout, or an output-cap kill fails the task. A failed
  process is never reported as a successful task.
- A task failure aborts the run; dependent tasks stay `pending` and are reported
  as such.
- `SIGINT`/`SIGTERM` abort the run and tear down running process trees through
  the existing supervision path.

### Worktree isolation

By default a task runs in the workstream directory resolved from the project
root, so two tasks routed to the same workstream share one working tree. Pass
`--isolate` to give **each task its own Git worktree** instead:

- The worktree is created when the task starts and its path becomes the agent
  process's working directory.
- The fleet root defaults to `.trestle/worktrees/` (already gitignored) and can
  be moved with `--worktree-root PATH`.
- Each task gets a per-run branch (`trestle/task-…`), which is the head ref
  `review` can gate on.

Worktree lifetime is bound to the work, and the three outcomes differ
deliberately:

| Outcome | Worktree | Why |
|---|---|---|
| Task completed | removed | Nothing left to inspect. |
| Task failed | **retained** | The operator needs to see what the agent actually produced. Reported as `worktreeStatus: "retained"`. |
| Run interrupted | removed | An abort is the operator stopping the run, not a reviewable result. Accumulating a checkout on every interruption would be a leak, not evidence. |

A failed task and an interrupted one both surface as a non-`ok` execution, so
they are told apart by the process `aborted` flag rather than by whether the
task threw.

On interruption the run releases every worktree it still holds and then runs
`git worktree prune`, so an aborted run leaves nothing registered with Git.

`--isolate` requires the project root to be a Git repository, and the fleet
fails closed with `INSECURE_CONTAINMENT` rather than operating on a directory
whose ownership cannot be proven — which is also why it does not work on
Windows.

### Failing before side effects

A manifest that cannot produce a runnable graph is rejected with exit code 2
*before any process is spawned*. This includes unknown keys, a missing or
duplicated prompt source, a dependency on an unknown task, a self-dependency, a
dependency cycle (reported with the offending task IDs), and a route naming an
unknown project, workstream or role.

### Reported output

`--json` reports the graph: per-task `status`, `rounds`, the `stop` reason, and
one entry per dispatch. Raw `stdout`/`stderr` are summarized as `stdoutBytes`
and `stderrBytes` rather than embedded, because each stream is capped at 10 MiB
per dispatch and a multi-task, multi-round graph would otherwise emit a payload
hundreds of megabytes wide. Use `dispatch` when you need the raw output of a
single agent invocation.

## State server tool surface

`state-server` speaks JSON-RPC/MCP over stdio and exposes exactly nine tools.
Most take `scope` (`project` or `workstream`, default `workstream`), `namespace`,
and `key`.

| Tool | Purpose |
|---|---|
| `trestle_state_read` | Read one state value. |
| `trestle_state_write` | Atomically write one schema-validated state value. |
| `trestle_state_append` | Atomically append to a schema-validated array. |
| `trestle_state_delete` | Delete one mutable state value. |
| `trestle_state_list` | List state keys. |
| `trestle_state_health` | Report state server health and explicit roots. |
| `trestle_state_lock_status` | Inspect one per-key lock (token/pid/host/age, immutable inode+device). |
| `trestle_state_unlock` | Clear one stale lock or recovery barrier under the recovery contract below. |
| `trestle_decide` | Record a schema-validated decision in the `decisions` namespace. |

`trestle_state_lock_status`/`trestle_state_unlock` mirror the `state-lock`/
`state-unlock` CLI contract exactly, including the tokenless
`expectedInode` + `expectedDevice` authorization for malformed locks. Every
mutable namespace must be declared in the `--schemas` registry; see
[configuration](configuration.md#state-contract).

## State lock recovery contract

- Normal writers never delete stale locks automatically. Same-host dead-PID,
  old, remote-host, or otherwise indeterminate locks fail closed with
  `LOCK_STALE` and include the expected-token unlock hint in JSON error details.
- Malformed (tokenless) locks — e.g. a zero-length file left when a crash
  interrupts lock creation — cannot present a token, so they fail closed with a
  hint whose `authorization` is `expected-identity`: recover them with
  `state-unlock --expected-inode ... --expected-device ...`.
- Operators inspect with `state-lock`, then run the emitted `unlock` hint exactly
  as returned: `state-unlock --expected-token ...` for a well-formed lock, or
  `state-unlock --expected-inode ... --expected-device ...` for a malformed one.
- If `state-lock` reports `recoveryUnlock`, operators must run that hint with
  `--recovery`; writers never remove a `needsOperator` recovery barrier.
- Recovery revalidates the lock's inode+device and all parent identities via a
  no-follow descriptor/check immediately before pathname unlinking and fails
  closed (`LOCK_REPLACED`) if the file or a parent was replaced in the checked
  window.
- Live locks and valid tokened locks (without their token) are never removed by
  the CLI contract.

## Worktree fleet containment contract

- `git` resolves the worktree paths it is handed on its own and cannot be pinned
  to a directory handle portably, so `fleet create`/`remove`/`prune` **fail
  closed** unless the relevant root is *securely held*: every component of
  `--worktree-root` (and the repository root) must be a real directory — no
  symbolic link — owned by the current user or root, with no group/other-writable
  ancestor (a sticky ancestor such as a private `/tmp` subtree is allowed, but the
  staging directory itself must not be group/other-writable).
- When that guarantee cannot be proven — an untrusted owner, a writable or
  symlinked path component, or a platform without POSIX ownership (e.g. Windows) —
  automatic `create`/`remove` are refused with `INSECURE_CONTAINMENT` **before**
  `git` runs, so a root-replacement race cannot redirect a write or deletion
  outside the pinned root. Relocate `--worktree-root` under a directory you own
  that is not writable by others to re-enable it.

## Container sandbox

`--sandbox` runs the agent inside a container instead of as a direct child of
this process. Where the rest of this document constrains what *Agent Trestle*
writes, this constrains what the *agent* can reach: containment becomes a
property of the kernel's mount and network namespaces rather than of a working
directory the agent is merely pointed at.

It is off by default on Linux and macOS, and **required on Windows**, where
`dispatch` and `run` exit 3 with `SANDBOX_REQUIRED` without it — an unsandboxed
agent cannot be spawned there without a shell, and Windows has no process
groups to bound one with. Declaring a sandbox does not enable one. `--sandbox`
enables it, and asking for it without a `sandbox` block in
`.trestle/config.json` is a usage error (exit 2) rather than a silent fall back
to running unsandboxed.

```json
{
  "sandbox": {
    "image": "ghcr.io/example/copilot:1",
    "runtime": "docker",
    "network": "none",
    "pidsLimit": 512,
    "memory": "2g",
    "cpus": "2",
    "env": ["HTTPS_PROXY"],
    "copilotHome": "/home/dev/.copilot"
  }
}
```

Only `image` is required. The block is closed, like the rest of the config
schema: an unknown key fails rather than silently failing to constrain
anything.

Every invocation gets `--rm`, `--cap-drop ALL`,
`--security-opt no-new-privileges`, a `--pids-limit`, the project working
directory bind-mounted at `/work` as the only mount, and `--workdir /work`. On
POSIX the container also runs as the invoking uid/gid so agent output is not
left root-owned on the host.

Defaults deny, and each escalation is separately visible:

| Key | Default | Escalation |
| --- | --- | --- |
| `network` | `none` | `bridge` grants egress. Copilot CLI needs it to reach the API, so a real run is an explicit choice, not an accident. |
| `env` | `[]` | Named host variables are passed **by name**, so a value never reaches argv or an audit record. |
| `copilotHome` | unset | Mounted read-only at `/copilot-home`. |
| `runtime` | `docker` | `podman` is also accepted. `host` networking is not accepted at all. |

The sandbox is recorded in `dispatch.started` and returned on the execution
result, so an audit reader can tell a sandboxed run from an unsandboxed one and
see exactly what it granted.

### What this does and does not protect

A container bounds the *blast radius* of a misbehaving agent: it cannot read
your home directory, and with `network: "none"` it cannot reach anything at
all. That is what makes `permissions.allowAllTools` a reasonable thing to grant.

It does not make credentials safe. An agent that can use a mounted Copilot
credential can still use it, whatever the filesystem boundary. Prefer a
short-lived credential, and treat `network: "bridge"` as the point at which
egress becomes possible.

A container is also not a security boundary against a kernel exploit. It is a
large improvement over a working directory, not a guarantee.

