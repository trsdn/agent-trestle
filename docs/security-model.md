# Security model

Agent Trestle is a local orchestration tool, not a sandbox. A Copilot agent can
only be as safe as the permissions granted to its process.

## Default-deny policy

The default policy does not grant:

- all tools;
- unrestricted filesystem paths;
- unrestricted URLs;
- unattended prompts;
- automatic branch merge.

Each escalation is separately visible in effective configuration. Headless use
must reference an explicit policy that acknowledges its capabilities.

## Review boundary

A producer cannot review its own task. Reviewers receive no tools: the exact
diff is already embedded in the prompt, and Copilot CLI's empty
`--available-tools` filter avoids version-sensitive tool identifiers. The
command also uses `--silent` so stdout contains only the agent response, with
custom instructions, built-in MCPs, remote control, and auto-update disabled. The
reviewer's child environment is built from a strict allowlist (`PATH`; the
`TMPDIR`/`TEMP`/`TMP` scratch-space variables; Windows `SystemRoot`, `windir`,
`PATHEXT`, and `SystemDrive`; locale variables; proxy variables) rather than a
list of variables to block, and `NODE_OPTIONS`, every other `NODE_*` variable,
every `OTEL_*` variable, and `COPILOT_OTEL_*` are additionally excluded by
name pattern even if a future allowlist edit would otherwise admit them; any
variable whose name matches a case-insensitive secret pattern (token, secret,
key, password, credential, auth, cert, private, ...) is dropped regardless of
which list it came from. The reviewer's
`COPILOT_HOME`/`cwd` is a freshly created, mode-restricted (`0700`) directory
outside the reviewed repository, and the reviewer is not given a `--add-dir`
grant for the repository, so no repository or user MCP/plugin configuration
can load; it is removed only after the reviewer process has settled. A
project-defined custom reviewer agent is made discoverable without
ever moving the reviewer's `cwd`/`COPILOT_HOME` into the reviewed repository:
its `.github/agents/<id>.agent.md` definition and any declared skills are
loaded and validated with the same secure, symlink-safe loaders used for
producer agents, then re-rendered into a minimal, sanitized copy - carrying
only `model` and `description`, never `tools`, `mcp-servers`, or any other
capability-widening key the source file declared - and materialized at
`$COPILOT_HOME/agents/<id>.agent.md`, the location Copilot CLI already
searches for a user-level custom agent regardless of `cwd`. Built-in Copilot
CLI agents skip this lookup entirely. A reviewer ID that is neither a builtin
nor a loadable project agent fails closed before any reviewer process is
spawned. The reviewer prompt is identified by its actual trailing
`-p`/`--prompt` argv position (not by scanning for the flag anywhere in argv),
so an agent or reviewer identifier that happens to equal `-p` cannot cause the
true prompt to leak, unredacted, through results, errors, or `spawnargs`.
Prompt/secret redaction recurses through the full `cause` chain of an error
unconditionally - not only when an error's own message or args match - and
redacts a non-object (for example string) cause directly, so a leak nested
several causes deep is still caught. Untrusted diffs are fenced as data, and
only a nonce-bound verdict is accepted. Empty, malformed, oversized,
timed-out, or failed reviews fail closed.

A passing review records the digest of the exact base-tree to constructed
merge-tree diff. The merge tree and changed paths are recomputed immediately
before merge; any drift, multiple merge bases, missing `permissions.autoMerge`,
or rejected ownership policy blocks the merge. Ownership checks consume
Git-style POSIX repo-relative paths, so a literal backslash remains part of a
filename byte; Windows path normalization is only used when a caller opts into
it explicitly.

## Filesystem boundary

Configuration declares repository, workstream, state, audit, and owned roots.
All derived paths are resolved and checked against their root. Relative path
traversal, symlink escape where detectable, and undeclared changed paths are
rejected.

Repository and worktree-fleet roots are pinned by real path and device/inode
identity, and the pin holds the directory open for as long as it is live. The
open descriptor is load-bearing: Linux filesystems (ext4, overlayfs) hand a
freed inode number straight back to the next directory created at the same
pathname, so device/inode identity alone cannot distinguish an `rm`+`mkdir`
replacement from the original. Holding the inode allocated forces the
replacement onto a different identity and additionally exposes the removal as a
zero link count. A same-path replacement, symlink component, or remove candidate
that does not physically remain below the pinned fleet root fails closed before
Git is invoked. Releasing a pin surrenders that guarantee, so verifying a
released pin fails closed with `PIN_RELEASED` rather than silently falling back
to the weaker check.

