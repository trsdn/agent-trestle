# Security model

Agent Trestle is a local orchestration tool. By default it is **not** a sandbox:
an agent is exactly as contained as the permissions granted to its process, and
no more. `--sandbox` is the opt-in that changes that, moving containment of the
agent into a container's mount and network namespaces — see
[Container sandbox](#container-sandbox).

Read that distinction carefully, because the rest of this document is mostly
about a different thing. Everything below on paths, locks and audit constrains
what *Agent Trestle itself* writes, and defends it against a hostile local user.
Only the sandbox constrains what the *agent* can reach.

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

## Container sandbox

`--sandbox` is the only control in this document that constrains the agent
rather than Agent Trestle. It rewrites the Copilot invocation into a container
run, so the working directory the agent is given is enforced by a mount
namespace instead of merely being where it was started.

The rewrite happens after the Copilot argv is fully built and before anything is
spawned, and the original command is appended last and unchanged. The existing
process adapter therefore keeps ownership of spawning, supervision, output caps
and prompt redaction, and the trailing `-p <prompt>` pair stays in final
position so positional redaction still masks the right element. An invalid
sandbox declaration fails before a process exists.

Defaults deny: no network, all capabilities dropped, `no-new-privileges`, a
bounded pid count, and the project working directory as the only mount. Host
environment variables are passed **by name**, so a value never reaches argv,
a process listing, or an audit record. A mounted Copilot home is read-only.
Values that a runtime would parse as options are rejected, and a mount source
may not smuggle extra `:`-separated fields — on Windows a drive letter is the
only colon allowed.

This is a blast-radius control, not a credential control. An agent that can use
a mounted credential can still use it, and `network: "bridge"` — which Copilot
CLI needs to reach its API — is the point at which egress becomes possible.
Both are deliberate, explicit escalations rather than defaults.

The full option surface is in
[the commands reference](commands.md#container-sandbox).

## Platform support

Linux and macOS are supported directly. Windows is supported for agent
execution **through the sandbox only**, and the CLI enforces that rather than
documenting it: `dispatch` and `run` without `--sandbox` exit 3 with
`SANDBOX_REQUIRED` there.

That is not caution for its own sake. Two things are genuinely missing on
Windows, and the container supplies both:

- **A spawnable agent.** npm installs Copilot CLI as a `.cmd` shim, and Node
  refuses to spawn `.cmd` without `shell: true` (the CVE-2024-27980
  mitigation). A shell concatenates argv rather than escaping it, and the prompt
  travels in argv, so the process adapters do not use one. `docker` is a real
  executable and spawns directly.
- **A bound on what the agent leaves behind.** `process.kill(-pid)` returns
  `ESRCH` on Windows, so a helper an agent forks could outlive termination.
  Inside a container the whole process tree goes with it.

Two constraints remain, and both fail **closed**:

- **The worktree fleet.** Secure-hold verification reads the POSIX owner and
  mode bits of every path component, and Windows exposes no uid to build that
  proof from, so `fleet` and `run --isolate` refuse with
  `INSECURE_CONTAINMENT`. Reconstructing the proof from NTFS ACLs would mean a
  security-critical parser and a subprocess per path component, to buy a
  guarantee weaker than the refusal it replaced.
- **Symlink-safe opens** are reconstructed rather than delegated to the kernel,
  as described above. They detect rather than prevent, and they fail closed.

Windows also implements delete-while-open by unlinking the name and parking the
file under the NTFS metadata directory `\$Extend\$Deleted` until the last handle
closes. `realpath` still resolves such an entry — to that reserved location —
and during the same window can instead fail with `EPERM`, `EBADF` or `EBUSY`
where POSIX would simply have said `ENOENT`. Path containment treats all of
these as the deletion they are; `\$Extend` is NTFS-internal and cannot be
written by user code, so it cannot be used to smuggle a path.

### Windows via WSL2

WSL2 is the supported way to run from a Windows host. It is a real Linux
kernel, so `O_NOFOLLOW`, POSIX ownership, and process groups all behave
natively and nothing in this document is weakened.

Keep the checkout on the WSL2 filesystem (under `~`, for example), not on a
Windows drive under `/mnt/c`. DrvFs *synthesizes* Linux metadata rather than
translating NTFS ACLs: by default it reports every path as owned by `root` with
mode `0777`, which secure-hold verification refuses as group/other-writable —
the right answer, but reached for the wrong reason. Mounting with the
`metadata` option and tightening the mode would silence that refusal without
making it true, because the synthesized owner and mode still do not reflect the
NTFS ACLs that actually govern access. A checkout on the native filesystem
avoids the question entirely, and is substantially faster.

## Network boundary

The dashboard CLI exposes no `--host` flag and therefore always binds
`127.0.0.1`; the underlying `createDashboardServer` API defaults to `127.0.0.1`
and serves no remote assets. Copilot URL access is disabled unless explicitly
enabled by policy.
