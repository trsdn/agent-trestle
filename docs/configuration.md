# Configuration contract

Agent Trestle requires an explicit project root and reads exactly
`<project-root>/.trestle/config.json`. It does not walk parent directories or
infer project, workstream, or role IDs from paths.

The stable v1 shape is defined by `schemas/config.schema.json`:

- `version` is `1`;
- `project.id` is an explicit lowercase ID;
- every workstream declares an ID, project-relative path, and at least one role;
- every role declares an ID and `.github/agents/<agent>.agent.md`;
- agent frontmatter declares `model` and may declare `skills`;
- skills resolve only from `.github/skills/<id>/SKILL.md`, then
  `.copilot/skills/<id>/SKILL.md`.

Unknown keys are rejected: every object in the schema is
`additionalProperties: false`. Ownership, review, and stop/convergence policies
are not config keys in v1; they are passed programmatically to the ownership,
review, and scheduler APIs.

## Copilot executable

The optional `copilot` object tunes how a dispatched agent process is launched:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `copilot.binary` | non-empty string | `copilot` | Executable resolved for `dispatch`. `dispatch --binary PATH` overrides it per invocation. |
| `copilot.timeoutMs` | positive integer | `0` | Per-process timeout in milliseconds; `0` disables the timeout. |

## Least-privilege defaults

All permission flags default to `false`: unrestricted tools, paths, URLs,
non-interactive execution, and automatic merge. Project, workstream, and role
permissions layer in that order; an escalation must be explicit.

## Generated project

`agent-trestle init` creates a minimal generic config and
`.github/agents/example-builder.agent.md`. Existing files are never overwritten
unless `--force` is supplied.

## State contract

State is rooted explicitly per project and workstream. `config` is immutable
through the state API and, in production, is rooted at the disjoint
`<project-root>/.trestle/config/` artifact directory. Config keys name only
immediate JSON artifacts; nested keys fail closed. Mutable namespaces are
caller-defined and must have a schema in the registry passed to `state-server`;
`decisions` is the conventional namespace used by `trestle_decide`. State keys
are relative safe path segments.

The registry is a JSON object mapping each namespace to a JSON Schema, supplied
as `state-server --schemas FILE`. `examples/state-schemas.json` is a runnable
starting point:

```json
{
  "decisions": { "type": "object" },
  "tasks": { "type": "object" },
  "events": { "type": "array" }
}
```

## Audit contract

Audit writers append JSON-serializable events to independent NDJSON segments.
The runtime adds `sequence`, writer/run/task identity, timestamp, prior hash,
and record hash. Consumers should treat those envelope fields as stable and the
event body as application-defined.

The complete minimal example is under `examples/minimal/`.
