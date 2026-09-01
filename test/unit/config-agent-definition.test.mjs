import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  loadAgentDefinition,
  parseAgentFrontmatter,
} from "../../src/config/agent-definition.mjs";

const fixturePath = new URL("./config-agent-fixture.agent.md", import.meta.url);

const mockPin = Object.freeze({ path: "/fixture-project/.github/agents", realPath: "/fixture-project/.github/agents" });
const mockPinDirectoryImpl = async () => mockPin;
const mockVerifyDescendantImpl = async () => {};

test("parses model and block-list skills from agent frontmatter", async () => {
  const fixture = await readFile(fixturePath, "utf8");
  const agent = await loadAgentDefinition("/fixture-project", "builder", {
    readVerifiedFileImpl: async () => fixture,
    pinDirectoryImpl: mockPinDirectoryImpl,
  });
  assert.equal(agent.id, "builder");
  assert.equal(
    agent.path,
    path.resolve("/fixture-project", ".github", "agents", "builder.agent.md"),
  );
  assert.equal(agent.model, "gpt-test");
  assert.deepEqual(agent.skills, ["reviewer", "shared"]);
});

test("parses inline skills and quoted model", () => {
  const parsed = parseAgentFrontmatter("---\nmodel: \"gpt-5\"\nskills: [one, 'two']\n---\nPrompt");
  assert.equal(parsed.model, "gpt-5");
  assert.deepEqual(parsed.skills, ["one", "two"]);
  assert.equal(parsed.body, "Prompt");
});

test("requires a declared model", () => {
  assert.throws(() => parseAgentFrontmatter("---\nskills: []\n---\n"), /declare model/);
});
