# Engineering provenance audit

**Original audit date:** 2026-08-14

**Current-tree refresh:** 2026-08-20

**Repository:** `agent-trestle`

**Current audited commit:** `a0da9b7` (`main`)

**Original comparison scope:** the `shared/tools` subtree of a private
predecessor project by the same author

## Audit currency

The original audit covered the 2026-08-14 baseline recorded as `c295fff`. This
refresh brings the public repository inventory current to `a0da9b7`, but it does
not have access to the private predecessor project. It therefore verifies the
current public tree, the dependency posture, the public-history delta, and the
known coverage gaps; it cannot independently repeat the private-subtree textual
comparison for files changed after `c295fff`.

| Measure | Original baseline (`c295fff`) | Current `main` (`a0da9b7`) |
|---|---:|---:|
| Tracked files | 89 | 111 |
| Current paths never covered by the original audit inventory | — | 25 |
| Original-audit paths modified since the baseline | — | 45 |
| Files changed since the baseline commit | — | 72 |

Current paths never covered by the original audit inventory:

```text
.editorconfig
.github/CODEOWNERS
.github/ISSUE_TEMPLATE/bug_report.yml
.github/ISSUE_TEMPLATE/config.yml
.github/ISSUE_TEMPLATE/feature_request.yml
.github/dependabot.yml
.github/pull_request_template.md
.github/workflows/ci.yml
.nvmrc
CHANGELOG.md
docs/name-clearance.md
scripts/lint.mjs
src/process/live-child-supervisor.mjs
src/security/path-security.mjs
test/integration/parent-signal-supervision.test.mjs
test/unit/audit-hardening.test.mjs
test/unit/audit-lock-race.test.mjs
test/unit/audit-segments.test.mjs
test/unit/config-loader-containment.test.mjs
test/unit/live-child-supervisor.test.mjs
test/unit/mcp-stdio.test.mjs
test/unit/path-security.test.mjs
test/unit/review-hardening.test.mjs
test/unit/secure-file-handle-races.test.mjs
test/unit/state-store.test.mjs
```

Original-audit paths modified since `c295fff`:

```text
.gitignore
CODE_OF_CONDUCT.md
CONTRIBUTING.md
README.md
SECURITY.md
THIRD_PARTY_NOTICES.md
docs/architecture.md
docs/commands.md
docs/configuration.md
docs/downstream-migration.md
docs/provenance-audit.md
docs/provenance.md
docs/security-model.md
package.json
src/audit/audit.mjs
src/cli/main.mjs
src/config/agent-definition.mjs
src/config/config.mjs
src/config/skills.mjs
src/copilot/process-adapter.mjs
src/dispatch/dispatch.mjs
src/dispatch/router.mjs
src/ownership/policy.mjs
src/review/command.mjs
src/review/gate.mjs
src/review/git-adapter.mjs
src/review/process-adapter.mjs
src/review/protocol.mjs
src/scheduler/scheduler.mjs
src/state/mcp-server.mjs
src/state/store.mjs
src/worktrees/fleet.mjs
src/worktrees/git-adapter.mjs
test/integration/cli-contract.test.mjs
test/integration/git-hardening.test.mjs
test/integration/package-install.test.mjs
test/unit/config-agent-definition.test.mjs
test/unit/config-config.test.mjs
test/unit/config-skills.test.mjs
test/unit/copilot-process-adapter.test.mjs
test/unit/dashboard-rendering.test.mjs
test/unit/ownership-policy.test.mjs
test/unit/review-gate.test.mjs
test/unit/scheduler-core.test.mjs
test/unit/worktree-fleet.test.mjs
```

The public history shows 72 changed paths since `c295fff`: 22 added,
46 modified, 2 deleted, and 2 renamed. These counts supersede the earlier
stale issue snapshot that reported 100 tracked files, 11 uncovered files, and 33
modified audited files.

## Conclusion and release recommendation

The 2026-08-14 predecessor-subtree comparison found no copied implementation,
distinctive comment, or substantial copied documentation text in the reviewed
baseline. That conclusion remains evidence for `c295fff` only.

For current `main` at `a0da9b7`, this refresh found no vendored third-party code,
no dependency-tree expansion, and no public-history evidence that new files were
imported from an external package. The new and modified files are cohesive with
Agent Trestle's existing module structure, error contracts, and security model.
However, because this environment cannot read the private predecessor project, it
cannot assert that the 25 current paths never covered by the original inventory
or the 45 modified original-audit paths have no substantive overlap with that
private codebase.

