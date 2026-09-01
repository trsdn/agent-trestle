import assert from "node:assert/strict";
import { constants } from "node:fs";
import test from "node:test";
import {
  isMissingDuringResolve,
  openSymlinkSafe,
  PathSecurityError,
  symlinkSafeFlags,
} from "../../src/security/path-security.mjs";

// The emulated path is exercised with explicit seams rather than real symlinks
// so it runs identically on every platform, including the POSIX hosts where
// O_NOFOLLOW is present and would otherwise mask it.
const EMULATED = { platform: "win32", supportsNoFollow: false };
const NATIVE = { platform: "linux", supportsNoFollow: true };
// The flag only has a value on platforms that define it, so assertions about
// its bit pattern only mean anything there. The behavioural tests below still
// run everywhere.
const HAS_NOFOLLOW = Number.isInteger(constants.O_NOFOLLOW);

function statLike({ dev = 1, ino = 2, symlink = false } = {}) {
  return { dev, ino, isSymbolicLink: () => symlink };
}

function fakeHandle(stat) {
  let closed = false;
  return {
    stat: async () => stat,
    close: async () => { closed = true; },
    get closed() { return closed; },
  };
}

test("the kernel refusal is used wherever the platform provides one", { skip: !HAS_NOFOLLOW }, () => {
  const flags = symlinkSafeFlags(constants.O_RDONLY, NATIVE);
  assert.equal(flags & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
});

test("a platform without O_NOFOLLOW that is not Windows still fails closed", () => {
  assert.throws(
    () => symlinkSafeFlags(constants.O_RDONLY, { platform: "sunos", supportsNoFollow: false }),
    (error) => error instanceof PathSecurityError && error.code === "UNSUPPORTED_PLATFORM",
  );
});

test("Windows drops the flag it cannot express rather than failing", () => {
  assert.equal(symlinkSafeFlags(constants.O_RDONLY, EMULATED), constants.O_RDONLY);
});

test("a truncating open is refused where it cannot be made symlink-safe", () => {
  // Truncation happens during the open, so no post-open check could undo it.
  assert.throws(
    () => symlinkSafeFlags(constants.O_WRONLY | constants.O_TRUNC, EMULATED),
    (error) => error.code === "UNSUPPORTED_PLATFORM",
  );
});

test("truncation is allowed where the kernel refuses the link itself", { skip: !HAS_NOFOLLOW }, () => {
  assert.doesNotThrow(() => symlinkSafeFlags(constants.O_WRONLY | constants.O_TRUNC, NATIVE));
});

test("non-numeric flags are rejected", () => {
  assert.throws(() => symlinkSafeFlags("rw", NATIVE), TypeError);
});

test("emulated open wraps exhausted delete-pending retries in a path security error", async () => {
  const platformError = Object.assign(new Error("delete pending"), { code: "EPERM" });
  let opens = 0;
  await assert.rejects(
    () => openSymlinkSafe("/srv/target", constants.O_RDONLY, undefined, {
      ...EMULATED,
      attempts: 2,
      retryMs: 0,
      lstatImpl: async () => statLike(),
      openImpl: async () => { opens += 1; throw platformError; },
    }),
    (error) => error instanceof PathSecurityError
      && error.code === "PATH_TRAVERSAL"
      && error.cause === platformError,
  );
  assert.equal(opens, 2);
});

test("Windows delete-pending errors are treated as vanished names only on Windows", () => {
  const error = Object.assign(new Error("delete pending"), { code: "EPERM" });
  assert.equal(isMissingDuringResolve(error, EMULATED), true);
  assert.equal(isMissingDuringResolve(error, NATIVE), false);
  const wrapped = new PathSecurityError("wrapped", "PATH_TRAVERSAL", { cause: error });
  assert.equal(isMissingDuringResolve(wrapped, EMULATED), true);
  assert.equal(isMissingDuringResolve(wrapped, NATIVE), false);
  const enoent = Object.assign(new Error("gone"), { code: "ENOENT" });
  assert.equal(isMissingDuringResolve(enoent, NATIVE), true);
});

test("emulated open refuses a link that is visible before opening", async () => {
  let opened = false;
  await assert.rejects(
    () => openSymlinkSafe("/srv/link", constants.O_RDONLY, undefined, {
      ...EMULATED,
      lstatImpl: async () => statLike({ symlink: true }),
      openImpl: async () => { opened = true; return fakeHandle(statLike()); },
    }),
    // Reported as ELOOP so callers cannot tell the platforms apart.
    (error) => error.code === "ELOOP",
  );
  assert.equal(opened, false, "the link must never be opened at all");
});

test("emulated open refuses a link swapped in during the open window", async () => {
  const handle = fakeHandle(statLike({ ino: 10 }));
  let calls = 0;
  await assert.rejects(
    () => openSymlinkSafe("/srv/target", constants.O_RDONLY, undefined, {
      ...EMULATED,
      // Clean before the open, a link afterwards: the race this check exists for.
      lstatImpl: async () => {
        calls += 1;
        return calls === 1 ? statLike({ ino: 10 }) : statLike({ ino: 10, symlink: true });
      },
      openImpl: async () => handle,
    }),
    (error) => error.code === "ELOOP",
  );
  assert.equal(handle.closed, true, "the handle must be closed before the error escapes");
});

test("emulated open refuses a file replaced during the open window", async () => {
  const handle = fakeHandle(statLike({ ino: 10 }));
  let calls = 0;
  await assert.rejects(
    () => openSymlinkSafe("/srv/target", constants.O_RDONLY, undefined, {
      ...EMULATED,
      // A link swapped in and back out again leaves the descriptor on the
      // attacker's file while the path itself looks ordinary, so only identity
      // catches it.
      lstatImpl: async () => {
        calls += 1;
        return calls === 1 ? statLike({ ino: 10 }) : statLike({ ino: 99 });
      },
      openImpl: async () => handle,
    }),
    (error) => error instanceof PathSecurityError && /changed while it was being opened/.test(error.message),
  );
  assert.equal(handle.closed, true);
});

test("emulated open passes an ordinary file straight through", async () => {
  const handle = fakeHandle(statLike({ ino: 7 }));
  const result = await openSymlinkSafe("/srv/target", constants.O_RDONLY, undefined, {
    ...EMULATED,
    lstatImpl: async () => statLike({ ino: 7 }),
    openImpl: async () => handle,
  });
  assert.equal(result, handle);
  assert.equal(handle.closed, false);
});

test("a missing entry is not mistaken for a link when creating", async () => {
  const handle = fakeHandle(statLike({ ino: 3 }));
  let mode;
  const result = await openSymlinkSafe(
    "/srv/new",
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
    {
      ...EMULATED,
      lstatImpl: async () => {
        if (mode === undefined) { mode = "missing"; throw Object.assign(new Error("gone"), { code: "ENOENT" }); }
        return statLike({ ino: 3 });
      },
      openImpl: async (_target, _flags, fileMode) => { mode = fileMode; return handle; },
    },
  );
  assert.equal(result, handle);
  assert.equal(mode, 0o600, "the file mode must still reach the open call");
});

test("the native path performs exactly one open and no extra stat calls", async () => {
  const handle = fakeHandle(statLike());
  let opens = 0;
  let lstats = 0;
  const result = await openSymlinkSafe("/srv/target", constants.O_RDONLY, undefined, {
    ...NATIVE,
    lstatImpl: async () => { lstats += 1; return statLike(); },
    openImpl: async () => { opens += 1; return handle; },
  });
  assert.equal(result, handle);
  assert.equal(opens, 1);
  // The kernel already refused any link, so the emulation must stay out of the
  // way entirely and leave POSIX behaviour byte-for-byte unchanged.
  assert.equal(lstats, 0);
});

test("the native path lets the raw errno reach the caller", async () => {
  // Callers branch on ELOOP/EEXIST to tell a replaced lock from contention, so
  // the code must not be rewritten on the way out.
  await assert.rejects(
    () => openSymlinkSafe("/srv/target", constants.O_RDONLY, undefined, {
      ...NATIVE,
      openImpl: async () => { throw Object.assign(new Error("busy"), { code: "EEXIST" }); },
      lstatImpl: async () => statLike(),
    }),
    (error) => error.code === "EEXIST",
  );
});
