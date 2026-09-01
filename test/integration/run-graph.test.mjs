import assert from "node:assert/strict";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";
import { makeScratchRoot } from "../helpers/scratch.mjs";
import { validateConfig } from "../../src/config/config.mjs";
import { validateManifest } from "../../src/manifest/manifest.mjs";
import { runManifest } from "../../src/run/run.mjs";
import { createWorkSignatureProvider } from "../../src/scheduler/work-signature.mjs";
import { EXIT_CODES, runCli } from "../../src/cli/main.mjs";

const workRoot = await makeScratchRoot("run-graph");

after(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

const config = validateConfig({
  version: 1,
  project: { id: "acme" },
  copilot: { binary: "copilot", timeoutMs: 5_000 },
  workstreams: [{
    id: "backend",
    path: "backend",
    roles: [{ id: "implementer", agent: "backend-implementer" }],
  }],
});

const route = { project: "acme", workstream: "backend", role: "implementer" };

function succeeded() {
  return {
    route: { agentId: "backend-implementer" },
    agent: { id: "backend-implementer" },
    skills: [],
    permissions: {},
    execution: { status: "succeeded", ok: true, exitCode: 0, stdout: "out", stderr: "" },
  };
}

function failed(status = "failed", exitCode = 1) {
  return {
    ...succeeded(),
    execution: { status, ok: false, exitCode, stdout: "", stderr: "boom" },
  };
}

async function projectWith(name) {
  const projectRoot = path.join(workRoot, name);
  await mkdir(path.join(projectRoot, "backend"), { recursive: true });
  return projectRoot;
}

function graph(tasks) {
  return validateManifest({ version: 1, tasks });
}

test("tasks execute in dependency order", async () => {
  const projectRoot = await projectWith("order");
  const order = [];
  const result = await runManifest({
    config,
    projectRoot,
    manifest: graph([
      { id: "publish", route, prompt: "publish", dependsOn: ["build"] },
      { id: "build", route, prompt: "build", dependsOn: ["design"] },
      { id: "design", route, prompt: "design" },
    ]),
    dispatchImpl: async ({ prompt }) => {
      order.push(prompt);
      return succeeded();
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
  assert.deepEqual(order, ["design", "build", "publish"]);
  assert.deepEqual(result.tasks.map((task) => task.status), ["completed", "completed", "completed"]);
});

test("concurrency bounds simultaneous agents and defaults to one", async () => {
  const projectRoot = await projectWith("concurrency");
  const independent = ["a", "b", "c", "d"].map((id) => ({ id, route, prompt: id }));

  const observe = async (concurrency) => {
    let active = 0;
    let peak = 0;
    await runManifest({
      config,
      projectRoot,
      manifest: graph(independent),
      ...(concurrency === undefined ? {} : { concurrency }),
      dispatchImpl: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => { setTimeout(resolve, 20); });
        active -= 1;
        return succeeded();
      },
    });
    return peak;
  };

  assert.equal(await observe(undefined), 1, "default concurrency must be 1");
  assert.equal(await observe(1), 1);
  assert.equal(await observe(2), 2);
});

test("a failed process is never reported as a successful task", async () => {
  const projectRoot = await projectWith("failure");
  const result = await runManifest({
    config,
    projectRoot,
    manifest: graph([
      { id: "first", route, prompt: "first" },
      { id: "second", route, prompt: "second", dependsOn: ["first"] },
    ]),
    dispatchImpl: async ({ prompt }) => (prompt === "first" ? failed() : succeeded()),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.failedTask, "first");
  const first = result.tasks.find((task) => task.id === "first");
  assert.equal(first.status, "failed");
  assert.equal(first.error.code, "TASK_FAILED");
  assert.equal(first.error.execution.ok, false);
  // The dependent task must never have started.
  assert.equal(result.tasks.find((task) => task.id === "second").status, "pending");
});

test("a timeout and an output-cap kill both fail the task", async () => {
  const projectRoot = await projectWith("nonzero");
  for (const status of ["timeout", "output-limit", "signaled", "error"]) {
    const result = await runManifest({
      config,
      projectRoot,
      manifest: graph([{ id: "only", route, prompt: "only" }]),
      dispatchImpl: async () => failed(status, null),
    });
    assert.equal(result.ok, false, `${status} must not be reported as success`);
    assert.equal(result.tasks[0].error.execution.status, status);
  }
});

test("raw stdout and stderr are summarized rather than embedded", async () => {
  const projectRoot = await projectWith("summary");
  const result = await runManifest({
    config,
    projectRoot,
    manifest: graph([{ id: "only", route, prompt: "only" }]),
    dispatchImpl: async () => succeeded(),
  });
  const { execution } = result.tasks[0].dispatches[0];
  assert.equal(execution.stdout, undefined);
  assert.equal(execution.stderr, undefined);
  assert.equal(execution.stdoutBytes, 3);
  assert.equal(execution.stderrBytes, 0);
  assert.equal(execution.ok, true);
});

test("a task without stop conditions runs exactly once", async () => {
  const projectRoot = await projectWith("single");
  let calls = 0;
  const result = await runManifest({
    config,
    projectRoot,
    manifest: graph([{ id: "only", route, prompt: "only" }]),
    dispatchImpl: async () => { calls += 1; return succeeded(); },
  });
  assert.equal(calls, 1);
  assert.equal(result.tasks[0].rounds, 1);
  assert.equal(result.tasks[0].stop.reason, "single-dispatch");
});

test("declared stop conditions bound repeated rounds", async () => {
  const projectRoot = await projectWith("rounds");
  let calls = 0;
  const result = await runManifest({
    config,
    projectRoot,
    manifest: graph([{ id: "only", route, prompt: "only", stop: { maxRounds: 3 } }]),
    // A signature that always changes keeps the no-op stop from firing, so the
    // declared round bound is what terminates the task.
    workSignatureProvider: createWorkSignatureProvider(async () => `sig-${calls}`),
    dispatchImpl: async () => { calls += 1; return succeeded(); },
  });
  assert.equal(calls, 3);
  assert.equal(result.tasks[0].rounds, 3);
  assert.equal(result.tasks[0].stop.reason, "max-rounds");
  assert.equal(result.tasks[0].dispatches.length, 3);
});

test("an unchanged work signature stops a task as converged", async () => {
  const projectRoot = await projectWith("converged");
  let calls = 0;
  const result = await runManifest({
    config,
    projectRoot,
    manifest: graph([{ id: "only", route, prompt: "only", stop: { maxRounds: 50 } }]),
    workSignatureProvider: createWorkSignatureProvider(async () => "unchanged"),
    dispatchImpl: async () => { calls += 1; return succeeded(); },
  });
  assert.equal(result.tasks[0].stop.reason, "no-op");
  assert.equal(calls, 1, "a converged task must not keep dispatching");
});

test("an unknown route is a manifest error raised before anything is spawned", async () => {
  const projectRoot = await projectWith("route");
  let dispatched = false;
  await assert.rejects(
    runManifest({
      config,
      projectRoot,
      manifest: graph([{ id: "only", route: { ...route, role: "ghost" }, prompt: "p" }]),
      dispatchImpl: async () => { dispatched = true; return succeeded(); },
    }),
    (error) => error.name === "ManifestError" && error.code === "UNKNOWN_ROUTE",
  );
  assert.equal(dispatched, false);
});

test("aborting a run stops scheduled work", async () => {
  const projectRoot = await projectWith("abort");
  const controller = new AbortController();
  const started = [];
  const result = await runManifest({
    config,
    projectRoot,
    manifest: graph([
      { id: "first", route, prompt: "first" },
      { id: "second", route, prompt: "second", dependsOn: ["first"] },
    ]),
    signal: controller.signal,
    dispatchImpl: async ({ prompt }) => {
      started.push(prompt);
      controller.abort(new Error("interrupted"));
      return succeeded();
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(started, ["first"], "no task may start after the abort");
});

test("run rejects a concurrency that is not a positive integer", async () => {
  const projectRoot = await projectWith("concurrency-guard");
  for (const concurrency of [0, -1, 1.5]) {
    await assert.rejects(
      runManifest({
        config,
        projectRoot,
        manifest: graph([{ id: "only", route, prompt: "only" }]),
        concurrency,
        dispatchImpl: async () => succeeded(),
      }),
      RangeError,
    );
  }
});

// --- CLI contract -----------------------------------------------------------

function capture(cwd) {
  const out = [];
  const err = [];
  return {
    io: {
      cwd,
      stdout: { write: (chunk) => out.push(chunk) },
      stderr: { write: (chunk) => err.push(chunk) },
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

async function initializedProject(name) {
  const projectRoot = path.join(workRoot, name);
  await mkdir(projectRoot, { recursive: true });
  const init = capture(projectRoot);
  assert.equal(await runCli(["init", "--json"], init.io), EXIT_CODES.SUCCESS);
  return projectRoot;
}

test("an invalid manifest exits 2 before any side effect", async () => {
  const projectRoot = await initializedProject("cli-invalid");
  await writeFile(
    path.join(projectRoot, "tasks.json"),
    JSON.stringify({ version: 1, tasks: [{ id: "a", route: {}, prompt: "p" }] }),
  );
  const invoked = capture(projectRoot);
  const { main } = await import("../../src/cli/main.mjs");
  const exitCode = await main(["run", "--manifest", "tasks.json", "--json"], invoked.io);
  assert.equal(exitCode, EXIT_CODES.USAGE);
  const failure = JSON.parse(invoked.stderr());
  assert.equal(failure.ok, false);
  assert.match(failure.error.message, /route\.project is required/);
});

test("an unrunnable graph is refused before any process starts", async () => {
  const projectRoot = await initializedProject("cli-cycle");
  const node = { project: "example-project", workstream: "main", role: "builder" };
  await writeFile(path.join(projectRoot, "tasks.json"), JSON.stringify({
    version: 1,
    tasks: [
      { id: "a", route: node, prompt: "a", dependsOn: ["b"] },
      { id: "b", route: node, prompt: "b", dependsOn: ["a"] },
    ],
  }));
  const invoked = capture(projectRoot);
  const { main } = await import("../../src/cli/main.mjs");
  const exitCode = await main(["run", "--manifest", "tasks.json", "--json"], invoked.io);
  assert.equal(exitCode, EXIT_CODES.USAGE);
  const failure = JSON.parse(invoked.stderr());
  assert.equal(failure.error.code, "UNRESOLVABLE_GRAPH");
  assert.match(failure.error.message, /contains a cycle: a -> b -> a/);
});

test("run executes a manifest end to end and reports the graph", async () => {
  const projectRoot = await initializedProject("cli-run");
  const fakeCopilot = path.join(projectRoot, "fake-copilot");
  await writeFile(fakeCopilot, "#!/usr/bin/env node\nprocess.stdout.write('done');\n");
  await chmod(fakeCopilot, 0o755);

  await writeFile(path.join(projectRoot, "tasks.json"), JSON.stringify({
    version: 1,
    id: "nightly",
    tasks: [
      { id: "design", route: { project: "example-project", workstream: "main", role: "builder" }, prompt: "design it" },
      {
        id: "build",
        route: { project: "example-project", workstream: "main", role: "builder" },
        promptFile: "prompts/build.md",
        dependsOn: ["design"],
      },
    ],
  }));
  await mkdir(path.join(projectRoot, "prompts"), { recursive: true });
  await writeFile(path.join(projectRoot, "prompts", "build.md"), "build it");

  const invoked = capture(projectRoot);
  const exitCode = await runCli(
    ["run", "--manifest", "tasks.json", "--binary", fakeCopilot, "--json"],
    invoked.io,
  );
  assert.equal(exitCode, EXIT_CODES.SUCCESS, invoked.stderr());
  const payload = JSON.parse(invoked.stdout());
  assert.equal(payload.command, "run");
  assert.equal(payload.ok, true);
  assert.equal(payload.status, "completed");
  assert.equal(payload.runId, "nightly");
  assert.equal(payload.concurrency, 1);
  assert.deepEqual(payload.tasks.map((task) => task.id), ["design", "build"]);
  assert.ok(payload.tasks.every((task) => task.status === "completed"));
});

test("a failing task yields a non-zero exit and a failure-shaped payload", async () => {
  const projectRoot = await initializedProject("cli-fail");
  const fakeCopilot = path.join(projectRoot, "fake-copilot");
  await writeFile(fakeCopilot, "#!/usr/bin/env node\nprocess.stderr.write('nope');\nprocess.exit(7);\n");
  await chmod(fakeCopilot, 0o755);
  await writeFile(path.join(projectRoot, "tasks.json"), JSON.stringify({
    version: 1,
    tasks: [{
      id: "doomed",
      route: { project: "example-project", workstream: "main", role: "builder" },
      prompt: "fail please",
    }],
  }));

  const invoked = capture(projectRoot);
  const exitCode = await runCli(
    ["run", "--manifest", "tasks.json", "--binary", fakeCopilot, "--json"],
    invoked.io,
  );
  assert.equal(exitCode, EXIT_CODES.FAILED);
  const payload = JSON.parse(invoked.stdout());
  assert.equal(payload.ok, false);
  assert.equal(payload.status, "failed");
  assert.equal(payload.failedTask, "doomed");
  assert.equal(payload.tasks[0].error.execution.exitCode, 7);
});
