import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { makeScratchRoot } from "../helpers/scratch";
import { checkOwnership, createOwnershipPolicy } from "../../src/ownership/index.mjs";
import { createReviewGitAdapter, reviewFence, runReviewGate } from "../../src/review/index.mjs";
import { createGitProcessAdapter, createWorktreeFleet } from "../../src/worktrees/index.mjs";

const fixtureRoot = await makeScratchRoot("git-hardening");
const repoRoot = path.join(fixtureRoot, "repo");
const worktreeRoot = path.join(fixtureRoot, "worktrees");

// The fixture repository lives inside this project's own checkout, so any git
// command that fails to find the fixture's `.git` would otherwise walk up and
// operate on the real repository. `initializeRepo` deletes and recreates the
// fixture, which opens exactly that window. The ceiling stops the upward search
// so a missing fixture fails loudly instead of silently mutating the checkout,
// and the identity is supplied through the environment so no `git config` write
// can escape either. These are inherited by every git process this file starts,
// including the ones spawned inside the worktree and review adapters.
process.env.GIT_CEILING_DIRECTORIES = path.resolve(".");
process.env.GIT_AUTHOR_NAME = "Trestle Tests";
process.env.GIT_AUTHOR_EMAIL = "trestle-tests@example.invalid";
process.env.GIT_COMMITTER_NAME = "Trestle Tests";
process.env.GIT_COMMITTER_EMAIL = "trestle-tests@example.invalid";
const reviewNonce = "abcdefghijklmnop";
const authorizedMerge = {
  permissions: { autoMerge: true },
  ownershipPolicy: createOwnershipPolicy({ owners: { builder: ["**"] } }),
  actor: "builder",
};

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function spawnGitRunner(onBeforeRun = async () => {}) {
  return async ({ repoRoot: root, args }) => {
    await onBeforeRun({ repoRoot: root, args });
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
}

function passReviewResponse() {
  const fence = reviewFence(reviewNonce);
  return {
    code: 0,
    stdout: `${fence.open}\nPASS\nExact change is acceptable.\n${fence.close}`,
    stderr: "",
  };
}

async function initializeRepo() {
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(repoRoot, { recursive: true });
  git(repoRoot, "init", "-b", "main");
  await writeFile(path.join(repoRoot, "owned.txt"), "base\n");
  await writeFile(path.join(repoRoot, "other.txt"), "base\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "base");
}

async function createReviewedWorktreeChange({
  id = "task-one",
  content = "reviewed\n",
  filePath = "owned.txt",
} = {}) {
  await mkdir(worktreeRoot, { recursive: true });
  const fleet = createWorktreeFleet({
    repoRoot,
    worktreeRoot,
    git: createGitProcessAdapter(),
  });
  const worktree = await fleet.create({ id, startPoint: "main" });
  await writeFile(path.join(worktree.path, filePath), content);
  git(worktree.path, "add", filePath);
  git(worktree.path, "commit", "-m", "reviewed change");
  return worktree;
}

test.beforeEach(initializeRepo);
test.after(async () => rm(fixtureRoot, { recursive: true, force: true }));

test("real worktree changes remain isolated and exact changed paths enforce ownership", async () => {
  await mkdir(worktreeRoot, { recursive: true });
  const fleet = createWorktreeFleet({
    repoRoot,
    worktreeRoot,
    git: createGitProcessAdapter(),
  });
  const worktree = await fleet.create({ id: "task-one", startPoint: "main" });
  assert.equal(path.dirname(worktree.path), worktreeRoot);
  assert.match(path.basename(worktree.path), /^trestle-task-one-/);
  await writeFile(path.join(worktree.path, "owned.txt"), "task change\n");
  await writeFile(path.join(worktree.path, "other.txt"), "wrong owner\n");
  assert.equal(await readFile(path.join(repoRoot, "owned.txt"), "utf8"), "base\n");

  const changed = git(worktree.path, "diff", "--name-only").split("\n");
  const policy = createOwnershipPolicy({
    owners: { builder: ["owned.txt"], maintainer: ["other.txt"] },
  });
  assert.deepEqual(checkOwnership(policy, "builder", changed), {
    allowed: false,
    violations: [{ path: "other.txt", owner: "maintainer", reason: "wrong-owner" }],
  });

  const retained = await fleet.remove(worktree, { outcome: "failed" });
  assert.equal(retained.status, "retained");
  assert.equal(git(repoRoot, "worktree", "list", "--porcelain").includes(worktree.path), true);
});

test("real rename exposes both paths and blocks a producer who only owns the destination", async () => {
  await mkdir(worktreeRoot, { recursive: true });
  const fleet = createWorktreeFleet({
    repoRoot,
    worktreeRoot,
    git: createGitProcessAdapter(),
  });
  const worktree = await fleet.create({ id: "rename-task", startPoint: "main" });
  git(worktree.path, "mv", "other.txt", "renamed.txt");
  git(worktree.path, "commit", "-m", "rename unowned path");
  git(repoRoot, "checkout", "--detach", "HEAD");

  const exactGit = createReviewGitAdapter({ runner: spawnGitRunner() });
  const diff = await exactGit.diff({
    repoRoot,
    baseRef: "main",
    headRef: worktree.branch,
  });
  assert.deepEqual([...diff.changedPaths].sort(), ["other.txt", "renamed.txt"]);

  const result = await runReviewGate({
    repoRoot,
    baseRef: "main",
    headRef: worktree.branch,
    producer: "builder",
    reviewer: "code-review",
    git: exactGit,
    process: { run: async () => passReviewResponse() },
    nonceProvider: () => reviewNonce,
    merge: true,
    permissions: { autoMerge: true },
    ownershipPolicy: createOwnershipPolicy({
      owners: { builder: ["renamed.txt"], maintainer: ["other.txt"] },
    }),
    actor: "builder",
  });
  assert.equal(result.reason, "ownership-rejected");
  assert.deepEqual(
    result.error.violations.map(({ path: changedPath }) => changedPath).sort(),
    ["other.txt"],
  );
  assert.equal(git(repoRoot, "show", "main:other.txt"), "base");
});

test("real review denies a literal backslash filename byte instead of treating it as a separator", { skip: process.platform === "win32" ? "requires POSIX literal backslash filenames" : false }, async () => {
  const worktree = await createReviewedWorktreeChange({
    id: "backslash-task",
    filePath: "owned\\critical.txt",
  });
  git(repoRoot, "checkout", "--detach", "HEAD");

  const exactGit = createReviewGitAdapter({ runner: spawnGitRunner() });
  const diff = await exactGit.diff({
    repoRoot,
    baseRef: "main",
    headRef: worktree.branch,
  });
  assert.deepEqual(diff.changedPaths, ["owned\\critical.txt"]);

  const result = await runReviewGate({
    repoRoot,
    baseRef: "main",
    headRef: worktree.branch,
    producer: "builder",
    reviewer: "code-review",
    git: exactGit,
    process: { run: async () => passReviewResponse() },
    nonceProvider: () => reviewNonce,
    merge: true,
    permissions: { autoMerge: true },
    ownershipPolicy: createOwnershipPolicy({
      owners: { builder: ["owned/**"] },
    }),
    actor: "builder",
  });
  assert.equal(result.reason, "ownership-rejected");
  assert.deepEqual(result.error?.violations, [
    { path: "owned\\critical.txt", owner: null, reason: "unowned" },
  ]);
  assert.equal(git(repoRoot, "show", `${worktree.branch}:owned\\critical.txt`), "reviewed");
});

test("real review merges the pinned head commit when its branch moves", async () => {
  const worktree = await createReviewedWorktreeChange();
  git(repoRoot, "checkout", "--detach", "HEAD");
  const exactGit = createReviewGitAdapter({ runner: spawnGitRunner() });
  const reviewedHeadOid = git(worktree.path, "rev-parse", "HEAD");
  let movedHeadOid;
  const result = await runReviewGate({
    repoRoot,
    baseRef: "main",
    headRef: worktree.branch,
    producer: "builder",
    reviewer: "code-review",
    git: exactGit,
    process: {
      run: async () => {
        await writeFile(path.join(worktree.path, "owned.txt"), "drifted\n");
        git(worktree.path, "add", "owned.txt");
        git(worktree.path, "commit", "-m", "post-review drift");
        movedHeadOid = git(worktree.path, "rev-parse", "HEAD");
        return passReviewResponse();
      },
    },
    nonceProvider: () => reviewNonce,
    merge: true,
    ...authorizedMerge,
  });
  assert.equal(result.status, "merged");
  assert.equal(result.reviewedHeadOid, reviewedHeadOid);
  assert.notEqual(movedHeadOid, reviewedHeadOid);
  assert.equal(git(repoRoot, "show", "main:owned.txt"), "reviewed");
  assert.equal(await readFile(path.join(repoRoot, "owned.txt"), "utf8"), "base\n");
  const ancestry = spawnSync(
    "git",
    ["-C", repoRoot, "merge-base", "--is-ancestor", movedHeadOid, "main"],
  );
  assert.equal(ancestry.status, 1, "the moved branch tip must not be merged");
});

test("real review merges when the target base ref is unchecked out everywhere", async () => {
  const worktree = await createReviewedWorktreeChange();
  const detachedAt = git(repoRoot, "rev-parse", "HEAD");
  git(repoRoot, "checkout", "--detach", "HEAD");
  const result = await runReviewGate({
    repoRoot,
    baseRef: "main",
    headRef: worktree.branch,
    producer: "builder",
    reviewer: "code-review",
    git: createReviewGitAdapter({ runner: spawnGitRunner() }),
    process: { run: async () => passReviewResponse() },
    nonceProvider: () => reviewNonce,
    merge: true,
    ...authorizedMerge,
  });
  assert.equal(result.status, "merged");
  assert.equal(git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
  assert.equal(git(repoRoot, "rev-parse", "HEAD"), detachedAt);
  assert.equal(git(repoRoot, "show", "main:owned.txt"), "reviewed");
  assert.equal(await readFile(path.join(repoRoot, "owned.txt"), "utf8"), "base\n");
});

test("real review hashes the base-to-constructed-merge-tree diff on divergent history", async () => {
  await writeFile(path.join(repoRoot, "owned.txt"), "one\ntwo\nthree\n");
  git(repoRoot, "commit", "-am", "expand divergent fixture");
  git(repoRoot, "checkout", "-b", "task");
  await writeFile(path.join(repoRoot, "owned.txt"), "task-one\ntwo\nthree\n");
  git(repoRoot, "commit", "-am", "task-side change");
  git(repoRoot, "checkout", "main");
  await writeFile(path.join(repoRoot, "owned.txt"), "one\ntwo\nbase-three\n");
  git(repoRoot, "commit", "-am", "base-side change");
  git(repoRoot, "checkout", "--detach", "HEAD");

  const mergedTreeOid = git(repoRoot, "merge-tree", "--write-tree", "main", "task").split(/\s+/)[0];
  const exactDiff = spawnSync(
    "git",
    ["-C", repoRoot, "diff", "--binary", "--full-index", "--no-ext-diff", "main", mergedTreeOid],
    { encoding: "utf8" },
  ).stdout;
  let reviewedPrompt;
  const result = await runReviewGate({
    repoRoot,
    baseRef: "main",
    headRef: "task",
    producer: "builder",
    reviewer: "code-review",
    git: createReviewGitAdapter({ runner: spawnGitRunner() }),
    process: {
      run: async (command) => {
        reviewedPrompt = command.args[command.args.indexOf("-p") + 1];
        return passReviewResponse();
      },
    },
    nonceProvider: () => reviewNonce,
  });
  assert.equal(result.status, "passed");
  assert.equal(result.reviewedMergedTreeOid, mergedTreeOid);
  assert.equal(result.reviewedDiffHash, createHash("sha256").update(exactDiff).digest("hex"));
  assert.match(reviewedPrompt, /\+task-one/);
  assert.doesNotMatch(reviewedPrompt, /\+base-three/);
});

test("real review fails closed when Git reports multiple merge bases", async () => {
  const root = git(repoRoot, "rev-parse", "main");
  git(repoRoot, "checkout", "-b", "branch-a");
  await writeFile(path.join(repoRoot, "a.txt"), "a\n");
  git(repoRoot, "add", "a.txt");
  const a1 = git(repoRoot, "commit", "-m", "a1") && git(repoRoot, "rev-parse", "HEAD");
  git(repoRoot, "checkout", "main");
  git(repoRoot, "checkout", "-b", "branch-b");
  await writeFile(path.join(repoRoot, "b.txt"), "b\n");
  git(repoRoot, "add", "b.txt");
  const b1 = git(repoRoot, "commit", "-m", "b1") && git(repoRoot, "rev-parse", "HEAD");
  const tree = git(repoRoot, "rev-parse", `${root}^{tree}`);
  const a2 = git(repoRoot, "commit-tree", tree, "-p", a1, "-p", b1, "-m", "a2");
  const b2 = git(repoRoot, "commit-tree", tree, "-p", b1, "-p", a1, "-m", "b2");
  git(repoRoot, "update-ref", "refs/heads/branch-a", a2);
  git(repoRoot, "update-ref", "refs/heads/branch-b", b2);
  git(repoRoot, "checkout", "--detach", "HEAD");

  await assert.rejects(
    createReviewGitAdapter({ runner: spawnGitRunner() }).diff({
      repoRoot,
      baseRef: "branch-a",
      headRef: "branch-b",
    }),
    (error) => error.code === "MULTIPLE_MERGE_BASES",
  );
});

test("real review blocks when baseRef is checked out in the current worktree", async () => {
  const worktree = await createReviewedWorktreeChange();
  const result = await runReviewGate({
    repoRoot,
    baseRef: "main",
    headRef: worktree.branch,
    producer: "builder",
    reviewer: "code-review",
    git: createReviewGitAdapter({ runner: spawnGitRunner() }),
    process: { run: async () => passReviewResponse() },
    nonceProvider: () => reviewNonce,
    merge: true,
    ...authorizedMerge,
  });
  assert.equal(result.reason, "merge-failed");
  assert.match(result.error?.message ?? "", /checked out in worktree/);
  assert.equal(git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(git(repoRoot, "show", "main:owned.txt"), "base");
  assert.equal(await readFile(path.join(repoRoot, "owned.txt"), "utf8"), "base\n");
  assert.equal(git(repoRoot, "status", "--porcelain"), "");
});

test("real review blocks when baseRef is checked out in a linked worktree", async () => {
  const worktree = await createReviewedWorktreeChange();
  git(repoRoot, "checkout", "--detach", "HEAD");
  const linkedMainPath = path.join(fixtureRoot, "linked-main");
  git(repoRoot, "worktree", "add", linkedMainPath, "main");
  const result = await runReviewGate({
    repoRoot,
    baseRef: "main",
    headRef: worktree.branch,
    producer: "builder",
    reviewer: "code-review",
    git: createReviewGitAdapter({ runner: spawnGitRunner() }),
    process: { run: async () => passReviewResponse() },
    nonceProvider: () => reviewNonce,
    merge: true,
    ...authorizedMerge,
  });
  assert.equal(result.reason, "merge-failed");
  assert.match(result.error?.message ?? "", /checked out in worktree/);
  assert.equal((result.error?.message ?? "").includes(linkedMainPath), true);
  assert.equal(git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
  assert.equal(git(repoRoot, "show", "main:owned.txt"), "base");
  assert.equal(await readFile(path.join(repoRoot, "owned.txt"), "utf8"), "base\n");
  assert.equal(await readFile(path.join(linkedMainPath, "owned.txt"), "utf8"), "base\n");
  assert.equal(git(repoRoot, "status", "--porcelain"), "");
});

test("real review merges into baseRef when another branch is checked out", async () => {
  const worktree = await createReviewedWorktreeChange();
  git(repoRoot, "checkout", "-b", "staging");
  const result = await runReviewGate({
    repoRoot,
    baseRef: "main",
    headRef: worktree.branch,
    producer: "builder",
    reviewer: "code-review",
    git: createReviewGitAdapter({ runner: spawnGitRunner() }),
    process: { run: async () => passReviewResponse() },
    nonceProvider: () => reviewNonce,
    merge: true,
    ...authorizedMerge,
  });
  assert.equal(result.status, "merged");
  assert.equal(git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD"), "staging");
  assert.equal(git(repoRoot, "show", "main:owned.txt"), "reviewed");
  assert.equal(git(repoRoot, "show", "staging:owned.txt"), "base");
  assert.equal(await readFile(path.join(repoRoot, "owned.txt"), "utf8"), "base\n");
});

test("real review blocks when the base moves before merge", async () => {
  const worktree = await createReviewedWorktreeChange();
  const result = await runReviewGate({
    repoRoot,
    baseRef: "main",
    headRef: worktree.branch,
    producer: "builder",
    reviewer: "code-review",
    git: createReviewGitAdapter({ runner: spawnGitRunner() }),
    process: {
      run: async () => {
        await writeFile(path.join(repoRoot, "other.txt"), "base moved\n");
        git(repoRoot, "add", "other.txt");
        git(repoRoot, "commit", "-m", "move base during review");
        return passReviewResponse();
      },
    },
    nonceProvider: () => reviewNonce,
    merge: true,
    ...authorizedMerge,
  });
  assert.equal(result.reason, "base-drift");
  assert.notEqual(result.currentBaseOid, result.reviewedBaseOid);
  assert.equal(git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(git(repoRoot, "show", "main:owned.txt"), "base");
  assert.equal(git(repoRoot, "show", "main:other.txt"), "base moved");
});

test("real review fails closed when base ref moves during update-ref compare-and-swap", async () => {
  const worktree = await createReviewedWorktreeChange();
  git(repoRoot, "checkout", "--detach", "HEAD");
  let raced = false;
  const runner = spawnGitRunner(async ({ repoRoot: root, args }) => {
    if (!raced && args[0] === "update-ref") {
      raced = true;
      await writeFile(path.join(root, "other.txt"), "raced base move\n");
      git(root, "add", "other.txt");
      git(root, "commit", "-m", "race base before update-ref");
      const racedBaseOid = git(root, "rev-parse", "HEAD");
      git(root, "update-ref", "refs/heads/main", racedBaseOid);
    }
  });
  const result = await runReviewGate({
    repoRoot,
    baseRef: "main",
    headRef: worktree.branch,
    producer: "builder",
    reviewer: "code-review",
    git: createReviewGitAdapter({ runner }),
    process: { run: async () => passReviewResponse() },
    nonceProvider: () => reviewNonce,
    merge: true,
    ...authorizedMerge,
  });
  assert.equal(raced, true);
  assert.equal(result.reason, "merge-failed");
  assert.match(result.error?.message ?? "", /update-ref/);
  assert.equal(git(repoRoot, "show", "main:owned.txt"), "base");
  assert.equal(git(repoRoot, "show", "main:other.txt"), "raced base move");
});

test("real review rolls back when target becomes checked out between pre-CAS check and update-ref", async () => {
  const worktree = await createReviewedWorktreeChange();
  git(repoRoot, "checkout", "--detach", "HEAD");
  const reviewedBaseOid = git(repoRoot, "rev-parse", "refs/heads/main");
  const linkedMainPath = path.join(
    fixtureRoot,
    `raced-linked-main-${process.pid}-${Date.now().toString(16)}`,
  );
  let injectedCheckout = false;
  let updateRefCalls = 0;
  let injectError;
  const runner = spawnGitRunner(async ({ repoRoot: root, args }) => {
    // Inject the checkout after the immediate pre-CAS worktree check and
    // immediately before the first update-ref CAS succeeds.
    if (!injectedCheckout && args[0] === "update-ref") {
      injectedCheckout = true;
      const added = spawnSync(
        "git",
        ["-C", root, "worktree", "add", linkedMainPath, "main"],
        { encoding: "utf8" },
      );
      if (added.status !== 0) {
        injectError = new Error(`worktree inject failed: ${added.stderr || added.stdout}`);
        throw injectError;
      }
    }
    if (args[0] === "update-ref") updateRefCalls += 1;
  });

  const result = await runReviewGate({
    repoRoot,
    baseRef: "main",
    headRef: worktree.branch,
    producer: "builder",
    reviewer: "code-review",
    git: createReviewGitAdapter({ runner }),
    process: { run: async () => passReviewResponse() },
    nonceProvider: () => reviewNonce,
    merge: true,
    ...authorizedMerge,
  });

  assert.equal(injectError, undefined, injectError?.message);
  assert.equal(injectedCheckout, true);
  assert.equal(result.reason, "merge-failed");
  assert.equal(result.error?.code, "CHECKED_OUT_TARGET_RACE", result.error?.message);
  assert.match(result.error?.message ?? "", /became checked out/);
  assert.match(result.error?.message ?? "", /rolled back/);
  assert.equal((result.error?.message ?? "").includes(linkedMainPath), true);
  // Forward CAS + rollback CAS.
  assert.ok(updateRefCalls >= 2, "expected forward update-ref and rollback");
  // Ref restored to the reviewed base; no merge content published.
  assert.equal(git(repoRoot, "rev-parse", "refs/heads/main"), reviewedBaseOid);
  assert.equal(git(repoRoot, "show", "main:owned.txt"), "base");
  // No destructive reset/checkout of either worktree.
  assert.equal(git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
  assert.equal(await readFile(path.join(repoRoot, "owned.txt"), "utf8"), "base\n");
  assert.equal(await readFile(path.join(linkedMainPath, "owned.txt"), "utf8"), "base\n");
  assert.equal(git(repoRoot, "status", "--porcelain"), "");
  assert.equal(git(linkedMainPath, "status", "--porcelain"), "");
});

test("conflicting reviewed merge leaves no MERGE_HEAD or index mutations", async () => {
  const worktree = await createReviewedWorktreeChange({ content: "reviewed branch\n" });
  await writeFile(path.join(repoRoot, "owned.txt"), "main branch\n");
  git(repoRoot, "add", "owned.txt");
  git(repoRoot, "commit", "-m", "main-side conflict");
  git(repoRoot, "checkout", "--detach", "HEAD");
  const indexBefore = git(repoRoot, "write-tree");

  const result = await runReviewGate({
    repoRoot,
    baseRef: "main",
    headRef: worktree.branch,
    producer: "builder",
    reviewer: "code-review",
    git: createReviewGitAdapter({ runner: spawnGitRunner() }),
    process: { run: async () => passReviewResponse() },
    nonceProvider: () => reviewNonce,
    merge: true,
    ...authorizedMerge,
  });
  assert.equal(result.reason, "diff-failed");
  const mergeHead = spawnSync(
    "git",
    ["-C", repoRoot, "rev-parse", "--verify", "MERGE_HEAD"],
    { encoding: "utf8" },
  );
  assert.notEqual(mergeHead.status, 0, "MERGE_HEAD must not be written on conflict");
  assert.equal(git(repoRoot, "write-tree"), indexBefore);
  assert.equal(git(repoRoot, "status", "--porcelain"), "");
  assert.equal(git(repoRoot, "show", "main:owned.txt"), "main branch");
});
