# Security

Agent Trestle launches local AI agents that may read or modify repositories.
The default policy is least privilege:

- unrestricted tools, filesystem paths, and URLs are disabled;
- non-interactive execution requires an explicit policy;
- the CLI exposes no merge path at all: `review --merge` returns
  `NOT_SUPPORTED`, and programmatic merge additionally requires an exact-diff
  passing review plus explicit `permissions.autoMerge`;
- the dashboard binds only to `127.0.0.1`;
- state and audit paths are constrained to configured project roots.

Do not report vulnerabilities through a public issue. Use the private security
reporting channel configured on the repository after publication.
