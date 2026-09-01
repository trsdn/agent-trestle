import assert from "node:assert/strict";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";
import { makeScratchRoot } from "../helpers/scratch.mjs";
import { createProjectDataProvider } from "../../src/dashboard/project-provider.mjs";
import { auditRootFor } from "../../src/audit/index.mjs";
import { EXIT_CODES, runCli } from "../../src/cli/main.mjs";

const workRoot = await makeScratchRoot("dashboard-runtime");

after(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

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

async function initializedProject(name, script = "process.stdout.write('ok');") {
  const projectRoot = path.join(workRoot, name);
  await mkdir(projectRoot, { recursive: true });
  const init = capture(projectRoot);
  assert.equal(await runCli(["init", "--json"], init.io), EXIT_CODES.SUCCESS, init.stderr());
  const binary = path.join(projectRoot, "fake-copilot");
  await writeFile(binary, `#!/usr/bin/env node\n${script}\n`);
  await chmod(binary, 0o755);
  return { projectRoot, binary };
}

const ROUTE = { project: "example-project", workstream: "main", role: "builder" };

test("an empty project yields an empty but well-formed model", async () => {
  const { projectRoot } = await initializedProject("empty");
  const model = await createProjectDataProvider(projectRoot)();
  for (const collection of ["projects", "workstreams", "runs", "tasks", "reviews", "audit"]) {
    assert.deepEqual(model[collection], [], `${collection} must be an empty array`);
  }
  assert.equal(typeof model.generatedAt, "string");
});

test("a real run is reconstructed from the project's own audit records", async () => {
  const { projectRoot, binary } = await initializedProject("real-run");
  await writeFile(path.join(projectRoot, "tasks.json"), JSON.stringify({
    version: 1,
    id: "nightly",
    tasks: [
      { id: "design", route: ROUTE, prompt: "design" },
      { id: "build", route: ROUTE, prompt: "build", dependsOn: ["design"] },
    ],
  }));

  const invoked = capture(projectRoot);
  assert.equal(
    await runCli(["run", "--manifest", "tasks.json", "--binary", binary, "--json"], invoked.io),
    EXIT_CODES.SUCCESS,
    invoked.stderr(),
  );

  const model = await createProjectDataProvider(projectRoot)();

  assert.deepEqual(model.runs.map((run) => run.id), ["nightly"]);
  const [run] = model.runs;
  assert.equal(run.status, "completed");
  assert.equal(run.taskCount, 2);
  assert.equal(run.concurrency, 1);
  assert.equal(typeof run.startedAt, "string");

  assert.deepEqual(model.tasks.map((task) => task.name).sort(), ["build", "design"]);
  const build = model.tasks.find((task) => task.name === "build");
  assert.equal(build.status, "completed");
  assert.equal(build.runId, "nightly");
  assert.equal(build.project, "example-project");
  assert.equal(build.workstream, "main");
  assert.equal(build.role, "builder");
  assert.equal(build.agent, "example-builder");
  assert.equal(build.exitCode, 0);

  assert.deepEqual(model.projects.map((project) => project.id), ["example-project"]);
  assert.deepEqual(model.workstreams.map((workstream) => workstream.id), ["main"]);

  // Every reconciled task reports its integrity result.
  assert.equal(model.audit.length >= 3, true);
  assert.equal(model.audit.every((entry) => entry.status === "verified"), true);
  assert.equal(model.failures.length, 0);
});

test("a failed task surfaces as a failure without hand-assembled JSON", async () => {
  const { projectRoot, binary } = await initializedProject("failed-run", "process.exit(3);");
  await writeFile(path.join(projectRoot, "tasks.json"), JSON.stringify({
    version: 1,
    id: "doomed",
    tasks: [{ id: "alpha", route: ROUTE, prompt: "fail" }],
  }));

  const invoked = capture(projectRoot);
  assert.equal(
    await runCli(["run", "--manifest", "tasks.json", "--binary", binary, "--json"], invoked.io),
    EXIT_CODES.FAILED,
  );

  const model = await createProjectDataProvider(projectRoot)();
  assert.equal(model.runs[0].status, "failed");
  assert.equal(model.runs[0].failedTask, "alpha");
  assert.equal(model.tasks[0].status, "failed");
  assert.equal(model.tasks[0].exitCode, 3);
  // deriveFailures picks the failures up without any explicit failures array.
  assert.equal(model.failures.some((failure) => failure.status === "failed"), true);
});

test("a standalone dispatch appears even though it has no run-level writer", async () => {
  const { projectRoot, binary } = await initializedProject("standalone");
  const invoked = capture(projectRoot);
  assert.equal(
    await runCli(
      ["dispatch", "--project", "example-project", "--workstream", "main", "--role", "builder",
        "--prompt", "solo", "--binary", binary, "--json"],
      invoked.io,
    ),
    EXIT_CODES.SUCCESS,
    invoked.stderr(),
  );

  const model = await createProjectDataProvider(projectRoot)();
  assert.equal(model.runs.length, 1);
  assert.equal(model.runs[0].status, "completed");
  assert.equal(model.tasks.length, 1);
  assert.equal(model.tasks[0].name, "example-project.main.builder");
});

test("a tampered segment is surfaced rather than thrown", async () => {
  const { projectRoot, binary } = await initializedProject("tampered");
  const invoked = capture(projectRoot);
  assert.equal(
    await runCli(
      ["dispatch", "--project", "example-project", "--workstream", "main", "--role", "builder",
        "--prompt", "solo", "--binary", binary, "--json"],
      invoked.io,
    ),
    EXIT_CODES.SUCCESS,
    invoked.stderr(),
  );

  const auditRoot = auditRootFor(projectRoot);
  const { readdir, readFile, writeFile: write } = await import("node:fs/promises");
  const [runId] = await readdir(path.join(auditRoot, "runs"));
  const segmentDirectory = path.join(
    auditRoot, "runs", runId, "tasks", "example-project.main.builder", "segments",
  );
  const [segment] = await readdir(segmentDirectory);
  const segmentPath = path.join(segmentDirectory, segment);
  const lines = (await readFile(segmentPath, "utf8")).trim().split("\n");
  const record = JSON.parse(lines[0]);
  record.event.type = "dispatch.tampered";
  await write(segmentPath, [JSON.stringify(record), ...lines.slice(1)].join("\n") + "\n");

  const model = await createProjectDataProvider(projectRoot)();
  const entry = model.audit.find((item) => item.id.startsWith(runId));
  assert.equal(entry.status, "failed", "a broken hash chain must be visible in the model");
});

test("the run cap bounds an unbounded audit history", async () => {
  const { projectRoot } = await initializedProject("capped");
  const auditRoot = auditRootFor(projectRoot);
  for (const index of ["001", "002", "003"]) {
    await mkdir(path.join(auditRoot, "runs", `run-${index}`, "tasks"), { recursive: true });
  }
  let reconciled = 0;
  const provider = createProjectDataProvider(projectRoot, {
    maxRuns: 2,
    reconcile: async () => {
      reconciled += 1;
      return { records: [], segments: [], reconciliationHash: "" };
    },
  });
  await provider();
  assert.equal(reconciled, 0, "empty task directories need no reconciliation");
  assert.deepEqual(await (async () => {
    const { readdir } = await import("node:fs/promises");
    return (await readdir(path.join(auditRoot, "runs"))).sort().slice(-2);
  })(), ["run-002", "run-003"]);
});
