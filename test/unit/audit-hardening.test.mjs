import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { makeScratchRoot } from "../helpers/scratch.mjs";
import { after, beforeEach, test } from "node:test";
import { createAuditSegmentWriter, reconcileAuditTask } from "../../src/audit/audit.mjs";

const workRoot = await makeScratchRoot("audit-hardening");
const HOST = hostname();

beforeEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
  await mkdir(workRoot, { recursive: true });
});

after(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

function writer(auditRoot, overrides = {}) {
  return createAuditSegmentWriter({
    auditRoot,
    runId: "run-1",
    taskId: "task-1",
    writerId: "writer-a",
    idGenerator: () => "segment-a",
    clock: () => new Date("2026-08-14T10:00:00.000Z"),
    ...overrides,
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function seedLock(auditWriter, info) {
  await mkdir(auditWriter.segmentDirectory, { recursive: true });
  await writeFile(auditWriter.lockPath, JSON.stringify(info));
}

test("rejects an audit root that is itself a symlink", { concurrency: false }, async () => {
  const realRoot = resolve(workRoot, "real-root");
  const linkRoot = resolve(workRoot, "link-root");
  await mkdir(realRoot, { recursive: true });
  await symlink(realRoot, linkRoot);
  await assert.rejects(writer(linkRoot).append({ type: "start" }), /symbolic link/i);
});

test("rejects an audit root reached through a symlinked ancestor", { concurrency: false }, async () => {
  const realParent = resolve(workRoot, "real-parent");
  const linkParent = resolve(workRoot, "link-parent");
  await mkdir(realParent, { recursive: true });
  await symlink(realParent, linkParent);
  const auditRoot = resolve(linkParent, "audit");
  await assert.rejects(writer(auditRoot).append({ type: "start" }), /symbolic link/i);
});

test("rejects a segment directory swapped for a symlink (no-follow containment)", { concurrency: false }, async () => {
  const auditRoot = resolve(workRoot, "audit");
  const outside = resolve(workRoot, "outside");
  await mkdir(outside, { recursive: true });
  const audit = writer(auditRoot);
  // Pre-build the segment path but replace the leaf `segments` with a symlink.
  await mkdir(resolve(auditRoot, "runs", "run-1", "tasks", "task-1"), { recursive: true });
  await symlink(outside, audit.segmentDirectory);
  await assert.rejects(audit.append({ type: "start" }), /symbolic link/i);
  // The write must not have escaped into the symlink target.
  assert.equal(await exists(resolve(outside, "writer-a--segment-a.ndjson")), false);
});

test("rolls over past a crashed writer's stale lock (dead PID) without stealing or DoS", { concurrency: false }, async () => {
  const auditRoot = resolve(workRoot, "audit");
  const audit = writer(auditRoot, { isProcessAlive: () => false });
  const abandonedLock = audit.lockPath;
  const abandonedSegment = audit.segmentPath;
  await seedLock(audit, { token: "crashed", pid: 424242, host: HOST, epoch: Date.now() });

  const record = await audit.append({ type: "start" });
  // The append fulfils on a brand-new, exclusively-owned segment (no DoS).
  assert.equal(record.sequence, 1);
  assert.notEqual(audit.segmentPath, abandonedSegment);
  assert.notEqual(audit.lockPath, abandonedLock);
  // The abandoned lock is preserved untouched for forensics — never reclaimed.
  assert.equal(await exists(abandonedLock), true);
  assert.equal(JSON.parse(await readFile(abandonedLock, "utf8")).token, "crashed");
  // The rolled-over segment holds the record and reconciliation still verifies.
  assert.equal((await audit.verify()).records, 1);
  const { records } = await reconcileAuditTask({ auditRoot, runId: "run-1", taskId: "task-1" });
  assert.equal(records.length, 1);
});

test("rolls over past an ancient lock beyond the staleness window (preserving it)", { concurrency: false }, async () => {
  const auditRoot = resolve(workRoot, "audit");
  // Real liveness check, but the lock timestamp is far older than staleMs.
  const audit = writer(auditRoot, { lockStaleMs: 1_000 });
  const abandonedLock = audit.lockPath;
  await seedLock(audit, {
    token: "ancient",
    pid: process.pid,
    host: HOST,
    epoch: Date.now() - 60_000,
  });

  const record = await audit.append({ type: "start" });
  assert.equal(record.sequence, 1);
  assert.notEqual(audit.lockPath, abandonedLock);
  // The ancient lock is routed around, not reclaimed.
  assert.equal(await exists(abandonedLock), true);
  // The freshly-minted lock is released once the append completes.
  assert.equal(await exists(audit.lockPath), false);
});

test("does not steal a fresh lock held by a live writer", { concurrency: false }, async () => {
  const auditRoot = resolve(workRoot, "audit");
  const audit = writer(auditRoot, {
    isProcessAlive: () => true,
    lockTimeoutMs: 120,
    lockStaleMs: 60_000,
  });
  await seedLock(audit, { token: "live", pid: process.pid, host: HOST, epoch: Date.now() });

  await assert.rejects(audit.append({ type: "start" }), /timed out acquiring audit lock/);
  // The live holder's lock is untouched.
  const held = JSON.parse(await readFile(audit.lockPath, "utf8"));
  assert.equal(held.token, "live");

  // Once the live holder releases, appends proceed normally.
  await rm(audit.lockPath, { force: true });
  const record = await audit.append({ type: "start" });
  assert.equal(record.sequence, 1);
});

test("rolls over past a malformed lock instead of reclaiming it", { concurrency: false }, async () => {
  const auditRoot = resolve(workRoot, "audit");
  const audit = writer(auditRoot, { lockTimeoutMs: 500 });
  const abandonedLock = audit.lockPath;
  await mkdir(audit.segmentDirectory, { recursive: true });
  await writeFile(abandonedLock, "{ not valid json");

  const record = await audit.append({ type: "start" });
  assert.equal(record.sequence, 1);
  assert.notEqual(audit.lockPath, abandonedLock);
  // A truncated/garbage lock is treated as stale and preserved, not deleted.
  assert.equal(await exists(abandonedLock), true);
});
