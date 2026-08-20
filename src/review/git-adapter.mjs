import { createHash } from "node:crypto";
import { createGitDiffRunner } from "./process-adapter.mjs";

function resultCode(result) {
  return result.code ?? result.exitCode;
}

function requireOid(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40,64}$/i.test(value)) {
    throw new Error(`${label} must be an immutable git object ID`);
  }
}

function asHeadsRef(baseRef) {
  if (typeof baseRef !== "string" || baseRef.trim() === "") {
    throw new Error("baseRef must name a local branch");
  }
  if (baseRef.startsWith("refs/heads/")) return baseRef;
  if (baseRef.startsWith("refs/")) {
    throw new Error("baseRef must target refs/heads/*");
  }
  return `refs/heads/${baseRef}`;
}

function oidFromOutput(result, label) {
  const oids = oidsFromOutput(result, label);
  if (oids.length !== 1) {
    throw new Error(`${label} returned multiple immutable object IDs`);
  }
  return oids[0];
}

function oidsFromOutput(result, label) {
  const oids = `${result?.stdout ?? ""}`.trim().split(/\s+/).filter(Boolean);
  if (oids.length === 0 || oids.some((oid) => !/^[a-f0-9]{40,64}$/i.test(oid))) {
    throw new Error(`${label} returned no immutable object IDs`);
  }
  return oids;
}

function changedPathsFromOutput(result) {
  const text = `${result?.stdout ?? ""}`;
  if (text.includes("\0")) return text.split("\0").filter(Boolean);
  return text.split(/\r?\n/).filter(Boolean);
}

function oversized(result, maxBytes) {
  return result?.oversize === true
    || (Number.isFinite(maxBytes) && Buffer.byteLength(result?.stdout ?? "") > maxBytes);
}

function gitError(message, result) {
  const error = new Error(message);
  error.result = result;
  return error;
}

function parseWorktreeList(text) {
  const worktrees = [];
  let current = null;
  const finish = () => {
    if (!current) return;
    if (typeof current.path !== "string" || current.path.length === 0) {
      throw new Error("worktree record is missing its path");
    }
    worktrees.push(current);
    current = null;
  };

  for (const rawLine of `${text ?? ""}`.replace(/\r\n/g, "\n").split("\n")) {
    if (rawLine === "") {
      finish();
      continue;
    }

    const separator = rawLine.indexOf(" ");
    const key = separator === -1 ? rawLine : rawLine.slice(0, separator);
    const value = separator === -1 ? "" : rawLine.slice(separator + 1);
    if (key === "worktree") {
      finish();
      current = { path: value };
      continue;
    }
    if (!current) {
      throw new Error("unexpected data before worktree record");
    }
    if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value;
    else if (key === "bare" || key === "detached") current[key] = true;
    else if (key === "locked" || key === "prunable") current[key] = value || true;
  }

  finish();
  if (worktrees.length === 0) {
    throw new Error("no worktree records were returned");
  }
  return worktrees;
}

async function ensureTargetRefIsUnchecked({ runner, repoRoot, targetRef }) {
  const result = await runner({
    repoRoot,
    args: ["worktree", "list", "--porcelain"],
  });
  if (resultCode(result) !== 0) {
    throw gitError("git worktree list failed", result);
  }

  let worktrees;
  try {
    worktrees = parseWorktreeList(result.stdout);
  } catch (error) {
    const wrapped = new Error(`git worktree list returned malformed porcelain: ${error.message}`);
    wrapped.result = result;
    wrapped.cause = error;
    throw wrapped;
  }

  const blocking = worktrees.find(
    (worktree) => worktree.branch === targetRef && worktree.prunable === undefined,
  );
  if (blocking) {
    const error = new Error(`merge target ${targetRef} is checked out in worktree ${blocking.path}`);
    error.code = "CHECKED_OUT_TARGET";
    error.worktree = blocking;
    throw error;
  }
}

