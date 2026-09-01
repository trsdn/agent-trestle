import assert from "node:assert/strict";
import test from "node:test";
import { configPath, validateConfig } from "../../src/config/config.mjs";

const minimal = {
  version: 1,
  project: { id: "acme-bank" },
  workstreams: [
    {
      id: "payments",
      path: "products/payments",
      roles: [{ id: "builder", agent: "payments-builder" }],
    },
  ],
};

test("validates explicit project, workstream, and role IDs with least-privilege defaults", () => {
  const config = validateConfig(minimal);
  assert.equal(config.project.id, "acme-bank");
  assert.deepEqual(config.permissions, {
    allowAllTools: false,
    allowAllPaths: false,
    allowAllUrls: false,
    nonInteractive: false,
    autoMerge: false,
  });
  assert.equal(config.copilot.binary, "copilot");
  assert.equal(config.copilot.timeoutMs, 0);
  // No sandbox is configured, so there is nothing --sandbox could enable.
  assert.equal(config.sandbox, undefined);
});

test("normalizes a declared sandbox without enabling it", () => {
  const config = validateConfig({
    ...minimal,
    sandbox: { image: "ghcr.io/example/copilot:1" },
  });
  assert.equal(config.sandbox.image, "ghcr.io/example/copilot:1");
  assert.equal(config.sandbox.runtime, "docker");
  // Denying egress by default is what makes an escalation to "bridge" visible.
  assert.equal(config.sandbox.network, "none");
  // Declaring a sandbox does not grant any Copilot permission.
  assert.equal(config.permissions.allowAllTools, false);
});

test("rejects a sandbox that cannot constrain anything", () => {
  assert.throws(() => validateConfig({ ...minimal, sandbox: {} }), /image must be a non-empty string/);
  assert.throws(
    () => validateConfig({ ...minimal, sandbox: { image: "x", network: "host" } }),
    /network must be one of none, bridge/,
  );
  assert.throws(
    () => validateConfig({ ...minimal, sandbox: { image: "x", privileged: true } }),
    /unknown keys: privileged/,
  );
});

test("does not infer IDs from a path or basename", () => {
  assert.throws(
    () => validateConfig({
      ...minimal,
      project: {},
    }),
    /project\.id/,
  );
  assert.throws(
    () => validateConfig({
      ...minimal,
      workstreams: [{ path: "payments", roles: minimal.workstreams[0].roles }],
    }),
    /workstreams\[0\]\.id/,
  );
});

test("rejects duplicate deterministic routing IDs", () => {
  assert.throws(
    () => validateConfig({
      ...minimal,
      workstreams: [minimal.workstreams[0], minimal.workstreams[0]],
    }),
    /duplicate ID "payments"/,
  );
});

test("uses only .trestle/config.json", () => {
  assert.match(configPath("/repo"), /\/repo\/\.trestle\/config\.json$/);
});

test("rejects unknown keys at all levels", () => {
  assert.throws(
    () => validateConfig({ ...minimal, unknownKey: true }),
    /config contains unknown key: unknownKey/
  );
  assert.throws(
    () => validateConfig({ ...minimal, project: { id: "acme", unknownKey: true } }),
    /config\.project contains unknown key: unknownKey/
  );
  assert.throws(
    () => validateConfig({
      ...minimal,
      copilot: { binary: "copilot", unknownKey: true }
    }),
    /config\.copilot contains unknown key: unknownKey/
  );
  assert.throws(
    () => validateConfig({
      ...minimal,
      workstreams: [{ ...minimal.workstreams[0], unknownKey: true }]
    }),
    /workstreams\[0\] contains unknown key: unknownKey/
  );
  assert.throws(
    () => validateConfig({
      ...minimal,
      workstreams: [{
        ...minimal.workstreams[0],
        roles: [{ ...minimal.workstreams[0].roles[0], unknownKey: true }]
      }]
    }),
    /workstreams\[0\]\.roles\[0\] contains unknown key: unknownKey/
  );
  assert.throws(
    () => validateConfig({
      ...minimal,
      permissions: { allowAllTools: true, unknownKey: true }
    }),
    /config.permissions contains unknown keys: unknownKey/
  );
});

test("rejects explicitly present null and non-object workstream or role permissions", () => {
  const invalidValues = [undefined, null, true, 1, "all-tools", []];
  for (const value of invalidValues) {
    assert.throws(
      () => validateConfig({
        ...minimal,
        workstreams: [{ ...minimal.workstreams[0], permissions: value }],
      }),
      /workstreams\[0\]\.permissions must be an object/,
    );
    assert.throws(
      () => validateConfig({
        ...minimal,
        workstreams: [{
          ...minimal.workstreams[0],
          roles: [{ ...minimal.workstreams[0].roles[0], permissions: value }],
        }],
      }),
      /workstreams\[0\]\.roles\[0\]\.permissions must be an object/,
    );
  }
});
