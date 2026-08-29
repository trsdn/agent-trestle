import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";
import { makeScratchRoot } from "../helpers/scratch";
import {
  loadOwnershipPolicy,
  OwnershipPolicyError,
  validateOwnershipDocument,
} from "../../src/ownership/load-policy.mjs";
import { assertOwnership, checkOwnership } from "../../src/ownership/policy.mjs";

const workRoot = await makeScratchRoot("ownership-policy-document");

after(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

function document(overrides = {}) {
  return {
    version: 1,
    owners: { "backend-implementer": ["src/api/**"] },
    ...overrides,
  };
}

function rejects(input, fragment) {
  assert.throws(() => validateOwnershipDocument(input), (error) => {
    assert.ok(error instanceof OwnershipPolicyError, `expected OwnershipPolicyError, got ${error?.name}`);
    assert.equal(error.code, "INVALID_OWNERSHIP_POLICY");
    assert.match(error.message, fragment);
    return true;
  });
}

test("a valid document compiles to an enforceable policy", () => {
  const policy = validateOwnershipDocument(document({
    owners: { alice: ["src/api/**"], bob: ["docs/**", "*.md"] },
  }));
  assert.equal(checkOwnership(policy, "alice", ["src/api/users.mjs"]).allowed, true);
  assert.equal(checkOwnership(policy, "bob", ["docs/guide.md", "README.md"]).allowed, true);
  assert.equal(checkOwnership(policy, "alice", ["docs/guide.md"]).allowed, false);
});

test("an unowned path rejects unless allowUnowned is deliberate", () => {
  const strict = validateOwnershipDocument(document());
  const violation = checkOwnership(strict, "backend-implementer", ["scripts/deploy.sh"]);
  assert.equal(violation.allowed, false);
  assert.equal(violation.violations[0].reason, "unowned");

  const permissive = validateOwnershipDocument(document({ allowUnowned: true }));
  assert.equal(checkOwnership(permissive, "backend-implementer", ["scripts/deploy.sh"]).allowed, true);
});

test("defaultOwner attributes otherwise unmatched paths", () => {
  const policy = validateOwnershipDocument(document({ defaultOwner: "maintainer" }));
  assert.equal(checkOwnership(policy, "maintainer", ["anything/else.txt"]).allowed, true);
  assert.equal(checkOwnership(policy, "backend-implementer", ["anything/else.txt"]).allowed, false);
});

test("unknown keys and wrong versions are rejected", () => {
  rejects(document({ extra: true }), /contains unknown key: extra/);
  rejects(document({ version: 2 }), /version must be 1/);
  rejects({ owners: { a: ["x"] } }, /version must be 1/);
});

test("owners must be a non-empty map of non-empty pattern lists", () => {
  rejects(document({ owners: {} }), /owners must be a non-empty object/);
  rejects(document({ owners: [] }), /owners must be a non-empty object/);
  rejects(document({ owners: { alice: [] } }), /patterns for alice must be a non-empty array/);
  rejects(document({ owners: { alice: ["  "] } }), /patterns for alice must be a non-empty array/);
});

test("scalar fields are type-checked", () => {
  rejects(document({ defaultOwner: "" }), /defaultOwner must be a non-empty string or null/);
  rejects(document({ allowUnowned: "yes" }), /allowUnowned must be a boolean/);
  rejects(document({ pathStyle: "nt" }), /pathStyle must be "posix" or "win32"/);
});

test("an escaping glob is rejected when the document is read, not at merge time", () => {
  assert.throws(
    () => validateOwnershipDocument(document({ owners: { alice: ["../outside/**"] } })),
    /unsafe repository-relative path/,
  );
  assert.throws(
    () => validateOwnershipDocument(document({ owners: { alice: ["/etc/**"] } })),
    /unsafe repository-relative path/,
  );
});

test("ambiguous ownership between two owners rejects rather than picking one", () => {
  const policy = validateOwnershipDocument(document({
    owners: { alice: ["src/**"], bob: ["**/api/**"] },
  }));
  assert.throws(
    () => checkOwnership(policy, "alice", ["src/api/users.mjs"]),
    /ambiguous ownership/,
  );
});

test("assertOwnership reports every violating path", () => {
  const policy = validateOwnershipDocument(document({ owners: { alice: ["src/**"] } }));
  assert.throws(
    () => assertOwnership(policy, "alice", ["src/ok.mjs", "docs/a.md", "docs/b.md"]),
    (error) => {
      assert.equal(error.code, "OWNERSHIP_VIOLATION");
      assert.deepEqual(error.violations.map((violation) => violation.path), ["docs/a.md", "docs/b.md"]);
      return true;
    },
  );
});

test("loadOwnershipPolicy validates the document it read", async () => {
  const repoRoot = path.join(workRoot, "load");
  await mkdir(repoRoot, { recursive: true });
  await writeFile(path.join(repoRoot, "owners.json"), JSON.stringify(document()));
  const policy = await loadOwnershipPolicy(repoRoot, "owners.json");
  assert.equal(checkOwnership(policy, "backend-implementer", ["src/api/x.mjs"]).allowed, true);

  await writeFile(path.join(repoRoot, "broken.json"), "{ not json");
  await assert.rejects(
    loadOwnershipPolicy(repoRoot, "broken.json"),
    (error) => error instanceof OwnershipPolicyError && /Invalid JSON in/.test(error.message),
  );
});

test("a policy outside the repository root loads, so the authority can sit outside agent write scope", async () => {
  const repoRoot = path.join(workRoot, "escape", "repo");
  await mkdir(repoRoot, { recursive: true });
  const outside = path.join(workRoot, "escape", "outside.json");
  await writeFile(outside, JSON.stringify(document()));

  // The ownership policy constrains a semi-trusted agent. If it could only live
  // inside repoRoot, that agent could rewrite its own authorization, so an
  // absolute out-of-repo path is supported and pinned at its own directory.
  const policy = await loadOwnershipPolicy(repoRoot, outside);
  assert.equal(checkOwnership(policy, "backend-implementer", ["src/api/x.mjs"]).allowed, true);
});

test("a symlinked policy still fails closed", async () => {
  const { symlink } = await import("node:fs/promises");
  const repoRoot = path.join(workRoot, "symlinked", "repo");
  await mkdir(repoRoot, { recursive: true });
  await writeFile(path.join(workRoot, "symlinked", "real.json"), JSON.stringify(document()));
  await symlink(path.join(workRoot, "symlinked", "real.json"), path.join(repoRoot, "owners.json"));

  await assert.rejects(
    loadOwnershipPolicy(repoRoot, "owners.json"),
    (error) => error.name === "PathSecurityError" || /symlink|escape|traversal/i.test(error.message),
  );
});

test("the shipped example policy is valid", async () => {
  const { readFile } = await import("node:fs/promises");
  const example = JSON.parse(await readFile(
    path.resolve(import.meta.dirname, "../../examples/ownership-policy.json"),
    "utf8",
  ));
  const policy = validateOwnershipDocument(example);
  assert.equal(checkOwnership(policy, "docs-writer", ["docs/commands.md"]).allowed, true);
  assert.equal(checkOwnership(policy, "docs-writer", ["src/api/x.mjs"]).allowed, false);
});
