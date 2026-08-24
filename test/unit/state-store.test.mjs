import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import {
  TrestleStateError,
  createTrestleStateStore,
} from '../../src/state/store.mjs';

const artifactRoot = resolve('test/.artifacts/state-store');
const HOST = hostname();
const CONCURRENCY = 25;
const roots = {
  projectStateRoot: resolve(artifactRoot, 'project'),
  workstreamStateRoot: resolve(artifactRoot, 'workstream'),
  configRoot: resolve(artifactRoot, 'config'),
};
const schemas = {
  tasks: {
    type: 'object',
    required: ['status'],
    properties: { status: { type: 'string' } },
    additionalProperties: false,
  },
  events: { type: 'array', items: { type: 'object', required: ['name'] } },
  decisions: { type: 'object', required: ['choice'] },
};

beforeEach(async () => {
  await rm(artifactRoot, { recursive: true, force: true });
});

after(async () => {
  await rm(artifactRoot, { recursive: true, force: true });
});

function store(overrides = {}) {
  return createTrestleStateStore({
    ...roots,
    schemas,
    clock: () => new Date('2026-08-14T12:00:00.000Z'),
    idGenerator: () => 'test-id',
    ...overrides,
  });
}

// The symlink fixtures below live at a fixed path inside the checkout, so a failed
// security assertion can also mean the fixture was disturbed mid-test. Checking the
// fixture separately keeps a real regression apart from interference (see issue #25).
async function describeTree(path) {
  try {
    return (await readdir(path)).join(', ') || '<empty>';
  } catch (error) {
    return `<${error.code}>`;
  }
}

async function assertSymlinkFixture(path, description) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    assert.fail(
      `fixture missing: ${description} (${error.code}); `
        + `${artifactRoot} contains: ${await describeTree(artifactRoot)}`,
    );
  }
  assert.ok(
    stats.isSymbolicLink(),
    `fixture broken: ${description} is not a symlink; `
      + `${artifactRoot} contains: ${await describeTree(artifactRoot)}`,
  );
}

function statePath(scope, namespace, key) {
  const root = scope === 'project' ? roots.projectStateRoot : roots.workstreamStateRoot;
  return resolve(root, 'namespaces', namespace, ...key.split('/')) + '.json';
}

function lockPath(scope, namespace, key) {
  return `${statePath(scope, namespace, key)}.lock`;
}

