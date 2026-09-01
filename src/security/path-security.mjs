import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

export class PathSecurityError extends Error {
  constructor(message, code = "PATH_TRAVERSAL") {
    super(message);
    this.name = "PathSecurityError";
    this.code = code;
  }
}

export function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Recognises the location Windows moves an entry to when it is deleted while a
 * handle is still open.
 *
 * NTFS implements POSIX-style delete-while-open by unlinking the name from its
 * directory and parking the file under the reserved metadata directory
 * `\$Extend\$Deleted` until the last handle closes. `lstat` on the original
 * name reports `ENOENT`, exactly as POSIX would, but `realpath` still resolves
 * it - to that reserved location. Read literally, a lock file another writer
 * has just released therefore looks like a path that escaped the pinned root.
 *
 * `\$Extend` is NTFS-internal: user code cannot create, rename into, or write
 * inside it, so matching it can only ever mean "this entry was unlinked" and
 * cannot be used to smuggle a path past containment.
 */
function isDeletePending(resolved) {
  return /^(?:\\\\\?\\)?[A-Za-z]:\\\$Extend\\\$Deleted\\/i.test(resolved);
}

/**
 * Whether a failure to resolve or open a name means it is simply not there.
 *
 * POSIX says `ENOENT`. Windows says `ENOENT` too once the entry is fully gone,
 * but during the delete-pending window - after the unlink, before the last
 * handle closes - libuv surfaces the same condition as `EPERM`, `EBADF` or
 * `EBUSY` depending on which syscall observed it. All three have been seen from
 * `realpath` and `open` against a lock file another writer had just released.
 *
 * Treating them as hard errors made an ordinary lock release look like a
 * containment failure to every concurrent reader. Walking up to the nearest
 * resolvable ancestor is the behaviour `ENOENT` already gets, and it is equally
 * safe: the lexical containment check and the per-component symlink scan have
 * both already run before this point.
 */
const WINDOWS_VANISHED_CODES = new Set(["EPERM", "EBADF", "EBUSY"]);

function isMissingDuringResolve(error, { platform = process.platform } = {}) {
  return error.code === "ENOENT"
    || (platform === "win32" && WINDOWS_VANISHED_CODES.has(error.code));
}

async function assertNoSymlinkComponents(target, { allowMissing = false } = {}) {  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT" && allowMissing) return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new PathSecurityError(`Path must not contain symbolic links: ${target}`);
    }
  }
}

/**
 * Open directory handles backing live pins, keyed by the pin itself.
 *
 * The handle is deliberately *not* a property of the pin: pins are frozen plain
 * data that callers embed in audit records and pass across module boundaries, so
 * they must stay serialisable. A `WeakMap` keeps the resource private and lets an
 * unreleased pin be collected normally.
 */
const PIN_HANDLES = new WeakMap();
const RELEASED_PINS = new WeakSet();

const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY
  | (Number.isInteger(constants.O_DIRECTORY) ? constants.O_DIRECTORY : 0)
  | (Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : 0);

/**
 * Holds the pinned directory open so its inode cannot be recycled.
 *
 * `dev`+`ino` alone cannot detect an `rm`+`mkdir` swap at the same pathname:
 * Linux filesystems (ext4, overlayfs) hand the freed inode number straight back
 * to the replacement directory, so the replacement is indistinguishable from the
 * original. Holding a descriptor keeps the original inode allocated, which both
 * forces the replacement onto a different inode number and lets the removal be
 * observed directly as `nlink === 0`.
 *
 * Platforms that cannot hold a directory descriptor degrade to identity-only
 * detection rather than failing the pin outright; the caller-facing containment
 * guarantee there comes from `assertSecurelyHeldDirectory`.
 */
async function openPinnedDirectory(absolute) {
  try {
    return await open(absolute, DIRECTORY_OPEN_FLAGS);
  } catch (error) {
    if (error.code === "ELOOP") {
      throw new PathSecurityError(`Path must not contain symbolic links: ${absolute}`);
    }
    if (["EISDIR", "EPERM", "ENOTSUP", "EINVAL", "ENOSYS"].includes(error.code)) return null;
    throw error;
  }
}

