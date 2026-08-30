import assert from "node:assert/strict";
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";
import { makeScratchRoot } from "../helpers/scratch.mjs";
import { auditRootFor, reconcileAuditTask } from "../../src/audit/index.mjs";
import { EXIT_CODES, main, runCli } from "../../src/cli/main.mjs";

const workRoot = await makeScratchRoot("audit-runtime");

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

async function initializedProject(name) {
  const projectRoot = path.join(workRoot, name);
  await mkdir(projectRoot, { recursive: true });
  const init = capture(projectRoot);
  assert.equal(await runCli(["init", "--json"], init.io), EXIT_CODES.SUCCESS);
  const binary = path.join(projectRoot, "fake-copilot");
  await writeFile(binary, "#!/usr/bin/env node\nprocess.stdout.write('ok');\n");
  await chmod(binary, 0o755);
  return { projectRoot, binary };
}

const ROUTE = ["--project", "example-project", "--workstream", "main", "--role", "builder"];

test("dispatch writes a reconcilable audit segment under .trestle/audit", async () => {
  const { projectRoot, binary } = await initializedProject("dispatch-audit");
  const invoked = capture(projectRoot);
  const exitCode = await runCli(
    ["dispatch", ...ROUTE, "--prompt", "do the thing", "--binary", binary, "--json"],
    invoked.io,
  );
  assert.equal(exitCode, EXIT_CODES.SUCCESS, invoked.stderr());

  const payload = JSON.parse(invoked.stdout());
  assert.equal(payload.audit.enabled, true);
  assert.equal(payload.audit.writerId, "dispatch");
  assert.equal(payload.audit.taskId, "example-project.main.builder");

  const auditRoot = auditRootFor(projectRoot);
  const { records, segments } = await reconcileAuditTask({
    auditRoot,
    runId: payload.audit.runId,
    taskId: payload.audit.taskId,
  });

  assert.equal(segments.length, 1);
  assert.deepEqual(records.map((record) => record.event.type), [
    "dispatch.started",
    "dispatch.settled",
  ]);

  const [started, settled] = records;
  assert.equal(started.event.route.projectId, "example-project");
  assert.equal(started.event.agent.id, "example-builder");
  assert.deepEqual(started.event.permissions, {
    allowAllTools: false,
    allowAllPaths: false,
    allowAllUrls: false,
    nonInteractive: false,
    autoMerge: false,
  });
  assert.equal(settled.event.execution.ok, true);
  assert.equal(settled.event.execution.exitCode, 0);
  // Raw output is never copied into an integrity record.
  assert.equal(settled.event.execution.stdout, undefined);
  // The chain links the second record to the first.
  assert.equal(settled.priorHash, started.hash);
});

test("a non-zero dispatch is recorded as a failure, never as success", async () => {
  const { projectRoot } = await initializedProject("dispatch-audit-failure");
  const binary = path.join(projectRoot, "failing-copilot");
  await writeFile(binary, "#!/usr/bin/env node\nprocess.exit(9);\n");
  await chmod(binary, 0o755);

  const invoked = capture(projectRoot);
  const exitCode = await runCli(
    ["dispatch", ...ROUTE, "--prompt", "fail", "--binary", binary, "--json"],
    invoked.io,
  );
  assert.equal(exitCode, EXIT_CODES.FAILED);

  const payload = JSON.parse(invoked.stdout());
  const { records } = await reconcileAuditTask({
    auditRoot: auditRootFor(projectRoot),
    runId: payload.audit.runId,
    taskId: payload.audit.taskId,
  });
  const settled = records.at(-1);
  assert.equal(settled.event.type, "dispatch.settled");
  assert.equal(settled.event.execution.ok, false);
  assert.equal(settled.event.execution.exitCode, 9);
});