**Engineering recommendation for current `main`: HOLD for a provenance-gated
release unless the maintainer with access to the private predecessor project
confirms the changed and newly covered paths.** After that maintainer check, the
current public tree has enough repository-local evidence to serve as the next
provenance baseline.

This is not formal legal clearance. The audit cannot prove a negative, establish
employment or contractual ownership, clear patents or trademarks, or replace
advice from qualified counsel. Public release should not be described as
"legally cleared" solely because this engineering audit passed.

## Repository and authorship state

- The original audited baseline was recorded as `c295fff`. The public repository
  now has a short published history: `83c691a` is tagged `v0.1.0`, and
  `a0da9b7` is the current `main` commit reviewed by this refresh.
- The original baseline was the first auditable boundary available to the audit.
  Public commits after that point provide durable chronology for subsequent
  repository changes, but they do not replace comparison against the private
  predecessor for copied-text risk.
- Local filesystem ownership and repository Git identity both identify Torsten
  Mahr, matching the copyright statement in `LICENSE`. Filesystem metadata is
  supporting engineering evidence only; it is not proof of legal ownership.
- The predecessor project history for the conceptually comparable runtime files
  was reported by the original audit to identify Torsten Mahr as author. That
  common authorship explains domain knowledge but is not, by itself, a relicensing
  grant.

## Methodology

1. Inspected Git status, branch, available public history, current commit, tag
   state, tracked-file inventory, and file delta since `c295fff`.
2. Inventoried every tracked file at current `main` and compared that inventory
   with the original audited file list.
3. Reviewed source, tests, schemas, examples, templates, documentation, license,
   notices, package metadata, workflow metadata, and repository scaffolding for
   third-party source, copied attribution, generated artifacts, or dependency
   additions.
4. Reviewed the security-relevant new and rewritten areas named in the stale
   issue: `src/security/path-security.mjs`,
   `src/process/live-child-supervisor.mjs`, audit hardening tests, review
   hardening tests, state-store tests, and secure-file-handle race tests.
5. Rechecked package metadata and import patterns for non-Node dependencies.
6. Did **not** repeat the private predecessor textual comparison, because this
   environment has no access to the predecessor repository. A maintainer with
   access must run the normalized-line, token-sequence, shingle, and manual
   closest-pair checks over the 25 never-covered current paths and the 45 modified
   original-audit paths before using this document as a release gate.

These methods detect repository-local provenance and dependency risks; they do
not determine whether an abstract idea, public interface, or behavior is legally
protectable.

## Comparison findings

### Original automated overlap

The 2026-08-14 normalized long-line scan reported 25 matches. They were limited
to:

- standard imports such as `node:assert/strict`, `node:url`, and `node:crypto`;
- the routine promise-constructor phrase `new Promise((resolve, reject) => {`;
- the standard responsive HTML viewport metadata;
- generic JavaScript and test-runner syntax.

No exact substantive implementation block was found in the original baseline.
Focused matching-block analysis found only:

- a 62-character Node crypto import shared by review code; and
- a 69-character standard HTML viewport fragment shared by dashboard output.

Eight-token shingle containment was low across the closest conceptual pairs. The
highest non-HTML result was worktree-name normalization at 13.4%, explained by
conventional slug construction (`toLowerCase`, non-alphanumeric replacement,
trimming, and Git-safe naming). No exact block of 60 characters existed in that
pair.

### Current-tree refresh

The refresh did not find vendored source, generated dependency output, copied
license blocks, or third-party package metadata in the current tree. The files
added after the original inventory are either repository-governance files,
release documentation, hardening code, or tests for those hardening paths.

The most security-relevant current additions and rewrites are internally
consistent with the documented threat model:

- `src/security/path-security.mjs` implements descendant checks, directory pins,
  no-symlink file opening, and securely held directory validation. The code uses
  Node built-ins and local error types rather than imported helper code.
- `src/audit/audit.mjs` now publishes audit locks through private pending files
  and hard links, then revalidates path identity before using or removing lock
  files.
- `src/state/store.mjs` keeps state rooted in explicit configured directories,
  rejects unsafe keys, and requires token or immutable-identity authorization for
  destructive lock recovery.
