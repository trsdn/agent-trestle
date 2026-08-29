import { createHash } from "node:crypto";
import { createWorkSignatureProvider } from "../scheduler/work-signature.mjs";
import { createGitProcessAdapter } from "../worktrees/git-adapter.mjs";

/**
 * Work signatures drive the scheduler's no-op convergence stop. A task that
 * produced no observable change is not making progress, so the signature must
 * reflect committed state and working-tree state together: an agent that only
 * commits, or only edits untracked files, must still register as progress.
 *
 * Git is the source of truth rather than a filesystem walk because every
 * workstream this project dispatches into is a Git checkout, and `git status`
 * already applies the repository's own ignore rules. A raw directory scan would
 * otherwise churn the signature on build output and `.trestle/` runtime data.
 */
export function createGitWorkSignatureProvider({
  repoRoot,
  git = createGitProcessAdapter(),
  timeoutMs = 30_000,
} = {}) {
  if (typeof repoRoot !== "string" || repoRoot.trim() === "") {
    throw new TypeError("repoRoot must be an explicit path");
  }
  return createWorkSignatureProvider(async () => {
    const head = await readGit(git, repoRoot, ["rev-parse", "HEAD"], timeoutMs);
    // -z keeps paths NUL-separated, so a filename containing a newline or a
    // quote cannot forge a status boundary and mask a change.
    const status = await readGit(
      git,
      repoRoot,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      timeoutMs,
    );
    return createHash("sha256")
      .update(head, "utf8")
      .update("\u0000", "utf8")
      .update(status, "utf8")
      .digest("hex");
  });
}

async function readGit(git, repoRoot, args, timeoutMs) {
  try {
    const { stdout } = await git.run({ repoRoot, args, timeoutMs });
    return stdout;
  } catch (error) {
    const failure = new Error(
      `Cannot read a work signature from ${repoRoot}: git ${args[0]} failed. `
      + "Declare stop conditions only for workstreams backed by a Git checkout, "
      + "or inject an explicit workSignatureProvider.",
      { cause: error },
    );
    failure.code = "WORK_SIGNATURE_UNAVAILABLE";
    throw failure;
  }
}
