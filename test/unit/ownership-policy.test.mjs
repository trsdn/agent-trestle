import assert from "node:assert/strict";
import test from "node:test";
import {
  assertOwnership,
  checkOwnership,
  createOwnershipPolicy,
  ownerForPath,
} from "../../src/ownership/index.mjs";

test("configurable ownership supports recursive globs and defaults", () => {
  const policy = createOwnershipPolicy({
    owners: {
      scheduler: ["src/scheduler/**", "test/**/scheduler-*.test.mjs"],
      review: ["src/review/**/*.mjs"],
    },
    defaultOwner: "maintainer",
  });
  assert.equal(ownerForPath(policy, "src/scheduler/index.mjs"), "scheduler");
  assert.equal(ownerForPath(policy, "src/review/gate.mjs"), "review");
  assert.equal(ownerForPath(policy, "docs/design.md"), "maintainer");
});

test("ownership fails closed for unowned and wrong-owner paths", () => {
  const policy = createOwnershipPolicy({
    owners: { scheduler: ["src/scheduler/**"] },
  });
  assert.deepEqual(checkOwnership(policy, "scheduler", ["unknown.txt"]), {
    allowed: false,
    violations: [{ path: "unknown.txt", owner: null, reason: "unowned" }],
  });
  assert.throws(
    () => assertOwnership(policy, "review", ["src/scheduler/a.mjs"]),
    (error) =>
      error.code === "OWNERSHIP_VIOLATION" &&
      error.violations[0].reason === "wrong-owner",
  );
});

test("ambiguous ownership and unsafe paths are rejected", () => {
  const policy = createOwnershipPolicy({
    owners: { one: ["src/**"], two: ["src/review/**"] },
  });
  assert.throws(() => ownerForPath(policy, "src/review/a.mjs"), /ambiguous/);
  assert.throws(() => ownerForPath(policy, "../secret"), /unsafe/);
});

test("recursive ownership globs preserve filesystem-valid newline paths", () => {
  const policy = createOwnershipPolicy({
    owners: { scheduler: ["src/**"] },
  });
  assert.equal(ownerForPath(policy, "src/a\nb.mjs"), "scheduler");
});

test("POSIX ownership keeps literal backslashes as filename bytes", () => {
  const policy = createOwnershipPolicy({
    owners: { scheduler: ["src/**"] },
  });
  assert.deepEqual(checkOwnership(policy, "scheduler", ["src\\owned.mjs"]), {
    allowed: false,
    violations: [{ path: "src\\owned.mjs", owner: null, reason: "unowned" }],
  });
});

test("explicit win32 ownership mode can opt into separator semantics for filesystem paths", () => {
  const policy = createOwnershipPolicy({
    platform: "win32",
    owners: { scheduler: ["src/**"] },
  });
  assert.equal(ownerForPath(policy, "src\\owned.mjs"), "scheduler");
});
