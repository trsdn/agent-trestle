# Architecture

Agent Trestle separates project-owned configuration from reusable runtime code.

```text
.trestle project configuration
  -> deterministic workstream/role routing
  -> GitHub Copilot CLI process adapter
  -> bounded scheduler or isolated worktree fleet
  -> exact-diff review and ownership enforcement
  -> state and per-run audit segments
  -> read-only local dashboard
```

## Runtime boundaries

- **Configuration** declares project identity, workstreams, roles, agents,
  permissions, and the Copilot executable and timeout. Ownership, review, and
  stop policies are deliberately *not* v1 config keys: they are supplied
  programmatically to the ownership, review, and scheduler APIs, so the config
  schema stays closed (`additionalProperties: false`) and small.
- **Dispatch** resolves exactly one agent and launches one Copilot process.
- **Scheduling** orders tasks and applies explicit stop conditions.
- **Review** is independent of production and binds approval to exact content.
- **State** is scoped to one configured workstream; it is never selected by
  walking upward from an arbitrary process directory.
- **Audit** uses independent writer segments so parallel processes do not race
  on a single global hash chain.
- **Dashboard** consumes normalized runtime records and has no authority to
  mutate or merge work.

## Safety invariants

1. Unknown configuration fails explicitly.
2. Process failure cannot be represented as task success.
3. Broad permissions are opt-in.
4. Reviewed content must be the content merged.
5. Ownership violations cannot merge.
6. Parallel writers cannot corrupt audit integrity.
7. A workstream cannot read or mutate another workstream's state.
