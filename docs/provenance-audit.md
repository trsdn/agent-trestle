# Engineering provenance audit

**Audit date:** 2026-08-14

**Repository:** `agent-trestle`

**Comparison scope:** the `shared/tools` subtree of a private predecessor
project by the same author

## Audit currency

> **This audit is out of date and its RELEASE recommendation below applies only
> to the 2026-08-14 baseline, not to current `main`.**

The audited baseline was the uncommitted working tree of 2026-08-14, later
committed as `eb853c5`. Since that commit the tree has changed substantially:

| Measure | Baseline (2026-08-14) | Current `main` |
|---|---:|---:|
| Tracked files | 89 (untracked) | 100 |
| Files never covered by this audit | — | 11 |
| Audited files modified since the baseline | — | 33 |

Files added after the baseline and therefore **not covered** by any finding in
this document:

```text
docs/name-clearance.md
src/process/live-child-supervisor.mjs
src/security/path-security.mjs
test/integration/parent-signal-supervision.test.mjs
test/unit/audit-hardening.test.mjs
test/unit/audit-lock-race.test.mjs
test/unit/config-loader-containment.test.mjs
test/unit/live-child-supervisor.test.mjs
test/unit/path-security.test.mjs
test/unit/review-hardening.test.mjs
test/unit/secure-file-handle-races.test.mjs
```

Reproduce the current delta with:

```bash
git diff --name-only eb853c5 HEAD
```

Re-run the audit over the full tree before any public release; until then the
provenance gate referenced by `README.md` and `docs/provenance.md` is satisfied
only for the baseline.

## Conclusion and release recommendation

No copied implementation, distinctive comment, or substantial copied
documentation text was found in the reviewed Agent Trestle files. The limited
overlap detected consists of ordinary Node.js imports, common HTML metadata,
standard Git command vocabulary, JSON-RPC/MCP protocol terms, and routine test
syntax. The implementations are materially different in structure, naming,
module boundaries, error handling, and data contracts.

**Engineering recommendation: RELEASE.** The repository has sufficient
engineering evidence to establish an initial provenance baseline and may be
released under its declared MIT license if the named copyright holder confirms
that they own or are authorized to license the contribution.

This is not formal legal clearance. The audit cannot prove a negative, establish
employment or contractual ownership, clear patents or trademarks, or replace
advice from qualified counsel. Public release should not be described as
"legally cleared" solely because this engineering audit passed.

## Repository and authorship state

- The repository was on `main` and had **no commits** at audit time. All files
  were untracked, so Git provided no durable creation chronology, review trail,
  signed authorship record, or per-file attribution history. That baseline has
  since been committed as `eb853c5`, which establishes the provenance boundary
  for subsequent changes.
- Local filesystem ownership and repository Git identity both identify Torsten
  Mahr, matching the copyright statement in `LICENSE`. Filesystem metadata is
  supporting engineering evidence only; it is not proof of legal ownership.
- The predecessor project history for the conceptually comparable runtime files
  also identifies Torsten Mahr as author. That common authorship explains
  domain knowledge but is not, by itself, a relicensing grant.
- The initial Agent Trestle commit `eb853c5` includes this audit, so later
  changes have a durable provenance boundary.

## Methodology

1. Inspected Git status, branch, complete available history, configured author,
   and filesystem ownership metadata.
2. Inventoried every non-`.git` file in Agent Trestle and reviewed source,
   tests, schemas, examples, templates, documentation, license, notices, and
   package metadata.
3. Reviewed all source imports and package metadata for third-party code or
   undeclared dependencies.
4. Compared Agent Trestle only against the predecessor project `shared/tools`
   subtree to
   detect suspicious copying. The comparison excluded generated logs,
   `node_modules`, and test output.
5. Ran:
   - exact normalized-line matching for lines of at least 40 characters;
   - token-sequence matching;
   - eight-token shingle containment ranking;
   - exact matching-block review for the conceptually closest implementation
     pairs.
6. Manually reviewed the highest-scoring pairs: scheduler/loop runner,
   worktree fleet and naming, review gate, ownership policy, state MCP server,
   dispatch/skill selection, and dashboard rendering/server code.
7. Searched comments and prose for copied attribution, migration, Squad CLI,
   licensing, and provenance language.

These methods detect exact and near-exact textual reuse; they do not determine
whether an abstract idea, public interface, or behavior is legally protectable.

## Comparison findings

### Automated overlap

The normalized long-line scan reported 25 matches. They were limited to:

- standard imports such as `node:assert/strict`, `node:url`, and `node:crypto`;
- the routine promise-constructor phrase `new Promise((resolve, reject) => {`;
- the standard responsive HTML viewport metadata;
- generic JavaScript and test-runner syntax.

No exact substantive implementation block was found. Focused matching-block
analysis found only:

- a 62-character Node crypto import shared by review code; and
- a 69-character standard HTML viewport fragment shared by dashboard output.

Eight-token shingle containment was low across the closest conceptual pairs.
The highest non-HTML result was worktree-name normalization at 13.4%, explained
by conventional slug construction (`toLowerCase`, non-alphanumeric replacement,
trimming, and Git-safe naming). No exact block of 60 characters existed in that
pair.

### Manual conceptual comparison

