import assert from "node:assert/strict";
import { mkdir, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { POSIX_MODE_BITS_ONLY } from "../helpers/platform.mjs";
import { makeScratchRoot } from "../helpers/scratch.mjs";
import {
  PathSecurityError,
  assertSecurelyHeldDirectory,
  pinDirectory,
  releasePin,
  verifyPinnedDirectory,
} from "../../src/security/path-security.mjs";

const workRoot = await makeScratchRoot("path-security");

test.after(async () => rm(workRoot, { recursive: true, force: true }));

test("directory pins reject rm+mkdir replacement at the same pathname", async () => {
  const root = path.join(workRoot, "rm-mkdir");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const pin = await pinDirectory(root);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await assert.rejects(
    verifyPinnedDirectory(pin),
    (error) => error instanceof PathSecurityError,
  );
});

// Detection only works while the pin still holds the directory open: the held
// descriptor is what stops the freed inode number being handed straight back to
// a replacement directory on filesystems that recycle them (ext4, overlayfs).
test("released pins fail closed instead of degrading to identity-only checks", async () => {
  const root = path.join(workRoot, "released");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const pin = await pinDirectory(root);
  await verifyPinnedDirectory(pin);

  assert.equal(await releasePin(pin), true);
  assert.equal(await releasePin(pin), false);

  await assert.rejects(
    verifyPinnedDirectory(pin),
    (error) => error instanceof PathSecurityError && error.code === "PIN_RELEASED",
  );
});

test("directory pins reject rename replacement and symlink root replacement", async () => {
  const root = path.join(workRoot, "rename");
  const replacement = path.join(workRoot, "replacement");
  await rm(path.join(workRoot, "rename"), { recursive: true, force: true });
  await rm(replacement, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await mkdir(replacement, { recursive: true });
  const pin = await pinDirectory(root);
  await rename(replacement, `${root}.new`);
  await rename(root, replacement);
  await rename(`${root}.new`, root);
  await assert.rejects(verifyPinnedDirectory(pin), PathSecurityError);

  await rm(root, { recursive: true, force: true });
  await symlink(replacement, root);
  await assert.rejects(verifyPinnedDirectory(pin), PathSecurityError);
});

// `assertSecurelyHeldDirectory` is the structural guarantee that replaces
// detect-after-the-fact escape checks: it proves no untrusted user can swap or
// write a path component of the staging root. The negative cases use a fake
// stat seam so the unsafe ownership/permission shapes can be asserted
// deterministically without provisioning genuinely unsafe directories.

function fakeStatSeam(entries) {
  const map = new Map(Object.entries(entries).map(([key, value]) => [path.resolve(key), value]));
  return async (candidate) => {
    const key = path.resolve(candidate);
    const entry = map.get(key);
    if (!entry) throw Object.assign(new Error(`missing ${key}`), { code: "ENOENT" });
    return {
      uid: entry.uid,
      mode: entry.mode,
      isSymbolicLink: () => Boolean(entry.symlink),
      isDirectory: () => true,
    };
  };
}

test("securely held directory under the repo passes containment", { skip: POSIX_MODE_BITS_ONLY }, async () => {
  const dir = path.join(workRoot, "held");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  assert.equal(await assertSecurelyHeldDirectory(dir), path.resolve(dir));
});

test("containment rejects a path component owned by an untrusted user", async () => {
  const statImpl = fakeStatSeam({
    "/": { uid: 0, mode: 0o40755 },
    "/srv": { uid: 0, mode: 0o40755 },
    "/srv/app": { uid: 1000, mode: 0o40755 },
    "/srv/app/root": { uid: 4242, mode: 0o40700 },
  });
  await assert.rejects(
    assertSecurelyHeldDirectory("/srv/app/root", { getuid: () => 1000, statImpl }),
    (error) => error instanceof PathSecurityError && error.code === "INSECURE_CONTAINMENT",
  );
});

test("containment rejects a group/other-writable staging directory", async () => {
  const statImpl = fakeStatSeam({
    "/": { uid: 0, mode: 0o40755 },
    "/srv": { uid: 0, mode: 0o40755 },
    "/srv/root": { uid: 1000, mode: 0o40707 },
  });
  await assert.rejects(
    assertSecurelyHeldDirectory("/srv/root", { getuid: () => 1000, statImpl }),
    (error) => error instanceof PathSecurityError && error.code === "INSECURE_CONTAINMENT",
  );
});

test("containment allows a sticky writable ancestor but never a writable staging directory", async () => {
  const shared = { uid: 0, mode: 0o41777 }; // sticky + world-writable, e.g. /tmp
  await assert.doesNotReject(
    assertSecurelyHeldDirectory("/shared/root", {
      getuid: () => 1000,
      statImpl: fakeStatSeam({
        "/": { uid: 0, mode: 0o40755 },
        "/shared": shared,
        "/shared/root": { uid: 1000, mode: 0o40700 },
      }),
    }),
  );
  // The sticky exception must not extend to the staging directory itself, since
  // a new (attacker-planted) entry can still be created inside a sticky dir.
  await assert.rejects(
    assertSecurelyHeldDirectory("/shared/root", {
      getuid: () => 1000,
      statImpl: fakeStatSeam({
        "/": { uid: 0, mode: 0o40755 },
        "/shared": shared,
        "/shared/root": { uid: 1000, mode: 0o41777 },
      }),
    }),
    (error) => error instanceof PathSecurityError && error.code === "INSECURE_CONTAINMENT",
  );
});

test("containment rejects a symlinked path component", async () => {
  const statImpl = fakeStatSeam({
    "/": { uid: 0, mode: 0o40755 },
    "/srv": { uid: 0, mode: 0o40755, symlink: true },
    "/srv/root": { uid: 1000, mode: 0o40700 },
  });
  await assert.rejects(
    assertSecurelyHeldDirectory("/srv/root", { getuid: () => 1000, statImpl }),
    (error) => error instanceof PathSecurityError && error.code === "PATH_TRAVERSAL",
  );
});

test("containment fails closed when POSIX ownership is unavailable", async () => {
  await assert.rejects(
    assertSecurelyHeldDirectory("/anything", { getuid: null }),
    (error) => error instanceof PathSecurityError && error.code === "UNSUPPORTED_PLATFORM",
  );
});
