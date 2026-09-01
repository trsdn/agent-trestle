import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { makeScratchRoot } from "../helpers/scratch.mjs";
import { POSIX_EXECUTABLE_SCRIPT_ONLY } from "../helpers/platform.mjs";

const execFileAsync = promisify(execFile);
const workRoot = await makeScratchRoot("scratch-helper");
const repoRoot = path.resolve(import.meta.dirname, "../..");

after(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

test("scratch roots are unique per call", async () => {
  const roots = await Promise.all(
    Array.from({ length: 8 }, () => makeScratchRoot("uniqueness")),
  );
  assert.equal(new Set(roots).size, roots.length);
});

/**
 * Regression test. The stale-root purge inspects directories owned by other
 * worker processes, which may delete their own containers at exit. If any
 * per-entry error escaped the purge, the memoized purge promise rejected and
 * every later `makeScratchRoot` call in that worker threw, failing the whole
 * test file at module load rather than at an assertion. Purging is best effort
 * and must never fail a run.
 */
test("concurrent workers creating and reclaiming scratch roots never fail each other", { skip: POSIX_EXECUTABLE_SCRIPT_ONLY }, async () => {
  const script = path.join(workRoot, "worker.mjs");
  await writeFile(script, [
    `import { makeScratchRoot } from ${JSON.stringify(path.join(repoRoot, "test/helpers/scratch.mjs"))};`,
    "for (let i = 0; i < 4; i += 1) await makeScratchRoot(`race-${i}`);",
    "process.exit(0);",
  ].join("\n"));

  // Enough overlapping processes that at least one purge observes another
  // worker's container being removed by its exit handler.
  const workers = await Promise.all(Array.from({ length: 8 }, () =>
    execFileAsync(process.execPath, [script], { cwd: repoRoot })
      .then(() => ({ ok: true }), (error) => ({ ok: false, error }))));

  const failed = workers.filter((worker) => !worker.ok);
  assert.deepEqual(
    failed.map((worker) => String(worker.error.stderr || worker.error.message)),
    [],
    "no worker may fail because another worker reclaimed a scratch root",
  );
});

test("a stale root owned by a dead process is reclaimed", { skip: POSIX_EXECUTABLE_SCRIPT_ONLY }, async () => {
  const scratchBase = path.resolve(repoRoot, "test/.work/.scratch");
  // PID 2^22 + 1 is above the maximum PID on Linux and macOS, so it can never
  // identify a live process.
  const stale = path.join(scratchBase, `stale-reclaim-${Date.now()}-deadowner`);
  await mkdir(stale, { recursive: true });
  await writeFile(path.join(stale, ".owner.json"), JSON.stringify({
    host: (await import("node:os")).hostname().replace(/[^a-zA-Z0-9.-]/g, "_"),
    pid: 4_194_305,
    createdAt: new Date().toISOString(),
  }));

  const script = path.join(workRoot, "reclaim.mjs");
  await writeFile(script, [
    `import { makeScratchRoot } from ${JSON.stringify(path.join(repoRoot, "test/helpers/scratch.mjs"))};`,
    "await makeScratchRoot('reclaim');",
    `import('node:fs').then(({ existsSync }) => {`,
    `  process.stdout.write(existsSync(${JSON.stringify(stale)}) ? 'present' : 'reclaimed');`,
    "  process.exit(0);",
    "});",
  ].join("\n"));

  const { stdout } = await execFileAsync(process.execPath, [script], { cwd: repoRoot });
  assert.equal(stdout.trim(), "reclaimed");
});