- `src/review/gate.mjs` and `src/review/git-adapter.mjs` bind approval to a
  nonce-checked exact diff, verified object IDs, exact changed paths, explicit
  `permissions.autoMerge`, and ownership policy enforcement before merge.
- `src/process/live-child-supervisor.mjs` and the new parent-signal tests cover
  process-settlement behavior, not third-party protocol or vendored code.

These observations reduce repository-local concern but are not a substitute for
private predecessor comparison.

### Manual conceptual comparison from the original audit

| Agent Trestle area | Predecessor comparison | Finding |
| --- | --- | --- |
| `src/scheduler/` | `loop-runner.mjs` | Different task-graph and round APIs; no substantive text match in the original baseline. |
| `src/worktrees/` | `worktree-fleet.mjs` | Same Git concepts, independently structured adapters and safety checks; no substantive text match in the original baseline. |
| `src/review/` | `review-gate.mjs` | Same exact-diff security goal, different protocol, return contracts, and control flow; only a standard import matched in the original baseline. |
| `src/ownership/` | `ownership-guard.mjs` | Different policy representation and glob implementation; no substantive text match in the original baseline. |
| `src/state/` | `state-mcp-server.mjs` | Same public JSON-RPC/MCP concepts, different tool names, storage API, errors, and server organization; no substantive text match in the original baseline. |
| `src/config/`, `src/dispatch/` | `dispatch-slice.mjs` | Same agent-routing problem, different configuration schema and module design; no substantive text match in the original baseline. |
| `src/dashboard/` | `crew-dashboard.mjs` | New normalized model and renderer; overlap limited to ordinary HTML/CSS vocabulary and viewport metadata in the original baseline. |

### Comments and documentation

Source files in the reviewed public tree contain ordinary explanatory comments
about local invariants, Node platform limitations, and fail-closed behavior. This
refresh found no copied attribution, migration marker, predecessor-project name,
or distinctive third-party prose in the current tracked files. Documentation uses
"clean-room-style" framing and states that the audit is engineering evidence,
not formal legal clearance.

## Third-party dependency and notice status

- `package.json` declares no `dependencies`, `devDependencies`, optional
  dependencies, or bundled dependencies.
- No npm lockfile or shrinkwrap file exists.
- Source, tests, scripts, and workflows use Node.js built-ins, Git, GitHub
  Actions, CodeQL action references, and the GitHub Copilot CLI executable; no
  third-party source code is vendored into this repository.
- Git and GitHub Copilot CLI are external executables used by applicable
  workflows; their implementations are not vendored or redistributed here.
- MCP/JSON-RPC behavior is implemented locally from public protocol concepts; no
  MCP SDK package is included.
- `THIRD_PARTY_NOTICES.md` records that no third-party source code is
  incorporated. If dependencies, generated assets, copied examples, or vendored
  code are added later, the manifest, lockfile, license review, and notices must
  be updated before release.

## License status

- Agent Trestle declares MIT in `package.json` and includes the standard MIT
  license naming Torsten Mahr as the 2026 copyright holder.
- The predecessor project `shared/tools/package.json` declared ISC according to
  the original audit, but no root `LICENSE`, `NOTICE`, or
  `THIRD_PARTY_NOTICES.md` was observed in the inspected comparison locations.
  Because the original audit found no copied implementation in the baseline, the
  comparison repository's license was not relied on as the license basis for
  Agent Trestle.
- The MIT declaration is internally consistent, but only the rights holder or
  counsel reviewing applicable contracts can confirm authority to grant it.

## Remaining legal and process limitations

1. The original baseline had limited public history, so `c295fff` is the first
   auditable provenance boundary rather than a complete traceable development
   history.
2. This refresh was repository-local and could not inspect the private
   predecessor project. Private-subtree comparison remains required for the 25
   current paths never covered by the original inventory and the 45 original
   paths modified since `c295fff`.
3. This was a targeted comparison, not a search across every private, public,
   generated, or previously deleted source the author may have seen.
4. Textual and structural comparison cannot establish independent creation in the
   formal clean-room sense; no separate specification team and isolated
   implementation team were documented.
5. Copyright ownership may be affected by employment, consulting, assignment, or
   contributor agreements not available to this engineering audit.
6. Patent, trademark, export-control, privacy, and product-name clearance were
   outside scope.
7. Future contributions require their own provenance and dependency review before
   they are used as release evidence.