async function seedLock({
  scope = 'workstream',
  namespace,
  key,
  token,
  pid,
  host,
  epoch = Date.now(),
}) {
  const path = lockPath(scope, namespace, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({
    token,
    pid,
    host,
    epoch,
    acquiredAt: new Date(epoch).toISOString(),
  })}\n`);
  return path;
}

async function seedMalformedLock({ scope = 'workstream', namespace, key, contents = '' }) {
  const path = lockPath(scope, namespace, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  return path;
}

test('requires explicit absolute project, workstream, and config roots', () => {
  assert.throws(
    () => createTrestleStateStore({ projectStateRoot: '.', workstreamStateRoot: '.', configRoot: '.', schemas }),
    (error) => error.code === 'INVALID_ROOT',
  );
});

test('keeps project and workstream state isolated and reports v1 topology', async () => {
  const state = store();
  await state.write({ scope: 'project', namespace: 'tasks', key: 'same', value: { status: 'project' } });
  await state.write({ scope: 'workstream', namespace: 'tasks', key: 'same', value: { status: 'workstream' } });

  assert.deepEqual(await state.read({ scope: 'project', namespace: 'tasks', key: 'same' }), { status: 'project' });
  assert.deepEqual(await state.read({ scope: 'workstream', namespace: 'tasks', key: 'same' }), { status: 'workstream' });
  assert.equal((await state.health()).topology, 'server-per-workstream');
});

test('separate workstream stores cannot observe or delete each other state', async () => {
  const first = store({ workstreamStateRoot: resolve(artifactRoot, 'workstream-a') });
  const second = store({ workstreamStateRoot: resolve(artifactRoot, 'workstream-b') });
  await first.write({ namespace: 'tasks', key: 'same', value: { status: 'first' } });
  await second.write({ namespace: 'tasks', key: 'same', value: { status: 'second' } });

  assert.deepEqual(await first.read({ namespace: 'tasks', key: 'same' }), { status: 'first' });
  assert.deepEqual(await second.read({ namespace: 'tasks', key: 'same' }), { status: 'second' });
  await first.delete({ namespace: 'tasks', key: 'same' });
  assert.deepEqual(await second.read({ namespace: 'tasks', key: 'same' }), { status: 'second' });
  assert.deepEqual(await first.list({ namespace: 'tasks' }), []);
  assert.deepEqual(await second.list({ namespace: 'tasks' }), ['same']);
});

test('production topology keeps immutable config reads disjoint from every workstream', async () => {
  const projectRoot = resolve(artifactRoot, 'project-root');
  const configRoot = resolve(projectRoot, '.trestle/config');
  const first = store({
    projectRoot,
    configRoot,
    workstreamStateRoot: resolve(projectRoot, '.trestle/state/workstreams/first'),
    workstreamId: 'first',
  });
  const second = store({
    projectRoot,
    configRoot,
    workstreamStateRoot: resolve(projectRoot, '.trestle/state/workstreams/second'),
    workstreamId: 'second',
  });
  await mkdir(configRoot, { recursive: true });
  await writeFile(resolve(configRoot, 'settings.json'), '{"mode":"safe"}\n');
  await first.write({ namespace: 'tasks', key: 'secret', value: { status: 'first' } });
  await second.write({ namespace: 'tasks', key: 'secret', value: { status: 'second' } });

  assert.deepEqual(await first.read({ namespace: 'config', key: 'settings' }), { mode: 'safe' });
  assert.deepEqual(await first.list({ namespace: 'config' }), ['settings']);
  await assert.rejects(
    first.read({ namespace: 'config', key: 'state/workstreams/second/namespaces/tasks/secret' }),
    (error) => error.code === 'INVALID_PATH',
  );
  await assert.rejects(
    first.lockStatus({ namespace: 'config', key: 'state/workstreams/second' }),
    (error) => error.code === 'INVALID_PATH',
  );
  assert.deepEqual(await second.read({ namespace: 'tasks', key: 'secret' }), { status: 'second' });
});

test('rejects traversal, immutable config mutation, and unregistered mutable namespaces', async () => {
  const state = store();
  await assert.rejects(
    state.write({ namespace: 'tasks', key: '../escape', value: { status: 'bad' } }),
    (error) => error.code === 'INVALID_PATH',
  );
  await assert.rejects(
    state.write({ namespace: 'config', key: 'settings', value: {} }),
    (error) => error.code === 'IMMUTABLE_NAMESPACE',
  );
  await assert.rejects(
    state.write({ namespace: 'unknown', key: 'entry', value: {} }),
    (error) => error.code === 'SCHEMA_REQUIRED',
  );
});

test('reads raw immutable config and rejects symlink escapes beneath trusted roots', async () => {
  const state = store();
  await mkdir(roots.configRoot, { recursive: true });
  await writeFile(resolve(roots.configRoot, 'settings.json'), '{"mode":"safe"}\n');
  assert.deepEqual(await state.read({ namespace: 'config', key: 'settings' }), { mode: 'safe' });

  await mkdir(resolve(artifactRoot, 'outside'), { recursive: true });
  await mkdir(resolve(roots.workstreamStateRoot, 'namespaces/tasks'), { recursive: true });
  await symlink(resolve(artifactRoot, 'outside'), resolve(roots.workstreamStateRoot, 'namespaces/tasks/link'));
  await assert.rejects(
    state.write({ namespace: 'tasks', key: 'link/escape', value: { status: 'bad' } }),
    (error) => error.code === 'PATH_TRAVERSAL',
  );
});

test('rejects symlink state roots and symlink ancestors while allowing valid nonexistent roots', async () => {
  const outside = resolve(artifactRoot, 'outside');
  await mkdir(outside, { recursive: true });
  await symlink(outside, roots.workstreamStateRoot);
  await assertSymlinkFixture(roots.workstreamStateRoot, 'workstream root symlink');
  await assert.rejects(
    store().health(),
    (error) => error.code === 'PATH_TRAVERSAL',
    'a symlinked state root must be rejected',
  );

  await rm(artifactRoot, { recursive: true, force: true });
  await mkdir(resolve(artifactRoot, 'real-parent'), { recursive: true });
  await symlink(resolve(artifactRoot, 'real-parent'), resolve(artifactRoot, 'linked-parent'));
  await assertSymlinkFixture(resolve(artifactRoot, 'linked-parent'), 'ancestor symlink');
  await assert.rejects(
    store({
      projectStateRoot: resolve(artifactRoot, 'linked-parent/project'),
      workstreamStateRoot: resolve(artifactRoot, 'linked-parent/workstream'),
    }).health(),
    (error) => error.code === 'PATH_TRAVERSAL',
    'a symlinked ancestor must be rejected',
  );

  await rm(artifactRoot, { recursive: true, force: true });
  const state = store();
  assert.equal((await state.health()).ok, true, 'a nonexistent root must be created on demand');
});

test('fails closed when a validated descendant is swapped for an escaping symlink', async () => {
  const state = store();
  await state.health();
  const namespaceRoot = resolve(roots.workstreamStateRoot, 'namespaces/tasks');
  const outside = resolve(artifactRoot, 'outside');
  await mkdir(namespaceRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  await rm(namespaceRoot, { recursive: true });
  await symlink(outside, namespaceRoot);
  await assert.rejects(
    state.write({ namespace: 'tasks', key: 'escaped', value: { status: 'bad' } }),
    (error) => error.code === 'PATH_TRAVERSAL',
  );
  await assert.rejects(readFile(resolve(outside, 'escaped.json'), 'utf8'), { code: 'ENOENT' });
});

test('validates mutable namespace values and persists state version metadata', async () => {
  const state = store({ stateVersion: 3 });
  await assert.rejects(
    state.write({ namespace: 'tasks', key: 'bad', value: { status: 42 } }),
    (error) => error.code === 'SCHEMA_VALIDATION',
  );
  await state.write({ namespace: 'tasks', key: 'good', value: { status: 'ready' } });
  const stored = JSON.parse(await readFile(resolve(roots.workstreamStateRoot, 'namespaces/tasks/good.json'), 'utf8'));
  assert.equal(stored.trestleStateVersion, 3);
  assert.equal(stored.updatedAt, '2026-08-14T12:00:00.000Z');
});

test('runs sequential migration hooks when reading older state', async () => {
  const path = resolve(roots.workstreamStateRoot, 'namespaces/tasks/legacy.json');
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify({
    trestleStateVersion: 1,
    namespace: 'tasks',
    updatedAt: '2020-01-01T00:00:00.000Z',
    value: { state: 'queued' },
  }));
  const state = store({
    stateVersion: 2,
    migrations: {
      1: (envelope, context) => ({
        ...envelope,
        value: { status: envelope.value.state, migratedFrom: context.fromVersion },
      }),
    },
  });
  assert.deepEqual(
    await state.read({ namespace: 'tasks', key: 'legacy' }),
    { status: 'queued', migratedFrom: 1 },
  );
});

test('serializes concurrent appends without losing entries', async () => {
  const state = store({ lockTimeoutMs: 20_000 });
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, index) =>
    state.append({ namespace: 'events', key: 'run-1', value: { name: `event-${index}` } })));
  const values = await state.read({ namespace: 'events', key: 'run-1' });
  assert.equal(values.length, CONCURRENCY);
  assert.deepEqual(new Set(values.map(({ name }) => name)), new Set(Array.from({ length: CONCURRENCY }, (_, index) => `event-${index}`)));
});

test('reports per-key lock metadata, liveness, and recovery mode', async () => {
  const epoch = Date.now() - 60_000;
  await seedLock({
    namespace: 'events',
    key: 'locked',
    token: 'remote-token',
    pid: 424242,
    host: 'remote-host',
    epoch,
  });

  const status = await store({ lockStaleMs: 5_000 }).lockStatus({ namespace: 'events', key: 'locked' });
  assert.equal(status.locked, true);
  assert.equal(status.lock.token, 'remote-token');
  assert.equal(status.lock.host, 'remote-host');
  assert.equal(status.lock.pid, 424242);
  assert.equal(status.lock.status, 'operator-recovery-required');
  assert.equal(status.lock.canAutoRecover, false);
  assert.equal(typeof status.lock.ageMs, 'number');
  assert.equal(status.recovery, null);
});

test(`requires explicit recovery for a crashed same-host lock before serializing ${CONCURRENCY} appends`, async () => {
  const key = 'crash-recovery';
  const path = await seedLock({
    namespace: 'events',
    key,
    token: 'crashed-token',
    pid: 424242,
    host: HOST,
    epoch: Date.now() - 60_000,
  });

  const isProcessAlive = (pid) => pid === process.pid;
  const guarded = store({
    isProcessAlive,
    lockStaleMs: 5_000,
    lockTimeoutMs: 20_000,
  });
  await assert.rejects(
    guarded.append({ namespace: 'events', key, value: { name: 'blocked' } }),
    (error) => error.code === 'LOCK_STALE' && error.details.lock.token === 'crashed-token',
  );
  const status = await guarded.lockStatus({ namespace: 'events', key });
  assert.equal(status.lock.status, 'operator-recovery-required');
  assert.equal(status.lock.canAutoRecover, false);
  assert.equal(status.lock.needsOperator, true);
  const unlocked = await guarded.unlock(status.unlock.arguments);
  assert.equal(unlocked.unlocked, true);
  await assert.rejects(readFile(path, 'utf8'), (error) => error.code === 'ENOENT');

  const writers = Array.from({ length: CONCURRENCY }, () => store({
    isProcessAlive,
    lockStaleMs: 5_000,
    lockTimeoutMs: 20_000,
  }));
  const results = await Promise.allSettled(
    writers.map((state, index) => state.append({
      namespace: 'events',
      key,
      value: { name: `event-${index}` },
    })),
  );
  for (const [index, result] of results.entries()) {
    assert.equal(result.status, 'fulfilled', `writer ${index} rejected: ${result.reason?.stack ?? result.reason}`);
  }

  const recovered = store({ isProcessAlive });
  const values = await recovered.read({ namespace: 'events', key });
  assert.equal(values.length, CONCURRENCY);
  assert.deepEqual(new Set(values.map(({ name }) => name)), new Set(Array.from({ length: CONCURRENCY }, (_, index) => `event-${index}`)));
  assert.equal((await recovered.lockStatus({ namespace: 'events', key })).locked, false);
});

test('operator recovery revalidates identity before unlinking a replacement', async () => {
  const state = store({
    lockStaleMs: 50,
    beforeUnlinkRevalidation: async (target) => {
      const replacement = `${target}.replacement`;
      await writeFile(replacement, 'replacement');
      await rename(replacement, target);
    },
  });
  const path = await seedLock({
    namespace: 'events',
    key: 'recovery-race',
    token: 'dead-token',
    pid: 424242,
    host: HOST,
    epoch: Date.now() - 60_000,
  });
  const status = await state.lockStatus({ namespace: 'events', key: 'recovery-race' });

  await assert.rejects(
    state.unlock(status.unlock.arguments),
    (error) => error.code === 'LOCK_REPLACED',
  );
  assert.equal(await readFile(path, 'utf8'), 'replacement');
});

test('fails closed for remote stale locks until an operator provides the expected token', async () => {
  const state = store({ lockTimeoutMs: 120, lockStaleMs: 50 });
  await seedLock({
    namespace: 'events',
    key: 'remote-stale',
    token: 'remote-token',
    pid: 424242,
    host: 'remote-host',
    epoch: Date.now() - 60_000,
  });

  await assert.rejects(
    state.append({ namespace: 'events', key: 'remote-stale', value: { name: 'blocked' } }),
    (error) => error.code === 'LOCK_STALE' && error.details.lock.token === 'remote-token',
  );

  const status = await state.lockStatus({ namespace: 'events', key: 'remote-stale' });
  assert.equal(status.lock.status, 'operator-recovery-required');
  assert.equal(status.lock.token, 'remote-token');
  const unlocked = await state.unlock({
    namespace: 'events',
    key: 'remote-stale',
    expectedToken: 'remote-token',
    expectedInode: status.lock.ino,
  });
  assert.equal(unlocked.unlocked, true);

  await state.append({ namespace: 'events', key: 'remote-stale', value: { name: 'recovered' } });
  assert.deepEqual(await state.read({ namespace: 'events', key: 'remote-stale' }), [{ name: 'recovered' }]);
});

test('remote and malformed recovery barriers are never auto-deleted and expose explicit recovery', async () => {
  const remoteKey = 'remote-barrier';
  const remoteBarrier = `${await seedLock({
    namespace: 'events',
    key: remoteKey,
    token: 'remote-lock',
    pid: 424242,
    host: HOST,
    epoch: Date.now() - 60_000,
  })}.recovery`;
  await writeFile(remoteBarrier, `${JSON.stringify({
    token: 'remote-barrier-token',
    pid: 424242,
    host: 'remote-host',
    epoch: Date.now() - 60_000,
  })}\n`);
  const state = store({ lockTimeoutMs: 120, lockStaleMs: 50 });

  await assert.rejects(
    state.append({ namespace: 'events', key: remoteKey, value: { name: 'blocked' } }),
    (error) => error.code === 'LOCK_STALE' && error.details.recoveryBarrier === true,
  );
  assert.match(await readFile(remoteBarrier, 'utf8'), /remote-barrier-token/);
  const remoteStatus = await state.lockStatus({ namespace: 'events', key: remoteKey });
  assert.equal(remoteStatus.recovery.status, 'operator-recovery-required');
  assert.equal(remoteStatus.recoveryUnlock.arguments.expectedToken, 'remote-barrier-token');
  const remoteRecovery = await state.unlock(remoteStatus.recoveryUnlock.arguments);
  assert.equal(remoteRecovery.recovery, true);
  await assert.rejects(readFile(remoteBarrier, 'utf8'), (error) => error.code === 'ENOENT');

  const malformedKey = 'malformed-barrier';
  const malformedBarrier = `${await seedMalformedLock({
    namespace: 'events',
    key: malformedKey,
  })}.recovery`;
  await rm(`${malformedBarrier}`, { force: true });
  await mkdir(dirname(malformedBarrier), { recursive: true });
  await writeFile(malformedBarrier, '');
  await assert.rejects(
    state.append({ namespace: 'events', key: malformedKey, value: { name: 'blocked' } }),
    (error) => error.code === 'LOCK_STALE' && error.details.recoveryBarrier === true,
  );
  assert.equal(await readFile(malformedBarrier, 'utf8'), '');
  const malformedStatus = await state.lockStatus({ namespace: 'events', key: malformedKey });
  assert.equal(malformedStatus.recoveryUnlock.authorization, 'expected-identity');
  const malformedRecovery = await state.unlock(malformedStatus.recoveryUnlock.arguments);
  assert.equal(malformedRecovery.recovery, true);
  await assert.rejects(readFile(malformedBarrier, 'utf8'), (error) => error.code === 'ENOENT');
});

test(`respects live locks under ${CONCURRENCY}-way contention and refuses unsafe unlocks`, async () => {
  const key = 'live-lock';
  const path = await seedLock({
    namespace: 'events',
    key,
    token: 'live-token',
    pid: process.pid,
    host: HOST,
    epoch: Date.now() - 60_000,
  });

  const contenders = Array.from({ length: CONCURRENCY }, () => store({
    lockTimeoutMs: 100,
    lockStaleMs: 50,
    isProcessAlive: (pid) => pid === process.pid,
  }));
  const results = await Promise.allSettled(
    contenders.map((state, index) => state.append({
      namespace: 'events',
      key,
      value: { name: `blocked-${index}` },
    })),
  );
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.code, 'LOCK_TIMEOUT');
    assert.equal(result.reason.details.lock.status, 'live');
  }
  const status = await contenders[0].lockStatus({ namespace: 'events', key });
  assert.equal(status.lock.status, 'live');
  await assert.rejects(
    contenders[0].unlock({
      namespace: 'events',
      key,
      expectedToken: 'live-token',
      expectedInode: status.lock.ino,
    }),
    (error) => error.code === 'LOCK_NOT_STALE',
  );
  assert.match(await readFile(path, 'utf8'), /live-token/);
  await assert.rejects(
    contenders[0].read({ namespace: 'events', key }),
    (error) => error.code === 'NOT_FOUND',
  );
});

test('recovers a malformed zero-length crash-window lock through the emitted tokenless hint', async () => {
  const state = store({ workstreamId: 'main-ws', lockTimeoutMs: 200, lockStaleMs: 50 });
  const path = await seedMalformedLock({ namespace: 'events', key: 'crash-window' });

  const status = await state.lockStatus({ namespace: 'events', key: 'crash-window' });
  assert.equal(status.lock.status, 'operator-recovery-required');
  assert.equal(status.lock.malformed, true);
  assert.equal(status.lock.needsOperator, true);
  assert.equal(status.lock.token, null);

  // The status must carry an executable, tokenless recovery hint pinned to the
  // immutable inode + device identity (no token, because there is none on disk).
  assert.equal(status.unlock.authorization, 'expected-identity');
  assert.equal(status.unlock.tool, 'trestle_state_unlock');
  assert.equal(status.unlock.arguments.expectedToken, undefined);
  assert.equal(status.unlock.arguments.expectedInode, status.lock.ino);
  assert.equal(status.unlock.arguments.expectedDevice, status.lock.dev);
  assert.match(status.unlock.cli, /--expected-inode \d+ --expected-device \d+$/);
  assert.match(status.unlock.cli, /--workstream main-ws /);
  assert.doesNotMatch(status.unlock.cli, /--expected-token/);

  // Executing the emitted machine-readable arguments exactly as returned works.
  const unlocked = await state.unlock(status.unlock.arguments);
  assert.equal(unlocked.unlocked, true);
  assert.equal(unlocked.lock.malformed, true);
  await assert.rejects(readFile(path, 'utf8'), (error) => error.code === 'ENOENT');

  // A subsequent write acquires a fresh lock and succeeds.
  await state.append({ namespace: 'events', key: 'crash-window', value: { name: 'recovered' } });
  assert.deepEqual(await state.read({ namespace: 'events', key: 'crash-window' }), [{ name: 'recovered' }]);
  assert.equal((await state.lockStatus({ namespace: 'events', key: 'crash-window' })).locked, false);
});

test('refuses tokenless unlock of valid live and valid tokened locks', async () => {
  const live = store({ isProcessAlive: (pid) => pid === process.pid, lockStaleMs: 50 });
  const livePath = await seedLock({
    namespace: 'events', key: 'live', token: 'live-token', pid: process.pid, host: HOST, epoch: Date.now() - 60_000,
  });
  const liveStatus = await live.lockStatus({ namespace: 'events', key: 'live' });
  assert.equal(liveStatus.lock.status, 'live');
  assert.equal(liveStatus.unlock, null);
  await assert.rejects(
    live.unlock({ namespace: 'events', key: 'live', expectedInode: liveStatus.lock.ino, expectedDevice: liveStatus.lock.dev }),
    (error) => error.code === 'LOCK_TOKEN_REQUIRED',
  );
  assert.match(await readFile(livePath, 'utf8'), /live-token/);

  const stale = store({ lockStaleMs: 50 });
  const stalePath = await seedLock({
    namespace: 'events', key: 'remote', token: 'remote-token', pid: 424242, host: 'remote-host', epoch: Date.now() - 60_000,
  });
  const staleStatus = await stale.lockStatus({ namespace: 'events', key: 'remote' });
  assert.equal(staleStatus.lock.status, 'operator-recovery-required');
  await assert.rejects(
    stale.unlock({ namespace: 'events', key: 'remote', expectedInode: staleStatus.lock.ino, expectedDevice: staleStatus.lock.dev }),
    (error) => error.code === 'LOCK_TOKEN_REQUIRED',
  );
  assert.match(await readFile(stalePath, 'utf8'), /remote-token/);
});

test('revalidates lock identity immediately before unlink and fails closed on replacement', async () => {
  const state = store({
    lockStaleMs: 50,
    // Simulate an attacker/other process swapping a fresh file over the lock
    // path after identity was confirmed but immediately before the unlink.
    beforeUnlinkRevalidation: async (target) => {
      const swap = `${target}.swap`;
      await writeFile(swap, 'intruder');
      await rename(swap, target);
    },
  });
  const path = await seedMalformedLock({ namespace: 'events', key: 'raced' });
  const status = await state.lockStatus({ namespace: 'events', key: 'raced' });

  await assert.rejects(
    state.unlock(status.unlock.arguments),
    (error) => error.code === 'LOCK_REPLACED',
  );
  // The swapped-in file must be left intact — recovery never unlinks a replacement.
  assert.equal(await readFile(path, 'utf8'), 'intruder');
});

test('fails closed on an intermediate-parent swap and preserves the outside file', async () => {
  const outside = resolve(artifactRoot, 'outside-parent');
  await mkdir(outside, { recursive: true });
  const outsideFile = resolve(outside, 'raced.json.lock');
  await writeFile(outsideFile, 'OUTSIDE CONTENT\n');
  let swapped = false;
  const state = store({
    lockStaleMs: 50,
    beforeRemove: async ({ path: target }) => {
      if (swapped) return;
      swapped = true;
      const parent = dirname(target);
      await rename(parent, `${parent}.original`);
      await symlink(outside, parent);
    },
  });
  const path = await seedMalformedLock({ namespace: 'events', key: 'raced' });
  const status = await state.lockStatus({ namespace: 'events', key: 'raced' });

  await assert.rejects(
    state.unlock(status.unlock.arguments),
    (error) => error.code === 'PATH_TRAVERSAL',
  );
  assert.equal(await readFile(outsideFile, 'utf8'), 'OUTSIDE CONTENT\n');
});

test('requires both inode and device for tokenless recovery and rejects bad identity integers', async () => {
  const state = store({ lockStaleMs: 50 });
  const path = await seedMalformedLock({ namespace: 'events', key: 'guarded' });
  const status = await state.lockStatus({ namespace: 'events', key: 'guarded' });

  await assert.rejects(
    state.unlock({ namespace: 'events', key: 'guarded', expectedInode: status.lock.ino }),
    (error) => error.code === 'UNLOCK_AUTHORIZATION_REQUIRED',
  );
  await assert.rejects(
    state.unlock({ namespace: 'events', key: 'guarded', expectedInode: status.lock.ino, expectedDevice: status.lock.dev + 1 }),
    (error) => error.code === 'LOCK_IDENTITY_MISMATCH',
  );
  await assert.rejects(
    state.unlock({ namespace: 'events', key: 'guarded', expectedInode: -1, expectedDevice: status.lock.dev }),
    (error) => error.code === 'INVALID_LOCK_IDENTITY',
  );
  // Nothing above cleared the lock.
  assert.equal(await readFile(path, 'utf8'), '');
});

test('lists nested keys, deletes entries, and records decisions', async () => {
  const state = store();
  await state.write({ namespace: 'tasks', key: 'group/a', value: { status: 'a' } });
  await state.write({ namespace: 'tasks', key: 'group/b', value: { status: 'b' } });
  assert.deepEqual(await state.list({ namespace: 'tasks', prefix: 'group' }), ['group/a', 'group/b']);
  assert.deepEqual(await state.delete({ namespace: 'tasks', key: 'group/a' }), { deleted: true });
  await state.decide({ decisionId: 'route-1', decision: { choice: 'review' } });
  assert.deepEqual(await state.read({ namespace: 'decisions', key: 'route-1' }), { choice: 'review' });
});

test('uses stable error type and code for missing state', async () => {
  await assert.rejects(
    store().read({ namespace: 'tasks', key: 'missing' }),
    (error) => error instanceof TrestleStateError && error.code === 'NOT_FOUND',
  );
});
