import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, readdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  assertFileHandleMatchesPath,
  openVerifiedFile,
  pinDirectory,
  readVerifiedFile,
  releasePin,
  removeVerifiedFile,
  verifyDescendant,
  verifyPinnedDirectory,
} from "../security/path-security.mjs";

const GENESIS_HASH = "0".repeat(64);
const HOST = hostname();
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;

export class AuditIntegrityError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = "AuditIntegrityError";
    this.code = "AUDIT_INTEGRITY";
    this.details = details;
  }
}

function safeId(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new TypeError(`${name} contains invalid characters`);
  }
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashAuditRecord(record) {
  const { hash: ignored, ...hashable } = record;
  return createHash("sha256").update(canonicalize(hashable)).digest("hex");
}

function verifyRecords(records, path, expected = {}) {
  let priorHash = GENESIS_HASH;
  const identity = {
    ...expected,
    writerId: expected.writerId ?? records[0]?.writerId,
  };
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const sequence = index + 1;
    if (record.sequence !== sequence) {
      throw new AuditIntegrityError(`invalid sequence at record ${sequence}`, { path, expected: sequence, actual: record.sequence });
    }
    if (record.priorHash !== priorHash) {
      throw new AuditIntegrityError(`broken prior hash at record ${sequence}`, { path });
    }
    for (const field of ["runId", "taskId", "writerId"]) {
      if (identity[field] !== undefined && record[field] !== identity[field]) {
        throw new AuditIntegrityError(`${field} changed within segment`, { path, sequence });
      }
    }
    const calculated = hashAuditRecord(record);
    if (record.hash !== calculated) {
      throw new AuditIntegrityError(`hash mismatch at record ${sequence}`, { path, expected: calculated, actual: record.hash });
    }
    priorHash = record.hash;
  }
  return { ok: true, path, records: records.length, headHash: priorHash };
}

function defaultProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function readLockInfo(rootPin, path, securityOptions) {
  try {
    const info = JSON.parse(await readVerifiedFile(rootPin, path, securityOptions));
    if (info && typeof info === "object" && typeof info.token === "string") return info;
    return { malformed: true, token: null };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.code === "PATH_TRAVERSAL") {
      // A competing holder may unlink its lock after this reader opened its
      // verified descriptor but before the pathname identity recheck. That is
      // an ordinary release, not a containment breach; retry acquisition. A
      // surviving symlink remains a hard failure.
      try {
        if ((await lstat(path)).isSymbolicLink()) throw error;
        return null;
      } catch (lstatError) {
        if (lstatError.code === "ENOENT") return null;
        throw lstatError;
      }
    }
    return { malformed: true, token: null };
  }
}

function lockIsStale(info, { now, staleMs, isProcessAlive }) {
  if (!info) return false;
  if (info.malformed) return true;
  const age = now - (typeof info.epoch === "number" ? info.epoch : 0);
  if (info.host === HOST && !isProcessAlive(info.pid)) return true;
  return age > staleMs;
}

async function writeLockIdentity(rootPin, path, handle, token, clock) {
  const identity = {
    token,
    pid: process.pid,
    host: HOST,
    epoch: clock(),
    acquiredAt: new Date().toISOString(),
  };
  await verifyDescendant(rootPin, path, { allowMissing: false });
  await assertFileHandleMatchesPath(handle, path);
  await handle.writeFile(JSON.stringify(identity));
  return identity;
}

// A fully-written private O_EXCL/O_NOFOLLOW file is hard-linked to the public
// lock path. link() cannot overwrite a destination, so contenders never observe
// a partial lock identity and only one can publish a lock.
async function createLock(rootPin, lockPath, token, clock, securityOptions) {
  const pendingPath = `${lockPath}.pending-${randomBytes(16).toString("hex")}`;
  const { handle, identity } = await openVerifiedFile(rootPin, pendingPath, {
    ...securityOptions,
    flags: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    mode: 0o600,
    allowMissing: true,
  });
  let published = false;
  try {
    await writeLockIdentity(rootPin, pendingPath, handle, token, clock);
    await verifyDescendant(rootPin, lockPath, { allowMissing: true });
    try {
      await link(pendingPath, lockPath);
    } catch (error) {
      if (error.code === "EEXIST") return null;
      throw error;
    }
    await verifyDescendant(rootPin, lockPath, { allowMissing: false });
    await assertFileHandleMatchesPath(handle, lockPath);
    published = true;
    await removeVerifiedFile(rootPin, pendingPath, identity).catch(() => {});
    return { handle, identity };
  } finally {
    if (!published) {
      await handle.close().catch(() => {});
      await removeVerifiedFile(rootPin, pendingPath, identity).catch(() => {});
    }
  }
}

async function createOwnedSegment(rootPin, makeCandidate, clock, securityOptions) {
  let lastError;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const candidate = await makeCandidate();
    const token = randomBytes(16).toString("hex");
    const lock = await createLock(rootPin, candidate.lockPath, token, clock, securityOptions);
    if (lock) return { ...candidate, ...lock, token };
    lastError = new Error(`audit lock collision at ${candidate.lockPath}`);
  }
  throw lastError ?? new Error("unable to allocate a fresh audit segment");
}

