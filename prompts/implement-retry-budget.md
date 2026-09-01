# Implement the retry budget

Referenced by [`examples/task-manifest.json`](../examples/task-manifest.json) as a
`promptFile`. It exists so the shipped example is runnable as written: `promptFile`
resolves against the **project root**, not the manifest's directory.

## Task

Implement the retry budget described in `docs/retry-budget.md`, which the preceding
`design` task produces.

- Add the retry-budget logic in `src/`, following the approach in that document.
- Keep the change confined to the paths this task owns. Do not edit the design
  document, the manifest, or any ownership policy.
- Cover the new behaviour with tests, including the exhausted-budget path.

## Constraints

- No new runtime dependencies. This project deliberately ships zero of them, so
  prefer Node built-ins.
- Match the surrounding code style; `npm run lint` enforces the mechanical parts.
- Leave the working tree buildable: `npm run check` must pass.

## Done when

- The budget bounds retries as `docs/retry-budget.md` specifies.
- New tests fail without the change and pass with it.
- `npm run check` is green.
