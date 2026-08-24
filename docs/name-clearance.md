# Name clearance research

**Working name:** Agent Trestle  
**Package:** `agent-trestle`  
**Checked:** 2026-08-14  
**Rechecked:** 2026-08-20

This is factual naming research, not legal advice or formal trademark
clearance.

## Exact-name checks

| Surface | Finding | Evidence |
|---|---|---|
| npm `agent-trestle` | Unregistered at both checks | https://registry.npmjs.org/agent-trestle |
| PyPI `agent-trestle` | Unregistered at both checks | https://pypi.org/project/agent-trestle/ |
| GitHub | No exact repository found besides this one | GitHub repository search, 2026-08-20 |
| Agent tooling | No exact Agent Trestle product found | Web and developer-tool search, 2026-08-14 |

The exact compound name remains unclaimed on the surfaces checked. That is
factual availability research; it is not formal legal clearance, and it does
not survey trademark registers.

## CLI collision

The short executable name `trestle` is already used by multiple developer
tools:

- `@trestlescan/cli`, an active secret-scanning tool:
  https://www.npmjs.com/package/@trestlescan/cli
- `compliance-trestle`, the OSCAL Compass/IBM compliance tool:
  https://pypi.org/project/compliance-trestle/
- the legacy npm package `trestle`:
  https://registry.npmjs.org/trestle

Agent Trestle therefore uses **`agent-trestle` as its executable name** rather
than claiming the ambiguous global `trestle` binary.

## Adjacent brand and trademark risk

- TrestleScan serves an overlapping developer audience, although its product
  category differs.
- A third-party Class 009 application for `TRESTLE` was reported under USPTO
  serial `99830598`, filed 2026-05-18. Its status and scope require confirmation
  from authoritative registers and qualified counsel.
- Other standalone Trestle products exist in identity APIs, compliance, and
  project scaffolding.

## Public-release gate

The gate below separates two decisions that were previously conflated:
publishing the source, and distributing a package under the name. Trademark
exposure attaches mainly to the second.

| # | Condition | Status at 2026-08-24 |
|---|---|---|
| 1 | reserve the GitHub and npm `agent-trestle` identifiers | GitHub reserved; npm **not** reserved, the name was still unclaimed on 2026-08-24 |
| 2 | authoritative USPTO/EUIPO and national-register search | **not performed** |
| 3 | likelihood-of-confusion assessment where required | **not performed** |
| 4 | recheck exact-name registry availability | done 2026-08-20; npm rechecked 2026-08-24 |
| 5 | confirm the independent source-provenance gate | see [provenance audit](provenance-audit.md); covers the baseline only |

Conditions 2 and 3 require qualified counsel and remain outstanding. The
project was published without them as a deliberate, documented decision, not
because they were satisfied. Nothing in this repository may be described as
legally cleared.

Risk is reduced, not removed, by two choices: the namespaced executable
`agent-trestle` rather than the contested bare `trestle`, and a pre-`1.0.0`
version that keeps the name easy to change. If a register search or a rights
holder later shows a conflict, renaming is the expected remedy.
