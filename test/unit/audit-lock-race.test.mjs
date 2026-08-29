import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, resolve } from "node:path";
import { after, test } from "node:test";
import { makeScratchRoot } from "../helpers/scratch";
import { createAuditSegmentWriter, reconcileAuditTask } from "../../src/audit/audit.mjs";

// Regression coverage for the stale-lock reclaim race: the old design read a
// lock, judged it stale, then renamed it away. Between the read and the rename a
// second recoverer could win, delete the stale lock, and create a fresh *live*
// lock at the same path — which the first recoverer's rename then stole, giving
// two writers the same segment and corrupting it. The redesign never reclaims:
// on a stale lock a writer rolls over to a brand-new, exclusively-owned segment
// (atomic `wx` create) and leaves the abandoned lock/segment intact.

const workRoot = await makeScratchRoot("audit-lock-race");
const HOST = hostname();
const CONCURRENCY = 30; // > 25 concurrent appends targeting one logical writer
const ROUNDS = 6; // repeated, to shake out timing-dependent corruption

after(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

function makeWriter(auditRoot, segmentId, overrides = {}) {
  return createAuditSegmentWriter({
    auditRoot,
    runId: "run-1",
    taskId: "task-1",
    writerId: "writer-a",
    idGenerator: () => segmentId,
    ...overrides,
  });
}

async function segmentFiles(auditRoot) {
  const dir = resolve(auditRoot, "runs", "run-1", "tasks", "task-1", "segments");
  const names = await readdir(dir);
  return names.filter((name) => name.endsWith(".ndjson")).sort();
}

function eventKey(record) {
  const event = record.event;
  return event.crashed !== undefined ? `crashed:${event.crashed}` : `live:${event.live}`;
}

test(`repeatedly: ${CONCURRENCY} concurrent appends over a seeded stale lock all fulfil and reconcile`, { concurrency: false }, async () => {
  const roundsRoot = resolve(workRoot, "rounds");
  await rm(roundsRoot, { recursive: true, force: true });
  await mkdir(roundsRoot, { recursive: true });
  for (let round = 0; round < ROUNDS; round += 1) {
    const auditRoot = resolve(roundsRoot, `round-${round}`);

    // A crashed writer leaves behind a VALID segment (two records) plus a stale
    // lock on it (dead PID => stale independent of the staleness window). This is
    // the "abandoned segment preserved for reconciliation/forensics" fixture.
    const crashed = makeWriter(auditRoot, "seg-crashed");
    await crashed.append({ crashed: 0 });
    await crashed.append({ crashed: 1 });
    await writeFile(
      crashed.lockPath,
      JSON.stringify({ token: "crashed", pid: 424242, host: HOST, epoch: Date.now() }),
    );

    // CONCURRENCY writers all target the SAME logical writer and SAME home
    // segment/lock as the crashed one.
    const expected = new Set(["crashed:0", "crashed:1"]);
    const writers = Array.from({ length: CONCURRENCY }, (_, index) => {
      expected.add(`live:${round}:${index}`);
      return makeWriter(auditRoot, "seg-crashed", { isProcessAlive: () => false });
    });

    // Fire them all at once. Every append must fulfil on its own fresh segment.
    const results = await Promise.allSettled(
      writers.map((audit, index) => audit.append({ live: `${round}:${index}` })),
    );
    for (const [index, result] of results.entries()) {
      assert.equal(
        result.status,
        "fulfilled",
        `writer ${index} rejected: ${result.reason?.stack ?? result.reason}`,
      );
      assert.equal(result.value.sequence, 1, `writer ${index} must open a fresh segment at sequence 1`);
    }

    // Concurrent recoverers each chose a DISTINCT recovery segment: exactly one
    // file per rolled-over writer, plus the preserved crashed segment.
    const files = await segmentFiles(auditRoot);
    assert.equal(files.length, CONCURRENCY + 1, `round ${round}: expected ${CONCURRENCY + 1} distinct segments, got ${files.length}`);
    assert.equal(new Set(files).size, files.length, "segment filenames must be unique");

    // Reconciliation verifies every segment (throws on any broken chain) and
    // returns EVERY record — the two abandoned ones and all live ones.
    const { records, segments } = await reconcileAuditTask({ auditRoot, runId: "run-1", taskId: "task-1" });
    assert.equal(segments.length, CONCURRENCY + 1);
    for (const segment of segments) assert.equal(segment.ok, true);
    assert.equal(records.length, CONCURRENCY + 2);
    assert.deepEqual(new Set(records.map(eventKey)), expected);
  }
});

test("concurrent appends on a live home lock serialize into one segment (live lock respected)", { concurrency: false }, async () => {
  const auditRoot = resolve(workRoot, "live");
  await rm(auditRoot, { recursive: true, force: true });
  await mkdir(auditRoot, { recursive: true });
  const writers = Array.from({ length: CONCURRENCY }, () =>
    makeWriter(auditRoot, "seg-live", { lockTimeoutMs: 60_000 }));

  const results = await Promise.all(writers.map((audit, index) => audit.append({ index })));
  assert.equal(results.length, CONCURRENCY);

  // No writer rolled over — a live lock is waited on, never stolen or forked.
  const files = await segmentFiles(auditRoot);
  assert.equal(files.length, 1);

  const { records, segments } = await reconcileAuditTask({ auditRoot, runId: "run-1", taskId: "task-1" });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].ok, true);
  assert.equal(records.length, CONCURRENCY);
  assert.deepEqual(
    records.map((record) => record.sequence).sort((left, right) => left - right),
    Array.from({ length: CONCURRENCY }, (_, index) => index + 1),
  );
});

test("a permanently held stale lock never causes DoS and rollover is sticky per writer", { concurrency: false }, async () => {
  const auditRoot = resolve(workRoot, "dos");
  await rm(auditRoot, { recursive: true, force: true });
  await mkdir(auditRoot, { recursive: true });
  const audit = makeWriter(auditRoot, "seg-stuck", { isProcessAlive: () => false });
  await mkdir(audit.segmentDirectory, { recursive: true });
  const stuckLock = audit.lockPath;
  await writeFile(stuckLock, JSON.stringify({ token: "stuck", pid: 424242, host: HOST, epoch: Date.now() }));

  const first = await audit.append({ n: 0 });
  assert.equal(first.sequence, 1);
  const rolledSegment = audit.segmentPath;
  assert.notEqual(rolledSegment, resolve(audit.segmentDirectory, "writer-a--seg-stuck.ndjson"));

  // Subsequent appends must reuse the adopted segment (chain continues), proving
  // the writer routes around the stuck lock indefinitely without wedging.
  for (let n = 1; n < 10; n += 1) {
    const record = await audit.append({ n });
    assert.equal(record.sequence, n + 1);
    assert.equal(audit.segmentPath, rolledSegment);
  }

  // The stuck lock was never touched, and only the single rolled segment holds data.
  assert.equal(JSON.parse(await readFile(stuckLock, "utf8")).token, "stuck");
  assert.equal((await audit.verify()).records, 10);
  const files = await segmentFiles(auditRoot);
  assert.deepEqual(files, [basename(rolledSegment)]);
});