export async function pinDirectory(target, { create = false } = {}) {
  const absolute = path.resolve(target);
  await assertNoSymlinkComponents(absolute, { allowMissing: create });
  if (create) await mkdir(absolute, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(absolute);
  const info = await stat(absolute);
  if (!info.isDirectory()) throw new PathSecurityError(`Path is not a directory: ${target}`, "INVALID_ROOT");
  const pinnedRealPath = await realpath(absolute);
  if (pinnedRealPath !== absolute) {
    throw new PathSecurityError(`Directory real path differs from configured path: ${target}`);
  }
  const handle = await openPinnedDirectory(absolute);
  let identity = { dev: info.dev, ino: info.ino };
  if (handle) {
    try {
      const held = await handle.stat();
      if (!held.isDirectory() || held.dev !== info.dev || held.ino !== info.ino) {
        throw new PathSecurityError(`Directory identity changed after validation: ${target}`);
      }
      identity = { dev: held.dev, ino: held.ino };
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }
  const pin = Object.freeze({
    path: absolute,
    realPath: pinnedRealPath,
    identity: Object.freeze(identity),
  });
  if (handle) PIN_HANDLES.set(pin, handle);
  return pin;
}

/**
 * Closes the descriptor held by `pin`. Idempotent, and a no-op for pins that
 * never acquired one (test doubles, unsupported platforms). Long-lived holders
 * that pin a root for the lifetime of the process may skip this; anything that
 * pins per operation must release, or it leaks a descriptor per call.
 */
export async function releasePin(pin) {
  const handle = pin ? PIN_HANDLES.get(pin) : undefined;
  if (!handle) return false;
  PIN_HANDLES.delete(pin);
  RELEASED_PINS.add(pin);
  await handle.close().catch(() => {});
  return true;
}

export async function verifyPinnedDirectory(pin) {
  // A released pin no longer holds its inode, so replacement is undetectable.
  // Fail closed rather than silently downgrading to the weaker identity check.
  if (RELEASED_PINS.has(pin)) {
    throw new PathSecurityError(`Directory pin was already released: ${pin.path}`, "PIN_RELEASED");
  }
  await assertNoSymlinkComponents(pin.path);
  const currentRealPath = await realpath(pin.path);
  if (currentRealPath !== pin.realPath) {
    throw new PathSecurityError(`Directory identity changed after validation: ${pin.path}`);
  }
  const handle = PIN_HANDLES.get(pin);
  if (handle) {
    // The pinned inode stays allocated for as long as this descriptor lives, so
    // an unlinked directory reports a zero link count even when the pathname was
    // immediately recreated. This is the only reliable replacement signal on
    // filesystems that recycle inode numbers.
    let held;
    try {
      held = await handle.stat();
    } catch {
      throw new PathSecurityError(`Directory identity changed after validation: ${pin.path}`);
    }
    if (!held.isDirectory() || held.nlink === 0) {
      throw new PathSecurityError(`Directory identity changed after validation: ${pin.path}`);
    }
  }
  const current = await stat(pin.path);
  if (
    !current.isDirectory()
    || current.dev !== pin.identity.dev
    || current.ino !== pin.identity.ino
  ) {
    throw new PathSecurityError(`Directory identity changed after validation: ${pin.path}`);
  }
  return pin;
}

export async function verifyDescendant(pin, candidate, { allowMissing = true } = {}) {
  const absolute = path.resolve(candidate);
  if (!isWithin(pin.path, absolute)) {
    throw new PathSecurityError(`Path escapes pinned root: ${candidate}`);
  }
  await verifyPinnedDirectory(pin);
  await assertNoSymlinkComponents(absolute, { allowMissing });

  let existing = absolute;
  while (true) {
    try {
      const existingRealPath = await realpath(existing);
      if (isDeletePending(existingRealPath)) {
        // Unlinked, not escaped - treat it exactly as the ENOENT that POSIX
        // would have reported and keep walking up the chain.
        if (existing === pin.path) {
          throw new PathSecurityError(`Pinned root was deleted: ${pin.path}`);
        }
        existing = path.dirname(existing);
        continue;
      }
      if (!isWithin(pin.realPath, existingRealPath)) {
        throw new PathSecurityError(`Path resolves outside pinned root: ${candidate}`);
      }
      break;
    } catch (error) {
      if (!isMissingDuringResolve(error) || existing === pin.path) throw error;
      existing = path.dirname(existing);
    }
  }
  return absolute;
}

const GROUP_OTHER_WRITE_MASK = 0o022;
const STICKY_BIT = 0o1000;

function defaultGetuid() {
  return typeof process.getuid === "function" ? process.getuid.bind(process) : undefined;
}

function directoryChain(absolute) {
  const parsed = path.parse(absolute);
  const chain = [parsed.root];
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    chain.push(current);
  }
  return chain;
}

/**
 * Proves that `target` is *securely held*: every path component from the
 * filesystem root down to `target` is owned by a trusted user (the current
 * effective uid or root) and cannot be replaced or written by an untrusted
 * user. This is the structural precondition that makes a symlink/rename swap of
 * the directory *impossible* rather than merely *detectable after the fact* —
 * external tools (such as `git`) resolve string paths on their own and cannot be
 * pinned to a Node directory handle portably, so containment must instead deny
 * the attacker the write access a swap requires.
 *
 * Rules applied to each component (owner must be trusted throughout):
 *   - an intermediate directory may be group/other-writable only if it carries
 *     the sticky bit (which stops non-owners renaming/deleting the entry on the
 *     chain, so it cannot be swapped);
 *   - the final `target` directory must not be group/other-writable at all,
 *     because new entries are created inside it and the sticky bit does not stop
 *     an untrusted user injecting a *new* entry (e.g. a pre-planted symlink).
 *
 * `getuid` and `statImpl` are deterministic seams so callers can prove the
 * fail-closed behaviour without provisioning genuinely unsafe directories (which
 * is not portably possible without elevated privileges). Platforms that cannot
 * report POSIX ownership (no `process.getuid`, e.g. Windows) fail closed with
 * `UNSUPPORTED_PLATFORM`.
 */
export async function assertSecurelyHeldDirectory(target, {
  getuid = defaultGetuid(),
  statImpl = lstat,
  trustedUids = [],
} = {}) {
  if (typeof getuid !== "function") {
    throw new PathSecurityError(
      `Cannot prove secure directory ownership on this platform: ${target}`,
      "UNSUPPORTED_PLATFORM",
    );
  }
  const absolute = path.resolve(target);
  const trusted = new Set([getuid(), 0, ...trustedUids]);
  const chain = directoryChain(absolute);
  for (let index = 0; index < chain.length; index += 1) {
    const component = chain[index];
    const isTarget = index === chain.length - 1;
    let info;
    try {
      info = await statImpl(component);
    } catch (error) {
      throw new PathSecurityError(
        `Cannot verify secure ownership of ${component}: ${error.code ?? error.message}`,
        "INSECURE_CONTAINMENT",
      );
    }
    if (info.isSymbolicLink()) {
      throw new PathSecurityError(`Path must not contain symbolic links: ${component}`);
    }
    if (!trusted.has(info.uid)) {
      throw new PathSecurityError(
        `Path component is owned by an untrusted user (uid ${info.uid}): ${component}`,
        "INSECURE_CONTAINMENT",
      );
    }
    const groupOtherWritable = (info.mode & GROUP_OTHER_WRITE_MASK) !== 0;
    const sticky = (info.mode & STICKY_BIT) !== 0;
    if (groupOtherWritable && (isTarget || !sticky)) {
      throw new PathSecurityError(
        `Path component is writable by untrusted users: ${component}`,
        "INSECURE_CONTAINMENT",
      );
    }
  }
  return absolute;
}

export async function fileHandleIdentity(handle) {
  const info = await handle.stat();
  return Object.freeze({ dev: info.dev, ino: info.ino });
}

export function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function assertFileHandleMatchesPath(handle, candidate, {
  lstatImpl = lstat,
} = {}) {
  const [identity, current] = await Promise.all([
    fileHandleIdentity(handle),
    lstatImpl(candidate),
  ]);
  if (current.isSymbolicLink() || !sameFileIdentity(identity, current)) {
    throw new PathSecurityError(`Path changed while its file handle was in use: ${candidate}`);
  }
  return identity;
}

const SUPPORTS_O_NOFOLLOW = Number.isInteger(constants.O_NOFOLLOW);
// Bounded so a benign race settles while an attacker who keeps winning it is
// still refused. Backoff matters here: a delete-pending entry under heavy
// contention can stay unopenable for longer than a few milliseconds, and the
// whole budget is still well under a second. Only used where the kernel
// refusal is unavailable.
const EMULATED_OPEN_ATTEMPTS = 10;
const EMULATED_RETRY_MS = 2;
const EMULATED_RETRY_CAP_MS = 50;

function sleep(ms) {
  // Deliberately not unref'd: this runs in the middle of an open that has
  // already been committed to, so the process must stay alive to finish it
  // rather than exiting and leaving the caller's promise unsettled.
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * The error a POSIX kernel raises for `O_NOFOLLOW` against a link. Reproduced
 * verbatim on platforms without the flag so callers that already branch on
 * `ELOOP` behave identically everywhere.
 */
function symlinkRefusal(target) {
  const error = new Error(`ELOOP: symbolic link refused, open '${target}'`);
  error.code = "ELOOP";
  error.path = target;
  return error;
}

/**
 * Adds the kernel-level symlink refusal where the platform has one.
 *
 * `O_NOFOLLOW` makes the kernel refuse to open a symlink at all, which is a
 * guarantee rather than a check. Windows has no equivalent exposed through
 * Node, so there the link has to be excluded by observation instead - see
 * `openSymlinkSafe`, which is the only supported way to take that path.
 *
 * A platform that is neither Windows nor `O_NOFOLLOW`-capable is unknown
 * territory, so it still fails closed rather than being guessed at.
 */
export function symlinkSafeFlags(flags, {
  platform = process.platform,
  supportsNoFollow = SUPPORTS_O_NOFOLLOW,
} = {}) {
  if (!Number.isInteger(flags)) throw new TypeError("flags must be numeric");
  if (supportsNoFollow) return flags | constants.O_NOFOLLOW;
  if (platform !== "win32") {
    throw new PathSecurityError("O_NOFOLLOW is unavailable on this platform", "UNSUPPORTED_PLATFORM");
  }
  // Truncation happens as part of the open itself, so a symlinked target would
  // already be destroyed by the time any post-open check could reject it. No
  // caller needs this today; the guard exists so a future one cannot quietly
  // introduce the hole.
  if (Number.isInteger(constants.O_TRUNC) && (flags & constants.O_TRUNC) !== 0) {
    throw new PathSecurityError(
      "Truncating open cannot be made symlink-safe without O_NOFOLLOW",
      "UNSUPPORTED_PLATFORM",
    );
  }
  return flags;
}

/**
 * Opens `target` while refusing to act on a symbolic link.
 *
 * Where `O_NOFOLLOW` exists this is exactly the historical behaviour: one open
 * call, refused by the kernel, and the raw `errno` reaches the caller unchanged
 * so existing `ELOOP`/`EEXIST` handling keeps working.
 *
 * Where it does not, the same property is reconstructed from two observations
 * around the open - `lstat` first to narrow the window, and a
 * descriptor-versus-path comparison afterwards to close it. The descriptor is
 * pinned to whatever it actually opened, so a link swapped into the window
 * makes the two disagree and the handle is closed and refused before any caller
 * can read or write through it. A link is reported as `ELOOP` so callers cannot
 * tell the platforms apart.
 *
 * The reconstruction is strictly weaker than a kernel refusal: it *detects*
 * rather than *prevents*. It fails closed, and every write path in this
 * codebase creates with `O_CREAT|O_EXCL` and renames into place, which the
 * runtime refuses outright against an existing link.
 */
export async function openSymlinkSafe(target, flags, mode, {
  openImpl = open,
  lstatImpl = lstat,
  platform = process.platform,
  supportsNoFollow = SUPPORTS_O_NOFOLLOW,
  attempts = EMULATED_OPEN_ATTEMPTS,
  retryMs = EMULATED_RETRY_MS,
} = {}) {
  const resolvedFlags = symlinkSafeFlags(flags, { platform, supportsNoFollow });
  const openHandle = () => (mode === undefined
    ? openImpl(target, resolvedFlags)
    : openImpl(target, resolvedFlags, mode));
  if (supportsNoFollow) return await openHandle();

  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(Math.min(retryMs * (2 ** (attempt - 1)), EMULATED_RETRY_CAP_MS));
    try {
      return await attemptEmulatedOpen(target, openHandle, lstatImpl);
    } catch (error) {
      // A link is a refusal, not a race, so it is never retried.
      if (error.code === "ELOOP") throw error;
      // Everything else here is a state POSIX would not have surfaced at all.
      // Windows reports an open against a delete-pending entry as EPERM/EBADF/
      // EBUSY, and a lock file legitimately replaced by another writer shows up
      // as an identity mismatch. Retrying lets an ordinary race settle; an
      // attacker who keeps winning it still runs out of attempts and is refused.
      const retryable = WINDOWS_VANISHED_CODES.has(error.code)
        || error instanceof PathSecurityError;
      if (!retryable) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

async function attemptEmulatedOpen(target, openHandle, lstatImpl) {
  try {
    if ((await lstatImpl(target)).isSymbolicLink()) throw symlinkRefusal(target);
  } catch (error) {
    // A missing entry is normal for a create; anything else is real.
    if (error.code !== "ENOENT") throw error;
  }

  const handle = await openHandle();
  try {
    const [opened, current] = await Promise.all([handle.stat(), lstatImpl(target)]);
    if (current.isSymbolicLink()) throw symlinkRefusal(target);
    // A link swapped in and back out again would leave this descriptor on the
    // attacker's file while the path itself looks ordinary, so identity has to
    // be compared too, not just the link bit.
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new PathSecurityError(`Path changed while it was being opened: ${target}`);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function symlinkOpenError(error, candidate, lstatImpl) {
  if (error?.code === "ELOOP") {
    return new PathSecurityError(`Path must not contain symbolic links: ${candidate}`);
  }
  // Darwin reports EEXIST rather than ELOOP for O_CREAT|O_EXCL|O_NOFOLLOW
  // against a symlink. Preserve ordinary contention, but fail closed if the
  // existing entry is a link.
  if (error?.code === "EEXIST") {
    try {
      if ((await lstatImpl(candidate)).isSymbolicLink()) {
        return new PathSecurityError(`Path must not contain symbolic links: ${candidate}`);
      }
    } catch (lstatError) {
      if (lstatError.code !== "ENOENT") throw lstatError;
    }
  }
  return error;
}

/**
 * Opens a file only after proving it remains the verified descendant of `pin`.
 *
 * `beforeOpen` and `beforeUse` are deterministic test seams. Production callers
 * do not provide them; they make the two race windows testable without timing.
 */
export async function openVerifiedFile(pin, candidate, {
  flags = constants.O_RDONLY,
  mode,
  allowMissing = false,
  beforeOpen,
  beforeUse,
  openImpl = open,
  verifyDescendantImpl = verifyDescendant,
  lstatImpl = lstat,
} = {}) {
  const absolute = await verifyDescendantImpl(pin, candidate, { allowMissing });
  await beforeOpen?.({ pin, path: absolute, flags });

  let handle;
  try {
    handle = await openSymlinkSafe(absolute, flags, mode, { openImpl, lstatImpl });
  } catch (error) {
    throw await symlinkOpenError(error, absolute, lstatImpl);
  }

  try {
    await verifyDescendantImpl(pin, absolute, { allowMissing: false });
    const identity = await assertFileHandleMatchesPath(handle, absolute, { lstatImpl });
    await beforeUse?.({ pin, path: absolute, flags, identity });
    await verifyDescendantImpl(pin, absolute, { allowMissing: false });
    await assertFileHandleMatchesPath(handle, absolute, { lstatImpl });
    return { handle, identity, path: absolute };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export async function readVerifiedFile(pin, candidate, {
  encoding = "utf8",
  ...options
} = {}) {
  const { handle } = await openVerifiedFile(pin, candidate, {
    ...options,
    flags: constants.O_RDONLY,
    allowMissing: false,
  });
  try {
    return await handle.readFile(encoding);
  } finally {
    await handle.close();
  }
}

export async function removeVerifiedFile(pin, candidate, expectedIdentity, {
  beforeRemove,
  verifyDescendantImpl = verifyDescendant,
  lstatImpl = lstat,
  rmImpl = rm,
} = {}) {
  const absolute = await verifyDescendantImpl(pin, candidate, { allowMissing: false });
  await beforeRemove?.({ pin, path: absolute, identity: expectedIdentity });
  await verifyDescendantImpl(pin, absolute, { allowMissing: false });
  const current = await lstatImpl(absolute);
  if (current.isSymbolicLink() || !sameFileIdentity(expectedIdentity, current)) {
    throw new PathSecurityError(`Path changed before it could be removed: ${absolute}`);
  }
  await rmImpl(absolute, { force: true });
  return true;
}
