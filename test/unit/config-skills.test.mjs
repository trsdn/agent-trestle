import assert from "node:assert/strict";
import test from "node:test";
import { resolveSkillPaths, selectSkills } from "../../src/config/skills.mjs";
import { availableSkillSuffixes } from "./config-skill-fixtures.mjs";

const mockPin = Object.freeze({ path: "/fixture-project", realPath: "/fixture-project" });
const mockPinDirectoryImpl = async () => mockPin;
const mockVerifyDescendantImpl = async () => {};

test("selects a stable, unique skill set from test-owned fixtures", async () => {
  const selected = selectSkills({
    declared: ["shared", "reviewer"],
    configured: ["reviewer"],
  });
  assert.deepEqual(selected, ["reviewer", "shared"]);
  const resolved = await resolveSkillPaths("/fixture-project", selected, {
    readVerifiedFileImpl: async (_pin, candidate) => {
      if (![...availableSkillSuffixes].some((suffix) => candidate.endsWith(suffix))) {
        const error = new Error(`Missing fixture ${candidate}`);
        error.code = "ENOENT";
        throw error;
      }
      return "# fixture skill\n";
    },
    pinDirectoryImpl: mockPinDirectoryImpl,
  });
  assert.match(resolved[0].path, /\.github\/skills\/reviewer\/SKILL\.md$/);
  assert.match(resolved[1].path, /\.copilot\/skills\/shared\/SKILL\.md$/);
});

test("requested skills must be explicitly declared or configured", () => {
  assert.throws(
    () => selectSkills({ declared: ["reviewer"], requested: ["deploy"] }),
    /deploy/,
  );
});
