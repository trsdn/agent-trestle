import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";
import { makeScratchRoot } from "../helpers/scratch";
import {
  loadManifest,
  ManifestError,
  MANIFEST_VERSION,
  resolveTaskPrompts,
  validateManifest,
} from "../../src/manifest/manifest.mjs";

const workRoot = await makeScratchRoot("manifest-contract");

after(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

const route = { project: "acme", workstream: "backend", role: "implementer" };

function manifest(overrides = {}) {
  return {
    version: MANIFEST_VERSION,
    tasks: [{ id: "alpha", route, prompt: "do the thing" }],
    ...overrides,
  };
}

function rejects(input, fragment, code = "INVALID_MANIFEST") {
  assert.throws(() => validateManifest(input), (error) => {
    assert.ok(error instanceof ManifestError, `expected ManifestError, got ${error?.name}`);
    assert.equal(error.code, code);
    assert.match(error.message, fragment);
    return true;
  });
}

test("a minimal manifest normalizes to an explicit graph", () => {
  const normalized = validateManifest(manifest());
  assert.deepEqual(normalized, {
    version: 1,
    tasks: [{ id: "alpha", route, prompt: "do the thing", dependsOn: [] }],
  });
});

test("the run id is preserved when declared", () => {
  assert.equal(validateManifest(manifest({ id: "nightly" })).id, "nightly");
});

test("unknown keys are rejected at every level", () => {
  rejects(manifest({ extra: true }), /manifest contains unknown key: extra/);
  rejects(
    manifest({ tasks: [{ id: "alpha", route, prompt: "p", extra: 1 }] }),
    /manifest\.tasks\[0\] contains unknown key: extra/,
  );
  rejects(
    manifest({ tasks: [{ id: "alpha", route: { ...route, extra: 1 }, prompt: "p" }] }),
    /manifest\.tasks\[0\]\.route contains unknown key: extra/,
  );
  rejects(
    manifest({ tasks: [{ id: "alpha", route, prompt: "p", stop: { maxRounds: 2, extra: 1 } }] }),
    /manifest\.tasks\[0\]\.stop contains unknown key: extra/,
  );
});

test("only version 1 is accepted", () => {
  rejects(manifest({ version: 2 }), /manifest\.version must be 1/);
  rejects(manifest({ version: "1" }), /manifest\.version must be 1/);
});

test("tasks must be a non-empty array", () => {
  rejects(manifest({ tasks: [] }), /manifest\.tasks must be a non-empty array/);
  rejects(manifest({ tasks: {} }), /manifest\.tasks must be a non-empty array/);
});

test("exactly one prompt source is required", () => {
  rejects(
    manifest({ tasks: [{ id: "alpha", route }] }),
    /must declare exactly one of prompt or promptFile/,
  );
  rejects(
    manifest({ tasks: [{ id: "alpha", route, prompt: "p", promptFile: "p.md" }] }),
    /must declare exactly one of prompt or promptFile/,
  );
  rejects(
    manifest({ tasks: [{ id: "alpha", route, prompt: "   " }] }),
    /\.prompt must be a non-empty string/,
  );
});

test("a route must name project, workstream and role explicitly", () => {
  for (const key of ["project", "workstream", "role"]) {
    const partial = { ...route };
    delete partial[key];
    rejects(
      manifest({ tasks: [{ id: "alpha", route: partial, prompt: "p" }] }),
      new RegExp(`route\\.${key} is required`),
    );
  }
  rejects(
    manifest({ tasks: [{ id: "alpha", route: { ...route, role: "Not An ID" }, prompt: "p" }] }),
    /route\.role must be an explicit lowercase ID/,
  );
});

test("task IDs must be unique and well-formed", () => {
  rejects(
    manifest({
      tasks: [
        { id: "alpha", route, prompt: "p" },
        { id: "alpha", route, prompt: "q" },
      ],
    }),
    /manifest\.tasks contains duplicate entry "alpha"/,
  );
  rejects(manifest({ tasks: [{ id: "Alpha", route, prompt: "p" }] }), /\.id must be an explicit lowercase ID/);
});

test("a stop object must declare at least one bound", () => {
  rejects(
    manifest({ tasks: [{ id: "alpha", route, prompt: "p", stop: {} }] }),
    /must declare at least one of: maxRounds, maxDurationMs, maxNoOpRounds/,
  );
  rejects(
    manifest({ tasks: [{ id: "alpha", route, prompt: "p", stop: { maxRounds: 0 } }] }),
    /stop\.maxRounds must be a positive integer/,
  );
  const bounded = validateManifest(
    manifest({ tasks: [{ id: "alpha", route, prompt: "p", stop: { maxNoOpRounds: 2 } }] }),
  );
  assert.deepEqual(bounded.tasks[0].stop, { maxNoOpRounds: 2 });
});

test("an unrunnable graph is rejected before execution", () => {
  rejects(
    manifest({ tasks: [{ id: "alpha", route, prompt: "p", dependsOn: ["ghost"] }] }),
    /task alpha has unknown dependency: ghost/,
    "UNRESOLVABLE_GRAPH",
  );
  rejects(
    manifest({ tasks: [{ id: "alpha", route, prompt: "p", dependsOn: ["alpha"] }] }),
    /task alpha cannot depend on itself/,
    "UNRESOLVABLE_GRAPH",
  );
  rejects(
    manifest({
      tasks: [
        { id: "alpha", route, prompt: "p", dependsOn: ["beta"] },
        { id: "beta", route, prompt: "q", dependsOn: ["alpha"] },
      ],
    }),
    /contains a cycle: alpha -> beta -> alpha/,
    "UNRESOLVABLE_GRAPH",
  );
});

test("duplicate skills and dependencies are rejected rather than silently deduplicated", () => {
  rejects(
    manifest({ tasks: [{ id: "alpha", route, prompt: "p", skills: ["a", "a"] }] }),
    /skills contains duplicate entry "a"/,
  );
  rejects(
    manifest({
      tasks: [
        { id: "alpha", route, prompt: "p" },
        { id: "beta", route, prompt: "q", dependsOn: ["alpha", "alpha"] },
      ],
    }),
    /dependsOn contains duplicate entry "alpha"/,
  );
});

test("loadManifest rejects malformed JSON with the offending path", async () => {
  const projectRoot = path.join(workRoot, "bad-json");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "tasks.json"), "{ not json");
  await assert.rejects(
    loadManifest(projectRoot, "tasks.json"),
    (error) => error instanceof ManifestError && /Invalid JSON in .*tasks\.json/.test(error.message),
  );
});

