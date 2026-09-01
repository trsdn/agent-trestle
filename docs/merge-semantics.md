# Merge semantics

`agent-trestle review --merge` completes the loop the project exists to
automate: an agent produces work, the exact-diff gate approves it, and the
approved content is merged. Merging is the most destructive thing this tool can
do, so its semantics are stated here in full before anything moves.

The guarantee is narrow and specific:

> **The content merged is byte-identical to the content that was reviewed, or
> nothing is merged at all.**

## What is reviewed

The gate does not review "the branch". It reviews a specific diff:

- `baseRef` and `headRef` are resolved once, to commit OIDs
  (`reviewedBaseOid`, `reviewedHeadOid`).
- A merge tree is constructed from those two pinned commits
  (`reviewedMergedTreeOid`).
- The diff from the base commit to that constructed merge tree is hashed with
  SHA-256 (`reviewedDiffHash`), and its changed paths are recorded
  (`reviewedChangedPaths`).

Everything downstream is keyed to those pinned values, never to a branch name.
A branch that moves after approval is therefore irrelevant to what gets merged:
the pinned commit is what merges.

## Merge strategy

A **constructed merge commit**, never a fast-forward and never a rebase.

`git commit-tree` builds a commit whose tree is the reviewed merged tree and
whose parents are exactly the reviewed base and reviewed head. The ref is then
advanced with a compare-and-swap. Nothing is rebased, squashed or replayed,
because every one of those operations produces content that was never reviewed.

The commit message records the provenance:

```text
Merge reviewed <headOid> into refs/heads/<base>

Reviewed-base: <baseOid>
Reviewed-head: <headOid>
Reviewed-diff-sha256: <hash>
```

The working tree is never touched. No `checkout`, no `reset`, no `merge` — only
a ref update. An operator's checkout cannot be mutated by a merge.

## What must be true before anything moves

Merge refuses by default. Every one of these is required, and each is checked
before content moves:

| Requirement | Why |
|---|---|
| `--merge` passed explicitly | Merging is never implied. |
| `permissions.autoMerge` enabled in config | Least privilege: the capability is granted by configuration, not by a flag alone. |
| `--ownership FILE` supplied | Every changed path must be attributable. |
| `--actor ID` supplied | Ownership is meaningless without the actor it is evaluated against. |
| Review decision is `PASS` | A blocked or failed review never reaches the merge path. |
| Exact changed paths available | Ownership is enforced against the constructed merge tree's real paths, not a guess. |
| Every changed path owned by the actor | Safety invariant 5. An unowned path rejects unless `allowUnowned` is deliberately set. |
| `baseRef` unchanged since review | Re-resolved immediately before merging; any drift blocks with reason `base-drift`. |
| `baseRef` not checked out anywhere | Checked before building the commit, again immediately before the CAS, and again after. |
| Reviewed diff still reproduces | The diff between the pinned commits is re-hashed at merge time and must equal `reviewedDiffHash`. |

Any failure returns a `blocked` result with a reason. Nothing partial is left
behind.

## Ownership policy

Ownership is merge policy, not project configuration, so it lives in its own
explicitly supplied document rather than in `.trestle/config.json` — which stays
small and closed. The contract is
[`schemas/ownership.schema.json`](../schemas/ownership.schema.json); a worked
example is [`examples/ownership-policy.json`](../examples/ownership-policy.json).

### Where to keep the policy

The policy is the authority that constrains a semi-trusted agent, so **prefer an
absolute path outside the repository** the agent writes to. `--ownership` accepts
one, and it is read with the same pinned, symlink-safe checks as an in-repo path.

An in-repo policy still works and remains the convenient default for a trusted,
single-operator setup. To keep it from becoming self-authorizing, a merge whose
reviewed diff touches the ownership policy or `.trestle/config.json` is refused
with `governance-self-modification`, so a branch can never install the rules that
approve it. That guard covers the committed diff only; it does not protect an
in-repo policy against uncommitted local edits made before `review` runs.

```json
{
  "version": 1,
  "owners": {
    "backend-implementer": ["src/api/**", "src/db/**"],
    "docs-writer": ["docs/**", "*.md"]
  },
  "defaultOwner": null,
  "allowUnowned": false
}
```

Globs support `*`, `?` and `**`, and are repository-relative. An absolute or
parent-escaping pattern is rejected when the document is read. A path matched by
rules naming two different owners is ambiguous and rejects. Paths are POSIX by
default, so a literal backslash stays a filename byte rather than becoming a
separator.

`allowUnowned: true` weakens the invariant — a changed path that no rule covers
would then merge unattributed. It exists for deliberate use, not convenience.

## Races the implementation closes

Each is covered by an adversarial test. The cases involving real repositories
live in
[`test/integration/git-hardening.test.mjs`](../test/integration/git-hardening.test.mjs);
the oversize-diff and failed-rollback cases require fault injection and live in
[`test/unit/review-hardening.test.mjs`](../test/unit/review-hardening.test.mjs)
and [`test/unit/review-gate.test.mjs`](../test/unit/review-gate.test.mjs).

- **Branch moves after approval.** The pinned head commit merges. The moved
  branch tip does not.
- **Base moves after approval.** Detected by re-resolution before merging, and
  again by the compare-and-swap on `update-ref`, which refuses if the ref is no
  longer at `reviewedBaseOid`.
- **Target becomes checked out mid-merge.** Checked before `commit-tree`,
  immediately before the CAS, and again immediately after. If it became checked
  out inside the CAS window, the ref is **rolled back** by a reverse CAS. The
  worktree is never reset — only the ref moves.
- **Rollback itself fails.** Reported as `MERGE_ROLLBACK_FAILED` with the
  offending worktree, rather than being swallowed.
- **Multiple merge bases.** Fails closed rather than guessing which base was
  reviewed.
- **Conflicting merge.** Leaves no `MERGE_HEAD` and no index mutation, because
  the merge is constructed out-of-tree.
- **Oversize diff.** Refuses rather than hashing a truncated diff.

## What is deliberately not supported

- Fast-forward and rebase merges, for the reason above.
- Merging without a passing review. There is no override that merges.
- Merging from `agent-trestle run`. A run produces reviewable branches; merging
  stays a separate, explicit act.
- Any operation that mutates a working tree.

## Audit

A merge attempt writes `review.started` and `review.settled` audit records on
the `review` writer, including the actor, the status, the pinned base and head
OIDs, `reviewedDiffHash`, the reviewed changed paths, and — on `base-drift` —
the `currentBaseOid` that caused the refusal. See
[Audit records](commands.md#audit-records).