// On a stale home lock, writers never rename or remove it. They route around it
// to an exclusively-created segment, preserving both the abandoned evidence and
// the atomic ownership invariant.
async function acquireSegment(rootPin, home, {
  makeCandidate,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  staleMs = DEFAULT_LOCK_STALE_MS,
  isProcessAlive = defaultProcessAlive,
  clock = () => Date.now(),
  securityOptions,
} = {}) {
  await mkdir(dirname(home.lockPath), { recursive: true });
  await verifyDescendant(rootPin, dirname(home.lockPath), { allowMissing: false });
  const started = clock();
  for (;;) {
    const token = randomBytes(16).toString("hex");
    const lock = await createLock(rootPin, home.lockPath, token, clock, securityOptions);
    if (lock) return { ...home, ...lock, token, rolledOver: false };

    const info = await readLockInfo(rootPin, home.lockPath, securityOptions);
    const now = clock();
    if (lockIsStale(info, { now, staleMs, isProcessAlive })) {
      const owned = await createOwnedSegment(rootPin, makeCandidate, clock, securityOptions);
      return { ...owned, rolledOver: true };
    }
    if (now - started > timeoutMs) throw new Error(`timed out acquiring audit lock ${home.lockPath}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function releaseLock(rootPin, path, handle, identity, token, securityOptions) {
  try {
    const info = await readLockInfo(rootPin, path, securityOptions);
    if (info?.token === token) {
      await assertFileHandleMatchesPath(handle, path);
      await removeVerifiedFile(rootPin, path, identity);
    }
  } finally {
    await handle.close();
  }
}

async function readRecords(rootPin, path, securityOptions) {
  try {
    const text = await readVerifiedFile(rootPin, path, securityOptions);
    if (!text.trim()) return [];
    return text.trimEnd().split("\n").map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new AuditIntegrityError(`invalid JSON at line ${index + 1}`, { path, line: index + 1 });
      }
    });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function assertAbsoluteRoot(root) {
  if (typeof root !== "string" || !isAbsolute(root)) throw new TypeError("auditRoot must be an explicit absolute path");
  return resolve(root);
}

export class AuditSegmentWriter {
  constructor({
    auditRoot,
    runId,
    taskId,
    writerId,
    clock = () => new Date(),
    idGenerator = () => `${process.pid}`,
    lockTimeoutMs,
    lockStaleMs,
    isProcessAlive,
    lockClock,
    beforeOpen,
    beforeUse,
  }) {
    this.auditRoot = assertAbsoluteRoot(auditRoot);
    this.runId = safeId(runId, "runId");
    this.taskId = safeId(taskId, "taskId");
    this.writerId = safeId(writerId, "writerId");
    this.clock = clock;
    this.idGenerator = idGenerator;
    this.segmentId = safeId(String(this.idGenerator()), "segmentId");
    this.segmentDirectory = resolve(this.auditRoot, "runs", this.runId, "tasks", this.taskId, "segments");
    this.segmentPath = resolve(this.segmentDirectory, `${this.writerId}--${this.segmentId}.ndjson`);
    const rel = relative(this.auditRoot, this.segmentPath);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new TypeError("audit path escapes root");
    this.lockPath = `${this.segmentPath}.lock`;
    this.lockOptions = {
      timeoutMs: lockTimeoutMs,
      staleMs: lockStaleMs,
      isProcessAlive,
      clock: lockClock,
    };
    this.securityOptions = { beforeOpen, beforeUse };
    this._rootPin = null;
    this._appendChain = Promise.resolve();
  }

  _serialized(fn) {
    const result = this._appendChain.then(fn, fn);
    this._appendChain = result.then(() => undefined, () => undefined);
    return result;
  }

  _fileSecurityOptions(operation) {
    const { beforeOpen, beforeUse } = this.securityOptions;
    return {
      beforeOpen: beforeOpen && ((details) => beforeOpen({ operation, ...details })),
      beforeUse: beforeUse && ((details) => beforeUse({ operation, ...details })),
    };
  }

  async _freshCandidate() {
    const segmentId = safeId(`roll-${randomBytes(12).toString("hex")}`, "segmentId");
    const segmentPath = resolve(this.segmentDirectory, `${this.writerId}--${segmentId}.ndjson`);
    const lockPath = `${segmentPath}.lock`;
    await verifyDescendant(this._rootPin, segmentPath, { allowMissing: true });
    await verifyDescendant(this._rootPin, lockPath, { allowMissing: true });
    return { segmentId, segmentPath, lockPath };
  }

  async _resolveSafePaths() {
    if (this._rootPin) {
      await verifyPinnedDirectory(this._rootPin);
    } else {
      this._rootPin = await pinDirectory(this.auditRoot, { create: true });
    }
    await verifyDescendant(this._rootPin, this.segmentDirectory, { allowMissing: true });
    await mkdir(this.segmentDirectory, { recursive: true });
    await verifyDescendant(this._rootPin, this.segmentDirectory, { allowMissing: false });
    await verifyDescendant(this._rootPin, this.segmentPath, { allowMissing: true });
    await verifyDescendant(this._rootPin, this.lockPath, { allowMissing: true });
  }

  async append(event) {
    if (event === undefined) throw new TypeError("event is required");
    let eventSnapshot;
    try {
      eventSnapshot = JSON.parse(JSON.stringify(event));
    } catch {
      throw new TypeError("event must be JSON-serializable");
    }
    return this._serialized(async () => {
      await this._resolveSafePaths();
      const acquired = await acquireSegment(
        this._rootPin,
        { segmentId: this.segmentId, segmentPath: this.segmentPath, lockPath: this.lockPath },
        {
          ...this.lockOptions,
          makeCandidate: () => this._freshCandidate(),
          securityOptions: this._fileSecurityOptions("lock"),
        },
      );
      if (acquired.rolledOver) {
        this.segmentId = acquired.segmentId;
        this.segmentPath = acquired.segmentPath;
        this.lockPath = acquired.lockPath;
      }
      try {
        const records = await readRecords(
          this._rootPin,
          acquired.segmentPath,
          this._fileSecurityOptions("segment-read"),
        );
        verifyRecords(records, acquired.segmentPath, {
          runId: this.runId,
          taskId: this.taskId,
          writerId: this.writerId,
        });
        const prior = records.at(-1);
        const record = {
          sequence: records.length + 1,
          writerId: this.writerId,
          runId: this.runId,
          taskId: this.taskId,
          timestamp: this.clock().toISOString(),
          priorHash: prior?.hash ?? GENESIS_HASH,
          event: eventSnapshot,
        };
        record.hash = hashAuditRecord(record);
        const { handle } = await openVerifiedFile(this._rootPin, acquired.segmentPath, {
          ...this._fileSecurityOptions("segment-append"),
          flags: constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
          mode: 0o600,
          allowMissing: true,
        });
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`);
        } finally {
          await handle.close();
        }
        return record;
      } finally {
        await releaseLock(
          this._rootPin,
          acquired.lockPath,
          acquired.handle,
          acquired.identity,
          acquired.token,
          this._fileSecurityOptions("lock"),
        );
      }
    });
  }

  async verify() {
    await this._resolveSafePaths();
    return verifyAuditSegment(this.segmentPath, {
      runId: this.runId,
      taskId: this.taskId,
      writerId: this.writerId,
    }, {
      rootPin: this._rootPin,
      securityOptions: this._fileSecurityOptions("segment-read"),
    });
  }
}

