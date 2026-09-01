import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";
import { makeScratchRoot } from "../helpers/scratch.mjs";
import { POSIX_EXECUTABLE_SCRIPT_ONLY } from "../helpers/platform.mjs";
import { EXIT_CODES, main, runCli } from "../../src/cli/main.mjs";

const workRoot = await makeScratchRoot("review-merge-cli");
const originalPath = process.env.PATH;

after(async () => {
  process.env.PATH = originalPath;
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

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * A stand-in reviewer. The gate embeds a fresh nonce in the prompt it passes as
 * a single argv element, so the fake recovers the nonce and returns a correctly
 * fenced verdict. It never inspects the diff: the point of the test is the merge
 * path, not the judgement.
 *
 * Deliberately a shell script rather than Node. The gate runs the reviewer in a
 * locked-down isolated home, and a Node child would inherit `NODE_V8_COVERAGE`
 * under `npm run test:coverage` and fail trying to write a coverage profile
 * there — a property of the harness, not of the product.
 */
const FAKE_REVIEWER = `#!/bin/sh
nonce=$(printf '%s' "$*" | grep -o 'nonce=[A-Za-z0-9_-]*' | head -1 | cut -d= -f2)
if [ -z "$nonce" ]; then
  echo "no nonce in prompt" >&2
  exit 1
fi
printf '<<<TRESTLE_REVIEW nonce=%s>>>\\n%s\\nExact change is acceptable.\\n<<<END_TRESTLE_REVIEW nonce=%s>>>\\n' \\
  "$nonce" "\${TRESTLE_FAKE_VERDICT:-PASS}" "$nonce"
`;

async function reviewableRepo(name, { autoMerge = true, owners = { builder: ["**"] } } = {}) {
  const repoRoot = path.join(workRoot, name);
  await mkdir(repoRoot, { recursive: true });

  const init = capture(repoRoot);
  assert.equal(await runCli(["init", "--json"], init.io), EXIT_CODES.SUCCESS, init.stderr());

  const configPath = path.join(repoRoot, ".trestle", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.permissions.autoMerge = autoMerge;
  await writeFile(configPath, JSON.stringify(config, null, 2));
  await writeFile(
    path.join(repoRoot, "owners.json"),
    JSON.stringify({ version: 1, owners }),
  );

  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.email", "test@example.com");
  git(repoRoot, "config", "user.name", "Test");
  await writeFile(path.join(repoRoot, "owned.txt"), "base\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-qm", "base");

  // Produce the reviewable change on a branch, leaving main checked out
  // elsewhere is unnecessary because the gate refuses a checked-out target;
  // main is switched away from below.
  git(repoRoot, "checkout", "-q", "-b", "topic");
  await writeFile(path.join(repoRoot, "owned.txt"), "reviewed content\n");
  git(repoRoot, "add", "owned.txt");
  git(repoRoot, "commit", "-qm", "reviewed change");

  const binDirectory = path.join(repoRoot, "bin");
  await mkdir(binDirectory, { recursive: true });
  const reviewer = path.join(binDirectory, "copilot");
  await writeFile(reviewer, FAKE_REVIEWER);
  await chmod(reviewer, 0o755);
  process.env.PATH = `${binDirectory}${path.delimiter}${originalPath}`;

  return { repoRoot, headOid: git(repoRoot, "rev-parse", "HEAD") };
}

const REVIEW = ["review", "--base", "main", "--head", "topic", "--producer", "builder", "--reviewer", "code-review"];

test("a gated CLI merge moves exactly the reviewed content", { skip: POSIX_EXECUTABLE_SCRIPT_ONLY }, async () => {
  const { repoRoot, headOid } = await reviewableRepo("merges");
  const baseBefore = git(repoRoot, "rev-parse", "main");

  const invoked = capture(repoRoot);
  const exitCode = await main([
    ...REVIEW, "--merge", "--ownership", "owners.json", "--actor", "builder", "--json",
  ], invoked.io);
  assert.equal(exitCode, EXIT_CODES.SUCCESS, invoked.stderr());

  const payload = JSON.parse(invoked.stdout());
  assert.equal(payload.status, "merged");
  assert.equal(payload.ok, true);
  assert.equal(payload.reviewedHeadOid, headOid);
  assert.match(payload.reviewedDiffHash, /^[a-f0-9]{64}$/);

  // main advanced, and the merge commit's parents are exactly the pinned pair.
  const mergeOid = git(repoRoot, "rev-parse", "main");
  assert.notEqual(mergeOid, baseBefore);
  assert.deepEqual(
    git(repoRoot, "rev-list", "--parents", "-n", "1", mergeOid).split(" ").slice(1),
    [baseBefore, headOid],
  );

  // The merged content is byte-identical to the reviewed content.
  assert.equal(git(repoRoot, "show", "main:owned.txt"), "reviewed content");
  assert.equal(
    git(repoRoot, "rev-parse", `${mergeOid}^{tree}`),
    payload.reviewedMergedTreeOid,
  );

  // Provenance is recorded in the commit message.
  const message = git(repoRoot, "log", "-1", "--format=%B", mergeOid);
  assert.match(message, new RegExp(`Reviewed-diff-sha256: ${payload.reviewedDiffHash}`));

  // The working tree was never touched: topic is still checked out.
  assert.equal(git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD"), "topic");
});

test("an ownership violation blocks the merge and moves nothing", { skip: POSIX_EXECUTABLE_SCRIPT_ONLY }, async () => {
  const { repoRoot } = await reviewableRepo("ownership", { owners: { someone_else: ["**"] } });
  const baseBefore = git(repoRoot, "rev-parse", "main");

  const invoked = capture(repoRoot);
  const exitCode = await main([
    ...REVIEW, "--merge", "--ownership", "owners.json", "--actor", "builder", "--json",
  ], invoked.io);

  assert.equal(exitCode, EXIT_CODES.BLOCKED);
  const payload = JSON.parse(invoked.stdout());
  assert.equal(payload.status, "blocked");
  assert.equal(payload.reason, "ownership-rejected");
  assert.equal(git(repoRoot, "rev-parse", "main"), baseBefore, "a blocked merge must move nothing");
});

test("a frozen reviewer environment survives spawning under coverage", { skip: POSIX_EXECUTABLE_SCRIPT_ONLY }, async () => {
  // Regression: the scrubbed reviewer environment is frozen, and Node injects
  // NODE_V8_COVERAGE into a child's env object at spawn time when the parent
  // runs under coverage. Passing the frozen object straight through threw
  // "Cannot add property NODE_V8_COVERAGE, object is not extensible" and failed
  // every review, which is why this path's coverage could never be measured.
  const { createProcessAdapter } = await import("../../src/review/process-adapter.mjs");
  const adapter = createProcessAdapter();
  const frozen = Object.freeze({ PATH: process.env.PATH });

  const previous = process.env.NODE_V8_COVERAGE;
  process.env.NODE_V8_COVERAGE = path.join(workRoot, "coverage-probe");
  try {
    const result = await adapter.run({
      executable: "printf",
      args: ["frozen-env-ok"],
      options: { env: frozen, cwd: workRoot },
      timeoutMs: 10_000,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "frozen-env-ok");
  } finally {
    if (previous === undefined) delete process.env.NODE_V8_COVERAGE;
    else process.env.NODE_V8_COVERAGE = previous;
  }

  // The caller's frozen object must not have been widened.
  assert.deepEqual(Object.keys(frozen), ["PATH"]);
});

test("a base that moves after approval aborts the merge", async () => {
  const { repoRoot } = await reviewableRepo("base-drift");

  // Advance main between review and merge by driving the gate through a
  // process adapter that mutates the base right after the verdict is produced.
  const { runReviewGate } = await import("../../src/review/gate.mjs");
  const { createReviewGitAdapter } = await import("../../src/review/git-adapter.mjs");
  const { createGitDiffRunner } = await import("../../src/review/process-adapter.mjs");
  const { createOwnershipPolicy } = await import("../../src/ownership/policy.mjs");

  const result = await runReviewGate({
    repoRoot,
    baseRef: "main",
    headRef: "topic",
    producer: "builder",
    reviewer: "code-review",
    git: createReviewGitAdapter({ runner: createGitDiffRunner() }),
    process: {
      async run(command) {
        const prompt = command.args.join(" ");
        const nonce = prompt.match(/nonce=([A-Za-z0-9_-]{16,128})/)[1];
        // The base moves in the window between approval and merge.
        git(repoRoot, "checkout", "-q", "main");
        await writeFile(path.join(repoRoot, "drift.txt"), "drift\n");
        git(repoRoot, "add", "drift.txt");
        git(repoRoot, "commit", "-qm", "drift");
        git(repoRoot, "checkout", "-q", "topic");
        return {
          code: 0,
          stdout: `<<<TRESTLE_REVIEW nonce=${nonce}>>>\nPASS\nok\n<<<END_TRESTLE_REVIEW nonce=${nonce}>>>`,
          stderr: "",
        };
      },
    },
    merge: true,
    permissions: { autoMerge: true },
    ownershipPolicy: createOwnershipPolicy({ owners: { builder: ["**"] } }),
    actor: "builder",
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "base-drift");
  assert.notEqual(result.currentBaseOid, result.reviewedBaseOid);
  // The drift commit is still the tip: nothing was merged on top of it.
  assert.equal(git(repoRoot, "log", "-1", "--format=%s", "main"), "drift");
});
