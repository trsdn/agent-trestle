import path from "node:path";
import { createWorktreeFleet } from "../worktrees/fleet.mjs";
import { createGitProcessAdapter } from "../worktrees/git-adapter.mjs";

/**
 * `.gitignore` already reserves this path, so an isolated run leaves no
 * untracked noise in the operator's checkout.
 */
export function defaultWorktreeRoot(projectRoot) {
  return path.resolve(projectRoot, ".trestle", "worktrees");
}

const COMMIT_NAME = "Agent Trestle";
const COMMIT_EMAIL = "agent-trestle@localhost";

/**
 * Commits whatever the agent produced onto the task's own branch.
 *
 * Nothing else in the run path commits, so a task that did real work leaves an
 * unclean checkout, and `git worktree remove` refuses those outright ("contains
 * modified or untracked files, use --force to delete it"). Forcing instead
 * would silently discard the agent's output, which is the only thing the run
 * produced. Committing keeps the work on the branch that deliberately outlives
 * the worktree, which is what `review` later gates on.
 */
async function commitTaskWork(git, worktree) {
  const status = await git.run({ repoRoot: worktree.path, args: ["status", "--porcelain"] });
  if (status.stdout.trim() === "") return { committed: false };
  await git.run({ repoRoot: worktree.path, args: ["add", "--all"] });
  await git.run({
    repoRoot: worktree.path,
    // Identity is pinned inline so the commit never depends on the operator's
    // global git config, and hooks are skipped so a local hook cannot block or
    // rewrite agent output during teardown.
    args: [
      "-c", `user.name=${COMMIT_NAME}`,
      "-c", `user.email=${COMMIT_EMAIL}`,
      "commit", "--no-verify", "--message", `trestle: ${worktree.id} task output`,
    ],
  });
  const head = await git.run({ repoRoot: worktree.path, args: ["rev-parse", "HEAD"] });
  return { committed: true, commit: head.stdout.trim() };
}

/**
 * Binds worktree lifetime to the work that runs inside it.
 *
 * Success and failure paths differ deliberately: a completed task's worktree is
 * removed, while a failed task's is retained through the fleet's existing
 * `outcome: "failed"` path so the operator can inspect what the agent actually
 * produced. Retention is the more surprising behaviour, so it is the one the
 * result reports explicitly.
 */
export function createTaskWorktrees({
  projectRoot,
  repoRoot = projectRoot,
  worktreeRoot,
  fleet,
  git = createGitProcessAdapter(),
} = {}) {
  const root = worktreeRoot ?? defaultWorktreeRoot(projectRoot);
  const pool = fleet ?? createWorktreeFleet({ repoRoot, worktreeRoot: root, git });
  const live = new Map();

  return {
    worktreeRoot: root,
    async acquire(taskKey, { startPoint = "HEAD" } = {}) {
      const worktree = await pool.create({ id: taskKey, startPoint });
      live.set(taskKey, worktree);
      return worktree;
    },
    /**
     * Releases one worktree. A failed task keeps its checkout; the per-run
     * branch stays behind either way so `review` has a head ref to gate on.
     */
    async release(taskKey, { failed = false } = {}) {
      const worktree = live.get(taskKey);
      if (!worktree) return null;
      if (failed) {
        live.delete(taskKey);
        return pool.remove(worktree, { outcome: "failed" });
      }
      const work = await commitTaskWork(git, worktree);
      // Safe to force once the work is committed: it now only covers ignored or
      // regenerated files, and stops a stray artefact from failing teardown.
      const removed = await pool.remove(worktree, { force: true });
      // Dropped from `live` only after removal actually succeeded. Deleting it
      // first made a failed removal invisible to releaseAll() and immune to
      // prune(), stranding the checkout with no record of it.
      live.delete(taskKey);
      return { ...removed, ...work };
    },
    /**
     * Tears down everything still held. Called on interruption so an aborted
     * run strands no worktrees. Individual failures are collected rather than
     * thrown, because a teardown that stops halfway would strand the rest, and
     * `prune` reconciles whatever Git still believes exists.
     */
    async releaseAll({ failed = false } = {}) {
      const released = [];
      const errors = [];
      for (const taskKey of [...live.keys()]) {
        try {
          released.push(await this.release(taskKey, { failed }));
        } catch (error) {
          errors.push({ taskKey, message: error.message });
        }
      }
      try {
        await pool.prune();
      } catch (error) {
        errors.push({ taskKey: null, message: error.message });
      }
      return { released, errors };
    },
  };
}