export function createAuditSegmentWriter(options) {
  return new AuditSegmentWriter(options);
}

export async function verifyAuditSegment(path, expected = {}, {
  rootPin,
  securityOptions,
} = {}) {
  const pin = rootPin ?? await pinDirectory(dirname(resolve(path)));
  try {
    const records = await readRecords(pin, path, securityOptions);
    return verifyRecords(records, path, expected);
  } finally {
    if (pin !== rootPin) await releasePin(pin);
  }
}

export async function reconcileAuditTask({ auditRoot, runId, taskId }) {
  const root = assertAbsoluteRoot(auditRoot);
  safeId(runId, "runId");
  safeId(taskId, "taskId");
  const rootPin = await pinDirectory(root, { create: true });
  try {
    const directory = resolve(rootPin.path, "runs", runId, "tasks", taskId, "segments");
    await verifyDescendant(rootPin, directory, { allowMissing: true });
    let names;
    try {
      names = (await readdir(directory)).filter((name) => name.endsWith(".ndjson")).sort();
    } catch (error) {
      if (error.code === "ENOENT") return { records: [], segments: [], reconciliationHash: createHash("sha256").update("").digest("hex") };
      throw error;
    }
    const segments = [];
    const records = [];
    for (const name of names) {
      const path = resolve(directory, name);
      await verifyDescendant(rootPin, path, { allowMissing: false });
      const verification = await verifyAuditSegment(path, { runId, taskId }, { rootPin });
      segments.push({ name, ...verification });
      records.push(...await readRecords(rootPin, path));
    }
    records.sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp)
      || left.writerId.localeCompare(right.writerId)
      || left.sequence - right.sequence
      || left.hash.localeCompare(right.hash));
    const reconciliationHash = createHash("sha256").update(records.map((record) => record.hash).join("\n")).digest("hex");
    return { records, segments, reconciliationHash };
  } finally {
    await releasePin(rootPin);
  }
}

export { GENESIS_HASH };
export const AuditWriter = AuditSegmentWriter;
export const createAuditWriter = createAuditSegmentWriter;
export const verifyAuditChain = verifyAuditSegment;
export const reconcileAuditSegments = reconcileAuditTask;