## Audited file inventory

This is the current `main` inventory at `a0da9b7`: 111 tracked files
comprising 11 root files, 7 GitHub configuration files,
8 documentation files, 3 examples,
1 schema, 1 script, 49 source files,
2 templates, and 29 tests. The uncommitted
`.github/workflows/codeql.yml` file created after this inventory must be included
in the next release audit once it is committed.

```text
.editorconfig
.github/CODEOWNERS
.github/ISSUE_TEMPLATE/bug_report.yml
.github/ISSUE_TEMPLATE/config.yml
.github/ISSUE_TEMPLATE/feature_request.yml
.github/dependabot.yml
.github/pull_request_template.md
.github/workflows/ci.yml
.gitignore
.nvmrc
CHANGELOG.md
CODE_OF_CONDUCT.md
CONTRIBUTING.md
LICENSE
README.md
SECURITY.md
THIRD_PARTY_NOTICES.md
docs/architecture.md
docs/commands.md
docs/configuration.md
docs/downstream-migration.md
docs/name-clearance.md
docs/provenance-audit.md
docs/provenance.md
docs/security-model.md
examples/minimal/.github/agents/example-builder.agent.md
examples/minimal/.trestle/config.json
examples/state-schemas.json
package.json
schemas/config.schema.json
scripts/lint.mjs
src/audit/audit-log.mjs
src/audit/audit.mjs
src/audit/index.mjs
src/cli/agent-trestle.mjs
src/cli/main.mjs
src/config/agent-definition.mjs
src/config/config.mjs
src/config/index.mjs
src/config/load-config.mjs
src/config/permissions.mjs
src/config/skill-selection.mjs
src/config/skills.mjs
src/copilot/adapter.mjs
src/copilot/index.mjs
src/copilot/process-adapter.mjs
src/dashboard/index.mjs
src/dashboard/model.mjs
src/dashboard/provider.mjs
src/dashboard/render.mjs
src/dashboard/server.mjs
src/dispatch/dispatch.mjs
src/dispatch/index.mjs
src/dispatch/resolve-route.mjs
src/dispatch/router.mjs
src/index.mjs
src/ownership/index.mjs
src/ownership/policy.mjs
src/process/live-child-supervisor.mjs
src/review/command.mjs
src/review/gate.mjs
src/review/git-adapter.mjs
src/review/index.mjs
src/review/process-adapter.mjs
src/review/protocol.mjs
src/scheduler/dag.mjs
src/scheduler/index.mjs
src/scheduler/scheduler.mjs
src/scheduler/stop-decisions.mjs
src/scheduler/work-signature.mjs
src/security/path-security.mjs
src/state/index.mjs
src/state/mcp-server.mjs
src/state/mcp-stdio.mjs
src/state/state-store.mjs
src/state/store.mjs
src/worktrees/fleet.mjs
src/worktrees/git-adapter.mjs
src/worktrees/index.mjs
src/worktrees/names.mjs
templates/minimal/.github/agents/example-builder.agent.md
templates/minimal/.trestle/config.json
test/integration/cli-contract.test.mjs
test/integration/dispatch-execution.test.mjs
test/integration/git-hardening.test.mjs
test/integration/package-install.test.mjs
test/integration/parent-signal-supervision.test.mjs
test/unit/audit-hardening.test.mjs
test/unit/audit-lock-race.test.mjs
test/unit/audit-segments.test.mjs
test/unit/config-agent-definition.test.mjs
test/unit/config-agent-fixture.agent.md
test/unit/config-config.test.mjs
test/unit/config-loader-containment.test.mjs
test/unit/config-skill-fixtures.mjs
test/unit/config-skills.test.mjs
test/unit/copilot-process-adapter.test.mjs
test/unit/dashboard-rendering.test.mjs
test/unit/dashboard-security.test.mjs
test/unit/dispatch-routing.test.mjs
test/unit/live-child-supervisor.test.mjs
test/unit/mcp-stdio.test.mjs
test/unit/ownership-policy.test.mjs
test/unit/path-security.test.mjs
test/unit/permission-defaults.test.mjs
test/unit/review-gate.test.mjs
test/unit/review-hardening.test.mjs
test/unit/scheduler-core.test.mjs
test/unit/secure-file-handle-races.test.mjs
test/unit/state-store.test.mjs
test/unit/worktree-fleet.test.mjs
```
