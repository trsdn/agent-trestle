import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { assertAutoMergeAllowed } from "../config/permissions.mjs";
import { assertOwnership } from "../ownership/policy.mjs";
import {
  buildReadOnlyReviewerCommand,
  cleanupReviewerHome,
  createReviewerHome,
  prepareReviewerAgent,
} from "./command.mjs";
import {
  SAFE_ARG_BYTES,
  sanitizeProcessError,
  sanitizeProcessResult,
} from "./process-adapter.mjs";
import { createReviewPrompt, parseReviewResponse } from "./protocol.mjs";

function digest(diff) {
  return createHash("sha256").update(diff).digest("hex");
}

function requireAdapter(adapter, method, label) {
  if (!adapter || typeof adapter[method] !== "function") {
    throw new TypeError(`${label} adapter must implement ${method}()`);
  }
}

function requireSafeRef(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("-") ||
    /[\s~^:?*[\]\\]/.test(value) ||
    value.includes("..") ||
    value.includes("@{")
  ) {
    throw new Error(`${label} is not a safe git ref`);
  }
}

async function exactDiff(git, repoRoot, baseRef, headRef) {
  const result = await git.diff({ repoRoot, baseRef, headRef });
  const text = typeof result === "string" ? result : result?.text;
  if (typeof text !== "string") throw new Error("git diff adapter returned no text");
  const oversize = result?.oversize === true;
  return {
    text,
    oversize,
    hash: oversize ? null : digest(text),
    ...(result?.mergedTreeOid ? { mergedTreeOid: result.mergedTreeOid } : {}),
    ...(Array.isArray(result?.changedPaths) ? { changedPaths: [...result.changedPaths] } : {}),
  };
}

