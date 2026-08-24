import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pinDirectory, releasePin, verifyDescendant, verifyPinnedDirectory } from '../security/path-security.mjs';

const DEFAULT_VERSION = 1;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RECOVERY_SUFFIX = '.recovery';
const HOST = hostname();

export class TrestleStateError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'TrestleStateError';
    this.code = code;
    this.details = details;
  }
}

function requireAbsoluteRoot(name, value) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new TrestleStateError(`${name} must be an explicit absolute path`, 'INVALID_ROOT');
  }
  return resolve(value);
}

function safeSegment(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new TrestleStateError(`${name} contains invalid characters`, 'INVALID_PATH');
  }
  return value;
}

function safeKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.includes('\0') || isAbsolute(key)) {
    throw new TrestleStateError('key must be a non-empty relative path', 'INVALID_PATH');
  }
  const parts = key.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) {
    throw new TrestleStateError('key contains invalid path segments', 'INVALID_PATH');
  }
  return parts;
}

function within(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function assertWithin(root, candidate) {
  if (!within(root, candidate)) {
    throw new TrestleStateError('resolved path escapes its state root', 'PATH_TRAVERSAL');
  }
}

function assertConfigArtifactKey(key) {
  const parts = safeKey(key);
  if (parts.length !== 1) {
    throw new TrestleStateError(
      'config keys must name one immediate JSON artifact',
      'INVALID_PATH',
    );
  }
  return parts;
}

function defaultId() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function defaultProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function lockToken() {
  return randomBytes(16).toString('hex');
}

function lockTimestamp(clockMs) {
  const epoch = clockMs();
  return { epoch, acquiredAt: new Date(epoch).toISOString() };
}

function lockIdentity(token, clockMs, metadata = {}) {
  const { epoch, acquiredAt } = lockTimestamp(clockMs);
  return {
    token,
    pid: process.pid,
    host: HOST,
    epoch,
    acquiredAt,
    ...metadata,
  };
}

function normalizeSchemas(schemas) {
  return schemas instanceof Map ? schemas : new Map(Object.entries(schemas ?? {}));
}

function validateSchema(value, schema, path = '$') {
  if (typeof schema === 'function') {
    const result = schema(value);
    if (result === false) throw new TrestleStateError(`schema validation failed at ${path}`, 'SCHEMA_VALIDATION');
    return;
  }
  if (!schema || typeof schema !== 'object') {
    throw new TrestleStateError('mutable namespaces require a schema or validator', 'SCHEMA_REQUIRED');
  }
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) {
    throw new TrestleStateError(`value at ${path} is not in enum`, 'SCHEMA_VALIDATION');
  }
  if (schema.type) {
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (actual !== schema.type) {
      throw new TrestleStateError(`expected ${schema.type} at ${path}, received ${actual}`, 'SCHEMA_VALIDATION');
    }
  }
  if (schema.type === 'object') {
    const required = schema.required ?? [];
    for (const property of required) {
      if (!Object.hasOwn(value, property)) {
        throw new TrestleStateError(`missing required property ${path}.${property}`, 'SCHEMA_VALIDATION');
      }
    }
    for (const [property, childSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, property)) validateSchema(value[property], childSchema, `${path}.${property}`);
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      const extra = Object.keys(value).find((property) => !known.has(property));
      if (extra) throw new TrestleStateError(`unexpected property ${path}.${extra}`, 'SCHEMA_VALIDATION');
    }
  }
  if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new TrestleStateError(`too few items at ${path}`, 'SCHEMA_VALIDATION');
    }
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`));
  }
}

async function pathExists(path, verify) {
  try {
    await verify(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    await handle.close();
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function assertHandleMatchesPath(handle, path) {
  const [opened, current] = await Promise.all([handle.stat(), lstat(path)]);
  if (current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino) {
    throw new TrestleStateError('state path changed while it was in use', 'PATH_TRAVERSAL');
  }
}

function normalizeLockInfo(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      malformed: true,
      token: null,
      pid: null,
      host: null,
      epoch: null,
      acquiredAt: null,
    };
  }
  const token = typeof payload.token === 'string' && payload.token.length > 0 ? payload.token : null;
  const pid = Number.isInteger(payload.pid) ? payload.pid : null;
  const host = typeof payload.host === 'string' && payload.host.length > 0 ? payload.host : null;
  const epoch = typeof payload.epoch === 'number' && Number.isFinite(payload.epoch) ? payload.epoch : null;
  const acquiredAt = typeof payload.acquiredAt === 'string' && payload.acquiredAt.length > 0 ? payload.acquiredAt : null;
  return {
    malformed: token === null || pid === null || host === null || epoch === null,
    token,
    pid,
    host,
    epoch,
    acquiredAt,
  };
}

async function readLockSnapshot(path, { verify }) {
  try {
    await verify(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await verify(path);
      const stat = await handle.stat();
      let current;
      try {
        current = await lstat(path);
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      if (current.isSymbolicLink()) {
        throw new TrestleStateError('state path changed while it was in use', 'PATH_TRAVERSAL');
      }
      if (stat.dev !== current.dev || stat.ino !== current.ino) return null;
      const text = await handle.readFile('utf8');
      try {
        return { path, stat, info: normalizeLockInfo(JSON.parse(text)) };
      } catch {
        return { path, stat, info: normalizeLockInfo(null) };
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function describeLock(lock, { nowMs, staleMs, isProcessAlive }) {
  if (!lock) return null;
  const ageMs = lock.info.epoch === null ? null : Math.max(0, nowMs - lock.info.epoch);
  const sameHost = lock.info.host === HOST;
  const pidAlive = sameHost && lock.info.pid !== null ? Boolean(isProcessAlive(lock.info.pid)) : null;
  const status = lock.info.malformed
    ? 'operator-recovery-required'
    : sameHost && pidAlive === false
      ? 'operator-recovery-required'
      : sameHost && pidAlive === true
        ? 'live'
        : ageMs !== null && ageMs > staleMs
          ? 'operator-recovery-required'
          : 'live-or-unknown';
  return {
    path: lock.path,
    token: lock.info.token,
    pid: lock.info.pid,
    host: lock.info.host,
    epoch: lock.info.epoch,
    acquiredAt: lock.info.acquiredAt ?? (lock.info.epoch === null ? null : new Date(lock.info.epoch).toISOString()),
    ageMs,
    sameHost,
    pidAlive,
    malformed: lock.info.malformed,
    status,
    canAutoRecover: false,
    needsOperator: status === 'operator-recovery-required',
    staleMs,
    ino: lock.stat.ino,
    dev: lock.stat.dev,
    size: lock.stat.size,
  };
}

function unlockHint(context, lock, { recovery = false } = {}) {
  const hasToken = typeof lock?.token === 'string' && lock.token.length > 0;
  const hasInode = Number.isSafeInteger(lock?.ino);
  const hasDevice = Number.isSafeInteger(lock?.dev);
  const workstreamArgs = context.scope === 'workstream'
    ? ['--workstream', context.workstreamId ?? '<workstream-id>']
    : [];
  const rootArgs = context.projectRoot ? ['--root', context.projectRoot] : [];
  const baseArgs = [
    ...rootArgs,
    '--scope', context.scope,
    ...workstreamArgs,
    '--namespace', context.namespace,
    '--key', context.key,
    ...(recovery ? ['--recovery'] : []),
  ];
  const tokenArgs = hasToken ? ['--expected-token', lock.token] : [];
  const inodeArgs = hasInode ? ['--expected-inode', String(lock.ino)] : [];
  const deviceArgs = hasDevice ? ['--expected-device', String(lock.dev)] : [];
  return {
    tool: 'trestle_state_unlock',
    authorization: hasToken ? 'expected-token' : 'expected-identity',
    arguments: {
      scope: context.scope,
      namespace: context.namespace,
      key: context.key,
      ...(recovery ? { recovery: true } : {}),
      ...(hasToken ? { expectedToken: lock.token } : {}),
      ...(hasInode ? { expectedInode: lock.ino } : {}),
      ...(hasDevice ? { expectedDevice: lock.dev } : {}),
    },
    cli: `agent-trestle state-unlock ${baseArgs.concat(tokenArgs, inodeArgs, deviceArgs).join(' ')}`.trim(),
  };
}

function lockFailure(code, message, context, lock, extra = {}) {
  return new TrestleStateError(message, code, {
    ...(lock ? { lock } : {}),
    ...(lock ? { unlock: unlockHint(context, lock, { recovery: extra.recoveryBarrier === true }) } : {}),
    ...extra,
  });
}

async function createOwnedLock(path, {
  verify,
  clockMs = () => Date.now(),
  metadata = {},
} = {}) {
  await verify(path);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const token = lockToken();
  const identity = lockIdentity(token, clockMs, metadata);
  try {
    await handle.writeFile(`${JSON.stringify(identity)}\n`, 'utf8');
    await handle.sync();
    await verify(path);
    await assertHandleMatchesPath(handle, path);
    return { handle, token, identity };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function releaseOwnedLock(path, handle, token, verify, { beforeRemove } = {}) {
  let remove = false;
  try {
    const [opened, current] = await Promise.all([handle.stat(), readLockSnapshot(path, { verify })]);
    remove = Boolean(
      current
      && opened.dev === current.stat.dev
      && opened.ino === current.stat.ino
      && current.info.token === token,
    );
  } catch (error) {
    if (error.code !== 'ENOENT') {
      await handle.close().catch(() => {});
      throw error;
    }
  }
  if (remove) {
    await verify(path);
    const parentChain = await snapshotParentChain(path);
    await assertHandleMatchesPath(handle, path);
    await beforeRemove?.({ path, phase: 'release' });
    await verify(path);
    await assertParentChainStable(parentChain);
    await rm(path, { force: true });
  }
  await handle.close().catch(() => {});
}

async function snapshotParentChain(path) {
  const chain = [];
  let current = dirname(path);
  while (true) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new TrestleStateError(`lock parent contains a symbolic link: ${current}`, 'PATH_TRAVERSAL');
    }
    chain.push({ path: current, dev: info.dev, ino: info.ino });
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

async function assertParentChainStable(chain) {
  for (const expected of chain) {
    let current;
    try {
      current = await lstat(expected.path);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new TrestleStateError(
          `lock parent changed before removal: ${expected.path}`,
          'LOCK_REPLACED',
        );
      }
      throw error;
    }
    if (
      current.isSymbolicLink()
      || current.dev !== expected.dev
      || current.ino !== expected.ino
    ) {
      throw new TrestleStateError(
        `lock parent changed before removal: ${expected.path}`,
        'LOCK_REPLACED',
      );
    }
  }
}

/**
 * Re-open the lock with a no-follow descriptor and confirm its immutable file
 * identity (device + inode, and that it is not a symlink) still matches what the
 * caller authorized, immediately before unlinking. If the file was replaced,
 * swapped for a symlink, or vanished in the recovery window, fail closed with
 * LOCK_REPLACED instead of unlinking whatever now occupies the path. The parent
 * chain is also checked immediately before the pathname unlink. Node 20/22 do
 * not expose unlinkat(2), so this remains a checked pathname operation rather
 * than an atomic directory-capability operation.
 */
async function revalidateIdentityAndUnlink(path, {
  verify,
  expectedDev,
  expectedIno,
  context,
  lock,
  beforeOpen,
  beforeRemove,
}) {
  if (beforeOpen) await beforeOpen(path);
  await verify(path);
  const parentChain = await snapshotParentChain(path);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    // ENOENT: unlinked in the window. ELOOP: a symlink was swapped in and
    // O_NOFOLLOW refused to follow it. Both mean the authorized file is gone.
    if (error.code === 'ENOENT' || error.code === 'ELOOP') {
      throw lockFailure('LOCK_REPLACED', `lock ${path} was replaced before recovery could complete`, context, lock);
    }
    throw error;
  }
  try {
    const [opened, current] = await Promise.all([handle.stat(), lstat(path)]);
    const stable = !current.isSymbolicLink()
      && opened.dev === current.dev
      && opened.ino === current.ino
      && opened.dev === expectedDev
      && opened.ino === expectedIno;
    if (!stable) {
      throw lockFailure('LOCK_REPLACED', `lock ${path} was replaced before recovery could complete`, context, lock);
    }
    await verify(path);
    await assertParentChainStable(parentChain);
    await beforeRemove?.({ path, expectedDev, expectedIno });
    await verify(path);
    await assertParentChainStable(parentChain);
    const refreshed = await lstat(path);
    if (
      refreshed.isSymbolicLink()
      || refreshed.dev !== expectedDev
      || refreshed.ino !== expectedIno
    ) {
      throw lockFailure('LOCK_REPLACED', `lock ${path} was replaced before recovery could complete`, context, lock);
    }
    await rm(path, { force: true });
  } finally {
    await handle.close().catch(() => {});
  }
}

function identityInteger(value, name) {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TrestleStateError(`${name} must be a non-negative integer`, 'INVALID_LOCK_IDENTITY');
  }
  return parsed;
}

async function inspectLock(lockPath, {
  verify,
  nowMs = Date.now(),
  staleMs = LOCK_STALE_MS,
  isProcessAlive = defaultProcessAlive,
} = {}) {
  return describeLock(await readLockSnapshot(lockPath, { verify }), { nowMs, staleMs, isProcessAlive });
}

async function acquireRecoveryBarrier(recoveryPath, {
  verify,
  deadlineMs,
  clockMs = () => Date.now(),
  staleMs = LOCK_STALE_MS,
  isProcessAlive = defaultProcessAlive,
  context,
  metadata = {},
} = {}) {
  while (true) {
    try {
      return await createOwnedLock(recoveryPath, {
        verify,
        clockMs,
        metadata: { purpose: 'state-lock-recovery', ...metadata },
      });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const barrier = await inspectLock(recoveryPath, {
      verify,
      nowMs: clockMs(),
      staleMs,
      isProcessAlive,
    });
    if (!barrier) continue;
    if (barrier.canAutoRecover || barrier.needsOperator) {
      throw lockFailure(
        'LOCK_STALE',
        `recovery barrier ${recoveryPath} requires explicit operator recovery`,
        context,
        barrier,
        { recoveryBarrier: true },
      );
    }
    if (clockMs() >= deadlineMs) {
      throw lockFailure(
        'LOCK_TIMEOUT',
        `timed out serializing lock recovery ${recoveryPath}`,
        context,
        barrier,
      );
    }
    await sleep(LOCK_RETRY_MS);
  }
}

async function withLock(lockPath, action, {
  timeoutMs = LOCK_TIMEOUT_MS,
  staleMs = LOCK_STALE_MS,
  verify,
  isProcessAlive = defaultProcessAlive,
  clockMs = () => Date.now(),
  context,
  beforeRemove,
} = {}) {
  const started = clockMs();
  const deadlineMs = started + timeoutMs;
  const recoveryPath = `${lockPath}${LOCK_RECOVERY_SUFFIX}`;

  await verify(lockPath);
  await mkdir(dirname(lockPath), { recursive: true });
  await verify(lockPath);

  while (true) {
    const barrier = await inspectLock(recoveryPath, { verify, nowMs: clockMs(), staleMs, isProcessAlive });
    if (barrier) {
      if (barrier.canAutoRecover || barrier.needsOperator) {
        throw lockFailure(
          'LOCK_STALE',
          `recovery barrier ${recoveryPath} requires explicit operator recovery`,
          context,
          barrier,
          { recoveryBarrier: true },
        );
      }
      if (clockMs() >= deadlineMs) {
        throw lockFailure(
          'LOCK_TIMEOUT',
          `timed out waiting for lock recovery ${recoveryPath}`,
          context,
          barrier,
        );
      }
      await sleep(LOCK_RETRY_MS);
      continue;
    }

    let ownedLock;
    try {
      ownedLock = await createOwnedLock(lockPath, { verify, clockMs });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (ownedLock) {
      try {
        await verify(lockPath);
        await assertHandleMatchesPath(ownedLock.handle, lockPath);
        return await action();
      } finally {
        await releaseOwnedLock(lockPath, ownedLock.handle, ownedLock.token, verify, { beforeRemove });
      }
    }

    const observed = await inspectLock(lockPath, {
      verify,
      nowMs: clockMs(),
      staleMs,
      isProcessAlive,
    });
    if (!observed) continue;

    if (observed.needsOperator) {
      throw lockFailure(
        'LOCK_STALE',
        `lock ${lockPath} requires explicit operator recovery; automatic stale-lock deletion is disabled`,
        context,
        observed,
      );
    }

    if (clockMs() >= deadlineMs) {
      throw lockFailure(
        'LOCK_TIMEOUT',
        `timed out acquiring lock ${lockPath}`,
        context,
        observed,
      );
    }
    await sleep(LOCK_RETRY_MS);
  }
}

export class TrestleStateStore {
  constructor({
    projectStateRoot,
    workstreamStateRoot,
    configRoot,
    projectRoot = null,
    schemas,
    stateVersion = DEFAULT_VERSION,
    migrations = {},
    clock = () => new Date(),
    idGenerator = defaultId,
    lockTimeoutMs = LOCK_TIMEOUT_MS,
    lockStaleMs = LOCK_STALE_MS,
    isProcessAlive = defaultProcessAlive,
    lockClock = () => Date.now(),
    workstreamId = null,
    beforeUnlinkRevalidation = null,
    beforeRemove = null,
  }) {
    this.projectStateRoot = requireAbsoluteRoot('projectStateRoot', projectStateRoot);
    this.workstreamStateRoot = requireAbsoluteRoot('workstreamStateRoot', workstreamStateRoot);
    this.configRoot = requireAbsoluteRoot('configRoot', configRoot);
    this.projectRoot = requireAbsoluteRoot(
      'projectRoot',
      projectRoot ?? dirname(this.configRoot),
    );
    this.schemas = normalizeSchemas(schemas);
    this.stateVersion = stateVersion;
    this.migrations = migrations instanceof Map ? migrations : new Map(Object.entries(migrations).map(([key, value]) => [Number(key), value]));
    this.clock = clock;
    this.idGenerator = idGenerator;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockStaleMs = lockStaleMs;
    this.isProcessAlive = isProcessAlive;
    this.lockClock = lockClock;
    this.workstreamId = typeof workstreamId === 'string' && workstreamId.length > 0 ? workstreamId : null;
    this.beforeUnlinkRevalidation = typeof beforeUnlinkRevalidation === 'function' ? beforeUnlinkRevalidation : null;
    this.beforeRemove = typeof beforeRemove === 'function' ? beforeRemove : null;
    this.rootPins = undefined;
    this.rootPinsPromise = undefined;
  }

  #root(scope, namespace) {
    safeSegment(namespace, 'namespace');
    if (namespace === 'config') return { scopeRoot: this.configRoot, root: this.configRoot, pinName: 'config' };
    if (scope === 'project') {
      return {
        scopeRoot: this.projectStateRoot,
        root: resolve(this.projectStateRoot, 'namespaces', namespace),
        pinName: 'project',
      };
    }
    if (scope === 'workstream') {
      return {
        scopeRoot: this.workstreamStateRoot,
        root: resolve(this.workstreamStateRoot, 'namespaces', namespace),
        pinName: 'workstream',
      };
    }
    throw new TrestleStateError('scope must be project or workstream', 'INVALID_SCOPE');
  }

  #path({ scope = 'workstream', namespace, key }) {
    const { root, scopeRoot, pinName } = this.#root(scope, namespace);
    const keyParts = namespace === 'config' ? assertConfigArtifactKey(key) : safeKey(key);
    const path = resolve(root, ...keyParts) + '.json';
    assertWithin(root, path);
    return { root, scopeRoot, pinName, path };
  }

  #lockContext(options) {
    return {
      scope: options.scope ?? 'workstream',
      namespace: options.namespace,
      key: options.key,
      workstreamId: this.workstreamId,
      projectRoot: this.projectRoot,
    };
  }

  #lockPaths(pathSpec) {
    const lockPath = `${pathSpec.path}.lock`;
    return {
      lockPath,
      recoveryPath: `${lockPath}${LOCK_RECOVERY_SUFFIX}`,
    };
  }

  #lockOptions(context, pathSpec) {
    return {
      timeoutMs: this.lockTimeoutMs,
      staleMs: this.lockStaleMs,
      isProcessAlive: this.isProcessAlive,
      clockMs: this.lockClock,
      context,
      verify: (candidatePath = pathSpec.path) => this.#verifyPath({ ...pathSpec, path: candidatePath }),
      beforeUnlinkRevalidation: this.beforeUnlinkRevalidation,
      beforeRemove: this.beforeRemove,
    };
  }

  async #initializeRoots() {
    if (this.rootPins) return this.rootPins;
    if (!this.rootPinsPromise) {
      // Every pin must settle before this rejects. Promise.all surfaces the
      // first failure while the remaining pins are still creating their
      // directories, so a caller that reacts to the rejection by clearing the
      // state root races those pending mkdirs and sees a spurious ENOTEMPTY.
      // Settling first also lets the pins that did succeed hand back their
      // descriptors, which Promise.all leaks on every failed initialisation.
      this.rootPinsPromise = Promise.allSettled([
        pinDirectory(this.projectStateRoot, { create: true }),
        pinDirectory(this.workstreamStateRoot, { create: true }),
        pinDirectory(this.configRoot, { create: true }),
      ]).then(async (results) => {
        const failure = results.find((result) => result.status === 'rejected');
        if (failure) {
          for (const result of results) {
            if (result.status === 'fulfilled') await releasePin(result.value);
          }
          throw failure.reason;
        }
        const [project, workstream, config] = results.map((result) => result.value);
        this.rootPins = { project, workstream, config };
        return this.rootPins;
      });
    }
    return this.rootPinsPromise;
  }

  async #verifyPath({ pinName, path }) {
    const pins = await this.#initializeRoots();
    try {
      await verifyDescendant(pins[pinName], path);
    } catch (error) {
      if (error.code === 'PATH_TRAVERSAL') {
        throw new TrestleStateError(error.message, 'PATH_TRAVERSAL');
      }
      throw error;
    }
  }

  async #readFile(pathSpec) {
    await this.#verifyPath(pathSpec);
    const handle = await open(pathSpec.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await this.#verifyPath(pathSpec);
      await assertHandleMatchesPath(handle, pathSpec.path);
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  }

  async #writeEnvelope(pathSpec, envelope) {
    const pending = `${pathSpec.path}.pending-${safeSegment(String(this.idGenerator()), 'generated ID')}`;
    const pendingSpec = { ...pathSpec, path: pending };
    await this.#verifyPath(pendingSpec);
    const handle = await open(
      pending,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
      await handle.sync();
      await this.#verifyPath(pendingSpec);
      await assertHandleMatchesPath(handle, pending);
      await this.#verifyPath(pathSpec);
      await rename(pending, pathSpec.path);
      await this.#verifyPath(pathSpec);
    } catch (error) {
      await handle.close().catch(() => {});
      await this.#verifyPath(pendingSpec).then(() => rm(pending, { force: true })).catch(() => {});
      throw error;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  #assertMutable(namespace) {
    if (namespace === 'config') {
      throw new TrestleStateError('config is immutable through the state API', 'IMMUTABLE_NAMESPACE');
    }
    const schema = this.schemas.get(namespace);
    if (!schema) {
      throw new TrestleStateError(`namespace ${namespace} has no registered schema`, 'SCHEMA_REQUIRED');
    }
    return schema;
  }

  async #readEnvelope(options, { missing = 'throw' } = {}) {
    const pathSpec = this.#path(options);
    let envelope;
    try {
      envelope = JSON.parse(await this.#readFile(pathSpec));
    } catch (error) {
      if (error.code === 'ENOENT' && missing === 'undefined') return undefined;
      if (error.code === 'ENOENT') throw new TrestleStateError('state entry not found', 'NOT_FOUND');
      if (error instanceof SyntaxError) throw new TrestleStateError('state entry is not valid JSON', 'CORRUPT_STATE');
      throw error;
    }
    if (options.namespace === 'config' && (!envelope || !Number.isInteger(envelope.trestleStateVersion))) {
      return {
        trestleStateVersion: this.stateVersion,
        namespace: 'config',
        value: envelope,
      };
    }
    if (!envelope || typeof envelope !== 'object' || !Number.isInteger(envelope.trestleStateVersion)) {
      throw new TrestleStateError('state entry has no valid version metadata', 'CORRUPT_STATE');
    }
    if (envelope.trestleStateVersion > this.stateVersion) {
      throw new TrestleStateError('state entry was written by a newer version', 'UNSUPPORTED_VERSION');
    }
    let migrated = envelope;
    while (migrated.trestleStateVersion < this.stateVersion) {
      const migrate = this.migrations.get(migrated.trestleStateVersion);
      if (!migrate) throw new TrestleStateError(`no migration from version ${migrated.trestleStateVersion}`, 'MIGRATION_REQUIRED');
      const next = await migrate(structuredClone(migrated), {
        fromVersion: migrated.trestleStateVersion,
        toVersion: migrated.trestleStateVersion + 1,
        ...options,
      });
      migrated = { ...next, trestleStateVersion: migrated.trestleStateVersion + 1 };
    }
    return migrated;
  }

  async read(options) {
    return (await this.#readEnvelope(options)).value;
  }

  async lockStatus(options) {
    const pathSpec = this.#path(options);
    const context = this.#lockContext(options);
    const { lockPath, recoveryPath } = this.#lockPaths(pathSpec);
    const lockOptions = this.#lockOptions(context, pathSpec);
    const [lock, recovery] = await Promise.all([
      inspectLock(lockPath, lockOptions),
      inspectLock(recoveryPath, lockOptions),
    ]);
    const recoverable = Boolean(lock && (lock.needsOperator || lock.canAutoRecover));
    const recoveryRecoverable = Boolean(recovery && (recovery.needsOperator || recovery.canAutoRecover));
    return {
      locked: Boolean(lock),
      lock,
      recovery,
      unlock: recoverable ? unlockHint(context, lock) : null,
      recoveryUnlock: recoveryRecoverable ? unlockHint(context, recovery, { recovery: true }) : null,
    };
  }

  async unlock(options) {
    const recoveryMode = options.recovery === true;
    const providedToken = options.expectedToken !== undefined
      && options.expectedToken !== null
      && options.expectedToken !== '';
    const expectedToken = providedToken ? safeSegment(options.expectedToken, 'expectedToken') : null;
    const expectedInode = identityInteger(options.expectedInode, 'expectedInode');
    const expectedDevice = identityInteger(options.expectedDevice, 'expectedDevice');

    // Tokenless recovery is a narrow escape hatch for locks that are malformed
    // (e.g. a zero-length file left by a crash between O_CREAT and the identity
    // write). Because there is no token to prove ownership, the operator must
    // instead pin the exact immutable file identity: both inode AND device.
    if (!providedToken && (expectedInode === undefined || expectedDevice === undefined)) {
      throw new TrestleStateError(
        'tokenless malformed-lock recovery requires both expectedInode and expectedDevice',
        'UNLOCK_AUTHORIZATION_REQUIRED',
      );
    }

    const pathSpec = this.#path(options);
    const context = this.#lockContext(options);
    const { lockPath, recoveryPath } = this.#lockPaths(pathSpec);
    const lockOptions = this.#lockOptions(context, pathSpec);
    const targetPath = recoveryMode ? recoveryPath : lockPath;
    const targetOptions = {
      ...lockOptions,
      verify: (candidatePath = targetPath) => this.#verifyPath({ ...pathSpec, path: candidatePath }),
    };
    const barrier = recoveryMode
      ? null
      : await acquireRecoveryBarrier(recoveryPath, {
        ...lockOptions,
        deadlineMs: lockOptions.clockMs() + lockOptions.timeoutMs,
      });
    try {
      const lock = await inspectLock(targetPath, targetOptions);
      if (!lock) {
        return { unlocked: false, reason: 'missing', lock: null };
      }
      if (providedToken) {
        if (lock.token !== expectedToken) {
          throw lockFailure(
            'LOCK_TOKEN_MISMATCH',
            `lock ${lockPath} no longer matches expected token`,
            context,
            lock,
            { expectedToken },
          );
        }
      } else if (!lock.malformed) {
        // A well-formed lock carries a token; tokenless recovery must never
        // clear a valid tokened lock (or, by construction, a live one).
        throw lockFailure(
          'LOCK_TOKEN_REQUIRED',
          `refusing tokenless unlock of a valid lock at ${lockPath}; supply --expected-token`,
          context,
          lock,
        );
      }
      if (expectedInode !== undefined && lock.ino !== expectedInode) {
        throw lockFailure(
          'LOCK_IDENTITY_MISMATCH',
          `lock ${lockPath} no longer matches expected inode`,
          context,
          lock,
          { expectedInode },
        );
      }
      if (expectedDevice !== undefined && lock.dev !== expectedDevice) {
        throw lockFailure(
          'LOCK_IDENTITY_MISMATCH',
          `lock ${lockPath} no longer matches expected device`,
          context,
          lock,
          { expectedDevice },
        );
      }
      if (!lock.canAutoRecover && !lock.needsOperator) {
        throw lockFailure(
          'LOCK_NOT_STALE',
          `refusing to unlock a live or indeterminate lock at ${lockPath}`,
          context,
          lock,
        );
      }
      await revalidateIdentityAndUnlink(targetPath, {
        verify: targetOptions.verify,
        expectedDev: lock.dev,
        expectedIno: lock.ino,
        context,
        lock,
        beforeOpen: this.beforeUnlinkRevalidation,
        beforeRemove: this.beforeRemove,
      });
      return { unlocked: true, lock, ...(recoveryMode ? { recovery: true } : {}) };
    } finally {
      if (barrier) {
        await releaseOwnedLock(recoveryPath, barrier.handle, barrier.token, lockOptions.verify);
      }
    }
  }

  async write(options) {
    const { namespace, value } = options;
    const schema = this.#assertMutable(namespace);
    validateSchema(value, schema);
    const pathSpec = this.#path(options);
    const context = this.#lockContext(options);
    const { lockPath } = this.#lockPaths(pathSpec);
    const lockOptions = this.#lockOptions(context, pathSpec);
    await this.#verifyPath(pathSpec);
    const envelope = {
      trestleStateVersion: this.stateVersion,
      namespace,
      updatedAt: this.clock().toISOString(),
      value,
    };
    await withLock(lockPath, async () => {
      await mkdir(dirname(pathSpec.path), { recursive: true });
      await this.#verifyPath(pathSpec);
      await this.#writeEnvelope(pathSpec, envelope);
    }, lockOptions);
    return envelope;
  }

  async append(options) {
    const schema = this.#assertMutable(options.namespace);
    const pathSpec = this.#path(options);
    const context = this.#lockContext(options);
    const { lockPath } = this.#lockPaths(pathSpec);
    const lockOptions = this.#lockOptions(context, pathSpec);
    await this.#verifyPath(pathSpec);
    return withLock(lockPath, async () => {
      const current = await this.#readEnvelope(options, { missing: 'undefined' });
      const previous = current?.value ?? [];
      if (!Array.isArray(previous)) {
        throw new TrestleStateError('append target is not an array', 'NOT_APPENDABLE');
      }
      const value = [...previous, options.value];
      validateSchema(value, schema);
      const envelope = {
        trestleStateVersion: this.stateVersion,
        namespace: options.namespace,
        updatedAt: this.clock().toISOString(),
        value,
      };
      await mkdir(dirname(pathSpec.path), { recursive: true });
      await this.#verifyPath(pathSpec);
      await this.#writeEnvelope(pathSpec, envelope);
      return envelope;
    }, lockOptions);
  }

  async delete(options) {
    this.#assertMutable(options.namespace);
    const pathSpec = this.#path(options);
    const context = this.#lockContext(options);
    const { lockPath } = this.#lockPaths(pathSpec);
    const lockOptions = this.#lockOptions(context, pathSpec);
    await this.#verifyPath(pathSpec);
    return withLock(lockPath, async () => {
      const existed = await pathExists(pathSpec.path, lockOptions.verify);
      await this.#verifyPath(pathSpec);
      await rm(pathSpec.path, { force: true });
      await this.#verifyPath({ ...pathSpec, path: dirname(pathSpec.path) });
      return { deleted: existed };
    }, lockOptions);
  }

  async list({ scope = 'workstream', namespace, prefix = '' }) {
    const { root, pinName } = this.#root(scope, namespace);
    if (namespace === 'config' && prefix !== '') {
      throw new TrestleStateError(
        'config listing does not support nested prefixes',
        'INVALID_PATH',
      );
    }
    const prefixParts = namespace === 'config'
      ? (prefix === '' ? [] : assertConfigArtifactKey(prefix))
      : (prefix === '' ? [] : safeKey(prefix));
    const start = resolve(root, ...prefixParts);
    assertWithin(root, start);
    await this.#verifyPath({ pinName, path: start });
    const entries = [];
    const walk = async (directory) => {
      let children;
      try {
        await this.#verifyPath({ pinName, path: directory });
        children = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        if (child.name.endsWith('.lock') || child.name.endsWith(LOCK_RECOVERY_SUFFIX) || child.name.includes('.pending-')) continue;
        const childPath = resolve(directory, child.name);
        assertWithin(root, childPath);
        if (child.isSymbolicLink()) {
          throw new TrestleStateError('state paths may not contain symbolic links', 'PATH_TRAVERSAL');
        }
        await this.#verifyPath({ pinName, path: childPath });
        if (child.isDirectory()) {
          if (namespace === 'config') {
            throw new TrestleStateError(
              'config surface contains a nested artifact directory',
              'CONFIG_ARTIFACT_REJECTED',
            );
          }
          await walk(childPath);
        }
        else if (child.isFile() && child.name.endsWith('.json')) {
          entries.push(relative(root, childPath).split(sep).join('/').slice(0, -5));
        }
      }
    };
    await walk(start);
    return entries;
  }

  async health() {
    const pins = await this.#initializeRoots();
    await Promise.all(Object.values(pins).map((pin) => verifyPinnedDirectory(pin)));
    return {
      ok: true,
      stateVersion: this.stateVersion,
      topology: 'server-per-workstream',
      lockRecovery: {
        timeoutMs: this.lockTimeoutMs,
        staleMs: this.lockStaleMs,
        sameHostDeadPidAutoRecovery: false,
        automaticStaleLockDeletion: false,
        remoteOrIndeterminateRecovery: 'explicit-unlock-required',
      },
      roots: {
        project: this.projectStateRoot,
        workstream: this.workstreamStateRoot,
        config: this.configRoot,
      },
      namespaces: [...this.schemas.keys()].sort(),
    };
  }

  async decide({ scope = 'workstream', decisionId, decision }) {
    safeSegment(decisionId, 'decisionId');
    if (!this.schemas.has('decisions')) {
      throw new TrestleStateError('decisions namespace requires a registered schema', 'SCHEMA_REQUIRED');
    }
    return this.write({ scope, namespace: 'decisions', key: decisionId, value: decision });
  }
}

export function createTrestleStateStore(options) {
  return new TrestleStateStore(options);
}

export const StateStore = TrestleStateStore;
export const createStateStore = createTrestleStateStore;
export const trestle_state_read = (store, input) => store.read(input);
export const trestle_state_write = (store, input) => store.write(input);
export const trestle_state_append = (store, input) => store.append(input);
export const trestle_state_delete = (store, input) => store.delete(input);
export const trestle_state_list = (store, input) => store.list(input);
export const trestle_state_health = (store) => store.health();
export const trestle_state_lock_status = (store, input) => store.lockStatus(input);
export const trestle_state_unlock = (store, input) => store.unlock(input);
export const trestle_decide = (store, input) => store.decide(input);
