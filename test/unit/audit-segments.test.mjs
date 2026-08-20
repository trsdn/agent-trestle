import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import {
  AuditIntegrityError,
  createAuditSegmentWriter,
  reconcileAuditTask,
  verifyAuditSegment,
} from '../../src/audit/audit.mjs';

const auditRoot = resolve('test/.artifacts/audit');

beforeEach(async () => {
  await rm(auditRoot, { recursive: true, force: true });
});

after(async () => {
  await rm(auditRoot, { recursive: true, force: true });
});

function writer(writerId, segmentId, timestamps) {
  let index = 0;
  return createAuditSegmentWriter({
    auditRoot,
    runId: 'run-1',
    taskId: 'task-1',
    writerId,
    idGenerator: () => segmentId,
    clock: () => new Date(timestamps[Math.min(index++, timestamps.length - 1)]),
  });
}

test('creates per-run/per-task/per-writer segments with hash chains', async () => {
  const audit = writer('writer-a', 'segment-a', [
    '2026-08-14T10:00:00.000Z',
    '2026-08-14T10:00:01.000Z',
  ]);
  const first = await audit.append({ type: 'start' });
  const second = await audit.append({ type: 'finish' });

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(second.priorHash, first.hash);
  assert.equal(first.writerId, 'writer-a');
  assert.match(audit.segmentPath, /runs[/\\]run-1[/\\]tasks[/\\]task-1[/\\]segments/);
  assert.deepEqual(await audit.verify(), {
    ok: true,
    path: audit.segmentPath,
    records: 2,
    headHash: second.hash,
  });
});

test('serializes concurrent appends by the same segment writer', async () => {
  const audit = writer('writer-a', 'segment-a', ['2026-08-14T10:00:00.000Z']);
  const records = await Promise.all(Array.from({ length: 20 }, (_, index) => audit.append({ index })));
  assert.equal(records.length, 20);
  assert.equal((await audit.verify()).records, 20);
  const persisted = (await readFile(audit.segmentPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(persisted.map(({ sequence }) => sequence), Array.from({ length: 20 }, (_, index) => index + 1));
});

test('detects payload, hash, and sequence tampering', async () => {
  const audit = writer('writer-a', 'segment-a', ['2026-08-14T10:00:00.000Z']);
  await audit.append({ amount: 1 });
  const record = JSON.parse((await readFile(audit.segmentPath, 'utf8')).trim());
  record.event.amount = 2;
  await writeFile(audit.segmentPath, `${JSON.stringify(record)}\n`);

  await assert.rejects(
    verifyAuditSegment(audit.segmentPath),
    (error) => error instanceof AuditIntegrityError && error.message.includes('hash mismatch'),
  );
  await assert.rejects(
    audit.append({ amount: 3 }),
    (error) => error instanceof AuditIntegrityError && error.message.includes('hash mismatch'),
  );
});

test('reconciles independent segments deterministically without a global append file', async () => {
  const a = writer('writer-a', 'segment-a', ['2026-08-14T10:00:02.000Z']);
  const b = writer('writer-b', 'segment-b', ['2026-08-14T10:00:01.000Z']);
  await Promise.all([
    a.append({ source: 'a' }),
    b.append({ source: 'b' }),
  ]);

  const first = await reconcileAuditTask({ auditRoot, runId: 'run-1', taskId: 'task-1' });
  const second = await reconcileAuditTask({ auditRoot, runId: 'run-1', taskId: 'task-1' });
  assert.deepEqual(first.records.map(({ writerId }) => writerId), ['writer-b', 'writer-a']);
  assert.equal(first.reconciliationHash, second.reconciliationHash);
  assert.equal(first.segments.length, 2);
});

test('uses writer ID as a deterministic reconciliation tie-breaker', async () => {
  const time = ['2026-08-14T10:00:00.000Z'];
  await Promise.all([
    writer('writer-z', 'segment-z', time).append({ source: 'z' }),
    writer('writer-a', 'segment-a', time).append({ source: 'a' }),
  ]);
  const result = await reconcileAuditTask({ auditRoot, runId: 'run-1', taskId: 'task-1' });
  assert.deepEqual(result.records.map(({ writerId }) => writerId), ['writer-a', 'writer-z']);
});

test('rejects traversal in run, task, writer, and segment identifiers', () => {
  assert.throws(
    () => createAuditSegmentWriter({
      auditRoot,
      runId: '../run',
      taskId: 'task',
      writerId: 'writer',
      idGenerator: () => 'segment',
    }),
    /invalid characters/,
  );
});

test('rejects non-serializable audit events', async () => {
  const audit = writer('writer-a', 'segment-a', ['2026-08-14T10:00:00.000Z']);
  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(audit.append(cyclic), /JSON-serializable/);
});
