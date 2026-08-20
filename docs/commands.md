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
  (--prompt TEXT | --prompt-file FILE) [--skill ID ...] [--binary PATH]`
  where `--binary` overrides `config.copilot.binary` for this invocation.
- `agent-trestle review --base REF --head REF --producer ID --reviewer ID
  [--attempts N] [--timeout-ms MS]`
  runs a read-only exact-diff gate. `--merge` returns `NOT_SUPPORTED`.
  `--attempts` defaults to 1 and `--timeout-ms` to 120000.
- `agent-trestle fleet create --worktree-root PATH --id ID
  [--start-point REF]`
- `agent-trestle fleet remove --worktree-root PATH --id ID --path PATH
  [--force] [--outcome failed]`
- `agent-trestle fleet prune --worktree-root PATH`
- `agent-trestle dashboard --data FILE [--port PORT]`. The CLI exposes no
  `--host` flag, so it always binds `127.0.0.1`.
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
- `agent-trestle run` is reserved and returns `NOT_SUPPORTED`; no success-shaped
  placeholder is emitted.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | Success or a persistent server started |
| 1 | Operation or dispatched process failed |
| 2 | Invalid command or arguments |
| 3 | Recognized feature is not yet supported |
| 4 | Environment/doctor check failed |
| 5 | Policy or review blocked the requested operation |

`dispatch` preserves process failure as exit code 1. A non-passing review exits
5. The state server uses JSON-RPC error objects after startup.

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
