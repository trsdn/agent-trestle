import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAutoMergeAllowed,
  copilotPermissionArgs,
  mergePermissions,
  normalizePermissions,
} from "../../src/config/permissions.mjs";

test("permissions default to least privilege", () => {
  assert.deepEqual(copilotPermissionArgs(), []);
  assert.throws(() => assertAutoMergeAllowed(), /explicitly enabled/);
});

test("broad access, noninteractive mode, and auto merge require explicit opt-ins", () => {
  const permissions = normalizePermissions({
    allowAllTools: true,
    allowAllPaths: true,
    allowAllUrls: true,
    nonInteractive: true,
    autoMerge: true,
  });
  assert.deepEqual(copilotPermissionArgs(permissions), [
    "--allow-all-tools",
    "--allow-all-paths",
    "--allow-all-urls",
    "--no-ask-user",
  ]);
  assert.equal(assertAutoMergeAllowed(permissions).autoMerge, true);
});

test("permission layers override only explicitly supplied values", () => {
  assert.deepEqual(
    mergePermissions({ allowAllTools: true }, { nonInteractive: true }),
    {
      allowAllTools: true,
      allowAllPaths: false,
      allowAllUrls: false,
      nonInteractive: true,
      autoMerge: false,
    },
  );
});

test("unknown permission keys fail closed", () => {
  assert.throws(() => normalizePermissions({ unrestricted: true }), /unknown keys/);
});