| Agent Trestle area | Predecessor comparison | Finding |
| --- | --- | --- |
| `src/scheduler/` | `loop-runner.mjs` | Different task-graph and round APIs; no substantive text match. |
| `src/worktrees/` | `worktree-fleet.mjs` | Same Git concepts, independently structured adapters and safety checks; no substantive text match. |
| `src/review/` | `review-gate.mjs` | Same exact-diff security goal, different protocol, return contracts, and control flow; only a standard import matched. |
| `src/ownership/` | `ownership-guard.mjs` | Different policy representation and glob implementation; no substantive text match. |
| `src/state/` | `state-mcp-server.mjs` | Same public JSON-RPC/MCP concepts, different tool names, storage API, errors, and server organization; no substantive text match. |
| `src/config/`, `src/dispatch/` | `dispatch-slice.mjs` | Same agent-routing problem, different configuration schema and module design; no substantive text match. |
| `src/dashboard/` | `crew-dashboard.mjs` | New normalized model and renderer; overlap limited to ordinary HTML/CSS vocabulary and viewport metadata. |

### Comments and documentation

Source files contain no explanatory comments copied from the comparison
repository; only a shebang, JavaScript private-field syntax, and CSS universal
selector were returned by the source-comment pattern scan. Documentation refers to
the predecessor project only to define migration and provenance boundaries. No
accidental copied comment or distinctive prose required removal.

## Third-party dependency and notice status

- `package.json` declares no `dependencies`, `devDependencies`, optional
  dependencies, or bundled dependencies.
- `npm ls --all --json` reported only the root `agent-trestle` package.
- No npm lockfile or shrinkwrap file exists.
- Source and tests import only Node.js built-in modules and local relative
  modules.
- Git and GitHub Copilot CLI are external executables used by applicable
  workflows; their implementations are not vendored or redistributed here.
- MCP/JSON-RPC behavior is implemented locally from public protocol concepts;
  no MCP SDK package is included.
- `THIRD_PARTY_NOTICES.md` accurately records that no third-party source code is
  incorporated. If dependencies, generated assets, copied examples, or vendored
  code are added later, the manifest, lockfile, license review, and notices must
  be updated before release.

## License status

- Agent Trestle declares MIT in `package.json` and includes the standard MIT
  license naming Torsten Mahr as the 2026 copyright holder.
- The predecessor project `shared/tools/package.json` declares ISC, but no root
  `LICENSE`, `NOTICE`, or `THIRD_PARTY_NOTICES.md` was observed in the inspected
  comparison locations. Because this audit found no copied implementation, the
  comparison repository's license is not relied on as the license basis for
  Agent Trestle.
- The MIT declaration is internally consistent, but only the rights holder (or
  counsel reviewing applicable contracts) can confirm authority to grant it.

## Remaining legal and process limitations

1. The audited baseline had no Git history, so that working tree was the first
   auditable baseline rather than a traceable development history. Commits made
   after `eb853c5` are outside this audit; see [Audit currency](#audit-currency).
2. This was a targeted local comparison, not a search across every private,
   public, generated, or previously deleted source the author may have seen.
3. Textual and structural comparison cannot establish independent creation in
   the formal clean-room sense; no separate specification team and isolated
   implementation team were documented.
4. Copyright ownership may be affected by employment, consulting, assignment,
   or contributor agreements not available to this engineering audit.
5. Patent, trademark, export-control, privacy, and product-name clearance were
   outside scope.
6. Future contributions require their own provenance and dependency review.

## Audited file inventory

This is the **baseline** inventory of 2026-08-14: 89 files comprising 8 root
files, 7 documentation files, 3 examples, 1 schema, 47 source files, 2
templates, and 21 tests. It is not the current file list; see
[Audit currency](#audit-currency).

```text
.gitignore
CODE_OF_CONDUCT.md
CONTRIBUTING.md
LICENSE
README.md
SECURITY.md
THIRD_PARTY_NOTICES.md
package.json
docs/architecture.md
docs/commands.md
docs/configuration.md
docs/downstream-migration.md
docs/provenance.md
docs/provenance-audit.md
docs/security-model.md
examples/minimal/.github/agents/example-builder.agent.md
examples/minimal/.trestle/config.json
examples/state-schemas.json
schemas/config.schema.json
src/audit/audit-log.mjs
src/audit/audit.mjs
src/audit/index.mjs
src/cli/main.mjs
src/cli/agent-trestle.mjs
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
test/audit-segments.test.mjs
test/integration/cli-contract.test.mjs
test/integration/dispatch-execution.test.mjs
test/integration/git-hardening.test.mjs
test/integration/package-install.test.mjs
test/mcp-stdio.test.mjs
test/state-store.test.mjs
test/unit/config-agent-definition.test.mjs
test/unit/config-agent-fixture.agent.md
test/unit/config-config.test.mjs
test/unit/config-skill-fixtures.mjs
test/unit/config-skills.test.mjs
test/unit/copilot-process-adapter.test.mjs
test/unit/dashboard-rendering.test.mjs
test/unit/dashboard-security.test.mjs
test/unit/dispatch-routing.test.mjs
test/unit/ownership-policy.test.mjs
test/unit/permission-defaults.test.mjs
test/unit/review-gate.test.mjs
test/unit/scheduler-core.test.mjs
test/unit/worktree-fleet.test.mjs
```