test("--no-audit suppresses every record", async () => {
  const { projectRoot, binary } = await initializedProject("dispatch-no-audit");
  const invoked = capture(projectRoot);
  const exitCode = await runCli(
    ["dispatch", ...ROUTE, "--prompt", "quiet", "--binary", binary, "--no-audit", "--json"],
    invoked.io,
  );
  assert.equal(exitCode, EXIT_CODES.SUCCESS, invoked.stderr());
  assert.deepEqual(JSON.parse(invoked.stdout()).audit, { enabled: false });
  await assert.rejects(readdir(auditRootFor(projectRoot)), (error) => error.code === "ENOENT");
});

test("an audit write failure fails the command instead of degrading to success", async () => {
  const { projectRoot, binary } = await initializedProject("audit-write-failure");
  // A regular file where the audit root must be a directory: the writer cannot
  // pin it, so the record cannot be written.
  await writeFile(auditRootFor(projectRoot), "not a directory");

  const invoked = capture(projectRoot);
  const exitCode = await main(
    ["dispatch", ...ROUTE, "--prompt", "blocked", "--binary", binary, "--json"],
    invoked.io,
  );
  assert.notEqual(exitCode, EXIT_CODES.SUCCESS);
  const failure = JSON.parse(invoked.stderr());
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, "AUDIT_WRITE_FAILED");
});

test("run gives every task its own writer under one run", async () => {
  const { projectRoot, binary } = await initializedProject("run-audit");
  await writeFile(path.join(projectRoot, "tasks.json"), JSON.stringify({
    version: 1,
    id: "nightly",
    tasks: [
      { id: "design", route: { project: "example-project", workstream: "main", role: "builder" }, prompt: "design" },
      {
        id: "build",
        route: { project: "example-project", workstream: "main", role: "builder" },
        prompt: "build",
        dependsOn: ["design"],
      },
    ],
  }));

  const invoked = capture(projectRoot);
  const exitCode = await runCli(
    ["run", "--manifest", "tasks.json", "--binary", binary, "--json"],
    invoked.io,
  );
  assert.equal(exitCode, EXIT_CODES.SUCCESS, invoked.stderr());
  const payload = JSON.parse(invoked.stdout());
  assert.equal(payload.audit.enabled, true);

  const auditRoot = auditRootFor(projectRoot);
  // The run-level writer records the plan and the outcome.
  const runRecords = (await reconcileAuditTask({ auditRoot, runId: "nightly", taskId: "run" })).records;
  assert.deepEqual(runRecords.map((record) => record.event.type), ["run.started", "run.settled"]);
  assert.equal(runRecords[1].event.status, "completed");

  // Each task has its own segment, so parallel tasks never share a hash chain.
  for (const taskId of ["design", "build"]) {
    const { records, segments } = await reconcileAuditTask({ auditRoot, runId: "nightly", taskId });
    assert.equal(segments.length, 1, `${taskId} must own exactly one segment`);
    assert.deepEqual(
      records.map((record) => record.event.type),
      ["dispatch.started", "dispatch.settled"],
    );
    assert.equal(records[0].writerId, "dispatch");
    assert.equal(records[0].taskId, taskId);
  }
});

test("fleet records filesystem-mutating operations", async () => {
  const repoRoot = path.join(workRoot, "fleet-audit");
  await mkdir(repoRoot, { recursive: true });
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  await run("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
  await run("git", ["config", "user.name", "Test"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "README.md"), "seed\n");
  await run("git", ["add", "."], { cwd: repoRoot });
  await run("git", ["commit", "-qm", "seed"], { cwd: repoRoot });

  const invoked = capture(repoRoot);
  const exitCode = await runCli(
    ["fleet", "prune", "--worktree-root", path.join(repoRoot, "fleet"), "--json"],
    invoked.io,
  );
  assert.equal(exitCode, EXIT_CODES.SUCCESS, invoked.stderr());
  const payload = JSON.parse(invoked.stdout());
  assert.equal(payload.audit.enabled, true);

  const { records } = await reconcileAuditTask({
    auditRoot: auditRootFor(repoRoot),
    runId: payload.audit.runId,
    taskId: "fleet",
  });
  assert.deepEqual(records.map((record) => record.event.type), ["fleet.pruned"]);
  assert.equal(records[0].writerId, "fleet");
});
