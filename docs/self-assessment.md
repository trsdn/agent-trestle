# Self-assessment against the Repository Quality Standard

This is the per-criterion evidence behind
[`.github/conformance.yml`](../.github/conformance.yml), which is the machine-
readable record required by `B11`. The badge in the README is generated from
that record and cannot disagree with it.

| | |
| --- | --- |
| Standard | [trsdn Repository Quality Standard v1.7.0](https://github.com/trsdn/.github/blob/v1.7.0/docs/repository-quality-standard.md) |
| Assessed on | 2026-09-01 |
| State | Healthy |
| Method | Self-assessment by inspection of the repository, its GitHub settings, and a local run of `npm run check` |

Results use the standard's vocabulary: `pass`, `partial`, `fail`, `na`,
`unknown`. Every criterion in the catalog appears, including the ones that do
not apply, so "does not apply" stays distinguishable from "was never looked
at".

## Profiles

Applicable: Baseline, Public, Software, Package and Release, Product Identity,
Agent Readiness, Language and Localization, Accessibility, Data Protection and
Privacy.

Not applicable:

- **Deployable** — Agent Trestle is a locally installed CLI and library. It is
  not deployed to a workstation fleet, server, container, or cloud environment;
  the only "deployment" is `npm install -g`, which the Package profile already
  covers.
- **Documentation** — the primary product is executable code. `docs/` supports
  it rather than being the product.
- **Published Site** — nothing is published as a website. The dashboard is a
  local, read-only server bound to `127.0.0.1`, and its audience is the
  operator of the repository, who necessarily has the repository.
- **Archived** — the repository is active.

## Baseline

| ID | Result | Evidence |
| --- | --- | --- |
| B01 | pass | GitHub name and description state the purpose: "Local-first orchestration for GitHub Copilot CLI agents: deterministic routing, isolated Git worktrees, review gates, and audit records." |
| B02 | pass | [README](../README.md) covers purpose, audience, pre-release status, install, quickstart, and links to every companion document. |
| B03 | pass | [`LICENSE`](../LICENSE) is MIT, and `package.json` declares `"license": "MIT"`. |
| B04 | pass | [`.gitignore`](../.gitignore) ignores `test/.work/` and `test/.artifacts/`; no secret or generated artifact is tracked, and secret scanning with push protection is enabled. |
| B05 | pass | `npm run check` (lint, full suite, `npm pack --dry-run`) is documented in the README, `CONTRIBUTING.md`, and `AGENTS.md`, and runs from a clean checkout with no install step. |
| B06 | pass | `main` is protected: force pushes and deletions blocked, branch must be current, six required checks (`Lint`, `Package`, `Coverage`, and four `Test` matrix legs). Zero open Dependabot alerts at assessment time. |
| B07 | pass | `engines.node` is `>=20`, `.nvmrc` pins 22, and the README states the Git and Copilot CLI requirements plus the Linux/macOS constraint. There are no npm dependencies to declare. |
| B08 | pass | [`CHANGELOG.md`](../CHANGELOG.md) follows Keep a Changelog, and tagged releases carry the matching section as their notes. |
| B09 | pass | Public, unarchived, eight descriptive topics plus `trsdn-standard`, homepage set to the README. |
| B10 | pass | [`.github/CODEOWNERS`](../.github/CODEOWNERS) plus `CONTRIBUTING.md`; the README states the pre-release maintenance status. |
| B11 | pass | This document and [`.github/conformance.yml`](../.github/conformance.yml), validated in CI by [`.github/workflows/conformance.yml`](../.github/workflows/conformance.yml). |
| B12 | pass | The `trsdn-standard` topic is set on the repository. |
| B13 | pass | Each fact has one home and the others link to it: the security model lives in `docs/security-model.md`, the command surface in `docs/commands.md`, the contribution bar in `CONTRIBUTING.md`, and `AGENTS.md` explicitly links rather than restates. |

## Public Repositories

| ID | Result | Evidence |
| --- | --- | --- |
| P01 | pass | Root `LICENSE`, MIT, recognised by GitHub. |
| P02 | pass | [`CONTRIBUTING.md`](../CONTRIBUTING.md) and [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md). |
| P03 | pass | [`SECURITY.md`](../SECURITY.md) documents the reporting path, and private vulnerability reporting is enabled on the repository. |
| P04 | pass | Issue forms for bug reports and feature requests, an intake `config.yml`, and a pull-request template under `.github/`. |
| P05 | pass | README covers install (global, from clone, from a release tarball), configuration via `.trestle/config.json`, a worked quickstart, compatibility (Node, OS), security posture, and support status. |
| P06 | pass | `LICENSE`, `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue templates and a pull-request template are all in GitHub-recognised locations. |
| P07 | pass | Description, eight topics, and a homepage pointing at the README. |
| P08 | pass | Badge block is license, runtime, CI, release, conformance, in that order. Each links to what it reports. License and release are derived live from the repository; the runtime badge reads `engines.node` from `package.json` itself; CI is GitHub's own first-party image; conformance is a committed SVG regenerated from the record by a repository event, which the standard permits. No badge restates a hand-maintained value. |
| P09 | partial | [`.github/workflows/stats.yml`](../.github/workflows/stats.yml) adopts the shared reusable workflow, renders light and dark SVGs, commits them to the `stats` branch, and the README embeds them through a `<picture>` element with no third-party image service. Recorded as `partial` rather than `pass` because at the time of assessment the workflow has not yet completed its first run on the default branch, so the card it references does not exist yet. This resolves to `pass` on the first scheduled run after merge. |

## Software Repositories

| ID | Result | Evidence |
| --- | --- | --- |
| S01 | pass | Zero runtime and development dependencies, so a clean checkout is immediately runnable; the runtime is pinned by `.nvmrc` and constrained by `engines`. There is no build step, and `AGENTS.md` states explicitly that `npm ci` failing is correct rather than a broken checkout. |
| S02 | pass | 244 tests over `test/unit/` and `test/integration/`, covering failure paths deliberately: fail-closed containment, lock races, redaction of prompts through error cause chains, review rejection, and process-failure propagation. `npm run test:coverage` enforces 88% lines, 78% branches, 86% functions. |
| S03 | pass | `npm run lint` (`scripts/lint.mjs`: `node --check`, JSON parse, whitespace and line-ending checks) runs as the `Lint` job in CI and is a required check. Formatting is fixed by `.editorconfig`; the absence of ESLint and Prettier is a recorded consequence of the zero-dependency rule. |
| S04 | pass | The CI matrix covers Node 20 and 22 on `ubuntu-latest` and `macos-latest`. Windows is excluded deliberately and documented: the worktree fleet requires POSIX ownership semantics and fails closed there, so it is not a materially supported platform. |
| S05 | pass | GitHub secret scanning and push protection are both enabled. |
| S06 | pass | Configuration is explicit and project-scoped (`.trestle/config.json`); the schema is closed (`additionalProperties: false`) so unknown keys fail rather than being ignored. Defaults are least-privilege: unrestricted tools, paths, and URLs are off, non-interactive execution requires an explicit policy, and the dashboard binds `127.0.0.1` only. |
| S07 | pass | Prompt and secret redaction recurses the full `cause` chain of an error unconditionally and redacts non-object causes, so a leak nested several causes deep is still caught. The reviewer prompt is identified by argv position rather than by scanning for a flag. Errors carry stable machine-readable codes. See [the security model](security-model.md) and `test/unit/review-hardening.test.mjs`. |
| S08 | pass | [`.github/dependabot.yml`](../.github/dependabot.yml) covers GitHub Actions, Dependabot security updates are enabled, and `CODEOWNERS` gives the alerts an owner. There is no npm dependency surface to triage. |
| S09 | pass | Branch protection on `main` requires the six checks that exist, requires the branch to be current, and blocks force pushes and deletion. |
| S10 | pass | [`docs/architecture.md`](architecture.md) states the runtime boundaries; [`docs/security-model.md`](security-model.md) states the invariants that explain why the code is shaped as it is. Non-obvious constraints — no hash chain but per-writer segments, fail-closed containment, no CLI merge path — are each written down with their reason. |

## Deployable Repositories

`D01` through `D06` are recorded `na`. Agent Trestle is installed, not
deployed: it has no deployment target, no infrastructure, no runtime secrets,
and no server-side state. State it creates is local files under the user's own
project root, which the Data Protection section covers.

## Package And Release Repositories

| ID | Result | Evidence |
| --- | --- | --- |
| R01 | pass | `package.json` carries name, description, license, author, `homepage`, `repository`, `bugs`, keywords, `engines`, `bin`, `exports`, and an explicit `files` allow-list; the description and keywords agree with the GitHub description and topics. `test/unit/release-metadata.test.mjs` asserts the manifest stays coherent. |
| R02 | pass | `CHANGELOG.md` states adherence to Semantic Versioning and records the pre-1.0 exception explicitly: below `1.0.0` the public API and command surface may change without a major bump. The README repeats the status and points at the release badge rather than a hand-copied version string. |
| R03 | pass | [`.github/workflows/release.yml`](../.github/workflows/release.yml) is triggered by a `v*` tag and produces the GitHub release with the tarball attached, plus an npm publish gated on the `NPM_PUBLISH` repository variable. |
| R04 | pass | `scripts/release.mjs verify --tag vX.Y.Z` asserts that the tag, the `package.json` version, and the `CHANGELOG.md` section agree, and runs as the first release job. |
| R05 | pass | The release `verify` job installs the packed tarball into a clean consumer and asserts the installed CLI reports the tagged version. `test/integration/package-install.test.mjs` covers the same property in CI. |
| R06 | pass | Release notes are the changelog section for the version, which describes behavioural changes and upgrade concerns. |
| R07 | pass | `scripts/release.mjs notes --tag vX.Y.Z` emits that section and the release job fails when it is missing, empty, or still held under `Unreleased`. |

## Product Identity

| ID | Result | Evidence |
| --- | --- | --- |
| I01 | pass | The packed artifact embeds `name` and the exact `version` in its manifest, and the release smoke test asserts the installed CLI reports the tagged version. |
| I02 | pass | `repository.url` and `bugs.url` are in the manifest and are printed by `agent-trestle --help`. |
| I03 | pass | `license` and `author` are in the manifest, and `LICENSE` is in the published `files` allow-list, so the licence text ships with the artifact. |
| I04 | pass | `agent-trestle --version` prints the version; `agent-trestle --help` ends with `agent-trestle <version> (MIT)`, the project URL, and the issue tracker URL. |
| I05 | na | The product is a terminal CLI and a library. It has no installer, store listing, or site surface on which an icon would appear, so there is nothing for an icon to be consistent across. |
| I06 | partial | Identity values are read from the manifest rather than hand-copied into source, and the release workflow refuses to release when the tag, manifest, and changelog disagree — so the values cannot drift silently. They are still *bumped* by hand in `package.json` rather than derived from the tag by the build, which is the shape the criterion asks for. Recorded honestly as `partial`. |

## Documentation Repositories

`T01` through `T05` are recorded `na`. The product is executable code;
documentation under `docs/` supports it and is held to `S10` and `B13` instead.

## Published Sites

`W01` through `W08` are recorded `na`. Nothing is published as a site. The
dashboard is served locally, binds `127.0.0.1` with no `--host` flag, is
read-only, and loads no remote assets — its audience is the operator of the
repository, so the "usable without the repository" trigger does not apply.

## Agent Readiness

| ID | Result | Evidence |
| --- | --- | --- |
| G01 | pass | [`AGENTS.md`](../AGENTS.md) in the repository root, tool-neutral. |
| G02 | pass | It states purpose, the `src/` layout and module boundaries, and the authoritative commands, each with the result of an actual run on the pinned runtime, including the known parallel-load flakiness and how to distinguish it from a real failure. |
| G03 | pass | "Forbidden and high-risk operations" names history rewriting, force pushes, branch/tag/worktree deletion, destructive filesystem commands, releasing and publishing, deployment, repository settings, secret handling, and weakening a safety property or test. |
| G04 | pass | [`.github/github-app.yml`](../.github/github-app.yml) instructs the agent to read `AGENTS.md` and deliberately does not restate it. No other tool-specific instruction file exists. |
| G05 | pass | `npm run check` succeeds from a clean checkout with no install step and covers lint, the full suite, and packaging. |
| G06 | pass | "Generated and machine-owned paths" in `AGENTS.md` names the conformance badge, the stats card, and the test scratch directories, and records that nothing is vendored because there are no dependencies. `.gitignore` covers the scratch paths. |
| G07 | pass | "Attribution and review of agent-authored changes" in `AGENTS.md` requires a `Co-authored-by:` trailer, disclosure in the pull-request body with what was verified, and human review; an agent may not approve or merge, including its own change. |
| G08 | pass | [`.github/github-app.yml`](../.github/github-app.yml) is an intentional configuration: no setup script because there are no dependencies, `npm run check` as the validation script, and `remote_control: false` because sessions orchestrate agents against local worktrees. |

## Language And Localization

| ID | Result | Evidence |
| --- | --- | --- |
| L01 | pass | The README "Language" section declares English as the primary user-facing language. No exception is claimed. |
| L02 | pass | All CLI output, error codes, dashboard strings, and templates are English; source review found no user-facing string in another language. |
| L03 | pass | The same section declares the project English-only, with no locale list and no localization machinery. |
| L04 | na | No string catalogs exist, so there are no missing or orphaned keys to detect. |
| L05 | na | The product formats no dates, numbers, or currency for presentation. Timestamps are emitted as ISO 8601 because they are an interchange format, and sorting is over identifiers rather than human-readable text. |
| L06 | na | No translated strings exist. |
| L07 | pass | README, `docs/`, code comments, identifiers, commit messages, issues, pull requests, and release notes are English. |

## Accessibility

| ID | Result | Evidence |
| --- | --- | --- |
| X01 | pass | The dashboard is a static read-only document with no custom widgets, so focus order follows the document. A skip link is the first focusable element and is off-screen until focused; navigation links carry an explicit focus style in addition to the platform indicator. Asserted by `test/unit/dashboard-accessibility.test.mjs`. |
| X02 | pass | `lang` on the document, `header`/`nav`/`main`/`footer` landmarks, `aria-label` on the navigation and on card lists, `aria-labelledby` on every section, and `role="status"` on empty-state messages. Asserted by the same test file. |
| X03 | pass | Text is sized in `rem` so platform text-size settings apply, layout reflows below 35rem, light and dark palettes are both defined, and run status is a coloured badge that contains the status word — so no state is carried by colour alone. Asserted by the same test file. |
| X04 | pass | The CLI writes no ANSI colour, no cursor control, and no Unicode decoration to `stdout` or `stderr`; plain text is the only mode, so there is nothing to disable. `--json` provides the same information machine-readably, and meaning is carried by words and stable exit codes. Stated in the README "Accessibility" section. |
| X05 | pass | The README states the limitations: the dashboard's accessibility is covered by automated tests over rendered markup rather than an audit with assistive technology, and contrast ratios were chosen by inspection rather than measured against WCAG thresholds. |

## Data Protection And Privacy

| ID | Result | Evidence |
| --- | --- | --- |
| Y01 | pass | The README "Privacy and data protection" section states the explicit none case: no telemetry, no analytics, no crash reporting, nothing collected or transmitted by Agent Trestle itself. |
| Y02 | pass | The same section tabulates every outbound destination and its purpose, and distinguishes Agent Trestle's own sockets (one listener on `127.0.0.1`, no outbound request) from the launched `git` and Copilot CLI processes. |
| Y03 | pass | Absent rather than disabled: there is no telemetry, analytics, or crash-reporting code to opt into. Disclosed in the README. |
| Y04 | pass | The same section tabulates the on-disk locations — `.trestle/config.json`, `.trestle/config/`, `.trestle/state/project/`, `.trestle/state/workstreams/<id>/`, and the explicit absolute audit root — all under the user's own project root and removable with ordinary tools. |
| Y05 | pass | The README names GitHub and the model providers GitHub routes to as the recipients of prompts and of repository content an agent reads, and states that the Copilot CLI, not Agent Trestle, sends it. |
| Y06 | pass | The README states that nothing expires or is uploaded, that state and audit records live until deleted, how to delete them, and why audit segments are retained deliberately. |

## Archived Repositories

`A01` through `A04` are recorded `na`. The repository is active and
intentionally not archived.

## Overall state

`Healthy`. No criterion fails. Both `partial` results are minor and neither
affects security, recoverability, or reproducibility:

- `P09` is a first-run timing gap in a workflow that is already wired up.
- `I06` is a manual version bump that a release gate already prevents from
  drifting.

## Reassessment

The record ages out after 183 days, at which point the badge renders as stale
and the conformance check fails. Reassess by 2027-03-03, or sooner if the
standard publishes a new version, and update both this document and
`.github/conformance.yml` together.
