# Security Policy

Agent Trestle launches local AI agents that may read or modify repositories.
The default policy is least privilege:

- unrestricted tools, filesystem paths, and URLs are disabled;
- non-interactive execution requires an explicit policy;
- the CLI exposes no merge path at all: `review --merge` returns
  `NOT_SUPPORTED`, and programmatic merge additionally requires an exact-diff
  passing review plus explicit `permissions.autoMerge`;
- the dashboard binds only to `127.0.0.1`;
- state and audit paths are constrained to configured project roots.

The full threat model and containment guarantees are documented in
[docs/security-model.md](docs/security-model.md).

## Supported versions

The project is pre-release and fixes land on the newest version only. There
are no backports to earlier tags.

| Version | Supported |
| --- | --- |
| Latest `0.1.x` release and `main` | Yes |
| Any earlier tag | No — upgrade first |

## Reporting a vulnerability

Report privately through GitHub Security Advisories:

<https://github.com/trsdn/agent-trestle/security/advisories/new>

The same form is reachable from the repository's **Security** tab via **Report
a vulnerability**. Private vulnerability reporting is enabled, so the report
stays visible only to you and the maintainer.

**Do not** open a public issue, pull request, or discussion for a suspected
vulnerability, and please do not disclose details publicly until a fix or a
documented mitigation is available.

Include, where you can:

- the affected release or commit, plus your OS and Node.js version;
- the relevant `.trestle/config.json` settings, with secrets and private paths
  redacted;
- reproduction steps or a proof of concept;
- the impact you expect, such as containment escape, audit tampering, review
  bypass, or credential exposure.

## What to expect

| Stage | Target |
| --- | --- |
| Acknowledgement of the report | 3 working days |
| Initial assessment and severity | 10 working days |
| Fix or documented mitigation for a confirmed high-severity issue | 30 days |
| Advisory, release, and changelog entry | with the fix |

Reporters are credited in the advisory unless they ask not to be. This is a
volunteer-maintained project, so these are targets rather than guarantees; if a
report goes unanswered past these windows, please ping the advisory thread.

## Scope

In scope: containment escapes from configured project roots, review-gate or
audit-integrity bypasses, dashboard exposure beyond `127.0.0.1`, privilege
escalation past the documented permission defaults, and credential or state
leakage in logs and audit records.

Out of scope: vulnerabilities in Node.js, Git, or the GitHub Copilot CLI
themselves — report those to their maintainers — and behaviour that follows
directly from an operator deliberately enabling a documented opt-in such as
`permissions.allowAllTools` or `permissions.autoMerge`.
