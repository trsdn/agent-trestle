import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, lstat, rm, symlink } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import { makeScratchRoot } from "../helpers/scratch.mjs";
import {
  createGitProcessAdapter,
  createWorktreeFleet,
  safeBranchName,
  safeWorktreeName,
} from "../../src/worktrees/index.mjs";
import { PathSecurityError } from "../../src/security/path-security.mjs";

const scratchRoot = await makeScratchRoot("worktree-fleet");
const processTreeRoot = path.join(scratchRoot, "git-adapter-process-tree");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function markerSize(markerPath) {
  try {
    return Buffer.byteLength(await readFile(markerPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

function fakeChild(onKill) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    onKill?.(signal, child);
    return true;
  };
  return child;
}

test("worktree and branch names are safe and deterministic", () => {
  const first = safeWorktreeName("../../Feature: Pay €");
  const second = safeWorktreeName("../../Feature: Pay €");
  assert.equal(first, second);
  assert.match(first, /^[a-z0-9-]+$/);
  assert.ok(first.length <= 63);
  assert.match(safeBranchName("Feature"), /^trestle\/task-/);
});

test("fleet uses explicit repo root and safe worktree path", async () => {
  const calls = [];
  const git = {
    run: async (call) => {
      calls.push(call);
      if (call.args[0] === "worktree") await mkdir(call.args.at(-2), { recursive: true });
    },
  };
  const repoRoot = path.join(scratchRoot, "unit-fleet-repo");
  const worktreeRoot = path.join(scratchRoot, "unit-fleet-root");
  await mkdir(repoRoot, { recursive: true });
  const fleet = createWorktreeFleet({ repoRoot, worktreeRoot, git });
  const worktree = await fleet.create({ id: "../../escape", startPoint: "main" });
  assert.equal(calls[0].repoRoot, repoRoot);
  assert.deepEqual(calls[0].args.slice(0, 3), ["worktree", "add", "-b"]);
  assert.ok(worktree.path.startsWith(`${worktreeRoot}${path.sep}`));
  assert.equal(calls[0].args.at(-1), "main");
});

test("failed worktrees and branches are retained", async () => {
  const calls = [];
  await mkdir(path.join(scratchRoot, "unit-fleet-repo"), { recursive: true });
  const fleet = createWorktreeFleet({
    repoRoot: path.join(scratchRoot, "unit-fleet-repo"),
    worktreeRoot: path.join(scratchRoot, "unit-fleet-root"),
    git: {
      run: async (call) => {
        calls.push(call);
        if (call.args[0] === "worktree") await mkdir(call.args.at(-2), { recursive: true });
      },
    },
  });
  const worktree = await fleet.create({ id: "failed-task" });
  const retained = await fleet.remove(worktree, { outcome: "failed" });
  assert.equal(retained.status, "retained");
  assert.equal(calls.length, 1);
  assert.ok(!calls.flatMap((call) => call.args).includes("branch"));
});

test("fleet requires absolute roots", () => {
  assert.throws(
    () =>
      createWorktreeFleet({
        repoRoot: ".",
        worktreeRoot: "/fleet",
        git: { run() {} },
      }),
    /absolute/,
  );
});

test("fleet rejects option-like start refs", async () => {
  const fleet = createWorktreeFleet({
    repoRoot: path.resolve("repo"),
    worktreeRoot: path.resolve("fleet"),
    git: { run() {} },
  });
  await assert.rejects(
    fleet.create({ id: "task", startPoint: "--upload-pack=bad" }),
    /safe git ref/,
  );
});

test("fleet pins roots and rejects replacement or symlinked remove candidates before Git", async () => {
  const root = path.join(scratchRoot, "fleet-pins");
  const repoRoot = path.join(root, "repo");
  const worktreeRoot = path.join(root, "fleet");
  const outside = path.join(root, "outside");
  await rm(root, { recursive: true, force: true });
  await mkdir(repoRoot, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, path.join(worktreeRoot, "escaped"));
  const calls = [];
  const fleet = createWorktreeFleet({
    repoRoot,
    worktreeRoot,
    git: { run: async (call) => calls.push(call) },
  });
  await assert.rejects(
    fleet.remove({ path: path.join(worktreeRoot, "escaped") }),
    PathSecurityError,
  );
  assert.equal(calls.length, 0);

  const pinned = createWorktreeFleet({
    repoRoot,
    worktreeRoot,
    git: { run: async (call) => calls.push(call) },
  });
  await pinned.prune();
  await rm(worktreeRoot, { recursive: true, force: true });
  await mkdir(worktreeRoot, { recursive: true });
  await assert.rejects(
    pinned.prune(),
    (error) => error instanceof PathSecurityError,
  );

  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await mkdir(repoRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, worktreeRoot);
  const symlinked = createWorktreeFleet({
    repoRoot,
    worktreeRoot,
    git: { run: async (call) => calls.push(call) },
  });
  await assert.rejects(symlinked.prune(), PathSecurityError);
  await rm(root, { recursive: true, force: true });
});

// A directory root cannot be swapped or written by an untrusted user only if no
// component of its path is attacker-controlled. Git resolves the paths we give
// it on its own, so if the root is *not* securely held these operations must
// refuse to invoke Git at all — otherwise a symlink/rename swap of the root that
// wins the race against a post-hoc check redirects Git's write/removal outside
// the pinned root. These tests drive that race deterministically through the
// containment stat seam and assert there is no outside path or branch side
// effect, rather than merely a detected-after-the-fact escape.

function racingWritableRoot(worktreeRoot) {
  const target = path.resolve(worktreeRoot);
  return async (candidate) => {
    const info = await lstat(candidate);
    if (path.resolve(candidate) !== target) return info;
    return {
      uid: info.uid,
      mode: info.mode | 0o022,
      isSymbolicLink: () => info.isSymbolicLink(),
      isDirectory: () => info.isDirectory(),
    };
  };
}

test("create fails closed with no git or outside-path side effect when the fleet root cannot be held", async () => {
  const base = path.join(scratchRoot, "fleet-race-create");
  const repoRoot = path.join(base, "repo");
  const worktreeRoot = path.join(base, "fleet");
  const attackerTarget = path.join(base, "attacker");
  await rm(base, { recursive: true, force: true });
  await mkdir(repoRoot, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await mkdir(attackerTarget, { recursive: true });

  const calls = [];
  const fleet = createWorktreeFleet({
    repoRoot,
    worktreeRoot,
    security: { statImpl: racingWritableRoot(worktreeRoot) },
    git: {
      run: async (call) => {
        calls.push(call);
        // A faithful, malicious Git that followed a swapped root would create the
        // worktree outside the pinned root. Prove we never reach this.
        await mkdir(path.join(attackerTarget, path.basename(call.args.at(-2))), { recursive: true });
      },
    },
  });

  await assert.rejects(
    fleet.create({ id: "task", startPoint: "main" }),
    (error) => error instanceof PathSecurityError && error.code === "INSECURE_CONTAINMENT",
  );
  assert.equal(calls.length, 0, "Git must not run when the fleet root is not securely held");
  assert.deepEqual(
    await readdir(attackerTarget),
    [],
    "no worktree path may be created outside the pinned root",
  );
  await rm(base, { recursive: true, force: true });
});

test("create fails closed when the platform cannot prove secure ownership", async () => {
  const base = path.join(scratchRoot, "fleet-race-unsupported");
  const repoRoot = path.join(base, "repo");
  const worktreeRoot = path.join(base, "fleet");
  await rm(base, { recursive: true, force: true });
  await mkdir(repoRoot, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  const calls = [];
  const fleet = createWorktreeFleet({
    repoRoot,
    worktreeRoot,
    // Emulate a platform without POSIX ownership (e.g. Windows getuid absent).
    security: { getuid: null },
    git: { run: async (call) => calls.push(call) },
  });
  await assert.rejects(
    fleet.create({ id: "task", startPoint: "main" }),
    (error) => error instanceof PathSecurityError && error.code === "INSECURE_CONTAINMENT",
  );
  assert.equal(calls.length, 0, "Git must not run when secure ownership cannot be proven");
  await rm(base, { recursive: true, force: true });
});

test("remove fails closed with no git side effect when the fleet root cannot be held", async () => {
  const base = path.join(scratchRoot, "fleet-race-remove");
  const repoRoot = path.join(base, "repo");
  const worktreeRoot = path.join(base, "fleet");
  const worktreePath = path.join(worktreeRoot, "trestle-task-abc0123456");
  await rm(base, { recursive: true, force: true });
  await mkdir(repoRoot, { recursive: true });
  await mkdir(worktreePath, { recursive: true });
  const calls = [];
  const fleet = createWorktreeFleet({
    repoRoot,
    worktreeRoot,
    security: { statImpl: racingWritableRoot(worktreeRoot) },
    git: { run: async (call) => calls.push(call) },
  });
  await assert.rejects(
    fleet.remove({ id: "task", path: worktreePath }),
    (error) => error instanceof PathSecurityError && error.code === "INSECURE_CONTAINMENT",
  );
  assert.equal(calls.length, 0, "Git must not run for removal when the root is not securely held");
  await rm(base, { recursive: true, force: true });
});

test("create invokes git once with an in-root worktree path when the root is securely held", async () => {
  const base = path.join(scratchRoot, "fleet-race-secure");
  const repoRoot = path.join(base, "repo");
  const worktreeRoot = path.join(base, "fleet");
  await rm(base, { recursive: true, force: true });
  await mkdir(repoRoot, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  const calls = [];
  const fleet = createWorktreeFleet({
    repoRoot,
    worktreeRoot,
    git: {
      run: async (call) => {
        calls.push(call);
        if (call.args[0] === "worktree") await mkdir(call.args.at(-2), { recursive: true });
      },
    },
  });
  const worktree = await fleet.create({ id: "task", startPoint: "main" });
  assert.equal(calls.length, 1);
  assert.equal(path.dirname(worktree.path), worktreeRoot);
  assert.ok(worktree.path.startsWith(`${worktreeRoot}${path.sep}`));
  await rm(base, { recursive: true, force: true });
});

test("git timeout allows graceful SIGTERM settlement", async () => {
  const signals = [];
  const adapter = createGitProcessAdapter({
    spawnImpl: () => fakeChild((signal, child) => {
      signals.push(signal);
      if (signal === "SIGTERM") {
        setTimeout(() => child.emit("close", null, "SIGTERM"), 2);
      }
    }),
    terminationGraceMs: 20,
    forcedKillSettlementMs: 20,
  });
  await assert.rejects(
    adapter.run({ repoRoot: "/repo", args: ["status"], timeoutMs: 2 }),
    (error) => error.code === "TIMEOUT" && error.result.signal === "SIGTERM",
  );
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("git timeout forces SIGKILL and settles even when child never closes", async () => {
  const signals = [];
  const adapter = createGitProcessAdapter({
    spawnImpl: () => fakeChild((signal) => signals.push(signal)),
    terminationGraceMs: 5,
    forcedKillSettlementMs: 5,
  });
  const started = Date.now();
  await assert.rejects(
    adapter.run({ repoRoot: "/repo", args: ["status"], timeoutMs: 2 }),
    (error) => error.code === "TIMEOUT" && error.result.signal === "SIGKILL",
  );
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.ok(Date.now() - started < 250, "timeout settlement must remain bounded");
});

test(
  "git adapter timeout stops a spawned grandchild writer via process-tree termination",
  { skip: process.platform === "win32" ? "requires POSIX process groups" : false },
  async () => {
    await rm(processTreeRoot, { recursive: true, force: true });
    await mkdir(processTreeRoot, { recursive: true });
    const markerPath = path.join(processTreeRoot, `marker-${process.pid}-${Date.now()}.log`);
    const childPidPath = path.join(processTreeRoot, `grandchild-${process.pid}-${Date.now()}.pid`);
    const grandchildSource = [
      "const { appendFileSync, writeFileSync } = require('node:fs');",
      "const markerPath = process.argv[1];",
      "const pidPath = process.argv[2];",
      "writeFileSync(pidPath, String(process.pid));",
      "appendFileSync(markerPath, 'start\\n');",
      "setInterval(() => appendFileSync(markerPath, 'tick\\n'), 20);",
    ].join("\n");
    const parentSource = [
      "const { spawn } = require('node:child_process');",
      "const markerPath = process.argv[1];",
      "const pidPath = process.argv[2];",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}, markerPath, pidPath], { stdio: 'ignore' });`,
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("\n");

    // createGitProcessAdapter always spawns the literal "git" binary; inject a
    // spawnImpl that redirects to a real Node parent process while honouring
    // the options the adapter builds (so `detached` still governs process
    // group signaling), proving descendants are torn down too, not just the
    // direct child.
    const adapter = createGitProcessAdapter({
      spawnImpl: (_binary, _args, options) =>
        spawn(process.execPath, ["-e", parentSource, markerPath, childPidPath], options),
      terminationGraceMs: 100,
      forcedKillSettlementMs: 300,
    });

    try {
      await assert.rejects(
        adapter.run({ repoRoot: "/repo", args: ["status"], timeoutMs: 700 }),
        (error) => error.code === "TIMEOUT",
      );
      let firstSize = 0;
      for (let attempt = 0; attempt < 20 && firstSize === 0; attempt += 1) {
        await sleep(100);
        firstSize = await markerSize(markerPath);
      }
      assert.ok(firstSize > 0, "grandchild marker writes must start before termination");
      await sleep(250);
      const secondSize = await markerSize(markerPath);
      assert.equal(secondSize, firstSize, "marker writes must stop after process-tree termination");
    } finally {
      try {
        const pid = Number((await readFile(childPidPath, "utf8")).trim());
        if (Number.isInteger(pid) && pid > 1) {
          process.kill(pid, "SIGKILL");
        }
      } catch {
        // best-effort test cleanup
      }
      await rm(processTreeRoot, { recursive: true, force: true });
    }
  },
);
