import assert from "node:assert/strict";
import { mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeScratchRoot } from "../helpers/scratch.mjs";
import { validateConfig } from "../../src/config/config.mjs";
import {
  resolveRoute,
  resolveWorkstreamDirectory,
} from "../../src/dispatch/router.mjs";

const config = validateConfig({
  version: 1,
  project: { id: "bank" },
  permissions: { allowAllTools: true },
  workstreams: [
    {
      id: "lending",
      path: "streams/lending",
      permissions: { nonInteractive: true },
      roles: [
        {
          id: "builder",
          agent: "loan-builder",
          skills: ["reviewer"],
          permissions: { allowAllUrls: true },
        },
      ],
    },
  ],
});

test("resolves workstream and role deterministically from explicit IDs", () => {
  const route = resolveRoute(config, {
    projectId: "bank",
    workstreamId: "lending",
    roleId: "builder",
  });
  assert.equal(route.agentId, "loan-builder");
  assert.deepEqual(route.configuredSkills, ["reviewer"]);
  assert.equal(route.permissions.allowAllTools, true);
  assert.equal(route.permissions.nonInteractive, true);
  assert.equal(route.permissions.allowAllUrls, true);
  assert.equal(route.permissions.allowAllPaths, false);
});

test("never infers a route when an ID is absent", () => {
  assert.throws(
    () => resolveRoute(config, { projectId: "bank", workstreamId: "lending" }),
    /IDs are never inferred/,
  );
});

test("rejects unknown IDs without fallback", () => {
  assert.throws(
    () => resolveRoute(config, { projectId: "bank", workstreamId: "loans", roleId: "builder" }),
    /Unknown workstream ID "loans"/,
  );
});

const fixtureRoot = await makeScratchRoot("dispatch-routing");

test("workstream directories cannot escape the project root", async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(path.join(fixtureRoot, "streams/lending"), { recursive: true });
  assert.equal(
    await resolveWorkstreamDirectory(fixtureRoot, { workstreamPath: "streams/lending" }),
    path.join(fixtureRoot, "streams/lending"),
  );
  await assert.rejects(
    resolveWorkstreamDirectory(fixtureRoot, { workstreamPath: "../outside" }),
    /escapes project root/,
  );
  await rm(fixtureRoot, { recursive: true, force: true });
});

test("rejects symlink project roots and symlink workstreams", async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
  const project = path.join(fixtureRoot, "project");
  const outside = path.join(fixtureRoot, "outside");
  await mkdir(path.join(project, "streams"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, path.join(project, "streams/link"));
  await assert.rejects(
    resolveWorkstreamDirectory(project, { workstreamPath: "streams/link" }),
    (error) => error.code === "PATH_TRAVERSAL",
  );
  await symlink(project, path.join(fixtureRoot, "project-link"));
  await assert.rejects(
    resolveWorkstreamDirectory(path.join(fixtureRoot, "project-link"), { workstreamPath: "streams" }),
    (error) => error.code === "PATH_TRAVERSAL",
  );
  await rm(fixtureRoot, { recursive: true, force: true });
});