export async function runReviewGate({
  repoRoot,
  baseRef,
  headRef,
  producer,
  reviewer,
  git,
  process,
  attempts = 1,
  timeoutMs = 120_000,
  maxDiffBytes = 1024 * 1024,
  maxOutputBytes = 64 * 1024,
  maxPromptBytes = SAFE_ARG_BYTES,
  nonceProvider = () => randomBytes(18).toString("base64url"),
  commandBuilder = buildReadOnlyReviewerCommand,
  reviewerHomeFactory = createReviewerHome,
  reviewerHomeCleanup = cleanupReviewerHome,
  reviewerAgentPreparer = prepareReviewerAgent,
  override = null,
  merge = false,
  permissions,
  ownershipPolicy,
  actor,
} = {}) {
  if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot)) {
    throw new TypeError("repoRoot must be an absolute path");
  }
  if (!producer || !reviewer) throw new TypeError("producer and reviewer are required");
  if (producer === reviewer) throw new Error("reviewer must differ from producer");
  requireSafeRef(baseRef, "baseRef");
  requireSafeRef(headRef, "headRef");
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError("attempts must be a positive integer");
  }
  requireAdapter(git, "diff", "git");
  requireAdapter(git, "resolveRef", "git");
  requireAdapter(process, "run", "process");
  if (merge) requireAdapter(git, "merge", "git");
  if (typeof reviewerHomeFactory !== "function") {
    throw new TypeError("reviewerHomeFactory must be a function");
  }
  if (typeof reviewerHomeCleanup !== "function") {
    throw new TypeError("reviewerHomeCleanup must be a function");
  }
  if (typeof reviewerAgentPreparer !== "function") {
    throw new TypeError("reviewerAgentPreparer must be a function");
  }

  let reviewedBaseOid;
  let reviewedHeadOid;
  let reviewedDiff;
  try {
    [reviewedBaseOid, reviewedHeadOid] = await Promise.all([
      git.resolveRef({ repoRoot, ref: baseRef }),
      git.resolveRef({ repoRoot, ref: headRef }),
    ]);
    reviewedDiff = await exactDiff(
      git,
      repoRoot,
      reviewedBaseOid,
      reviewedHeadOid,
    );
  } catch (error) {
    return closed("diff-failed", error);
  }
  if (reviewedDiff.oversize) return closed("oversized-diff");
  if (reviewedDiff.text.trim() === "") return closed("empty-diff");
  if (Buffer.byteLength(reviewedDiff.text) > maxDiffBytes) {
    return closed("oversized-diff");
  }

  const reviews = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const nonce = nonceProvider();
    let reviewPrompt = "";
    try {
      reviewPrompt = createReviewPrompt({
        nonce,
        producer,
        diff: reviewedDiff.text,
      });
      // The reviewer prompt is passed as a single argv element; keep it below
      // the OS per-argument ceiling so an oversized diff fails deterministically
      // here instead of raising E2BIG when the reviewer is launched.
      if (Buffer.byteLength(reviewPrompt) > maxPromptBytes) {
        return closed("oversized-diff");
      }
      const execution = await (async () => {
        const reviewerHome = await reviewerHomeFactory();
        try {
          // Discover a project-defined custom reviewer agent (or confirm a
          // builtin) and fail closed before anything is spawned if it is
          // neither - see prepareReviewerAgent for the full contract.
          await reviewerAgentPreparer({ repoRoot, reviewer, reviewerHome });
          const command = commandBuilder({
            reviewer,
            prompt: reviewPrompt,
            cwd: reviewerHome,
            repoRoot,
            reviewerHome,
          });
          if (command?.options?.readOnly !== true || command?.options?.shell !== false) {
            return { unsafe: true };
          }
          return {
            result: await process.run(command, { timeoutMs, maxOutputBytes }),
          };
        } finally {
          // The process adapter settles only after the child has closed (or
          // its bounded settlement backstop fires), so cleanup cannot race a
          // live reviewer.
          await reviewerHomeCleanup(reviewerHome);
        }
      })();
      if (execution.unsafe) {
        return closed("unsafe-reviewer-command");
      }
      const { result } = execution;
      if (result?.code !== 0) {
        reviews.push({
          attempt,
          status: "crash",
          result: sanitizeProcessResult(result, reviewPrompt),
        });
        continue;
      }
      const parsed = parseReviewResponse(result.stdout, { nonce, maxBytes: maxOutputBytes });
      reviews.push({ attempt, status: "parsed", ...parsed });
      if (parsed.decision === "PASS") {
        if (!merge) {
          return {
            status: "passed",
            mergeAllowed: true,
            reviewedDiffHash: reviewedDiff.hash,
            reviewedBaseOid,
            reviewedHeadOid,
            reviewedMergedTreeOid: reviewedDiff.mergedTreeOid,
            reviewedChangedPaths: reviewedDiff.changedPaths,
            review: parsed,
            reviews,
          };
        }
        try {
          assertAutoMergeAllowed(permissions);
        } catch (error) {
          return closed("auto-merge-unauthorized", error, reviews);
        }
        if (!ownershipPolicy || typeof actor !== "string" || actor.trim() === "") {
          return closed(
            "ownership-policy-required",
            new Error("automatic merge requires an ownership policy and actor"),
            reviews,
          );
        }
        if (!Array.isArray(reviewedDiff.changedPaths)) {
          return closed(
            "changed-paths-unavailable",
            new Error("automatic merge requires exact merged-tree changed paths"),
            reviews,
          );
        }
        try {
          assertOwnership(ownershipPolicy, actor, reviewedDiff.changedPaths);
        } catch (error) {
          return closed("ownership-rejected", error, reviews);
        }
        let currentBaseOid;
        try {
          currentBaseOid = await git.resolveRef({ repoRoot, ref: baseRef });
        } catch (error) {
          return closed("pre-merge-base-failed", error, reviews);
        }
        if (currentBaseOid !== reviewedBaseOid) {
          return {
            status: "blocked",
            reason: "base-drift",
            mergeAllowed: false,
            reviewedDiffHash: reviewedDiff.hash,
            reviewedBaseOid,
            currentBaseOid,
            reviewedHeadOid,
            reviewedMergedTreeOid: reviewedDiff.mergedTreeOid,
            reviewedChangedPaths: reviewedDiff.changedPaths,
            reviews,
          };
        }
        try {
          await git.merge({
            repoRoot,
            baseRef,
            reviewedBaseOid,
            reviewedHeadOid,
            expectedDiffHash: reviewedDiff.hash,
            expectedMergedTreeOid: reviewedDiff.mergedTreeOid,
            expectedChangedPaths: reviewedDiff.changedPaths,
          });
        } catch (error) {
          return closed("merge-failed", error, reviews);
        }
        return {
          status: "merged",
          mergeAllowed: true,
          reviewedDiffHash: reviewedDiff.hash,
          reviewedBaseOid,
          reviewedHeadOid,
          reviewedMergedTreeOid: reviewedDiff.mergedTreeOid,
          reviewedChangedPaths: reviewedDiff.changedPaths,
          review: parsed,
          reviews,
        };
      }
    } catch (error) {
      reviews.push({
        attempt,
        status: "invalid",
        error: sanitizeProcessError(error, reviewPrompt),
      });
    }
  }

  if (override) {
    const accepted =
      typeof override === "function"
        ? await override({ producer, reviewer, reviews, diffHash: reviewedDiff.hash })
        : override;
    if (accepted?.allowed === true && accepted.actor && accepted.reason) {
      return {
        status: "overridden",
        reason: accepted.reason,
        actor: accepted.actor,
        mergeAllowed: false,
        reviewedDiffHash: reviewedDiff.hash,
        reviewedBaseOid,
        reviewedHeadOid,
        reviews,
      };
    }
  }
  return {
    status: "blocked",
    reason: reviews.at(-1)?.decision?.toLowerCase() ?? "review-failed",
    mergeAllowed: false,
    reviewedDiffHash: reviewedDiff.hash,
    reviewedBaseOid,
    reviewedHeadOid,
    reviews,
  };
}

function closed(reason, error, reviews = []) {
  return {
    status: "blocked",
    reason,
    mergeAllowed: false,
    error,
    reviews,
  };
}