test("loadManifest validates the document it read", async () => {
  const projectRoot = path.join(workRoot, "load");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "tasks.json"), JSON.stringify(manifest({ id: "nightly" })));
  const loaded = await loadManifest(projectRoot, "tasks.json");
  assert.equal(loaded.id, "nightly");
  assert.equal(loaded.tasks[0].id, "alpha");
});

test("prompt files are read from within the project and empty ones fail closed", async () => {
  const projectRoot = path.join(workRoot, "prompts");
  await mkdir(path.join(projectRoot, "prompts"), { recursive: true });
  await writeFile(path.join(projectRoot, "prompts", "alpha.md"), "written prompt");
  await writeFile(path.join(projectRoot, "prompts", "empty.md"), "   \n");

  const resolved = await resolveTaskPrompts(
    projectRoot,
    validateManifest(manifest({ tasks: [{ id: "alpha", route, promptFile: "prompts/alpha.md" }] })),
  );
  assert.equal(resolved.tasks[0].prompt, "written prompt");

  await assert.rejects(
    resolveTaskPrompts(
      projectRoot,
      validateManifest(manifest({ tasks: [{ id: "alpha", route, promptFile: "prompts/empty.md" }] })),
    ),
    (error) => error instanceof ManifestError && /resolved to an empty prompt/.test(error.message),
  );
});

test("a prompt file outside the project root fails closed", async () => {
  const projectRoot = path.join(workRoot, "escape", "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(workRoot, "escape", "outside.md"), "secret");
  await assert.rejects(
    resolveTaskPrompts(
      projectRoot,
      validateManifest(manifest({ tasks: [{ id: "alpha", route, promptFile: "../outside.md" }] })),
    ),
    (error) => error.name === "PathSecurityError" || /escape|traversal/i.test(error.message),
  );
});

test("the shipped example manifest loads and every promptFile it references resolves", async () => {
  // Guards against example rot: a promptFile that does not exist makes the
  // documented quickstart fail for anyone who copies it verbatim.
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const manifest = await loadManifest(repoRoot, "examples/task-manifest.json");
  const resolved = await resolveTaskPrompts(repoRoot, manifest);

  assert.ok(resolved.tasks.length > 0);
  for (const task of resolved.tasks) {
    assert.equal(typeof task.prompt, "string", `${task.id} must resolve to a prompt`);
    assert.notEqual(task.prompt.trim(), "", `${task.id} resolved to an empty prompt`);
  }
});
