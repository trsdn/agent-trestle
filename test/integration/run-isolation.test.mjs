import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { makeScratchRoot } from "../helpers/scratch.mjs";
import { POSIX_OWNERSHIP_ONLY } from "../helpers/platform.mjs";
import { EXIT_CODES, runCli } from "../../src/cli/main.mjs";

const execFileAsync = promisify(execFile);
const workRoot = await makeScratchRoot("run-isolation");

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

const ROUTE = { project: "example-project", workstream: "main", role: "builder" };

/**
 * The worktree fleet refuses to operate on a directory whose ownership cannot
 * be proven, so these fixtures live under a real Git repository owned by the
 * test user rather than a shared temporary directory.
 */
async function isolatedProject(name, { copilotScript }) {
  const projectRoot = path.join(workRoot, name);
  await mkdir(projectRoot, { recursive: true });

  const init = capture(projectRoot);
  assert.equal(await runCli(["init", "--json"], init.io), EXIT_CODES.SUCCESS, init.stderr());

  const git = (...args) => execFileAsync("git", args, { cwd: projectRoot });
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await git("add", ".");
  await git("commit", "-qm", "seed");

  const binary = path.join(projectRoot, "fake-copilot");
  await writeFile(binary, `#!/usr/bin/env node\n${copilotScript}\n`);
  await chmod(binary, 0o755);
  return { projectRoot, binary };
}

async function writeManifest(projectRoot, tasks, id = "isolated") {
  await writeFile(
    path.join(projectRoot, "tasks.json"),
    JSON.stringify({ version: 1, id, tasks }),
  );
}

async function worktreeList(projectRoot) {
  const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: projectRoot });
  return stdout.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
}