Because external Git resolves the worktree paths it is given on its own — and
cannot portably be bound to a Node directory handle — pinning alone can only
*detect* a root swap after Git has already written through it. Automatic worktree
creation and removal are therefore additionally gated on the roots being
*securely held*: every path component from the filesystem root down to the
repository and fleet roots must be a real directory owned by the current user or
root, with no group/other-writable ancestor (a sticky ancestor is tolerated, but
the staging directory itself must not be group/other-writable, because new
worktree entries are created inside it). This denies an untrusted user the write
access a symlink/rename swap requires, making an escaped write **impossible**
rather than merely observable. When the guarantee cannot be proven — an untrusted
owner, a writable or symlinked component, or a platform that cannot report POSIX
ownership — `create`/`remove` fail closed with `INSECURE_CONTAINMENT` before Git
runs.

Per-key state writes use identity-bearing lock files (`token`, `pid`, `host`,
`epoch`, `acquiredAt`). Stale-lock deletion is **never automatic**, including
for a dead PID on the same host: writers fail closed and require the explicit
operator recovery contract. Remote, malformed, and otherwise indeterminate
locks likewise remain in place until an operator authorizes recovery. A
**malformed** lock (for example a zero-length file left when a crash interrupts
lock creation) has no token to prove ownership, so tokenless operator recovery
is permitted only when the operator pins the lock's immutable file identity —
both inode **and** device — and never for a valid tokened or live lock.
Recovery barriers marked `needsOperator` are also never removed by a writer;
`state-lock` exposes a separate recovery-barrier hint, which must be run with
`--recovery`.

Before a removal, Trestle revalidates the no-follow target identity and every
parent directory's device/inode identity. Node 20/22 do not expose a portable
`unlinkat(2)`/directory-capability API, so this is a checked pathname operation,
not an atomic guarantee against a replacement in the final syscall window.
Automatic stale recovery is disabled to avoid silently taking that residual
risk. Normal release remains automatic for the lock the current writer owns;
explicit `state-unlock` is an operator-authorized destructive action and
requires the exact observed token or immutable identity. If the documented
threat model includes an active parent-replacement race during that final
window, quiesce the state directory and perform recovery manually. Live locks
are never reclaimed automatically.

## Platform support

Linux and macOS are the supported platforms. `package.json` declares
`"os": ["!win32"]`, so npm refuses a Windows install outright with
`EBADPLATFORM` rather than letting the constraint surface part-way through a
run.

The constraint is broader than the worktree fleet. Three of the guarantees in
this document rest on POSIX primitives that Windows does not provide:

- **Symlink-safe opens.** Audit and state writes open their target with
  `O_NOFOLLOW`, so a symlink swapped in at the path is refused by the kernel
  instead of followed. Where the flag does not exist the open fails closed with
  `UNSUPPORTED_PLATFORM`, which takes out audit recording and the state store —
  so *every* command loses the guarantee, not only `run --isolate`.
- **Ownership proof.** Secure-hold verification reads the POSIX owner and mode
  bits of every path component. Without `process.getuid` that proof cannot be
  constructed, so the fleet fails closed with `INSECURE_CONTAINMENT`.
- **Process-group termination.** Copilot, reviewer, and Git children are spawned
  detached and signalled as a process group, so a hook or helper they fork
  cannot outlive termination. Windows has no equivalent, so only the direct
  child can be signalled.

The first two fail **closed**, which is the correct outcome but leaves little
that still runs. The third degrades **open**: a forked helper could survive a
cancelled or timed-out run. A platform on which a containment guarantee silently
weakens contradicts the fail-closed rule the rest of this document depends on,
so the platform is refused at install time instead of being partially
supported.

## Network boundary

The dashboard CLI exposes no `--host` flag and therefore always binds
`127.0.0.1`; the underlying `createDashboardServer` API defaults to `127.0.0.1`
and serves no remote assets. Copilot URL access is disabled unless explicitly
enabled by policy.
