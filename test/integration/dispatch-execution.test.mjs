import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeScratchRoot } from "../helpers/scratch";
import { validateConfig } from "../../src/config/config.mjs";
import { dispatch } from "../../src/dispatch/dispatch.mjs";

const config = validateConfig({
  version: 1,
  project: { id: "bank" },
  permissions: {
    allowAllTools: true,
    allowAllPaths: true,
    allowAllUrls: true,
    nonInteractive: true,
  },
  copilot: { binary: "configured-copilot", timeoutMs: 5000 },
  workstreams: [{
    id: "payments",
    path: "payments",
    roles: [{
      id: "builder",
      agent: "payments-builder",
      skills: ["configured"],
    }],
  }],
});

test("dispatch binds route, agent, skills, permissions, and process adapter", async () => {
  const projectRoot = await makeScratchRoot("dispatch-execution");
  await rm(projectRoot, { recursive: true, force: true });
  await mkdir(path.join(projectRoot, "payments"), { recursive: true });
  let executionSpec;
  const result = await dispatch({
    config,
    projectRoot,
    projectId: "bank",
    workstreamId: "payments",
    roleId: "builder",
    prompt: "Implement settlement",
    requestedSkills: ["declared"],
    binary: "injected-copilot",
    loadAgent: async () => ({
      id: "payments-builder",
      path: path.join(projectRoot, ".github/agents/payments-builder.agent.md"),
      model: "gpt-test",
      skills: ["declared"],
    }),
    resolveSkills: async (_root, selected) => selected.map((id) => ({
      id,
      path: path.join(projectRoot, `.github/skills/${id}/SKILL.md`),
    })),
    run: async (spec) => {
      executionSpec = spec;
      return { status: "succeeded", ok: true, exitCode: 0 };
    },
  });

  assert.equal(result.route.agentId, "payments-builder");
  assert.deepEqual(result.skills.map(({ id }) => id), ["declared"]);
  assert.equal(executionSpec.binary, "injected-copilot");
  assert.equal(executionSpec.model, "gpt-test");
  assert.equal(executionSpec.cwd, path.join(projectRoot, "payments"));
  assert.deepEqual(executionSpec.args, [
    "--allow-all-tools",
    "--allow-all-paths",
    "--allow-all-urls",
    "--no-ask-user",
  ]);
  assert.match(executionSpec.prompt, /declared: .*SKILL\.md/);
  await rm(projectRoot, { recursive: true, force: true });
});
