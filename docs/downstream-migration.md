# Downstream migration

Agent Trestle ships only the generic orchestration runtime. A downstream project
that adopts it stays an external consumer and is not part of this package.

Migration uses a golden-diff contract:

- exact parity is required for unchanged deterministic routing and ownership;
- intended behavior changes are explicitly enumerated and reviewed;
- every other difference is a regression until explained.

Expected intentional changes include real Copilot failure propagation, explicit
root/workstream identity, mandatory exact-diff review, isolated state roots, and
one reviewed merge path for both loop and fleet execution.

Consumer-specific agents, prompts, skills, paths, and dashboard labels stay in
the downstream project. Only the generic runtime lives in Agent Trestle.