test("an isolated task runs inside its own provisioned worktree", { skip: POSIX_OWNERSHIP_ONLY }, async () => {
  // The agent records the directory it was actually started in.
  const { projectRoot, binary } = await isolatedProject("provisioned", {
    copilotScript: "import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.TRESTLE_TEST_CWD_LOG, process.cwd() + '\\n');",
  });
  const cwdLog = path.join(projectRoot, "cwd.log");
  process.env.TRESTLE_TEST_CWD_LOG = cwdLog;

  await writeManifest(projectRoot, [{ id: "alpha", route: ROUTE, prompt: "work" }]);
  const invoked = capture(projectRoot);
  const exitCode = await runCli(
    ["run", "--manifest", "tasks.json", "--binary", binary, "--isolate", "--json"],
    invoked.io,
  );
  delete process.env.TRESTLE_TEST_CWD_LOG;
  assert.equal(exitCode, EXIT_CODES.SUCCESS, invoked.stderr());

  const payload = JSON.parse(invoked.stdout());
  assert.equal(payload.isolation.enabled, true);
  assert.equal(payload.isolation.worktreeRoot, path.join(projectRoot, ".trestle", "worktrees"));

  const task = payload.tasks[0];
  assert.ok(task.worktree, "an isolated task must report its worktree");
  assert.equal(task.worktree.path.startsWith(payload.isolation.worktreeRoot), true);
  // A per-run branch exists so review has a head ref to gate on.
  assert.match(task.worktree.branch, /^trestle\//);

  const { readFile } = await import("node:fs/promises");
  const observed = (await readFile(cwdLog, "utf8")).trim();
  assert.equal(
    observed,
    task.worktree.path,
    "the agent process must start inside the provisioned worktree, not the project checkout",
  );
});

test("a successful task releases its worktree, a failed one retains it", { skip: POSIX_OWNERSHIP_ONLY }, async () => {
  const { projectRoot, binary } = await isolatedProject("lifetime", {
    copilotScript: "process.exit(process.env.TRESTLE_TEST_FAIL === '1' ? 4 : 0);",
  });

  await writeManifest(projectRoot, [{ id: "alpha", route: ROUTE, prompt: "work" }], "successrun");
  const ok = capture(projectRoot);
  assert.equal(
    await runCli(["run", "--manifest", "tasks.json", "--binary", binary, "--isolate", "--json"], ok.io),
    EXIT_CODES.SUCCESS,
    ok.stderr(),
  );
  const success = JSON.parse(ok.stdout());
  assert.equal(success.tasks[0].worktreeStatus, "removed");
  assert.deepEqual(
    await readdir(success.isolation.worktreeRoot),
    [],
    "a completed task must not leave its checkout behind",
  );

  process.env.TRESTLE_TEST_FAIL = "1";
  await writeManifest(projectRoot, [{ id: "beta", route: ROUTE, prompt: "work" }], "failrun");
  const bad = capture(projectRoot);
  const exitCode = await runCli(
    ["run", "--manifest", "tasks.json", "--binary", binary, "--isolate", "--json"],
    bad.io,
  );
  delete process.env.TRESTLE_TEST_FAIL;
  assert.equal(exitCode, EXIT_CODES.FAILED);

  const failure = JSON.parse(bad.stdout());
  assert.equal(failure.status, "failed");
  const retained = await readdir(failure.isolation.worktreeRoot);
  assert.equal(retained.length, 1, "a failed task must retain its checkout for inspection");
});

test("concurrent tasks routed to one workstream never share a working tree", { skip: POSIX_OWNERSHIP_ONLY }, async () => {
  const { projectRoot, binary } = await isolatedProject("concurrent", {
    copilotScript: "import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.TRESTLE_TEST_CWD_LOG, process.cwd() + '\\n');",
  });
  const cwdLog = path.join(projectRoot, "cwd.log");
  process.env.TRESTLE_TEST_CWD_LOG = cwdLog;

  await writeManifest(projectRoot, ["a", "b", "c"].map((id) => ({ id, route: ROUTE, prompt: id })), "concurrent");
  const invoked = capture(projectRoot);
  const exitCode = await runCli(
    ["run", "--manifest", "tasks.json", "--binary", binary, "--isolate", "--concurrency", "3", "--json"],
    invoked.io,
  );
  delete process.env.TRESTLE_TEST_CWD_LOG;
  assert.equal(exitCode, EXIT_CODES.SUCCESS, invoked.stderr());

  const payload = JSON.parse(invoked.stdout());
  const paths = payload.tasks.map((task) => task.worktree.path);
  assert.equal(new Set(paths).size, 3, "each task needs its own checkout");

  const { readFile } = await import("node:fs/promises");
  const observed = (await readFile(cwdLog, "utf8")).trim().split("\n").sort();
  assert.deepEqual(observed, [...paths].sort());
});

test("an interrupted run strands no worktrees", { skip: POSIX_OWNERSHIP_ONLY }, async () => {
  // A slow agent gives the run time to be aborted mid-flight. The abort is
  // raised through the same AbortController the CLI wires SIGINT to, without
  // signalling the test runner itself.
  const { projectRoot, binary } = await isolatedProject("interrupted", {
    copilotScript: "setTimeout(() => process.exit(0), 5000);",
  });

  const { validateManifest } = await import("../../src/manifest/manifest.mjs");
  const { runManifest } = await import("../../src/run/run.mjs");
  const { loadConfig } = await import("../../src/config/config.mjs");

  const manifest = validateManifest({
    version: 1,
    id: "interrupted",
    tasks: [
      { id: "alpha", route: ROUTE, prompt: "a" },
      { id: "beta", route: ROUTE, prompt: "b", dependsOn: ["alpha"] },
    ],
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("interrupted")), 500);
  const result = await runManifest({
    config: await loadConfig(projectRoot),
    projectRoot,
    manifest,
    binary,
    isolate: true,
    signal: controller.signal,
    auditEnabled: false,
  });
  clearTimeout(timer);

  assert.equal(result.ok, false, "an interrupted run must not report success");
  assert.equal(result.tasks.find((task) => task.id === "beta").status, "pending");

  // Git's registry must agree with the filesystem: only the main checkout is
  // left registered, so nothing was stranded.
  const registered = await worktreeList(projectRoot);
  assert.deepEqual(
    registered.map((entry) => path.resolve(entry)),
    [path.resolve(projectRoot)],
    "an interrupted run must leave no worktree registered with Git",
  );
});

test("a task that writes files inside its worktree succeeds and keeps the work on the branch", { skip: POSIX_OWNERSHIP_ONLY }, async () => {
  // Regression: nothing in the run path commits, so a task that did real work
  // left an unclean checkout and `git worktree remove` refused it -- turning a
  // successful run into a failure and stranding the worktree. Every other
  // fixture here writes outside the worktree or writes nothing, so the checkout
  // stayed pristine and the bug was invisible.
  const { projectRoot, binary } = await isolatedProject("dirty-worktree", {
    copilotScript: "import { writeFileSync } from 'node:fs';\nwriteFileSync('agent-output.txt', 'produced by the agent\\n');",
  });

  await writeManifest(projectRoot, [{ id: "alpha", route: ROUTE, prompt: "work" }], "dirtyrun");
  const invoked = capture(projectRoot);
  const exitCode = await runCli(
    ["run", "--manifest", "tasks.json", "--binary", binary, "--isolate", "--json"],
    invoked.io,
  );
  assert.equal(exitCode, EXIT_CODES.SUCCESS, invoked.stderr());

  const payload = JSON.parse(invoked.stdout());
  const task = payload.tasks[0];
  assert.equal(task.worktreeStatus, "removed", "a completed task must release its checkout");
  assert.deepEqual(await readdir(payload.isolation.worktreeRoot), []);

  // The branch outlives the worktree precisely so the work survives; a forced
  // removal would have discarded the only output the run produced.
  const { stdout } = await execFileAsync(
    "git",
    ["show", `${task.worktree.branch}:agent-output.txt`],
    { cwd: projectRoot },
  );
  assert.equal(stdout, "produced by the agent\n");
});

test("the same named manifest can be run twice with --isolate", { skip: POSIX_OWNERSHIP_ONLY }, async () => {
  // Regression: worktree and branch names were derived from `manifest.id`, but
  // `git worktree add -b` refuses an existing branch and `remove` deliberately
  // leaves branches behind, so the second run of a named manifest failed on
  // every task.
  const { projectRoot, binary } = await isolatedProject("repeatable", {
    copilotScript: "import { writeFileSync } from 'node:fs';\nwriteFileSync('out.txt', 'work\\n');",
  });
  await writeManifest(projectRoot, [{ id: "alpha", route: ROUTE, prompt: "work" }], "nightly");

  for (const attempt of [1, 2]) {
    const invoked = capture(projectRoot);
    const exitCode = await runCli(
      ["run", "--manifest", "tasks.json", "--binary", binary, "--isolate", "--json"],
      invoked.io,
    );
    assert.equal(exitCode, EXIT_CODES.SUCCESS, `attempt ${attempt} failed: ${invoked.stderr()}`);
  }
});

test("a failed task reports where its retained worktree is", { skip: POSIX_OWNERSHIP_ONLY }, async () => {
  // Retention is useless if the operator is never told the checkout exists.
  const { projectRoot, binary } = await isolatedProject("retention-report", {
    copilotScript: "import { writeFileSync } from 'node:fs';\nwriteFileSync('partial.txt', 'half done\\n');\nprocess.exit(4);",
  });
  await writeManifest(projectRoot, [{ id: "alpha", route: ROUTE, prompt: "work" }], "reportrun");

  const invoked = capture(projectRoot);
  assert.equal(
    await runCli(["run", "--manifest", "tasks.json", "--binary", binary, "--isolate", "--json"], invoked.io),
    EXIT_CODES.FAILED,
  );

  const task = JSON.parse(invoked.stdout()).tasks[0];
  assert.equal(task.status, "failed");
  assert.equal(task.worktreeStatus, "retained");
  assert.ok(task.worktree?.path, "a retained checkout must be reported with its path");
  // The point of retention is the evidence inside it, so prove the partial work
  // is still there at the reported path.
  const { readFile } = await import("node:fs/promises");
  assert.equal(
    await readFile(path.join(task.worktree.path, "partial.txt"), "utf8"),
    "half done\n",
  );
});