export function createReviewGitAdapter({ runner: injectedRunner, maxDiffBytes = 1024 * 1024 } = {}) {
  if (injectedRunner !== undefined && typeof injectedRunner !== "function") {
    throw new TypeError("runner must implement async ({ repoRoot, args })");
  }
  // Default to a streaming, byte-capped runner so exact diff collection can
  // never buffer an unbounded diff into memory before the size check. An
  // injected runner (tests/CLI) is honoured and capped deterministically below.
  const runner = typeof injectedRunner === "function" ? injectedRunner : createGitDiffRunner();
  const runDiff = async ({ repoRoot, baseRef, headRef, maxBytes = Infinity }) => {
    const mergeBases = await runner({
      repoRoot,
      args: ["merge-base", "--all", baseRef, headRef],
    });
    if (resultCode(mergeBases) !== 0) {
      throw gitError("git merge-base failed", mergeBases);
    }
    const bases = oidsFromOutput(mergeBases, "git merge-base");
    if (bases.length !== 1) {
      const error = new Error("review requires a single merge base");
      error.code = "MULTIPLE_MERGE_BASES";
      error.mergeBases = bases;
      throw error;
    }

    const mergeTree = await runner({
      repoRoot,
      args: ["merge-tree", "--write-tree", baseRef, headRef],
    });
    if (resultCode(mergeTree) !== 0) {
      throw gitError("git merge-tree failed", mergeTree);
    }
    const mergedTreeOid = oidFromOutput(mergeTree, "merged tree");

    const result = await runner({
      repoRoot,
      maxBytes,
      args: [
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        baseRef,
        mergedTreeOid,
      ],
    });
    const text = result.stdout ?? "";
    // A streaming runner reports oversize directly; a plain buffering runner is
    // measured here so the outcome is deterministic ("oversized") regardless of
    // which transport produced the diff.
    const oversize = oversized(result, maxBytes);
    if (!oversize && resultCode(result) !== 0) {
      const error = new Error("git diff failed");
      error.result = result;
      throw error;
    }
    if (oversize) {
      return { text, oversize: true, mergedTreeOid, changedPaths: [] };
    }

    const names = await runner({
      repoRoot,
      // Rename detection reports only the destination with --name-only. The
      // ownership check must see both sides of a rename, so disable it for the
      // name-only query and receive the delete/add paths instead.
      args: [
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        baseRef,
        mergedTreeOid,
      ],
    });
    if (resultCode(names) !== 0) {
      throw gitError("git changed-path query failed", names);
    }
    return {
      text,
      mergedTreeOid,
      changedPaths: changedPathsFromOutput(names),
    };
  };
  return {
    async resolveRef({ repoRoot, ref }) {
      const result = await runner({
        repoRoot,
        args: ["rev-parse", "--verify", `${ref}^{commit}`],
      });
      if (resultCode(result) !== 0) {
        const error = new Error(`git could not resolve ${ref}`);
        error.result = result;
        throw error;
      }
      const oid = result.stdout.trim();
      requireOid(oid, "resolved ref");
      return oid;
    },
    diff: ({ repoRoot, baseRef, headRef }) =>
      runDiff({ repoRoot, baseRef, headRef, maxBytes: maxDiffBytes }),
    async merge({
      repoRoot,
      baseRef,
      reviewedBaseOid,
      reviewedHeadOid,
      expectedDiffHash,
      expectedMergedTreeOid,
      expectedChangedPaths,
    }) {
      const targetRef = asHeadsRef(baseRef);
      requireOid(reviewedBaseOid, "reviewedBaseOid");
      requireOid(reviewedHeadOid, "reviewedHeadOid");
      if (!/^[a-f0-9]{64}$/i.test(expectedDiffHash ?? "")) {
        throw new Error("merge requires an exact reviewed diff hash");
      }

      const diff = await runDiff({
        repoRoot,
        baseRef: reviewedBaseOid,
        headRef: reviewedHeadOid,
        maxBytes: maxDiffBytes,
      });
      if (diff.oversize) {
        throw new Error("reviewed diff exceeds the configured size limit");
      }
      const actualDiffHash = createHash("sha256").update(diff.text).digest("hex");
      if (actualDiffHash !== expectedDiffHash) {
        throw new Error("reviewed diff hash does not match pinned commits");
      }
      if (expectedMergedTreeOid && diff.mergedTreeOid !== expectedMergedTreeOid) {
        throw new Error("reviewed merge tree does not match pinned commits");
      }
      if (
        expectedChangedPaths
        && JSON.stringify(diff.changedPaths) !== JSON.stringify(expectedChangedPaths)
      ) {
        throw new Error("reviewed changed paths do not match pinned commits");
      }

      // Fail fast before building the merge commit when the target is already
      // checked out. The authoritative race window is closed around CAS below.
      await ensureTargetRefIsUnchecked({ runner, repoRoot, targetRef });

      const mergeTree = await runner({
        repoRoot,
        args: ["merge-tree", "--write-tree", reviewedBaseOid, reviewedHeadOid],
      });
      if (resultCode(mergeTree) !== 0) {
        throw gitError("git merge-tree failed", mergeTree);
      }
      const mergedTreeOid = oidFromOutput(mergeTree, "merged tree");
      if (diff.mergedTreeOid !== mergedTreeOid) {
        throw new Error("merge tree changed after review");
      }

      const commitTree = await runner({
        repoRoot,
        args: [
          "commit-tree",
          mergedTreeOid,
          "-p",
          reviewedBaseOid,
          "-p",
          reviewedHeadOid,
          "-m",
          `Merge reviewed ${reviewedHeadOid} into ${targetRef}\n\nReviewed-base: ${reviewedBaseOid}\nReviewed-head: ${reviewedHeadOid}\nReviewed-diff-sha256: ${expectedDiffHash}`,
        ],
      });
      if (resultCode(commitTree) !== 0) {
        throw gitError("git commit-tree failed", commitTree);
      }
      const mergeCommitOid = oidFromOutput(commitTree, "merge commit");

      // Immediate pre-CAS check: close the window between the earlier check and
      // update-ref so a concurrent checkout is observed before the ref moves.
      await ensureTargetRefIsUnchecked({ runner, repoRoot, targetRef });

      const result = await runner({
        repoRoot,
        args: ["update-ref", "-m", "trestle reviewed merge", targetRef, mergeCommitOid, reviewedBaseOid],
      });
      if (resultCode(result) !== 0) {
        throw gitError("git update-ref failed", result);
      }

      // Immediate post-CAS check: if the target became checked out in the race
      // between pre-CAS and CAS, roll the ref back atomically and fail closed.
      // Never reset/checkout the worktree — only move the ref via CAS.
      try {
        await ensureTargetRefIsUnchecked({ runner, repoRoot, targetRef });
      } catch (error) {
        if (error?.code !== "CHECKED_OUT_TARGET") throw error;
        const rollback = await runner({
          repoRoot,
          args: [
            "update-ref",
            "-m",
            "trestle reviewed merge rollback",
            targetRef,
            reviewedBaseOid,
            mergeCommitOid,
          ],
        });
        if (resultCode(rollback) !== 0) {
          const fatal = gitError(
            `merge target ${targetRef} became checked out after update-ref; rollback to ${reviewedBaseOid} failed`,
            rollback,
          );
          fatal.code = "MERGE_ROLLBACK_FAILED";
          fatal.cause = error;
          fatal.worktree = error.worktree;
          fatal.mergeCommitOid = mergeCommitOid;
          throw fatal;
        }
        const raced = new Error(
          `merge target ${targetRef} became checked out in worktree ${error.worktree?.path ?? "(unknown)"} after update-ref; rolled back to ${reviewedBaseOid}`,
        );
        raced.code = "CHECKED_OUT_TARGET_RACE";
        raced.worktree = error.worktree;
        raced.cause = error;
        raced.mergeCommitOid = mergeCommitOid;
        throw raced;
      }

      return {
        ...result,
        targetRef,
        mergeCommitOid,
      };
    },
  };
}
